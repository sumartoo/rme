import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, RequirePermission, Uuid, assertId, ctx, optText, problem, problemWith } from '@clinicrme/shared';
import { Db, type Tx, audit, idempotent, rows } from '@clinicrme/db';
import { allocate, batchesFor, dispenseLocation, lockStock, round4 } from './dispense.repo';
import { currentPrice } from './stock.repo';

const OTC_NOT_FOUND = ['PHM-404-OTC', 'Penjualan tidak ditemukan'] as const;
export const OTC_CLASSES = ['BEBAS', 'BEBAS_TERBATAS'];
const SaleBody = z.object({
  branchId: Uuid, locationId: Uuid.nullable().optional(), patientId: Uuid.nullable().optional(),
  customerName: optText(200), notes: optText(500),
  lines: z.array(z.object({ drugItemId: Uuid, qty: z.number().positive().max(100_000).transform(round4) }).strict()).min(1).max(30),
}).strict();
const CancelBody = z.object({ reason: z.string().trim().min(5).max(300) }).strict();
const ListQuery = z.object({
  branchId: Uuid.optional(), status: z.enum(['AWAITING_PAYMENT', 'PAID', 'CANCELLED']).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * Penjualan obat bebas tanpa kunjungan (PHM-FR-012; OD-101 / DEC-039): hanya golongan Bebas & Bebas terbatas (juga
 * dijaga trigger DB), harga penjamin Umum yang berlaku, batch FEFO/FIFO dari lokasi cabang dengan kunci stok yang sama
 * dengan penyerahan resep. Status menunggu bayar — pembayaran diterima kasir di Stage 11. Batal sebelum dibayar
 * mengembalikan stok ke batch asal (mutasi RETURN_IN).
 */
@Controller('api/v1')
export class OtcController {
  constructor(private readonly db: Db) {}

  @RequirePermission('pharmacy.otc.sell') @Get('otc-sales')
  async list(@Query() query: Record<string, string | undefined>) {
    const P = ListQuery.safeParse(query);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const f = P.data;
    return this.db.withTenantTx(async (tx) => {
      const r = await rows<{ id: string }>(tx, sql`
        select o.id from otc_sale o join branch br on br.id = o.branch_id
         where (${f.branchId ?? null}::uuid is null or o.branch_id = ${f.branchId ?? null}::uuid)
           and (${f.status ?? null}::text is null or o.status = ${f.status ?? null}::text)
           and (o.sold_at at time zone br.timezone)::date = coalesce(${f.date ?? null}::date, (now() at time zone br.timezone)::date)
         order by o.sold_at desc limit 200`);
      const out = [];
      for (const x of r) out.push(await this.one(tx, x.id));
      return out;
    });
  }

  @RequirePermission('pharmacy.otc.sell') @Get('otc-sales/:id')
  async get(@Param('id') id: string) {
    assertId(id, ...OTC_NOT_FOUND);
    return this.db.withTenantTx((tx) => this.one(tx, id));
  }

  @RequirePermission('pharmacy.otc.sell') @BodySchema(SaleBody) @Post('otc-sales') @HttpCode(201)
  async create(@Body() b: z.infer<typeof SaleBody>, @Headers('idempotency-key') key: string | undefined) {
    return this.db.withTenantTx((tx) => idempotent(tx, 'otc.sale', key, b, async () => {
      const [br] = await rows<{ today: string; is_active: boolean }>(tx, sql`
        select to_char(now() at time zone b.timezone, 'YYYY-MM-DD') as today, b.is_active from branch b where b.id = ${b.branchId}`);
      if (!br?.is_active) throw problem(400, 'MST-404-BRANCH', 'Cabang tidak ditemukan atau tidak aktif');
      const loc = await dispenseLocation(tx, b.branchId, b.locationId);
      if (b.patientId) {
        const [p] = await rows(tx, sql`select 1 from patient where id = ${b.patientId}`);
        if (!p) throw problem(400, 'PAT-404', 'Pasien tidak ditemukan');
      }
      if (new Set(b.lines.map((l) => l.drugItemId)).size !== b.lines.length) throw problem(400, 'PHM-400-OTC', 'Obat yang sama ditulis lebih dari sekali');
      const ids = b.lines.map((l) => l.drugItemId);
      const drugs = new Map((await rows<{ id: string; generic_name: string; drug_class: string; is_active: boolean }>(tx, sql`
        select id, generic_name, drug_class, is_active from drug_item where id = any(${`{${ids.join(',')}}`}::uuid[])`)).map((d) => [d.id, d]));
      const [{ method }] = await rows<{ method: 'FEFO' | 'FIFO' }>(tx, sql`
        select coalesce(settings->>'dispenseMethod', 'FEFO') as method from tenant where id = app.current_tenant_id()`);
      await lockStock(tx, loc.id, ids);
      const errors: { field: string; message: string }[] = [];
      const allocs: { drugItemId: string; batchId: string; qty: number; price: { id: string; sellPrice: string } }[] = [];
      for (const [n, l] of b.lines.entries()) {
        const d = drugs.get(l.drugItemId);
        if (!d?.is_active) { errors.push({ field: `lines.${n}.drugItemId`, message: 'Obat tidak ditemukan atau tidak aktif' }); continue; }
        if (!OTC_CLASSES.includes(d.drug_class)) {
          errors.push({ field: `lines.${n}.drugItemId`, message: `${d.generic_name} golongan ${d.drug_class.toLowerCase().replace('_', ' ')} — hanya dapat diserahkan dengan resep` });
          continue;
        }
        const price = await currentPrice(tx, d.id, b.branchId, 'UMUM', br.today);
        if (!price) { errors.push({ field: `lines.${n}.drugItemId`, message: `${d.generic_name} belum memiliki harga jual berlaku` }); continue; }
        const avail = await batchesFor(tx, d.id, loc.id, br.today, method);
        const pick = allocate(avail, l.qty);
        if (!pick) {
          errors.push({ field: `lines.${n}.qty`, message: `Stok ${d.generic_name} di ${loc.name} tidak cukup (tersedia ${round4(avail.reduce((t, a) => t + Number(a.qty_on_hand), 0))})` });
          continue;
        }
        for (const p of pick) allocs.push({ drugItemId: d.id, batchId: p.batchId, qty: p.qty, price });
      }
      if (errors.length) throw problemWith(422, 'PHM-422-OTC', 'Penjualan tidak dapat diproses', { errors });
      const total = Math.round(allocs.reduce((t, a) => t + a.qty * Number(a.price.sellPrice), 0) * 100) / 100;
      const [{ no }] = await rows<{ no: string }>(tx, sql`select app.next_document_number('OTC_SALE', 'TENANT', 'OTC{YYYY}{MM}{SEQ:5}') as no`);
      const [{ id }] = await rows<{ id: string }>(tx, sql`
        insert into otc_sale(tenant_id, sale_no, branch_id, location_id, patient_id, sold_by, customer_name, notes, total)
        values (app.current_tenant_id(), ${no}, ${b.branchId}, ${loc.id}, ${b.patientId ?? null}, ${ctx().userId}, ${b.customerName ?? null},
                ${b.notes ?? null}, ${total.toFixed(2)}::numeric) returning id`);
      for (const a of allocs) {
        await tx.execute(sql`insert into otc_sale_line(tenant_id, otc_sale_id, drug_item_id, batch_id, qty_base, unit_price, drug_price_id)
                             values (app.current_tenant_id(), ${id}, ${a.drugItemId}, ${a.batchId}, ${a.qty}, ${a.price.sellPrice}::numeric, ${a.price.id})`);
        await tx.execute(sql`insert into stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id, actor_id)
                             values (app.current_tenant_id(), ${a.batchId}, ${loc.id}, 'OTC_SALE', ${-a.qty}, 'otc_sale', ${id}, ${ctx().userId})`);
      }
      await audit(tx, 'OTC_SALE_CREATED', 'otc_sale', id, b.patientId ?? null, { saleNo: no, lines: b.lines.length, total });
      return this.one(tx, id);
    }));
  }

  @RequirePermission('pharmacy.otc.sell') @BodySchema(CancelBody) @Post('otc-sales/:id/cancel') @HttpCode(200)
  async cancel(@Param('id') id: string, @Body() b: z.infer<typeof CancelBody>) {
    assertId(id, ...OTC_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const [s] = await rows<{ status: string; location_id: string; sale_no: string; patient_id: string | null }>(tx, sql`
        select status, location_id, sale_no, patient_id from otc_sale where id = ${id} for update`);
      if (!s) throw problem(404, ...OTC_NOT_FOUND);
      if (s.status !== 'AWAITING_PAYMENT') throw problem(409, 'PHM-409-OTC-STATE', 'Hanya penjualan yang belum dibayar yang dapat dibatalkan');
      const lines = await rows<{ batch_id: string; drug_item_id: string; qty_base: string }>(tx, sql`
        select batch_id, drug_item_id, qty_base::text from otc_sale_line where otc_sale_id = ${id}`);
      await lockStock(tx, s.location_id, lines.map((l) => l.drug_item_id));
      for (const l of lines) {
        await tx.execute(sql`insert into stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id, actor_id)
                             values (app.current_tenant_id(), ${l.batch_id}, ${s.location_id}, 'RETURN_IN', ${l.qty_base}::numeric, 'otc_sale', ${id}, ${ctx().userId})`);
      }
      await tx.execute(sql`update otc_sale set status = 'CANCELLED', cancel_reason = ${b.reason}, cancelled_by = ${ctx().userId}, cancelled_at = now() where id = ${id}`);
      await audit(tx, 'OTC_SALE_CANCELLED', 'otc_sale', id, s.patient_id, { saleNo: s.sale_no, reason: b.reason });
      return this.one(tx, id);
    });
  }

  private async one(tx: Tx, id: string) {
    const [s] = await rows<{ id: string; sale_no: string; status: string; branch_name: string; location_name: string; customer_name: string | null;
                             patient_name: string | null; mrn: string | null; sold_at: string; sold_by_name: string; total: string; notes: string | null;
                             cancel_reason: string | null; cancelled_at: string | null }>(tx, sql`
      select o.id, o.sale_no, o.status, br.name as branch_name, l.name as location_name, o.customer_name, p.full_name as patient_name, p.mrn, o.sold_at,
             u.full_name as sold_by_name, o.total::text, o.notes, o.cancel_reason, o.cancelled_at
        from otc_sale o join branch br on br.id = o.branch_id join stock_location l on l.id = o.location_id join app_user u on u.id = o.sold_by
        left join patient p on p.id = o.patient_id where o.id = ${id}`);
    if (!s) throw problem(404, ...OTC_NOT_FOUND);
    const lines = await rows<{ id: string; drug_item_id: string; drug_name: string; batch_no: string; expiry_date: string; qty_base: string; uom_name: string;
                               unit_price: string }>(tx, sql`
      select x.id, x.drug_item_id, d.generic_name as drug_name, sb.batch_no, to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date,
             trim_scale(x.qty_base)::text as qty_base, u.name as uom_name, x.unit_price::text
        from otc_sale_line x join drug_item d on d.id = x.drug_item_id join stock_batch sb on sb.id = x.batch_id join uom u on u.id = d.base_uom_id
       where x.otc_sale_id = ${id} order by lower(d.generic_name), sb.expiry_date`);
    return {
      id: s.id, saleNo: s.sale_no, status: s.status, branchName: s.branch_name, locationName: s.location_name, customerName: s.customer_name,
      patient: s.patient_name ? { name: s.patient_name, mrn: s.mrn } : null, soldAt: s.sold_at, soldByName: s.sold_by_name, total: s.total, notes: s.notes,
      cancelReason: s.cancel_reason, cancelledAt: s.cancelled_at,
      lines: lines.map((l) => ({ id: l.id, drugItemId: l.drug_item_id, drugName: l.drug_name, batchNo: l.batch_no, expiryDate: l.expiry_date,
        qtyBase: Number(l.qty_base), uomName: l.uom_name, unitPrice: l.unit_price,
        amount: (Math.round(Number(l.qty_base) * Number(l.unit_price) * 100) / 100).toFixed(2) })),
    };
  }
}
