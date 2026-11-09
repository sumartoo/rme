'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Dialog, Field, Input, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { StockLocation, StockOpname, api, errorText } from '../../../../lib/api';
import { fmtDate, fmtDateTime } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

const STATUS_LABEL: Record<StockOpname['status'], string> = { COUNTING: 'Menghitung', SUBMITTED: 'Menunggu persetujuan', APPROVED: 'Disetujui', CANCELLED: 'Dibatalkan' };
const TONE: Record<StockOpname['status'], 'warning' | 'success' | 'neutral'> = { COUNTING: 'warning', SUBMITTED: 'warning', APPROVED: 'success', CANCELLED: 'neutral' };
const qty = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 4 });

/**
 * Stock opname per lokasi (PHM-FR-017): hitung fisik per batch, kirim, lalu disetujui orang lain; selisih menjadi mutasi
 * OPNAME. Saldo sistem dicatat saat baris dihitung, jadi transaksi setelah penghitungan tetap tercatat apa adanya.
 */
export default function OpnamePage() {
  const s = useSession();
  const canCount = can(s, 'pharmacy.stock.opname');
  const [items, setItems] = useState<StockOpname[]>();
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [locationId, setLocationId] = useState('');
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const load = useCallback(async () => {
    try { setItems(await api<StockOpname[]>('/stock-opnames')); setError(undefined); } catch (e) { setError(errorText(e, 'Gagal memuat stock opname')); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!can(s, 'master.facility.read')) return;
    const b = s.me.activeBranchId;
    void api<StockLocation[]>(b ? `/stock-locations?branchId=${b}` : '/stock-locations').then((ls) => {
      const act = ls.filter((l) => l.isActive);
      setLocations(act); setLocationId((x) => x || act.find((l) => l.isDefault)?.id || act[0]?.id || '');
    }).catch(() => undefined);
  }, [s]);
  async function start() {
    setError(undefined);
    try { const o = await api<StockOpname>('/stock-opnames', { method: 'POST', body: { locationId } }); await load(); setOpen(o.id); }
    catch (e) { setError(errorText(e, 'Gagal memulai stock opname')); }
  }
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Stock opname</h1>
        {canCount && locations.length ? (
          <div className="ml-auto flex items-center gap-2">
            <Select aria-label="Lokasi opname" className="w-48" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}{s.me.activeBranchId ? '' : ` · ${l.branchName}`}</option>)}
            </Select>
            <Button disabled={!locationId} onClick={() => void start()}>Mulai opname</Button>
          </div>
        ) : null}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada stock opname.</p> : (
            <Table>
              <THead><TR><TH>Dimulai</TH><TH>Lokasi</TH><TH>Progres</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {items.map((o) => (
                  <TR key={o.id} data-testid="opname-row">
                    <TD className="text-xs">{fmtDateTime(o.startedAt)}<span className="block text-muted-foreground">{o.startedByName}</span></TD>
                    <TD>{o.location.name}<span className="block text-xs text-muted-foreground">{o.location.branchName}</span></TD>
                    <TD className="text-xs">{o.countedCount}/{o.lineCount} batch dihitung · {o.diffCount} selisih</TD>
                    <TD><Badge tone={TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge>{o.approvedByName ? <span className="block text-xs text-muted-foreground">{o.approvedByName}</span> : null}</TD>
                    <TD className="text-right"><Button size="sm" variant="outline" onClick={() => setOpen(o.id)}>Buka</Button></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {open ? <OpnameDialog id={open} onClose={() => { setOpen(undefined); void load(); }} /> : null}
    </div>
  );
}

function OpnameDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useSession();
  const canCount = can(s, 'pharmacy.stock.opname');
  const canApprove = can(s, 'pharmacy.stock.approve');
  const restrictedOk = can(s, 'pharmacy.restricted.dispense');
  const [o, setO] = useState<StockOpname>();
  const [form, setForm] = useState<Record<string, { counted: string; note: string }>>({});
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [note, setNote] = useState('');
  const apply = (x: StockOpname) => {
    setO(x);
    setForm(Object.fromEntries((x.lines ?? []).map((l) => [l.batchId, { counted: l.countedQty === null ? '' : String(l.countedQty), note: l.note ?? '' }])));
  };
  const load = useCallback(async () => {
    try { apply(await api<StockOpname>(`/stock-opnames/${id}`)); } catch (e) { setError(errorText(e, 'Gagal memuat stock opname')); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const call = async (path: string, body: unknown, msg: string, method = 'POST') => {
    setError(undefined); setNotice(undefined);
    try { apply(await api<StockOpname>(path, { method, headers: { 'if-match': String(o!.version) }, body })); setNotice(msg); }
    catch (e) { setError(errorText(e, 'Gagal menyimpan')); await load(); }
  };
  const changed = (o?.lines ?? []).filter((l) => {
    const f = form[l.batchId];
    return f && f.counted.trim() !== '' && (String(l.countedQty ?? '') !== f.counted.trim().replace(',', '.') || (l.note ?? '') !== f.note);
  });
  const counting = o?.status === 'COUNTING' && canCount;
  return (
    <Dialog open onClose={onClose} title={o ? `Stock opname — ${o.location.name}` : 'Stock opname'}>
      <div className="grid gap-3" data-testid="opname-dialog">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {!o ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : (
          <>
            <p className="text-sm">Status: <Badge tone={TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge> · dimulai {o.startedByName}, {fmtDateTime(o.startedAt)}
              {o.decisionNote ? <span className="block text-xs">Catatan penyetuju: {o.decisionNote}</span> : null}</p>
            {(o.lines ?? []).length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada batch bersaldo di lokasi ini.</p> : (
              <Table>
                <THead><TR><TH>Obat · batch</TH><TH className="text-right">Sistem</TH><TH className="w-28">Hitung fisik</TH><TH className="text-right">Selisih</TH><TH>Catatan</TH></TR></THead>
                <TBody>
                  {(o.lines ?? []).map((l) => {
                    const f = form[l.batchId] ?? { counted: '', note: '' };
                    const c = f.counted.trim() === '' ? null : Number(f.counted.replace(',', '.'));
                    const diff = c === null ? null : Math.round((c - l.systemQty) * 10_000) / 10_000;
                    const locked = !counting || (l.restricted && !restrictedOk);
                    return (
                      <TR key={l.batchId} data-testid="opname-line">
                        <TD>{l.drugName} {l.restricted ? <Badge tone="danger">Terbatas</Badge> : null}
                          <span className="block text-xs text-muted-foreground">{l.batchNo} · ED {fmtDate(l.expiryDate)}{l.countedByName ? ` · dihitung ${l.countedByName}` : ''}</span></TD>
                        <TD className="text-right tabular-nums">{qty(l.systemQty)} <span className="text-xs text-muted-foreground">{l.uomName}</span></TD>
                        <TD><Input aria-label={`Hitung ${l.drugName} ${l.batchNo}`} inputMode="decimal" disabled={locked} value={f.counted}
                          onChange={(e) => setForm({ ...form, [l.batchId]: { ...f, counted: e.target.value } })} /></TD>
                        <TD className={`text-right tabular-nums ${diff ? 'font-medium text-destructive' : ''}`}>{diff === null ? '—' : `${diff > 0 ? '+' : ''}${qty(diff)}`}</TD>
                        <TD><Input aria-label={`Catatan ${l.drugName} ${l.batchNo}`} disabled={locked} maxLength={300} value={f.note}
                          placeholder={diff ? 'Wajib: penyebab selisih' : ''} onChange={(e) => setForm({ ...form, [l.batchId]: { ...f, note: e.target.value } })} /></TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
            {counting ? (
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={() => void call(`/stock-opnames/${id}/cancel`, undefined, 'Stock opname dibatalkan.')}>Batalkan opname</Button>
                <Button variant="outline" disabled={!changed.length} onClick={() => void call(`/stock-opnames/${id}/counts`, {
                  lines: changed.map((l) => ({ batchId: l.batchId, countedQty: Number(form[l.batchId].counted.replace(',', '.')), note: form[l.batchId].note.trim() || null })),
                }, 'Hasil hitung disimpan.', 'PUT')}>Simpan hitungan</Button>
                <Button disabled={changed.length > 0} onClick={() => void call(`/stock-opnames/${id}/submit`, undefined, 'Hasil opname dikirim untuk disetujui.')}>Kirim untuk disetujui</Button>
              </div>
            ) : null}
            {o.status === 'SUBMITTED' && canApprove ? (
              o.mine ? <p className="text-xs text-muted-foreground">Menunggu persetujuan orang lain (Anda yang memulai opname ini).</p> : (
                <div className="grid gap-2">
                  <Field id="op-note" label="Catatan (wajib bila ditolak)"><Input id="op-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                  <div className="flex justify-end gap-2">
                    <Button variant="destructive" disabled={note.trim().length < 5} onClick={() => void call(`/stock-opnames/${id}/decision`, { decision: 'REJECT', note: note.trim() }, 'Dikembalikan untuk dihitung ulang.')}>Tolak, hitung ulang</Button>
                    <Button onClick={() => void call(`/stock-opnames/${id}/decision`, { decision: 'APPROVE', note: note.trim() || null }, 'Opname disetujui; selisih dicatat sebagai mutasi stok.')}>Setujui</Button>
                  </div>
                </div>
              )
            ) : null}
          </>
        )}
        <div className="flex justify-end"><Button variant="outline" onClick={onClose}>Tutup</Button></div>
      </div>
    </Dialog>
  );
}
