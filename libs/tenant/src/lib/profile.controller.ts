import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { BodySchema, RequirePermission, ctx, problem } from '@clinicrme/shared';
import { Db, audit, rows } from '@clinicrme/db';

const text = (max: number) => z.string().trim().max(max);
/** Pengaturan yang dikenal saja (strict); kunci baru ditambah bersama modul yang memakainya. */
const Settings = z.object({
  pharmacyBeforeCashier: z.boolean().optional(),     // DEC-013
  discountLimitPercent: z.number().min(0).max(100).optional(),
  noShowMinutes: z.number().int().min(5).max(240).optional(),
  queueDisplayInitials: z.boolean().optional(),   // OD-088: layar TV menampilkan inisial pasien
  lateToleranceMinutes: z.number().int().min(0).max(120).optional(),   // OD-087: toleransi terlambat janji temu
  mrnPrefix: z.string().trim().toUpperCase().regex(/^[A-Z]{0,5}$/, 'Awalan nomor RM 0–5 huruf').optional(),   // OD-081
}).strict();
export const TenantProfileBody = z.object({
  displayName: text(200).min(2),
  letterhead: z.object({ name: text(200), address: text(500), phone: text(50), license: text(100) }).partial().strict().nullable().optional(),
  logoFileId: z.string().uuid().nullable().optional(),
  settings: Settings.optional(),
}).strict();

interface Row { display_name: string; letterhead: Record<string, string> | null; logo_file_id: string | null; settings: Record<string, unknown>; version: number }
const dto = (r: Row) => ({ displayName: r.display_name, letterhead: r.letterhead, logoFileId: r.logo_file_id, settings: r.settings, version: r.version });

/** PLT-FR-007: profil & kop klinik. Hanya kolom profil yang dapat diubah (GRANT kolom + policy migrasi 0004). Logo: Stage 9 (unggah berkas). */
@Controller('api/v1/tenant/profile')
export class TenantProfileController {
  constructor(private readonly db: Db) {}

  @RequirePermission('tenant.profile.read') @Get()
  async get(@Res({ passthrough: true }) res: Response) {
    const [r] = await this.db.withTenantTx((tx) => rows<Row>(tx, sql`
      select display_name, letterhead, logo_file_id, settings, version from tenant where id = app.current_tenant_id()`));
    res.setHeader('ETag', `"${r.version}"`);
    return dto(r);
  }

  /** Optimistic locking (GEN-FR-007): If-Match wajib = versi terakhir. */
  @RequirePermission('tenant.profile.manage') @BodySchema(TenantProfileBody) @Put()
  async update(@Body() b: z.infer<typeof TenantProfileBody>, @Headers('if-match') ifMatch: string | undefined,
               @Res({ passthrough: true }) res: Response) {
    const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(ifMatch ?? '');
    if (!m) throw problem(428, 'GEN-428-IF-MATCH', 'Header If-Match (versi profil) wajib');
    const r = await this.db.withTenantTx(async (tx) => {
      if (b.logoFileId) {
        const [f] = await rows(tx, sql`select 1 from stored_file where id = ${b.logoFileId} and category = 'BRANDING'`);
        if (!f) throw problem(400, 'PLT-400-LOGO', 'Berkas logo tidak ditemukan');
      }
      const [cur] = await rows<Row>(tx, sql`select display_name, letterhead, logo_file_id, settings, version from tenant
                                            where id = app.current_tenant_id() for update`);
      if (cur.version !== Number(m[1])) throw problem(412, 'GEN-412-VERSION', 'Profil sudah diubah orang lain. Muat ulang lalu coba lagi.');
      const [upd] = await rows<Row>(tx, sql`
        update tenant set display_name = ${b.displayName},
               letterhead = ${b.letterhead === undefined ? cur.letterhead : b.letterhead}::jsonb,
               logo_file_id = ${b.logoFileId === undefined ? cur.logo_file_id : b.logoFileId}::uuid,
               settings = ${JSON.stringify(b.settings ?? cur.settings)}::jsonb
         where id = app.current_tenant_id()
         returning display_name, letterhead, logo_file_id, settings, version`);
      const changed = (['display_name', 'letterhead', 'logo_file_id', 'settings'] as const)
        .filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(upd[k]));
      await audit(tx, 'TENANT_PROFILE_UPDATED', 'tenant', ctx().tenantId!, null, { changed });
      return upd;
    });
    res.setHeader('ETag', `"${r.version}"`);
    return dto(r);
  }
}
