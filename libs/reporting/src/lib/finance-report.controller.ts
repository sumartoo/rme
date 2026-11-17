import { Controller, Get, Query, Res } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePermission, Uuid, problem } from '@clinicrme/shared';
import { Db, audit, rows } from '@clinicrme/db';
import { DATE, PAYER_LABEL, PAYER_TYPES, type Column, branchScope, csvOf, filterSummary, inBranches, parseQuery, reportTimeout } from './report-common';

const Range = { from: DATE, to: DATE, branchId: Uuid.optional(), format: z.enum(['json', 'csv']).default('json') };
const RevenueQ = z.object({ ...Range, view: z.enum(['billed', 'cash']).default('billed'),
  groupBy: z.enum(['category', 'service', 'payer', 'day']).default('category'), payerType: z.enum(PAYER_TYPES).optional() });
const ClosingQ = z.object(Range);
const AgingQ = z.object({ asOf: DATE.optional(), branchId: Uuid.optional(), format: z.enum(['json', 'csv']).default('json') });

const CATEGORY_LABEL: Record<string, string> = { KONSULTASI: 'Konsultasi', TINDAKAN: 'Tindakan', OBAT: 'Obat', LAB: 'Laboratorium', ADMINISTRASI: 'Administrasi', LAINNYA: 'Lainnya' };
const METHOD_LABEL: Record<string, string> = { TUNAI: 'Tunai', DEBIT: 'Kartu debit', KARTU_KREDIT: 'Kartu kredit', TRANSFER: 'Transfer', QRIS: 'QRIS', PIUTANG_PELUNASAN: 'Pelunasan piutang' };
const STATUS_LABEL: Record<string, string> = { OPEN: 'Terbuka', CLOSED: 'Ditutup', VERIFIED: 'Terverifikasi' };

const BILLED_COLUMNS: Column[] = [
  { key: 'groupLabel', label: 'Kelompok', type: 'string' }, { key: 'lines', label: 'Jumlah baris', type: 'number' },
  { key: 'gross', label: 'Bruto', type: 'money' }, { key: 'discount', label: 'Diskon', type: 'money' }, { key: 'net', label: 'Neto', type: 'money' },
  { key: 'patientPortion', label: 'Porsi pasien', type: 'money' }, { key: 'payerPortion', label: 'Porsi penjamin', type: 'money' },
];
const CASH_COLUMNS: Column[] = [
  { key: 'groupLabel', label: 'Kelompok', type: 'string' }, { key: 'payments', label: 'Pembayaran', type: 'money' },
  { key: 'receivableSettlements', label: 'Pelunasan piutang', type: 'money' }, { key: 'refunds', label: 'Refund', type: 'money' }, { key: 'net', label: 'Kas bersih', type: 'money' },
];
const CLOSING_COLUMNS: Column[] = [
  { key: 'date', label: 'Tanggal', type: 'date' }, { key: 'branchName', label: 'Cabang', type: 'string' }, { key: 'cashierName', label: 'Kasir', type: 'string' },
  { key: 'statusLabel', label: 'Status', type: 'string' }, { key: 'openingCash', label: 'Kas awal', type: 'money' }, { key: 'cashIn', label: 'Tunai masuk', type: 'money' },
  { key: 'cashRefunds', label: 'Refund tunai', type: 'money' }, { key: 'expectedCash', label: 'Kas seharusnya', type: 'money' },
  { key: 'countedCash', label: 'Kas dihitung', type: 'money' }, { key: 'variance', label: 'Selisih', type: 'money' }, { key: 'nonCash', label: 'Non-tunai', type: 'money' },
  { key: 'verifiedByName', label: 'Diverifikasi oleh', type: 'string' },
];
const AGING_COLUMNS: Column[] = [
  { key: 'payerName', label: 'Penjamin', type: 'string' }, { key: 'count', label: 'Jumlah tagihan', type: 'number' },
  { key: 'notDue', label: 'Belum jatuh tempo', type: 'money' }, { key: 'd1_30', label: '1–30 hari', type: 'money' }, { key: 'd31_60', label: '31–60 hari', type: 'money' },
  { key: 'd61_90', label: '61–90 hari', type: 'money' }, { key: 'over90', label: '> 90 hari', type: 'money' }, { key: 'total', label: 'Total piutang', type: 'money' },
];
const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/**
 * Laporan keuangan standar (Stage 14 batch 2; RPT-FR-003, 004, 007; OD-126, OD-127 / DEC-047). Bukan laporan akuntansi resmi.
 * Tanggal menurut zona waktu cabang; cakupan cabang dari penugasan role (OD-129).
 */
@Controller('api/v1/reports')
export class FinanceReportController {
  constructor(private readonly db: Db) {}

  /**
   * Pendapatan (OD-126). `view=billed`: tagihan terbit (bukan draf/void) per tanggal terbit — bruto, diskon, neto, porsi pasien & penjamin,
   * dikelompokkan per kategori/layanan/penjamin/hari. `view=cash`: penerimaan kas per metode — pembayaran (tanggal terima) + pelunasan piutang
   * penjamin (tanggal bayar) − refund disetujui (tanggal keputusan), dikelompokkan per metode atau hari.
   */
  @RequirePermission('report.finance.read') @Get('revenue')
  async revenue(@Query() query: Record<string, string | undefined>, @Res({ passthrough: true }) res: Response) {
    const f = parseQuery(RevenueQ, query);
    if (f.view === 'cash' && (f.groupBy === 'category' || f.groupBy === 'service')) f.groupBy = 'payer';   // kas: per metode (kolom "payer" tidak berlaku)
    const out = await this.db.withTenantTx(async (tx) => {
      await reportTimeout(tx);
      const scope = await branchScope(tx, 'report.finance.read', f.branchId);
      const local = (col: SQL) => sql`(${col} at time zone br.timezone)::date`;
      const inRange = (col: SQL) => sql`${col} >= (${f.from}::date - 1)::timestamptz and ${col} < (${f.to}::date + 2)::timestamptz
                                        and ${local(col)} between ${f.from}::date and ${f.to}::date`;
      if (f.view === 'billed') {
        const [key, label]: [SQL, SQL] = {
          category: [sql`l.source_type`, sql`l.source_type`],
          service: [sql`coalesce(l.service_item_id::text, l.drug_item_id::text, l.description)`,
            sql`coalesce((select name from service_item where id = l.service_item_id), (select generic_name from drug_item where id = l.drug_item_id), l.description)`],
          payer: [sql`coalesce(i.payer_id::text, i.payer_type)`, sql`coalesce((select name from payer where id = i.payer_id), i.payer_type)`],
          day: [sql`to_char(${local(sql`i.issued_at`)}, 'YYYY-MM-DD')`, sql`to_char(${local(sql`i.issued_at`)}, 'YYYY-MM-DD')`],
        }[f.groupBy] as [SQL, SQL];
        const data = await rows<{ group_key: string; group_label: string; lines: number; gross: string; discount: string; net: string; patient: string; payer: string }>(tx, sql`
          select ${key} as group_key, ${label} as group_label, count(*)::int as lines,
                 sum(round(l.qty * l.unit_price, 2))::text as gross, sum(l.discount_amount)::text as discount, sum(l.line_total)::text as net,
                 sum(l.patient_portion)::text as patient, sum(l.payer_portion)::text as payer
            from invoice i join invoice_line l on l.invoice_id = i.id join branch br on br.id = i.branch_id
           where i.status in ('ISSUED', 'PARTIALLY_PAID', 'PAID') and ${inRange(sql`i.issued_at`)} and ${inBranches(sql`br.id`, scope)}
             and (${f.payerType ?? null}::text is null or i.payer_type = ${f.payerType ?? null}::text)
           group by 1, 2 order by ${f.groupBy === 'day' ? sql`1` : sql`sum(l.line_total) desc, 2`}`);
        const [inv] = await rows<{ n: number }>(tx, sql`
          select count(*)::int as n from invoice i join branch br on br.id = i.branch_id
           where i.status in ('ISSUED', 'PARTIALLY_PAID', 'PAID') and ${inRange(sql`i.issued_at`)} and ${inBranches(sql`br.id`, scope)}
             and (${f.payerType ?? null}::text is null or i.payer_type = ${f.payerType ?? null}::text)`);
        const r = data.map((x) => ({ groupKey: x.group_key,
          groupLabel: f.groupBy === 'category' ? CATEGORY_LABEL[x.group_label] ?? x.group_label : f.groupBy === 'payer' ? PAYER_LABEL[x.group_label] ?? x.group_label : x.group_label,
          lines: x.lines, gross: money(+x.gross), discount: money(+x.discount), net: money(+x.net), patientPortion: money(+x.patient), payerPortion: money(+x.payer) }));
        const sum = (k: 'gross' | 'discount' | 'net' | 'patientPortion' | 'payerPortion') => money(r.reduce((a, x) => a + Number(x[k]), 0));
        return { columns: BILLED_COLUMNS, rows: r, scope,
          totals: { invoices: inv.n, gross: sum('gross'), discount: sum('discount'), net: sum('net'), patientPortion: sum('patientPortion'), payerPortion: sum('payerPortion') } };
      }
      // Penerimaan kas
      const byDay = f.groupBy === 'day';
      const data = await rows<{ group_key: string; payments: string; settlements: string; refunds: string }>(tx, sql`
        with cash as (
          select ${byDay ? sql`to_char(${local(sql`p.received_at`)}, 'YYYY-MM-DD')` : sql`p.method`} as k, p.amount as pay, 0::numeric as settle, 0::numeric as ref
            from payment p join invoice i on i.id = p.invoice_id join branch br on br.id = i.branch_id
           where ${inRange(sql`p.received_at`)} and ${inBranches(sql`br.id`, scope)}
          union all
          select ${byDay ? sql`to_char(rp.paid_on, 'YYYY-MM-DD')` : sql`rp.method`}, 0, rp.amount, 0
            from receivable_payment rp join receivable rc on rc.id = rp.receivable_id join invoice i on i.id = rc.invoice_id join branch br on br.id = i.branch_id
           where rp.paid_on between ${f.from}::date and ${f.to}::date and ${inBranches(sql`br.id`, scope)}
          union all
          select ${byDay ? sql`to_char(${local(sql`r.decided_at`)}, 'YYYY-MM-DD')` : sql`r.method`}, 0, 0, r.amount
            from refund r join payment p on p.id = r.payment_id join invoice i on i.id = p.invoice_id join branch br on br.id = i.branch_id
           where r.status = 'APPROVED' and ${inRange(sql`r.decided_at`)} and ${inBranches(sql`br.id`, scope)})
        select k as group_key, sum(pay)::text as payments, sum(settle)::text as settlements, sum(ref)::text as refunds from cash group by k order by k`);
      const r = data.map((x) => ({ groupKey: x.group_key, groupLabel: byDay ? x.group_key : METHOD_LABEL[x.group_key] ?? x.group_key,
        payments: money(+x.payments), receivableSettlements: money(+x.settlements), refunds: money(+x.refunds), net: money(+x.payments + +x.settlements - +x.refunds) }));
      const sum = (k: 'payments' | 'receivableSettlements' | 'refunds' | 'net') => money(r.reduce((a, x) => a + Number(x[k]), 0));
      return { columns: CASH_COLUMNS, rows: r, scope,
        totals: { payments: sum('payments'), receivableSettlements: sum('receivableSettlements'), refunds: sum('refunds'), net: sum('net') } };
    });
    await this.db.withTenantTx((tx) => audit(tx, 'REPORT_REVENUE_VIEWED', 'report', null, null, filterSummary(f)));
    if (f.format === 'csv') return this.csv(res, `pendapatan-${f.view === 'cash' ? 'kas' : 'tagihan'}-${f.from}-${f.to}.csv`, csvOf(out.columns, out.rows));
    return { columns: out.columns, rows: out.rows, totals: out.totals, view: f.view, groupBy: f.groupBy, from: f.from, to: f.to, allBranches: out.scope === null,
      generatedAt: new Date().toISOString() };
  }

  /** Closing kasir (OD-127): rekap shift per tanggal buka (zona waktu cabang) — kas awal, tunai masuk, refund tunai, kas seharusnya, dihitung, selisih, non-tunai. */
  @RequirePermission('report.finance.read') @Get('cashier-closing')
  async cashierClosing(@Query() query: Record<string, string | undefined>, @Res({ passthrough: true }) res: Response) {
    const f = parseQuery(ClosingQ, query);
    const data = await this.db.withTenantTx(async (tx) => {
      await reportTimeout(tx);
      const scope = await branchScope(tx, 'report.finance.read', f.branchId);
      const r = await rows<{ id: string; date: string; branch_name: string; cashier_name: string; status: string; opening_cash: string; cash_in: string; cash_refund: string;
        expected_cash: string | null; counted_cash: string | null; variance: string | null; non_cash: string; verified_by_name: string | null; variance_note: string | null }>(tx, sql`
        select s.id, to_char((s.opened_at at time zone br.timezone)::date, 'YYYY-MM-DD') as date, br.name as branch_name, u.full_name as cashier_name, s.status,
               s.opening_cash::text, s.expected_cash::text, s.counted_cash::text, s.variance::text, vb.full_name as verified_by_name, s.variance_note,
               coalesce((select sum(p.amount) from payment p where p.shift_id = s.id and p.method = 'TUNAI'), 0)::text as cash_in,
               coalesce((select sum(p.amount) from payment p where p.shift_id = s.id and p.method <> 'TUNAI'), 0)::text as non_cash,
               coalesce((select sum(x.amount) from refund x where x.shift_id = s.id and x.method = 'TUNAI' and x.status = 'APPROVED'), 0)::text as cash_refund
          from cashier_shift s join branch br on br.id = s.branch_id join app_user u on u.id = s.cashier_id left join app_user vb on vb.id = s.verified_by
         where s.opened_at >= (${f.from}::date - 1)::timestamptz and s.opened_at < (${f.to}::date + 2)::timestamptz
           and (s.opened_at at time zone br.timezone)::date between ${f.from}::date and ${f.to}::date and ${inBranches(sql`br.id`, scope)}
         order by s.opened_at, s.id`);
      await audit(tx, 'REPORT_CASHIER_CLOSING_VIEWED', 'report', null, null, filterSummary(f));
      return r;
    });
    const rowsOut = data.map((s) => ({
      shiftId: s.id, date: s.date, branchName: s.branch_name, cashierName: s.cashier_name, status: s.status, statusLabel: STATUS_LABEL[s.status] ?? s.status,
      openingCash: money(+s.opening_cash), cashIn: money(+s.cash_in), cashRefunds: money(+s.cash_refund),
      // OD-111: kas awal + tunai masuk − refund tunai (nilai tersimpan saat tutup bila ada)
      expectedCash: s.expected_cash ?? money(+s.opening_cash + +s.cash_in - +s.cash_refund),
      countedCash: s.counted_cash, variance: s.variance, nonCash: money(+s.non_cash), verifiedByName: s.verified_by_name, varianceNote: s.variance_note,
    }));
    if (f.format === 'csv') return this.csv(res, `closing-kasir-${f.from}-${f.to}.csv`, csvOf(CLOSING_COLUMNS, rowsOut));
    const sum = (k: 'cashIn' | 'cashRefunds' | 'nonCash') => money(rowsOut.reduce((a, x) => a + Number(x[k]), 0));
    const closed = rowsOut.filter((x) => x.variance !== null);
    return { columns: CLOSING_COLUMNS, rows: rowsOut, from: f.from, to: f.to, generatedAt: new Date().toISOString(),
      totals: { shifts: rowsOut.length, open: rowsOut.filter((x) => x.status === 'OPEN').length, unverified: rowsOut.filter((x) => x.status === 'CLOSED').length,
        cashIn: sum('cashIn'), cashRefunds: sum('cashRefunds'), nonCash: sum('nonCash'), variance: money(closed.reduce((a, x) => a + Number(x.variance), 0)) } };
  }

  /**
   * Umur piutang penjamin (OD-127) per tanggal posisi (bawaan hari ini, zona waktu tenant): sisa = nominal − pelunasan s.d. tanggal itu, untuk
   * piutang dari tagihan yang terbit s.d. tanggal itu (tidak void). Umur dihitung dari jatuh tempo.
   */
  @RequirePermission('report.finance.read') @Get('receivables')
  async receivables(@Query() query: Record<string, string | undefined>, @Res({ passthrough: true }) res: Response) {
    const P = AgingQ.safeParse(query);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', `Parameter tidak valid: ${P.error.issues[0]?.path.join('.')} — ${P.error.issues[0]?.message}`);
    const f = P.data;
    const out = await this.db.withTenantTx(async (tx) => {
      await reportTimeout(tx);
      const scope = await branchScope(tx, 'report.finance.read', f.branchId);
      const [{ as_of }] = await rows<{ as_of: string }>(tx, sql`
        select coalesce(${f.asOf ?? null}::date, (now() at time zone (select timezone from tenant where id = app.current_tenant_id()))::date)::text as as_of`);
      const data = await rows<{ payer_id: string; payer_name: string; n: number; not_due: string; d1: string; d31: string; d61: string; d90: string }>(tx, sql`
        with r as (
          select rc.payer_id, rc.due_date,
                 rc.amount - coalesce((select sum(rp.amount) from receivable_payment rp where rp.receivable_id = rc.id and rp.paid_on <= ${as_of}::date), 0) as remaining
            from receivable rc join invoice i on i.id = rc.invoice_id join branch br on br.id = i.branch_id
           where rc.status <> 'VOID' and i.status <> 'VOID' and (i.issued_at at time zone br.timezone)::date <= ${as_of}::date and ${inBranches(sql`br.id`, scope)})
        select r.payer_id, p.name as payer_name, count(*)::int as n,
               coalesce(sum(remaining) filter (where ${as_of}::date - due_date <= 0), 0)::text as not_due,
               coalesce(sum(remaining) filter (where ${as_of}::date - due_date between 1 and 30), 0)::text as d1,
               coalesce(sum(remaining) filter (where ${as_of}::date - due_date between 31 and 60), 0)::text as d31,
               coalesce(sum(remaining) filter (where ${as_of}::date - due_date between 61 and 90), 0)::text as d61,
               coalesce(sum(remaining) filter (where ${as_of}::date - due_date > 90), 0)::text as d90
          from r join payer p on p.id = r.payer_id where r.remaining > 0 group by r.payer_id, p.name order by p.name`);
      await audit(tx, 'REPORT_RECEIVABLES_VIEWED', 'report', null, null, { asOf: as_of, branchId: f.branchId ?? null, format: f.format });
      return { asOf: as_of, data };
    });
    const rowsOut = out.data.map((x) => {
      const b = [+x.not_due, +x.d1, +x.d31, +x.d61, +x.d90];
      return { payerId: x.payer_id, payerName: x.payer_name, count: x.n, notDue: money(b[0]), d1_30: money(b[1]), d31_60: money(b[2]), d61_90: money(b[3]),
        over90: money(b[4]), total: money(b.reduce((a, v) => a + v, 0)) };
    });
    if (f.format === 'csv') return this.csv(res, `umur-piutang-${out.asOf}.csv`, csvOf(AGING_COLUMNS, rowsOut));
    const sum = (k: 'notDue' | 'd1_30' | 'd31_60' | 'd61_90' | 'over90' | 'total') => money(rowsOut.reduce((a, x) => a + Number(x[k]), 0));
    return { columns: AGING_COLUMNS, rows: rowsOut, asOf: out.asOf, generatedAt: new Date().toISOString(),
      totals: { count: rowsOut.reduce((a, x) => a + x.count, 0), notDue: sum('notDue'), d1_30: sum('d1_30'), d31_60: sum('d31_60'), d61_90: sum('d61_90'),
        over90: sum('over90'), total: sum('total') } };
  }

  private csv(res: Response, filename: string, body: string) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return body;
  }
}
