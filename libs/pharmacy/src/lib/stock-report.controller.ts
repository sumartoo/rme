import { Controller, Get, Query, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePermission, Uuid, problem } from '@clinicrme/shared';
import { Db, type Tx, audit, rows } from '@clinicrme/db';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Q = z.object({
  from: DATE, to: DATE, branchId: Uuid.optional(), locationId: Uuid.optional(), drugId: Uuid.optional(),
  type: z.enum(['RECEIPT', 'DISPENSE', 'OTC_SALE', 'RETURN_IN', 'RETURN_OUT', 'ADJUSTMENT', 'OPNAME', 'TRANSFER_IN', 'TRANSFER_OUT']).optional(),
  format: z.enum(['json', 'csv']).default('json'),
}).refine((q) => q.from <= q.to, { message: 'Tanggal awal setelah tanggal akhir' })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 366 * 86_400_000, { message: 'Rentang maksimal 1 tahun' });

const SUMMARY_COLUMNS = [
  { key: 'code', label: 'Kode', type: 'string' }, { key: 'drugName', label: 'Nama obat', type: 'string' },
  { key: 'drugClass', label: 'Golongan', type: 'string' }, { key: 'uomName', label: 'Satuan', type: 'string' },
  { key: 'opening', label: 'Saldo awal', type: 'number' }, { key: 'received', label: 'Penerimaan', type: 'number' },
  { key: 'returnedIn', label: 'Retur masuk', type: 'number' }, { key: 'dispensed', label: 'Penyerahan resep', type: 'number' },
  { key: 'otcSold', label: 'Penjualan bebas', type: 'number' }, { key: 'otherOut', label: 'Keluar lain', type: 'number' },
  { key: 'adjusted', label: 'Penyesuaian/opname (±)', type: 'number' }, { key: 'closing', label: 'Saldo akhir', type: 'number' },
  { key: 'closingValue', label: 'Nilai saldo akhir (harga beli)', type: 'money' },
];
const MOVE_COLUMNS = [
  { key: 'occurredAt', label: 'Waktu', type: 'datetime' }, { key: 'type', label: 'Jenis', type: 'string' },
  { key: 'code', label: 'Kode', type: 'string' }, { key: 'drugName', label: 'Nama obat', type: 'string' },
  { key: 'batchNo', label: 'Batch', type: 'string' }, { key: 'expiryDate', label: 'Kedaluwarsa', type: 'date' },
  { key: 'locationName', label: 'Lokasi', type: 'string' }, { key: 'qty', label: 'Jumlah (±)', type: 'number' },
  { key: 'uomName', label: 'Satuan', type: 'string' }, { key: 'reference', label: 'Referensi', type: 'string' }, { key: 'actorName', label: 'Oleh', type: 'string' },
];
const csvOf = (cols: { key: string; label: string }[], data: Record<string, unknown>[]) => {
  const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return `\uFEFF${[cols.map((c) => c.label).join(','), ...data.map((r) => cols.map((c) => esc(r[c.key])).join(','))].join('\r\n')}\r\n`;
};

/**
 * Laporan stok & mutasi (RPT-FR-005, PHM-FR-004): ringkasan per obat (saldo awal, masuk, keluar per jenis, penyesuaian,
 * saldo akhir, nilai harga beli) dan daftar mutasi ledger untuk rentang tanggal (zona waktu cabang/tenant). JSON atau CSV.
 * Nilai memakai harga beli per batch (`unit_cost`); valuasi HPP (FIFO/rata-rata) ditunda (OD-038).
 */
@Controller('api/v1/reports')
export class StockReportController {
  constructor(private readonly db: Db) {}

  @RequirePermission('report.pharmacy.read') @Get('stock')
  async summary(@Query() query: Record<string, string | undefined>, @Res({ passthrough: true }) res: Response) {
    const f = this.parse(query);
    const data = await this.db.withTenantTx(async (tx) => {
      const b = await this.bounds(tx, f);
      const r = await rows<{ code: string; drug_name: string; drug_class: string; uom_name: string; opening: string; received: string; returned_in: string;
                             dispensed: string; otc: string; other_out: string; adjusted: string; closing_value: string }>(tx, sql`
        with mv as (
          select sb.drug_item_id, m.movement_type t, m.qty, m.occurred_at, sb.unit_cost
            from stock_movement m join stock_batch sb on sb.id = m.batch_id join stock_location l on l.id = m.location_id
           where m.occurred_at < ${b.t1}::timestamptz
             and (${f.branchId ?? null}::uuid is null or l.branch_id = ${f.branchId ?? null}::uuid)
             and (${f.locationId ?? null}::uuid is null or l.id = ${f.locationId ?? null}::uuid))
        select d.code, d.generic_name as drug_name, d.drug_class, u.name as uom_name,
               trim_scale(coalesce(sum(mv.qty) filter (where mv.occurred_at < ${b.t0}::timestamptz), 0))::text as opening,
               ${this.sumIn(b.t0, ['RECEIPT', 'TRANSFER_IN'])} as received,
               ${this.sumIn(b.t0, ['RETURN_IN'])} as returned_in,
               ${this.sumIn(b.t0, ['DISPENSE'], true)} as dispensed,
               ${this.sumIn(b.t0, ['OTC_SALE'], true)} as otc,
               ${this.sumIn(b.t0, ['RETURN_OUT', 'TRANSFER_OUT'], true)} as other_out,
               ${this.sumIn(b.t0, ['ADJUSTMENT', 'OPNAME'])} as adjusted,
               round(coalesce(sum(mv.qty * mv.unit_cost), 0), 2)::text as closing_value
          from drug_item d join uom u on u.id = d.base_uom_id left join mv on mv.drug_item_id = d.id
         where (${f.drugId ?? null}::uuid is null or d.id = ${f.drugId ?? null}::uuid)
         group by d.id, u.name
        having d.is_active or count(mv.qty) > 0
         order by lower(d.generic_name), d.code`);
      await audit(tx, 'REPORT_STOCK_VIEWED', 'report', null, null, { from: f.from, to: f.to, branchId: f.branchId ?? null, format: f.format });
      return r.map((x) => {
        const n = { opening: Number(x.opening), received: Number(x.received), returnedIn: Number(x.returned_in), dispensed: Number(x.dispensed),
          otcSold: Number(x.otc), otherOut: Number(x.other_out), adjusted: Number(x.adjusted) };
        return { code: x.code, drugName: x.drug_name, drugClass: x.drug_class, uomName: x.uom_name, ...n,
          closing: Math.round((n.opening + n.received + n.returnedIn - n.dispensed - n.otcSold - n.otherOut + n.adjusted) * 10_000) / 10_000,
          closingValue: x.closing_value };
      });
    });
    if (f.format === 'csv') return this.csv(res, `stok-${f.from}-${f.to}.csv`, csvOf(SUMMARY_COLUMNS, data));
    return { columns: SUMMARY_COLUMNS, rows: data, from: f.from, to: f.to, generatedAt: new Date().toISOString(), dataAsOf: new Date().toISOString(),
      totals: { closingValue: data.reduce((t, r) => t + Number(r.closingValue), 0).toFixed(2) } };
  }

  @RequirePermission('report.pharmacy.read') @Get('stock-movements')
  async movements(@Query() query: Record<string, string | undefined>, @Res({ passthrough: true }) res: Response) {
    const f = this.parse(query);
    const LIMIT = 5000;
    const data = await this.db.withTenantTx(async (tx) => {
      const b = await this.bounds(tx, f);
      const r = await rows<{ occurred_at: string; type: string; code: string; drug_name: string; batch_no: string; expiry_date: string; location_name: string;
                             qty: string; uom_name: string; reference: string | null; actor_name: string | null }>(tx, sql`
        select m.occurred_at, m.movement_type as type, d.code, d.generic_name as drug_name, sb.batch_no, to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date,
               l.name as location_name, trim_scale(m.qty)::text as qty, u.name as uom_name,
               case m.ref_type
                 when 'goods_receipt' then (select receipt_no from goods_receipt where id = m.ref_id)
                 when 'dispense' then (select p.prescription_no from dispense x join prescription p on p.id = x.prescription_id where x.id = m.ref_id)
                 when 'otc_sale' then (select sale_no from otc_sale where id = m.ref_id)
                 when 'stock_adjustment' then 'Penyesuaian'
                 when 'stock_opname' then 'Stock opname'
               end as reference, a.full_name as actor_name
          from stock_movement m join stock_batch sb on sb.id = m.batch_id join drug_item d on d.id = sb.drug_item_id join uom u on u.id = d.base_uom_id
          join stock_location l on l.id = m.location_id left join app_user a on a.id = m.actor_id
         where m.occurred_at >= ${b.t0}::timestamptz and m.occurred_at < ${b.t1}::timestamptz
           and (${f.branchId ?? null}::uuid is null or l.branch_id = ${f.branchId ?? null}::uuid)
           and (${f.locationId ?? null}::uuid is null or l.id = ${f.locationId ?? null}::uuid)
           and (${f.drugId ?? null}::uuid is null or d.id = ${f.drugId ?? null}::uuid)
           and (${f.type ?? null}::text is null or m.movement_type = ${f.type ?? null}::text)
         order by m.occurred_at, m.id limit ${LIMIT + 1}`);
      await audit(tx, 'REPORT_STOCK_MOVEMENTS_VIEWED', 'report', null, null, { from: f.from, to: f.to, drugId: f.drugId ?? null, format: f.format });
      return r;
    });
    const out = data.slice(0, LIMIT).map((x) => ({ occurredAt: x.occurred_at, type: x.type, code: x.code, drugName: x.drug_name, batchNo: x.batch_no,
      expiryDate: x.expiry_date, locationName: x.location_name, qty: Number(x.qty), uomName: x.uom_name, reference: x.reference, actorName: x.actor_name }));
    if (f.format === 'csv') return this.csv(res, `mutasi-stok-${f.from}-${f.to}.csv`, csvOf(MOVE_COLUMNS, out));
    return { columns: MOVE_COLUMNS, rows: out, truncated: data.length > LIMIT, from: f.from, to: f.to, generatedAt: new Date().toISOString(),
      dataAsOf: new Date().toISOString() };
  }

  private parse(query: Record<string, string | undefined>) {
    const P = Q.safeParse(query);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', P.error.issues[0]?.message?.startsWith('Rentang') || P.error.issues[0]?.message?.startsWith('Tanggal')
      ? P.error.issues[0].message : 'Parameter tidak valid (from, to: YYYY-MM-DD)');
    return P.data;
  }

  /** Batas rentang [from 00:00, to+1 00:00) di zona waktu cabang (atau tenant). */
  private async bounds(tx: Tx, f: z.infer<typeof Q>) {
    const [b] = await rows<{ t0: string; t1: string; ok: boolean }>(tx, sql`
      with z as (select coalesce((select timezone from branch where id = ${f.branchId ?? null}::uuid), t.timezone) as tz,
                        (${f.branchId ?? null}::uuid is null or exists (select 1 from branch where id = ${f.branchId ?? null}::uuid)) as ok
                   from tenant t where t.id = app.current_tenant_id())
      select (${f.from}::date::timestamp at time zone z.tz)::text as t0, ((${f.to}::date + 1)::timestamp at time zone z.tz)::text as t1, z.ok from z`);
    if (!b.ok) throw problem(404, 'MST-404-BRANCH', 'Cabang tidak ditemukan');
    return b;
  }

  private sumIn(t0: string, types: string[], negate = false) {
    const list = `{${types.join(',')}}`;
    return sql`trim_scale(coalesce(${negate ? sql`-` : sql``}sum(mv.qty) filter (where mv.occurred_at >= ${t0}::timestamptz and mv.t = any(${list}::text[])), 0))::text`;
  }

  private csv(res: Response, name: string, body: string) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    return body;
  }
}
