import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { type ObjectStorage, objectPathFor } from '@clinicrme/storage';
import { type Q, ReportError, parseQuery, reportTimeout, rowsOf } from './common';
import { MAX_EXPORT_ROWS, REPORTS, describeFilters } from './registry';
import { CONTENT_TYPE, EXT, type ExportFormat, renderExport } from './render';

/**
 * Ekspor laporan (RPT-FR-008, OD-128). Dipakai API (jalur langsung ≤ 10.000 baris) dan worker (job `report.export`, di atas 10.000 baris).
 * Yang disimpan: berkas di bucket `exports` (+ `stored_file` kategori REPORT) dan baris `report_export_job` (parameter filter, jumlah baris).
 * Isi laporan tidak pernah masuk audit maupun log.
 */
export const EXPORT_TTL_HOURS = 24;
/** PDF dibatasi agar berkas tetap dapat dibuka; ekspor lebih besar memakai XLSX/CSV. */
export const PDF_MAX_ROWS = 10_000;

export interface ExportContext { clinicName: string; exporterName: string; timezone: string; names: Record<string, string> }

/** Nama klinik, nama pengekspor, zona waktu tenant, serta nama cabang/lokasi/obat dalam filter untuk preamble (dibaca dalam konteks tenant). */
export async function exportContext(tx: Q, userId: string, params: Record<string, unknown>): Promise<ExportContext> {
  const ids = Object.entries(params).filter(([k, v]) => /Id$/.test(k) && typeof v === 'string').map(([, v]) => String(v));
  const [t] = await rowsOf<{ clinic: string; tz: string; exporter: string | null }>(tx, sql`
    select t.display_name as clinic, t.timezone as tz, (select full_name from app_user where id = ${userId}::uuid) as exporter
      from tenant t where t.id = app.current_tenant_id()`);
  const names: Record<string, string> = {};
  if (ids.length) {
    const arr = `{${ids.join(',')}}`;
    const r = await rowsOf<{ id: string; name: string }>(tx, sql`
      select id::text, name from branch where id = any(${arr}::uuid[])
      union all select id::text, name from stock_location where id = any(${arr}::uuid[])
      union all select id::text, generic_name from drug_item where id = any(${arr}::uuid[])
      union all select id::text, name from service_unit where id = any(${arr}::uuid[])
      union all select id::text, full_name from practitioner where id = any(${arr}::uuid[])`);
    for (const x of r) names[x.id] = x.name;
  }
  return { clinicName: t.clinic, exporterName: t.exporter ?? 'Pengguna', timezone: t.tz, names };
}

export interface BuiltExport { fileId: string; objectPath: string; size: number; sha256: string; rowCount: number; filename: string }
export interface ExportArgs { tenantId: string; userId: string; code: string; format: ExportFormat; params: Record<string, unknown>; scope: string[] | null }

/** Validasi parameter + hitung laporan untuk ekspor (batas baris diperiksa). */
export async function computeExport(tx: Q, a: Omit<ExportArgs, 'tenantId' | 'userId'>) {
  const def = REPORTS[a.code];
  if (!def) throw new ReportError(404, 'RPT-404-REPORT', 'Laporan tidak dikenal');
  const f = parseQuery(def.schema, { ...a.params, format: 'json' }) as Record<string, unknown>;
  await reportTimeout(tx);
  const result = await def.run(tx, f as never, a.scope, { forExport: true });
  if (result.extra?.['truncated'] || result.rows.length > MAX_EXPORT_ROWS) {
    throw new ReportError(422, 'RPT-422-EXPORT-TOO-LARGE', `Data melebihi ${MAX_EXPORT_ROWS.toLocaleString('id-ID')} baris. Persempit filter.`);
  }
  if (a.format === 'PDF' && result.rows.length > PDF_MAX_ROWS) {
    throw new ReportError(422, 'RPT-422-PDF-TOO-LARGE', `PDF dibatasi ${PDF_MAX_ROWS.toLocaleString('id-ID')} baris. Gunakan XLSX atau CSV.`);
  }
  return { def, f, result };
}

/** Merender hasil laporan ke berkas (watermark) dan menyimpannya di bucket `exports`. */
export async function storeExport(tx: Q, storage: ObjectStorage, a: ExportArgs, c: Awaited<ReturnType<typeof computeExport>>): Promise<BuiltExport> {
  const ctxInfo = await exportContext(tx, a.userId, c.f);
  const buf = await renderExport(a.format, c.result, {
    title: c.def.title, clinicName: ctxInfo.clinicName, exportedBy: ctxInfo.exporterName, exportedAt: new Date(), timezone: ctxInfo.timezone,
    filters: describeFilters(c.f, ctxInfo.names),
  });
  const fileId = randomUUID();
  const ext = EXT[a.format];
  const objectPath = objectPathFor(a.tenantId, 'report', fileId, ext);
  const dir = await mkdtemp(join(tmpdir(), 'crme-report-'));
  try {
    const path = join(dir, `export.${ext}`);
    await writeFile(path, buf, { mode: 0o600 });
    await storage.putFile('exports', objectPath, path, CONTENT_TYPE[a.format]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { fileId, objectPath, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), rowCount: c.result.rows.length,
    filename: `${c.def.filename(c.f, c.result)}.${ext}` };
}

export async function buildExport(tx: Q, storage: ObjectStorage, a: ExportArgs): Promise<BuiltExport> {
  return storeExport(tx, storage, a, await computeExport(tx, a));
}

/** Mencatat berkas & menandai job DONE (dalam transaksi tenant pemanggil). */
export async function completeJob(tx: Q, jobId: string, tenantId: string, userId: string, format: ExportFormat, b: BuiltExport) {
  await tx.execute(sql`insert into stored_file(id, tenant_id, category, object_path, content_type, size_bytes, sha256, uploaded_by)
                       values (${b.fileId}, ${tenantId}, 'REPORT', ${b.objectPath}, ${CONTENT_TYPE[format]}, ${b.size}, ${b.sha256}, ${userId})`);
  await tx.execute(sql`update report_export_job set status = 'DONE', file_id = ${b.fileId}, row_count = ${b.rowCount}, finished_at = now(),
                         expires_at = now() + make_interval(hours => ${EXPORT_TTL_HOURS}) where id = ${jobId}`);
}

const safeError = (e: unknown) => (e instanceof ReportError ? e.message : 'Ekspor gagal diproses');

/**
 * Worker: memproses satu job QUEUED (bila ada) sebagai `clinicrme_app` dengan konteks tenant & user pemohon (RLS penuh).
 * Mengembalikan id job yang diproses, atau null.
 */
export async function runNextReportExport(pool: Pool, storage: ObjectStorage): Promise<string | null> {
  const c = await pool.connect();
  type Job = { id: string; tenant_id: string; report_code: string; format: ExportFormat; params: Record<string, unknown>; branch_scope: string[] | null;
               requested_by: string };
  let job: Job | undefined;
  try {
    ({ rows: [job] } = await c.query<Job>(`
      update app.report_export_job set status = 'RUNNING', started_at = now()
       where id = (select id from app.report_export_job where status = 'QUEUED' order by created_at for update skip locked limit 1)
      returning id, tenant_id, report_code, format, params, branch_scope, requested_by`));
    if (!job) return null;
    const j = job;
    await asTenant(c, j.tenant_id, j.requested_by, async (tx) => {
      const b = await buildExport(tx, storage, { tenantId: j.tenant_id, userId: j.requested_by, code: j.report_code, format: j.format, params: j.params,
        scope: j.branch_scope });
      await completeJob(tx, j.id, j.tenant_id, j.requested_by, j.format, b);
      await tx.execute(sql`select app.write_audit('REPORT_EXPORTED', 'report_export_job', ${j.id}::uuid, null,
        ${JSON.stringify({ report: j.report_code, format: j.format, filters: j.params, rowCount: b.rowCount, async: true })}::jsonb, 'SYSTEM', null, null)`);
    });
    return j.id;
  } catch (e) {
    if (job) {
      const j = job;
      await c.query(`update app.report_export_job set status = 'FAILED', finished_at = now(), error = $2 where id = $1`, [j.id, safeError(e)]);
      await asTenant(c, j.tenant_id, j.requested_by, (tx) => tx.execute(sql`select app.write_audit('REPORT_EXPORT_FAILED', 'report_export_job', ${j.id}::uuid, null,
        ${JSON.stringify({ report: j.report_code, format: j.format, error: safeError(e) })}::jsonb, 'SYSTEM', null, null)`)).catch(() => undefined);
      return j.id;
    }
    throw e;
  } finally {
    c.release();
  }
}

/** Tautan kedaluwarsa → objek dihapus, status EXPIRED; job RUNNING > 1 jam dianggap macet → FAILED. */
export async function expireReportExports(pool: Pool, storage: ObjectStorage): Promise<{ expired: number; stale: number }> {
  const { rows } = await pool.query<{ id: string; object_path: string }>(`
    select j.id, f.object_path from app.report_export_job j join app.stored_file f on f.id = j.file_id
     where j.status = 'DONE' and j.expires_at < now()`);
  for (const r of rows) {
    await storage.remove('exports', r.object_path);
    await pool.query(`update app.report_export_job set status = 'EXPIRED' where id = $1`, [r.id]);
  }
  const stale = await pool.query(`update app.report_export_job set status = 'FAILED', finished_at = now(), error = 'Ekspor macet (> 1 jam)'
                                   where status = 'RUNNING' and started_at < now() - interval '1 hour'`);
  return { expired: rows.length, stale: stale.rowCount ?? 0 };
}

/** Transaksi sebagai clinicrme_app dengan konteks tenant & user (RLS penuh), search_path app. */
async function asTenant<T>(c: PoolClient, tenantId: string, userId: string, fn: (tx: Q) => Promise<T>): Promise<T> {
  await c.query('begin');
  try {
    await c.query('set local role clinicrme_app');
    await c.query(`select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('search_path', 'app, public', true)`,
                  [tenantId, userId]);
    const r = await fn(drizzle(c) as unknown as Q);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  }
}
