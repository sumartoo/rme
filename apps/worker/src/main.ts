import pino from 'pino';
import { createTransport } from 'nodemailer';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { REDACT_CENSOR, REDACT_PATHS } from '@clinicrme/shared/logging';
import { createStorage, storageConfigFromEnv } from '@clinicrme/storage';
import { loadWorkerConfig } from './app/config';
import { AUDIT_CHAIN_VERIFY, AUDIT_PARTITIONS, HEARTBEAT, JobDeps, jobs } from './app/jobs';

/**
 * Worker ClinicRME (ADR-0001, ADR-0004): memproses job pg-boss — outbox, integrasi, PDF, export (Stage 9+).
 * Stage 4: kerangka, job heartbeat, partisi audit bulanan, graceful shutdown, dan mode self-test untuk smoke test CI.
 */
/** SMTP via nodemailer; teks polos saja (tanpa HTML/tautan pelacak). */
function mailer(url: string, from: string) {
  const t = createTransport(url);
  return async (m: { to: string; subject: string; text: string }) => { await t.sendMail({ from, ...m }); };
}

async function main() {
  const cfg = loadWorkerConfig();
  const log = pino({ level: cfg.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR }, base: { app: 'worker', env: cfg.APP_ENV } });
  const boss = new PgBoss({ connectionString: cfg.WORKER_DATABASE_URL, application_name: 'clinicrme-worker' });
  boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
  await boss.start();
  // Pool job: query sistem, dan job tenant yang selalu SET LOCAL ROLE clinicrme_app (tenant-export)
  const pool = new Pool({ connectionString: cfg.WORKER_DATABASE_URL, max: 3, application_name: 'clinicrme-worker-jobs' });
  const deps: JobDeps = {
    query: async (text, params) => (await pool.query(text, params as unknown[])).rows,
    pool,
    storage: createStorage(storageConfigFromEnv(process.env, cfg.APP_ENV)),
    exportOptions: { encryptionKeyHex: cfg.ENCRYPTION_KEY_HEX, ttlHours: cfg.EXPORT_TTL_HOURS, workDir: cfg.WORKER_TMP_DIR },
    sendMail: cfg.SMTP_URL ? mailer(cfg.SMTP_URL, cfg.MAIL_FROM) : undefined,
    notifyOptions: { clinicUrlTemplate: cfg.CLINIC_URL_TEMPLATE },
    appEnv: cfg.APP_ENV,
    warn: (obj, msg) => log.warn(obj, msg),
  };

  const startupJobs = new Map<string, string | null>();
  for (const job of jobs) {
    await boss.createQueue(job.name, { retryLimit: job.retryLimit });
    await boss.work(job.name, { localConcurrency: cfg.WORKER_CONCURRENCY }, async ([j]) => {
      log.info({ job: job.name, job_id: j.id }, 'job mulai');
      try {
        const result = await job.handler(j.data, deps);
        log.info({ job: job.name, job_id: j.id }, 'job selesai');
        return result;
      } catch (err) {
        log.error({ job: job.name, job_id: j.id, err }, 'job gagal');
        throw err;
      }
    });
    if (job.cron) await boss.schedule(job.name, job.cron, null, { tz: 'UTC' });
    if (job.runOnStart) startupJobs.set(job.name, await boss.send(job.name, null));
  }
  log.info({ queues: jobs.map((j) => j.name) }, 'worker siap');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'worker berhenti — menunggu job berjalan selesai');
    await boss.stop({ graceful: true, timeout: 30_000 });
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  if (cfg.WORKER_SELFTEST === '1') {
    // Smoke test: heartbeat, job partisi audit (dikirim saat start), dan verifikasi hash chain harus selesai
    const waitFor = async (name: string, id: string | null | undefined) => {
      const deadline = Date.now() + 30_000;
      while (id && Date.now() < deadline) {
        const [j] = await boss.findJobs(name, { id });
        if (j?.state === 'completed') return j.output;
        if (j?.state === 'failed') return null;
        await new Promise((r) => setTimeout(r, 250));
      }
      return null;
    };
    const hb = await waitFor(HEARTBEAT, await boss.send(HEARTBEAT, { nonce: `selftest-${Date.now()}` }));
    const ap = await waitFor(AUDIT_PARTITIONS, startupJobs.get(AUDIT_PARTITIONS));
    const cv = await waitFor(AUDIT_CHAIN_VERIFY, await boss.send(AUDIT_CHAIN_VERIFY, null));
    if (hb && ap && cv) {
      log.info({ heartbeat: hb, audit_partitions: ap, audit_chain_verify: cv }, 'SELFTEST OK');
      await shutdown('SELFTEST');
      return;
    }
    log.error({ heartbeat: !!hb, audit_partitions: !!ap, audit_chain_verify: !!cv }, 'SELFTEST GAGAL');
    await boss.stop({ graceful: false });
    await pool.end();
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`Worker gagal start: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
