'use client';
import QRCode from 'qrcode';
import { FormEvent, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Dialog, Field, Input, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { ApprovalStatus, Invoice, Payment, QrisCharge, Refund, api, errorText } from '../../../../../lib/api';
import { fmtDateTime, fmtRupiah } from '../../../../../lib/format';

const APPROVAL_LABEL: Record<ApprovalStatus, string> = { REQUESTED: 'Menunggu persetujuan', APPROVED: 'Disetujui', REJECTED: 'Ditolak' };
const APPROVAL_TONE: Record<ApprovalStatus, 'warning' | 'success' | 'neutral'> = { REQUESTED: 'warning', APPROVED: 'success', REJECTED: 'neutral' };
const QRIS_LABEL: Record<QrisCharge['status'], string> = { PENDING: 'Menunggu pembayaran', PAID: 'Dibayar', EXPIRED: 'Kedaluwarsa', FAILED: 'Gagal', CANCELLED: 'Dibatalkan' };

/**
 * Bayar QRIS (BIL-FR-006): QR dinamis untuk sisa tagihan; status dipantau tiap 2 detik dan pembayaran baru tercatat setelah
 * callback penyedia terverifikasi. Pada simulator, tombol simulasi mengirim callback ber-signature lewat jalur yang sama.
 */
export function QrisDialog({ inv, onClose, onPaid }: { inv: Invoice; onClose: () => void; onPaid: () => void }) {
  const [key] = useState(() => `qr-${crypto.randomUUID()}`);
  const [charge, setCharge] = useState<QrisCharge>();
  const [img, setImg] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = inv.pendingQrisId ? await api<QrisCharge>(`/qris/${inv.pendingQrisId}`)
          : await api<QrisCharge>(`/invoices/${inv.id}/qris`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: {} });
        if (!alive) return;
        setCharge(c);
        if (c.qrPayload) setImg(`data:image/svg+xml;utf8,${encodeURIComponent(await QRCode.toString(c.qrPayload, { type: 'svg', margin: 1, width: 220 }))}`);
      } catch (e) { if (alive) setError(errorText(e, 'Gagal membuat QR')); }
    })();
    return () => { alive = false; };
  }, [inv.id, inv.pendingQrisId, key]);
  useEffect(() => {
    if (!charge || charge.status !== 'PENDING') return;
    const t = setInterval(async () => {
      try { const c = await api<QrisCharge>(`/qris/${charge.id}`); setCharge(c); if (c.status === 'PAID') onPaid(); } catch { /* coba lagi pada putaran berikut */ }
    }, 2000);
    return () => clearInterval(t);
  }, [charge, onPaid]);
  async function simulate(outcome: 'PAID' | 'FAILED') {
    if (!charge) return;
    setBusy(true); setError(undefined);
    try { const c = await api<QrisCharge>(`/qris/${charge.id}/simulate`, { method: 'POST', body: { outcome } }); setCharge(c); if (c.status === 'PAID') onPaid(); }
    catch (e) { setError(errorText(e, 'Simulasi gagal')); } finally { setBusy(false); }
  }
  return (
    <Dialog open title="Bayar dengan QRIS" onClose={onClose}>
      <div className="grid justify-items-center gap-3 text-sm">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {!charge && !error ? <p role="status" className="text-muted-foreground">Membuat QR…</p> : null}
        {charge ? <>
          <p>Nominal <b className="tabular-nums">{fmtRupiah(charge.amount)}</b></p>
          {img && charge.status === 'PENDING' ? <img src={img} alt="Kode QR pembayaran" width={220} height={220} /> : null}
          <Badge tone={charge.status === 'PAID' ? 'success' : charge.status === 'PENDING' ? 'warning' : 'neutral'} data-testid="qris-status">{QRIS_LABEL[charge.status]}</Badge>
          {charge.status === 'PENDING' ? <p className="text-xs text-muted-foreground">Berlaku sampai {fmtDateTime(charge.expiresAt)} · status diperbarui otomatis</p> : null}
          {charge.simulator ? <p className="text-xs text-muted-foreground">Mode simulator — bukan pembayaran sungguhan ({charge.providerRef}).</p> : null}
          {charge.simulator && charge.status === 'PENDING' ? (
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void simulate('PAID')}>Simulasikan bayar</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void simulate('FAILED')}>Simulasikan gagal</Button>
            </div>
          ) : null}
        </> : null}
        <Button variant="outline" onClick={onClose}>Tutup</Button>
      </div>
    </Dialog>
  );
}

/** Setujui / tolak dengan catatan (tolak wajib catatan). */
export function DecisionDialog({ title, onClose, onDecide }: { title: string; onClose: () => void; onDecide: (d: 'APPROVE' | 'REJECT', note?: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function go(d: 'APPROVE' | 'REJECT') {
    if (d === 'REJECT' && note.trim().length < 3) { setError('Isi catatan penolakan'); return; }
    setBusy(true); setError(undefined);
    try { await onDecide(d, note.trim() || undefined); } catch (e) { setError(errorText(e, 'Gagal menyimpan keputusan')); } finally { setBusy(false); }
  }
  return (
    <Dialog open title={title} onClose={onClose}>
      <div className="grid gap-3">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="decision-note" label="Catatan" hint="Wajib bila ditolak."><Input id="decision-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Batal</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void go('REJECT')}>Tolak</Button>
          <Button type="button" disabled={busy} onClick={() => void go('APPROVE')}>Setujui</Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Void (BIL-FR-009): tagihan terbit yang belum menerima uang. Pengajuan dan persetujuan oleh orang berbeda; selama diajukan
 * pembayaran ditahan. Sesudah disetujui, buat tagihan pengganti dari antrean kasir.
 */
export function VoidCard({ inv, canRequest, canApprove, onChanged }: { inv: Invoice; canRequest: boolean; canApprove: boolean; onChanged: (msg: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const open = inv.voids.find((v) => v.status === 'REQUESTED');
  const voidable = inv.status === 'ISSUED' && inv.payments.length === 0 && !open;
  if (!inv.voids.length && !(canRequest && voidable)) return null;
  return (
    <Card data-testid="void-card">
      <CardContent className="grid gap-2 pt-6 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-medium">Void tagihan</p>
          {canRequest && voidable ? <Button size="sm" variant="outline" className="ml-auto" onClick={() => setAsking(true)}>Ajukan void</Button> : null}
          {open && canApprove && !open.mine ? <Button size="sm" className="ml-auto" onClick={() => setDeciding(true)}>Putuskan void</Button> : null}
        </div>
        {inv.voids.map((v) => (
          <div key={v.id} className="flex flex-wrap items-center gap-2" data-testid="void-row">
            <Badge tone={APPROVAL_TONE[v.status]}>{APPROVAL_LABEL[v.status]}</Badge>
            <span>{v.reason}</span>
            <span className="text-xs text-muted-foreground">diajukan {v.requestedByName} · {fmtDateTime(v.requestedAt)}
              {v.approvedByName ? ` · diputuskan ${v.approvedByName}${v.decisionNote ? `: ${v.decisionNote}` : ''}` : ''}</span>
          </div>
        ))}
        {open ? <p className="text-xs text-muted-foreground">Selama void diajukan, tagihan tidak menerima pembayaran.</p> : null}
      </CardContent>
      {asking ? <ReasonDialog title="Ajukan void tagihan" label="Alasan void" onClose={() => setAsking(false)}
        onSubmit={async (reason) => { await api(`/invoices/${inv.id}/void-requests`, { method: 'POST', body: { reason } }); setAsking(false); onChanged('Void diajukan; menunggu persetujuan manajer.'); }} /> : null}
      {deciding && open ? <DecisionDialog title={`Void: ${open.reason}`} onClose={() => setDeciding(false)}
        onDecide={async (decision, note) => {
          await api(`/void-requests/${open.id}/decision`, { method: 'POST', body: { decision, note } });
          setDeciding(false); onChanged(decision === 'APPROVE' ? 'Tagihan di-void. Buat tagihan pengganti dari antrean kasir.' : 'Void ditolak.');
        }} /> : null}
    </Card>
  );
}

function ReasonDialog({ title, label, onClose, onSubmit }: { title: string; label: string; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { await onSubmit(reason.trim()); } catch (x) { setError(errorText(x, 'Gagal mengajukan')); } finally { setBusy(false); }
  }
  return (
    <Dialog open title={title} onClose={onClose}>
      <form className="grid gap-3" onSubmit={submit}>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="reason" label={label}><Input id="reason" required minLength={5} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Batal</Button><Button type="submit" disabled={busy}>Ajukan</Button></div>
      </form>
    </Dialog>
  );
}

/** Refund atas satu pembayaran (BIL-FR-010, OD-112): tunai dari kas shift; non-tunai sebagai transfer manual dengan referensi. */
export function RefundDialog({ payment, room, onClose, onDone }: { payment: Payment; room: number; onClose: () => void; onDone: (r: Refund) => void }) {
  const [key] = useState(() => `rf-${crypto.randomUUID()}`);
  const [amount, setAmount] = useState(String(room));
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const cash = payment.method === 'TUNAI';
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      onDone(await api<Refund>('/refunds', { method: 'POST', headers: { 'Idempotency-Key': key },
        body: { paymentId: payment.id, amount: Number(amount), reason: reason.trim(), ...(cash ? {} : { reference: reference.trim() }) } }));
    } catch (x) { setError(errorText(x, 'Gagal mengajukan refund')); } finally { setBusy(false); }
  }
  return (
    <Dialog open title={`Ajukan refund ${payment.receiptNo}`} onClose={onClose}>
      <form className="grid gap-3" onSubmit={submit}>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p className="text-sm">Dapat dikembalikan: <b className="tabular-nums">{fmtRupiah(room.toFixed(2))}</b>
          {cash ? ' · dibayar tunai dari kas shift Anda' : ' · dikembalikan lewat transfer manual'}</p>
        <Field id="refund-amount" label="Nominal refund (Rp)"><Input id="refund-amount" type="number" min="1" step="1" max={room} required value={amount}
          onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field id="refund-reason" label="Alasan refund"><Input id="refund-reason" required minLength={5} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {!cash ? <Field id="refund-ref" label="Rekening / referensi transfer"><Input id="refund-ref" required minLength={3} maxLength={100} value={reference}
          onChange={(e) => setReference(e.target.value)} /></Field> : null}
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Batal</Button><Button type="submit" disabled={busy}>Ajukan refund</Button></div>
      </form>
    </Dialog>
  );
}

/** Riwayat refund tagihan + keputusan manajer (≠ pengaju). */
export function RefundTable({ inv, canApprove, onChanged }: { inv: Invoice; canApprove: boolean; onChanged: (msg: string) => void }) {
  const [deciding, setDeciding] = useState<Refund>();
  if (!inv.refunds.length) return null;
  return (
    <>
      <p className="font-medium">Refund</p>
      <Table>
        <THead><TR><TH>No.</TH><TH>Kwitansi</TH><TH className="text-right">Nominal</TH><TH>Cara</TH><TH>Alasan</TH><TH>Status</TH><TH /></TR></THead>
        <TBody>
          {inv.refunds.map((r) => (
            <TR key={r.id} data-testid="refund-row">
              <TD className="font-mono text-xs">{r.refundNo}<span className="block font-sans text-muted-foreground">{r.requestedByName} · {fmtDateTime(r.requestedAt)}</span></TD>
              <TD className="font-mono text-xs">{r.receiptNo}</TD>
              <TD className="text-right tabular-nums">{fmtRupiah(r.amount)}</TD>
              <TD className="text-xs">{r.method === 'TUNAI' ? 'Tunai (kas shift)' : `Transfer · ${r.reference}`}</TD>
              <TD className="text-xs">{r.reason}{r.decisionNote ? <span className="block text-muted-foreground">Catatan: {r.decisionNote}</span> : null}</TD>
              <TD><Badge tone={APPROVAL_TONE[r.status]}>{APPROVAL_LABEL[r.status]}</Badge>
                {r.approvedByName ? <span className="block text-xs text-muted-foreground">{r.approvedByName}</span> : null}</TD>
              <TD className="text-right">{canApprove && r.status === 'REQUESTED' && !r.mine
                ? <Button size="sm" onClick={() => setDeciding(r)}>Putuskan</Button> : null}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {deciding ? <DecisionDialog title={`Refund ${deciding.refundNo} · ${fmtRupiah(deciding.amount)}`} onClose={() => setDeciding(undefined)}
        onDecide={async (decision, note) => {
          await api(`/refunds/${deciding.id}/decision`, { method: 'POST', body: { decision, note } });
          setDeciding(undefined); onChanged(decision === 'APPROVE' ? `Refund ${deciding.refundNo} disetujui.` : `Refund ${deciding.refundNo} ditolak.`);
        }} /> : null}
    </>
  );
}

/** Sisa yang dapat di-refund dari satu pembayaran = nominal − refund yang diajukan/disetujui. */
export const refundRoom = (inv: Invoice, p: Payment) =>
  Math.round((Number(p.amount) - inv.refunds.filter((r) => r.paymentId === p.id && r.status !== 'REJECTED').reduce((n, r) => n + Number(r.amount), 0)) * 100) / 100;
