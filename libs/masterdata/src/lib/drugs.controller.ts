import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { BodySchema, RequirePermission, ctx, problem } from '@clinicrme/shared';
import { Db, type Tx, rows } from '@clinicrme/db';
import { Code, Uuid, assertId, assertVersion, auditChange, ifMatchVersion, merge } from './common';

export const DRUG_CLASSES = ['BEBAS', 'BEBAS_TERBATAS', 'KERAS', 'NARKOTIKA', 'PSIKOTROPIKA', 'PREKURSOR', 'ALKES', 'LAINNYA'] as const;
const Qty = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Angka positif, maks. 4 desimal'))
  .refine((s) => Number(s) > 0, 'Harus lebih dari 0');
/** Zat aktif disimpan huruf kecil tanpa spasi berlebih — dipakai cek alergi & duplikasi resep (CLN-FR-012). */
const Ingredient = z.string().trim().min(2).max(100).transform((s) => s.toLowerCase().replace(/\s+/g, ' '));

export const DrugBody = z.object({
  code: Code,
  genericName: z.string().trim().min(2).max(200),
  brandName: z.string().trim().max(200).nullable().optional(),
  dosageForm: z.string().trim().min(2).max(50),
  strength: z.string().trim().max(50).nullable().optional(),
  baseUomId: Uuid,
  drugClass: z.enum(DRUG_CLASSES),
  ingredients: z.array(Ingredient).min(1, 'Isi minimal satu zat aktif').max(10)
    .refine((a) => new Set(a).size === a.length, 'Zat aktif tercantum dua kali'),
  maxDoseQty: Qty.nullable().optional(),
  maxDailyQty: Qty.nullable().optional(),
  isActive: z.boolean().optional(),
}).strict();
const checkMax = (b: { maxDoseQty?: string | null; maxDailyQty?: string | null }) => {
  if (b.maxDoseQty && b.maxDailyQty && Number(b.maxDailyQty) < Number(b.maxDoseQty)) {
    throw problem(400, 'MST-400-DRUG-MAX', 'Batas per hari tidak boleh lebih kecil dari batas per pemberian');
  }
};

export interface DrugRow { id: string; code: string; generic_name: string; brand_name: string | null; dosage_form: string; strength: string | null;
  base_uom_id: string; uom_code: string; uom_name: string; drug_class: string; ingredients: string[]; max_dose_qty: string | null;
  max_daily_qty: string | null; is_active: boolean; version: number }
export const drugDto = (r: DrugRow) => ({ id: r.id, code: r.code, genericName: r.generic_name, brandName: r.brand_name, dosageForm: r.dosage_form,
  strength: r.strength, baseUomId: r.base_uom_id, uomCode: r.uom_code, uomName: r.uom_name, drugClass: r.drug_class, ingredients: r.ingredients,
  maxDoseQty: r.max_dose_qty, maxDailyQty: r.max_daily_qty, isActive: r.is_active, version: r.version });
export const DRUG = sql`select d.id, d.code, d.generic_name, d.brand_name, d.dosage_form, d.strength, d.base_uom_id, u.code as uom_code, u.name as uom_name,
                               d.drug_class, d.ingredients, trim_scale(d.max_dose_qty)::text as max_dose_qty,
                               trim_scale(d.max_daily_qty)::text as max_daily_qty, d.is_active, d.version
                          from drug_item d join uom u on u.id = d.base_uom_id`;
const DrugQuery = z.object({
  q: z.string().trim().max(100).optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^\d{1,6}$/).optional(),
});
export async function assertUom(tx: Tx, id: string) {
  const [u] = await rows<{ is_active: boolean }>(tx, sql`select is_active from uom where id = ${id}`);
  if (!u?.is_active) throw problem(400, 'MST-400-UOM', 'Satuan tidak ditemukan atau tidak aktif');
}

/**
 * Master obat minimal (OD-091 / DEC-038): identitas obat, bentuk & kekuatan, satuan dasar, golongan, zat aktif, dan
 * batas dosis opsional untuk peringatan resep (OD-033, [REVIEW-MEDIS]). Stok, harga, batch & KFA ditambah di Stage 10.
 * Obat tidak dihapus; dinonaktifkan. Perubahan teraudit sebelum/sesudah.
 */
@Controller('api/v1')
export class DrugsController {
  constructor(private readonly db: Db) {}

  @RequirePermission('pharmacy.drug.read') @Get('drugs')
  async list(@Query() query: Record<string, unknown>) {
    const p = DrugQuery.safeParse(query);
    if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const { q, includeInactive, limit, cursor } = p.data;
    const offset = Number(cursor ?? 0);
    const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const r = await this.db.withTenantTx((tx) => rows<DrugRow>(tx, sql`${DRUG}
      where (${includeInactive === 'true'}::boolean or d.is_active)
        and (${like}::text is null or d.generic_name ilike ${like} or d.brand_name ilike ${like} or d.code ilike ${like}
             or exists (select 1 from unnest(d.ingredients) i where i ilike ${like}))
      order by lower(d.generic_name), d.id limit ${limit + 1} offset ${offset}`));
    return { data: r.slice(0, limit).map(drugDto), page: { hasMore: r.length > limit, nextCursor: r.length > limit ? String(offset + limit) : null } };
  }

  @RequirePermission('pharmacy.drug.manage') @BodySchema(DrugBody) @Post('drugs') @HttpCode(201)
  async create(@Body() b: z.infer<typeof DrugBody>) {
    checkMax(b);
    return this.db.withTenantTx(async (tx) => {
      await assertUom(tx, b.baseUomId);
      const [dup] = await rows(tx, sql`select 1 from drug_item where code = ${b.code}`);
      if (dup) throw problem(409, 'MST-409-CODE', 'Kode obat sudah dipakai');
      const [{ id }] = await rows<{ id: string }>(tx, sql`
        insert into drug_item(tenant_id, code, generic_name, brand_name, dosage_form, strength, base_uom_id, drug_class, ingredients,
                              max_dose_qty, max_daily_qty, is_active, updated_by)
        values (app.current_tenant_id(), ${b.code}, ${b.genericName}, ${b.brandName ?? null}, ${b.dosageForm}, ${b.strength ?? null},
                ${b.baseUomId}, ${b.drugClass}, ${`{${b.ingredients.map((i) => JSON.stringify(i)).join(',')}}`}::text[],
                ${b.maxDoseQty ?? null}::numeric, ${b.maxDailyQty ?? null}::numeric, ${b.isActive ?? true}, ${ctx().userId}) returning id`);
      const [r] = await rows<DrugRow>(tx, sql`${DRUG} where d.id = ${id}`);
      const d = drugDto(r);
      await auditChange(tx, 'DRUG_CREATED', 'drug_item', id, null, d);
      return d;
    });
  }

  @RequirePermission('pharmacy.drug.manage') @BodySchema(DrugBody.partial().strict()) @Put('drugs/:id')
  async update(@Param('id') id: string, @Body() b: Partial<z.infer<typeof DrugBody>>,
               @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    assertId(id, 'MST-404-DRUG', 'Obat tidak ditemukan');
    const v = ifMatchVersion(ifMatch, 'obat');
    const out = await this.db.withTenantTx(async (tx) => {
      const [cur] = await rows<DrugRow>(tx, sql`${DRUG} where d.id = ${id} for update of d`);
      if (!cur) throw problem(404, 'MST-404-DRUG', 'Obat tidak ditemukan');
      assertVersion(cur.version, v, 'Obat');
      const before = drugDto(cur);
      const n = merge(before, b);
      checkMax(n);
      if (n.baseUomId !== cur.base_uom_id) await assertUom(tx, n.baseUomId);
      if (n.code !== cur.code) {
        const [dup] = await rows(tx, sql`select 1 from drug_item where code = ${n.code} and id <> ${id}`);
        if (dup) throw problem(409, 'MST-409-CODE', 'Kode obat sudah dipakai');
      }
      await tx.execute(sql`
        update drug_item set code = ${n.code}, generic_name = ${n.genericName}, brand_name = ${n.brandName}, dosage_form = ${n.dosageForm},
               strength = ${n.strength}, base_uom_id = ${n.baseUomId}, drug_class = ${n.drugClass},
               ingredients = ${`{${n.ingredients.map((i) => JSON.stringify(i)).join(',')}}`}::text[],
               max_dose_qty = ${n.maxDoseQty}::numeric, max_daily_qty = ${n.maxDailyQty}::numeric, is_active = ${n.isActive}, updated_by = ${ctx().userId}
         where id = ${id}`);
      const [r] = await rows<DrugRow>(tx, sql`${DRUG} where d.id = ${id}`);
      const after = drugDto(r);
      await auditChange(tx, 'DRUG_UPDATED', 'drug_item', id, before, after);
      return after;
    });
    res.setHeader('ETag', `"${out.version}"`);
    return out;
  }
}
