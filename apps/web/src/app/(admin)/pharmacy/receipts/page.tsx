'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Dialog, Field, Input, Select, TBody, TD, TH, THead, TR, Table, Textarea } from '@clinicrme/ui';
import { Drug, GoodsReceipt, Page, StockLocation, Supplier, Uom, api, errorText } from '../../../../lib/api';
import { fmtDate, fmtDateTime, fmtRupiah, todayWib } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

/**
 * Penerimaan barang dari supplier (PHM-FR-003): satu faktur, banyak baris batch + kedaluwarsa. Jumlah dicatat dalam
 * satuan yang diterima lalu dikonversi ke satuan dasar obat. Penerimaan tidak dapat diubah; koreksi lewat penyesuaian stok.
 */
export default function ReceiptsPage() {
  const s = useSession();
  const canReceive = can(s, 'pharmacy.stock.receive');
  const [items, setItems] = useState<GoodsReceipt[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<string>();
  const load = useCallback(async () => {
    try { setItems((await api<Page<GoodsReceipt>>('/goods-receipts?limit=100')).data); setError(undefined); }
    catch (e) { setError(errorText(e, 'Gagal memuat penerimaan')); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Penerimaan barang</h1>
        {canReceive ? <Button className="ml-auto" onClick={() => { setNotice(undefined); setCreating(true); }}>Terima barang</Button> : null}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada penerimaan.</p> : (
            <Table>
              <THead><TR><TH>Nomor</TH><TH>Diterima</TH><TH>Supplier · faktur</TH><TH>Lokasi</TH><TH className="text-right">Total</TH><TH /></TR></THead>
              <TBody>
                {items.map((g) => (
                  <TR key={g.id} data-testid="receipt-row">
                    <TD className="font-mono text-xs">{g.receiptNo}</TD>
                    <TD className="text-xs">{fmtDateTime(g.receivedAt)}<span className="block text-muted-foreground">{g.receivedByName ?? ''}</span></TD>
                    <TD>{g.supplierName}<span className="block text-xs text-muted-foreground">Faktur {g.invoiceNo}{g.invoiceDate ? ` · ${fmtDate(g.invoiceDate)}` : ''}</span></TD>
                    <TD className="text-xs">{g.locationName} · {g.branchName}</TD>
                    <TD className="text-right tabular-nums">{fmtRupiah(g.total)}<span className="block text-xs text-muted-foreground">{g.lineCount} baris</span></TD>
                    <TD className="text-right"><Button size="sm" variant="ghost" onClick={() => setViewing(g.id)}>Lihat</Button></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {creating ? <ReceiveDialog onClose={() => setCreating(false)}
                                 onSaved={async (g) => { setCreating(false); setNotice(`Penerimaan ${g.receiptNo} tersimpan; stok bertambah.`); await load(); }} /> : null}
      {viewing ? <ViewDialog id={viewing} onClose={() => setViewing(undefined)} /> : null}
    </div>
  );
}

interface Line { drug?: Drug; batchNo: string; expiryDate: string; qty: string; uomId: string; unitPrice: string }
const emptyLine = (): Line => ({ batchNo: '', expiryDate: '', qty: '', uomId: '', unitPrice: '' });
/** "25.000" → 25000 (pemisah ribuan), "1,5" / "1.5" → 1.5. */
const num = (v: string) => {
  const t = v.trim();
  return Number(/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(',', '.'));
};

function ReceiveDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (g: GoodsReceipt) => Promise<void> }) {
  const s = useSession();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [uoms, setUoms] = useState<Uom[]>([]);
  const [head, setHead] = useState({ supplierId: '', locationId: '', invoiceNo: '', invoiceDate: todayWib(), notes: '' });
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => `gr-${crypto.randomUUID()}`);
  useEffect(() => {
    const branchId = s.me.activeBranchId;
    void Promise.all([
      // Tanpa cabang aktif: semua lokasi (nama cabang ditampilkan)
      api<Supplier[]>('/suppliers'), api<StockLocation[]>(branchId ? `/stock-locations?branchId=${branchId}` : '/stock-locations'), api<Uom[]>('/uoms'),
    ]).then(([sp, ls, us]) => {
      setSuppliers(sp.filter((x) => x.isActive));
      const active = ls.filter((l) => l.isActive);
      setLocations(active);
      setUoms(us);
      setHead((h) => ({ ...h, locationId: h.locationId || active.find((l) => l.isDefault)?.id || active[0]?.id || '' }));
    }).catch((e) => setError(errorText(e, 'Gagal memuat data pendukung')));
  }, [s.me.activeBranchId]);
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((t, l) => t + (num(l.qty) || 0) * (num(l.unitPrice) || 0), 0);
  const valid = head.supplierId && head.locationId && head.invoiceNo.trim() &&
    lines.every((l) => l.drug && l.batchNo.trim() && l.expiryDate && num(l.qty) > 0 && l.uomId && num(l.unitPrice) >= 0 && l.unitPrice.trim() !== '');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(undefined); setFieldErrors({}); setBusy(true);
    try {
      const g = await api<GoodsReceipt>('/goods-receipts', { method: 'POST', headers: { 'idempotency-key': key }, body: {
        supplierId: head.supplierId, locationId: head.locationId, invoiceNo: head.invoiceNo.trim(), invoiceDate: head.invoiceDate || null,
        notes: head.notes.trim() || null,
        lines: lines.map((l) => ({ drugItemId: l.drug!.id, batchNo: l.batchNo.trim(), expiryDate: l.expiryDate, qty: num(l.qty), uomId: l.uomId, unitPrice: num(l.unitPrice) })),
      } });
      await onSaved(g);
    } catch (err) {
      setError(errorText(err, 'Gagal menyimpan penerimaan'));
      const p = (err as { problem?: { errors?: { field: string; message: string }[] } }).problem;
      setFieldErrors(Object.fromEntries((p?.errors ?? []).map((x) => [x.field, x.message])));
    } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title="Terima barang">
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="gr-sup" label="Supplier *">
            <Select id="gr-sup" value={head.supplierId} onChange={(e) => setHead({ ...head, supplierId: e.target.value })}>
              <option value="">Pilih supplier…</option>
              {suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
          <Field id="gr-loc" label="Lokasi penyimpanan *">
            <Select id="gr-loc" value={head.locationId} onChange={(e) => setHead({ ...head, locationId: e.target.value })}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}{s.me.activeBranchId ? '' : ` · ${l.branchName}`}</option>)}
            </Select>
          </Field>
          <Field id="gr-inv" label="Nomor faktur *"><Input id="gr-inv" maxLength={50} value={head.invoiceNo} onChange={(e) => setHead({ ...head, invoiceNo: e.target.value })} /></Field>
          <Field id="gr-invdate" label="Tanggal faktur"><Input id="gr-invdate" type="date" value={head.invoiceDate} onChange={(e) => setHead({ ...head, invoiceDate: e.target.value })} /></Field>
        </div>
        <div className="grid gap-2">
          {lines.map((l, i) => (
            <fieldset key={i} className="grid gap-2 rounded-md border p-3 sm:grid-cols-6" data-testid="receipt-line">
              <legend className="px-1 text-xs text-muted-foreground">Baris {i + 1}</legend>
              <div className="sm:col-span-3"><DrugPicker id={`gr-drug-${i}`} value={l.drug} error={fieldErrors[`lines.${i}.drugItemId`]}
                onChange={(d) => setLine(i, { drug: d, uomId: d?.baseUomId ?? '' })} /></div>
              <Field id={`gr-batch-${i}`} label="No. batch *"><Input id={`gr-batch-${i}`} maxLength={50} value={l.batchNo} onChange={(e) => setLine(i, { batchNo: e.target.value })} /></Field>
              <div className="sm:col-span-2"><Field id={`gr-exp-${i}`} label="Kedaluwarsa *" error={fieldErrors[`lines.${i}.expiryDate`]}>
                <Input id={`gr-exp-${i}`} type="date" value={l.expiryDate} onChange={(e) => setLine(i, { expiryDate: e.target.value })} /></Field></div>
              <Field id={`gr-qty-${i}`} label="Jumlah *"><Input id={`gr-qty-${i}`} inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></Field>
              <div className="sm:col-span-2"><Field id={`gr-uom-${i}`} label="Satuan *" error={fieldErrors[`lines.${i}.uomId`]}>
                <Select id={`gr-uom-${i}`} value={l.uomId} onChange={(e) => setLine(i, { uomId: e.target.value })}>
                  <option value="">Pilih…</option>
                  {uoms.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </Select>
              </Field></div>
              <div className="sm:col-span-2"><Field id={`gr-price-${i}`} label="Harga beli per satuan *">
                <Input id={`gr-price-${i}`} inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} /></Field></div>
              <div className="flex items-end justify-end">
                {lines.length > 1 ? <Button type="button" size="sm" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Hapus</Button> : null}
              </div>
            </fieldset>
          ))}
          <div><Button type="button" size="sm" variant="outline" onClick={() => setLines([...lines, emptyLine()])}>Tambah baris</Button></div>
        </div>
        <Field id="gr-notes" label="Catatan"><Textarea id="gr-notes" maxLength={500} rows={2} value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} /></Field>
        <p className="text-sm">Total faktur: <strong>{fmtRupiah(String(Math.round(total)))}</strong></p>
        <p className="text-xs text-muted-foreground">Penerimaan tidak dapat diubah setelah disimpan. Periksa batch, kedaluwarsa, dan jumlah sebelum menyimpan.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" disabled={!valid || busy}>Simpan penerimaan</Button>
        </div>
      </form>
    </Dialog>
  );
}

function DrugPicker({ id, value, error, onChange }: { id: string; value?: Drug; error?: string; onChange: (d?: Drug) => void }) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState<Drug[]>([]);
  useEffect(() => {
    if (value || q.trim().length < 2) { setOpts([]); return; }
    const t = setTimeout(() => void api<Page<Drug>>(`/drugs?limit=10&q=${encodeURIComponent(q.trim())}`).then((p) => setOpts(p.data)).catch(() => setOpts([])), 250);
    return () => clearTimeout(t);
  }, [q, value]);
  if (value) {
    return (
      <Field id={id} label="Obat *" error={error}>
        <div className="flex items-center gap-2 text-sm" id={id}>
          <span className="font-medium">{value.genericName}</span><span className="text-xs text-muted-foreground">satuan dasar {value.uomName}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => { onChange(undefined); setQ(''); }}>Ganti</Button>
        </div>
      </Field>
    );
  }
  return (
    <Field id={id} label="Obat *" error={error}>
      <div className="relative">
        <Input id={id} placeholder="Ketik nama/kode obat" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        {opts.length ? (
          <ul className="absolute z-10 mt-1 w-full rounded-md border bg-background shadow" role="listbox">
            {opts.map((d) => (
              <li key={d.id}><button type="button" role="option" aria-selected={false} className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => onChange(d)}>{d.genericName} <span className="text-xs text-muted-foreground">{d.code}</span></button></li>
            ))}
          </ul>
        ) : null}
      </div>
    </Field>
  );
}

function ViewDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [g, setG] = useState<GoodsReceipt>();
  const [error, setError] = useState<string>();
  useEffect(() => { void api<GoodsReceipt>(`/goods-receipts/${id}`).then(setG).catch((e) => setError(errorText(e, 'Gagal memuat penerimaan'))); }, [id]);
  return (
    <Dialog open onClose={onClose} title={g ? `Penerimaan ${g.receiptNo}` : 'Penerimaan'}>
      <div className="grid gap-3">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {!g ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : (
          <>
            <p className="text-sm">{g.supplierName} · faktur {g.invoiceNo} · {g.locationName} · {fmtDateTime(g.receivedAt)}</p>
            {g.notes ? <p className="text-sm text-muted-foreground">{g.notes}</p> : null}
            <Table>
              <THead><TR><TH>Obat</TH><TH>Batch</TH><TH>ED</TH><TH className="text-right">Jumlah</TH><TH className="text-right">Harga</TH></TR></THead>
              <TBody>
                {(g.lines ?? []).map((l) => (
                  <TR key={l.id}>
                    <TD>{l.drugName}</TD><TD className="font-mono text-xs">{l.batchNo}</TD><TD className="text-xs">{fmtDate(l.expiryDate)}</TD>
                    <TD className="text-right text-xs">{l.qty} {l.uomName}{l.uomName !== l.baseUomName ? ` (= ${l.qtyBase} ${l.baseUomName})` : ''}</TD>
                    <TD className="text-right text-xs">{fmtRupiah(l.unitPrice)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <p className="text-sm">Total: <strong>{fmtRupiah(g.total)}</strong></p>
          </>
        )}
        <div className="flex justify-end"><Button variant="outline" onClick={onClose}>Tutup</Button></div>
      </div>
    </Dialog>
  );
}
