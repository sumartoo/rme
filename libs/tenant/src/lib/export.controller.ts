import { Controller, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import type { AppConfig } from '@clinicrme/shared';
import { CONFIG, NoBody, RequirePermission, ctx, decrypt, pgError, problem } from '@clinicrme/shared';
import { Db, audit, rows } from '@clinicrme/db';
import type { ObjectStorage } from '@clinicrme/storage';
import { STORAGE } from '@clinicrme/storage';

interface JobRow {
  id: string; status: string; created_at: Date; finished_at: Date | null; expires_at: Date | null; size_bytes: string | null;
  sha256: string | null; table_count: number | null; row_count: string | null; error: string | null;
}
const COLS = sql`id, status, created_at, finished_at, expires_at, size_bytes, sha256, table_count, row_count, error`;
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const dto = (j: JobRow) => ({
  id: j.id, status: j.status, requestedAt: iso(j.created_at), finishedAt: iso(j.finished_at), expiresAt: iso(j.expires_at),
  sizeBytes: j.size_bytes === null ? null : Number(j.size_bytes), sha256: j.sha256, tableCount: j.table_count,
  rowCount: j.row_count === null ? null : Number(j.row_count), error: j.status === 'FAILED' ? 'Ekspor gagal. Coba lagi atau hubungi ClinicRME.' : null,
  downloadUrl: j.status === 'DONE' ? `/api/v1/tenant/exports/${j.id}/file` : null,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => problem(404, 'PLT-404-EXPORT', 'Ekspor tidak ditemukan');

/**
 * PLT-FR-008: tenant admin meminta ekspor seluruh data; worker membuat arsip terenkripsi (libs/db tenant-export).
 * Unduhan & pengambilan kunci lewat API (bukan signed URL) agar setiap akses teraudit (AC-PLT-FR-008-2) dan dibatasi waktu.
 */
@Controller('api/v1/tenant/exports')
export class TenantExportController {
  constructor(private readonly db: Db, @Inject(STORAGE) private readonly storage: ObjectStorage, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  @RequirePermission('tenant.data.export') @NoBody() @Post() @HttpCode(202)
  async create() {
    const c = ctx();
    try {
      return dto(await this.db.withTenantTx(async (tx) => {
        const [j] = await rows<JobRow>(tx, sql`insert into tenant_export_job(tenant_id, requested_by) values (${c.tenantId}, ${c.userId})
                                               returning ${COLS}`);
        await audit(tx, 'EXPORT_REQUESTED', 'tenant_export_job', j.id);
        return j;
      }));
    } catch (e) {
      if (pgError(e)?.code === '23505') throw problem(409, 'PLT-409-EXPORT-ACTIVE', 'Masih ada ekspor yang sedang diproses');
      throw e;
    }
  }

  @RequirePermission('tenant.data.export') @Get()
  async list() {
    const r = await this.db.withTenantTx((tx) => rows<JobRow>(tx, sql`select ${COLS} from tenant_export_job order by created_at desc limit 20`));
    return r.map(dto);
  }

  @RequirePermission('tenant.data.export') @Get(':jobId')
  async get(@Param('jobId') id: string) {
    return dto(await this.find(id));
  }

  /** Kunci dekripsi arsip (base64, 32 byte). Hanya saat DONE & belum kedaluwarsa; setiap pengambilan teraudit. */
  @RequirePermission('tenant.data.export') @Get(':jobId/key')
  async key(@Param('jobId') id: string) {
    const key = await this.db.withTenantTx(async (tx) => {
      const [j] = await rows<{ status: string; expires_at: Date | null; key_encrypted: Buffer | null }>(tx, sql`
        select status, expires_at, key_encrypted from tenant_export_job where id = ${this.uuid(id)}`);
      this.assertDownloadable(j);
      await audit(tx, 'EXPORT_KEY_VIEWED', 'tenant_export_job', id);
      return decrypt(this.cfg.encryptionKeyHex, j!.key_encrypted!);
    });
    return { algorithm: 'AES-256-GCM', key };
  }

  @RequirePermission('tenant.data.export') @Get(':jobId/file')
  async file(@Param('jobId') id: string, @Res() res: Response) {
    const f = await this.db.withTenantTx(async (tx) => {
      const [j] = await rows<{ status: string; expires_at: Date | null; object_path: string | null; size_bytes: string | null; created_at: Date; code: string }>(tx, sql`
        select j.status, j.expires_at, f.object_path, f.size_bytes, j.created_at, t.code
          from tenant_export_job j left join stored_file f on f.id = j.file_id join tenant t on t.id = j.tenant_id
         where j.id = ${this.uuid(id)}`);
      this.assertDownloadable(j);
      await tx.execute(sql`update tenant_export_job set download_count = download_count + 1 where id = ${id}`);
      await audit(tx, 'EXPORT_DOWNLOADED', 'tenant_export_job', id);
      return j!;
    });
    const stream = await this.storage.openRead('exports', f.object_path!);
    const day = new Date(f.created_at).toISOString().slice(0, 10);
    res.status(200).set({
      'content-type': 'application/octet-stream', 'content-length': String(f.size_bytes), 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="clinicrme-export-${f.code}-${day}.crmex"`,
    });
    await pipeline(stream, res);
  }

  private uuid(id: string) { if (!UUID.test(id)) throw notFound(); return id; }

  private async find(id: string) {
    const [j] = await this.db.withTenantTx((tx) => rows<JobRow>(tx, sql`select ${COLS} from tenant_export_job where id = ${this.uuid(id)}`));
    if (!j) throw notFound();
    return j;
  }

  private assertDownloadable(j: { status: string; expires_at: Date | null } | undefined) {
    if (!j) throw notFound();
    if (j.status === 'EXPIRED' || (j.status === 'DONE' && j.expires_at && new Date(j.expires_at) < new Date())) {
      throw problem(410, 'PLT-410-EXPORT-EXPIRED', 'Tautan ekspor sudah kedaluwarsa. Minta ekspor baru.');
    }
    if (j.status !== 'DONE') throw problem(409, 'PLT-409-EXPORT-NOT-READY', 'Ekspor belum selesai');
  }
}
