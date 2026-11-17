'use client';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Dialog, Field, Input, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { CashierShift, api, errorText } from '../../../../lib/api';
import { PAYMENT_METHOD_LABEL, fmtDateTime, fmtRupiah } from '../../../../lib/format';
import { useSession } from '../../../../lib/session';

const STATUS_LABEL: Record<CashierShift['status'], string> = { OPEN: 'Terbuka', CLOSED: 'Ditutup', VERIFIED: 'Terverifikasi' };
const STATUS_TONE: Record<CashierShift['status'], 'warning' | 'info' | 'success'> = { OPEN: 'warning', CLOSED: 'info', VERIFIED: 'success' };

/**
 * Shift kasir untuk manajer (OD-111): verifikasi shift yang sudah ditutup (≠ kasir shift; selisih di atas toleransi wajib
 * catatan) dan tutup shift yang lupa ditutup dengan kas fisik & keterangan.
 */
export default function ShiftsPage() {
  const s = useSession();
  const [status, setStatus] = useState<'' | CashierShift['status']>('CLOSED');
  const [items, setItems] = useState<CashierShift[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [verifying, setVerifying] = useState<CashierShift>();
  const [closing, setClosing] = useState<CashierShift>();
  // Respons lama (filter sebelumnya) yang datang belakangan diabaikan agar daftar selalu sesuai filter terakhir
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const r = await api<CashierShift[]>(`/cashier-shifts${status ? `?status=${status}` : ''}`);
      if (n === seq.current) { setItems(r); setError(undefined); }
    } catch (e) { if (n === seq.current) setError(errorText(e, 'Gagal memuat shift')); }
  }, [status]);
  useEffect(() => { void load(); }, [load]);
  const done = (msg: string) => { setVerifying(undefined); setClosing(undefined); setNotice(msg); void load(); };
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Shift kasir</h1>
        <Select aria-label="Status shift" className="w-44" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="">Semua status</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p role="status" className="text-sm text-muted-foreground">Memuat…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada shift.</p> : (
            <Table>
              <THead><TR><TH>Kasir</TH><TH>Buka / tutup</TH><TH>Pembayaran</TH><TH className="text-right">Kas seharusnya</TH><TH className="text-right">Dihitung</TH>
                <TH className="text-right">Selisih</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {items.map((x) => (
                  <TR key={x.id} data-testid="shift-row">
                    <TD>{x.cashierName}<span className="block text-xs text-muted-foreground">{x.branchName}</span></TD>
                    <TD className="text-xs">{fmtDateTime(x.openedAt)}<span className="block">{x.closedAt ? fmtDateTime(x.closedAt) : '—'}
                      {x.forceClosed ? ` · ditutup ${x.closedByName}` : ''}</span></TD>
                    <TD className="text-xs">{x.totals.map((t) => `${PAYMENT_METHOD_LABEL[t.method]} ${fmtRupiah(t.total)}`).join(' · ') || '—'}
                      {Number(x.cashRefunds) ? <span className="block">Refund tunai {fmtRupiah(x.cashRefunds)}</span> : null}</TD>
                    <TD className="text-right tabular-nums">{fmtRupiah(x.expectedCash)}</TD>
                    <TD className="text-right tabular-nums">{x.countedCash ? fmtRupiah(x.countedCash) : '—'}</TD>
                    <TD className="text-right tabular-nums">{x.variance !== null ? <span className={x.overTolerance ? 'font-semibold text-red-700' : ''}>{fmtRupiah(x.variance)}</span> : '—'}
                      {x.varianceNote ? <span className="block text-xs font-normal text-muted-foreground">{x.varianceNote}</span> : null}</TD>
                    <TD><Badge tone={STATUS_TONE[x.status]}>{STATUS_LABEL[x.status]}</Badge>
                      {x.verifiedByName ? <span className="block text-xs text-muted-foreground">{x.verifiedByName}{x.verifyNote ? `: ${x.verifyNote}` : ''}</span> : null}</TD>
                    <TD className="text-right">
                      {x.status === 'CLOSED' && x.cashierId !== s.me.user.id ? <Button size="sm" onClick={() => { setNotice(undefined); setVerifying(x); }}>Verifikasi</Button> : null}
                      {x.status === 'OPEN' && x.cashierId !== s.me.user.id ? <Button size="sm" variant="outline" onClick={() => { setNotice(undefined); setClosing(x); }}>Tutup shift</Button> : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {verifying ? <VerifyDialog shift={verifying} onClose={() => setVerifying(undefined)} onDone={() => done(`Shift ${verifying.cashierName} diverifikasi.`)} /> : null}
      {closing ? <ForceCloseDialog shift={closing} onClose={() => setClosing(undefined)} onDone={() => done(`Shift ${closing.cashierName} ditutup.`)} /> : null}
    </div>
  );
}

function VerifyDialog({ shift, onClose, onDone }: { shift: CashierShift; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { await api(`/cashier-shifts/${shift.id}/verify`, { method: 'POST', body: { note: note.trim() || undefined } }); onDone(); }
    catch (x) { setError(errorText(x, 'Gagal memverifikasi')); } finally { setBusy(false); }
  }
  return (
    <Dialog open title={`Verifikasi shift ${shift.cashierName}`} onClose={onClose}>
      <form className="grid gap-3 text-sm" onSubmit={submit}>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p>Kas seharusnya {fmtRupiah(shift.expectedCash)} · dihitung {fmtRupiah(shift.countedCash)} · selisih <b>{fmtRupiah(shift.variance)}</b></p>
        <Field id="verify-note" label="Catatan verifikasi" hint={shift.overTolerance ? 'Wajib: selisih di atas toleransi klinik.' : 'Opsional.'}>
          <Input id="verify-note" maxLength={300} required={shift.overTolerance} minLength={shift.overTolerance ? 5 : undefined} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Batal</Button><Button type="submit" disabled={busy}>Verifikasi</Button></div>
      </form>
    </Dialog>
  );
}

function ForceCloseDialog({ shift, onClose, onDone }: { shift: CashierShift; onClose: () => void; onDone: () => void }) {
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { await api(`/cashier-shifts/${shift.id}/force-close`, { method: 'POST', body: { countedCash: Number(counted), note: note.trim() } }); onDone(); }
    catch (x) { setError(errorText(x, 'Gagal menutup shift')); } finally { setBusy(false); }
  }
  return (
    <Dialog open title={`Tutup shift ${shift.cashierName}`} onClose={onClose}>
      <form className="grid gap-3 text-sm" onSubmit={submit}>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p>Shift dibuka {fmtDateTime(shift.openedAt)} · kas seharusnya <b>{fmtRupiah(shift.expectedCash)}</b></p>
        <Field id="fc-counted" label="Kas fisik dihitung (Rp)"><Input id="fc-counted" type="number" min="0" step="1" required value={counted} onChange={(e) => setCounted(e.target.value)} /></Field>
        <Field id="fc-note" label="Keterangan" hint="Wajib, mis. alasan shift tidak ditutup kasir.">
          <Input id="fc-note" required minLength={5} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Batal</Button><Button type="submit" disabled={busy}>Tutup shift</Button></div>
      </form>
    </Dialog>
  );
}
