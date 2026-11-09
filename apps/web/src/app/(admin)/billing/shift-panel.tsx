'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Dialog, Field, Input, Select } from '@clinicrme/ui';
import { CashierShift, api, errorText } from '../../../lib/api';
import { PAYMENT_METHOD_LABEL, fmtDateTime, fmtRupiah } from '../../../lib/format';
import { useSession } from '../../../lib/session';

/**
 * Shift kasir (BIL-FR-011; OD-111): buka dengan kas awal, ringkasan per metode, tutup dengan kas fisik. Pembayaran hanya
 * dapat dicatat saat shift terbuka; selisih di atas toleransi klinik wajib keterangan.
 */
export function ShiftPanel({ onChange }: { onChange?: (s: CashierShift | null) => void }) {
  const s = useSession();
  const [shift, setShift] = useState<CashierShift | null>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await api<{ shift: CashierShift | null }>('/cashier-shifts/current');
      setShift(r.shift); onChange?.(r.shift); setError(undefined);
    } catch (e) { setError(errorText(e, 'Gagal memuat shift')); }
  }, [onChange]);
  useEffect(() => { void load(); }, [load]);
  if (shift === undefined) return error ? <Alert tone="error">{error}</Alert> : null;
  return (
    <Card data-testid="shift-panel">
      <CardContent className="grid gap-2 pt-6 text-sm">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {!shift ? (
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="warning">Shift belum dibuka</Badge>
            <span className="text-muted-foreground">Pembayaran hanya dapat diterima setelah shift dibuka.</span>
            <Button size="sm" className="ml-auto" onClick={() => { setNotice(undefined); setOpening(true); }}>Buka shift</Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <Badge tone="success">Shift terbuka</Badge>
            <span>{shift.branchName} · sejak {fmtDateTime(shift.openedAt)}</span>
            <span>Kas awal <b className="tabular-nums">{fmtRupiah(shift.openingCash)}</b></span>
            {shift.totals.map((t) => <span key={t.method}>{PAYMENT_METHOD_LABEL[t.method]} ({t.count}) <b className="tabular-nums">{fmtRupiah(t.total)}</b></span>)}
            <span>Kas seharusnya <b className="tabular-nums" data-testid="expected-cash">{fmtRupiah(shift.expectedCash)}</b></span>
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => { setNotice(undefined); setClosing(true); }}>Tutup shift</Button>
          </div>
        )}
      </CardContent>
      {opening ? <OpenDialog branches={s.me.branches} activeBranchId={s.me.activeBranchId ?? null} onClose={() => setOpening(false)}
        onDone={(x) => { setOpening(false); setShift(x); onChange?.(x); setNotice('Shift dibuka.'); }} /> : null}
      {closing && shift ? <CloseDialog shift={shift} onClose={() => setClosing(false)}
        onDone={(x) => {
          setClosing(false); setShift(null); onChange?.(null);
          setNotice(`Shift ditutup. Kas seharusnya ${fmtRupiah(x.expectedCash)}, dihitung ${fmtRupiah(x.countedCash)}, selisih ${fmtRupiah(x.variance)}.`);
        }} /> : null}
    </Card>
  );
}

function OpenDialog({ branches, activeBranchId, onClose, onDone }: {
  branches: { id: string; name: string }[]; activeBranchId: string | null; onClose: () => void; onDone: (s: CashierShift) => void;
}) {
  const [branchId, setBranchId] = useState(activeBranchId ?? (branches.length === 1 ? branches[0].id : ''));
  const [cash, setCash] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { onDone(await api<CashierShift>('/cashier-shifts', { method: 'POST', body: { branchId: branchId || undefined, openingCash: Number(cash) || 0 } })); }
    catch (x) { setError(errorText(x, 'Gagal membuka shift')); } finally { setBusy(false); }
  }
  return (
    <Dialog open title="Buka shift kasir" onClose={onClose}>
      <form className="grid gap-3" onSubmit={submit}>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="shift-branch" label="Cabang"><Select id="shift-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} required>
          <option value="">— pilih —</option>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select></Field>
        <Field id="shift-opening" label="Kas awal (Rp)"><Input id="shift-opening" type="number" min="0" step="1" required value={cash} onChange={(e) => setCash(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Batal</Button><Button type="submit" disabled={busy || !branchId}>Buka shift</Button></div>
      </form>
    </Dialog>
  );
}

function CloseDialog({ shift, onClose, onDone }: { shift: CashierShift; onClose: () => void; onDone: (s: CashierShift) => void }) {
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const variance = counted === '' ? null : Number(counted) - Number(shift.expectedCash);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      onDone(await api<CashierShift>(`/cashier-shifts/${shift.id}/close`, { method: 'POST', body: { countedCash: Number(counted), varianceNote: note || undefined } }));
    } catch (x) { setError(errorText(x, 'Gagal menutup shift')); } finally { setBusy(false); }
  }
  return (
    <Dialog open title="Tutup shift kasir" onClose={onClose}>
      <form className="grid gap-3" onSubmit={submit}>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p className="text-sm">Kas seharusnya: <b className="tabular-nums">{fmtRupiah(shift.expectedCash)}</b> (kas awal + pembayaran tunai)</p>
        <Field id="shift-counted" label="Kas fisik dihitung (Rp)"><Input id="shift-counted" type="number" min="0" step="1" required value={counted} onChange={(e) => setCounted(e.target.value)} /></Field>
        {variance !== null ? <p className="text-sm" data-testid="variance">Selisih: <b className="tabular-nums">{fmtRupiah(variance.toFixed(2))}</b></p> : null}
        <Field id="shift-note" label="Keterangan selisih" hint="Wajib bila selisih melebihi toleransi klinik.">
          <Input id="shift-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Batal</Button><Button type="submit" disabled={busy || counted === ''}>Tutup shift</Button></div>
      </form>
    </Dialog>
  );
}
