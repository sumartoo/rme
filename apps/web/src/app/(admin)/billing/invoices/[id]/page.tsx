'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Dialog, Field, Input, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { Invoice, InvoiceLine, Page, Payment, PaymentMethod, ServiceItem, api, errorText } from '../../../../../lib/api';
import { PAYER_TYPE_LABEL, PAYMENT_METHOD_LABEL, fmtDate, fmtDateTime, fmtRupiah } from '../../../../../lib/format';
import { can, useSession } from '../../../../../lib/session';

const STATUS_LABEL: Record<Invoice['status'], string> = { DRAFT: 'Draf', ISSUED: 'Terbit', PARTIALLY_PAID: 'Dibayar sebagian', PAID: 'Lunas', VOID: 'Void' };
const DISCOUNT_LABEL: Record<InvoiceLine['discountStatus'], string> = { NONE: '', WITHIN_LIMIT: 'Diskon', PENDING: 'Menunggu persetujuan', APPROVED: 'Disetujui' };

/**
 * Editor tagihan (BIL-FR-001..004): baris dari layanan kunjungan & obat yang sudah diserahkan, tambah layanan manual,
 * ganti layanan konsultasi, diskon per baris dengan alasan (di atas batas → persetujuan manajer, OD-041), porsi penjamin,
 * lalu terbitkan. Tagihan terbit tidak bisa diubah (koreksi lewat void di batch berikut).
 */
export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const s = useSession();
  const router = useRouter();
  const canEdit = can(s, 'billing.invoice.issue');
  const canDiscount = can(s, 'billing.invoice.discount');
  const canApprove = can(s, 'billing.invoice.void.approve');
  const canPay = can(s, 'billing.payment.create');
  const [paying, setPaying] = useState(false);
  const [inv, setInv] = useState<Invoice>();
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<InvoiceLine>();
  const load = useCallback(async () => {
    try { setInv(await api<Invoice>(`/invoices/${id}`)); setError(undefined); }
    catch (e) { setError(errorText(e, 'Gagal memuat tagihan')); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (canEdit) void api<Page<ServiceItem>>('/service-items?limit=200').then((p) => setServices(p.data.filter((x) => x.isActive))).catch(() => undefined);
  }, [canEdit]);

  async function run(fn: () => Promise<Invoice | undefined>, ok?: string) {
    setBusy(true); setError(undefined); setNotice(undefined);
    try { const r = await fn(); if (r) setInv(r); if (ok) setNotice(ok); return true; }
    catch (e) { setError(errorText(e, 'Gagal menyimpan')); await load(); return false; }
    finally { setBusy(false); }
  }
  if (!inv) return error ? <Alert tone="error">{error}</Alert> : <p className="text-sm text-muted-foreground" role="status">Memuat…</p>;

  const draft = inv.status === 'DRAFT';
  const pending = inv.lines.some((l) => l.discountStatus === 'PENDING');
  const insured = inv.payerType !== 'UMUM';
  // Semua perubahan draf memakai If-Match (versi tagihan) agar suntingan dua kasir tidak saling menimpa
  const ifMatch = { 'If-Match': `"${inv.version}"` };
  const rebuild = () => run(() => api<Invoice>(inv.otcSaleId ? `/billing/otc-sales/${inv.otcSaleId}/invoice` : `/billing/encounters/${inv.encounterId}/invoice`, { method: 'POST' }), 'Draf diperbarui dari data kunjungan.');
  const issue = () => run(() => api<Invoice>(`/invoices/${inv.id}/issue`, { method: 'POST', headers: ifMatch }), 'Tagihan diterbitkan.');
  async function remove() {
    if (!window.confirm('Hapus draf tagihan ini?')) return;
    if (await run(async () => { await api(`/invoices/${inv?.id}`, { method: 'DELETE', headers: ifMatch }); return undefined; })) router.push('/billing');
  }
  const decide = (l: InvoiceLine, decision: 'APPROVE' | 'REJECT') =>
    run(() => api<Invoice>(`/invoices/${inv.id}/lines/${l.id}/discount-decision`, { method: 'POST', body: { decision } }), decision === 'APPROVE' ? 'Diskon disetujui.' : 'Diskon ditolak.');
  const delLine = (l: InvoiceLine) => run(() => api<Invoice>(`/invoices/${inv.id}/lines/${l.id}`, { method: 'DELETE', headers: ifMatch }));

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/billing" className="text-sm underline">← Tagihan</Link>
        <h1 className="text-xl font-semibold">{inv.invoiceNo ?? 'Draf tagihan'}</h1>
        <Badge tone={draft ? 'warning' : inv.status === 'VOID' ? 'neutral' : 'success'} data-testid="invoice-status">{STATUS_LABEL[inv.status]}</Badge>
        <a className="ml-auto text-sm underline" href={`/api/v1/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer">Rincian PDF</a>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {inv.warnings.map((w) => <Alert key={w} tone="info">{w}</Alert>)}
      <Card>
        <CardContent className="grid gap-1 pt-6 text-sm sm:grid-cols-2">
          <div><span className="text-muted-foreground">Pasien / pembeli: </span>{inv.patient ? `${inv.patient.name} · RM ${inv.patient.mrn}` : inv.customerName ?? 'Pembeli umum'}</div>
          <div><span className="text-muted-foreground">Rujukan: </span>{inv.encounterNo ?? inv.saleNo ?? '—'}{inv.kind === 'DRUG' ? ' (obat susulan)' : ''}</div>
          <div><span className="text-muted-foreground">Penjamin: </span>{inv.payerName ?? PAYER_TYPE_LABEL[inv.payerType]}
            {inv.contract ? ` · co-pay ${inv.contract.copayPercent}%${inv.contract.plafon != null ? ` · plafon ${fmtRupiah(String(inv.contract.plafon))}` : ''}` : ''}</div>
          <div><span className="text-muted-foreground">Cabang: </span>{inv.branchName}</div>
          {inv.issuedAt ? <div><span className="text-muted-foreground">Terbit: </span>{fmtDateTime(inv.issuedAt)} oleh {inv.issuedByName ?? '—'}</div> : null}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="grid gap-3 pt-6">
          <Table>
            <THead><TR><TH>Uraian</TH><TH className="text-right">Jml</TH><TH className="text-right">Harga</TH><TH className="text-right">Diskon</TH><TH className="text-right">Total</TH>
              {insured ? <TH className="text-right">Penjamin</TH> : null}<TH className="text-right">Pasien</TH><TH /></TR></THead>
            <TBody>
              {inv.lines.map((l) => (
                <TR key={l.id} data-testid="invoice-line">
                  <TD>{l.description}{l.isManual ? <Badge tone="neutral" className="ml-2">manual</Badge> : null}
                    {l.discountStatus !== 'NONE' ? <span className="block text-xs text-muted-foreground">
                      <Badge tone={l.discountStatus === 'PENDING' ? 'warning' : 'info'}>{DISCOUNT_LABEL[l.discountStatus]}</Badge> {l.discountReason}
                      {l.discountRequestedByName ? ` · ${l.discountRequestedByName}` : ''}{l.discountApprovedByName ? ` · disetujui ${l.discountApprovedByName}` : ''}</span> : null}
                    {l.splitReason ? <span className="block text-xs text-muted-foreground">Porsi diubah: {l.splitReason}</span> : null}</TD>
                  <TD className="text-right tabular-nums">{l.qty.toLocaleString('id-ID')}</TD>
                  <TD className="text-right tabular-nums">{fmtRupiah(l.unitPrice)}</TD>
                  <TD className="text-right tabular-nums">{Number(l.discountAmount) ? `−${fmtRupiah(l.discountAmount)}` : '—'}</TD>
                  <TD className="text-right tabular-nums">{fmtRupiah(l.lineTotal)}</TD>
                  {insured ? <TD className="text-right tabular-nums">{fmtRupiah(l.payerPortion)}</TD> : null}
                  <TD className="text-right tabular-nums">{fmtRupiah(l.patientPortion)}</TD>
                  <TD className="whitespace-nowrap text-right">
                    {draft && canEdit && inv.kind !== 'OTC' ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(l)} aria-label={`Ubah ${l.description}`}>Ubah</Button> : null}
                    {draft && canEdit && l.isManual ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void delLine(l)} aria-label={`Hapus ${l.description}`}>Hapus</Button> : null}
                    {draft && canApprove && l.discountStatus === 'PENDING' && !l.discountMine ? <>
                      <Button size="sm" disabled={busy} onClick={() => void decide(l, 'APPROVE')}>Setujui</Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide(l, 'REJECT')}>Tolak</Button></> : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <div className="ml-auto grid min-w-64 grid-cols-2 gap-x-6 text-sm tabular-nums" data-testid="invoice-totals">
            <span className="text-muted-foreground">Bruto</span><span className="text-right">{fmtRupiah(inv.grossAmount)}</span>
            <span className="text-muted-foreground">Diskon</span><span className="text-right">−{fmtRupiah(inv.discountAmount)}</span>
            <span className="text-muted-foreground">Neto</span><span className="text-right">{fmtRupiah(inv.netAmount)}</span>
            {insured ? <><span className="text-muted-foreground">Ditanggung penjamin</span><span className="text-right">{fmtRupiah(inv.payerPortion)}</span></> : null}
            <span className="font-semibold">Dibayar pasien</span><span className="text-right font-semibold" data-testid="patient-portion">{fmtRupiah(inv.patientPortion)}</span>
          </div>
          {draft && canEdit ? (
            <div className="flex flex-wrap gap-2">
              {inv.kind !== 'OTC' ? <Button variant="outline" disabled={busy} onClick={() => setAdding(true)}>Tambah layanan</Button> : null}
              <Button variant="outline" disabled={busy} onClick={() => void rebuild()}>Perbarui dari kunjungan</Button>
              <Button variant="ghost" disabled={busy} onClick={() => void remove()}>Hapus draf</Button>
              <Button className="ml-auto" disabled={busy || pending || !inv.lines.length} onClick={() => void issue()}>Terbitkan tagihan</Button>
            </div>
          ) : null}
          {draft && pending ? <p className="text-xs text-muted-foreground">Tagihan bisa diterbitkan sesudah semua diskon di atas batas disetujui manajer.</p> : null}
        </CardContent>
      </Card>
      {!draft ? (
        <Card data-testid="payments">
          <CardContent className="grid gap-3 pt-6 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <p className="font-medium">Pembayaran pasien</p>
              <span>Terbayar <b className="tabular-nums">{fmtRupiah(inv.paidAmount)}</b></span>
              <span>Sisa <b className="tabular-nums" data-testid="outstanding">{fmtRupiah(inv.outstanding)}</b></span>
              {canPay && (inv.status === 'ISSUED' || inv.status === 'PARTIALLY_PAID')
                ? <Button className="ml-auto" disabled={busy} onClick={() => { setNotice(undefined); setPaying(true); }}>Terima pembayaran</Button> : null}
            </div>
            {inv.payments.length ? (
              <Table>
                <THead><TR><TH>Kwitansi</TH><TH>Metode</TH><TH className="text-right">Nominal</TH><TH>Keterangan</TH><TH>Kasir</TH><TH /></TR></THead>
                <TBody>
                  {inv.payments.map((p) => (
                    <TR key={p.id} data-testid="payment-row">
                      <TD className="font-mono text-xs">{p.receiptNo}<span className="block font-sans text-muted-foreground">{fmtDateTime(p.receivedAt)}</span></TD>
                      <TD>{PAYMENT_METHOD_LABEL[p.method]}</TD>
                      <TD className="text-right tabular-nums">{fmtRupiah(p.amount)}</TD>
                      <TD className="text-xs">{p.reference ? `Ref. ${p.reference}` : p.change !== null ? `Diterima ${fmtRupiah(p.cashTendered)} · kembali ${fmtRupiah(p.change)}` : ''}</TD>
                      <TD className="text-xs">{p.receivedByName}</TD>
                      <TD className="text-right"><a className="underline" href={p.receiptUrl} target="_blank" rel="noreferrer">Kwitansi</a></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : <p className="text-muted-foreground">Belum ada pembayaran.</p>}
            {inv.receivable ? (
              <p className="text-xs text-muted-foreground" data-testid="receivable">Piutang ke {inv.payerName ?? 'penjamin'}: {fmtRupiah(inv.receivable.amount)}
                {' '}· jatuh tempo {fmtDate(inv.receivable.dueDate)}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {paying ? <PayDialog inv={inv} onClose={() => setPaying(false)} onDone={(p) => {
        setPaying(false); void load();
        setNotice(`Pembayaran ${p.receiptNo} tercatat${p.change && Number(p.change) > 0 ? ` — kembalian ${fmtRupiah(p.change)}` : ''}.`);
      }} /> : null}
      {adding ? <AddDialog services={services} busy={busy} onClose={() => setAdding(false)}
        onSave={async (serviceItemId, qty) => { if (await run(() => api<Invoice>(`/invoices/${inv.id}/lines`, { method: 'POST', body: { serviceItemId, qty }, headers: ifMatch }))) setAdding(false); }} /> : null}
      {editing ? <EditDialog line={editing} services={services} insured={insured} canDiscount={canDiscount} busy={busy} onClose={() => setEditing(undefined)}
        onSave={async (body) => { if (await run(() => api<Invoice>(`/invoices/${inv.id}/lines/${editing.id}`, { method: 'PUT', body, headers: ifMatch }))) setEditing(undefined); }} /> : null}
    </div>
  );
}

function AddDialog({ services, busy, onClose, onSave }: { services: ServiceItem[]; busy: boolean; onClose: () => void; onSave: (id: string, qty: number) => void }) {
  const [serviceId, setServiceId] = useState('');
  const [qty, setQty] = useState('1');
  function submit(e: FormEvent) { e.preventDefault(); if (serviceId) onSave(serviceId, Number(qty) || 1); }
  return (
    <Dialog open title="Tambah layanan" onClose={onClose}>
      <form className="grid gap-3" onSubmit={submit}>
        <Field id="inv-f1" label="Layanan"><Select id="inv-f1" value={serviceId} onChange={(e) => setServiceId(e.target.value)} required>
          <option value="">— pilih —</option>
          {services.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
        </Select></Field>
        <Field id="inv-f2" label="Jumlah"><Input id="inv-f2" type="number" min="1" step="1" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        <p className="text-xs text-muted-foreground">Harga mengikuti tarif berlaku untuk cabang & penjamin tagihan ini.</p>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Batal</Button><Button type="submit" disabled={busy || !serviceId}>Tambah</Button></div>
      </form>
    </Dialog>
  );
}

function EditDialog({ line, services, insured, canDiscount, busy, onClose, onSave }: {
  line: InvoiceLine; services: ServiceItem[]; insured: boolean; canDiscount: boolean; busy: boolean; onClose: () => void; onSave: (body: Record<string, unknown>) => void;
}) {
  const replaceable = line.sourceType === 'KONSULTASI' || line.isManual;
  const [serviceId, setServiceId] = useState(line.serviceItemId ?? '');
  const [qty, setQty] = useState(String(line.qty));
  const [discount, setDiscount] = useState(String(Number(line.discountAmount)));
  const [reason, setReason] = useState(line.discountReason ?? '');
  const [payer, setPayer] = useState(line.splitReason ? String(Number(line.payerPortion)) : '');
  const [splitReason, setSplitReason] = useState(line.splitReason ?? '');
  function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (replaceable && serviceId && serviceId !== line.serviceItemId) body.serviceItemId = serviceId;
    if (line.isManual && Number(qty) !== line.qty) body.qty = Number(qty);
    if (canDiscount && Number(discount) !== Number(line.discountAmount)) { body.discountAmount = Number(discount) || 0; body.discountReason = reason || undefined; }
    if (insured) {
      if (payer === '' && line.splitReason) body.payerPortion = null;
      else if (payer !== '' && (Number(payer) !== Number(line.payerPortion) || !line.splitReason)) { body.payerPortion = Number(payer); body.splitReason = splitReason || undefined; }
    }
    if (!Object.keys(body).length) { onClose(); return; }
    onSave(body);
  }
  const types = line.sourceType === 'KONSULTASI' ? services.filter((x) => x.serviceType === 'KONSULTASI') : services;
  return (
    <Dialog open title={`Ubah baris: ${line.description}`} onClose={onClose}>
      <form className="grid gap-3" onSubmit={submit}>
        {replaceable ? <Field id="inv-f3" label={line.sourceType === 'KONSULTASI' ? 'Layanan konsultasi' : 'Layanan'}>
          <Select id="inv-f3" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            {types.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
          </Select></Field> : null}
        {line.isManual ? <Field id="inv-f4" label="Jumlah"><Input id="inv-f4" type="number" min="1" step="1" value={qty} onChange={(e) => setQty(e.target.value)} /></Field> : null}
        {canDiscount ? <>
          <Field id="inv-f5" label="Diskon (Rp)"><Input id="inv-f5" type="number" min="0" step="1" value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>
          <Field id="inv-f6" label="Alasan diskon"><Input id="inv-f6" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></Field>
          <p className="text-xs text-muted-foreground">Diskon di atas batas klinik menunggu persetujuan manajer sebelum tagihan diterbitkan.</p>
        </> : null}
        {insured ? <>
          <Field id="inv-f7" label="Porsi penjamin (Rp) — kosongkan untuk hitung otomatis"><Input id="inv-f7" type="number" min="0" step="1" value={payer} onChange={(e) => setPayer(e.target.value)} /></Field>
          {payer !== '' ? <Field id="inv-f8" label="Alasan ubah porsi"><Input id="inv-f8" value={splitReason} maxLength={300} onChange={(e) => setSplitReason(e.target.value)} /></Field> : null}
        </> : null}
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Batal</Button><Button type="submit" disabled={busy}>Simpan</Button></div>
      </form>
    </Dialog>
  );
}

/** Terima pembayaran (BIL-FR-005/007): tunai menghitung kembalian; non-tunai wajib referensi. Satu Idempotency-Key per dialog
 *  sehingga klik ganda / kirim ulang tidak mencatat pembayaran dua kali. */
function PayDialog({ inv, onClose, onDone }: { inv: Invoice; onClose: () => void; onDone: (p: Payment) => void }) {
  const [key] = useState(() => `pay-${crypto.randomUUID()}`);
  const [method, setMethod] = useState<PaymentMethod>('TUNAI');
  const [amount, setAmount] = useState(String(Number(inv.outstanding)));
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const change = method === 'TUNAI' && tendered !== '' ? Number(tendered) - Number(amount) : null;
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      onDone(await api<Payment>(`/invoices/${inv.id}/payments`, { method: 'POST', headers: { 'Idempotency-Key': key },
        body: { method, amount: Number(amount), ...(method === 'TUNAI' ? (tendered ? { cashTendered: Number(tendered) } : {}) : { reference }) } }));
    } catch (x) { setError(errorText(x, 'Gagal mencatat pembayaran')); } finally { setBusy(false); }
  }
  return (
    <Dialog open title="Terima pembayaran" onClose={onClose}>
      <form className="grid gap-3" onSubmit={submit}>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p className="text-sm">Sisa tagihan: <b className="tabular-nums">{fmtRupiah(inv.outstanding)}</b></p>
        <Field id="pay-method" label="Metode"><Select id="pay-method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
          {(['TUNAI', 'DEBIT', 'KARTU_KREDIT', 'TRANSFER'] as const).map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>)}
        </Select></Field>
        <Field id="pay-amount" label="Nominal (Rp)"><Input id="pay-amount" type="number" min="1" step="1" max={Number(inv.outstanding)} required value={amount}
          onChange={(e) => setAmount(e.target.value)} /></Field>
        {method === 'TUNAI' ? <>
          <Field id="pay-tendered" label="Uang diterima (Rp)" hint="Kosongkan bila uang pas.">
            <Input id="pay-tendered" type="number" min="0" step="1" value={tendered} onChange={(e) => setTendered(e.target.value)} /></Field>
          {change !== null ? <p className="text-sm" data-testid="change">Kembalian: <b className="tabular-nums">{change >= 0 ? fmtRupiah(change.toFixed(2)) : 'uang kurang'}</b></p> : null}
        </> : <Field id="pay-ref" label="Nomor referensi (EDC / transfer)"><Input id="pay-ref" required minLength={3} maxLength={100} value={reference}
          onChange={(e) => setReference(e.target.value)} /></Field>}
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Batal</Button>
          <Button type="submit" disabled={busy || (change !== null && change < 0)}>Simpan pembayaran</Button></div>
      </form>
    </Dialog>
  );
}
