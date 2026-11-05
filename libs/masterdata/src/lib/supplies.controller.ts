import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { BodySchema, NoBody, RequirePermission, ctx, problem } from '@clinicrme/shared';
import { Db, rows } from '@clinicrme/db';
import { Code, Name, assertId, assertVersion, auditChange, ifMatchVersion, merge, optText } from './common';

// ---------------------------------------------------------------------------------------------- Satuan
export const UomBody = z.object({ code: Code, name: Name.max(100), isActive: z.boolean().optional() }).strict();
/** 1 satuan asal = factor × satuan tujuan (mis. 1 BOX = 10 STRIP). Maks 6 desimal. */
const Factor = z.union([z.string(), z.number()]).transform(String)
  .pipe(z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'Faktor konversi tidak valid'))
  .refine((s) => Number(s) > 0, 'Faktor harus lebih dari 0');
const ConversionBody = z.object({ factor: Factor }).strict();
interface UomRow { id: string; code: string; name: string; is_active: boolean; version: number; conversions: { toUomId: string; factor: string }[] }
const uomDto = (r: UomRow) => ({ id: r.id, code: r.code, name: r.name, isActive: r.is_active, version: r.version, conversions: r.conversions });
const UOM = sql`select u.id, u.code, u.name, u.is_active, u.version,
                       coalesce((select jsonb_agg(jsonb_build_object('toUomId', c.to_uom_id, 'factor', trim_scale(c.factor)::text) order by c.factor)
                                   from uom_conversion c where c.from_uom_id = u.id and c.drug_item_id is null), '[]'::jsonb) as conversions
                  from uom u`;

// ---------------------------------------------------------------------------------------------- Supplier
export const SupplierBody = z.object({
  code: Code.nullable().optional(),
  name: Name,
  contactPerson: optText(200),
  phone: optText(30),
  email: z.string().trim().toLowerCase().email().max(254).nullable().optional().or(z.literal('').transform(() => null)),
  address: optText(500),
  npwp: z.string().trim().regex(/^[\d.-]{15,20}$/, 'NPWP tidak valid').nullable().optional().or(z.literal('').transform(() => null)),
  isActive: z.boolean().optional(),
}).strict();
interface SupplierRow { id: string; code: string | null; name: string; contact_person: string | null; phone: string | null; email: string | null;
  address: string | null; npwp: string | null; is_active: boolean; version: number }
const supplierDto = (r: SupplierRow) => ({ id: r.id, code: r.code, name: r.name, contactPerson: r.contact_person, phone: r.phone, email: r.email,
  address: r.address, npwp: r.npwp, isActive: r.is_active, version: r.version });
const SUPPLIER = sql`select id, code, name, contact_person, phone, email, address, npwp, is_active, version from supplier`;
const ListQuery = z.object({ includeInactive: z.enum(['true', 'false']).optional(), q: z.string().trim().max(100).optional() });

/**
 * Satuan & konversi (MST-FR-007) dan supplier obat (MST-FR-010). Konversi umum (tanpa obat tertentu) dicek tidak
 * melingkar: bila sudah ada jalur tujuan → … → asal, konversi asal → tujuan ditolak. Konversi khusus obat: Stage 10.
 */
@Controller('api/v1')
export class SuppliesController {
  constructor(private readonly db: Db) {}

  @RequirePermission('master.uom.read') @Get('uoms')
  async uoms(@Query() q: Record<string, unknown>) {
    const p = ListQuery.safeParse(q);
    if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const r = await this.db.withTenantTx((tx) => rows<UomRow>(tx, sql`${UOM} where ${p.data.includeInactive === 'true'}::boolean or u.is_active order by u.code`));
    return r.map(uomDto);
  }

  @RequirePermission('master.uom.manage') @BodySchema(UomBody) @Post('uoms') @HttpCode(201)
  async createUom(@Body() b: z.infer<typeof UomBody>) {
    return this.db.withTenantTx(async (tx) => {
      const [dup] = await rows(tx, sql`select 1 from uom where code = ${b.code}`);
      if (dup) throw problem(409, 'MST-409-CODE', 'Kode satuan sudah dipakai');
      const [{ id }] = await rows<{ id: string }>(tx, sql`insert into uom(tenant_id, code, name, is_active, updated_by)
        values (app.current_tenant_id(), ${b.code}, ${b.name}, ${b.isActive ?? true}, ${ctx().userId}) returning id`);
      const [r] = await rows<UomRow>(tx, sql`${UOM} where u.id = ${id}`);
      const d = uomDto(r);
      await auditChange(tx, 'UOM_CREATED', 'uom', id, null, { code: d.code, name: d.name, isActive: d.isActive });
      return d;
    });
  }

  @RequirePermission('master.uom.manage') @BodySchema(UomBody.partial().strict()) @Put('uoms/:id')
  async updateUom(@Param('id') id: string, @Body() b: Partial<z.infer<typeof UomBody>>,
                  @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    assertId(id, 'MST-404-UOM', 'Satuan tidak ditemukan');
    const v = ifMatchVersion(ifMatch, 'satuan');
    const out = await this.db.withTenantTx(async (tx) => {
      const [lock] = await rows(tx, sql`select 1 from uom where id = ${id} for update`);
      const [cur] = lock ? await rows<UomRow>(tx, sql`${UOM} where u.id = ${id}`) : [];
      if (!cur) throw problem(404, 'MST-404-UOM', 'Satuan tidak ditemukan');
      assertVersion(cur.version, v, 'Satuan');
      const before = { code: cur.code, name: cur.name, isActive: cur.is_active };
      const n = merge(before, b);
      if (n.code !== cur.code) {
        const [dup] = await rows(tx, sql`select 1 from uom where code = ${n.code} and id <> ${id}`);
        if (dup) throw problem(409, 'MST-409-CODE', 'Kode satuan sudah dipakai');
      }
      await tx.execute(sql`update uom set code = ${n.code}, name = ${n.name}, is_active = ${n.isActive}, updated_by = ${ctx().userId} where id = ${id}`);
      await auditChange(tx, 'UOM_UPDATED', 'uom', id, before, n);
      const [r] = await rows<UomRow>(tx, sql`${UOM} where u.id = ${id}`);
      return uomDto(r);
    });
    res.setHeader('ETag', `"${out.version}"`);
    return out;
  }

  /** Tetapkan/ubah konversi umum asal → tujuan. */
  @RequirePermission('master.uom.manage') @BodySchema(ConversionBody) @Put('uoms/:id/conversions/:toId')
  async setConversion(@Param('id') id: string, @Param('toId') toId: string, @Body() b: z.infer<typeof ConversionBody>) {
    assertId(id, 'MST-404-UOM', 'Satuan tidak ditemukan');
    assertId(toId, 'MST-404-UOM', 'Satuan tidak ditemukan');
    if (id === toId) throw problem(400, 'MST-400-UOM-SELF', 'Satuan asal dan tujuan harus berbeda');
    return this.db.withTenantTx(async (tx) => {
      // Serialisasi perubahan konversi per tenant agar dua konversi berlawanan tidak lolos bersamaan
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('uom_conversion:' || app.current_tenant_id()::text))`);
      const found = await rows<{ id: string; code: string }>(tx, sql`select id, code from uom where id in (${id}, ${toId})`);
      if (found.length !== 2) throw problem(404, 'MST-404-UOM', 'Satuan tidak ditemukan');
      const [cycle] = await rows(tx, sql`
        with recursive path(node) as (
          select ${toId}::uuid
          union
          select c.to_uom_id from uom_conversion c join path p on c.from_uom_id = p.node where c.drug_item_id is null
        ) select 1 from path where node = ${id}::uuid limit 1`);
      if (cycle) throw problem(409, 'MST-409-UOM-CYCLE', 'Konversi melingkar: satuan tujuan sudah dikonversi (langsung/tidak langsung) ke satuan asal');
      const [old] = await rows<{ factor: string }>(tx, sql`select trim_scale(factor)::text as factor from uom_conversion
        where from_uom_id = ${id} and to_uom_id = ${toId} and drug_item_id is null for update`);
      if (old) await tx.execute(sql`update uom_conversion set factor = ${b.factor}::numeric where from_uom_id = ${id} and to_uom_id = ${toId} and drug_item_id is null`);
      else await tx.execute(sql`insert into uom_conversion(tenant_id, from_uom_id, to_uom_id, factor) values (app.current_tenant_id(), ${id}, ${toId}, ${b.factor}::numeric)`);
      const [norm] = await rows<{ factor: string }>(tx, sql`select trim_scale(${b.factor}::numeric)::text as factor`);
      await auditChange(tx, 'UOM_CONVERSION_SET', 'uom', id, old ? { toUomId: toId, factor: old.factor } : null, { toUomId: toId, factor: norm.factor });
      return { fromUomId: id, toUomId: toId, factor: norm.factor };
    });
  }

  @RequirePermission('master.uom.manage') @NoBody() @Delete('uoms/:id/conversions/:toId') @HttpCode(204)
  async deleteConversion(@Param('id') id: string, @Param('toId') toId: string) {
    assertId(id, 'MST-404-UOM', 'Konversi tidak ditemukan');
    assertId(toId, 'MST-404-UOM', 'Konversi tidak ditemukan');
    await this.db.withTenantTx(async (tx) => {
      const [old] = await rows<{ factor: string }>(tx, sql`delete from uom_conversion where from_uom_id = ${id} and to_uom_id = ${toId}
        and drug_item_id is null returning trim_scale(factor)::text as factor`);
      if (!old) throw problem(404, 'MST-404-UOM', 'Konversi tidak ditemukan');
      await auditChange(tx, 'UOM_CONVERSION_DELETED', 'uom', id, { toUomId: toId, factor: old.factor }, { toUomId: toId, factor: null });
    });
  }

  // ------------------------------------------------------------------------------------------ supplier
  @RequirePermission('master.supplier.read') @Get('suppliers')
  async suppliers(@Query() q: Record<string, unknown>) {
    const p = ListQuery.safeParse(q);
    if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const like = p.data.q ? `%${p.data.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const r = await this.db.withTenantTx((tx) => rows<SupplierRow>(tx, sql`${SUPPLIER}
      where (${p.data.includeInactive === 'true'}::boolean or is_active) and (${like}::text is null or name ilike ${like} or code ilike ${like})
      order by lower(name)`));
    return r.map(supplierDto);
  }

  @RequirePermission('master.supplier.manage') @BodySchema(SupplierBody) @Post('suppliers') @HttpCode(201)
  async createSupplier(@Body() b: z.infer<typeof SupplierBody>) {
    return this.db.withTenantTx(async (tx) => {
      if (b.code) {
        const [dup] = await rows(tx, sql`select 1 from supplier where code = ${b.code}`);
        if (dup) throw problem(409, 'MST-409-CODE', 'Kode supplier sudah dipakai');
      }
      const [r] = await rows<SupplierRow>(tx, sql`
        insert into supplier(tenant_id, code, name, contact_person, phone, email, address, npwp, is_active, updated_by)
        values (app.current_tenant_id(), ${b.code ?? null}, ${b.name}, ${b.contactPerson ?? null}, ${b.phone ?? null}, ${b.email ?? null},
                ${b.address ?? null}, ${b.npwp ?? null}, ${b.isActive ?? true}, ${ctx().userId})
        returning id, code, name, contact_person, phone, email, address, npwp, is_active, version`);
      const d = supplierDto(r);
      await auditChange(tx, 'SUPPLIER_CREATED', 'supplier', r.id, null, d);
      return d;
    });
  }

  @RequirePermission('master.supplier.manage') @BodySchema(SupplierBody.partial().strict()) @Put('suppliers/:id')
  async updateSupplier(@Param('id') id: string, @Body() b: Partial<z.infer<typeof SupplierBody>>,
                       @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    assertId(id, 'MST-404-SUPPLIER', 'Supplier tidak ditemukan');
    const v = ifMatchVersion(ifMatch, 'supplier');
    const out = await this.db.withTenantTx(async (tx) => {
      const [cur] = await rows<SupplierRow>(tx, sql`${SUPPLIER} where id = ${id} for update`);
      if (!cur) throw problem(404, 'MST-404-SUPPLIER', 'Supplier tidak ditemukan');
      assertVersion(cur.version, v, 'Supplier');
      const before = supplierDto(cur);
      const n = merge(before, b);
      if (n.code && n.code !== cur.code) {
        const [dup] = await rows(tx, sql`select 1 from supplier where code = ${n.code} and id <> ${id}`);
        if (dup) throw problem(409, 'MST-409-CODE', 'Kode supplier sudah dipakai');
      }
      const [r] = await rows<SupplierRow>(tx, sql`
        update supplier set code = ${n.code}, name = ${n.name}, contact_person = ${n.contactPerson}, phone = ${n.phone}, email = ${n.email},
               address = ${n.address}, npwp = ${n.npwp}, is_active = ${n.isActive}, updated_by = ${ctx().userId}
         where id = ${id} returning id, code, name, contact_person, phone, email, address, npwp, is_active, version`);
      const after = supplierDto(r);
      await auditChange(tx, 'SUPPLIER_UPDATED', 'supplier', id, before, after);
      return after;
    });
    res.setHeader('ETag', `"${out.version}"`);
    return out;
  }
}
