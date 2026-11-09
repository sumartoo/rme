import { sql } from 'drizzle-orm';
import { type Tx, audit, rows } from '@clinicrme/db';
import { ctx } from '@clinicrme/shared';

/**
 * Status tagihan dari uang yang diterima (BIL-FR-007): terbayar = Σ pembayaran − Σ refund disetujui. Belum ada → ISSUED,
 * sebagian → PARTIALLY_PAID, ≥ porsi pasien → PAID. Saat menjadi lunas, efek lanjutan dijalankan sekali (`onPaid`).
 */
export async function settleInvoice(tx: Tx, invoiceId: string): Promise<string> {
  const [i] = await rows<{ status: string; patient_portion: string; paid: string }>(tx, sql`
    select i.status, i.patient_portion::text,
           (coalesce((select sum(p.amount) from payment p where p.invoice_id = i.id), 0)
            - coalesce((select sum(r.amount) from refund r join payment p on p.id = r.payment_id where p.invoice_id = i.id and r.status = 'APPROVED'), 0))::text as paid
      from invoice i where i.id = ${invoiceId} for update`);
  if (i.status === 'DRAFT' || i.status === 'VOID') return i.status;
  const paid = Number(i.paid);
  const status = paid + 0.005 >= Number(i.patient_portion) ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'ISSUED';
  await tx.execute(sql`update invoice set paid_amount = ${i.paid}::numeric, status = ${status}, version = version + 1, updated_at = now(),
                         updated_by = ${ctx().userId} where id = ${invoiceId}`);
  if (status === 'PAID' && i.status !== 'PAID') await onPaid(tx, invoiceId);
  return status;
}

/**
 * Tagihan lunas: kunjungan selesai (alur farmasi dulu) atau diteruskan ke farmasi bila masih ada resep terbuka (kasir dulu,
 * OD-107); penjualan obat bebas menjadi PAID (OD-113). Tagihan obat susulan tidak mengubah kunjungan.
 */
async function onPaid(tx: Tx, invoiceId: string) {
  const [h] = await rows<{ kind: string; encounter_id: string | null; otc_sale_id: string | null; patient_id: string | null; invoice_no: string }>(tx, sql`
    select kind, encounter_id, otc_sale_id, patient_id, invoice_no from invoice where id = ${invoiceId}`);
  if (h.kind === 'OTC' && h.otc_sale_id) {
    await tx.execute(sql`update otc_sale set status = 'PAID' where id = ${h.otc_sale_id} and status = 'AWAITING_PAYMENT'`);
    return;
  }
  if (h.kind !== 'ENCOUNTER' || !h.encounter_id) return;
  const [e] = await rows<{ status: string; pharmacy_first: boolean; open_rx: boolean }>(tx, sql`
    select e.status, coalesce((t.settings->>'pharmacyBeforeCashier')::boolean, true) as pharmacy_first,
           exists (select 1 from prescription p where p.encounter_id = e.id and p.status in ('ISSUED', 'VERIFIED', 'PARTIALLY_DISPENSED')) as open_rx
      from encounter e join tenant t on t.id = e.tenant_id where e.id = ${h.encounter_id} for update of e`);
  if (e.status !== 'BILLING') return;
  const next = !e.pharmacy_first && e.open_rx ? 'PHARMACY' : 'FINISHED';
  await tx.execute(sql`update encounter set status = ${next}, updated_by = ${ctx().userId},
                         finished_at = case when ${next} = 'FINISHED' then now() else finished_at end where id = ${h.encounter_id}`);
  await audit(tx, 'ENCOUNTER_BILLING_SETTLED', 'encounter', h.encounter_id, h.patient_id, { invoiceNo: h.invoice_no, next });
}

/** OD-108: porsi penjamin menjadi piutang saat tagihan terbit; jatuh tempo = tanggal terbit (zona cabang) + `paymentTermDays` kontrak (bawaan 30). */
export async function createReceivable(tx: Tx, invoiceId: string) {
  const [r] = await rows<{ id: string; amount: string }>(tx, sql`
    insert into receivable(tenant_id, invoice_id, payer_id, amount, due_date)
    select i.tenant_id, i.id, i.payer_id, i.payer_portion,
           (now() at time zone br.timezone)::date + coalesce((p.contract->>'paymentTermDays')::int, 30)
      from invoice i join branch br on br.id = i.branch_id join payer p on p.id = i.payer_id
     where i.id = ${invoiceId} and i.payer_portion > 0
    returning id, amount::text`);
  return r ?? null;
}

export interface PaymentRow { id: string; receipt_no: string; method: string; amount: string; cash_tendered: string | null; reference: string | null;
  received_at: string; received_by_name: string }
export const paymentDto = (p: PaymentRow) => ({
  id: p.id, receiptNo: p.receipt_no, method: p.method, amount: p.amount, cashTendered: p.cash_tendered,
  change: p.cash_tendered !== null ? (Math.round((Number(p.cash_tendered) - Number(p.amount)) * 100) / 100).toFixed(2) : null,
  reference: p.reference, receivedAt: p.received_at, receivedByName: p.received_by_name, receiptUrl: `/api/v1/payments/${p.id}/receipt`,
});
