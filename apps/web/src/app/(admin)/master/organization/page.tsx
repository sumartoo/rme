'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, Field, Input, Select, Switch, TBody, TD, TH, THead, TR, Table,
} from '@clinicrme/ui';
import { BranchItem, Facility, FacilityType, ServiceUnit, Timezone, UnitType, api, errorText } from '../../../../lib/api';
import { FACILITY_TYPE_LABEL, TIMEZONE_LABEL, UNIT_TYPE_LABEL } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

type Kind = 'facility' | 'branch' | 'unit';
type Editing = { kind: Kind; item?: Facility | BranchItem | ServiceUnit };
const PATH: Record<Kind, string> = { facility: '/facilities', branch: '/branches', unit: '/service-units' };
const TITLE: Record<Kind, string> = { facility: 'fasilitas', branch: 'cabang', unit: 'poli/unit' };

/**
 * Struktur organisasi klinik (MST-FR-001): fasilitas → cabang → poli/ruang/unit. Simpan memakai If-Match; konflik
 * versi (diubah orang lain) ditampilkan dan data dimuat ulang. Data tidak dihapus — dinonaktifkan.
 */
export default function OrganizationPage() {
  const s = useSession();
  const manage = can(s, 'master.facility.manage');
  const [facilities, setFacilities] = useState<Facility[]>();
  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [units, setUnits] = useState<ServiceUnit[]>([]);
  const [unitBranch, setUnitBranch] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [editing, setEditing] = useState<Editing>();

  const load = useCallback(async () => {
    try {
      const [f, b, u] = await Promise.all([api<Facility[]>('/facilities?includeInactive=true'), api<BranchItem[]>('/branches?includeInactive=true'),
        api<ServiceUnit[]>('/service-units?includeInactive=true')]);
      setFacilities(f); setBranches(b); setUnits(u);
    } catch (e) { setError(errorText(e, 'Gagal memuat data organisasi')); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error && !facilities) return <Alert tone="error">{error}</Alert>;
  if (!facilities) return <p className="text-sm text-muted-foreground" role="status">Memuat…</p>;
  const facilityName = (id: string) => facilities.find((f) => f.id === id)?.name ?? '—';
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? '—';
  const shownUnits = unitBranch ? units.filter((u) => u.branchId === unitBranch) : units;
  const status = (active: boolean) => <Badge tone={active ? 'success' : 'neutral'}>{active ? 'Aktif' : 'Nonaktif'}</Badge>;
  const edit = (kind: Kind, item?: Editing['item']) => { setNotice(undefined); setEditing({ kind, item }); };

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Fasilitas & cabang</h1>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card>
        <CardHeader className="flex-row items-start gap-3">
          <div className="grid gap-1"><CardTitle>Fasilitas</CardTitle>
            <CardDescription>Fasilitas pelayanan kesehatan berizin (padanan Organization SATUSEHAT).</CardDescription></div>
          {manage ? <Button className="ml-auto" size="sm" onClick={() => edit('facility')}>Tambah fasilitas</Button> : null}
        </CardHeader>
        <CardContent>
          <Table>
            <THead><TR><TH>Nama</TH><TH>Jenis</TH><TH>No. izin</TH><TH>Status</TH>{manage ? <TH /> : null}</TR></THead>
            <TBody>
              {facilities.map((f) => (
                <TR key={f.id} data-testid="facility-row">
                  <TD>{f.name}</TD><TD>{FACILITY_TYPE_LABEL[f.facilityType]}</TD><TD>{f.licenseNumber ?? '—'}</TD><TD>{status(f.isActive)}</TD>
                  {manage ? <TD className="text-right"><Button size="sm" variant="outline" onClick={() => edit('facility', f)}>Ubah</Button></TD> : null}
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start gap-3">
          <div className="grid gap-1"><CardTitle>Cabang</CardTitle>
            <CardDescription>Lokasi pelayanan. Zona waktu cabang menentukan tampilan jam. Jumlah cabang aktif dibatasi paket langganan.</CardDescription></div>
          {manage ? <Button className="ml-auto" size="sm" disabled={!facilities.some((f) => f.isActive)} onClick={() => edit('branch')}>Tambah cabang</Button> : null}
        </CardHeader>
        <CardContent>
          {branches.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada cabang.</p> : (
            <Table>
              <THead><TR><TH>Kode</TH><TH>Nama</TH><TH>Fasilitas</TH><TH>Zona</TH><TH>Telepon</TH><TH>Status</TH>{manage ? <TH /> : null}</TR></THead>
              <TBody>
                {branches.map((b) => (
                  <TR key={b.id} data-testid="branch-row">
                    <TD className="font-mono text-xs">{b.code}</TD><TD>{b.name}</TD><TD>{facilityName(b.facilityId)}</TD>
                    <TD>{TIMEZONE_LABEL[b.timezone]}</TD><TD>{b.phone ?? '—'}</TD><TD>{status(b.isActive)}</TD>
                    {manage ? <TD className="text-right"><Button size="sm" variant="outline" onClick={() => edit('branch', b)}>Ubah</Button></TD> : null}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start gap-3">
          <div className="grid gap-1"><CardTitle>Poli & unit layanan</CardTitle>
            <CardDescription>Poli, ruang layanan, farmasi, kasir, laboratorium per cabang. Kode unik dalam satu cabang.</CardDescription></div>
          <div className="ml-auto flex gap-2">
            <Select aria-label="Filter cabang" className="h-8 w-48" value={unitBranch} onChange={(e) => setUnitBranch(e.target.value)}>
              <option value="">Semua cabang</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
            {manage ? <Button size="sm" disabled={!branches.some((b) => b.isActive)} onClick={() => edit('unit')}>Tambah unit</Button> : null}
          </div>
        </CardHeader>
        <CardContent>
          {shownUnits.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada poli/unit.</p> : (
            <Table>
              <THead><TR><TH>Kode</TH><TH>Nama</TH><TH>Jenis</TH><TH>Cabang</TH><TH>Spesialisasi</TH><TH>Status</TH>{manage ? <TH /> : null}</TR></THead>
              <TBody>
                {shownUnits.map((u) => (
                  <TR key={u.id} data-testid="unit-row">
                    <TD className="font-mono text-xs">{u.code}</TD><TD>{u.name}</TD><TD>{UNIT_TYPE_LABEL[u.unitType]}</TD>
                    <TD>{branchName(u.branchId)}</TD><TD>{u.specialty ?? '—'}</TD><TD>{status(u.isActive)}</TD>
                    {manage ? <TD className="text-right"><Button size="sm" variant="outline" onClick={() => edit('unit', u)}>Ubah</Button></TD> : null}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {editing ? (
        <EditDialog editing={editing} facilities={facilities} branches={branches} defaultBranch={unitBranch} onClose={() => setEditing(undefined)}
          onSaved={async (msg) => { setEditing(undefined); setNotice(msg); setError(undefined); await load(); }} />
      ) : null}
    </div>
  );
}

type Form = Record<string, string | boolean>;
function initial(e: Editing, facilities: Facility[], branches: BranchItem[], defaultBranch: string): Form {
  const i = e.item as Partial<Facility & BranchItem & ServiceUnit> | undefined;
  if (e.kind === 'facility') return { name: i?.name ?? '', facilityType: i?.facilityType ?? 'KLINIK_PRATAMA', licenseNumber: i?.licenseNumber ?? '', isActive: i?.isActive ?? true };
  if (e.kind === 'branch') return { facilityId: i?.facilityId ?? facilities.find((f) => f.isActive)?.id ?? '', code: i?.code ?? '', name: i?.name ?? '',
    address: i?.address ?? '', phone: i?.phone ?? '', timezone: i?.timezone ?? 'Asia/Jakarta', isActive: i?.isActive ?? true };
  return { branchId: i?.branchId ?? (defaultBranch || branches.find((b) => b.isActive)?.id || ''), code: i?.code ?? '', name: i?.name ?? '',
    unitType: i?.unitType ?? 'POLI', specialty: i?.specialty ?? '', isActive: i?.isActive ?? true };
}

function EditDialog({ editing, facilities, branches, defaultBranch, onClose, onSaved }: {
  editing: Editing; facilities: Facility[]; branches: BranchItem[]; defaultBranch: string; onClose: () => void; onSaved: (msg: string) => Promise<void>;
}) {
  const [f, setF] = useState<Form>(() => initial(editing, facilities, branches, defaultBranch));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = (k: string, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const str = (k: string) => String(f[k] ?? '');
  const isNew = !editing.item;
  const codeOk = editing.kind === 'facility' || /^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/.test(str('code').trim());
  const ok = str('name').trim().length >= 2 && codeOk && (editing.kind !== 'branch' || !!f.facilityId) && (editing.kind !== 'unit' || !!f.branchId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError(undefined);
    const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
    try {
      const item = editing.item;
      await api(item ? `${PATH[editing.kind]}/${item.id}` : PATH[editing.kind], {
        method: item ? 'PUT' : 'POST', body, headers: item ? { 'if-match': `"${item.version}"` } : undefined,
      });
      await onSaved(`${TITLE[editing.kind][0].toUpperCase()}${TITLE[editing.kind].slice(1)} "${body.name}" ${isNew ? 'ditambahkan' : 'disimpan'}.`);
    } catch (err) { setError(errorText(err, 'Gagal menyimpan')); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} title={`${isNew ? 'Tambah' : 'Ubah'} ${TITLE[editing.kind]}`}
            description={isNew ? 'Kolom bertanda wajib harus diisi.' : 'Perubahan dicatat di log audit (nilai sebelum & sesudah).'}>
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {editing.kind === 'branch' ? (
          <Field id="md-facility" label="Fasilitas *">
            <Select id="md-facility" value={str('facilityId')} onChange={(e) => set('facilityId', e.target.value)}>
              {facilities.filter((x) => x.isActive || x.id === f.facilityId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
        ) : null}
        {editing.kind === 'unit' ? (
          <Field id="md-branch" label="Cabang *">
            <Select id="md-branch" value={str('branchId')} onChange={(e) => set('branchId', e.target.value)}>
              {branches.filter((x) => x.isActive || x.id === f.branchId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
        ) : null}
        {editing.kind !== 'facility' ? (
          <Field id="md-code" label="Kode *" hint="2–20 huruf/angka, boleh - atau _; disimpan huruf besar">
            <Input id="md-code" value={str('code')} maxLength={20} onChange={(e) => set('code', e.target.value)} />
          </Field>
        ) : null}
        <Field id="md-name" label="Nama *"><Input id="md-name" value={str('name')} maxLength={200} onChange={(e) => set('name', e.target.value)} /></Field>
        {editing.kind === 'facility' ? (<>
          <Field id="md-ftype" label="Jenis fasilitas">
            <Select id="md-ftype" value={str('facilityType')} onChange={(e) => set('facilityType', e.target.value as FacilityType)}>
              {Object.entries(FACILITY_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field id="md-license" label="Nomor izin"><Input id="md-license" value={str('licenseNumber')} maxLength={100} onChange={(e) => set('licenseNumber', e.target.value)} /></Field>
        </>) : null}
        {editing.kind === 'branch' ? (<>
          <Field id="md-address" label="Alamat"><Input id="md-address" value={str('address')} maxLength={500} onChange={(e) => set('address', e.target.value)} /></Field>
          <Field id="md-phone" label="Telepon"><Input id="md-phone" value={str('phone')} maxLength={30} onChange={(e) => set('phone', e.target.value)} /></Field>
          <Field id="md-tz" label="Zona waktu">
            <Select id="md-tz" value={str('timezone')} onChange={(e) => set('timezone', e.target.value as Timezone)}>
              {Object.entries(TIMEZONE_LABEL).map(([k, v]) => <option key={k} value={k}>{v} ({k})</option>)}
            </Select>
          </Field>
        </>) : null}
        {editing.kind === 'unit' ? (<>
          <Field id="md-utype" label="Jenis unit">
            <Select id="md-utype" value={str('unitType')} onChange={(e) => set('unitType', e.target.value as UnitType)}>
              {Object.entries(UNIT_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field id="md-specialty" label="Spesialisasi"><Input id="md-specialty" value={str('specialty')} maxLength={100} onChange={(e) => set('specialty', e.target.value)} /></Field>
        </>) : null}
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={!!f.isActive} onChange={(e) => set('isActive', e.target.checked)} aria-label="Aktif" /> Aktif
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!ok}>Simpan</Button>
        </div>
      </form>
    </Dialog>
  );
}
