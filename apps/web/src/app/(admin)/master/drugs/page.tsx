'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Dialog, Field, Input, Select, Switch, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { Drug, DrugClass, DrugPrice, Page, PayerType, Uom, api, errorText } from '../../../../lib/api';
import { PAYER_TYPE_LABEL, fmtDate, fmtRupiah, todayWib } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

const DRUG_CLASS_LABEL: Record<DrugClass, string> = {
  BEBAS: 'Bebas', BEBAS_TERBATAS: 'Bebas terbatas', KERAS: 'Keras', NARKOTIKA: 'Narkotika', PSIKOTROPIKA: 'Psikotropika',
  PREKURSOR: 'Prekursor', ALKES: 'Alat kesehatan', LAINNYA: 'Lainnya',
};

/**
 * Master obat minimal (OD-091): dipakai dokter saat meresepkan. Zat aktif menjadi dasar peringatan alergi & duplikasi;
 * batas dosis (opsional) memicu peringatan dosis — [REVIEW-MEDIS]. Kode KFA, stok minimum & harga jual (Stage 10).
 */
export default function DrugsPage() {
  const s = useSession();
  const manage = can(s, 'pharmacy.drug.manage');
  const [items, setItems] = useState<Drug[]>();
  const [q, setQ] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [editing, setEditing] = useState<Drug | 'new'>();
  const [pricing, setPricing] = useState<Drug>();
  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ limit: '200', includeInactive: 'true' });
      if (q.trim()) p.set('q', q.trim());
      setItems((await api<Page<Drug>>(`/drugs?${p}`)).data); setError(undefined);
    } catch (e) { setError(errorText(e, 'Gagal memuat obat')); }
  }, [q]);
  useEffect(() => { const t = setTimeout(() => void load(), 250); return () => clearTimeout(t); }, [load]);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Obat</h1>
        <Input aria-label="Cari obat" placeholder="Cari nama, kode, atau zat aktif" className="w-72" value={q} onChange={(e) => setQ(e.target.value)} />
        {manage ? <Button className="ml-auto" onClick={() => { setNotice(undefined); setEditing('new'); }}>Tambah obat</Button> : null}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada obat.</p> : (
            <Table>
              <THead><TR><TH>Kode</TH><TH>Nama</TH><TH>Zat aktif</TH><TH>Golongan</TH><TH>Batas dosis</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {items.map((d) => (
                  <TR key={d.id} data-testid="drug-row">
                    <TD className="font-mono text-xs">{d.code}</TD>
                    <TD><span className="font-medium">{d.genericName}</span>{d.brandName ? <span className="text-muted-foreground"> ({d.brandName})</span> : null}
                      <span className="block text-xs text-muted-foreground">{d.dosageForm}{d.strength ? ` · ${d.strength}` : ''} · satuan {d.uomName}</span></TD>
                    <TD className="text-xs">{d.ingredients.join(', ')}</TD>
                    <TD className="text-xs">{DRUG_CLASS_LABEL[d.drugClass]}</TD>
                    <TD className="text-xs">{d.maxDoseQty || d.maxDailyQty ? `${d.maxDoseQty ?? '—'} / pemberian · ${d.maxDailyQty ?? '—'} / hari` : '—'}</TD>
                    <TD><Badge tone={d.isActive ? 'success' : 'neutral'}>{d.isActive ? 'Aktif' : 'Nonaktif'}</Badge></TD>
                    <TD className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => setPricing(d)}>Harga</Button>
                      {manage ? <Button size="sm" variant="ghost" onClick={() => { setNotice(undefined); setEditing(d); }}>Ubah</Button> : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {editing ? <DrugDialog drug={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)}
                             onSaved={async (d) => { setEditing(undefined); setNotice(`Obat "${d.genericName}" disimpan.`); await load(); }} /> : null}
      {pricing ? <PriceDialog drug={pricing} manage={manage} onClose={() => setPricing(undefined)} /> : null}
    </div>
  );
}

function DrugDialog({ drug, onClose, onSaved }: { drug?: Drug; onClose: () => void; onSaved: (d: Drug) => Promise<void> }) {
  const [uoms, setUoms] = useState<Uom[]>([]);
  const [f, setF] = useState({
    code: drug?.code ?? '', genericName: drug?.genericName ?? '', brandName: drug?.brandName ?? '', dosageForm: drug?.dosageForm ?? 'Tablet',
    strength: drug?.strength ?? '', baseUomId: drug?.baseUomId ?? '', drugClass: drug?.drugClass ?? 'BEBAS', ingredients: drug?.ingredients.join(', ') ?? '',
    maxDoseQty: drug?.maxDoseQty ?? '', maxDailyQty: drug?.maxDailyQty ?? '', kfaCode: drug?.kfaCode ?? '', minStock: drug?.minStock ?? '0',
    isActive: drug?.isActive ?? true,
  });
  const [error, setError] = useState<string>();
  useEffect(() => { void api<Uom[]>('/uoms').then((u) => { setUoms(u); setF((x) => ({ ...x, baseUomId: x.baseUomId || u[0]?.id || '' })); }).catch(() => undefined); }, []);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const ingredients = f.ingredients.split(',').map((x) => x.trim()).filter(Boolean);
  const num = (v: string) => (v.trim() === '' ? null : v.trim().replace(',', '.'));
  const ok = f.code.trim().length >= 2 && f.genericName.trim().length >= 2 && f.dosageForm.trim().length >= 2 && !!f.baseUomId && ingredients.length > 0;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = { code: f.code.trim().toUpperCase(), genericName: f.genericName.trim(), brandName: f.brandName.trim() || null, dosageForm: f.dosageForm.trim(),
      strength: f.strength.trim() || null, baseUomId: f.baseUomId, drugClass: f.drugClass, ingredients, maxDoseQty: num(f.maxDoseQty),
      maxDailyQty: num(f.maxDailyQty), kfaCode: f.kfaCode.trim() || null, minStock: num(f.minStock) ?? '0', isActive: f.isActive };
    try {
      await onSaved(await api<Drug>(drug ? `/drugs/${drug.id}` : '/drugs', { method: drug ? 'PUT' : 'POST', body,
        headers: drug ? { 'if-match': String(drug.version) } : undefined }));
    } catch (err) { setError(errorText(err, 'Gagal menyimpan obat')); }
  }
  return (
    <Dialog open onClose={onClose} title={drug ? 'Ubah obat' : 'Tambah obat'}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit} noValidate>
        {error ? <Alert tone="error" className="sm:col-span-2">{error}</Alert> : null}
        <Field id="dr-code" label="Kode *"><Input id="dr-code" maxLength={20} value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} /></Field>
        <Field id="dr-class" label="Golongan">
          <Select id="dr-class" value={f.drugClass} onChange={(e) => set('drugClass', e.target.value)}>
            {Object.entries(DRUG_CLASS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field id="dr-generic" label="Nama generik *"><Input id="dr-generic" maxLength={200} value={f.genericName} onChange={(e) => set('genericName', e.target.value)} /></Field>
        <Field id="dr-brand" label="Nama dagang"><Input id="dr-brand" maxLength={200} value={f.brandName} onChange={(e) => set('brandName', e.target.value)} /></Field>
        <Field id="dr-form" label="Bentuk sediaan *"><Input id="dr-form" maxLength={50} value={f.dosageForm} onChange={(e) => set('dosageForm', e.target.value)} /></Field>
        <Field id="dr-strength" label="Kekuatan"><Input id="dr-strength" maxLength={50} placeholder="mis. 500 mg" value={f.strength} onChange={(e) => set('strength', e.target.value)} /></Field>
        <Field id="dr-uom" label="Satuan dasar *">
          <Select id="dr-uom" value={f.baseUomId} onChange={(e) => set('baseUomId', e.target.value)}>
            {uoms.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.code})</option>)}
          </Select>
        </Field>
        <Field id="dr-ingredients" label="Zat aktif *" hint="Pisahkan dengan koma. Dipakai untuk peringatan alergi & duplikasi.">
          <Input id="dr-ingredients" value={f.ingredients} onChange={(e) => set('ingredients', e.target.value)} />
        </Field>
        <Field id="dr-maxdose" label="Batas per pemberian (satuan dasar)" hint="Opsional — memicu peringatan dosis."><Input id="dr-maxdose" inputMode="decimal" value={f.maxDoseQty} onChange={(e) => set('maxDoseQty', e.target.value)} /></Field>
        <Field id="dr-maxdaily" label="Batas per hari (satuan dasar)"><Input id="dr-maxdaily" inputMode="decimal" value={f.maxDailyQty} onChange={(e) => set('maxDailyQty', e.target.value)} /></Field>
        <Field id="dr-kfa" label="Kode KFA" hint="Opsional — kode obat SATUSEHAT."><Input id="dr-kfa" maxLength={30} value={f.kfaCode} onChange={(e) => set('kfaCode', e.target.value)} /></Field>
        <Field id="dr-min" label="Stok minimum (satuan dasar)" hint="0 = tanpa peringatan stok menipis."><Input id="dr-min" inputMode="decimal" value={f.minStock} onChange={(e) => set('minStock', e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><Switch checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} aria-label="Aktif" /> Aktif</label>
        <p className="text-xs text-muted-foreground sm:col-span-2">Batas dosis adalah usulan klinik dan perlu ditinjau apoteker/dokter.</p>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" disabled={!ok}>Simpan</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Riwayat harga jual per cabang/penjamin (PHM-FR-002). Harga lama ditutup, bukan dihapus. */
function PriceDialog({ drug, manage, onClose }: { drug: Drug; manage: boolean; onClose: () => void }) {
  const [items, setItems] = useState<DrugPrice[]>();
  const [error, setError] = useState<string>();
  const [f, setF] = useState({ payerType: '' as PayerType | '', sellPrice: '', het: '', hna: '', validFrom: todayWib() });
  const load = useCallback(async () => {
    try { setItems(await api<DrugPrice[]>(`/drugs/${drug.id}/prices`)); } catch (e) { setError(errorText(e, 'Gagal memuat harga')); }
  }, [drug.id]);
  useEffect(() => { void load(); }, [load]);
  const money = (v: string) => (v.trim() === '' ? null : toMoney(v));
  async function add(e: React.FormEvent) {
    e.preventDefault(); setError(undefined);
    try {
      await api(`/drugs/${drug.id}/prices`, { method: 'POST', body: { payerType: f.payerType || null, sellPrice: money(f.sellPrice), het: money(f.het),
        hna: money(f.hna), validFrom: f.validFrom } });
      setF((x) => ({ ...x, sellPrice: '', het: '', hna: '' })); await load();
    } catch (err) { setError(errorText(err, 'Gagal menyimpan harga')); }
  }
  async function end(p: DrugPrice) {
    setError(undefined);
    const d = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
    try { await api(`/drugs/${drug.id}/prices/${p.id}/end`, { method: 'POST', body: { validTo: d < p.validFrom ? p.validFrom : d } }); await load(); }
    catch (err) { setError(errorText(err, 'Gagal menutup harga')); }
  }
  return (
    <Dialog open onClose={onClose} title={`Harga jual — ${drug.genericName}`}>
      <div className="grid gap-3">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada harga.</p> : (
          <Table>
            <THead><TR><TH>Berlaku</TH><TH>Penjamin / cabang</TH><TH>Harga jual</TH><TH>HET</TH><TH /></TR></THead>
            <TBody>
              {items.map((p) => (
                <TR key={p.id} data-testid="price-row">
                  <TD className="text-xs">{fmtDate(p.validFrom)} – {p.validTo ? fmtDate(p.validTo) : 'sekarang'}</TD>
                  <TD className="text-xs">{p.payerType ? PAYER_TYPE_LABEL[p.payerType] : 'Semua penjamin'}{p.branchName ? ` · ${p.branchName}` : ''}</TD>
                  <TD>{fmtRupiah(p.sellPrice)} <span className="text-xs text-muted-foreground">/ {drug.uomName}</span></TD>
                  <TD className="text-xs">{p.het ? fmtRupiah(p.het) : '—'}</TD>
                  <TD className="text-right">{manage && !p.validTo ? <Button size="sm" variant="ghost" onClick={() => void end(p)}>Akhiri</Button> : null}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {manage ? (
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={add} noValidate>
            <Field id="pr-payer" label="Penjamin">
              <Select id="pr-payer" value={f.payerType} onChange={(e) => setF({ ...f, payerType: e.target.value as PayerType | '' })}>
                <option value="">Semua penjamin</option>
                {Object.entries(PAYER_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field id="pr-from" label="Berlaku mulai"><Input id="pr-from" type="date" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} /></Field>
            <Field id="pr-sell" label={`Harga jual per ${drug.uomName} *`}><Input id="pr-sell" inputMode="decimal" value={f.sellPrice} onChange={(e) => setF({ ...f, sellPrice: e.target.value })} /></Field>
            <Field id="pr-het" label="HET (opsional)"><Input id="pr-het" inputMode="decimal" value={f.het} onChange={(e) => setF({ ...f, het: e.target.value })} /></Field>
            <p className="text-xs text-muted-foreground sm:col-span-2">Periode tidak boleh tumpang tindih untuk penjamin yang sama — tutup harga lama lebih dulu.</p>
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button type="button" variant="outline" onClick={onClose}>Tutup</Button>
              <Button type="submit" disabled={!f.sellPrice.trim() || !f.validFrom}>Tambah harga</Button>
            </div>
          </form>
        ) : null}
      </div>
    </Dialog>
  );
}

/** "25.000" → "25000" (pemisah ribuan); "2500,50" → "2500.50". */
function toMoney(v: string) {
  const t = v.trim().replace(/^Rp\s*/i, '');
  return /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(',', '.');
}
