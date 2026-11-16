import { sql } from 'drizzle-orm';
import { type Tx, rows } from '@clinicrme/db';
import { problem } from '@clinicrme/shared';

export const SHIFT_NOT_FOUND = ['BIL-404-SHIFT', 'Shift kasir tidak ditemukan'] as const;

/** Ringkasan shift: total per metode, kas seharusnya (OD-111), hasil tutup & verifikasi. */
export async function shiftView(tx: Tx, id: string) {
  const [s] = await rows<{ id: string; status: string; branch_id: string; branch_name: string; cashier_name: string; opened_at: string; closed_at: string | null;
                           opening_cash: string; counted_cash: string | null; expected_cash: string | null; variance: string | null; variance_note: string | null;
                           cash_in: string; cash_refund: string; cashier_id: string; closed_by_name: string | null; verified_by_name: string | null;
                           verified_at: string | null; verify_note: string | null; forced: boolean }>(tx, sql`
    select s.id, s.status, s.branch_id, br.name as branch_name, u.full_name as cashier_name, s.opened_at, s.closed_at, s.opening_cash::text,
           s.counted_cash::text, s.expected_cash::text, s.variance::text, s.variance_note, s.cashier_id, cb.full_name as closed_by_name,
           vb.full_name as verified_by_name, s.verified_at, s.verify_note, (s.closed_by is not null and s.closed_by <> s.cashier_id) as forced,
           coalesce((select sum(p.amount) from payment p where p.shift_id = s.id and p.method = 'TUNAI'), 0)::text as cash_in,
           coalesce((select sum(r.amount) from refund r where r.shift_id = s.id and r.method = 'TUNAI' and r.status = 'APPROVED'), 0)::text as cash_refund
      from cashier_shift s join branch br on br.id = s.branch_id join app_user u on u.id = s.cashier_id
      left join app_user cb on cb.id = s.closed_by left join app_user vb on vb.id = s.verified_by where s.id = ${id}`);
  if (!s) throw problem(404, ...SHIFT_NOT_FOUND);
  const totals = await rows<{ method: string; n: number; total: string }>(tx, sql`
    select method, count(*)::int as n, sum(amount)::text as total from payment where shift_id = ${id} group by method order by method`);
  // OD-111: kas awal + tunai diterima − refund tunai disetujui di shift ini
  const expected = s.expected_cash ?? (Number(s.opening_cash) + Number(s.cash_in) - Number(s.cash_refund)).toFixed(2);
  return {
    id: s.id, status: s.status, branchId: s.branch_id, branchName: s.branch_name, cashierName: s.cashier_name, openedAt: s.opened_at, closedAt: s.closed_at,
    openingCash: s.opening_cash, expectedCash: expected, countedCash: s.counted_cash, variance: s.variance, varianceNote: s.variance_note,
    totals: totals.map((t) => ({ method: t.method, count: t.n, total: t.total })),
    paymentCount: totals.reduce((n, t) => n + t.n, 0), cashRefunds: s.cash_refund, cashierId: s.cashier_id,
    closedByName: s.closed_by_name, forceClosed: s.forced, verifiedByName: s.verified_by_name, verifiedAt: s.verified_at, verifyNote: s.verify_note,
  };
}