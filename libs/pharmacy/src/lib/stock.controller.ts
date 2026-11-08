import { Controller, Get, Param, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { RequirePermission, Uuid, assertId, problem } from '@clinicrme/shared';
import { Db, rows } from '@clinicrme/db';

const StockQuery = z.object({
  branchId: Uuid.optional(), locationId: Uuid.optional(), q: z.string().trim().max(100).optional(),
  filter: z.enum(['ALL', 'LOW', 'EXPIRING', 'EXPIRED']).default('ALL'),
  limit: z.coerce.number().int().min(1).max(200).default(100), cursor: z.string().regex(/^\d{1,6}$/).optional(),
});
interface StockRow { drug_item_id: string; code: string; generic_name: string; drug_class: string; uom_name: string; min_stock: string; on_hand: string;
  usable: string; nearest_expiry: string | null; expiring_qty: string; expired_qty: string; is_active: boolean }

/**
 * Posisi stok (PHM-FR-004, 014): saldo per obat dalam cakupan cabang/lokasi, stok minimum, kedaluwarsa terdekat,
 * jumlah yang akan kedaluwarsa (≤ `expiryWarningDays` hari, bawaan 90) dan yang sudah kedaluwarsa (tidak dapat
 * dikeluarkan). Saldo = jumlah ledger (diverifikasi uji rekonsiliasi).
 */
@Controller('api/v1')
export class StockController {
  constructor(private readonly db: Db) {}

  @RequirePermission('pharmacy.stock.read') @Get('stock')
  async list(@Query() query: Record<string, string | undefined>) {
    const P = StockQuery.safeParse(query);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const f = P.data;
    const offset = Number(f.cursor ?? 0);
    const like = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    return this.db.withTenantTx(async (tx) => {
      const [{ days, today }] = await rows<{ days: number; today: string }>(tx, sql`
        select coalesce((settings->>'expiryWarningDays')::int, 90) as days, to_char(now() at time zone coalesce((select timezone from branch where id = ${f.branchId ?? null}::uuid), timezone), 'YYYY-MM-DD') as today
          from tenant where id = app.current_tenant_id()`);
      const r = await rows<StockRow>(tx, sql`
        with bal as (
          select sb.drug_item_id, sb.expiry_date, s.qty_on_hand
            from stock_balance s join stock_batch sb on sb.id = s.batch_id join stock_location l on l.id = s.location_id
           where s.qty_on_hand > 0
             and (${f.branchId ?? null}::uuid is null or l.branch_id = ${f.branchId ?? null}::uuid)
             and (${f.locationId ?? null}::uuid is null or l.id = ${f.locationId ?? null}::uuid))
        select d.id as drug_item_id, d.code, d.generic_name, d.drug_class, u.name as uom_name, trim_scale(d.min_stock)::text as min_stock,
               trim_scale(coalesce(sum(b.qty_on_hand), 0))::text as on_hand,
               trim_scale(coalesce(sum(b.qty_on_hand) filter (where b.expiry_date >= ${today}::date), 0))::text as usable,
               to_char(min(b.expiry_date) filter (where b.expiry_date >= ${today}::date), 'YYYY-MM-DD') as nearest_expiry,
               trim_scale(coalesce(sum(b.qty_on_hand) filter (where b.expiry_date >= ${today}::date and b.expiry_date <= ${today}::date + ${days}::int::int), 0))::text as expiring_qty,
               trim_scale(coalesce(sum(b.qty_on_hand) filter (where b.expiry_date < ${today}::date), 0))::text as expired_qty, d.is_active
          from drug_item d join uom u on u.id = d.base_uom_id left join bal b on b.drug_item_id = d.id
         where (${like}::text is null or d.generic_name ilike ${like} or d.code ilike ${like} or d.brand_name ilike ${like})
         group by d.id, u.name
        having (${f.filter} = 'ALL' and (d.is_active or coalesce(sum(b.qty_on_hand), 0) > 0))
            or (${f.filter} = 'LOW' and d.is_active and d.min_stock > 0
                and coalesce(sum(b.qty_on_hand) filter (where b.expiry_date >= ${today}::date), 0) <= d.min_stock)
            or (${f.filter} = 'EXPIRING' and coalesce(sum(b.qty_on_hand) filter (where b.expiry_date >= ${today}::date and b.expiry_date <= ${today}::date + ${days}::int::int), 0) > 0)
            or (${f.filter} = 'EXPIRED' and coalesce(sum(b.qty_on_hand) filter (where b.expiry_date < ${today}::date), 0) > 0)
         order by lower(d.generic_name), d.id limit ${f.limit + 1} offset ${offset}`);
      return {
        data: r.slice(0, f.limit).map((x) => ({
          drugItemId: x.drug_item_id, code: x.code, genericName: x.generic_name, drugClass: x.drug_class, uomName: x.uom_name,
          minStock: Number(x.min_stock), onHand: Number(x.on_hand), usable: Number(x.usable), nearestExpiry: x.nearest_expiry,
          expiringQty: Number(x.expiring_qty), expiredQty: Number(x.expired_qty), isActive: x.is_active,
          low: x.is_active && Number(x.min_stock) > 0 && Number(x.usable) <= Number(x.min_stock),
        })),
        page: { hasMore: r.length > f.limit, nextCursor: r.length > f.limit ? String(offset + f.limit) : null },
        expiryWarningDays: days,
      };
    });
  }

  /**
   * Peringatan stok (PHM-FR-014): obat aktif di bawah/sama dengan stok minimum (stok layak pakai), batch yang akan
   * kedaluwarsa dalam `expiryWarningDays` hari, dan batch kedaluwarsa yang masih bersaldo.
   */
  @RequirePermission('pharmacy.stock.read') @Get('stock/alerts')
  async alerts(@Query('branchId') branchId?: string) {
    if (branchId) assertId(branchId, 'MST-404-BRANCH', 'Cabang tidak ditemukan');
    const b = branchId ?? null;
    return this.db.withTenantTx(async (tx) => {
      const [{ days, today }] = await rows<{ days: number; today: string }>(tx, sql`
        select coalesce((settings->>'expiryWarningDays')::int, 90) as days, to_char(now() at time zone coalesce((select timezone from branch where id = ${b}::uuid), timezone), 'YYYY-MM-DD') as today
          from tenant where id = app.current_tenant_id()`);
      const low = await rows<{ drug_item_id: string; generic_name: string; usable: string; min_stock: string }>(tx, sql`
        select d.id as drug_item_id, d.generic_name, trim_scale(coalesce(sum(s.qty_on_hand), 0))::text as usable, trim_scale(d.min_stock)::text as min_stock
          from drug_item d
          left join stock_batch sb on sb.drug_item_id = d.id and sb.expiry_date >= ${today}::date
          left join stock_balance s on s.batch_id = sb.id and s.qty_on_hand > 0
               and exists (select 1 from stock_location l where l.id = s.location_id and (${b}::uuid is null or l.branch_id = ${b}::uuid))
         where d.is_active and d.min_stock > 0
         group by d.id having coalesce(sum(s.qty_on_hand), 0) <= d.min_stock
         order by lower(d.generic_name), d.id limit 500`);
      const exp = await rows<{ drug_item_id: string; generic_name: string; batch_id: string; batch_no: string; expiry_date: string; location_name: string;
                               qty: string; expired: boolean }>(tx, sql`
        select d.id as drug_item_id, d.generic_name, sb.id as batch_id, sb.batch_no, to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date,
               l.name as location_name, trim_scale(s.qty_on_hand)::text as qty, sb.expiry_date < ${today}::date as expired
          from stock_balance s join stock_batch sb on sb.id = s.batch_id join drug_item d on d.id = sb.drug_item_id join stock_location l on l.id = s.location_id
         where s.qty_on_hand > 0 and sb.expiry_date <= ${today}::date + ${days}::int::int and (${b}::uuid is null or l.branch_id = ${b}::uuid)
         order by sb.expiry_date, lower(d.generic_name), l.name limit 500`);
      return [
        ...low.map((x) => ({ type: 'BELOW_MINIMUM', drugId: x.drug_item_id, drugName: x.generic_name, qtyOnHand: x.usable, minStock: x.min_stock })),
        ...exp.map((x) => ({ type: x.expired ? 'EXPIRED' : 'NEAR_EXPIRY', drugId: x.drug_item_id, drugName: x.generic_name, batchId: x.batch_id,
          batchNo: x.batch_no, expiryDate: x.expiry_date, locationName: x.location_name, qtyOnHand: x.qty })),
      ];
    });
  }

  /** Rincian satu obat: saldo per batch & lokasi, serta mutasi ledger terakhir. */
  @RequirePermission('pharmacy.stock.read') @Get('stock/:drugId')
  async detail(@Param('drugId') drugId: string, @Query('branchId') branchId?: string) {
    assertId(drugId, 'MST-404-DRUG', 'Obat tidak ditemukan');
    if (branchId) assertId(branchId, 'MST-404-BRANCH', 'Cabang tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      const [d] = await rows<{ generic_name: string; uom_name: string }>(tx, sql`
        select d.generic_name, u.name as uom_name from drug_item d join uom u on u.id = d.base_uom_id where d.id = ${drugId}`);
      if (!d) throw problem(404, 'MST-404-DRUG', 'Obat tidak ditemukan');
      const batches = await rows<{ batch_id: string; batch_no: string; expiry_date: string; unit_cost: string; location_id: string; location_name: string;
                                   branch_name: string; qty_on_hand: string }>(tx, sql`
        select sb.id as batch_id, sb.batch_no, to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date, sb.unit_cost::text, l.id as location_id,
               l.name as location_name, br.name as branch_name, trim_scale(s.qty_on_hand)::text as qty_on_hand
          from stock_balance s join stock_batch sb on sb.id = s.batch_id join stock_location l on l.id = s.location_id join branch br on br.id = l.branch_id
         where sb.drug_item_id = ${drugId} and s.qty_on_hand > 0 and (${branchId ?? null}::uuid is null or l.branch_id = ${branchId ?? null}::uuid)
         order by sb.expiry_date, sb.created_at, l.name`);
      const moves = await rows<{ id: string; occurred_at: string; movement_type: string; qty: string; batch_no: string; location_name: string;
                                 ref_type: string; ref_id: string; actor_name: string | null }>(tx, sql`
        select m.id, m.occurred_at, m.movement_type, trim_scale(m.qty)::text as qty, sb.batch_no, l.name as location_name, m.ref_type, m.ref_id,
               u.full_name as actor_name
          from stock_movement m join stock_batch sb on sb.id = m.batch_id join stock_location l on l.id = m.location_id left join app_user u on u.id = m.actor_id
         where sb.drug_item_id = ${drugId} and (${branchId ?? null}::uuid is null or l.branch_id = ${branchId ?? null}::uuid)
         order by m.occurred_at desc, m.id limit 50`);
      return {
        drugItemId: drugId, genericName: d.generic_name, uomName: d.uom_name,
        batches: batches.map((b) => ({ batchId: b.batch_id, batchNo: b.batch_no, expiryDate: b.expiry_date, unitCost: b.unit_cost, locationId: b.location_id,
          locationName: b.location_name, branchName: b.branch_name, qtyOnHand: Number(b.qty_on_hand) })),
        movements: moves.map((m) => ({ id: m.id, occurredAt: m.occurred_at, type: m.movement_type, qty: Number(m.qty), batchNo: m.batch_no,
          locationName: m.location_name, refType: m.ref_type, refId: m.ref_id, actorName: m.actor_name })),
      };
    });
  }
}
