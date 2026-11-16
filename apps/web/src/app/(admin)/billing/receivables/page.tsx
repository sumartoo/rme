'use client';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Dialog, Field, Input, Select, Switch, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { Receivable, ReceivableDetail, ReceivableStatus, api, errorText } from '../../../../lib/api';
import { fmtDate, fmtDateTime, fmtRupiah } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

const STATUS_LABEL: Record<ReceivableStatus, string> = { OPEN: 'Belum dibayar', PARTIAL: 'Dibayar sebagian', PAID: 'Lunas', WRITTEN_OFF: 'Dihapusbukukan', VOID: 'Batal (tagihan void)' };

/** Piutang porsi penjamin (BIL-FR-013; OD-108): terbentuk saat tagihan terbit; pelunasan sebagian/penuh dicatat manajer. */
export default function ReceivablesPage() {
  const s = useSession();
  const [items, setItems] = useState<Receivable[]>();
  const [status, setStatus] = useState<'' | ReceivableStatus>('OPEN');
  const [overdue, setOverdue] = useState(false);
  const [error, setError] = useState<string>();
  const canInvoice = can(s, 'billing.invoice.read');
  const canManage = can(s, 'billing.receivable.manage');
  const [open, setOpen] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (status) p.set('status', status);
      if (overdue) p.set('overdue', 'true');
      setItems(await api<Receivable[]>(`/receivables?${p}`)); setError(undefined);
    } catch (e) { setError(errorText(e, 'Gagal memuat piutang')); }
  }, [status, overdue]);
  useEffect(() => { void load(); }, [load]);
  const total = (items ?? []).reduce((n, r) => n + Number(r.balance), 0);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Piutang penjamin</h1>
        <Select aria-label="Status" className="w-44" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="">Semua status</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-sm"><Switch checked={overdue} onChange={(e) => setOverdue(e.target.checked)} aria-label="Hanya yang terlambat" /> Hanya yang terlambat</label>
        {items ? <span className="ml-auto text-sm">Saldo: <b className="tabular-nums" data-testid="receivable-total">{fmtRupiah(total.toFixed(2))}</b></span> : null}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada piutang.</p> : (
            <Table>
              <THead><TR><TH>Penjamin</TH><TH>Tagihan</TH><TH>Pasien</TH><TH className="text-right">Piutang</TH><TH className="text-right">Dibayar</TH>
                <TH className="text-right">Saldo</TH><TH>Jatuh tempo</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {items.map((r) => (
                  <TR key={r.id} data-testid="receivable-row">
                    <TD>{r.payerName}<span className="block text-xs text-muted-foreground">{r.branchName}</span></TD>
                    <TD className="font-mono text-xs">{canInvoice ? <Link className="underline" href={`/billing/invoices/${r.invoiceId}`}>{r.invoiceNo}</Link> : r.invoiceNo}</TD>
                    <TD>{r.patient ? <>{r.patient.name}<span className="block text-xs text-muted-foreground">RM {r.patient.mrn}</span></> : '—'}</TD>
                    <TD className="text-right tabular-nums">{fmtRupiah(r.amount)}</TD>
                    <TD className="text-right tabular-nums">{fmtRupiah(r.paidAmount)}</TD>
                    <TD className="text-right tabular-nums">{fmtRupiah(r.balance)}</TD>
                    <TD>{fmtDate(r.dueDate)}{r.overdue ? <Badge tone="danger" className="ml-2">Terlambat</Badge> : null}</TD>
                    <TD>{STATUS_LABEL[r.status]}</TD>
                    <TD className="text-right"><Button size="sm" variant="outline" onClick={() => { setNotice(undefined); setOpen(r.id); }}>
                      {canManage && (r.status === 'OPEN' || r.status === 'PARTIAL') ? 'Pelunasan' : 'Riwayat'}</Button></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {open ? <SettleDialog id={open} canManage={canManage} onClose={() => setOpen(undefined)}
        onDone={(d) => { setOpen(undefined); setNotice(`Pelunasan tercatat. Saldo ${d.payerName}: ${fmtRupiah(d.balance)}.`); void load(); }} /> : null}
    </div>
  );
}

/** Riwayat & catat pelunasan dari penjamin (AC-BIL-FR-013-1): ≤ saldo; satu Idempotency-Key per dialog. */
function SettleDialog({ id, canManage, onClose, onDone }: { id: string; canManage: boolean; onClose: () => void; onDone: (d: ReceivableDetail) => void }) {
  const [d, setD] = useState<ReceivableDetail>();
  const [key] = useState(() => `rp-${crypto.randomUUID()}`);
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(() => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10));
  const [method, setMethod] = useState<'TRANSFER' | 'GIRO' | 'LAINNYA'>('TRANSFER');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<ReceivableDetail>(`/receivables/${id}`).then((x) => { setD(x); setAmount(String(Number(x.balance))); }).catch((e) => setError(errorText(e, 'Gagal memuat piutang')));
  }, [id]);
  const payable = canManage && d && (d.status === 'OPEN' || d.status === 'PARTIAL');
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      onDone(await api<ReceivableDetail>(`/receivables/${id}/payments`, { method: 'POST', headers: { 'Idempotency-Key': key },
        body: { amount: Number(amount), paidOn, method, reference: reference.trim(), note: note.trim() || undefined } }));
    } catch (x) { setError(errorText(x, 'Gagal mencatat pelunasan')); } finally { setBusy(false); }
  }
  return (
    <Dialog open title={d ? `Piutang ${d.payerName} · ${d.invoiceNo}` : 'Piutang'} onClose={onClose}>
      <div className="grid gap-3 text-sm">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {d ? <>
          <p>Piutang <b className="tabular-nums">{fmtRupiah(d.amount)}</b> · dibayar <b className="tabular-nums">{fmtRupiah(d.paidAmount)}</b> ·
            saldo <b className="tabular-nums" data-testid="receivable-balance">{fmtRupiah(d.balance)}</b> · jatuh tempo {fmtDate(d.dueDate)}</p>
          {d.payments.length ? (
            <ul className="grid gap-1 text-xs" data-testid="receivable-payments">
              {d.payments.map((p) => <li key={p.id}>{fmtDate(p.paidOn)} · {p.method} {p.reference} · <b className="tabular-nums">{fmtRupiah(p.amount)}</b>
                {p.note ? ` · ${p.note}` : ''} <span className="text-muted-foreground">({p.recordedByName}, {fmtDateTime(p.recordedAt)})</span></li>)}
            </ul>
          ) : <p className="text-xs text-muted-foreground">Belum ada pelunasan.</p>}
          {payable ? (
            <form className="grid gap-3 md:grid-cols-2" onSubmit={submit}>
              <Field id="rp-amount" label="Nominal (Rp)"><Input id="rp-amount" type="number" min="1" step="1" max={Number(d.balance)} required value={amount}
                onChange={(e) => setAmount(e.target.value)} /></Field>
              <Field id="rp-date" label="Tanggal diterima"><Input id="rp-date" type="date" required value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
              <Field id="rp-method" label="Cara bayar"><Select id="rp-method" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option value="TRANSFER">Transfer</option><option value="GIRO">Giro</option><option value="LAINNYA">Lainnya</option></Select></Field>
              <Field id="rp-ref" label="Referensi (no. transfer / giro)"><Input id="rp-ref" required minLength={3} maxLength={100} value={reference}
                onChange={(e) => setReference(e.target.value)} /></Field>
              <div className="md:col-span-2"><Field id="rp-note" label="Catatan"><Input id="rp-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
              <div className="flex justify-end gap-2 md:col-span-2"><Button type="button" variant="ghost" onClick={onClose}>Tutup</Button>
                <Button type="submit" disabled={busy}>Catat pelunasan</Button></div>
            </form>
          ) : <div className="flex justify-end"><Button variant="outline" onClick={onClose}>Tutup</Button></div>}
        </> : !error ? <p role="status" className="text-muted-foreground">Memuat…</p> : null}
      </div>
    </Dialog>
  );
}
