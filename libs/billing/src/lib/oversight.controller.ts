import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { BodySchema, RequirePermission, Uuid, assertId, ctx, optText, problem } from '@clinicrme/shared';
import { Db, type Tx, audit, idempotent, rows } from '@clinicrme/db';
import { SHIFT_NOT_FOUND, shiftView } from './shift.repo';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ReceivablePayBody = z.object({
  amount: z.number().positive().max(1_000_000_000).transform((n) => Math.round(n * 100) / 100),
  paidOn: Day,
  method: z.enum(['TRANSFER', 'GIRO', 'LAINNYA']),
  reference: z.string().trim().min(3, 'Referensi minimal 3 karakter').max(100),
  note: optText(300),
}).strict();
const ForceCloseBody = z.object({ countedCash: z.number().min(0).max(1_000_000_000).transform((n) => Math.round(n * 100) / 100),
  note: z.string().trim().min(5, 'Keterangan minimal 5 karakter').max(300) }).strict();
const VerifyBody = z.object({ note: optText(300) }).strict();
const ShiftQuery = z.object({ status: z.enum(['OPEN', 'CLOSED', 'VERIFIED']).optional(), branchId: Uuid.optional(), from: Day.optional(), to: Day.optional() });
const AnomalyQuery = z.object({ from: Day, to: Day, branchId: Uuid.optional(), format: z.enum(['json', 'csv']).optional() });
const RCV_NOT_FOUND = ['BIL-404-RECEIVABLE', 'Piutang tidak ditemukan'] as const;
const rp = (v: string | number) => `Rp ${Number(v).toLocaleString('id-ID', { maximumFractionDigits: 2 })}`;

export const ANOMALY_RULES = {
  VOID_OUTSIDE_HOURS: 'Void di luar jam operasional',
  REFUND_OUTSIDE_HOURS: 'Refund di luar jam operasional',
  DISCOUNT_OVER_LIMIT: 'Diskon di atas batas klinik',
  VOIDS_PER_SHIFT: 'Void per kasir per shift melebihi batas',
  CASH_VARIANCE: 'Selisih kas di atas toleransi',
  CASH_AFTER_QRIS: 'Bayar tunai + QRIS melebihi tagihan',
} as const;
type Rule = keyof typeof ANOMALY_RULES;

/**
 * Pengawasan kasir (Stage 11 batch 4): pelunasan piutang penjamin (BIL-FR-013), verifikasi & penutupan shift oleh manajer
 * (OD-111), laporan transaksi tidak wajar (BIL-FR-016, OD-041 — tanda, bukan blokir).
 */
@Controller('api/v1')
export class OversightController {
  constructor(private readonly db: Db) {}

  /** Piutang + riwayat pelunasan. */
  @RequirePermission('billing.receivable.read') @Get('receivables/:id')
  async receivable(@Param('id') id: string) {
    assertId(id, ...RCV_NOT_FOUND);
    return this.db.withTenantTx((tx) => this.receivableView(tx, id));
  }

  /** Catat pelunasan sebagian/penuh dari penjamin (AC-BIL-FR-013-1): ≤ saldo; append-only; idempoten. */
  @RequirePermission('billing.receivable.manage') @BodySchema(ReceivablePayBody) @Post('receivables/:id/payments') @HttpCode(200)
  async payReceivable(@Param('id') id: string, @Body() b: z.infer<typeof ReceivablePayBody>, @Headers('idempotency-key') key: string | undefined) {
    assertId(id, ...RCV_NOT_FOUND);
    return this.db.withTenantTx((tx) => idempotent(tx, 'receivable.pay', key, { id, ...b }, async () => {
      const [r] = await rows<{ status: string; balance: string; invoice_id: string; patient_id: string | null; invoice_no: string; future: boolean }>(tx, sql`
        select r.status, (r.amount - r.paid_amount)::text as balance, r.invoice_id, i.patient_id, i.invoice_no,
               ${b.paidOn}::date > (now() at time zone br.timezone)::date as future
          from receivable r join invoice i on i.id = r.invoice_id join branch br on br.id = i.branch_id where r.id = ${id} for update of r`);
      if (!r) throw problem(404, ...RCV_NOT_FOUND);
      if (r.status !== 'OPEN' && r.status !== 'PARTIAL') throw problem(409, 'BIL-409-RECEIVABLE-CLOSED', 'Piutang sudah lunas atau dibatalkan');
      if (r.future) throw problem(400, 'BIL-400-DATE', 'Tanggal pelunasan tidak boleh di masa depan');
      if (b.amount > Number(r.balance) + 0.001) throw problem(409, 'BIL-409-OVERPAY', `Pelunasan melebihi saldo piutang (${rp(r.balance)})`);
      await tx.execute(sql`
        insert into receivable_payment(tenant_id, receivable_id, amount, paid_on, method, reference, note, idempotency_key, recorded_by)
        values (app.current_tenant_id(), ${id}, ${b.amount.toFixed(2)}::numeric, ${b.paidOn}::date, ${b.method}, ${b.reference}, ${b.note?.trim() || null},
                ${key}, ${ctx().userId})`);
      const [u] = await rows<{ status: string }>(tx, sql`
        update receivable set paid_amount = paid_amount + ${b.amount.toFixed(2)}::numeric,
               status = case when paid_amount + ${b.amount.toFixed(2)}::numeric >= amount then 'PAID' else 'PARTIAL' end
         where id = ${id} returning status`);
      await audit(tx, 'RECEIVABLE_PAYMENT_RECORDED', 'receivable', id, r.patient_id,
        { invoiceNo: r.invoice_no, amount: b.amount, method: b.method, reference: b.reference, status: u.status });
      return this.receivableView(tx, id);
    }));
  }

  /** Daftar shift untuk manajer: status, cabang, tanggal buka (zona cabang). */
  @RequirePermission('billing.reconcile') @Get('cashier-shifts')
  async shifts(@Query() q: Record<string, string | undefined>) {
    const P = ShiftQuery.safeParse(q);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const f = P.data;
    return this.db.withTenantTx(async (tx) => {
      const ids = await rows<{ id: string }>(tx, sql`
        select s.id from cashier_shift s join branch br on br.id = s.branch_id
         where (${f.status ?? null}::text is null or s.status = ${f.status ?? null}::text)
           and (${f.branchId ?? null}::uuid is null or s.branch_id = ${f.branchId ?? null}::uuid)
           and (${f.from ?? null}::date is null or (s.opened_at at time zone br.timezone)::date >= ${f.from ?? null}::date)
           and (${f.to ?? null}::date is null or (s.opened_at at time zone br.timezone)::date <= ${f.to ?? null}::date)
         order by s.opened_at desc limit 200`);
      const tol = await tolerance(tx);
      return Promise.all(ids.map(async (x) => {
        const v = await shiftView(tx, x.id);
        return { ...v, overTolerance: v.variance !== null && Math.abs(Number(v.variance)) > tol };
      }));
    });
  }

  /** Shift lupa ditutup (OD-111): manajer menutup dengan kas fisik & keterangan; tercatat siapa yang menutup. */
  @RequirePermission('billing.reconcile') @BodySchema(ForceCloseBody) @Post('cashier-shifts/:id/force-close') @HttpCode(200)
  async forceClose(@Param('id') id: string, @Body() b: z.infer<typeof ForceCloseBody>) {
    assertId(id, ...SHIFT_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const [s] = await rows<{ status: string; cashier_id: string }>(tx, sql`select status, cashier_id from cashier_shift where id = ${id} for update`);
      if (!s) throw problem(404, ...SHIFT_NOT_FOUND);
      if (s.status !== 'OPEN') throw problem(409, 'BIL-409-SHIFT-CLOSED', 'Shift sudah ditutup');
      if (s.cashier_id === ctx().userId) throw problem(409, 'BIL-409-SHIFT-OWN', 'Tutup shift Anda sendiri dari halaman Tagihan');
      const v = await shiftView(tx, id);
      await tx.execute(sql`
        update cashier_shift set status = 'CLOSED', closed_at = now(), closed_by = ${ctx().userId}, counted_cash = ${b.countedCash.toFixed(2)}::numeric,
               expected_cash = ${v.expectedCash}::numeric, variance_note = ${b.note} where id = ${id}`);
      await audit(tx, 'SHIFT_FORCE_CLOSED', 'cashier_shift', id, null,
        { cashier: v.cashierName, expectedCash: v.expectedCash, countedCash: b.countedCash, note: b.note });
      return shiftView(tx, id);
    });
  }

  /** Verifikasi shift tertutup oleh manajer (≠ kasir shift); selisih di atas toleransi wajib catatan verifikasi. */
  @RequirePermission('billing.reconcile') @BodySchema(VerifyBody) @Post('cashier-shifts/:id/verify') @HttpCode(200)
  async verify(@Param('id') id: string, @Body() b: z.infer<typeof VerifyBody>) {
    assertId(id, ...SHIFT_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const [s] = await rows<{ status: string; cashier_id: string; variance: string | null }>(tx, sql`
        select status, cashier_id, variance::text from cashier_shift where id = ${id} for update`);
      if (!s) throw problem(404, ...SHIFT_NOT_FOUND);
      if (s.status !== 'CLOSED') throw problem(409, 'BIL-409-SHIFT-STATE', s.status === 'OPEN' ? 'Shift belum ditutup' : 'Shift sudah diverifikasi');
      if (s.cashier_id === ctx().userId) throw problem(403, 'BIL-403-SELF-APPROVAL', 'Shift tidak dapat diverifikasi oleh kasirnya sendiri');
      const note = b.note?.trim() || null;
      const tol = await tolerance(tx);
      if (Math.abs(Number(s.variance ?? 0)) > tol + 1e-9 && (note ?? '').length < 5) {
        throw problem(400, 'BIL-400-NOTE', 'Selisih kas di atas toleransi: isi catatan verifikasi');
      }
      await tx.execute(sql`update cashier_shift set status = 'VERIFIED', verified_by = ${ctx().userId}, verified_at = now(), verify_note = ${note} where id = ${id}`);
      await audit(tx, 'SHIFT_VERIFIED', 'cashier_shift', id, null, { variance: s.variance, note });
      return shiftView(tx, id);
    });
  }

  /**
   * Transaksi tidak wajar (AC-BIL-FR-016-1): void/refund di luar jam operasional, diskon di atas batas, void per kasir per
   * shift melebihi batas, selisih kas di atas toleransi, bayar tunai + QRIS melebihi tagihan. Ambang dari Profil klinik
   * (OD-041). `format=csv` untuk ekspor (butuh `report.export`, OD-132).
   */
  @RequirePermission('report.finance.audit') @Get('reports/anomalies')
  async anomalies(@Query() q: Record<string, string | undefined>, @Res({ passthrough: true }) res: Response) {
    const P = AnomalyQuery.safeParse(q);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tanggal tidak valid');
    const { from, to, branchId, format } = P.data;
    if (from > to) throw problem(400, 'GEN-400-QUERY', 'Tanggal awal setelah tanggal akhir');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 92) throw problem(400, 'GEN-400-QUERY', 'Rentang maksimal 92 hari');
    // OD-132 (DEC-048): unduhan CSV laporan wajib izin ekspor
    if (format === 'csv' && !ctx().permissions?.has('report.export')) throw problem(403, 'RPT-403-EXPORT', 'Unduhan CSV memerlukan izin ekspor laporan');
    const out = await this.db.withTenantTx(async (tx) => {
      const [c] = await rows<{ start: string; end: string; voids: number; tol: number }>(tx, sql`
        select coalesce(settings->>'billingHoursStart', '07:00') as start, coalesce(settings->>'billingHoursEnd', '21:00') as end,
               coalesce((settings->>'voidsPerShiftLimit')::int, 3) as voids, coalesce((settings->>'cashVarianceTolerance')::numeric, 10000)::float as tol
          from tenant where id = app.current_tenant_id()`);
      const b = branchId ?? null;
      const inRange = (col: SQL) =>
        sql`(${col} at time zone br.timezone)::date between ${from}::date and ${to}::date and (${b}::uuid is null or br.id = ${b}::uuid)`;
      const outside = (col: SQL) =>
        sql`not ((${col} at time zone br.timezone)::time >= ${c.start}::time and (${col} at time zone br.timezone)::time < ${c.end}::time)`;
      const items = await rows<{ rule: Rule; at: string; branch_name: string; user_name: string | null; invoice_id: string | null; invoice_no: string | null;
                                 shift_id: string | null; amount: string | null; detail: string }>(tx, sql`
        select 'VOID_OUTSIDE_HOURS' as rule, v.created_at as at, br.name as branch_name, u.full_name as user_name, i.id as invoice_id, i.invoice_no,
               null::uuid as shift_id, i.net_amount::text as amount, v.reason || ' (' || v.status || ')' as detail
          from invoice_void v join invoice i on i.id = v.invoice_id join branch br on br.id = i.branch_id join app_user u on u.id = v.requested_by
         where ${inRange(sql`v.created_at`)} and ${outside(sql`v.created_at`)}
        union all
        select 'REFUND_OUTSIDE_HOURS', r.requested_at, br.name, u.full_name, i.id, i.invoice_no, r.shift_id, r.amount::text, r.refund_no || ': ' || r.reason || ' (' || r.status || ')'
          from refund r join payment p on p.id = r.payment_id join invoice i on i.id = p.invoice_id join branch br on br.id = i.branch_id
          join app_user u on u.id = r.requested_by
         where ${inRange(sql`r.requested_at`)} and ${outside(sql`r.requested_at`)}
        union all
        select 'DISCOUNT_OVER_LIMIT', i.issued_at, br.name, u.full_name, i.id, i.invoice_no, null, l.discount_amount::text,
               l.description || ' — ' || round(l.discount_amount / nullif(l.qty * l.unit_price, 0) * 100, 1) || '%: ' || coalesce(l.discount_reason, '')
               || coalesce(' · disetujui ' || au.full_name, '')
          from invoice_line l join invoice i on i.id = l.invoice_id join branch br on br.id = i.branch_id
          left join app_user u on u.id = l.discount_requested_by left join app_user au on au.id = l.discount_approved_by
         where i.status <> 'DRAFT' and l.discount_status in ('PENDING', 'APPROVED') and ${inRange(sql`i.issued_at`)}
        union all
        select 'VOIDS_PER_SHIFT', s.opened_at, br.name, u.full_name, null, null, s.id, null, n.n || ' pengajuan void dalam satu shift (batas ' || ${c.voids}::int || ')'
          from cashier_shift s join branch br on br.id = s.branch_id join app_user u on u.id = s.cashier_id
          cross join lateral (select count(*)::int as n from invoice_void v where v.requested_by = s.cashier_id
                                and v.created_at >= s.opened_at and v.created_at < coalesce(s.closed_at, now())) n
         where n.n > ${c.voids}::int and ${inRange(sql`s.opened_at`)}
        union all
        select 'CASH_VARIANCE', s.closed_at, br.name, u.full_name, null, null, s.id, s.variance::text, coalesce(s.variance_note, 'tanpa keterangan')
          from cashier_shift s join branch br on br.id = s.branch_id join app_user u on u.id = s.cashier_id
         where s.status <> 'OPEN' and abs(s.variance) > ${c.tol}::numeric and ${inRange(sql`s.closed_at`)}
        union all
        select 'CASH_AFTER_QRIS', x.last_at, br.name, null, i.id, i.invoice_no, null, (x.total - i.patient_portion)::text,
               'Tunai ' || x.cash || ' + QRIS ' || x.qris || ' untuk porsi pasien ' || i.patient_portion
          from invoice i join branch br on br.id = i.branch_id
          cross join lateral (select sum(p.amount) as total, max(p.received_at) as last_at,
                                     sum(p.amount) filter (where p.method = 'TUNAI') as cash, sum(p.amount) filter (where p.method = 'QRIS') as qris
                                from payment p where p.invoice_id = i.id) x
         where x.cash > 0 and x.qris > 0 and x.total > i.patient_portion and ${inRange(sql`x.last_at`)}
        order by 2, 1`);
      return {
        from, to, thresholds: { billingHoursStart: c.start, billingHoursEnd: c.end, voidsPerShiftLimit: c.voids, cashVarianceTolerance: c.tol },
        counts: Object.fromEntries((Object.keys(ANOMALY_RULES) as Rule[]).map((k) => [k, items.filter((x) => x.rule === k).length])),
        items: items.map((x) => ({ rule: x.rule, label: ANOMALY_RULES[x.rule], at: x.at, branchName: x.branch_name, userName: x.user_name, invoiceId: x.invoice_id,
          invoiceNo: x.invoice_no, shiftId: x.shift_id, amount: x.amount, detail: x.detail })),
      };
    });
    if (format !== 'csv') return out;
    const esc = (v: unknown) => { const t = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const csv = ['jenis,waktu,cabang,petugas,tagihan,nominal,keterangan',
      ...out.items.map((x) => [x.label, x.at, x.branchName, x.userName, x.invoiceNo, x.amount, x.detail].map(esc).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transaksi-tidak-wajar-${from}-${to}.csv"`);
    return `\uFEFF${csv}`;
  }

  private async receivableView(tx: Tx, id: string) {
    const [r] = await rows<{ id: string; invoice_id: string; invoice_no: string; payer_id: string; payer_name: string; patient_name: string | null; mrn: string | null;
                             amount: string; paid_amount: string; due_date: string; status: string; overdue: boolean; branch_name: string }>(tx, sql`
      select r.id, r.invoice_id, i.invoice_no, r.payer_id, py.name as payer_name, pt.full_name as patient_name, pt.mrn, r.amount::text, r.paid_amount::text,
             to_char(r.due_date, 'YYYY-MM-DD') as due_date, r.status, br.name as branch_name,
             (r.status in ('OPEN', 'PARTIAL') and r.due_date < (now() at time zone br.timezone)::date) as overdue
        from receivable r join invoice i on i.id = r.invoice_id join branch br on br.id = i.branch_id join payer py on py.id = r.payer_id
        left join patient pt on pt.id = i.patient_id where r.id = ${id}`);
    if (!r) throw problem(404, ...RCV_NOT_FOUND);
    const pays = await rows<{ id: string; amount: string; paid_on: string; method: string; reference: string; note: string | null; recorded_by_name: string;
                              recorded_at: string }>(tx, sql`
      select p.id, p.amount::text, to_char(p.paid_on, 'YYYY-MM-DD') as paid_on, p.method, p.reference, p.note, u.full_name as recorded_by_name, p.recorded_at
        from receivable_payment p join app_user u on u.id = p.recorded_by where p.receivable_id = ${id} order by p.recorded_at`);
    return { id: r.id, invoiceId: r.invoice_id, invoiceNo: r.invoice_no, branchName: r.branch_name, payerId: r.payer_id, payerName: r.payer_name,
      patient: r.patient_name ? { name: r.patient_name, mrn: r.mrn } : null, amount: r.amount, paidAmount: r.paid_amount,
      balance: (Number(r.amount) - Number(r.paid_amount)).toFixed(2), dueDate: r.due_date, status: r.status, overdue: r.overdue,
      payments: pays.map((p) => ({ id: p.id, amount: p.amount, paidOn: p.paid_on, method: p.method, reference: p.reference, note: p.note,
        recordedByName: p.recorded_by_name, recordedAt: p.recorded_at })) };
  }
}

async function tolerance(tx: Tx): Promise<number> {
  const [{ tol }] = await rows<{ tol: number }>(tx, sql`
    select coalesce((settings->>'cashVarianceTolerance')::numeric, 10000)::float as tol from tenant where id = app.current_tenant_id()`);
  return tol;
}
