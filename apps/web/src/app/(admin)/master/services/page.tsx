'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, Field, Input, Select, Switch, TBody, TD, TH, THead, TR, Table,
} from '@clinicrme/ui';
import { BranchItem, Page, Payer, PayerType, ServiceItem, ServiceType, Tariff, api, errorText } from '../../../../lib/api';
import { PAYER_TYPE_LABEL, SERVICE_TYPE_LABEL, fmtDate, fmtRupiah, todayWib } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

/**
 * Layanan (MST-FR-004) & tarif berperiode (MST-FR-005). Tarif tidak pernah diubah: harga baru = periode baru
 * (periode lama otomatis ditutup sehari sebelumnya bila dipilih); periode hanya dapat ditutup lebih awal.
 */
export default function ServicesPage() {
  const s = useSession();
  const manage = can(s, 'master.service.manage');
  const manageTariff = can(s, 'master.tariff.manage');
  const [items, setItems] = useState<ServiceItem[]>();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<ServiceItem>();
  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [editing, setEditing] = useState<ServiceItem | 'new'>();

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ limit: '200', includeInactive: 'true' });
      if (q.trim()) p.set('q', q.trim());
      const r = await api<Page<ServiceItem>>(`/service-items?${p}`);
      setItems(r.data);
      setSelected((cur) => (cur ? r.data.find((x) => x.id === cur.id) : r.data[0]));
    } catch (e) { setError(errorText(e, 'Gagal memuat layanan')); }
  }, [q]);
  useEffect(() => { const t = setTimeout(() => void load(), 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => {
    void (async () => {
      try {
        const [b, p] = await Promise.all([api<BranchItem[]>('/branches'), can(s, 'master.payer.read') ? api<Payer[]>('/payers') : Promise.resolve([])]);
        setBranches(b); setPayers(p);
      } catch { /* daftar pilihan opsional */ }
    })();
  }, [s]);

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Layanan & tarif</h1>
        {manage ? <Button className="ml-auto" onClick={() => { setNotice(undefined); setEditing('new'); }}>Tambah layanan</Button> : null}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
        <Card>
          <CardContent className="grid gap-3 pt-6">
            <Input aria-label="Cari layanan" placeholder="Cari kode atau nama layanan…" value={q} onChange={(e) => setQ(e.target.value)} />
            {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? (
              <p className="text-sm text-muted-foreground">Belum ada layanan.</p>
            ) : (
              <ul className="divide-y rounded-md border text-sm" aria-label="Daftar layanan">
                {items.map((it) => (
                  <li key={it.id} data-testid="service-row">
                    <button type="button" onClick={() => setSelected(it)} aria-current={selected?.id === it.id ? 'true' : undefined}
                            className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted ${selected?.id === it.id ? 'bg-muted font-medium' : ''}`}>
                      <span className="font-mono text-xs">{it.code}</span>
                      <span className="flex-1">{it.name}</span>
                      <span className="text-xs text-muted-foreground">{SERVICE_TYPE_LABEL[it.serviceType]}</span>
                      {!it.isActive ? <Badge tone="neutral">Nonaktif</Badge> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        {selected ? (
          <TariffPanel key={selected.id} service={selected} branches={branches} payers={payers} manage={manageTariff}
                       onEdit={manage ? () => { setNotice(undefined); setEditing(selected); } : undefined} />
        ) : <Card><CardContent className="pt-6 text-sm text-muted-foreground">Pilih layanan untuk melihat tarifnya.</CardContent></Card>}
      </div>
      {editing ? <ServiceDialog item={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)}
        onSaved={async (msg, saved) => { setEditing(undefined); setNotice(msg); setSelected(saved); await load(); }} /> : null}
    </div>
  );
}

function TariffPanel({ service, branches, payers, manage, onEdit }: {
  service: ServiceItem; branches: BranchItem[]; payers: Payer[]; manage: boolean; onEdit?: () => void;
}) {
  const [tariffs, setTariffs] = useState<Tariff[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState<Tariff>();
  const load = useCallback(async () => {
    try { setTariffs((await api<Page<Tariff>>(`/tariffs?serviceItemId=${service.id}&limit=200`)).data); }
    catch (e) { setError(errorText(e, 'Gagal memuat tarif')); }
  }, [service.id]);
  useEffect(() => { void load(); }, [load]);
  const today = todayWib();
  const branchName = (id: string | null) => (id ? branches.find((b) => b.id === id)?.name ?? '—' : 'Semua cabang');
  const payerName = (t: Tariff) => (t.payerId ? payers.find((p) => p.id === t.payerId)?.name ?? '—' : t.payerType ? `Semua ${PAYER_TYPE_LABEL[t.payerType]}` : 'Semua penjamin');
  const state = (t: Tariff) => (t.validFrom > today ? 'akan datang' : t.validTo && t.validTo < today ? 'berakhir' : 'berlaku');

  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3">
        <div className="grid gap-1">
          <CardTitle>{service.name}</CardTitle>
          <CardDescription>
            {service.code} · {SERVICE_TYPE_LABEL[service.serviceType]}{service.icd9cmCode ? ` · ICD-9-CM ${service.icd9cmCode}` : ''}{service.isActive ? '' : ' · nonaktif'}
          </CardDescription>
        </div>
        <div className="ml-auto flex gap-2">
          {onEdit ? <Button size="sm" variant="outline" onClick={onEdit}>Ubah layanan</Button> : null}
          {manage ? <Button size="sm" onClick={() => { setNotice(undefined); setAdding(true); }}>Tambah tarif</Button> : null}
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {!tariffs ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : tariffs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada tarif untuk layanan ini.</p>
        ) : (
          <Table>
            <THead><TR><TH>Cabang</TH><TH>Penjamin</TH><TH className="text-right">Harga</TH><TH>Berlaku</TH><TH>Status</TH>{manage ? <TH /> : null}</TR></THead>
            <TBody>
              {tariffs.map((t) => (
                <TR key={t.id} data-testid="tariff-row">
                  <TD className="text-xs">{branchName(t.branchId)}</TD>
                  <TD className="text-xs">{payerName(t)}</TD>
                  <TD className="text-right tabular-nums">{fmtRupiah(t.price)}</TD>
                  <TD className="whitespace-nowrap text-xs">{fmtDate(t.validFrom)} – {t.validTo ? fmtDate(t.validTo) : 'seterusnya'}</TD>
                  <TD><Badge tone={state(t) === 'berlaku' ? 'success' : state(t) === 'akan datang' ? 'info' : 'neutral'}>{state(t)}</Badge></TD>
                  {manage ? <TD className="text-right">{state(t) !== 'berakhir' ? <Button size="sm" variant="outline" onClick={() => setEnding(t)}>Akhiri</Button> : null}</TD> : null}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground">Tarif tidak dapat diubah. Untuk mengganti harga, tambahkan tarif dengan tanggal mulai baru; tarif lama ditutup otomatis.</p>
      </CardContent>
      {adding ? <TariffDialog service={service} branches={branches} payers={payers} onClose={() => setAdding(false)}
        onSaved={async (msg) => { setAdding(false); setNotice(msg); setError(undefined); await load(); }} /> : null}
      {ending ? <EndDialog tariff={ending} onClose={() => setEnding(undefined)}
        onSaved={async (msg) => { setEnding(undefined); setNotice(msg); setError(undefined); await load(); }} /> : null}
    </Card>
  );
}

function TariffDialog({ service, branches, payers, onClose, onSaved }: {
  service: ServiceItem; branches: BranchItem[]; payers: Payer[]; onClose: () => void; onSaved: (msg: string) => Promise<void>;
}) {
  const [f, setF] = useState({ branchId: '', payer: '', price: '', validFrom: todayWib(), validTo: '', closePrevious: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const priceOk = /^\d{1,13}$/.test(f.price.replace(/\./g, ''));
  const ok = priceOk && !!f.validFrom && (!f.validTo || f.validTo >= f.validFrom);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError(undefined);
    // payer: '' = semua; 'T:<kategori>' = semua dalam kategori; 'P:<id>' = penjamin tertentu
    const [kind, val] = f.payer ? f.payer.split(':') : [];
    try {
      await api('/tariffs', { method: 'POST', body: {
        serviceItemId: service.id, branchId: f.branchId || null, price: f.price.replace(/\./g, ''), validFrom: f.validFrom, validTo: f.validTo || null,
        closePrevious: f.closePrevious, ...(kind === 'T' ? { payerType: val } : kind === 'P' ? { payerId: val } : {}),
      } });
      await onSaved(`Tarif ${service.name} mulai ${fmtDate(f.validFrom)} ditambahkan.`);
    } catch (err) { setError(errorText(err, 'Gagal menyimpan tarif')); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} title="Tambah tarif" description={`${service.code} · ${service.name}`}>
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="tf-branch" label="Cabang">
          <Select id="tf-branch" value={f.branchId} onChange={(e) => set('branchId', e.target.value)}>
            <option value="">Semua cabang</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field id="tf-payer" label="Penjamin">
          <Select id="tf-payer" value={f.payer} onChange={(e) => set('payer', e.target.value)}>
            <option value="">Semua penjamin</option>
            {(Object.keys(PAYER_TYPE_LABEL) as PayerType[]).map((t) => <option key={t} value={`T:${t}`}>Semua {PAYER_TYPE_LABEL[t]}</option>)}
            {payers.map((p) => <option key={p.id} value={`P:${p.id}`}>{p.name}</option>)}
          </Select>
        </Field>
        <Field id="tf-price" label="Harga (Rp) *" hint="Rupiah bulat, tanpa pajak" error={f.price && !priceOk ? 'Harga harus angka bulat' : undefined}>
          <Input id="tf-price" inputMode="numeric" value={f.price} maxLength={17} onChange={(e) => set('price', e.target.value.replace(/[^\d.]/g, ''))} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="tf-from" label="Berlaku mulai *"><Input id="tf-from" type="date" value={f.validFrom} onChange={(e) => set('validFrom', e.target.value)} /></Field>
          <Field id="tf-to" label="Berlaku sampai" hint="Kosong = seterusnya"><Input id="tf-to" type="date" value={f.validTo} onChange={(e) => set('validTo', e.target.value)} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.closePrevious} onChange={(e) => set('closePrevious', e.target.checked)} />
          Tutup tarif sebelumnya yang masih berlaku (sehari sebelum tanggal mulai)
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!ok}>Simpan tarif</Button>
        </div>
      </form>
    </Dialog>
  );
}

function EndDialog({ tariff, onClose, onSaved }: { tariff: Tariff; onClose: () => void; onSaved: (msg: string) => Promise<void> }) {
  const [validTo, setValidTo] = useState(tariff.validFrom > todayWib() ? tariff.validFrom : todayWib());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit() {
    setBusy(true); setError(undefined);
    try { await api(`/tariffs/${tariff.id}/end`, { method: 'POST', body: { validTo } }); await onSaved(`Tarif berakhir ${fmtDate(validTo)}.`); }
    catch (e) { setError(errorText(e, 'Gagal mengakhiri tarif')); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title="Akhiri tarif?" description={`${fmtRupiah(tariff.price)} · mulai ${fmtDate(tariff.validFrom)}`}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field id="end-date" label="Berlaku sampai (termasuk)"><Input id="end-date" type="date" value={validTo} min={tariff.validFrom} onChange={(e) => setValidTo(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Tanggal akhir hanya dapat dimajukan, tidak dapat diperpanjang kembali.</p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Batal</Button>
        <Button variant="destructive" loading={busy} disabled={!validTo || validTo < tariff.validFrom} onClick={submit}>Akhiri tarif</Button>
      </div>
    </Dialog>
  );
}

function ServiceDialog({ item, onClose, onSaved }: { item?: ServiceItem; onClose: () => void; onSaved: (msg: string, saved: ServiceItem) => Promise<void> }) {
  const [f, setF] = useState({ code: item?.code ?? '', name: item?.name ?? '', serviceType: (item?.serviceType ?? 'KONSULTASI') as ServiceType,
    icd9cmCode: item?.icd9cmCode ?? '', isActive: item?.isActive ?? true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const icdBad = f.icd9cmCode.trim() !== '' && !/^\d{2}(\.\d{1,2})?$/.test(f.icd9cmCode.trim());
  const ok = /^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/.test(f.code.trim()) && f.name.trim().length >= 2 && !icdBad;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError(undefined);
    const body = { code: f.code.trim(), name: f.name.trim(), serviceType: f.serviceType, icd9cmCode: f.icd9cmCode.trim() || null, isActive: f.isActive };
    try {
      const saved = await api<ServiceItem>(item ? `/service-items/${item.id}` : '/service-items', {
        method: item ? 'PUT' : 'POST', body, headers: item ? { 'if-match': `"${item.version}"` } : undefined });
      await onSaved(`Layanan "${saved.name}" ${item ? 'disimpan' : 'ditambahkan'}.`, saved);
    } catch (err) { setError(errorText(err, 'Gagal menyimpan layanan')); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title={item ? 'Ubah layanan' : 'Tambah layanan'} description="Perubahan dicatat di log audit.">
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="sv-code" label="Kode *" hint="2–20 huruf/angka, boleh - atau _"><Input id="sv-code" value={f.code} maxLength={20} onChange={(e) => set('code', e.target.value)} /></Field>
        <Field id="sv-name" label="Nama *"><Input id="sv-name" value={f.name} maxLength={200} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field id="sv-type" label="Jenis">
          <Select id="sv-type" value={f.serviceType} onChange={(e) => set('serviceType', e.target.value as ServiceType)}>
            {Object.entries(SERVICE_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field id="sv-icd" label="Kode ICD-9-CM (tindakan)" hint="Opsional, mis. 86.59" error={icdBad ? 'Format ICD-9-CM: 2 digit, titik, 1–2 digit' : undefined}>
          <Input id="sv-icd" value={f.icd9cmCode} maxLength={5} onChange={(e) => set('icd9cmCode', e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm"><Switch checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} aria-label="Aktif" /> Aktif</label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!ok}>Simpan</Button>
        </div>
      </form>
    </Dialog>
  );
}
