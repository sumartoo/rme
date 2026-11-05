'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, Field, Input, Select, Switch, TBody, TD, TH, THead, TR, Table,
} from '@clinicrme/ui';
import { Supplier, Uom, api, errorText } from '../../../../lib/api';
import { can, useSession } from '../../../../lib/session';

const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/;

/** Satuan & konversi (MST-FR-007) dan supplier obat (MST-FR-010). */
export default function SuppliesPage() {
  const s = useSession();
  const manageUom = can(s, 'master.uom.manage');
  const manageSupplier = can(s, 'master.supplier.manage');
  const readSupplier = can(s, 'master.supplier.read');
  const [uoms, setUoms] = useState<Uom[]>();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [uomEdit, setUomEdit] = useState<Uom | 'new'>();
  const [convFor, setConvFor] = useState<Uom>();
  const [supEdit, setSupEdit] = useState<Supplier | 'new'>();

  const load = useCallback(async () => {
    try {
      const [u, sp] = await Promise.all([api<Uom[]>('/uoms?includeInactive=true'), readSupplier ? api<Supplier[]>('/suppliers?includeInactive=true') : Promise.resolve([])]);
      setUoms(u); setSuppliers(sp);
    } catch (e) { setError(errorText(e, 'Gagal memuat data')); }
  }, [readSupplier]);
  useEffect(() => { void load(); }, [load]);
  const done = async (msg: string) => { setUomEdit(undefined); setConvFor(undefined); setSupEdit(undefined); setError(undefined); await load(); setNotice(msg); };
  const code = (id: string) => uoms?.find((u) => u.id === id)?.code ?? '?';

  if (error && !uoms) return <Alert tone="error">{error}</Alert>;
  if (!uoms) return <p className="text-sm text-muted-foreground" role="status">Memuat…</p>;
  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Satuan & supplier</h1>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardHeader className="flex-row items-start gap-3">
          <div className="grid gap-1"><CardTitle>Satuan & konversi</CardTitle>
            <CardDescription>Contoh: 1 BOX = 10 STRIP, 1 STRIP = 10 TAB. Konversi tidak boleh melingkar.</CardDescription></div>
          {manageUom ? <Button className="ml-auto" size="sm" onClick={() => { setNotice(undefined); setUomEdit('new'); }}>Tambah satuan</Button> : null}
        </CardHeader>
        <CardContent>
          <Table>
            <THead><TR><TH>Kode</TH><TH>Nama</TH><TH>Konversi</TH><TH>Status</TH>{manageUom ? <TH /> : null}</TR></THead>
            <TBody>
              {uoms.map((u) => (
                <TR key={u.id} data-testid="uom-row">
                  <TD className="font-mono text-xs">{u.code}</TD><TD>{u.name}</TD>
                  <TD className="text-xs">{u.conversions.length ? u.conversions.map((c) => `1 ${u.code} = ${c.factor} ${code(c.toUomId)}`).join(' · ') : '—'}</TD>
                  <TD><Badge tone={u.isActive ? 'success' : 'neutral'}>{u.isActive ? 'Aktif' : 'Nonaktif'}</Badge></TD>
                  {manageUom ? (
                    <TD className="text-right"><span className="inline-flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => { setNotice(undefined); setConvFor(u); }}>Konversi</Button>
                      <Button size="sm" variant="outline" onClick={() => { setNotice(undefined); setUomEdit(u); }}>Ubah</Button>
                    </span></TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
      {readSupplier ? (
        <Card>
          <CardHeader className="flex-row items-start gap-3">
            <div className="grid gap-1"><CardTitle>Supplier</CardTitle><CardDescription>Pemasok obat & alat kesehatan (dipakai penerimaan barang di Stage 10).</CardDescription></div>
            {manageSupplier ? <Button className="ml-auto" size="sm" onClick={() => { setNotice(undefined); setSupEdit('new'); }}>Tambah supplier</Button> : null}
          </CardHeader>
          <CardContent>
            {suppliers.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada supplier.</p> : (
              <Table>
                <THead><TR><TH>Kode</TH><TH>Nama</TH><TH>Kontak</TH><TH>Telepon</TH><TH>NPWP</TH><TH>Status</TH>{manageSupplier ? <TH /> : null}</TR></THead>
                <TBody>
                  {suppliers.map((x) => (
                    <TR key={x.id} data-testid="supplier-row">
                      <TD className="font-mono text-xs">{x.code ?? '—'}</TD><TD>{x.name}</TD><TD className="text-xs">{x.contactPerson ?? '—'}{x.email ? <div>{x.email}</div> : null}</TD>
                      <TD className="text-xs">{x.phone ?? '—'}</TD><TD className="font-mono text-xs">{x.npwp ?? '—'}</TD>
                      <TD><Badge tone={x.isActive ? 'success' : 'neutral'}>{x.isActive ? 'Aktif' : 'Nonaktif'}</Badge></TD>
                      {manageSupplier ? <TD className="text-right"><Button size="sm" variant="outline" onClick={() => { setNotice(undefined); setSupEdit(x); }}>Ubah</Button></TD> : null}
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}
      {uomEdit ? <UomDialog item={uomEdit === 'new' ? undefined : uomEdit} onClose={() => setUomEdit(undefined)} onSaved={done} /> : null}
      {convFor ? <ConversionDialog from={convFor} uoms={uoms} onClose={() => setConvFor(undefined)} onSaved={done} /> : null}
      {supEdit ? <SupplierDialog item={supEdit === 'new' ? undefined : supEdit} onClose={() => setSupEdit(undefined)} onSaved={done} /> : null}
    </div>
  );
}

function UomDialog({ item, onClose, onSaved }: { item?: Uom; onClose: () => void; onSaved: (msg: string) => Promise<void> }) {
  const [f, setF] = useState({ code: item?.code ?? '', name: item?.name ?? '', isActive: item?.isActive ?? true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ok = CODE.test(f.code.trim()) && f.name.trim().length >= 2;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError(undefined);
    try {
      await api(item ? `/uoms/${item.id}` : '/uoms', { method: item ? 'PUT' : 'POST', body: { code: f.code.trim(), name: f.name.trim(), isActive: f.isActive },
        headers: item ? { 'if-match': `"${item.version}"` } : undefined });
      await onSaved(`Satuan ${f.code.trim().toUpperCase()} ${item ? 'disimpan' : 'ditambahkan'}.`);
    } catch (err) { setError(errorText(err, 'Gagal menyimpan satuan')); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title={item ? 'Ubah satuan' : 'Tambah satuan'}>
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="uo-code" label="Kode *" hint="mis. TAB, STRIP, BOX, ML"><Input id="uo-code" value={f.code} maxLength={20} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field id="uo-name" label="Nama *"><Input id="uo-name" value={f.name} maxLength={100} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-sm"><Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} aria-label="Aktif" /> Aktif</label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!ok}>Simpan</Button>
        </div>
      </form>
    </Dialog>
  );
}

function ConversionDialog({ from, uoms, onClose, onSaved }: { from: Uom; uoms: Uom[]; onClose: () => void; onSaved: (msg: string) => Promise<void> }) {
  const others = uoms.filter((u) => u.id !== from.id && u.isActive);
  const [to, setTo] = useState(others[0]?.id ?? '');
  const [factor, setFactor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ok = !!to && /^\d{1,12}(\.\d{1,6})?$/.test(factor) && Number(factor) > 0;
  const target = uoms.find((u) => u.id === to);
  async function save() {
    setBusy(true); setError(undefined);
    try { await api(`/uoms/${from.id}/conversions/${to}`, { method: 'PUT', body: { factor } }); await onSaved(`Konversi 1 ${from.code} = ${factor} ${target?.code} disimpan.`); }
    catch (e) { setError(errorText(e, 'Gagal menyimpan konversi')); }
    finally { setBusy(false); }
  }
  async function remove(toId: string) {
    setBusy(true); setError(undefined);
    try { await api(`/uoms/${from.id}/conversions/${toId}`, { method: 'DELETE' }); await onSaved('Konversi dihapus.'); }
    catch (e) { setError(errorText(e, 'Gagal menghapus konversi')); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title={`Konversi dari ${from.code}`} description={`1 ${from.code} = faktor × satuan tujuan`}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {from.conversions.length ? (
        <ul className="divide-y rounded-md border text-sm">
          {from.conversions.map((c) => (
            <li key={c.toUomId} className="flex items-center justify-between px-3 py-1.5">
              <span>1 {from.code} = {c.factor} {uoms.find((u) => u.id === c.toUomId)?.code}</span>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => remove(c.toUomId)}>Hapus</Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="cv-factor" label="Faktor *"><Input id="cv-factor" inputMode="decimal" value={factor} onChange={(e) => setFactor(e.target.value.replace(',', '.'))} /></Field>
        <Field id="cv-to" label="Satuan tujuan">
          <Select id="cv-to" value={to} onChange={(e) => setTo(e.target.value)}>
            {others.map((u) => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>)}
          </Select>
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Tutup</Button>
        <Button loading={busy} disabled={!ok} onClick={save}>Simpan konversi</Button>
      </div>
    </Dialog>
  );
}

function SupplierDialog({ item, onClose, onSaved }: { item?: Supplier; onClose: () => void; onSaved: (msg: string) => Promise<void> }) {
  const [f, setF] = useState({ code: item?.code ?? '', name: item?.name ?? '', contactPerson: item?.contactPerson ?? '', phone: item?.phone ?? '',
    email: item?.email ?? '', address: item?.address ?? '', npwp: item?.npwp ?? '', isActive: item?.isActive ?? true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const npwpBad = f.npwp.trim() !== '' && !/^[\d.-]{15,20}$/.test(f.npwp.trim());
  const emailBad = f.email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim());
  const ok = f.name.trim().length >= 2 && (f.code.trim() === '' || CODE.test(f.code.trim())) && !npwpBad && !emailBad;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError(undefined);
    const t = (v: string) => (v.trim() === '' ? null : v.trim());
    const body = { code: t(f.code), name: f.name.trim(), contactPerson: t(f.contactPerson), phone: t(f.phone), email: t(f.email), address: t(f.address),
      npwp: t(f.npwp), isActive: f.isActive };
    try {
      await api(item ? `/suppliers/${item.id}` : '/suppliers', { method: item ? 'PUT' : 'POST', body, headers: item ? { 'if-match': `"${item.version}"` } : undefined });
      await onSaved(`Supplier "${body.name}" ${item ? 'disimpan' : 'ditambahkan'}.`);
    } catch (err) { setError(errorText(err, 'Gagal menyimpan supplier')); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title={item ? 'Ubah supplier' : 'Tambah supplier'} description="Perubahan dicatat di log audit.">
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="sp-code" label="Kode"><Input id="sp-code" value={f.code} maxLength={20} onChange={(e) => set('code', e.target.value)} /></Field>
          <Field id="sp-npwp" label="NPWP" error={npwpBad ? 'NPWP 15–16 digit (boleh titik & strip)' : undefined}>
            <Input id="sp-npwp" value={f.npwp} maxLength={20} onChange={(e) => set('npwp', e.target.value)} />
          </Field>
        </div>
        <Field id="sp-name" label="Nama *"><Input id="sp-name" value={f.name} maxLength={200} onChange={(e) => set('name', e.target.value)} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="sp-cp" label="Kontak"><Input id="sp-cp" value={f.contactPerson} maxLength={200} onChange={(e) => set('contactPerson', e.target.value)} /></Field>
          <Field id="sp-phone" label="Telepon"><Input id="sp-phone" value={f.phone} maxLength={30} onChange={(e) => set('phone', e.target.value)} /></Field>
        </div>
        <Field id="sp-email" label="Email" error={emailBad ? 'Email tidak valid' : undefined}><Input id="sp-email" type="email" value={f.email} maxLength={254} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field id="sp-address" label="Alamat"><Input id="sp-address" value={f.address} maxLength={500} onChange={(e) => set('address', e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm"><Switch checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} aria-label="Aktif" /> Aktif</label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!ok}>Simpan</Button>
        </div>
      </form>
    </Dialog>
  );
}
