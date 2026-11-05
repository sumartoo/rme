import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { BodySchema, RequirePermission, ctx, problem } from '@clinicrme/shared';
import { Db, rows } from '@clinicrme/db';
import { Code, Name, assertId, assertVersion, auditChange, ifMatchVersion, merge } from './common';
import { PAYER_TYPES, Rupiah } from './services.controller';

/** Ketentuan kontrak penjamin (kolom `payer.contract`): dipakai billing (Stage 11) — di sini hanya disimpan & divalidasi. */
const Contract = z.object({
  contractNumber: z.string().trim().max(100).optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  plafon: Rupiah.optional(),
  copayPercent: z.number().min(0).max(100).optional(),
  paymentTermDays: z.number().int().min(0).max(365).optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();
export const PayerBody = z.object({
  code: Code,
  name: Name,
  payerType: z.enum(PAYER_TYPES),
  contract: Contract.nullable().optional(),
  isActive: z.boolean().optional(),
}).strict();
const ListQuery = z.object({ includeInactive: z.enum(['true', 'false']).optional(), type: z.enum(PAYER_TYPES).optional() });

interface Row { id: string; code: string; name: string; payer_type: string; contract: Record<string, unknown> | null; is_active: boolean; version: number }
const dto = (r: Row) => ({ id: r.id, code: r.code, name: r.name, payerType: r.payer_type, contract: r.contract, isActive: r.is_active, version: r.version });
const SELECT = sql`select id, code, name, payer_type, contract, is_active, version from payer`;

/**
 * Penjamin (MST-FR-006): Umum, Asuransi, Perusahaan (dengan kontrak), BPJS (Lanjutan, BPJ-FR-004). Tidak dihapus —
 * dinonaktifkan, karena dirujuk tarif & tagihan.
 */
@Controller('api/v1/payers')
export class PayersController {
  constructor(private readonly db: Db) {}

  @RequirePermission('master.payer.read') @Get()
  async list(@Query() q: Record<string, unknown>) {
    const p = ListQuery.safeParse(q);
    if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const r = await this.db.withTenantTx((tx) => rows<Row>(tx, sql`${SELECT}
      where (${p.data.includeInactive === 'true'}::boolean or is_active) and (${p.data.type ?? null}::text is null or payer_type = ${p.data.type ?? null})
      order by payer_type, name`));
    return r.map(dto);
  }

  @RequirePermission('master.payer.manage') @BodySchema(PayerBody) @Post() @HttpCode(201)
  async create(@Body() b: z.infer<typeof PayerBody>) {
    return this.db.withTenantTx(async (tx) => {
      const [dup] = await rows(tx, sql`select 1 from payer where code = ${b.code}`);
      if (dup) throw problem(409, 'MST-409-CODE', 'Kode penjamin sudah dipakai');
      const [r] = await rows<Row>(tx, sql`
        insert into payer(tenant_id, code, name, payer_type, contract, is_active, updated_by)
        values (app.current_tenant_id(), ${b.code}, ${b.name}, ${b.payerType}, ${b.contract ? JSON.stringify(b.contract) : null}::jsonb,
                ${b.isActive ?? true}, ${ctx().userId})
        returning id, code, name, payer_type, contract, is_active, version`);
      const d = dto(r);
      await auditChange(tx, 'PAYER_CREATED', 'payer', r.id, null, d);
      return d;
    });
  }

  @RequirePermission('master.payer.manage') @BodySchema(PayerBody.partial().strict()) @Put(':id')
  async update(@Param('id') id: string, @Body() b: Partial<z.infer<typeof PayerBody>>,
               @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    assertId(id, 'MST-404-PAYER', 'Penjamin tidak ditemukan');
    const v = ifMatchVersion(ifMatch, 'penjamin');
    const out = await this.db.withTenantTx(async (tx) => {
      const [cur] = await rows<Row>(tx, sql`${SELECT} where id = ${id} for update`);
      if (!cur) throw problem(404, 'MST-404-PAYER', 'Penjamin tidak ditemukan');
      assertVersion(cur.version, v, 'Penjamin');
      const before = dto(cur);
      const n = merge(before, b);
      if (n.code !== cur.code) {
        const [dup] = await rows(tx, sql`select 1 from payer where code = ${n.code} and id <> ${id}`);
        if (dup) throw problem(409, 'MST-409-CODE', 'Kode penjamin sudah dipakai');
      }
      // Kategori penjamin yang sudah dipakai tarif tidak boleh berubah (tarif menyimpan kategori yang sama)
      if (n.payerType !== cur.payer_type) {
        const [used] = await rows(tx, sql`select 1 from tariff where payer_id = ${id} limit 1`);
        if (used) throw problem(409, 'MST-409-PAYER-TYPE', 'Kategori penjamin tidak dapat diubah karena sudah dipakai di tarif');
      }
      const [r] = await rows<Row>(tx, sql`
        update payer set code = ${n.code}, name = ${n.name}, payer_type = ${n.payerType},
               contract = ${n.contract ? JSON.stringify(n.contract) : null}::jsonb, is_active = ${n.isActive}, updated_by = ${ctx().userId}
         where id = ${id} returning id, code, name, payer_type, contract, is_active, version`);
      const after = dto(r);
      await auditChange(tx, 'PAYER_UPDATED', 'payer', id, before, after);
      return after;
    });
    res.setHeader('ETag', `"${out.version}"`);
    return out;
  }
}
