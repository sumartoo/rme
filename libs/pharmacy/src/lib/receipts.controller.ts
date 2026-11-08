import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, IsoDate, RequirePermission, Uuid, assertId, ctx, optText, problem, problemWith } from '@clinicrme/shared';
import { Db, type Tx, audit, idempotent, rows } from '@clinicrme/db';
import { RESTRICTED, baseFactor } from './stock.repo';

const Qty = z.number().positive().max(1_000_000);
export const ReceiptBody = z.object({
  supplierId: Uuid, locationId: Uuid, invoiceNo: z.string().trim().min(1).max(50), invoiceDate: IsoDate.nullable().optional(), notes: optText(500),
  lines: z.array(z.object({
    drugItemId: Uuid, batchNo: z.string().trim().min(1).max(50), expiryDate: IsoDate, qty: Qty, uomId: Uuid,
    unitPrice: z.number().min(0).max(1e12),
  }).strict()).min(1).max(100),
}).strict();
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().regex(/^\d{1,6}$/).optional(),
  locationId: Uuid.optional() });

interface HeadRow { id: string; receipt_no: string; supplier_id: string; supplier_name: string; location_id: string; location_name: string; branch_name: string;
  invoice_no: string; invoice_date: string | null; notes: string | null; received_at: string; received_by_name: string | null; lines: number; total: string }
const HEAD = sql`select g.id, g.receipt_no, g.supplier_id, s.name as supplier_name, g.location_id, l.name as location_name, b.name as branch_name,
                        g.invoice_no, to_char(g.invoice_date, 'YYYY-MM-DD') as invoice_date, g.notes, g.received_at, u.full_name as received_by_name,
                        (select count(*)::int from goods_receipt_line x where x.goods_receipt_id = g.id) as lines,
                        (select coalesce(sum(x.qty * x.unit_price), 0)::numeric(18,2)::text from goods_receipt_line x where x.goods_receipt_id = g.id) as total
                   from goods_receipt g join supplier s on s.id = g.supplier_id join stock_location l on l.id = g.location_id
                   join branch b on b.id = l.branch_id left join app_user u on u.id = g.received_by`;
const headDto = (r: HeadRow) => ({ id: r.id, receiptNo: r.receipt_no, supplierId: r.supplier_id, supplierName: r.supplier_name, locationId: r.location_id,
  locationName: r.location_name, branchName: r.branch_name, invoiceNo: r.invoice_no, invoiceDate: r.invoice_date, notes: r.notes, receivedAt: r.received_at,
  receivedByName: r.received_by_name, lineCount: r.lines, total: r.total });

async function receiptOf(tx: Tx, id: string) {
  const [h] = await rows<HeadRow>(tx, sql`${HEAD} where g.id = ${id}`);
  if (!h) return null;
  const lines = await rows<{ id: string; drug_item_id: string; drug_name: string; batch_no: string; expiry_date: string; qty: string; uom_name: string;
                             qty_base: string; base_uom_name: string; unit_price: string }>(tx, sql`
    select x.id, d.id as drug_item_id, d.generic_name as drug_name, sb.batch_no, to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date,
           trim_scale(x.qty)::text as qty, u.name as uom_name, trim_scale(x.qty_base)::text as qty_base, bu.name as base_uom_name, x.unit_price::text
      from goods_receipt_line x join stock_batch sb on sb.id = x.batch_id join drug_item d on d.id = sb.drug_item_id
      join uom u on u.id = x.uom_id join uom bu on bu.id = d.base_uom_id where x.goods_receipt_id = ${id} order by d.generic_name, sb.batch_no`);
  return { ...headDto(h), lines: lines.map((l) => ({ id: l.id, drugItemId: l.drug_item_id, drugName: l.drug_name, batchNo: l.batch_no, expiryDate: l.expiry_date,
    qty: Number(l.qty), uomName: l.uom_name, qtyBase: Number(l.qty_base), baseUomName: l.base_uom_name, unitPrice: l.unit_price })) };
}

/**
 * Penerimaan barang dari supplier (PHM-FR-003, 004): satu faktur → banyak baris batch & kedaluwarsa. Jumlah dikonversi
 * ke satuan dasar obat (konversi khusus obat didahulukan); harga beli per satuan dasar disimpan di batch (OD-038).
 * Setiap baris menjadi mutasi RECEIPT di ledger; saldo diperbarui trigger dalam transaksi yang sama. Penerimaan tidak
 * diubah/dihapus — koreksi lewat penyesuaian stok (batch 3). Obat golongan terbatas butuh izin khusus (OD-100).
 */
@Controller('api/v1')
export class ReceiptsController {
  constructor(private readonly db: Db) {}

  @RequirePermission('pharmacy.stock.read') @Get('goods-receipts')
  async list(@Query() q: Record<string, string | undefined>) {
    const P = ListQuery.safeParse(q);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const { limit, cursor, locationId } = P.data;
    const offset = Number(cursor ?? 0);
    const r = await this.db.withTenantTx((tx) => rows<HeadRow>(tx, sql`${HEAD}
      where (${locationId ?? null}::uuid is null or g.location_id = ${locationId ?? null}::uuid)
      order by g.received_at desc, g.id limit ${limit + 1} offset ${offset}`));
    return { data: r.slice(0, limit).map(headDto), page: { hasMore: r.length > limit, nextCursor: r.length > limit ? String(offset + limit) : null } };
  }

  @RequirePermission('pharmacy.stock.read') @Get('goods-receipts/:id')
  async get(@Param('id') id: string) {
    assertId(id, 'PHM-404-RECEIPT', 'Penerimaan tidak ditemukan');
    const r = await this.db.withTenantTx((tx) => receiptOf(tx, id));
    if (!r) throw problem(404, 'PHM-404-RECEIPT', 'Penerimaan tidak ditemukan');
    return r;
  }

  @RequirePermission('pharmacy.stock.receive') @BodySchema(ReceiptBody) @Post('goods-receipts') @HttpCode(201)
  async create(@Body() b: z.infer<typeof ReceiptBody>, @Headers('idempotency-key') key: string | undefined) {
    return this.db.withTenantTx((tx) => idempotent(tx, 'goods.receipt', key, b, async () => {
      const [sup] = await rows<{ is_active: boolean }>(tx, sql`select is_active from supplier where id = ${b.supplierId}`);
      if (!sup?.is_active) throw problem(400, 'PHM-400-SUPPLIER', 'Supplier tidak ditemukan atau tidak aktif');
      const [loc] = await rows<{ is_active: boolean; timezone: string }>(tx, sql`
        select l.is_active, br.timezone from stock_location l join branch br on br.id = l.branch_id where l.id = ${b.locationId}`);
      if (!loc?.is_active) throw problem(400, 'PHM-400-LOCATION', 'Lokasi stok tidak ditemukan atau tidak aktif');
      const [dupInv] = await rows(tx, sql`select 1 from goods_receipt where supplier_id = ${b.supplierId} and lower(invoice_no) = lower(${b.invoiceNo})`);
      if (dupInv) throw problem(409, 'PHM-409-INVOICE', 'Faktur ini sudah pernah diterima');
      const [{ today }] = await rows<{ today: string }>(tx, sql`select to_char(now() at time zone ${loc.timezone}, 'YYYY-MM-DD') as today`);
      const drugIds = [...new Set(b.lines.map((l) => l.drugItemId))];
      const drugs = new Map((await rows<{ id: string; generic_name: string; base_uom_id: string; drug_class: string; is_active: boolean }>(tx, sql`
        select id, generic_name, base_uom_id, drug_class, is_active from drug_item where id = any(${`{${drugIds.join(',')}}`}::uuid[])`)).map((d) => [d.id, d]));
      const errors: { field: string; message: string }[] = [];
      const resolved: { factor: number }[] = [];
      for (const [i, l] of b.lines.entries()) {
        const d = drugs.get(l.drugItemId);
        if (!d?.is_active) { errors.push({ field: `lines.${i}.drugItemId`, message: 'Obat tidak ditemukan atau tidak aktif' }); resolved.push({ factor: 0 }); continue; }
        if (RESTRICTED.includes(d.drug_class) && !ctx().permissions?.has('pharmacy.restricted.dispense')) {
          errors.push({ field: `lines.${i}.drugItemId`, message: `${d.generic_name} golongan ${d.drug_class.toLowerCase()} — butuh izin obat terbatas` });
        }
        if (l.expiryDate <= today) errors.push({ field: `lines.${i}.expiryDate`, message: 'Sudah kedaluwarsa' });
        const f = await baseFactor(tx, d.id, l.uomId, d.base_uom_id);
        if (f === null) errors.push({ field: `lines.${i}.uomId`, message: 'Tidak ada konversi satuan ini ke satuan dasar obat' });
        resolved.push({ factor: f ?? 0 });
      }
      if (errors.some((e) => e.message.includes('izin obat terbatas'))) throw problemWith(403, 'PHM-403-RESTRICTED', 'Butuh izin obat terbatas', { errors });
      if (errors.length) throw problemWith(400, 'PHM-400-RECEIPT', 'Penerimaan tidak valid', { errors });
      const [{ no }] = await rows<{ no: string }>(tx, sql`select app.next_document_number('GOODS_RECEIPT', 'TENANT', 'GR{YYYY}{MM}{SEQ:5}') as no`);
      const [{ id }] = await rows<{ id: string }>(tx, sql`
        insert into goods_receipt(tenant_id, receipt_no, supplier_id, location_id, invoice_no, invoice_date, notes, received_by)
        values (app.current_tenant_id(), ${no}, ${b.supplierId}, ${b.locationId}, ${b.invoiceNo}, ${b.invoiceDate ?? null}::date, ${b.notes ?? null}, ${ctx().userId})
        returning id`);
      for (const [i, l] of b.lines.entries()) {
        const factor = resolved[i].factor;
        const qtyBase = Math.round(l.qty * factor * 10_000) / 10_000;
        const unitCost = factor ? l.unitPrice / factor : 0;
        // Batch unik per obat+nomor+kedaluwarsa; harga beli batch ditetapkan saat pertama diterima
        let [batch] = await rows<{ id: string }>(tx, sql`
          insert into stock_batch(tenant_id, drug_item_id, batch_no, expiry_date, unit_cost)
          values (app.current_tenant_id(), ${l.drugItemId}, ${l.batchNo}, ${l.expiryDate}::date, ${unitCost.toFixed(4)}::numeric)
          on conflict (tenant_id, drug_item_id, batch_no, expiry_date) do nothing returning id`);
        if (!batch) {
          [batch] = await rows<{ id: string }>(tx, sql`select id from stock_batch
            where drug_item_id = ${l.drugItemId} and batch_no = ${l.batchNo} and expiry_date = ${l.expiryDate}::date`);
        }
        await tx.execute(sql`insert into goods_receipt_line(tenant_id, goods_receipt_id, batch_id, qty, uom_id, qty_base, unit_price)
          values (app.current_tenant_id(), ${id}, ${batch.id}, ${l.qty}, ${l.uomId}, ${qtyBase}, ${l.unitPrice})`);
        await tx.execute(sql`insert into stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id, actor_id)
          values (app.current_tenant_id(), ${batch.id}, ${b.locationId}, 'RECEIPT', ${qtyBase}, 'goods_receipt', ${id}, ${ctx().userId})`);
      }
      await audit(tx, 'GOODS_RECEIVED', 'goods_receipt', id, null, { receiptNo: no, invoiceNo: b.invoiceNo, lines: b.lines.length });
      return receiptOf(tx, id);
    }));
  }
}
