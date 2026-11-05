import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { BodySchema, RequirePermission, ctx, problem } from '@clinicrme/shared';
import { Db, type Tx, rows } from '@clinicrme/db';
import { Code, IsoDate, Name, Uuid, assertId, assertVersion, auditChange, ifMatchVersion, merge } from './common';

export const SERVICE_TYPES = ['KONSULTASI', 'TINDAKAN', 'PAKET', 'ADMINISTRASI', 'LAB', 'LAINNYA'] as const;
export const PAYER_TYPES = ['UMUM', 'ASURANSI', 'PERUSAHAAN', 'BPJS'] as const;
/** OD-082: Rupiah bulat (boleh ".00"), tanpa pajak. Dikirim sebagai string agar tidak melewati float. */
export const Rupiah = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,13}(\.0{1,2})?$/, 'Harga dalam Rupiah bulat'))
  .transform((s) => s.replace(/\.0+$/, ''));

// ---------------------------------------------------------------------------------------------- Layanan
export const ServiceBody = z.object({
  code: Code,
  name: Name,
  serviceType: z.enum(SERVICE_TYPES),
  icd9cmCode: z.string().trim().regex(/^\d{2}(\.\d{1,2})?$/, 'Kode ICD-9-CM tidak valid').nullable().optional(),
  isActive: z.boolean().optional(),
}).strict();
interface ServiceRow { id: string; code: string; name: string; service_type: string; icd9cm_code: string | null; is_active: boolean; version: number }
const serviceDto = (r: ServiceRow) => ({ id: r.id, code: r.code, name: r.name, serviceType: r.service_type, icd9cmCode: r.icd9cm_code,
  isActive: r.is_active, version: r.version });
const SERVICE = sql`select id, code, name, service_type, icd9cm_code, is_active, version from service_item`;
const ServiceQuery = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(SERVICE_TYPES).optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^\d{1,6}$/).optional(),
});

// ---------------------------------------------------------------------------------------------- Tarif
export const TariffBody = z.object({
  serviceItemId: Uuid,
  branchId: Uuid.nullable().optional(),
  payerType: z.enum(PAYER_TYPES).nullable().optional(),
  payerId: Uuid.nullable().optional(),
  price: Rupiah,
  validFrom: IsoDate,
  validTo: IsoDate.nullable().optional(),
  /** Tutup otomatis periode sebelumnya yang masih berlaku pada `validFrom` (validTo = validFrom − 1 hari). */
  closePrevious: z.boolean().optional(),
}).strict().refine((b) => !b.validTo || b.validTo >= b.validFrom, { message: 'Tanggal akhir sebelum tanggal mulai', path: ['validTo'] });
const EndBody = z.object({ validTo: IsoDate }).strict();
const TariffQuery = z.object({
  serviceItemId: Uuid.optional(),
  branchId: Uuid.optional(),
  payerType: z.enum(PAYER_TYPES).optional(),
  /** Hanya tarif yang berlaku pada tanggal ini (YYYY-MM-DD). */
  on: IsoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().regex(/^\d{1,6}$/).optional(),
});
interface TariffRow { id: string; service_item_id: string; branch_id: string | null; payer_type: string | null; payer_id: string | null;
  price: string; valid_from: string; valid_to: string | null; created_at: Date }
const tariffDto = (r: TariffRow) => ({ id: r.id, serviceItemId: r.service_item_id, branchId: r.branch_id, payerType: r.payer_type,
  payerId: r.payer_id, price: r.price, validFrom: r.valid_from, validTo: r.valid_to });
const TARIFF = sql`select id, service_item_id, branch_id, payer_type, payer_id, price::text as price,
                          to_char(valid_from, 'YYYY-MM-DD') as valid_from, to_char(valid_to, 'YYYY-MM-DD') as valid_to, created_at
                     from tariff`;
/** Kunci tarif: periode dengan kunci sama tidak boleh tumpang tindih (constraint ex_tariff_no_overlap). */
const sameKey = (t: { serviceItemId: string; branchId: string | null; payerType: string | null; payerId: string | null }) => sql`
  service_item_id = ${t.serviceItemId} and branch_id is not distinct from ${t.branchId}::uuid
  and payer_type is not distinct from ${t.payerType}::text and payer_id is not distinct from ${t.payerId}::uuid`;

const offsetPage = <T>(r: T[], limit: number, offset: number) =>
  ({ data: r.slice(0, limit), page: { hasMore: r.length > limit, nextCursor: r.length > limit ? String(offset + limit) : null } });
const likeOf = (q?: string) => (q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null);

/**
 * Layanan (MST-FR-004) & tarif (MST-FR-005). Tarif berlaku per layanan × cabang (null = semua cabang) × penjamin
 * (kategori atau penjamin tertentu) × periode. Tarif tidak pernah ditimpa: harga baru = periode baru; periode lama
 * hanya dapat ditutup (tanggal akhir dimajukan). Ditegakkan juga oleh trigger database (migrasi 0012).
 */
@Controller('api/v1')
export class ServicesController {
  constructor(private readonly db: Db) {}

  @RequirePermission('master.service.read') @Get('service-items')
  async services(@Query() query: Record<string, unknown>) {
    const p = ServiceQuery.safeParse(query);
    if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const { q, type, includeInactive, limit, cursor } = p.data;
    const offset = Number(cursor ?? 0);
    const like = likeOf(q);
    const r = await this.db.withTenantTx((tx) => rows<ServiceRow>(tx, sql`${SERVICE}
      where (${includeInactive === 'true'}::boolean or is_active)
        and (${like}::text is null or name ilike ${like} or code ilike ${like})
        and (${type ?? null}::text is null or service_type = ${type ?? null})
      order by lower(name), id limit ${limit + 1} offset ${offset}`));
    return offsetPage(r.map(serviceDto), limit, offset);
  }

  @RequirePermission('master.service.manage') @BodySchema(ServiceBody) @Post('service-items') @HttpCode(201)
  async createService(@Body() b: z.infer<typeof ServiceBody>) {
    return this.db.withTenantTx(async (tx) => {
      const [dup] = await rows(tx, sql`select 1 from service_item where code = ${b.code}`);
      if (dup) throw problem(409, 'MST-409-CODE', 'Kode layanan sudah dipakai');
      const [r] = await rows<ServiceRow>(tx, sql`
        insert into service_item(tenant_id, code, name, service_type, icd9cm_code, is_active, updated_by)
        values (app.current_tenant_id(), ${b.code}, ${b.name}, ${b.serviceType}, ${b.icd9cmCode ?? null}, ${b.isActive ?? true}, ${ctx().userId})
        returning id, code, name, service_type, icd9cm_code, is_active, version`);
      const d = serviceDto(r);
      await auditChange(tx, 'SERVICE_ITEM_CREATED', 'service_item', r.id, null, d);
      return d;
    });
  }

  @RequirePermission('master.service.manage') @BodySchema(ServiceBody.partial().strict()) @Put('service-items/:id')
  async updateService(@Param('id') id: string, @Body() b: Partial<z.infer<typeof ServiceBody>>,
                      @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    assertId(id, 'MST-404-SERVICE', 'Layanan tidak ditemukan');
    const v = ifMatchVersion(ifMatch, 'layanan');
    const out = await this.db.withTenantTx(async (tx) => {
      const [cur] = await rows<ServiceRow>(tx, sql`${SERVICE} where id = ${id} for update`);
      if (!cur) throw problem(404, 'MST-404-SERVICE', 'Layanan tidak ditemukan');
      assertVersion(cur.version, v, 'Layanan');
      const before = serviceDto(cur);
      const n = merge(before, b);
      if (n.code !== cur.code) {
        const [dup] = await rows(tx, sql`select 1 from service_item where code = ${n.code} and id <> ${id}`);
        if (dup) throw problem(409, 'MST-409-CODE', 'Kode layanan sudah dipakai');
      }
      const [r] = await rows<ServiceRow>(tx, sql`
        update service_item set code = ${n.code}, name = ${n.name}, service_type = ${n.serviceType}, icd9cm_code = ${n.icd9cmCode},
               is_active = ${n.isActive}, updated_by = ${ctx().userId}
         where id = ${id} returning id, code, name, service_type, icd9cm_code, is_active, version`);
      const after = serviceDto(r);
      await auditChange(tx, 'SERVICE_ITEM_UPDATED', 'service_item', id, before, after);
      return after;
    });
    res.setHeader('ETag', `"${out.version}"`);
    return out;
  }

  // ------------------------------------------------------------------------------------------ tarif
  @RequirePermission('master.tariff.read') @Get('tariffs')
  async tariffs(@Query() query: Record<string, unknown>) {
    const p = TariffQuery.safeParse(query);
    if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const { serviceItemId, branchId, payerType, on, limit, cursor } = p.data;
    const offset = Number(cursor ?? 0);
    const r = await this.db.withTenantTx((tx) => rows<TariffRow>(tx, sql`${TARIFF}
      where (${serviceItemId ?? null}::uuid is null or service_item_id = ${serviceItemId ?? null}::uuid)
        and (${branchId ?? null}::uuid is null or branch_id = ${branchId ?? null}::uuid)
        and (${payerType ?? null}::text is null or payer_type = ${payerType ?? null})
        and (${on ?? null}::date is null or (valid_from <= ${on ?? null}::date and (valid_to is null or valid_to >= ${on ?? null}::date)))
      order by service_item_id, branch_id nulls first, payer_type nulls first, payer_id nulls first, valid_from desc
      limit ${limit + 1} offset ${offset}`));
    return offsetPage(r.map(tariffDto), limit, offset);
  }

  @RequirePermission('master.tariff.manage') @BodySchema(TariffBody) @Post('tariffs') @HttpCode(201)
  async createTariff(@Body() b: z.infer<typeof TariffBody>) {
    return this.db.withTenantTx(async (tx) => {
      const key = await this.resolveKey(tx, b);
      if (b.closePrevious) {
        // Periode terbuka/berjalan dengan kunci sama yang dimulai sebelum tanggal baru → ditutup sehari sebelumnya
        const prev = await rows<TariffRow>(tx, sql`${TARIFF} where ${sameKey(key)} and valid_from < ${b.validFrom}::date
          and (valid_to is null or valid_to >= ${b.validFrom}::date) for update`);
        for (const t of prev) {
          await tx.execute(sql`update tariff set valid_to = ${b.validFrom}::date - 1 where id = ${t.id}`);
          await auditChange(tx, 'TARIFF_ENDED', 'tariff', t.id, { validTo: t.valid_to }, { validTo: prevDay(b.validFrom) });
        }
      }
      const [r] = await rows<TariffRow>(tx, sql`
        insert into tariff(tenant_id, service_item_id, branch_id, payer_type, payer_id, price, valid_from, valid_to, created_by)
        values (app.current_tenant_id(), ${key.serviceItemId}, ${key.branchId}::uuid, ${key.payerType}, ${key.payerId}::uuid, ${b.price}::numeric,
                ${b.validFrom}::date, ${b.validTo ?? null}::date, ${ctx().userId})
        returning id, service_item_id, branch_id, payer_type, payer_id, price::text as price,
                  to_char(valid_from, 'YYYY-MM-DD') as valid_from, to_char(valid_to, 'YYYY-MM-DD') as valid_to, created_at`);
      const d = tariffDto(r);
      await auditChange(tx, 'TARIFF_CREATED', 'tariff', r.id, null, d);
      return d;
    });
  }

  /** Tutup periode tarif (tanggal akhir hanya dapat dimajukan, tidak diperpanjang). */
  @RequirePermission('master.tariff.manage') @BodySchema(EndBody) @Post('tariffs/:id/end') @HttpCode(200)
  async endTariff(@Param('id') id: string, @Body() b: z.infer<typeof EndBody>) {
    assertId(id, 'MST-404-TARIFF', 'Tarif tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      const [cur] = await rows<TariffRow>(tx, sql`${TARIFF} where id = ${id} for update`);
      if (!cur) throw problem(404, 'MST-404-TARIFF', 'Tarif tidak ditemukan');
      if (b.validTo < cur.valid_from) throw problem(400, 'MST-400-TARIFF-DATE', 'Tanggal akhir sebelum tanggal mulai tarif');
      if (cur.valid_to && b.validTo > cur.valid_to) throw problem(409, 'MST-409-TARIFF-IMMUTABLE', 'Periode tarif yang sudah ditutup tidak dapat diperpanjang');
      await tx.execute(sql`update tariff set valid_to = ${b.validTo}::date where id = ${id}`);
      await auditChange(tx, 'TARIFF_ENDED', 'tariff', id, { validTo: cur.valid_to }, { validTo: b.validTo });
      return { ...tariffDto(cur), validTo: b.validTo };
    });
  }

  /** Penjamin tertentu menentukan kategorinya; layanan & cabang harus milik klinik ini. */
  private async resolveKey(tx: Tx, b: z.infer<typeof TariffBody>) {
    const [s] = await rows(tx, sql`select 1 from service_item where id = ${b.serviceItemId}`);
    if (!s) throw problem(400, 'MST-400-SERVICE', 'Layanan tidak ditemukan');
    if (b.branchId) {
      const [br] = await rows(tx, sql`select 1 from branch where id = ${b.branchId}`);
      if (!br) throw problem(400, 'MST-400-BRANCH', 'Cabang tidak ditemukan');
    }
    let payerType: string | null = b.payerType ?? null;
    if (b.payerId) {
      const [p] = await rows<{ payer_type: string }>(tx, sql`select payer_type from payer where id = ${b.payerId}`);
      if (!p) throw problem(400, 'MST-400-PAYER', 'Penjamin tidak ditemukan');
      if (payerType && payerType !== p.payer_type) throw problem(400, 'MST-400-PAYER', 'Kategori penjamin tidak sesuai dengan penjamin yang dipilih');
      payerType = p.payer_type;
    }
    return { serviceItemId: b.serviceItemId, branchId: b.branchId ?? null, payerType, payerId: b.payerId ?? null };
  }
}

function prevDay(d: string) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}
