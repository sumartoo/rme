import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { BodySchema, RequirePermission, Uuid, assertId, ctx, optText, problem } from '@clinicrme/shared';
import { renderPdf } from '@clinicrme/shared/pdf';
import { Db, type Tx, audit, idempotent, rows } from '@clinicrme/db';
import { INV_NOT_FOUND, invoiceHead } from './invoice.repo';
import { type PaymentRow, assertNoVoidPending, paymentDto, settleInvoice } from './payment.repo';

const Money = z.number().min(0).max(1_000_000_000).transform((n) => Math.round(n * 100) / 100);
const PaymentBody = z.object({
  method: z.enum(['TUNAI', 'DEBIT', 'KARTU_KREDIT', 'TRANSFER']),
  amount: Money.refine((n) => n > 0, 'Nominal harus lebih dari 0'),
  cashTendered: Money.optional(),
  reference: optText(100),
}).strict();
const ShiftOpenBody = z.object({ branchId: Uuid.optional(), openingCash: Money }).strict();
const ShiftCloseBody = z.object({
  countedCash: Money,
  varianceNote: optText(300),
  denominations: z.record(z.string().regex(/^\d{1,9}$/), z.number().int().min(0).max(100_000)).optional(),
}).strict();
const ReceivableQuery = z.object({ status: z.enum(['OPEN', 'PARTIAL', 'PAID', 'WRITTEN_OFF']).optional(), payerId: Uuid.optional(),
  branchId: Uuid.optional(), overdue: z.enum(['true', 'false']).optional() });
const METHOD_LABEL: Record<string, string> = { TUNAI: 'Tunai', DEBIT: 'Kartu debit', KARTU_KREDIT: 'Kartu kredit', TRANSFER: 'Transfer', QRIS: 'QRIS' };
const rp = (v: string | number) => `Rp ${Number(v).toLocaleString('id-ID', { maximumFractionDigits: 2 })}`;
const SHIFT_NOT_FOUND = ['BIL-404-SHIFT', 'Shift kasir tidak ditemukan'] as const;

/**
 * Pembayaran & shift kasir (Stage 11 batch 2): BIL-FR-005, 007, 008, 011, 013 (pembentukan piutang).
 * Pembayaran append-only & idempoten (Idempotency-Key), hanya pada shift terbuka milik kasir di cabang tagihan (OD-111).
 */
@Controller('api/v1')
export class PaymentController {
  constructor(private readonly db: Db) {}

  /** Bayar tunai (kembalian) / debit / kartu / transfer (wajib referensi); boleh sebagian & beberapa metode (BIL-FR-005/007). */
  @RequirePermission('billing.payment.create') @BodySchema(PaymentBody) @Post('invoices/:id/payments') @HttpCode(201)
  async pay(@Param('id') id: string, @Body() b: z.infer<typeof PaymentBody>, @Headers('idempotency-key') key: string | undefined) {
    assertId(id, ...INV_NOT_FOUND);
    return this.db.withTenantTx((tx) => idempotent(tx, 'payment.create', key, { id, ...b }, async () => {
      const h = await invoiceHead(tx, id, true);
      if (h.status !== 'ISSUED' && h.status !== 'PARTIALLY_PAID') {
        throw problem(409, 'BIL-409-NOT-PAYABLE', h.status === 'PAID' ? 'Tagihan sudah lunas' : 'Tagihan belum diterbitkan atau sudah dibatalkan');
      }
      await assertNoVoidPending(tx, id);
      const [s] = await rows<{ id: string }>(tx, sql`
        select id from cashier_shift where cashier_id = ${ctx().userId} and status = 'OPEN' and branch_id = ${h.branch_id} for update`);
      if (!s) throw problem(409, 'BIL-409-NO-SHIFT', 'Buka shift kasir di cabang tagihan ini sebelum menerima pembayaran');
      const [o] = await rows<{ outstanding: string }>(tx, sql`select (patient_portion - paid_amount)::text as outstanding from invoice where id = ${id}`);
      if (b.amount > Number(o.outstanding) + 0.001) {
        throw problem(409, 'BIL-409-OVERPAY', `Nominal melebihi sisa tagihan (${rp(o.outstanding)})`);
      }
      const reference = b.reference?.trim() || null;
      if (b.method !== 'TUNAI' && (reference ?? '').length < 3) throw problem(400, 'BIL-400-REFERENCE', 'Nomor referensi wajib untuk pembayaran non-tunai');
      let tendered: number | null = null;
      if (b.method === 'TUNAI') {
        tendered = b.cashTendered ?? b.amount;
        if (tendered < b.amount) throw problem(400, 'BIL-400-TENDERED', 'Uang diterima kurang dari nominal pembayaran');
      }
      const [{ no }] = await rows<{ no: string }>(tx, sql`select app.next_document_number('RECEIPT', 'TENANT', 'KW{YYYY}{MM}{SEQ:6}') as no`);
      const [p] = await rows<{ id: string }>(tx, sql`
        insert into payment(tenant_id, receipt_no, invoice_id, shift_id, method, amount, cash_tendered, reference, idempotency_key, received_by)
        values (app.current_tenant_id(), ${no}, ${id}, ${s.id}, ${b.method}, ${b.amount.toFixed(2)}::numeric,
                ${tendered === null ? null : tendered.toFixed(2)}::numeric, ${b.method === 'TUNAI' ? null : reference}, ${key}, ${ctx().userId})
        returning id`);
      const status = await settleInvoice(tx, id);
      await audit(tx, 'PAYMENT_RECORDED', 'payment', p.id, h.patient_id, { receiptNo: no, invoiceNo: h.invoice_no, method: b.method, amount: b.amount, invoiceStatus: status });
      return { ...paymentDto(await this.payment(tx, p.id)), invoiceStatus: status };
    }));
  }

  /** Kwitansi PDF 80 mm untuk printer thermal dari peramban (OD-109). */
  @RequirePermission('billing.invoice.read') @Get('payments/:id/receipt')
  async receipt(@Param('id') id: string, @Res() res: Response) {
    assertId(id, 'BIL-404-PAYMENT', 'Pembayaran tidak ditemukan');
    const { buf, name } = await this.db.withTenantTx(async (tx) => {
      const p = await this.payment(tx, id);
      const [i] = await rows<{ invoice_no: string; patient_name: string | null; mrn: string | null; customer_name: string | null; net_amount: string;
                               payer_portion: string; patient_portion: string; paid_amount: string; status: string; patient_id: string | null; branch_name: string }>(tx, sql`
        select i.invoice_no, pt.full_name as patient_name, pt.mrn, coalesce(i.customer_name, o.customer_name) as customer_name, i.net_amount::text,
               i.payer_portion::text, i.patient_portion::text, i.paid_amount::text, i.status, i.patient_id, br.name as branch_name
          from payment pm join invoice i on i.id = pm.invoice_id join branch br on br.id = i.branch_id
          left join patient pt on pt.id = i.patient_id left join otc_sale o on o.id = i.otc_sale_id where pm.id = ${id}`);
      const lines = await rows<{ description: string; qty: string; line_total: string }>(tx, sql`
        select l.description, trim_scale(l.qty)::text as qty, l.line_total::text from invoice_line l join payment pm on pm.invoice_id = l.invoice_id
         where pm.id = ${id} order by l.line_no`);
      const [t] = await rows<{ name: string; address: string | null; phone: string | null }>(tx, sql`
        select coalesce(nullif(letterhead->>'name', ''), display_name) as name, letterhead->>'address' as address, letterhead->>'phone' as phone
          from tenant where id = app.current_tenant_id()`);
      const row = (a: string, b: string, bold = false) => ({ columns: [{ text: a, bold }, { text: b, alignment: 'right', bold, width: 'auto' }] });
      const sep = { canvas: [{ type: 'line', x1: 0, y1: 2, x2: 198, y2: 2, lineWidth: 0.5, dash: { length: 2 } }], margin: [0, 2, 0, 4] };
      const body = [
        { text: t.name, bold: true, alignment: 'center', fontSize: 10 },
        { text: [t.address, t.phone ? `Telp. ${t.phone}` : null].filter(Boolean).join(' · '), alignment: 'center', fontSize: 7 },
        { text: `KWITANSI ${p.receipt_no}`, bold: true, alignment: 'center', margin: [0, 6, 0, 2] },
        { text: [`Tagihan ${i.invoice_no}`, i.branch_name].join(' · '), alignment: 'center', fontSize: 7 },
        { text: i.patient_name ? `${i.patient_name} · RM ${i.mrn}` : i.customer_name ?? 'Pembeli umum', alignment: 'center', fontSize: 7, margin: [0, 0, 0, 4] },
        sep,
        ...lines.map((l) => row(`${l.description}${Number(l.qty) !== 1 ? ` ×${l.qty}` : ''}`, rp(l.line_total))),
        sep,
        row('Total tagihan', rp(i.net_amount)),
        ...(Number(i.payer_portion) ? [row('Ditanggung penjamin', rp(i.payer_portion))] : []),
        row('Bagian pasien', rp(i.patient_portion), true),
        sep,
        row(`Dibayar (${METHOD_LABEL[p.method] ?? p.method})`, rp(p.amount), true),
        ...(p.cash_tendered !== null ? [row('Uang diterima', rp(p.cash_tendered)), row('Kembalian', rp(Number(p.cash_tendered) - Number(p.amount)))] : []),
        ...(p.reference ? [row('Referensi', p.reference)] : []),
        row('Total terbayar', rp(i.paid_amount)),
        row('Sisa', rp(Math.max(0, Number(i.patient_portion) - Number(i.paid_amount))), true),
        sep,
        { text: `Kasir: ${p.received_by_name}`, fontSize: 7 },
        { text: new Date(p.received_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }), fontSize: 7 },
        { text: 'Harga sudah final. Terima kasih.', alignment: 'center', fontSize: 7, margin: [0, 6, 0, 0] },
      ];
      const buf = await renderPdf(body, { title: `Kwitansi ${p.receipt_no}`, issuedAt: new Date(p.received_at),
        pageSize: { width: 226.77, height: 'auto' }, pageMargins: [14, 12, 14, 12], fontSize: 8 });
      await audit(tx, 'RECEIPT_VIEWED', 'payment', id, i.patient_id, { receiptNo: p.receipt_no });
      return { buf, name: p.receipt_no };
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="kwitansi-${name}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  }

  /** Buka shift dengan kas awal (OD-111): satu shift terbuka per kasir; cabang = cabang aktif atau yang dipilih. */
  @RequirePermission('billing.shift.manage') @BodySchema(ShiftOpenBody) @Post('cashier-shifts') @HttpCode(201)
  async open(@Body() b: z.infer<typeof ShiftOpenBody>) {
    const c = ctx();
    const branchId = b.branchId ?? c.branchId ?? null;
    if (!branchId) throw problem(400, 'BIL-400-BRANCH', 'Pilih cabang untuk shift kasir');
    return this.db.withTenantTx(async (tx) => {
      const [ok] = await rows(tx, sql`
        select 1 from branch br where br.id = ${branchId} and br.is_active
           and exists (select 1 from user_role_assignment a where a.user_id = ${c.userId}
                        and (a.valid_to is null or a.valid_to > now()) and (a.branch_id is null or a.branch_id = br.id))`);
      if (!ok) throw problem(403, 'IAM-403-BRANCH', 'Anda tidak ditugaskan di cabang ini');
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`shift:${c.userId}`}, 0))`);
      const [cur] = await rows<{ id: string }>(tx, sql`select id from cashier_shift where cashier_id = ${c.userId} and status = 'OPEN'`);
      if (cur) throw problem(409, 'BIL-409-SHIFT-OPEN', 'Anda masih punya shift terbuka; tutup dulu sebelum membuka shift baru');
      const [s] = await rows<{ id: string }>(tx, sql`
        insert into cashier_shift(tenant_id, branch_id, cashier_id, opening_cash) values (app.current_tenant_id(), ${branchId}, ${c.userId}, ${b.openingCash.toFixed(2)}::numeric)
        returning id`);
      await audit(tx, 'SHIFT_OPENED', 'cashier_shift', s.id, null, { branchId, openingCash: b.openingCash });
      return this.shift(tx, s.id);
    });
  }

  /** Shift terbuka milik saya + total per metode & kas yang diharapkan; `shift: null` bila belum ada. */
  @RequirePermission('billing.shift.manage') @Get('cashier-shifts/current')
  async current() {
    return this.db.withTenantTx(async (tx) => {
      const [s] = await rows<{ id: string }>(tx, sql`select id from cashier_shift where cashier_id = ${ctx().userId} and status = 'OPEN'`);
      return { shift: s ? await this.shift(tx, s.id) : null };
    });
  }

  /**
   * Tutup shift (AC-BIL-FR-011-2): kas yang diharapkan = kas awal + tunai diterima − refund tunai disetujui; selisih di atas
   * toleransi klinik (bawaan Rp 10.000, OD-041) wajib keterangan. Hanya pemilik shift (penutupan oleh manajer di batch 4).
   */
  @RequirePermission('billing.shift.manage') @BodySchema(ShiftCloseBody) @Post('cashier-shifts/:id/close') @HttpCode(200)
  async close(@Param('id') id: string, @Body() b: z.infer<typeof ShiftCloseBody>) {
    assertId(id, ...SHIFT_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const [s] = await rows<{ cashier_id: string; status: string }>(tx, sql`select cashier_id, status from cashier_shift where id = ${id} for update`);
      if (!s) throw problem(404, ...SHIFT_NOT_FOUND);
      if (s.cashier_id !== ctx().userId) throw problem(403, 'BIL-403-SHIFT-OWNER', 'Shift hanya dapat ditutup oleh kasir pemiliknya');
      if (s.status !== 'OPEN') throw problem(409, 'BIL-409-SHIFT-CLOSED', 'Shift sudah ditutup');
      const v = await this.shift(tx, id);
      const variance = Math.round((b.countedCash - Number(v.expectedCash)) * 100) / 100;
      const [{ tol }] = await rows<{ tol: number }>(tx, sql`
        select coalesce((settings->>'cashVarianceTolerance')::numeric, 10000)::float as tol from tenant where id = app.current_tenant_id()`);
      const note = b.varianceNote?.trim() || null;
      if (Math.abs(variance) > tol + 1e-9 && (note ?? '').length < 5) {
        throw problem(400, 'BIL-400-VARIANCE-NOTE', `Selisih kas ${rp(variance)} melebihi toleransi ${rp(tol)}; isi keterangan`);
      }
      await tx.execute(sql`
        update cashier_shift set status = 'CLOSED', closed_at = now(), closed_by = ${ctx().userId}, counted_cash = ${b.countedCash.toFixed(2)}::numeric,
               expected_cash = ${v.expectedCash}::numeric, variance_note = ${note}, denominations = ${b.denominations ? JSON.stringify(b.denominations) : null}::jsonb
         where id = ${id}`);
      await audit(tx, 'SHIFT_CLOSED', 'cashier_shift', id, null, { expectedCash: v.expectedCash, countedCash: b.countedCash, variance, overTolerance: Math.abs(variance) > tol });
      return this.shift(tx, id);
    });
  }

  /** Piutang porsi penjamin (BIL-FR-013): saldo per tagihan, jatuh tempo, terlambat. Pelunasan di batch 4. */
  @RequirePermission('billing.receivable.read') @Get('receivables')
  async receivables(@Query() query: Record<string, string | undefined>) {
    const P = ReceivableQuery.safeParse(query);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const f = P.data;
    return this.db.withTenantTx(async (tx) => {
      const r = await rows<{ id: string; invoice_id: string; invoice_no: string; branch_name: string; patient_name: string | null; mrn: string | null;
                             payer_id: string; payer_name: string; amount: string; paid_amount: string; due_date: string; status: string; overdue: boolean;
                             created_at: string }>(tx, sql`
        select r.id, r.invoice_id, i.invoice_no, br.name as branch_name, pt.full_name as patient_name, pt.mrn, r.payer_id, py.name as payer_name,
               r.amount::text, r.paid_amount::text, to_char(r.due_date, 'YYYY-MM-DD') as due_date, r.status,
               (r.status in ('OPEN', 'PARTIAL') and r.due_date < (now() at time zone br.timezone)::date) as overdue, r.created_at
          from receivable r join invoice i on i.id = r.invoice_id join branch br on br.id = i.branch_id join payer py on py.id = r.payer_id
          left join patient pt on pt.id = i.patient_id
         where (${f.status ?? null}::text is null or r.status = ${f.status ?? null}::text)
           and (${f.payerId ?? null}::uuid is null or r.payer_id = ${f.payerId ?? null}::uuid)
           and (${f.branchId ?? null}::uuid is null or i.branch_id = ${f.branchId ?? null}::uuid)
           and (${f.overdue === 'true'} = false or (r.status in ('OPEN', 'PARTIAL') and r.due_date < (now() at time zone br.timezone)::date))
         order by r.due_date, r.created_at limit 500`);
      return r.map((x) => ({ id: x.id, invoiceId: x.invoice_id, invoiceNo: x.invoice_no, branchName: x.branch_name,
        patient: x.patient_name ? { name: x.patient_name, mrn: x.mrn } : null, payerId: x.payer_id, payerName: x.payer_name, amount: x.amount,
        paidAmount: x.paid_amount, balance: (Number(x.amount) - Number(x.paid_amount)).toFixed(2), dueDate: x.due_date, status: x.status, overdue: x.overdue,
        createdAt: x.created_at }));
    });
  }

  private async payment(tx: Tx, id: string): Promise<PaymentRow> {
    const [p] = await rows<PaymentRow>(tx, sql`
      select p.id, p.receipt_no, p.method, p.amount::text, p.cash_tendered::text, p.reference, p.received_at, u.full_name as received_by_name
        from payment p join app_user u on u.id = p.received_by where p.id = ${id}`);
    if (!p) throw problem(404, 'BIL-404-PAYMENT', 'Pembayaran tidak ditemukan');
    return p;
  }

  private async shift(tx: Tx, id: string) {
    const [s] = await rows<{ id: string; status: string; branch_id: string; branch_name: string; cashier_name: string; opened_at: string; closed_at: string | null;
                             opening_cash: string; counted_cash: string | null; expected_cash: string | null; variance: string | null; variance_note: string | null;
                             cash_in: string; cash_refund: string }>(tx, sql`
      select s.id, s.status, s.branch_id, br.name as branch_name, u.full_name as cashier_name, s.opened_at, s.closed_at, s.opening_cash::text,
             s.counted_cash::text, s.expected_cash::text, s.variance::text, s.variance_note,
             coalesce((select sum(p.amount) from payment p where p.shift_id = s.id and p.method = 'TUNAI'), 0)::text as cash_in,
             coalesce((select sum(r.amount) from refund r where r.shift_id = s.id and r.method = 'TUNAI' and r.status = 'APPROVED'), 0)::text as cash_refund
        from cashier_shift s join branch br on br.id = s.branch_id join app_user u on u.id = s.cashier_id where s.id = ${id}`);
    if (!s) throw problem(404, ...SHIFT_NOT_FOUND);
    const totals = await rows<{ method: string; n: number; total: string }>(tx, sql`
      select method, count(*)::int as n, sum(amount)::text as total from payment where shift_id = ${id} group by method order by method`);
    // OD-111: kas awal + tunai diterima − refund tunai disetujui di shift ini
    const expected = s.expected_cash ?? (Number(s.opening_cash) + Number(s.cash_in) - Number(s.cash_refund)).toFixed(2);
    return {
      id: s.id, status: s.status, branchId: s.branch_id, branchName: s.branch_name, cashierName: s.cashier_name, openedAt: s.opened_at, closedAt: s.closed_at,
      openingCash: s.opening_cash, expectedCash: expected, countedCash: s.counted_cash, variance: s.variance, varianceNote: s.variance_note,
      totals: totals.map((t) => ({ method: t.method, count: t.n, total: t.total })),
      paymentCount: totals.reduce((n, t) => n + t.n, 0), cashRefunds: s.cash_refund,
    };
  }
}
