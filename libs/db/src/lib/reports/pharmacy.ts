import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { DATE, FORMAT, type Column, type Q, type ReportResult, ReportError, UUID, inBranches, rowsOf } from './common';

/**
 * Laporan farmasi (Stage 10, disatukan ke menu Laporan di Stage 14 batch 3): stok & mutasi (RPT-FR-005), obat golongan terbatas
 * (RPT-FR-006, OD-100), mendekati kedaluwarsa (RPT-FR-005). Cakupan cabang dari penugasan role (OD-129).
 */
export const RESTRICTED = ['NARKOTIKA', 'PSIKOTROPIKA', 'PREKURSOR'];
const MOVEMENT_TYPES = ['RECEIPT', 'DISPENSE', 'OTC_SALE', 'RETURN_IN', 'RETURN_OUT', 'ADJUSTMENT', 'OPNAME', 'TRANSFER_IN', 'TRANSFER_OUT'] as const;

export const StockQ = z.object({
  from: DATE, to: DATE, branchId: UUID.optional(), locationId: UUID.optional(), drugId: UUID.optional(),
  type: z.enum(MOVEMENT_TYPES).optional(), format: FORMAT,
}).refine((q) => q.from <= q.to, { message: 'Tanggal awal setelah tanggal akhir' })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 366 * 86_400_000, { message: 'Rentang maksimal 1 tahun' });
export const ControlledQ = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), branchId: UUID.optional(), format: FORMAT });
export const NearExpiryQ = z.object({
  days: z.coerce.number().int().min(1).max(730).optional(), branchId: UUID.optional(), locationId: UUID.optional(),
  includeExpired: z.enum(['true', 'false']).default('true'), format: FORMAT,
});

const SUMMARY_COLUMNS: Column[] = [
  { key: 'code', label: 'Kode', type: 'string' }, { key: 'drugName', label: 'Nama obat', type: 'string' },
  { key: 'drugClass', label: 'Golongan', type: 'string' }, { key: 'uomName', label: 'Satuan', type: 'string' },
  { key: 'opening', label: 'Saldo awal', type: 'number' }, { key: 'received', label: 'Penerimaan', type: 'number' },
  { key: 'returnedIn', label: 'Retur masuk', type: 'number' }, { key: 'dispensed', label: 'Penyerahan resep', type: 'number' },
  { key: 'otcSold', label: 'Penjualan bebas', type: 'number' }, { key: 'otherOut', label: 'Keluar lain', type: 'number' },
  { key: 'adjusted', label: 'Penyesuaian/opname (±)', type: 'number' }, { key: 'closing', label: 'Saldo akhir', type: 'number' },
  { key: 'closingValue', label: 'Nilai saldo akhir (harga beli)', type: 'money' },
];
const MOVE_COLUMNS: Column[] = [
  { key: 'occurredAt', label: 'Waktu', type: 'datetime' }, { key: 'type', label: 'Jenis', type: 'string' },
  { key: 'code', label: 'Kode', type: 'string' }, { key: 'drugName', label: 'Nama obat', type: 'string' },
  { key: 'batchNo', label: 'Batch', type: 'string' }, { key: 'expiryDate', label: 'Kedaluwarsa', type: 'date' },
  { key: 'locationName', label: 'Lokasi', type: 'string' }, { key: 'qty', label: 'Jumlah (±)', type: 'number' },
  { key: 'uomName', label: 'Satuan', type: 'string' }, { key: 'reference', label: 'Referensi', type: 'string' }, { key: 'actorName', label: 'Oleh', type: 'string' },
];
const CONTROLLED_COLUMNS: Column[] = [
  { key: 'code', label: 'Kode', type: 'string' }, { key: 'drugName', label: 'Nama obat', type: 'string' },
  { key: 'drugClass', label: 'Golongan', type: 'string' }, { key: 'uomName', label: 'Satuan', type: 'string' },
  { key: 'opening', label: 'Saldo awal', type: 'number' }, { key: 'received', label: 'Pemasukan', type: 'number' },
  { key: 'dispensed', label: 'Pengeluaran (resep)', type: 'number' }, { key: 'otherOut', label: 'Pengeluaran lain', type: 'number' },
  { key: 'adjusted', label: 'Penyesuaian/opname (±)', type: 'number' }, { key: 'closing', label: 'Saldo akhir', type: 'number' },
];
const EXPIRY_COLUMNS: Column[] = [
  { key: 'expiryDate', label: 'Kedaluwarsa', type: 'date' }, { key: 'daysLeft', label: 'Sisa hari', type: 'number' },
  { key: 'code', label: 'Kode', type: 'string' }, { key: 'drugName', label: 'Nama obat', type: 'string' }, { key: 'drugClass', label: 'Golongan', type: 'string' },
  { key: 'batchNo', label: 'Batch', type: 'string' }, { key: 'locationName', label: 'Lokasi', type: 'string' },
  { key: 'qty', label: 'Jumlah', type: 'number' }, { key: 'uomName', label: 'Satuan', type: 'string' }, { key: 'value', label: 'Nilai (harga beli)', type: 'money' },
];
export const MOVEMENTS_LIMIT = 5000;

/** Batas rentang [from 00:00, to+1 00:00) di zona waktu cabang (atau tenant). */
async function bounds(tx: Q, f: { from: string; to: string; branchId?: string }) {
  const [b] = await rowsOf<{ t0: string; t1: string; ok: boolean }>(tx, sql`
    with z as (select coalesce((select timezone from branch where id = ${f.branchId ?? null}::uuid), t.timezone) as tz,
                      (${f.branchId ?? null}::uuid is null or exists (select 1 from branch where id = ${f.branchId ?? null}::uuid)) as ok
                 from tenant t where t.id = app.current_tenant_id())
    select (${f.from}::date::timestamp at time zone z.tz)::text as t0, ((${f.to}::date + 1)::timestamp at time zone z.tz)::text as t1, z.ok from z`);
  if (!b.ok) throw new ReportError(404, 'MST-404-BRANCH', 'Cabang tidak ditemukan');
  return b;
}
const sumIn = (t0: string, types: string[], negate = false) =>
  sql`trim_scale(coalesce(${negate ? sql`-` : sql``}sum(mv.qty) filter (where mv.occurred_at >= ${t0}::timestamptz and mv.t = any(${`{${types.join(',')}}`}::text[])), 0))::text`;

/**
 * Laporan stok (RPT-FR-005, PHM-FR-004): ringkasan per obat (saldo awal, masuk, keluar per jenis, penyesuaian, saldo akhir, nilai harga beli)
 * untuk rentang tanggal (zona waktu cabang/tenant). Nilai memakai harga beli per batch (`unit_cost`); valuasi HPP ditunda (OD-038).
 */
export async function stockSummary(tx: Q, f: z.infer<typeof StockQ>, scope: string[] | null): Promise<ReportResult> {
  const b = await bounds(tx, f);
  const r = await rowsOf<{ code: string; drug_name: string; drug_class: string; uom_name: string; opening: string; received: string; returned_in: string;
                           dispensed: string; otc: string; other_out: string; adjusted: string; closing_value: string }>(tx, sql`
    with mv as (
      select sb.drug_item_id, m.movement_type t, m.qty, m.occurred_at, sb.unit_cost
        from stock_movement m join stock_batch sb on sb.id = m.batch_id join stock_location l on l.id = m.location_id
       where m.occurred_at < ${b.t1}::timestamptz and ${inBranches(sql`l.branch_id`, scope)}
         and (${f.locationId ?? null}::uuid is null or l.id = ${f.locationId ?? null}::uuid))
    select d.code, d.generic_name as drug_name, d.drug_class, u.name as uom_name,
           trim_scale(coalesce(sum(mv.qty) filter (where mv.occurred_at < ${b.t0}::timestamptz), 0))::text as opening,
           ${sumIn(b.t0, ['RECEIPT', 'TRANSFER_IN'])} as received,
           ${sumIn(b.t0, ['RETURN_IN'])} as returned_in,
           ${sumIn(b.t0, ['DISPENSE'], true)} as dispensed,
           ${sumIn(b.t0, ['OTC_SALE'], true)} as otc,
           ${sumIn(b.t0, ['RETURN_OUT', 'TRANSFER_OUT'], true)} as other_out,
           ${sumIn(b.t0, ['ADJUSTMENT', 'OPNAME'])} as adjusted,
           round(coalesce(sum(mv.qty * mv.unit_cost), 0), 2)::text as closing_value
      from drug_item d join uom u on u.id = d.base_uom_id left join mv on mv.drug_item_id = d.id
     where (${f.drugId ?? null}::uuid is null or d.id = ${f.drugId ?? null}::uuid)
     group by d.id, u.name
    having d.is_active or count(mv.qty) > 0
     order by lower(d.generic_name), d.code`);
  const data = r.map((x) => {
    const n = { opening: Number(x.opening), received: Number(x.received), returnedIn: Number(x.returned_in), dispensed: Number(x.dispensed),
      otcSold: Number(x.otc), otherOut: Number(x.other_out), adjusted: Number(x.adjusted) };
    return { code: x.code, drugName: x.drug_name, drugClass: x.drug_class, uomName: x.uom_name, ...n,
      closing: Math.round((n.opening + n.received + n.returnedIn - n.dispensed - n.otcSold - n.otherOut + n.adjusted) * 10_000) / 10_000,
      closingValue: x.closing_value };
  });
  return { columns: SUMMARY_COLUMNS, rows: data, totals: { closingValue: data.reduce((t, x) => t + Number(x.closingValue), 0).toFixed(2) } };
}

/** Daftar mutasi ledger (RPT-FR-005). `limit` baris (bawaan 5.000 untuk tampilan; ekspor boleh lebih). */
export async function stockMovements(tx: Q, f: z.infer<typeof StockQ>, scope: string[] | null, limit = MOVEMENTS_LIMIT): Promise<ReportResult> {
  const b = await bounds(tx, f);
  const r = await rowsOf<{ occurred_at: string; type: string; code: string; drug_name: string; batch_no: string; expiry_date: string; location_name: string;
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
     where m.occurred_at >= ${b.t0}::timestamptz and m.occurred_at < ${b.t1}::timestamptz and ${inBranches(sql`l.branch_id`, scope)}
       and (${f.locationId ?? null}::uuid is null or l.id = ${f.locationId ?? null}::uuid)
       and (${f.drugId ?? null}::uuid is null or d.id = ${f.drugId ?? null}::uuid)
       and (${f.type ?? null}::text is null or m.movement_type = ${f.type ?? null}::text)
     order by m.occurred_at, m.id limit ${limit + 1}`);
  const out = r.slice(0, limit).map((x) => ({ occurredAt: x.occurred_at, type: x.type, code: x.code, drugName: x.drug_name, batchNo: x.batch_no,
    expiryDate: x.expiry_date, locationName: x.location_name, qty: Number(x.qty), uomName: x.uom_name, reference: x.reference, actorName: x.actor_name }));
  return { columns: MOVE_COLUMNS, rows: out, extra: { truncated: r.length > limit } };
}

/**
 * Pemakaian bulanan obat golongan terbatas (OD-100, RPT-FR-006, PHM-FR-019): per obat narkotika/psikotropika/prekursor — saldo awal,
 * pemasukan, pengeluaran resep, pengeluaran lain, penyesuaian/opname, saldo akhir — dari ledger per batas bulan zona waktu cabang (atau tenant).
 * Format pelaporan resmi **belum diverifikasi** (REG-10).
 */
export async function controlledDrugs(tx: Q, f: z.infer<typeof ControlledQ>, scope: string[] | null): Promise<ReportResult> {
  const [tz] = await rowsOf<{ tz: string; branch_name: string | null }>(tx, sql`
    select coalesce((select timezone from branch where id = ${f.branchId ?? null}::uuid), t.timezone) as tz,
           (select name from branch where id = ${f.branchId ?? null}::uuid) as branch_name
      from tenant t where t.id = app.current_tenant_id()`);
  if (f.branchId && !tz.branch_name) throw new ReportError(404, 'MST-404-BRANCH', 'Cabang tidak ditemukan');
  const r = await rowsOf<{ code: string; drug_name: string; drug_class: string; uom_name: string; opening: string; received: string; dispensed: string;
                           other_out: string; adjusted: string }>(tx, sql`
    with bounds as (select (${`${f.month}-01`}::date)::timestamp at time zone ${tz.tz} as t0,
                           ((${`${f.month}-01`}::date + interval '1 month')::date)::timestamp at time zone ${tz.tz} as t1),
    mv as (
      select sb.drug_item_id, m.movement_type, m.qty, m.occurred_at
        from stock_movement m join stock_batch sb on sb.id = m.batch_id join stock_location l on l.id = m.location_id
       where ${inBranches(sql`l.branch_id`, scope)})
    select d.code, d.generic_name as drug_name, d.drug_class, u.name as uom_name,
           trim_scale(coalesce(sum(mv.qty) filter (where mv.occurred_at < b.t0), 0))::text as opening,
           trim_scale(coalesce(sum(mv.qty) filter (where mv.occurred_at >= b.t0 and mv.occurred_at < b.t1
             and mv.movement_type in ('RECEIPT', 'RETURN_IN', 'TRANSFER_IN')), 0))::text as received,
           trim_scale(coalesce(-sum(mv.qty) filter (where mv.occurred_at >= b.t0 and mv.occurred_at < b.t1 and mv.movement_type = 'DISPENSE'), 0))::text as dispensed,
           trim_scale(coalesce(-sum(mv.qty) filter (where mv.occurred_at >= b.t0 and mv.occurred_at < b.t1
             and mv.movement_type in ('OTC_SALE', 'RETURN_OUT', 'TRANSFER_OUT')), 0))::text as other_out,
           trim_scale(coalesce(sum(mv.qty) filter (where mv.occurred_at >= b.t0 and mv.occurred_at < b.t1
             and mv.movement_type in ('ADJUSTMENT', 'OPNAME')), 0))::text as adjusted
      from drug_item d join uom u on u.id = d.base_uom_id cross join bounds b left join mv on mv.drug_item_id = d.id and mv.occurred_at < b.t1
     where d.drug_class = any(${`{${RESTRICTED.join(',')}}`}::text[])
     group by d.id, u.name, b.t0, b.t1
    having d.is_active or coalesce(sum(mv.qty), 0) <> 0 or count(mv.qty) filter (where mv.occurred_at >= b.t0) > 0
     order by d.drug_class, lower(d.generic_name)`);
  const data = r.map((x) => {
    const n = { opening: Number(x.opening), received: Number(x.received), dispensed: Number(x.dispensed), otherOut: Number(x.other_out), adjusted: Number(x.adjusted) };
    return { code: x.code, drugName: x.drug_name, drugClass: x.drug_class, uomName: x.uom_name, ...n,
      closing: Math.round((n.opening + n.received - n.dispensed - n.otherOut + n.adjusted) * 10_000) / 10_000 };
  });
  return { columns: CONTROLLED_COLUMNS, rows: data,
    extra: { month: f.month, branchName: tz.branch_name, note: 'Format laporan resmi belum diverifikasi (REG-10); angka dari ledger mutasi stok.' } };
}

/**
 * Mendekati kedaluwarsa (RPT-FR-005): batch dengan saldo > 0 yang kedaluwarsa dalam `days` hari (bawaan pengaturan `expiryWarningDays`, 90),
 * termasuk yang sudah kedaluwarsa (bisa dimatikan). Urut tanggal kedaluwarsa. Nilai = saldo × harga beli batch.
 */
export async function nearExpiry(tx: Q, f: z.infer<typeof NearExpiryQ>, scope: string[] | null): Promise<ReportResult> {
  const [{ days, today }] = await rowsOf<{ days: number; today: string }>(tx, sql`
    select coalesce(${f.days ?? null}::int, (settings->>'expiryWarningDays')::int, 90) as days,
           to_char(now() at time zone coalesce((select timezone from branch where id = ${f.branchId ?? null}::uuid), timezone), 'YYYY-MM-DD') as today
      from tenant where id = app.current_tenant_id()`);
  const r = await rowsOf<{ expiry_date: string; days_left: number; code: string; drug_name: string; drug_class: string; batch_no: string; location_name: string;
                           qty: string; uom_name: string; value: string }>(tx, sql`
    select to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date, (sb.expiry_date - ${today}::date)::int as days_left, d.code, d.generic_name as drug_name, d.drug_class,
           sb.batch_no, l.name as location_name, trim_scale(s.qty_on_hand)::text as qty, u.name as uom_name, round(s.qty_on_hand * sb.unit_cost, 2)::text as value
      from stock_balance s join stock_batch sb on sb.id = s.batch_id join drug_item d on d.id = sb.drug_item_id join uom u on u.id = d.base_uom_id
      join stock_location l on l.id = s.location_id
     where s.qty_on_hand > 0 and sb.expiry_date <= ${today}::date + ${days}::int
       and (${f.includeExpired} = 'true' or sb.expiry_date >= ${today}::date)
       and ${inBranches(sql`l.branch_id`, scope)} and (${f.locationId ?? null}::uuid is null or l.id = ${f.locationId ?? null}::uuid)
     order by sb.expiry_date, lower(d.generic_name), sb.batch_no, l.name`);
  const data = r.map((x) => ({ expiryDate: x.expiry_date, daysLeft: x.days_left, code: x.code, drugName: x.drug_name, drugClass: x.drug_class, batchNo: x.batch_no,
    locationName: x.location_name, qty: Number(x.qty), uomName: x.uom_name, value: x.value }));
  return { columns: EXPIRY_COLUMNS, rows: data, extra: { days, today },
    totals: { batches: data.length, expired: data.filter((x) => x.daysLeft < 0).length, value: data.reduce((t, x) => t + Number(x.value), 0).toFixed(2) } };
}
