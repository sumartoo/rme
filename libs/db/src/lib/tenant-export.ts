import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { writeEncryptedArchive } from '@clinicrme/shared/archive';
import { encrypt } from '@clinicrme/shared/crypto';
import { ObjectStorage, objectPathFor } from '@clinicrme/storage';

/**
 * Mesin ekspor data tenant (PLT-FR-008, OD-028). Dipanggil worker (job `tenant.export.run`), diuji langsung oleh suite integrasi.
 *
 * Keamanan isi arsip:
 * 1. Pembacaan berjalan sebagai `clinicrme_app` (SET LOCAL ROLE) dengan `app.tenant_id` = tenant job → RLS membatasi ke satu tenant,
 *    walau koneksi worker adalah pemilik skema.
 * 2. Pertahanan berlapis: setiap baris dengan kolom tenant_id diperiksa; satu baris tenant lain → ekspor GAGAL, tidak ada berkas.
 * 3. Kredensial & token tidak pernah diekspor (EXCLUDED).
 * Snapshot konsisten: satu transaksi REPEATABLE READ READ ONLY untuk semua tabel.
 */
export const EXPORT_FORMAT = 'clinicrme-export/1';
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  user_credential: 'hash password', user_mfa: 'secret TOTP & recovery code', user_session: 'token sesi',
  user_invitation: 'token undangan', tenant_export_job: 'metadata ekspor', outbox_event: 'antrean teknis internal',
  idempotency_record: 'salinan respons teknis 24 jam (Idempotency-Key)',
  queue_display_link: 'hash token layar TV (rahasia teknis)',
};

export interface ExportOptions { encryptionKeyHex: string; ttlHours: number; workDir?: string }
interface Job { id: string; tenant_id: string; requested_by: string }
interface TableDump { name: string; file: string; rows: number; sha256: string; size: number }

const safeError = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 300);

/** Memproses satu job QUEUED (bila ada). Mengembalikan id job yang diproses, atau null. */
export async function runNextExport(pool: Pool, storage: ObjectStorage, opts: ExportOptions): Promise<string | null> {
  const c = await pool.connect();
  let job: Job | undefined;
  try {
    // Klaim lintas tenant (tanpa membaca data tenant)
    ({ rows: [job] } = await c.query<Job>(`
      update app.tenant_export_job set status = 'RUNNING', started_at = now()
       where id = (select id from app.tenant_export_job where status = 'QUEUED' order by created_at for update skip locked limit 1)
      returning id, tenant_id, requested_by`));
    if (!job) return null;
    const dir = await mkdtemp(join(opts.workDir ?? tmpdir(), 'crme-export-'));
    try {
      const { dumps, tenant } = await dumpTenant(c, job.tenant_id, dir);
      const manifest = {
        format: EXPORT_FORMAT, exportId: job.id, generatedAt: new Date().toISOString(),
        tenant: { id: job.tenant_id, code: tenant.code, legalName: tenant.legal_name },
        tables: dumps.map(({ name, file, rows, sha256, size }) => ({ name, file, rows, sha256, bytes: size })),
        excluded: Object.entries(EXCLUDED_TABLES).map(([name, reason]) => ({ name, reason })),
        notes: [
          'Setiap berkas tables/*.ndjson berisi satu objek JSON per baris (row_to_json PostgreSQL).',
          'Kolom *_encrypted (mis. NIK) tetap terenkripsi dengan kunci aplikasi; dekripsi untuk serah terima disediakan saat modul pasien aktif (Stage 8).',
          'Data platform (langganan, histori status) tidak termasuk; dapat diminta ke ClinicRME.',
        ],
      };
      const manifestPath = join(dir, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      const key = randomBytes(32);
      const archive = join(dir, 'export.crmex');
      const entries = [{ name: 'manifest.json', path: manifestPath, size: (await stat(manifestPath)).size },
                       ...dumps.map((d) => ({ name: d.file, path: join(dir, d.file.replace('/', '__')), size: d.size }))];
      const { sha256, size } = await writeEncryptedArchive(archive, entries, key);
      const fileId = randomUUID();
      const objectPath = objectPathFor(job.tenant_id, 'export', fileId, 'crmex');
      await storage.putFile('exports', objectPath, archive, 'application/octet-stream');

      await asTenant(c, job.tenant_id, false, async () => {
        await c.query(`insert into app.stored_file(id, tenant_id, category, object_path, content_type, size_bytes, sha256, uploaded_by)
                       values ($1, $2, 'EXPORT', $3, 'application/octet-stream', $4, $5, $6)`,
                      [fileId, job!.tenant_id, objectPath, size, sha256, job!.requested_by]);
        await c.query(`update app.tenant_export_job set status = 'DONE', finished_at = now(), expires_at = now() + make_interval(hours => $2),
                         file_id = $3, size_bytes = $4, sha256 = $5, key_encrypted = $6, table_count = $7, row_count = $8
                        where id = $1`,
                      [job!.id, opts.ttlHours, fileId, size, sha256, encrypt(opts.encryptionKeyHex, key.toString('base64')),
                       dumps.length, dumps.reduce((n, d) => n + d.rows, 0)]);
        await c.query(`select app.write_audit('EXPORT_COMPLETED', 'tenant_export_job', $1::uuid, null,
                         $2::jsonb, 'SYSTEM', null, null)`,
                      [job!.id, JSON.stringify({ tables: dumps.length, rows: dumps.reduce((n, d) => n + d.rows, 0), bytes: size })]);
      });
      return job.id;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (e) {
    if (job) {
      await c.query('rollback').catch(() => undefined);
      await c.query(`update app.tenant_export_job set status = 'FAILED', finished_at = now(), error = $2 where id = $1`, [job.id, safeError(e)]);
      await asTenant(c, job.tenant_id, false, () =>
        c.query(`select app.write_audit('EXPORT_FAILED', 'tenant_export_job', $1::uuid, null, $2::jsonb, 'SYSTEM', null, null)`,
                [job!.id, JSON.stringify({ error: safeError(e) })])).catch(() => undefined);
      return job.id;
    }
    throw e;
  } finally {
    c.release();
  }
}

/** Transaksi sebagai clinicrme_app dengan tenant context (RLS berlaku penuh). */
async function asTenant<T>(c: PoolClient, tenantId: string, readOnly: boolean, fn: () => Promise<T>): Promise<T> {
  await c.query(readOnly ? 'begin isolation level repeatable read read only' : 'begin');
  try {
    await c.query('set local role clinicrme_app');
    await c.query(`select set_config('app.tenant_id', $1, true), set_config('app.user_id', '', true)`, [tenantId]);
    const r = await fn();
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  }
}

async function dumpTenant(c: PoolClient, tenantId: string, dir: string) {
  return asTenant(c, tenantId, true, async () => {
    const { rows: [tenant] } = await c.query<{ code: string; legal_name: string }>(`select code, legal_name from app.tenant where id = $1`, [tenantId]);
    if (!tenant) throw new Error('tenant tidak terlihat dalam konteks tenant');
    const { rows: tables } = await c.query<{ name: string; has_tenant: boolean }>(`
      select c.relname as name, exists(select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped) as has_tenant
        from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'app'
       where c.relkind in ('r', 'p') and not c.relispartition and has_table_privilege(c.oid, 'SELECT')
         and (c.relname = 'tenant' or exists(select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped))
         and not (c.relname = any($1::text[]))
       order by c.relname`, [Object.keys(EXCLUDED_TABLES)]);
    const dumps: TableDump[] = [];
    for (const t of tables) {
      const file = `tables/${t.name}.ndjson`;
      const path = join(dir, file.replace('/', '__'));
      const out = createWriteStream(path, { mode: 0o600 });
      const hash = createHash('sha256');
      let rows = 0, size = 0;
      const ident = c.escapeIdentifier(t.name);
      const tenantCol = t.name === 'tenant' ? 'id' : 'tenant_id';
      await c.query(`declare crme_export no scroll cursor for select ${tenantCol}::text as tid, row_to_json(x)::text as j from app.${ident} x`);
      for (;;) {
        const { rows: batch } = await c.query<{ tid: string; j: string }>('fetch 1000 from crme_export');
        if (!batch.length) break;
        for (const r of batch) {
          // Pertahanan berlapis: RLS seharusnya sudah memfilter; baris tenant lain = kegagalan isolasi → hentikan ekspor
          if (r.tid !== tenantId) throw new Error(`isolasi gagal: baris tenant lain di tabel ${t.name}`);
          const line = r.j + '\n';
          hash.update(line); size += Buffer.byteLength(line);
          if (!out.write(line)) await new Promise<void>((res) => out.once('drain', () => res()));
          rows++;
        }
      }
      await c.query('close crme_export');
      await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
      dumps.push({ name: t.name, file, rows, sha256: hash.digest('hex'), size });
    }
    return { dumps, tenant };
  });
}

/** Tautan kedaluwarsa → objek dihapus, status EXPIRED; job RUNNING > 2 jam dianggap macet → FAILED. */
export async function expireExports(pool: Pool, storage: ObjectStorage): Promise<{ expired: number; stale: number }> {
  const { rows } = await pool.query<{ id: string; object_path: string }>(`
    select j.id, f.object_path from app.tenant_export_job j join app.stored_file f on f.id = j.file_id
     where j.status = 'DONE' and j.expires_at < now()`);
  for (const r of rows) {
    await storage.remove('exports', r.object_path);
    await pool.query(`update app.tenant_export_job set status = 'EXPIRED', key_encrypted = null where id = $1`, [r.id]);
  }
  const stale = await pool.query(`update app.tenant_export_job set status = 'FAILED', finished_at = now(), error = 'macet (> 2 jam)'
                                   where status = 'RUNNING' and started_at < now() - interval '2 hours'`);
  return { expired: rows.length, stale: stale.rowCount ?? 0 };
}
