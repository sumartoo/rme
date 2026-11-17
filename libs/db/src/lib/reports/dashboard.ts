import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Q, UUID, encounterTimeIn, inBranches, money, rowsOf } from './common';

/**
 * Dashboard manajer hari ini (RPT-FR-009, OD-131). "Hari ini" = tanggal lokal masing-masing cabang (zona waktu cabang).
 * Isi: kunjungan per status, antrean menunggu per poli, penerimaan kas & tagihan belum lunas, obat di bawah stok minimum &
 * kedaluwarsa ≤ 30 hari, kiriman SATUSEHAT yang perlu tindakan, tren 14 hari (kunjungan & kas). Agregat — tanpa identitas pasien.
 */
export const DashboardQ = z.object({ branchId: UUID.optional() });
export const TREND_DAYS = 14;
export const EXPIRY_DAYS = 30;

export interface Dashboard {
  date: string; timezone: string;
  visits: { total: number; waiting: number; inService: number; finished: number };
  queue: { unitId: string; unitName: string; branchName: string; waiting: number }[];
  cash: { payments: string; receivableSettlements: string; refunds: string; net: string };
  unpaid: { invoices: number; amount: string };
  stock: { lowStock: number; expiringSoon: number; expired: number; low: { code: string; drugName: string; usable: number; minStock: number; uomName: string }[] };
  satusehat: { needsAction: number; error: number; dead: number; blocked: number };
  trend: { date: string; visits: number; cash: string }[];
}

export async function dashboard(tx: Q, f: z.infer<typeof DashboardQ>, scope: string[] | null): Promise<Dashboard> {
  const br = (col = sql`br.id`) => inBranches(col, scope);
  const [z0] = await rowsOf<{ tz: string; today: string }>(tx, sql`
    select z.tz, to_char((now() at time zone z.tz)::date, 'YYYY-MM-DD') as today
      from (select coalesce((select timezone from branch where id = ${f.branchId ?? null}::uuid), t.timezone) as tz from tenant t where t.id = app.current_tenant_id()) z`);
  // Kunjungan hari ini per status (encounter tidak batal, tanggal kedatangan lokal cabang = hari ini lokal cabang)
  const [v] = await rowsOf<{ total: number; waiting: number; in_service: number; finished: number }>(tx, sql`
    select count(*)::int as total,
           count(*) filter (where e.status in ('REGISTERED', 'ARRIVED', 'TRIAGED'))::int as waiting,
           count(*) filter (where e.status in ('IN_CONSULTATION', 'CONSULT_DONE', 'PHARMACY', 'BILLING'))::int as in_service,
           count(*) filter (where e.status = 'FINISHED')::int as finished
      from encounter e join branch br on br.id = e.branch_id
     where e.status <> 'CANCELLED' and ${encounterTimeIn(sql`now() - interval '2 days'`, sql`now() + interval '1 day'`)}
       and (coalesce(e.arrived_at, e.created_at) at time zone br.timezone)::date = (now() at time zone br.timezone)::date and ${br()}`);
  const queue = await rowsOf<{ unit_id: string; unit_name: string; branch_name: string; waiting: number }>(tx, sql`
    select q.unit_id, u.name as unit_name, br.name as branch_name, count(*)::int as waiting
      from queue_ticket q join branch br on br.id = q.branch_id join service_unit u on u.id = q.unit_id
     where q.status in ('WAITING', 'CALLED') and q.queue_date = (now() at time zone br.timezone)::date and ${br()}
     group by q.unit_id, u.name, br.name order by count(*) desc, u.name`);
  // Kas hari ini: pembayaran (tanggal terima) + pelunasan piutang (tanggal bayar) − refund disetujui (tanggal keputusan) — sama dengan laporan pendapatan kas
  const [c] = await rowsOf<{ pay: string; settle: string; ref: string }>(tx, sql`
    select coalesce((select sum(p.amount) from payment p join invoice i on i.id = p.invoice_id join branch br on br.id = i.branch_id
                      where p.received_at >= now() - interval '2 days' and (p.received_at at time zone br.timezone)::date = (now() at time zone br.timezone)::date and ${br()}), 0)::text as pay,
           coalesce((select sum(rp.amount) from receivable_payment rp join receivable rc on rc.id = rp.receivable_id join invoice i on i.id = rc.invoice_id join branch br on br.id = i.branch_id
                      where rp.paid_on = (now() at time zone br.timezone)::date and ${br()}), 0)::text as settle,
           coalesce((select sum(r.amount) from refund r join payment p on p.id = r.payment_id join invoice i on i.id = p.invoice_id join branch br on br.id = i.branch_id
                      where r.status = 'APPROVED' and r.decided_at >= now() - interval '2 days'
                        and (r.decided_at at time zone br.timezone)::date = (now() at time zone br.timezone)::date and ${br()}), 0)::text as ref`);
  // Tagihan belum lunas (porsi pasien yang belum dibayar), semua tanggal
  const [u] = await rowsOf<{ n: number; amount: string }>(tx, sql`
    select count(*)::int as n, coalesce(sum(i.patient_portion - i.paid_amount), 0)::text as amount
      from invoice i join branch br on br.id = i.branch_id
     where i.status in ('ISSUED', 'PARTIALLY_PAID') and i.patient_portion > i.paid_amount and ${br()}`);
  // Stok: obat aktif dengan stok layak pakai ≤ stok minimum (dalam cakupan cabang), batch ≤ 30 hari & sudah kedaluwarsa
  const low = await rowsOf<{ code: string; drug_name: string; usable: string; min_stock: string; uom_name: string }>(tx, sql`
    with bal as (
      select sb.drug_item_id, sb.expiry_date, s.qty_on_hand, (now() at time zone br.timezone)::date as today
        from stock_balance s join stock_batch sb on sb.id = s.batch_id join stock_location l on l.id = s.location_id join branch br on br.id = l.branch_id
       where s.qty_on_hand > 0 and ${br()})
    select d.code, d.generic_name as drug_name, trim_scale(coalesce(sum(b.qty_on_hand) filter (where b.expiry_date >= b.today), 0))::text as usable,
           trim_scale(d.min_stock)::text as min_stock, um.name as uom_name
      from drug_item d join uom um on um.id = d.base_uom_id left join bal b on b.drug_item_id = d.id
     where d.is_active and d.min_stock > 0
     group by d.id, um.name
    having coalesce(sum(b.qty_on_hand) filter (where b.expiry_date >= b.today), 0) <= d.min_stock
     order by coalesce(sum(b.qty_on_hand) filter (where b.expiry_date >= b.today), 0) / d.min_stock, lower(d.generic_name)`);
  const [x] = await rowsOf<{ soon: number; expired: number }>(tx, sql`
    select count(*) filter (where sb.expiry_date >= (now() at time zone br.timezone)::date
                              and sb.expiry_date <= (now() at time zone br.timezone)::date + ${EXPIRY_DAYS}::int)::int as soon,
           count(*) filter (where sb.expiry_date < (now() at time zone br.timezone)::date)::int as expired
      from stock_balance s join stock_batch sb on sb.id = s.batch_id join stock_location l on l.id = s.location_id join branch br on br.id = l.branch_id
     where s.qty_on_hand > 0 and ${br()}`);
  // SATUSEHAT perlu tindakan (OD-119): ditolak / gagal / tertahan, dipetakan ke cabang lewat kunjungannya
  const [ss] = await rowsOf<{ error: number; dead: number; blocked: number }>(tx, sql`
    select count(*) filter (where r.status = 'ERROR')::int as error, count(*) filter (where r.status = 'DEAD')::int as dead,
           count(*) filter (where r.status = 'BLOCKED')::int as blocked
      from fhir_sync_record r left join fhir_sync_record p on p.id = r.parent_id
      join encounter e on e.id = case when r.local_type = 'encounter' then r.local_id else p.local_id end
     where r.status in ('ERROR', 'DEAD', 'BLOCKED') and r.local_type in ('encounter', 'prescription_item', 'dispense_line', 'clinical_addendum')
       and ${br(sql`e.branch_id`)}`);
  // Tren 14 hari (tanggal lokal cabang)
  const trend = await rowsOf<{ d: string; visits: number; cash: string }>(tx, sql`
    with days as (select generate_series((now() at time zone ${z0.tz})::date - ${TREND_DAYS - 1}::int, (now() at time zone ${z0.tz})::date, interval '1 day')::date as d),
    v as materialized (select (coalesce(e.arrived_at, e.created_at) at time zone br.timezone)::date as d, count(*)::int as n
            from encounter e join branch br on br.id = e.branch_id
           where e.status <> 'CANCELLED' and ${encounterTimeIn(sql`now() - make_interval(days => ${TREND_DAYS + 1})`, sql`now() + interval '1 day'`)} and ${br()}
           group by 1),
    k as materialized (select (p.received_at at time zone br.timezone)::date as d, p.amount as a
            from payment p join invoice i on i.id = p.invoice_id join branch br on br.id = i.branch_id
           where p.received_at >= now() - make_interval(days => ${TREND_DAYS + 1}) and ${br()}
          union all
          select rp.paid_on, rp.amount from receivable_payment rp join receivable rc on rc.id = rp.receivable_id join invoice i on i.id = rc.invoice_id
            join branch br on br.id = i.branch_id where rp.paid_on >= current_date - ${TREND_DAYS + 1}::int and ${br()}
          union all
          select (r.decided_at at time zone br.timezone)::date, -r.amount from refund r join payment p on p.id = r.payment_id join invoice i on i.id = p.invoice_id
            join branch br on br.id = i.branch_id where r.status = 'APPROVED' and r.decided_at >= now() - make_interval(days => ${TREND_DAYS + 1}) and ${br()})
    select to_char(days.d, 'YYYY-MM-DD') as d, coalesce((select n from v where v.d = days.d), 0) as visits,
           coalesce((select sum(a) from k where k.d = days.d), 0)::text as cash
      from days order by days.d`);
  return {
    date: z0.today, timezone: z0.tz,
    visits: { total: v.total, waiting: v.waiting, inService: v.in_service, finished: v.finished },
    queue: queue.map((q) => ({ unitId: q.unit_id, unitName: q.unit_name, branchName: q.branch_name, waiting: q.waiting })),
    cash: { payments: money(+c.pay), receivableSettlements: money(+c.settle), refunds: money(+c.ref), net: money(+c.pay + +c.settle - +c.ref) },
    unpaid: { invoices: u.n, amount: money(+u.amount) },
    stock: { lowStock: low.length, expiringSoon: x.soon, expired: x.expired,
      low: low.slice(0, 5).map((l) => ({ code: l.code, drugName: l.drug_name, usable: Number(l.usable), minStock: Number(l.min_stock), uomName: l.uom_name })) },
    satusehat: { needsAction: ss.error + ss.dead + ss.blocked, error: ss.error, dead: ss.dead, blocked: ss.blocked },
    trend: trend.map((t) => ({ date: t.d, visits: t.visits, cash: money(+t.cash) })),
  };
}
