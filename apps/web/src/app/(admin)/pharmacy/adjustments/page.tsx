'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Dialog, Field, Input, Select, TBody, TD, TH, THead, TR, Table, Textarea } from '@clinicrme/ui';
import { Drug, StockAdjustment, StockDetail, api, errorText } from '../../../../lib/api';
import { fmtDate, fmtDateTime } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';
import { DrugPicker } from '../drug-picker';

const STATUS_LABEL: Record<StockAdjustment['status'], string> = { REQUESTED: 'Menunggu persetujuan', APPROVED: 'Disetujui', REJECTED: 'Ditolak' };
const REASONS = ['Rusak / pecah', 'Kedaluwarsa dimusnahkan', 'Hilang', 'Salah input penerimaan', 'Ditemukan (tidak tercatat)'];
const qty = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 4 });

/**
 * Penyesuaian stok maker–checker (PHM-FR-016): pengajuan beralasan oleh petugas farmasi, persetujuan oleh orang lain
 * (mis. manajer). Mutasi ADJUSTMENT baru tercatat setelah disetujui.
 */
export default function AdjustmentsPage() {
  const s = useSession();
  const canRequest = can(s, 'pharmacy.stock.adjust');
  const canApprove = can(s, 'pharmacy.stock.approve');
  const [status, setStatus] = useState<'' | StockAdjustment['status']>('REQUESTED');
  const [items, setItems] = useState<StockAdjustment[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [deciding, setDeciding] = useState<StockAdjustment>();
  const load = useCallback(async () => {
    try { setItems(await api<StockAdjustment[]>(`/stock-adjustments${status ? `?status=${status}` : ''}`)); setError(undefined); }
    catch (e) { setError(errorText(e, 'Gagal memuat penyesuaian')); }
  }, [status]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Penyesuaian stok</h1>
        <Select aria-label="Status" className="w-56" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="">Semua status</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        {canRequest ? <Button className="ml-auto" onClick={() => { setNotice(undefined); setCreating(true); }}>Ajukan penyesuaian</Button> : null}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada penyesuaian.</p> : (
            <Table>
              <THead><TR><TH>Diajukan</TH><TH>Obat · batch · lokasi</TH><TH className="text-right">Selisih</TH><TH>Alasan</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {items.map((a) => (
                  <TR key={a.id} data-testid="adjustment-row">
                    <TD className="text-xs">{fmtDateTime(a.createdAt)}<span className="block text-muted-foreground">{a.requestedByName}</span></TD>
                    <TD>{a.drug.name}<span className="block text-xs text-muted-foreground">{a.batch.batchNo} (ED {fmtDate(a.batch.expiryDate)}) · {a.location.name} · saldo {qty(a.qtyOnHand)}</span></TD>
                    <TD className={`text-right tabular-nums ${a.qtyDelta < 0 ? 'text-destructive' : ''}`}>{a.qtyDelta > 0 ? '+' : ''}{qty(a.qtyDelta)} {a.drug.uomName}</TD>
                    <TD className="text-xs">{a.reason}{a.decisionNote ? <span className="block text-muted-foreground">Catatan: {a.decisionNote}</span> : null}</TD>
                    <TD><Badge tone={a.status === 'REQUESTED' ? 'warning' : a.status === 'APPROVED' ? 'success' : 'neutral'}>{STATUS_LABEL[a.status]}</Badge>
                      {a.approvedByName ? <span className="block text-xs text-muted-foreground">{a.approvedByName}</span> : null}</TD>
                    <TD className="text-right">{canApprove && a.status === 'REQUESTED' && !a.mine
                      ? <Button size="sm" onClick={() => { setNotice(undefined); setDeciding(a); }}>Putuskan</Button>
                      : a.status === 'REQUESTED' && a.mine ? <span className="text-xs text-muted-foreground">Menunggu orang lain</span> : null}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {creating ? <CreateDialog onClose={() => setCreating(false)} onDone={async () => { setCreating(false); setNotice('Penyesuaian diajukan; menunggu persetujuan.'); await load(); }} /> : null}
      {deciding ? <DecideDialog a={deciding} onClose={() => setDeciding(undefined)} onDone={async (m) => { setDeciding(undefined); setNotice(m); await load(); }} /> : null}
    </div>
  );
}

function CreateDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const s = useSession();
  const [drug, setDrug] = useState<Drug>();
  const [detail, setDetail] = useState<StockDetail>();
  const [batchKey, setBatchKey] = useState('');
  const [dir, setDir] = useState<'-' | '+'>('-');
  const [amount, setAmount] = useState('');
  const [preset, setPreset] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    setDetail(undefined); setBatchKey('');
    if (!drug) return;
    const b = s.me.activeBranchId;
    void api<StockDetail>(`/stock/${drug.id}${b ? `?branchId=${b}` : ''}`).then(setDetail).catch((e) => setError(errorText(e, 'Gagal memuat batch')));
  }, [drug, s.me.activeBranchId]);
  const picked = detail?.batches.find((b) => `${b.batchId}|${b.locationId}` === batchKey);
  const n = Number(amount.replace(',', '.'));
  const text = [preset, reason.trim()].filter(Boolean).join(' — ');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(undefined);
    try {
      await api('/stock-adjustments', { method: 'POST', body: { batchId: picked!.batchId, locationId: picked!.locationId, qtyDelta: dir === '-' ? -n : n, reason: text } });
      await onDone();
    } catch (err) { setError(errorText(err, 'Gagal mengajukan penyesuaian')); }
  }
  return (
    <Dialog open onClose={onClose} title="Ajukan penyesuaian stok">
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <DrugPicker id="adj-drug" value={drug} onChange={setDrug} />
        {drug ? (
          <Field id="adj-batch" label="Batch & lokasi *">
            <Select id="adj-batch" value={batchKey} onChange={(e) => setBatchKey(e.target.value)}>
              <option value="">{detail ? (detail.batches.length ? 'Pilih batch…' : 'Tidak ada batch bersaldo') : 'Memuat…'}</option>
              {detail?.batches.map((b) => <option key={`${b.batchId}|${b.locationId}`} value={`${b.batchId}|${b.locationId}`}>
                {b.batchNo} · ED {fmtDate(b.expiryDate)} · {b.locationName} · saldo {qty(b.qtyOnHand)}</option>)}
            </Select>
          </Field>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="adj-dir" label="Jenis">
            <Select id="adj-dir" value={dir} onChange={(e) => setDir(e.target.value as '-' | '+')}>
              <option value="-">Kurangi stok</option><option value="+">Tambah stok</option>
            </Select>
          </Field>
          <Field id="adj-qty" label={`Jumlah${drug ? ` (${drug.uomName})` : ''} *`}
                 error={picked && dir === '-' && n > picked.qtyOnHand ? 'Melebihi saldo batch' : undefined}>
            <Input id="adj-qty" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </div>
        <Field id="adj-preset" label="Alasan *">
          <Select id="adj-preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="">Pilih alasan…</option>{REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
        <Field id="adj-reason" label="Keterangan"><Textarea id="adj-reason" rows={2} maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <p className="text-xs text-muted-foreground">Stok berubah setelah penyesuaian disetujui orang lain.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" disabled={!picked || !(n > 0) || text.length < 5 || (dir === '-' && n > picked.qtyOnHand)}>Ajukan</Button>
        </div>
      </form>
    </Dialog>
  );
}

function DecideDialog({ a, onClose, onDone }: { a: StockAdjustment; onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  async function decide(decision: 'APPROVE' | 'REJECT') {
    setError(undefined);
    try {
      await api(`/stock-adjustments/${a.id}/decision`, { method: 'POST', body: { decision, note: note.trim() || null } });
      await onDone(decision === 'APPROVE' ? 'Penyesuaian disetujui; stok diperbarui.' : 'Penyesuaian ditolak.');
    } catch (e) { setError(errorText(e, 'Gagal menyimpan keputusan')); }
  }
  return (
    <Dialog open onClose={onClose} title="Putuskan penyesuaian stok">
      <div className="grid gap-3 text-sm">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p><strong>{a.drug.name}</strong> · batch {a.batch.batchNo} · {a.location.name}</p>
        <p>Selisih: <strong>{a.qtyDelta > 0 ? '+' : ''}{qty(a.qtyDelta)} {a.drug.uomName}</strong> (saldo sekarang {qty(a.qtyOnHand)})</p>
        <p>Alasan: {a.reason} — {a.requestedByName}</p>
        <Field id="dec-note" label="Catatan (wajib bila ditolak)"><Input id="dec-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Batal</Button>
          <Button variant="destructive" disabled={note.trim().length < 5} onClick={() => void decide('REJECT')}>Tolak</Button>
          <Button onClick={() => void decide('APPROVE')}>Setujui</Button>
        </div>
      </div>
    </Dialog>
  );
}
