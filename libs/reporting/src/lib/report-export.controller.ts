import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { BodySchema, RequirePermission, ctx, problem } from '@clinicrme/shared';
import { Db, audit, rows } from '@clinicrme/db';
import {
  CONTENT_TYPE, EXT, type ExportFormat, REPORTS, SYNC_EXPORT_ROWS, branchScope, completeJob, computeExport, storeExport,
} from '@clinicrme/db/reports';
import { STORAGE, type ObjectStorage } from '@clinicrme/storage';
import { toProblem } from './report.controller';

const ExportBody = z.object({
  format: z.enum(['XLSX', 'CSV', 'PDF']),
  parameters: z.record(z.string(), z.union([z.string().max(100), z.number(), z.boolean()])).default({}),
}).strict();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => problem(404, 'RPT-404-EXPORT', 'Ekspor tidak ditemukan');

interface JobRow { id: string; report_code: string; format: ExportFormat; status: string; row_count: number | null; created_at: Date; finished_at: Date | null;
  expires_at: Date | null; error: string | null }
const COLS = sql`id, report_code, format, status, row_count, created_at, finished_at, expires_at, error`;
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const expired = (j: JobRow) => j.status === 'EXPIRED' || (j.status === 'DONE' && !!j.expires_at && new Date(j.expires_at) < new Date());
const dto = (j: JobRow) => {
  const status = expired(j) ? 'EXPIRED' : j.status;
  return { id: j.id, reportCode: j.report_code, format: j.format, status, rowCount: j.row_count, requestedAt: iso(j.created_at), finishedAt: iso(j.finished_at),
    expiresAt: iso(j.expires_at), error: status === 'FAILED' ? (j.error ?? 'Ekspor gagal diproses') : null,
    downloadUrl: status === 'DONE' ? `/api/v1/report-exports/${j.id}/download` : null };
};

/**
 * Ekspor laporan seragam (RPT-FR-008, OD-128): XLSX/CSV/PDF dengan watermark (nama klinik, pengekspor, waktu, "Rahasia — untuk internal klinik").
 * ≤ 10.000 baris dibuat langsung (status DONE); di atasnya job QUEUED diproses worker (keduanya 202). Tautan unduh berlaku 24 jam, hanya untuk pemohon;
 * permintaan, penyelesaian & unduhan teraudit (laporan, filter, jumlah baris, format — tanpa isi laporan).
 */
@Controller('api/v1')
export class ReportExportController {
  constructor(private readonly db: Db, @Inject(STORAGE) private readonly storage: ObjectStorage) {}

  @RequirePermission('report.export') @BodySchema(ExportBody) @Post('reports/:reportCode/exports') @HttpCode(202)
  async create(@Param('reportCode') code: string, @Body() b: z.infer<typeof ExportBody>) {
    const def = Object.hasOwn(REPORTS, code) ? REPORTS[code] : undefined;
    if (!def) throw problem(404, 'RPT-404-REPORT', 'Laporan tidak dikenal');
    const c = ctx();
    // Izin ekspor saja tidak cukup: pemohon juga harus berhak melihat laporan itu
    if (!c.permissions?.has(def.permission)) throw problem(403, 'IAM-403-FORBIDDEN', 'Tidak berwenang melihat laporan ini');
    try {
      const out = await this.db.withTenantTx(async (tx) => {
        const params = b.parameters as Record<string, unknown>;
        const scope = await branchScope(tx, c.userId!, def.permission, typeof params['branchId'] === 'string' ? params['branchId'] : undefined);
        const computed = await computeExport(tx, { code, format: b.format, params, scope });
        const filters = Object.fromEntries(Object.entries(computed.f).filter(([k, v]) => k !== 'format' && v !== undefined));
        const summary = { report: code, format: b.format, filters, rowCount: computed.result.rows.length };
        if (computed.result.rows.length <= SYNC_EXPORT_ROWS) {
          const built = await storeExport(tx, this.storage, { tenantId: c.tenantId!, userId: c.userId!, code, format: b.format, params: filters, scope }, computed);
          const [j] = await rows<JobRow>(tx, sql`insert into report_export_job(tenant_id, report_code, format, params, branch_scope, status, requested_by, started_at)
            values (${c.tenantId}, ${code}, ${b.format}, ${JSON.stringify(filters)}::jsonb, ${scope ? `{${scope.join(',')}}` : null}::uuid[], 'RUNNING', ${c.userId}, now())
            returning id`);
          await completeJob(tx, j.id, c.tenantId!, c.userId!, b.format, built);
          await audit(tx, 'REPORT_EXPORTED', 'report_export_job', j.id, null, summary);
          return j.id;
        }
        const [j] = await rows<{ id: string }>(tx, sql`insert into report_export_job(tenant_id, report_code, format, params, branch_scope, requested_by)
          values (${c.tenantId}, ${code}, ${b.format}, ${JSON.stringify(filters)}::jsonb, ${scope ? `{${scope.join(',')}}` : null}::uuid[], ${c.userId})
          returning id`);
        await audit(tx, 'REPORT_EXPORT_REQUESTED', 'report_export_job', j.id, null, summary);
        return j.id;
      });
      return dto(await this.find(out));
    } catch (e) {
      throw toProblem(e);
    }
  }

  @RequirePermission('report.export') @Get('report-exports/:exportId')
  async get(@Param('exportId') id: string) {
    return dto(await this.find(id));
  }

  @RequirePermission('report.export') @Get('report-exports/:exportId/download')
  async download(@Param('exportId') id: string, @Res() res: Response) {
    const f = await this.db.withTenantTx(async (tx) => {
      const [j] = await rows<JobRow & { object_path: string | null; size_bytes: string | null; params: Record<string, unknown> }>(tx, sql`
        select j.id, j.report_code, j.format, j.status, j.row_count, j.created_at, j.finished_at, j.expires_at, j.error, j.params,
               f.object_path, f.size_bytes
          from report_export_job j left join stored_file f on f.id = j.file_id
         where j.id = ${this.uuid(id)} and j.requested_by = ${ctx().userId}`);
      if (!j) throw notFound();
      if (expired(j)) throw problem(410, 'RPT-410-EXPORT-EXPIRED', 'Tautan unduh sudah kedaluwarsa (24 jam). Ekspor ulang laporan.');
      if (j.status !== 'DONE') throw problem(409, 'RPT-409-EXPORT-NOT-READY', 'Ekspor belum selesai');
      await tx.execute(sql`update report_export_job set download_count = download_count + 1 where id = ${id}`);
      await audit(tx, 'REPORT_EXPORT_DOWNLOADED', 'report_export_job', id, null, { report: j.report_code, format: j.format, rowCount: j.row_count });
      return j;
    });
    const def = REPORTS[f.report_code];
    const name = `${def ? def.filename(f.params) : f.report_code}.${EXT[f.format]}`;
    const stream = await this.storage.openRead('exports', f.object_path!);
    res.status(200).set({
      'content-type': CONTENT_TYPE[f.format], 'content-length': String(f.size_bytes), 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${name}"`, 'x-content-type-options': 'nosniff',
    });
    await pipeline(stream, res);
  }

  private uuid(id: string) { if (!UUID.test(id)) throw notFound(); return id; }

  /** Hanya pemohon yang dapat melihat job ekspornya. */
  private async find(id: string) {
    const [j] = await this.db.withTenantTx((tx) => rows<JobRow>(tx, sql`select ${COLS} from report_export_job where id = ${this.uuid(id)} and requested_by = ${ctx().userId}`));
    if (!j) throw notFound();
    return j;
  }
}
