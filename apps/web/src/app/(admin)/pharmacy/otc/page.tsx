'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Dialog, Field, Input, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { ApiError, Drug, OtcSale, api, errorText } from '../../../../lib/api';
import { fmtDate, fmtDateTime, fmtRupiah, todayWib } from '../../../../lib/format';
import { useSession } from '../../../../lib/session';
import { DrugPicker } from '../drug-picker';

const STATUS_LABEL: Record<OtcSale['status'], string> = { AWAITING_PAYMENT: 'Menunggu bayar', PAID: 'Lunas', CANCELLED: 'Dibatalkan' };
const TONE: Record<OtcSale['status'], 'warning' | 'success' | 'neutral'> = { AWAITING_PAYMENT: 'warning', PAID: 'success', CANCELLED: 'neutral' };
const OTC = ['BEBAS', 'BEBAS_TERBATAS'];
const qty = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 4 });

/**
 * Penjualan obat bebas tanpa kunjungan (PHM-FR-012; OD-101): hanya golongan Bebas & Bebas terbatas, harga Umum.
 * Penjualan berstatus menunggu bayar dan dibayar di kasir (Stage 11); batal sebelum dibayar mengembalikan stok.
 */
export default function OtcPage() {
  const s = useSession();
  const [pickedBranch, setPickedBranch] = useState('');
  // Cabang aktif; bila belum dipilih: satu-satunya cabang pengguna, atau pilih di halaman ini
  const branchId = s.me.activeBranchId ?? (s.me.branches.length === 1 ? s.me.branches[0].id : pickedBranch);
  const [date, setDate] = useState(todayWib());
  const [items, setItems] = useState<OtcSale[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<OtcSale>();
  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ date });
      if (branchId) p.set('branchId', branchId);
      setItems(await api<OtcSale[]>(`/otc-sales?${p}`)); setError(undefined);
    } catch (e) { setError(errorText(e, 'Gagal memuat penjualan')); }
  }, [date, branchId]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Penjualan obat bebas</h1>
        <Input aria-label="Tanggal" type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} />
        {!s.me.activeBranchId && s.me.branches.length > 1 ? (
          <Select aria-label="Cabang" className="w-48" value={pickedBranch} onChange={(e) => setPickedBranch(e.target.value)}>
            <option value="">Pilih cabang…</option>{s.me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        ) : null}
        <Button className="ml-auto" disabled={!branchId} onClick={() => { setNotice(undefined); setCreating(true); }}>Penjualan baru</Button>
      </div>
      {!branchId ? <Alert tone="info">Pilih cabang terlebih dahulu untuk mencatat penjualan.</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada penjualan.</p> : (
            <Table>
              <THead><TR><TH>Nomor</TH><TH>Waktu</TH><TH>Pembeli</TH><TH>Obat</TH><TH className="text-right">Total</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {items.map((o) => (
                  <TR key={o.id} data-testid="otc-row">
                    <TD className="font-mono text-xs">{o.saleNo}</TD>
                    <TD className="text-xs">{fmtDateTime(o.soldAt)}<span className="block text-muted-foreground">{o.soldByName}</span></TD>
                    <TD className="text-xs">{o.patient ? `${o.patient.name} (RM ${o.patient.mrn})` : o.customerName ?? '—'}</TD>
                    <TD className="text-xs">{[...new Set(o.lines.map((l) => l.drugName))].join(', ')}</TD>
                    <TD className="text-right tabular-nums">{fmtRupiah(o.total)}</TD>
                    <TD><Badge tone={TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge></TD>
                    <TD className="text-right"><Button size="sm" variant="ghost" onClick={() => { setNotice(undefined); setViewing(o); }}>Lihat</Button></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {creating ? <SaleDialog branchId={branchId} onClose={() => setCreating(false)}
        onDone={async (o) => { setCreating(false); setNotice(`Penjualan ${o.saleNo} tersimpan (${fmtRupiah(o.total)}) — menunggu pembayaran di kasir.`); await load(); }} /> : null}
      {viewing ? <ViewDialog o={viewing} onClose={() => setViewing(undefined)}
        onCancelled={async (o) => { setViewing(undefined); setNotice(`Penjualan ${o.saleNo} dibatalkan; stok dikembalikan.`); await load(); }} /> : null}
    </div>
  );
}

interface Line { drug?: Drug; qty: string }

function SaleDialog({ branchId, onClose, onDone }: { branchId: string; onClose: () => void; onDone: (o: OtcSale) => Promise<void> }) {
  const [lines, setLines] = useState<Line[]>([{ qty: '1' }]);
  const [customer, setCustomer] = useState('');
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => `otc-${crypto.randomUUID()}`);
  const set = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const num = (v: string) => Number(v.replace(',', '.'));
  const valid = lines.length > 0 && lines.every((l) => l.drug && OTC.includes(l.drug.drugClass) && num(l.qty) > 0);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined); setFieldErrors({});
    try {
      await onDone(await api<OtcSale>('/otc-sales', { method: 'POST', headers: { 'idempotency-key': key },
        body: { branchId, customerName: customer.trim() || null, lines: lines.map((l) => ({ drugItemId: l.drug!.id, qty: num(l.qty) })) } }));
    } catch (err) {
      setError(errorText(err, 'Gagal menyimpan penjualan'));
      if (err instanceof ApiError) setFieldErrors(Object.fromEntries((err.problem.errors ?? []).map((x) => [Number(x.field.split('.')[1]), x.message])));
    } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title="Penjualan obat bebas">
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {lines.map((l, i) => (
          <div key={i} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1fr_8rem_auto]" data-testid="otc-line">
            <div>
              <DrugPicker id={`otc-drug-${i}`} value={l.drug} onChange={(d) => set(i, { drug: d })} />
              {l.drug && !OTC.includes(l.drug.drugClass) ? <p className="text-xs text-destructive" role="alert">Golongan {l.drug.drugClass.toLowerCase()} — hanya dengan resep.</p> : null}
              {fieldErrors[i] ? <p className="text-xs text-destructive" role="alert">{fieldErrors[i]}</p> : null}
            </div>
            <Field id={`otc-qty-${i}`} label={`Jumlah${l.drug ? ` (${l.drug.uomName})` : ''}`}>
              <Input id={`otc-qty-${i}`} inputMode="decimal" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} />
            </Field>
            <div className="flex items-end">{lines.length > 1 ? <Button type="button" size="sm" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Hapus</Button> : null}</div>
          </div>
        ))}
        <div><Button type="button" size="sm" variant="outline" onClick={() => setLines([...lines, { qty: '1' }])}>Tambah obat</Button></div>
        <Field id="otc-customer" label="Nama pembeli (opsional)"><Input id="otc-customer" maxLength={200} value={customer} onChange={(e) => setCustomer(e.target.value)} /></Field>
        <p className="text-xs text-muted-foreground">Harga mengikuti harga jual Umum yang berlaku; batch dipilih otomatis (kedaluwarsa terdekat dulu). Pembayaran diterima di kasir.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" disabled={!valid || busy}>Simpan penjualan</Button>
        </div>
      </form>
    </Dialog>
  );
}

function ViewDialog({ o, onClose, onCancelled }: { o: OtcSale; onClose: () => void; onCancelled: (o: OtcSale) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [preset, setPreset] = useState('');
  const [error, setError] = useState<string>();
  const text = preset === 'LAIN' ? reason.trim() : preset;
  async function cancel() {
    setError(undefined);
    try { await onCancelled(await api<OtcSale>(`/otc-sales/${o.id}/cancel`, { method: 'POST', body: { reason: text } })); }
    catch (e) { setError(errorText(e, 'Gagal membatalkan penjualan')); }
  }
  return (
    <Dialog open onClose={onClose} title={`Penjualan ${o.saleNo}`}>
      <div className="grid gap-3 text-sm" data-testid="otc-dialog">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p>{fmtDateTime(o.soldAt)} · {o.soldByName} · {o.locationName} · <Badge tone={TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge></p>
        <Table>
          <THead><TR><TH>Obat</TH><TH>Batch</TH><TH className="text-right">Jumlah</TH><TH className="text-right">Harga</TH><TH className="text-right">Subtotal</TH></TR></THead>
          <TBody>
            {o.lines.map((l) => (
              <TR key={l.id}><TD>{l.drugName}</TD><TD className="text-xs">{l.batchNo} · ED {fmtDate(l.expiryDate)}</TD>
                <TD className="text-right">{qty(l.qtyBase)} {l.uomName}</TD><TD className="text-right">{fmtRupiah(l.unitPrice)}</TD><TD className="text-right">{fmtRupiah(l.amount)}</TD></TR>
            ))}
          </TBody>
        </Table>
        <p>Total: <strong>{fmtRupiah(o.total)}</strong></p>
        {o.cancelReason ? <p className="text-xs">Dibatalkan: {o.cancelReason}</p> : null}
        {o.status === 'AWAITING_PAYMENT' ? (
          <div className="grid gap-2 rounded-md border p-2">
            <Field id="otc-cancel" label="Batalkan penjualan — alasan">
              <Select id="otc-cancel" value={preset} onChange={(e) => setPreset(e.target.value)}>
                <option value="">Pilih alasan…</option>
                <option value="Pembeli batal membeli">Pembeli batal membeli</option>
                <option value="Salah input jumlah/obat">Salah input jumlah/obat</option>
                <option value="LAIN">Lainnya…</option>
              </Select>
            </Field>
            {preset === 'LAIN' ? <Input aria-label="Alasan lain" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /> : null}
            <div className="flex justify-end"><Button variant="destructive" disabled={text.length < 5} onClick={() => void cancel()}>Batalkan penjualan</Button></div>
          </div>
        ) : null}
        <div className="flex justify-end"><Button variant="outline" onClick={onClose}>Tutup</Button></div>
      </div>
    </Dialog>
  );
}
