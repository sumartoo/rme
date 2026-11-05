'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, CardContent, Dialog, Field, Input, Select, Switch, TBody, TD, TH, THead, TR, Table,
} from '@clinicrme/ui';
import { Page, Practitioner, PractitionerType, api, errorText } from '../../../../lib/api';
import { PRACTITIONER_TYPE_LABEL, daysUntil, fmtDate } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

const NIK = /^(1[1-9]|[2-9]\d)\d{14}$/;

/** Tanda masa berlaku STR/SIP: merah bila lewat, kuning bila ≤ 60 hari (pengingat otomatis = MST-FR-003, LJT). */
function Validity({ date }: { date: string | null }) {
  const d = daysUntil(date);
  if (d === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {fmtDate(date)}
      {d < 0 ? <Badge tone="danger">habis</Badge> : d <= 60 ? <Badge tone="warning">{d} hari</Badge> : null}
    </span>
  );
}

/** Tenaga kesehatan (MST-FR-002). NIK hanya dapat diisi/diganti; yang tampil selalu tersamar. */
export default function PractitionersPage() {
  const s = useSession();
  const manage = can(s, 'master.practitioner.manage');
  const [items, setItems] = useState<Practitioner[]>();
  const [next, setNext] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [inactive, setInactive] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [editing, setEditing] = useState<Practitioner | 'new'>();

  const query = useCallback((cursor?: string) => {
    const p = new URLSearchParams({ limit: '50' });
    if (q.trim()) p.set('q', q.trim());
    if (type) p.set('type', type);
    if (inactive) p.set('includeInactive', 'true');
    if (cursor) p.set('cursor', cursor);
    return `/practitioners?${p}`;
  }, [q, type, inactive]);
  const load = useCallback(async () => {
    try {
      const r = await api<Page<Practitioner>>(query());
      setItems(r.data); setNext(r.page.nextCursor); setError(undefined);
    } catch (e) { setError(errorText(e, 'Gagal memuat tenaga kesehatan')); }
  }, [query]);
  useEffect(() => { const t = setTimeout(() => void load(), 250); return () => clearTimeout(t); }, [load]);
  async function more() {
    if (!next) return;
    try { const r = await api<Page<Practitioner>>(query(next)); setItems((x) => [...(x ?? []), ...r.data]); setNext(r.page.nextCursor); }
    catch (e) { setError(errorText(e, 'Gagal memuat')); }
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Tenaga kesehatan</h1>
        {manage ? <Button className="ml-auto" onClick={() => { setNotice(undefined); setEditing('new'); }}>Tambah tenaga kesehatan</Button> : null}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Cari nama, STR, atau SIP" placeholder="Cari nama, STR, atau SIP…" className="w-72" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label="Jenis" className="w-56" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Semua jenis</option>
          {Object.entries(PRACTITIONER_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-sm"><Switch checked={inactive} onChange={(e) => setInactive(e.target.checked)} aria-label="Tampilkan nonaktif" /> Tampilkan nonaktif</label>
      </div>
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada data tenaga kesehatan.</p>
          ) : (
            <Table>
              <THead><TR><TH>Nama</TH><TH>Jenis</TH><TH>NIK</TH><TH>STR berlaku</TH><TH>SIP</TH><TH>SIP berlaku</TH><TH>Akun</TH><TH>Status</TH>{manage ? <TH /> : null}</TR></THead>
              <TBody>
                {items.map((p) => (
                  <TR key={p.id} data-testid="practitioner-row">
                    <TD>{p.fullName}{p.specialty ? <div className="text-xs text-muted-foreground">{p.specialty}</div> : null}</TD>
                    <TD className="text-xs">{PRACTITIONER_TYPE_LABEL[p.practitionerType]}</TD>
                    <TD className="font-mono text-xs">{p.nikMasked ?? '—'}</TD>
                    <TD className="text-xs"><Validity date={p.strValidUntil} /></TD>
                    <TD className="text-xs">{p.sipNumber ?? '—'}</TD>
                    <TD className="text-xs"><Validity date={p.sipValidUntil} /></TD>
                    <TD className="text-xs">{p.linkedUserId ? 'Tertaut' : '—'}</TD>
                    <TD><Badge tone={p.isActive ? 'success' : 'neutral'}>{p.isActive ? 'Aktif' : 'Nonaktif'}</Badge></TD>
                    {manage ? <TD className="text-right"><Button size="sm" variant="outline" onClick={() => { setNotice(undefined); setEditing(p); }}>Ubah</Button></TD> : null}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {next ? <div className="mt-3 flex justify-center"><Button variant="outline" size="sm" onClick={more}>Muat lebih banyak</Button></div> : null}
        </CardContent>
      </Card>
      {editing ? <PractitionerDialog item={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)}
        onSaved={async (msg) => { setEditing(undefined); await load(); setNotice(msg); }} /> : null}
    </div>
  );
}

function PractitionerDialog({ item, onClose, onSaved }: { item?: Practitioner; onClose: () => void; onSaved: (msg: string) => Promise<void> }) {
  const [f, setF] = useState({
    fullName: item?.fullName ?? '', practitionerType: (item?.practitionerType ?? 'DOKTER') as PractitionerType, specialty: item?.specialty ?? '',
    nik: '', clearNik: false, strNumber: item?.strNumber ?? '', strValidUntil: item?.strValidUntil ?? '', sipNumber: item?.sipNumber ?? '',
    sipValidUntil: item?.sipValidUntil ?? '', satusehatIhsId: item?.satusehatIhsId ?? '', isActive: item?.isActive ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const nikBad = f.nik.trim() !== '' && !NIK.test(f.nik.trim());
  const ok = f.fullName.trim().length >= 2 && !nikBad;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError(undefined);
    const t = (v: string) => (v.trim() === '' ? null : v.trim());
    const body: Record<string, unknown> = {
      fullName: f.fullName.trim(), practitionerType: f.practitionerType, specialty: t(f.specialty), strNumber: t(f.strNumber),
      strValidUntil: t(f.strValidUntil), sipNumber: t(f.sipNumber), sipValidUntil: t(f.sipValidUntil), satusehatIhsId: t(f.satusehatIhsId), isActive: f.isActive,
    };
    if (f.nik.trim()) body.nik = f.nik.trim();
    else if (item && f.clearNik) body.nik = null;
    try {
      await api(item ? `/practitioners/${item.id}` : '/practitioners', { method: item ? 'PUT' : 'POST', body, headers: item ? { 'if-match': `"${item.version}"` } : undefined });
      await onSaved(`${body.fullName} ${item ? 'disimpan' : 'ditambahkan'}.`);
    } catch (err) { setError(errorText(err, 'Gagal menyimpan')); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} title={item ? 'Ubah tenaga kesehatan' : 'Tambah tenaga kesehatan'}
            description="NIK disimpan terenkripsi dan hanya tampil tersamar. Perubahan dicatat di log audit.">
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="pr-name" label="Nama lengkap (dengan gelar) *"><Input id="pr-name" value={f.fullName} maxLength={200} onChange={(e) => set('fullName', e.target.value)} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="pr-type" label="Jenis">
            <Select id="pr-type" value={f.practitionerType} onChange={(e) => set('practitionerType', e.target.value as PractitionerType)}>
              {Object.entries(PRACTITIONER_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field id="pr-spec" label="Spesialisasi"><Input id="pr-spec" value={f.specialty} maxLength={100} onChange={(e) => set('specialty', e.target.value)} /></Field>
        </div>
        <Field id="pr-nik" label={item?.nikMasked ? `NIK (tersimpan: ${item.nikMasked})` : 'NIK'} error={nikBad ? 'NIK harus 16 digit angka' : undefined}
               hint={item?.nikMasked ? 'Kosongkan untuk tetap memakai NIK tersimpan.' : '16 digit sesuai KTP.'}>
          <Input id="pr-nik" inputMode="numeric" autoComplete="off" value={f.nik} maxLength={16} aria-invalid={nikBad}
                 aria-describedby={nikBad ? 'pr-nik-error' : undefined} onChange={(e) => set('nik', e.target.value.replace(/\D/g, ''))} />
        </Field>
        {item?.nikMasked ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.clearNik} disabled={f.nik !== ''} onChange={(e) => set('clearNik', e.target.checked)} /> Hapus NIK tersimpan
          </label>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="pr-str" label="Nomor STR"><Input id="pr-str" value={f.strNumber} maxLength={50} onChange={(e) => set('strNumber', e.target.value)} /></Field>
          <Field id="pr-str-until" label="STR berlaku sampai"><Input id="pr-str-until" type="date" value={f.strValidUntil} onChange={(e) => set('strValidUntil', e.target.value)} /></Field>
          <Field id="pr-sip" label="Nomor SIP"><Input id="pr-sip" value={f.sipNumber} maxLength={50} onChange={(e) => set('sipNumber', e.target.value)} /></Field>
          <Field id="pr-sip-until" label="SIP berlaku sampai"><Input id="pr-sip-until" type="date" value={f.sipValidUntil} onChange={(e) => set('sipValidUntil', e.target.value)} /></Field>
        </div>
        <Field id="pr-ihs" label="ID SATUSEHAT (IHS)" hint="Opsional; diisi otomatis saat integrasi SATUSEHAT (Stage 12).">
          <Input id="pr-ihs" value={f.satusehatIhsId} maxLength={50} onChange={(e) => set('satusehatIhsId', e.target.value)} />
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
