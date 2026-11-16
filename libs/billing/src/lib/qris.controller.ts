import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { BodySchema, CONFIG, Public, RequirePermission, assertId, ctx, problem, type AppConfig } from '@clinicrme/shared';
import { Db, type Tx, audit, idempotent, rows } from '@clinicrme/db';
import { PAYMENT_GATEWAY, type PaymentGateway, SimulatorCallback, SimulatorGateway, parseSettlementCsv } from './gateway';
import { INV_NOT_FOUND, invoiceHead } from './invoice.repo';
import { assertNoVoidPending, billingAudit, settleInvoice } from './payment.repo';

const QrisBody = z.object({ amount: z.number().positive().max(1_000_000_000).transform((n) => Math.round(n * 100) / 100).optional() }).strict();
const SimulateBody = z.object({ outcome: z.enum(['PAID', 'EXPIRED', 'FAILED']) }).strict();
const SettlementBody = z.object({
  settlementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fileName: z.string().max(200).optional(),
  csv: z.string().min(1).max(2_000_000),
}).strict();
const DateQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), branchId: z.string().uuid().optional() });
const QRIS_NOT_FOUND = ['BIL-404-QRIS', 'Transaksi QRIS tidak ditemukan'] as const;

interface TxnRow { id: string; invoice_id: string; provider: string; provider_ref: string | null; amount: string; qr_payload: string | null; status: string;
  expires_at: string; payment_id: string | null; created_by: string | null; shift_id: string | null; paid_at: string | null; callback_count: number;
  settled: boolean; invoice_status?: string }

/**
 * QRIS dinamis (BIL-FR-006, OD-039): QR dibuat lewat adapter; pembayaran **hanya** tercatat setelah callback ber-signature
 * terverifikasi. Callback ganda tidak mencatat ganda (kunci `qris:<txn>` + kunci baris). Rekonsiliasi harian dengan berkas
 * settlement (BIL-FR-012).
 */
@Controller()
export class QrisController {
  constructor(private readonly db: Db, @Inject(PAYMENT_GATEWAY) private readonly gw: PaymentGateway, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  /** Buat QR untuk sisa tagihan (atau nominal tertentu ≤ sisa); QR menunggu sebelumnya dibatalkan. Butuh shift terbuka. */
  @RequirePermission('billing.payment.create') @BodySchema(QrisBody) @Post('api/v1/invoices/:id/qris') @HttpCode(201)
  async create(@Param('id') id: string, @Body() b: z.infer<typeof QrisBody>, @Headers('idempotency-key') key: string | undefined) {
    assertId(id, ...INV_NOT_FOUND);
    return this.db.withTenantTx((tx) => idempotent(tx, 'qris.create', key, { id, ...b }, async () => {
      const h = await invoiceHead(tx, id, true);
      if (h.status !== 'ISSUED' && h.status !== 'PARTIALLY_PAID') throw problem(409, 'BIL-409-NOT-PAYABLE', 'Tagihan tidak dalam status dapat dibayar');
      await assertNoVoidPending(tx, id);
      const [s] = await rows<{ id: string }>(tx, sql`
        select id from cashier_shift where cashier_id = ${ctx().userId} and status = 'OPEN' and branch_id = ${h.branch_id}`);
      if (!s) throw problem(409, 'BIL-409-NO-SHIFT', 'Buka shift kasir di cabang tagihan ini sebelum menerima pembayaran');
      const [o] = await rows<{ outstanding: string }>(tx, sql`select (patient_portion - paid_amount)::text as outstanding from invoice where id = ${id}`);
      const amount = b.amount ?? Number(o.outstanding);
      if (amount <= 0 || amount > Number(o.outstanding) + 0.001) throw problem(409, 'BIL-409-OVERPAY', 'Nominal QR harus lebih dari 0 dan tidak melebihi sisa tagihan');
      await tx.execute(sql`update payment_gateway_txn set status = 'CANCELLED' where invoice_id = ${id} and status = 'PENDING'`);
      const expiresAt = new Date(Date.now() + this.cfg.paymentGateway.qrisExpiryMinutes * 60_000);
      const [t] = await rows<{ id: string }>(tx, sql`
        insert into payment_gateway_txn(tenant_id, invoice_id, provider, amount, expires_at, created_by, shift_id)
        values (app.current_tenant_id(), ${id}, ${this.gw.provider}, ${amount.toFixed(2)}::numeric, ${expiresAt.toISOString()}::timestamptz, ${ctx().userId}, ${s.id})
        returning id`);
      const c = await this.gw.createCharge({ orderRef: t.id, amount, expiresAt });
      await tx.execute(sql`update payment_gateway_txn set provider_ref = ${c.providerRef}, qr_payload = ${c.qrPayload} where id = ${t.id}`);
      await audit(tx, 'QRIS_CREATED', 'payment_gateway_txn', t.id, h.patient_id, { invoiceNo: h.invoice_no, amount, providerRef: c.providerRef });
      return this.view(await this.txn(tx, t.id));
    }));
  }

  /** Status QR untuk polling layar kasir; QR yang lewat batas waktu ditandai kedaluwarsa. */
  @RequirePermission('billing.payment.create') @Get('api/v1/qris/:id')
  async get(@Param('id') id: string) {
    assertId(id, ...QRIS_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      await tx.execute(sql`update payment_gateway_txn set status = 'EXPIRED' where id = ${id} and status = 'PENDING' and expires_at < now()`);
      return this.view(await this.txn(tx, id));
    });
  }

  /**
   * Callback penyedia (publik, per host klinik). Signature salah → 401 tanpa efek. Event PAID mencatat pembayaran QRIS
   * ke shift pembuat QR (atau shift terbuka kasir itu di cabang tagihan); event ulang → 200 tanpa pembayaran baru.
   */
  @Public() @BodySchema(SimulatorCallback) @Post('api/integrations/payment-gateway/callback') @HttpCode(200)
  async callback(@Req() req: Request & { rawBody?: Buffer }) {
    const tenantId = ctx().hostTenantId;
    if (!tenantId) throw problem(404, 'GEN-404', 'Tidak ditemukan');
    return this.process(tenantId, req.rawBody ?? Buffer.alloc(0), req.headers);
  }

  /** Simulator saja: kasir/penguji "membayar" QR — callback ditandatangani lalu diproses lewat jalur yang sama. */
  @RequirePermission('billing.payment.create') @BodySchema(SimulateBody) @Post('api/v1/qris/:id/simulate') @HttpCode(200)
  async simulate(@Param('id') id: string, @Body() b: z.infer<typeof SimulateBody>) {
    assertId(id, ...QRIS_NOT_FOUND);
    if (!(this.gw instanceof SimulatorGateway)) throw problem(404, 'GEN-404', 'Tidak ditemukan');
    const t = await this.db.withTenantTx((tx) => this.txn(tx, id));
    if (!t.provider_ref) throw problem(409, 'BIL-409-QRIS', 'QR belum siap');
    const raw = Buffer.from(JSON.stringify({ eventId: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, providerRef: t.provider_ref,
      status: b.outcome, amount: Number(t.amount), ...(b.outcome === 'PAID' ? { paidAt: new Date().toISOString() } : {}) }));
    await this.process(ctx().tenantId as string, raw, { 'x-signature': this.gw.sign(raw) });
    return this.db.withTenantTx(async (tx) => this.view(await this.txn(tx, id)));
  }

  /** Unggah berkas settlement CSV (`provider_ref,amount,settled_at`) — baris dicocokkan ke transaksi tercatat. */
  @RequirePermission('billing.reconcile') @BodySchema(SettlementBody) @Post('api/v1/billing/qris-settlements') @HttpCode(201)
  async upload(@Body() b: z.infer<typeof SettlementBody>) {
    let lines: ReturnType<typeof parseSettlementCsv>;
    try { lines = parseSettlementCsv(b.csv); } catch (e) { throw problem(400, 'BIL-400-SETTLEMENT', (e as Error).message); }
    if (lines.length > 20_000) throw problem(400, 'BIL-400-SETTLEMENT', 'Maksimal 20.000 baris per berkas');
    return this.db.withTenantTx(async (tx) => {
      const total = lines.reduce((n, l) => n + l.amount, 0);
      const [bt] = await rows<{ id: string }>(tx, sql`
        insert into qris_settlement_batch(tenant_id, provider, settlement_date, file_name, line_count, total, uploaded_by)
        values (app.current_tenant_id(), ${this.gw.provider}, ${b.settlementDate}::date, ${b.fileName ?? null}, ${lines.length}, ${total.toFixed(2)}::numeric, ${ctx().userId})
        returning id`);
      let matched = 0;
      for (const l of lines) {
        const [t] = await rows<{ id: string }>(tx, sql`
          select id from payment_gateway_txn where provider = ${this.gw.provider} and provider_ref = ${l.providerRef}`);
        await tx.execute(sql`insert into qris_settlement_line(tenant_id, batch_id, provider_ref, amount, settled_at, txn_id)
          values (app.current_tenant_id(), ${bt.id}, ${l.providerRef}, ${l.amount.toFixed(2)}::numeric, ${l.settledAt}::timestamptz, ${t?.id ?? null})`);
        if (t) { matched++; await tx.execute(sql`update payment_gateway_txn set settled = true, settlement_ref = ${bt.id} where id = ${t.id}`); }
      }
      await audit(tx, 'QRIS_SETTLEMENT_UPLOADED', 'qris_settlement_batch', bt.id, null, { settlementDate: b.settlementDate, lines: lines.length, matched });
      return { id: bt.id, settlementDate: b.settlementDate, lineCount: lines.length, matched, total: total.toFixed(2) };
    });
  }

  /**
   * Rekonsiliasi harian (AC-BIL-FR-012-1): QRIS lunas di sistem pada tanggal itu (zona cabang) tanpa baris settlement,
   * baris settlement tanpa transaksi lunas, nominal berbeda, dan lunas tanpa pembayaran tercatat (mis. shift sudah ditutup).
   */
  @RequirePermission('billing.reconcile') @Get('api/v1/billing/reconciliation/qris')
  async reconcile(@Query() q: Record<string, string | undefined>) {
    const P = DateQuery.safeParse(q);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tanggal tidak valid');
    const { date, branchId } = P.data;
    return this.db.withTenantTx(async (tx) => {
      const r = await rows<{ issue: string; txn_id: string | null; provider_ref: string; invoice_id: string | null; invoice_no: string | null; system_amount: string | null;
                             settled_amount: string | null; paid_at: string | null; payment_id: string | null }>(tx, sql`
        with paid as (
          select t.*, i.invoice_no, i.branch_id from payment_gateway_txn t join invoice i on i.id = t.invoice_id join branch br on br.id = i.branch_id
           where t.status = 'PAID' and (t.paid_at at time zone br.timezone)::date = ${date}::date
             and (${branchId ?? null}::uuid is null or i.branch_id = ${branchId ?? null}::uuid)),
        sl as (
          select l.*, t.status as txn_status, t.amount as txn_amount, t.invoice_id, i.invoice_no, t.payment_id, t.paid_at, i.branch_id
            from qris_settlement_line l join qris_settlement_batch b on b.id = l.batch_id
            left join payment_gateway_txn t on t.id = l.txn_id left join invoice i on i.id = t.invoice_id
           where b.settlement_date = ${date}::date and (${branchId ?? null}::uuid is null or i.branch_id is null or i.branch_id = ${branchId ?? null}::uuid))
        select 'PAID_NOT_SETTLED' as issue, p.id as txn_id, p.provider_ref, p.invoice_id, p.invoice_no, p.amount::text as system_amount, null::text as settled_amount,
               p.paid_at, p.payment_id
          from paid p where not exists (select 1 from qris_settlement_line l where l.txn_id = p.id)
        union all
        select case when sl.txn_id is null or sl.txn_status <> 'PAID' then 'SETTLED_NOT_PAID' else 'AMOUNT_MISMATCH' end, sl.txn_id, sl.provider_ref, sl.invoice_id,
               sl.invoice_no, sl.txn_amount::text, sl.amount::text, sl.paid_at, sl.payment_id
          from sl where sl.txn_id is null or sl.txn_status <> 'PAID' or sl.amount <> sl.txn_amount
        union all
        select 'PAID_WITHOUT_PAYMENT', p.id, p.provider_ref, p.invoice_id, p.invoice_no, p.amount::text, null, p.paid_at, null
          from paid p where p.payment_id is null
        order by 1, 3`);
      const [sum] = await rows<{ paid_count: number; paid_total: string; settled_count: number; settled_total: string; batches: number }>(tx, sql`
        select (select count(*)::int from payment_gateway_txn t join invoice i on i.id = t.invoice_id join branch br on br.id = i.branch_id
                 where t.status = 'PAID' and (t.paid_at at time zone br.timezone)::date = ${date}::date
                   and (${branchId ?? null}::uuid is null or i.branch_id = ${branchId ?? null}::uuid)) as paid_count,
               (select coalesce(sum(t.amount), 0)::text from payment_gateway_txn t join invoice i on i.id = t.invoice_id join branch br on br.id = i.branch_id
                 where t.status = 'PAID' and (t.paid_at at time zone br.timezone)::date = ${date}::date
                   and (${branchId ?? null}::uuid is null or i.branch_id = ${branchId ?? null}::uuid)) as paid_total,
               (select count(*)::int from qris_settlement_line l join qris_settlement_batch b on b.id = l.batch_id where b.settlement_date = ${date}::date) as settled_count,
               (select coalesce(sum(l.amount), 0)::text from qris_settlement_line l join qris_settlement_batch b on b.id = l.batch_id where b.settlement_date = ${date}::date) as settled_total,
               (select count(*)::int from qris_settlement_batch where settlement_date = ${date}::date) as batches`);
      return {
        date, paidCount: sum.paid_count, paidTotal: sum.paid_total, settledCount: sum.settled_count, settledTotal: sum.settled_total, batches: sum.batches,
        issues: r.map((x) => ({ issue: x.issue, txnId: x.txn_id, providerRef: x.provider_ref, invoiceId: x.invoice_id, invoiceNo: x.invoice_no,
          systemAmount: x.system_amount, settledAmount: x.settled_amount, paidAt: x.paid_at })),
      };
    });
  }

  /** Simulator saja: berkas settlement CSV untuk QRIS lunas pada tanggal itu (bahan uji rekonsiliasi). */
  @RequirePermission('billing.reconcile') @Get('api/v1/billing/qris-settlements/simulated')
  async simulatedSettlement(@Query() q: Record<string, string | undefined>) {
    if (!(this.gw instanceof SimulatorGateway)) throw problem(404, 'GEN-404', 'Tidak ditemukan');
    const P = DateQuery.safeParse(q);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tanggal tidak valid');
    return this.db.withTenantTx(async (tx) => {
      const r = await rows<{ provider_ref: string; amount: string; paid_at: string }>(tx, sql`
        select t.provider_ref, t.amount::text, to_char(t.paid_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as paid_at
          from payment_gateway_txn t join invoice i on i.id = t.invoice_id join branch br on br.id = i.branch_id
         where t.provider = 'SIMULATOR' and t.status = 'PAID' and (t.paid_at at time zone br.timezone)::date = ${P.data.date}::date order by t.paid_at`);
      return { csv: ['provider_ref,amount,settled_at', ...r.map((x) => `${x.provider_ref},${x.amount},${x.paid_at}`)].join('\n') };
    });
  }

  private async process(tenantId: string, raw: Buffer, headers: Record<string, string | string[] | undefined>) {
    if (!this.gw.verifySignature(raw, headers)) {
      await this.db.withTenant(tenantId, (tx) => billingAudit(tx, 'QRIS_CALLBACK_REJECTED', 'payment_gateway_txn', null, null, { reason: 'SIGNATURE' }));
      throw problem(401, 'BIL-401-SIGNATURE', 'Signature callback tidak valid');
    }
    let body: unknown;
    try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }
    const ev = this.gw.parseCallback(body);
    if (!ev) throw problem(400, 'BIL-400-CALLBACK', 'Payload callback tidak dikenali');
    const out = await this.db.withTenant(tenantId, async (tx) => {
      const [t] = await rows<TxnRow>(tx, sql`
        select t.*, t.amount::text as amount, i.status as invoice_status from payment_gateway_txn t join invoice i on i.id = t.invoice_id
         where t.provider = ${this.gw.provider} and t.provider_ref = ${ev.providerRef} for update of t`);
      if (!t) throw problem(404, ...QRIS_NOT_FOUND);
      await tx.execute(sql`update payment_gateway_txn set callback_count = callback_count + 1, last_callback_at = now(), last_event_id = ${ev.eventId}
                            where id = ${t.id}`);
      if (ev.status !== 'PAID') {
        if (t.status === 'PENDING') await tx.execute(sql`update payment_gateway_txn set status = ${ev.status} where id = ${t.id}`);
        await billingAudit(tx, 'QRIS_CALLBACK', 'payment_gateway_txn', t.id, null, { status: ev.status, eventId: ev.eventId });
        return { ok: true };
      }
      if (t.status === 'PAID') {
        await billingAudit(tx, 'QRIS_CALLBACK_DUPLICATE', 'payment_gateway_txn', t.id, null, { eventId: ev.eventId });
        return { ok: true, duplicate: true };
      }
      if (Math.abs(ev.amount - Number(t.amount)) > 0.001) {
        // Dicatat (commit) lalu ditolak di luar transaksi agar jejak penolakan tidak ikut di-rollback
        await billingAudit(tx, 'QRIS_CALLBACK_REJECTED', 'payment_gateway_txn', t.id, null, { reason: 'AMOUNT', expected: t.amount, got: ev.amount });
        return { ok: false as const, reject: 'AMOUNT' as const };
      }
      const paidAt = ev.paidAt ?? new Date();
      await tx.execute(sql`update payment_gateway_txn set status = 'PAID', paid_at = ${paidAt.toISOString()}::timestamptz where id = ${t.id}`);
      const h = await invoiceHead(tx, t.invoice_id, true);
      // Uang sudah diterima penyedia: dicatat ke shift pembuat QR, atau shift terbuka kasir itu di cabang tagihan
      const [s] = await rows<{ id: string }>(tx, sql`
        select id from cashier_shift where status = 'OPEN' and cashier_id = ${t.created_by} and branch_id = ${h.branch_id}
         order by (id = ${t.shift_id}) desc limit 1`);
      if (!s || h.status === 'VOID' || h.status === 'DRAFT') {
        await billingAudit(tx, 'QRIS_PAID_UNRECORDED', 'payment_gateway_txn', t.id, h.patient_id,
          { invoiceNo: h.invoice_no, reason: !s ? 'NO_OPEN_SHIFT' : 'INVOICE_NOT_PAYABLE', amount: t.amount });
        return { ok: true, recorded: false };
      }
      const [{ no }] = await rows<{ no: string }>(tx, sql`select app.next_document_number('RECEIPT', 'TENANT', 'KW{YYYY}{MM}{SEQ:6}') as no`);
      const [p] = await rows<{ id: string }>(tx, sql`
        insert into payment(tenant_id, receipt_no, invoice_id, shift_id, method, amount, reference, idempotency_key, received_by, received_at)
        values (app.current_tenant_id(), ${no}, ${t.invoice_id}, ${s.id}, 'QRIS', ${t.amount}::numeric, ${ev.providerRef}, ${`qris:${t.id}`}, ${t.created_by},
                ${paidAt.toISOString()}::timestamptz)
        returning id`);
      await tx.execute(sql`update payment_gateway_txn set payment_id = ${p.id} where id = ${t.id}`);
      const overpaid = h.status === 'PAID';
      const status = await settleInvoice(tx, t.invoice_id);
      await billingAudit(tx, 'PAYMENT_RECORDED', 'payment', p.id, h.patient_id,
        { receiptNo: no, invoiceNo: h.invoice_no, method: 'QRIS', amount: Number(t.amount), invoiceStatus: status, overpaid });
      return { ok: true, recorded: true };
    });
    if ('reject' in out) throw problem(409, 'BIL-409-QRIS-AMOUNT', 'Nominal callback tidak sama dengan nominal QR');
    return out;
  }

  private async txn(tx: Tx, id: string): Promise<TxnRow> {
    const [t] = await rows<TxnRow>(tx, sql`
      select t.id, t.invoice_id, t.provider, t.provider_ref, t.amount::text, t.qr_payload, t.status, t.expires_at, t.payment_id, t.created_by, t.shift_id,
             t.paid_at, t.callback_count, t.settled, i.status as invoice_status
        from payment_gateway_txn t join invoice i on i.id = t.invoice_id where t.id = ${id}`);
    if (!t) throw problem(404, ...QRIS_NOT_FOUND);
    return t;
  }

  private view(t: TxnRow) {
    return { id: t.id, invoiceId: t.invoice_id, provider: t.provider, providerRef: t.provider_ref, qrPayload: t.qr_payload, amount: t.amount, status: t.status,
      expiresAt: t.expires_at, paymentId: t.payment_id, paidAt: t.paid_at, callbackCount: t.callback_count, settled: t.settled, invoiceStatus: t.invoice_status,
      simulator: t.provider === 'SIMULATOR' };
  }
}
