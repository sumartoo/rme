/**
 * Registri job worker. Setiap job: nama antrean stabil, handler, kebijakan retry, dan jadwal opsional.
 * Job yang menyentuh data tenant WAJIB membawa tenant_id di payload dan memakai Db.withTenant (Stage 5+);
 * job sistem (heartbeat, partisi audit) tidak boleh membaca data tenant.
 */
import type { Pool } from 'pg';
import { expireExports, runNextExport, type ExportOptions } from '@clinicrme/db/tenant-export';
import { dispatchNotifications, type NotifyOptions, type SendMail } from '@clinicrme/db/notifications';
import type { ObjectStorage } from '@clinicrme/storage';

export interface JobDeps {
  /** Query sebagai role worker. Hanya untuk job sistem. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Pool untuk job yang membaca data tenant — WAJIB lewat fungsi yang SET LOCAL ROLE clinicrme_app (tenant-export). */
  pool: Pool;
  storage: ObjectStorage;
  exportOptions: ExportOptions;
  /** Pengirim email (SMTP); undefined = notifikasi tidak dikirim (event tetap PENDING). */
  sendMail?: SendMail;
  notifyOptions: NotifyOptions;
  appEnv: string;
  warn(obj: object, msg: string): void;
}

export interface JobDefinition<T = unknown> {
  name: string;
  retryLimit: number;
  /** Cron (UTC). Tanpa jadwal = hanya saat dikirim. */
  cron?: string;
  /** Jalankan sekali saat worker start (mis. memastikan partisi ada setelah deploy). */
  runOnStart?: boolean;
  handler: (data: T, deps: JobDeps) => Promise<unknown>;
}

export const HEARTBEAT = 'system.heartbeat';
export const AUDIT_PARTITIONS = 'system.audit_partitions';
export const AUDIT_CHAIN_VERIFY = 'system.audit_chain_verify';
export const EXPORT_RUN = 'tenant.export.run';
export const EXPORT_EXPIRE = 'tenant.export.expire';
const EXPORTS_PER_RUN = 3;
export const NOTIFY_DISPATCH = 'notify.outbox.dispatch';
const AUDIT_MONTHS_AHEAD = 2;

export const jobs: JobDefinition[] = [
  {
    name: HEARTBEAT,
    retryLimit: 0,
    handler: async (data) => ({ ok: true, echo: (data as { nonce?: string } | null)?.nonce ?? null, at: new Date().toISOString() }),
  },
  {
    // DATABASE_DESIGN §9: partisi audit_log bulan berjalan + 2 bulan ke depan (fungsi migrasi 0002)
    name: AUDIT_PARTITIONS,
    retryLimit: 3,
    cron: '17 0 * * *',
    runOnStart: true,
    handler: async (_data, deps) => {
      const rows = await deps.query<{ partition_name: string; status: string }>(
        'select partition_name, status from app.ensure_audit_partitions($1)', [AUDIT_MONTHS_AHEAD]);
      const skipped = rows.filter((r) => r.status === 'SKIPPED_DEFAULT_HAS_ROWS').map((r) => r.partition_name);
      if (skipped.length) {
        // Baris audit bulan itu sudah masuk partisi default (job sempat tidak berjalan). Baris audit immutable,
        // jadi tidak dipindah otomatis. Di cloud ini harus jadi alert; di lokal cukup peringatan.
        if (deps.appEnv === 'local' || deps.appEnv === 'test') {
          deps.warn({ skipped }, 'partisi audit dilewati: baris sudah ada di partisi default');
        } else {
          throw new Error(`Partisi audit tidak dapat dibuat (baris sudah di default): ${skipped.join(', ')}`);
        }
      }
      return { partitions: rows };
    },
  },
  {
    // SC-AUD-03: verifikasi hash chain audit setiap tenant, harian. Rantai rusak = indikasi manipulasi → job GAGAL (alert).
    // Catatan: verifikasi penuh dari awal; versi bertahap (checkpoint) dievaluasi pada volume produksi (Stage 15).
    name: AUDIT_CHAIN_VERIFY,
    retryLimit: 0,
    cron: '47 1 * * *',
    handler: async (_data, deps) => {
      const rows = await deps.query<{ tenant_id: string; ok: boolean; first_bad_seq: string | null }>(
        `select h.tenant_id, v.ok, v.first_bad_seq
           from app.audit_chain_head h cross join lateral app.verify_audit_chain(h.tenant_id) v
          order by h.tenant_id`);
      const broken = rows.filter((r) => !r.ok);
      if (broken.length) {
        throw new Error(`Hash chain audit rusak: ${broken.map((b) => `${b.tenant_id}@seq ${b.first_bad_seq}`).join(', ')}`);
      }
      return { tenantsVerified: rows.length };
    },
  },
  {
    // PLT-FR-008: ambil job ekspor QUEUED (FOR UPDATE SKIP LOCKED) tiap menit; aman dijalankan beberapa worker sekaligus
    name: EXPORT_RUN,
    retryLimit: 0,
    cron: '* * * * *',
    runOnStart: true,
    handler: async (_data, deps) => {
      const done: string[] = [];
      for (let i = 0; i < EXPORTS_PER_RUN; i++) {
        const id = await runNextExport(deps.pool, deps.storage, deps.exportOptions);
        if (!id) break;
        done.push(id);
      }
      return { processed: done };
    },
  },
  {
    // AC-PLT-FR-008-1: tautan kedaluwarsa → objek dihapus; job macet → FAILED
    name: EXPORT_EXPIRE,
    retryLimit: 2,
    cron: '23 * * * *',
    handler: async (_data, deps) => expireExports(deps.pool, deps.storage),
  },
  {
    // OD-076 & undangan: email dari outbox. Tanpa SMTP_URL event dibiarkan PENDING (dikirim setelah SMTP dikonfigurasi).
    name: NOTIFY_DISPATCH,
    retryLimit: 0,
    cron: '* * * * *',
    runOnStart: true,
    handler: async (_data, deps) => {
      if (!deps.sendMail) {
        deps.warn({}, 'SMTP_URL tidak diset — notifikasi email tidak dikirim');
        return { skipped: true };
      }
      const r = await dispatchNotifications(deps.pool, deps.sendMail, deps.notifyOptions);
      if (r.noRecipient > 0) deps.warn({ noRecipient: r.noRecipient }, 'notifikasi tanpa penerima (tenant tanpa admin aktif?)');
      return r;
    },
  },
];

export function findJob(name: string): JobDefinition | undefined {
  return jobs.find((j) => j.name === name);
}
