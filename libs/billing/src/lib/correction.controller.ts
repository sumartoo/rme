import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, RequirePermission, Uuid, assertId, ctx, optText, problem } from '@clinicrme/shared';
import { Db, type Tx, audit, idempotent, rows } from '@clinicrme/db';
import { INV_NOT_FOUND, invoiceHead } from './invoice.repo';
import { REFUND_SELECT, type RefundRow, refundDto, settleInvoice } from './payment.repo';

const Reason = z.string().trim().min(5, 'Alasan minimal 5 karakter').max(500);
const VoidBody = z.object({ reason: Reason }).strict();
const Decision = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: optText(500) }).strict();
const RefundBody = z.object({
  paymentId: Uuid,
  amount: z.number().positive().max(1_000_000_000).transform((n) => Math.round(n * 100) / 100),
  reason: Reason,
  reference: optText(100),
}).strict();
const ListQuery = z.object({ status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED']).optional(), invoiceId: Uuid.optional() });
const VOID_NOT_FOUND = ['BIL-404-VOID', 'Pengajuan void tidak ditemukan'] as const;
const REFUND_NOT_FOUND = ['BIL-404-REFUND', 'Refund tidak ditemukan'] as const;
const rp = (v: string | number) => `Rp ${Number(v).toLocaleString('id-ID', { maximumFractionDigits: 2 })}`;

/**
 * Koreksi tagihan (maker–checker, OD-041): void tagihan belum dibayar (BIL-FR-009) dan refund pembayaran (BIL-FR-010, OD-112).
 * Selalu disetujui orang lain berapa pun nilainya; tagihan & pembayaran asal tidak pernah diubah isinya.
 */
@Controller('api/v1')
export class CorrectionController {
  constructor(private readonly db: Db) {}

  /** Ajukan void: hanya tagihan terbit yang belum menerima uang. Selama diajukan, pembayaran ditahan dan QR menunggu dibatalkan. */
  @RequirePermission('billing.invoice.void.request') @BodySchema(VoidBody) @Post('invoices/:id/void-requests') @HttpCode(201)
  async requestVoid(@Param('id') id: string, @Body() b: z.infer<typeof VoidBody>) {
    assertId(id, ...INV_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const h = await invoiceHead(tx, id, true);
      await assertVoidable(tx, id, h.status);
      const [dup] = await rows(tx, sql`select 1 from invoice_void where invoice_id = ${id} and status = 'REQUESTED'`);
      if (dup) throw problem(409, 'BIL-409-VOID-PENDING', 'Void tagihan ini sudah diajukan');
      await tx.execute(sql`update payment_gateway_txn set status = 'CANCELLED' where invoice_id = ${id} and status = 'PENDING'`);
      const [v] = await rows<{ id: string }>(tx, sql`
        insert into invoice_void(tenant_id, invoice_id, reason, requested_by) values (app.current_tenant_id(), ${id}, ${b.reason}, ${ctx().userId}) returning id`);
      await audit(tx, 'INVOICE_VOID_REQUESTED', 'invoice', id, h.patient_id, { invoiceNo: h.invoice_no, voidRequestId: v.id, reason: b.reason });
      return this.voidView(tx, v.id);
    });
  }

  /** Antrean persetujuan void (manajer). */
  @RequirePermission('billing.invoice.void.approve') @Get('void-requests')
  async listVoids(@Query() q: Record<string, string | undefined>) {
    const P = ListQuery.safeParse(q);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    return this.db.withTenantTx(async (tx) => {
      const r = await rows<{ id: string }>(tx, sql`
        select v.id from invoice_void v where (${P.data.status ?? null}::text is null or v.status = ${P.data.status ?? null}::text)
           and (${P.data.invoiceId ?? null}::uuid is null or v.invoice_id = ${P.data.invoiceId ?? null}::uuid)
         order by v.created_at desc limit 200`);
      return Promise.all(r.map((x) => this.voidView(tx, x.id)));
    });
  }

  /**
   * Putuskan void (≠ pengaju). Disetujui → tagihan VOID (isi tetap ada), piutang batal, obat yang ditagih kembali "belum
   * ditagih" agar masuk tagihan pengganti; penjualan obat bebas tetap menunggu bayar (OD-113). Ditolak wajib catatan.
   */
  @RequirePermission('billing.invoice.void.approve') @BodySchema(Decision) @Post('void-requests/:id/decision') @HttpCode(200)
  async decideVoid(@Param('id') id: string, @Body() b: z.infer<typeof Decision>) {
    assertId(id, ...VOID_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const [v] = await rows<{ invoice_id: string; status: string; requested_by: string }>(tx, sql`
        select invoice_id, status, requested_by from invoice_void where id = ${id} for update`);
      if (!v) throw problem(404, ...VOID_NOT_FOUND);
      if (v.status !== 'REQUESTED') throw problem(409, 'BIL-409-DECIDED', 'Pengajuan sudah diputuskan');
      if (v.requested_by === ctx().userId) throw problem(403, 'BIL-403-SELF-APPROVAL', 'Pengajuan tidak dapat diputuskan oleh pengajunya sendiri');
      const note = b.note?.trim() || null;
      const h = await invoiceHead(tx, v.invoice_id, true);
      if (b.decision === 'REJECT') {
        if ((note ?? '').length < 3) throw problem(400, 'BIL-400-NOTE', 'Catatan penolakan wajib diisi');
        await tx.execute(sql`update invoice_void set status = 'REJECTED', approved_by = ${ctx().userId}, decided_at = now(), decision_note = ${note} where id = ${id}`);
        await audit(tx, 'INVOICE_VOID_REJECTED', 'invoice', v.invoice_id, h.patient_id, { invoiceNo: h.invoice_no, voidRequestId: id, note });
        return this.voidView(tx, id);
      }
      await assertVoidable(tx, v.invoice_id, h.status);
      await tx.execute(sql`update invoice_void set status = 'APPROVED', approved_by = ${ctx().userId}, decided_at = now(), decision_note = ${note} where id = ${id}`);
      await tx.execute(sql`update invoice set status = 'VOID', version = version + 1, updated_at = now(), updated_by = ${ctx().userId} where id = ${v.invoice_id}`);
      await tx.execute(sql`update receivable set status = 'VOID' where invoice_id = ${v.invoice_id}`);
      const [d] = await rows<{ n: number }>(tx, sql`
        with u as (update dispense_line set billing_status = 'UNBILLED', invoice_line_id = null
                    where invoice_line_id in (select id from invoice_line where invoice_id = ${v.invoice_id}) returning 1)
        select count(*)::int as n from u`);
      await audit(tx, 'INVOICE_VOIDED', 'invoice', v.invoice_id, h.patient_id, { invoiceNo: h.invoice_no, voidRequestId: id, drugLinesReleased: d.n });
      return this.voidView(tx, id);
    });
  }

  /**
   * Ajukan refund atas satu pembayaran (OD-112): ≤ nominal bayar − refund lain yang diajukan/disetujui. Bayar tunai → refund
   * tunai dari kas shift pengaju (butuh shift terbuka); non-tunai/QRIS → transfer manual dengan referensi.
   */
  @RequirePermission('billing.refund.request') @BodySchema(RefundBody) @Post('refunds') @HttpCode(201)
  async requestRefund(@Body() b: z.infer<typeof RefundBody>, @Headers('idempotency-key') key: string | undefined) {
    return this.db.withTenantTx((tx) => idempotent(tx, 'refund.create', key, b, async () => {
      // Pembayaran append-only (tanpa hak UPDATE) → serialisasi pengajuan refund per pembayaran dengan advisory lock
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`refund:${b.paymentId}`}, 0))`);
      const [p] = await rows<{ invoice_id: string; method: string; amount: string; refunded: string }>(tx, sql`
        select p.invoice_id, p.method, p.amount::text,
               coalesce((select sum(r.amount) from refund r where r.payment_id = p.id and r.status in ('REQUESTED', 'APPROVED')), 0)::text as refunded
          from payment p where p.id = ${b.paymentId}`);
      if (!p) throw problem(404, 'BIL-404-PAYMENT', 'Pembayaran tidak ditemukan');
      const h = await invoiceHead(tx, p.invoice_id, true);
      if (h.status === 'VOID') throw problem(409, 'BIL-409-NOT-PAYABLE', 'Tagihan sudah di-void');
      const room = Number(p.amount) - Number(p.refunded);
      if (b.amount > room + 0.001) throw problem(409, 'BIL-409-REFUND-EXCEEDS', `Refund melebihi sisa yang dapat dikembalikan (${rp(room)})`);
      const method = p.method === 'TUNAI' ? 'TUNAI' : 'TRANSFER';
      let shiftId: string | null = null;
      const reference = b.reference?.trim() || null;
      if (method === 'TUNAI') {
        const [s] = await rows<{ id: string }>(tx, sql`
          select id from cashier_shift where cashier_id = ${ctx().userId} and status = 'OPEN' and branch_id = ${h.branch_id}`);
        if (!s) throw problem(409, 'BIL-409-NO-SHIFT', 'Refund tunai dibayar dari kas shift: buka shift kasir di cabang tagihan ini');
        shiftId = s.id;
      } else if ((reference ?? '').length < 3) {
        throw problem(400, 'BIL-400-REFERENCE', 'Refund non-tunai dicatat sebagai transfer manual: isi nomor rekening/referensi transfer');
      }
      const [{ no }] = await rows<{ no: string }>(tx, sql`select app.next_document_number('REFUND', 'TENANT', 'RF{YYYY}{MM}{SEQ:5}') as no`);
      const [r] = await rows<{ id: string }>(tx, sql`
        insert into refund(tenant_id, refund_no, payment_id, amount, reason, method, requested_by, shift_id, reference)
        values (app.current_tenant_id(), ${no}, ${b.paymentId}, ${b.amount.toFixed(2)}::numeric, ${b.reason}, ${method}, ${ctx().userId}, ${shiftId},
                ${method === 'TRANSFER' ? reference : null})
        returning id`);
      await audit(tx, 'REFUND_REQUESTED', 'refund', r.id, h.patient_id, { refundNo: no, invoiceNo: h.invoice_no, amount: b.amount, method, reason: b.reason });
      return refundDto(await this.refund(tx, r.id));
    }));
  }

  /** Daftar refund (antrean persetujuan manajer atau riwayat per tagihan). */
  @RequirePermission('billing.invoice.read') @Get('refunds')
  async listRefunds(@Query() q: Record<string, string | undefined>) {
    const P = ListQuery.safeParse(q);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    return this.db.withTenantTx(async (tx) => {
      const r = await rows<RefundRow>(tx, sql`${REFUND_SELECT}
        where (${P.data.status ?? null}::text is null or r.status = ${P.data.status ?? null}::text)
          and (${P.data.invoiceId ?? null}::uuid is null or p.invoice_id = ${P.data.invoiceId ?? null}::uuid)
        order by r.requested_at desc limit 200`);
      return r.map(refundDto);
    });
  }

  /**
   * Putuskan refund (≠ pengaju). Disetujui → status tagihan dihitung ulang (pembayaran asal tidak berubah). Refund tunai
   * hanya dapat disetujui selama shift pengajunya masih terbuka (kas shift berkurang). Ditolak wajib catatan.
   */
  @RequirePermission('billing.refund.approve') @BodySchema(Decision) @Post('refunds/:id/decision') @HttpCode(200)
  async decideRefund(@Param('id') id: string, @Body() b: z.infer<typeof Decision>) {
    assertId(id, ...REFUND_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const [r] = await rows<{ payment_id: string; status: string; requested_by: string; method: string; amount: string; shift_status: string | null;
                               invoice_id: string; refund_no: string }>(tx, sql`
        select r.payment_id, r.status, r.requested_by, r.method, r.amount::text, s.status as shift_status, p.invoice_id, r.refund_no
          from refund r join payment p on p.id = r.payment_id left join cashier_shift s on s.id = r.shift_id where r.id = ${id} for update of r`);
      if (!r) throw problem(404, ...REFUND_NOT_FOUND);
      if (r.status !== 'REQUESTED') throw problem(409, 'BIL-409-DECIDED', 'Refund sudah diputuskan');
      if (r.requested_by === ctx().userId) throw problem(403, 'BIL-403-SELF-APPROVAL', 'Refund tidak dapat diputuskan oleh pengajunya sendiri');
      const note = b.note?.trim() || null;
      const h = await invoiceHead(tx, r.invoice_id, true);
      if (b.decision === 'REJECT') {
        if ((note ?? '').length < 3) throw problem(400, 'BIL-400-NOTE', 'Catatan penolakan wajib diisi');
        await tx.execute(sql`update refund set status = 'REJECTED', approved_by = ${ctx().userId}, decided_at = now(), decision_note = ${note} where id = ${id}`);
        await audit(tx, 'REFUND_REJECTED', 'refund', id, h.patient_id, { refundNo: r.refund_no, note });
        return refundDto(await this.refund(tx, id));
      }
      if (r.method === 'TUNAI' && r.shift_status !== 'OPEN') {
        throw problem(409, 'BIL-409-SHIFT-CLOSED', 'Shift pengaju refund tunai sudah ditutup; tolak lalu ajukan ulang di shift yang terbuka');
      }
      await tx.execute(sql`update refund set status = 'APPROVED', approved_by = ${ctx().userId}, decided_at = now(), decision_note = ${note} where id = ${id}`);
      const status = await settleInvoice(tx, r.invoice_id);
      await audit(tx, 'REFUND_APPROVED', 'refund', id, h.patient_id, { refundNo: r.refund_no, invoiceNo: h.invoice_no, amount: Number(r.amount), method: r.method,
        invoiceStatus: status });
      return refundDto(await this.refund(tx, id));
    });
  }

  private async refund(tx: Tx, id: string): Promise<RefundRow> {
    const [r] = await rows<RefundRow>(tx, sql`${REFUND_SELECT} where r.id = ${id}`);
    if (!r) throw problem(404, ...REFUND_NOT_FOUND);
    return r;
  }

  private async voidView(tx: Tx, id: string) {
    const [v] = await rows<{ id: string; invoice_id: string; invoice_no: string | null; kind: string; net_amount: string; patient_name: string | null;
                             customer_name: string | null; reason: string; status: string; requested_by: string; requested_by_name: string;
                             approved_by_name: string | null; created_at: string; decided_at: string | null; decision_note: string | null; invoice_status: string }>(tx, sql`
      select v.id, v.invoice_id, i.invoice_no, i.kind, i.net_amount::text, pt.full_name as patient_name, i.customer_name, v.reason, v.status, v.requested_by,
             ru.full_name as requested_by_name, au.full_name as approved_by_name, v.created_at, v.decided_at, v.decision_note, i.status as invoice_status
        from invoice_void v join invoice i on i.id = v.invoice_id join app_user ru on ru.id = v.requested_by left join app_user au on au.id = v.approved_by
        left join patient pt on pt.id = i.patient_id where v.id = ${id}`);
    if (!v) throw problem(404, ...VOID_NOT_FOUND);
    return { id: v.id, invoiceId: v.invoice_id, invoiceNo: v.invoice_no, kind: v.kind, netAmount: v.net_amount, patientName: v.patient_name ?? v.customer_name,
      reason: v.reason, status: v.status, requestedByName: v.requested_by_name, approvedByName: v.approved_by_name, requestedAt: v.created_at,
      decidedAt: v.decided_at, decisionNote: v.decision_note, invoiceStatus: v.invoice_status, mine: v.requested_by === ctx().userId };
  }
}

/** AC-BIL-FR-009-1: void hanya untuk tagihan terbit yang belum dibayar (termasuk piutang penjamin belum dibayar). */
async function assertVoidable(tx: Tx, invoiceId: string, status: string) {
  if (status === 'DRAFT') throw problem(409, 'BIL-409-VOID-DRAFT', 'Draf tagihan cukup dihapus, tidak perlu void');
  if (status === 'VOID') throw problem(409, 'BIL-409-VOID-DONE', 'Tagihan sudah di-void');
  const [x] = await rows<{ paid: boolean; rc_paid: boolean }>(tx, sql`
    select exists (select 1 from payment p where p.invoice_id = ${invoiceId}) as paid,
           exists (select 1 from receivable r where r.invoice_id = ${invoiceId} and r.paid_amount > 0) as rc_paid`);
  if (status !== 'ISSUED' || x.paid || x.rc_paid) {
    throw problem(409, 'BIL-409-VOID-PAID', 'Tagihan yang sudah menerima pembayaran tidak dapat di-void; gunakan refund');
  }
}
