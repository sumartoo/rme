'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, Field, Input, Select, Switch, TBody, TD, TH, THead, TR, Table, Textarea,
} from '@clinicrme/ui';
import { ConsentDocument, Coverage, Patient, PatientSummary, Payer, api, errorText } from '../../../../lib/api';
import { CONSENT_TYPE_LABEL, IDENTITY_LABEL, PAYER_TYPE_LABEL, SEX_LABEL, daysUntil, fmtAge, fmtDate, fmtDateTime } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';
import { PatientLine, PatientPicker } from '../../../../components/patient-picker';
import { PatientForm } from '../patient-form';

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[9rem_1fr] gap-2 py-1 text-sm"><dt className="text-muted-foreground">{label}</dt><dd>{children}</dd></div>
);

/** Detail pasien: identitas, kontak, penjamin, consent, pembatasan pemrosesan, penggabungan. Membuka halaman ini tercatat di audit. */
export default function PatientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const s = useSession();
  const update = can(s, 'patient.update');
  const [p, setP] = useState<Patient>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {   // ?created=1 dari halaman pendaftaran (tanpa useSearchParams agar tidak perlu Suspense)
    if (new URLSearchParams(window.location.search).get('created') === '1') setNotice('Pasien berhasil didaftarkan.');
  }, []);
  const [dialog, setDialog] = useState<'edit' | 'coverage' | 'consent' | 'restrict' | 'merge' | Coverage>();

  const load = useCallback(async () => {
    try { setP(await api<Patient>(`/patients/${id}`)); setError(undefined); }
    catch (e) { setError(errorText(e, 'Gagal memuat data pasien')); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  async function done(msg: string) { setDialog(undefined); await load(); setNotice(msg); }

  if (error && !p) return <Alert tone="error">{error}</Alert>;
  if (!p) return <p className="text-sm text-muted-foreground" role="status">Memuat…</p>;
  const merged = p.status === 'MERGED';
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/patients" className="text-sm text-muted-foreground hover:underline">← Pasien</Link>
        <h1 className="text-xl font-semibold" data-testid="patient-name">{p.fullName}</h1>
        <span className="font-mono text-sm" data-testid="patient-mrn">{p.mrn}</span>
        {merged ? <Badge tone="neutral">Digabung</Badge> : null}
        {p.processingRestricted ? <Badge tone="warning">Pemrosesan dibatasi</Badge> : null}
        {!merged && update ? <Button className="ml-auto" variant="outline" onClick={() => { setNotice(undefined); setDialog('edit'); }}>Ubah data</Button> : null}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {merged && p.mergedInto ? (
        <Alert tone="info">Data ini sudah digabung ke <Link className="font-medium underline" href={`/patients/${p.mergedInto.id}`}>{p.mergedInto.fullName} ({p.mergedInto.mrn})</Link>
          {p.mergeReason ? ` — ${p.mergeReason}` : ''}. Gunakan data tujuan untuk pelayanan.</Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Identitas</CardTitle></CardHeader>
          <CardContent>
            <dl>
              <Row label="Jenis kelamin">{SEX_LABEL[p.sex]}</Row>
              <Row label="Tanggal lahir">{fmtDate(p.birthDate)} ({fmtAge(p.birthDate)})</Row>
              <Row label="Identitas">{IDENTITY_LABEL[p.identityType]}{p.nikMasked ? <span className="ml-2 font-mono">{p.nikMasked}</span> : p.identityMasked ? <span className="ml-2 font-mono">{p.identityMasked}</span> : null}</Row>
              {p.mother ? <Row label="Ibu"><Link className="hover:underline" href={`/patients/${p.mother.id}`}>{p.mother.fullName} ({p.mother.mrn})</Link></Row> : null}
              <Row label="Telepon">{p.phone ?? '—'}</Row>
              <Row label="Email">{p.email ?? '—'}</Row>
              <Row label="Alamat">{p.address ?? '—'}{p.regionCode ? <span className="block text-xs text-muted-foreground">Kode wilayah {p.regionCode}</span> : null}</Row>
              <Row label="SATUSEHAT">{p.ihsStatus === 'NOT_APPLICABLE' ? 'Tidak berlaku' : p.ihsStatus === 'PENDING' ? 'Menunggu (Stage 12)' : p.ihsStatus}</Row>
              <Row label="Terdaftar">{fmtDateTime(p.createdAt)}</Row>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Kontak darurat & wali</CardTitle></CardHeader>
          <CardContent>
            {p.contacts.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada kontak.</p> : (
              <ul className="grid gap-2 text-sm" data-testid="contact-list">
                {p.contacts.map((c) => (
                  <li key={c.id}>{c.fullName} <span className="text-muted-foreground">({c.relation})</span> · {c.phone} {c.isGuardian ? <Badge tone="info">Wali</Badge> : null}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Penjamin</CardTitle>
          {!merged && update ? <Button size="sm" variant="outline" onClick={() => { setNotice(undefined); setDialog('coverage'); }}>Tambah penjamin</Button> : null}
        </CardHeader>
        <CardContent>
          {p.coverages.length === 0 ? <p className="text-sm text-muted-foreground">Pasien umum (bayar sendiri).</p> : (
            <Table>
              <THead><TR><TH>Penjamin</TH><TH>Kategori</TH><TH>No. peserta</TH><TH>Berlaku</TH><TH>Status</TH>{update && !merged ? <TH /> : null}</TR></THead>
              <TBody>
                {p.coverages.map((c) => {
                  const left = daysUntil(c.validTo);
                  return (
                    <TR key={c.id} data-testid="coverage-row">
                      <TD>{c.payerName}</TD>
                      <TD className="text-xs">{PAYER_TYPE_LABEL[c.payerType]}</TD>
                      <TD className="text-xs">{c.memberNo ?? '—'}</TD>
                      <TD className="text-xs">{c.validFrom ? fmtDate(c.validFrom) : '…'} – {c.validTo ? fmtDate(c.validTo) : '…'}
                        {left !== null && left < 0 ? <Badge tone="danger" className="ml-1">kedaluwarsa</Badge> : null}</TD>
                      <TD><Badge tone={c.isActive ? 'success' : 'neutral'}>{c.isActive ? 'Aktif' : 'Nonaktif'}</Badge></TD>
                      {update && !merged ? <TD className="text-right"><Button size="sm" variant="outline" onClick={() => { setNotice(undefined); setDialog(c); }}>Ubah</Button></TD> : null}
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Consent</CardTitle>
          {!merged && update ? <Button size="sm" variant="outline" onClick={() => { setNotice(undefined); setDialog('consent'); }}>Catat consent</Button> : null}
        </CardHeader>
        <CardContent>
          {!p.hasConsent ? <Alert tone="info" className="mb-3">Belum ada persetujuan umum yang berlaku.</Alert> : null}
          {p.consents.length === 0 ? null : (
            <Table>
              <THead><TR><TH>Jenis</TH><TH>Versi</TH><TH>Keputusan</TH><TH>Ditandatangani</TH><TH>Dicatat</TH><TH>Status</TH>{update && !merged ? <TH /> : null}</TR></THead>
              <TBody>
                {p.consents.map((c) => (
                  <TR key={c.id} data-testid="consent-row">
                    <TD className="text-xs">{CONSENT_TYPE_LABEL[c.consentType as keyof typeof CONSENT_TYPE_LABEL] ?? c.consentType}</TD>
                    <TD className="text-xs">{c.version}</TD>
                    <TD><Badge tone={c.granted ? 'success' : 'warning'}>{c.granted ? 'Setuju' : 'Menolak'}</Badge></TD>
                    <TD className="text-xs">{c.signedByName ?? '—'}{c.signedByRelation ? ` (${c.signedByRelation})` : ''}</TD>
                    <TD className="text-xs">{fmtDateTime(c.recordedAt)}</TD>
                    <TD className="text-xs">{c.revokedAt ? `Dicabut ${fmtDateTime(c.revokedAt)}` : 'Berlaku'}</TD>
                    {update && !merged ? <TD className="text-right">{c.revokedAt ? null : <RevokeButton patientId={p.id} consentId={c.id} onDone={done} />}</TD> : null}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {!merged && (update || can(s, 'patient.merge')) ? (
        <Card>
          <CardHeader><CardTitle>Privasi & data ganda</CardTitle></CardHeader>
          <CardContent className="grid gap-3 text-sm">
            {update ? (
              <div className="flex flex-wrap items-center gap-3">
                <span>{p.processingRestricted ? `Pemrosesan dibatasi sejak ${fmtDateTime(p.restrictedAt)}: ${p.restrictionReason}` : 'Tidak ada pembatasan pemrosesan.'}</span>
                <Button size="sm" variant="outline" onClick={() => { setNotice(undefined); setDialog('restrict'); }}>{p.processingRestricted ? 'Cabut pembatasan' : 'Batasi pemrosesan'}</Button>
              </div>
            ) : null}
            {can(s, 'patient.merge') ? (
              <div className="flex flex-wrap items-center gap-3">
                <span>Pasien ini terdaftar dua kali? Gabungkan ke data yang benar (data tidak dihapus).</span>
                <Button size="sm" variant="outline" onClick={() => { setNotice(undefined); setDialog('merge'); }}>Gabungkan ke pasien lain</Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {dialog === 'edit' ? (
        <Dialog open onClose={() => setDialog(undefined)} title="Ubah data pasien" className="max-w-3xl">
          <PatientForm patient={p} onCancel={() => setDialog(undefined)} onDone={() => void done('Data pasien disimpan.')} />
        </Dialog>
      ) : null}
      {dialog === 'coverage' || (typeof dialog === 'object' && dialog) ? (
        <CoverageDialog patientId={p.id} item={typeof dialog === 'object' ? dialog : undefined} onClose={() => setDialog(undefined)} onDone={done} />
      ) : null}
      {dialog === 'consent' ? <ConsentDialog patientId={p.id} onClose={() => setDialog(undefined)} onDone={done} /> : null}
      {dialog === 'restrict' ? <RestrictDialog p={p} onClose={() => setDialog(undefined)} onDone={done} /> : null}
      {dialog === 'merge' ? <MergeDialog p={p} onClose={() => setDialog(undefined)} /> : null}
    </div>
  );
}

function CoverageDialog({ patientId, item, onClose, onDone }: { patientId: string; item?: Coverage; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [payers, setPayers] = useState<Payer[]>([]);
  const [f, setF] = useState({ payerId: item?.payerId ?? '', memberNo: item?.memberNo ?? '', planName: item?.planName ?? '', employeeNo: item?.employeeNo ?? '',
    validFrom: item?.validFrom ?? '', validTo: item?.validTo ?? '', isActive: item?.isActive ?? true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { if (!item) void api<Payer[]>('/payers').then((p) => setPayers(p.filter((x) => x.isActive))).catch(() => undefined); }, [item]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    const t = (v: string) => (v.trim() === '' ? null : v.trim());
    const body = { memberNo: t(f.memberNo), planName: t(f.planName), employeeNo: t(f.employeeNo), validFrom: t(f.validFrom), validTo: t(f.validTo) };
    try {
      if (item) await api(`/patients/${patientId}/coverages/${item.id}`, { method: 'PUT', body: { ...body, isActive: f.isActive }, headers: { 'if-match': `"${item.version}"` } });
      else await api(`/patients/${patientId}/coverages`, { method: 'POST', body: { ...body, payerId: f.payerId } });
      await onDone(item ? 'Penjamin disimpan.' : 'Penjamin ditambahkan.');
    } catch (err) { setError(errorText(err, 'Gagal menyimpan penjamin')); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title={item ? `Ubah penjamin — ${item.payerName}` : 'Tambah penjamin'}
            description="Kepesertaan asuransi diverifikasi manual oleh petugas saat kunjungan (OD-032).">
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {item ? null : (
          <Field id="cv-payer" label="Penjamin *">
            <Select id="cv-payer" value={f.payerId} onChange={(e) => set('payerId', e.target.value)}>
              <option value="">— pilih —</option>
              {payers.map((p) => <option key={p.id} value={p.id}>{p.name} ({PAYER_TYPE_LABEL[p.payerType]})</option>)}
            </Select>
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="cv-no" label="No. peserta/polis"><Input id="cv-no" maxLength={50} value={f.memberNo} onChange={(e) => set('memberNo', e.target.value)} /></Field>
          <Field id="cv-plan" label="Plan/kelas"><Input id="cv-plan" maxLength={100} value={f.planName} onChange={(e) => set('planName', e.target.value)} /></Field>
          <Field id="cv-emp" label="No. karyawan"><Input id="cv-emp" maxLength={50} value={f.employeeNo} onChange={(e) => set('employeeNo', e.target.value)} /></Field>
          <div />
          <Field id="cv-from" label="Berlaku mulai"><Input id="cv-from" type="date" value={f.validFrom} onChange={(e) => set('validFrom', e.target.value)} /></Field>
          <Field id="cv-to" label="Berlaku sampai"><Input id="cv-to" type="date" value={f.validTo} onChange={(e) => set('validTo', e.target.value)} /></Field>
        </div>
        {item ? <label className="flex items-center gap-2 text-sm"><Switch checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} aria-label="Aktif" /> Aktif</label> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!item && !f.payerId}>Simpan</Button>
        </div>
      </form>
    </Dialog>
  );
}

function ConsentDialog({ patientId, onClose, onDone }: { patientId: string; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [docs, setDocs] = useState<ConsentDocument[]>();
  const [docId, setDocId] = useState('');
  const [granted, setGranted] = useState(true);
  const [name, setName] = useState('');
  const [relation, setRelation] = useState('Diri sendiri');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    void api<ConsentDocument[]>('/consent-documents').then((d) => { setDocs(d); setDocId(d[0]?.id ?? ''); }).catch((e) => setError(errorText(e, 'Gagal memuat dokumen consent')));
  }, []);
  const doc = docs?.find((d) => d.id === docId);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await api(`/patients/${patientId}/consents`, { method: 'POST', body: { consentDocumentId: docId, granted, signedByName: name.trim() || null, signedByRelation: relation.trim() || null } });
      await onDone('Consent dicatat.');
    } catch (err) { setError(errorText(err, 'Gagal mencatat consent')); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title="Catat consent" className="max-w-2xl">
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {docs && docs.length === 0 ? <Alert tone="info">Belum ada dokumen consent. Admin klinik menerbitkannya di Pengaturan klinik → Dokumen consent.</Alert> : null}
        {docs && docs.length > 0 ? (
          <>
            <Field id="cs-doc" label="Dokumen">
              <Select id="cs-doc" value={docId} onChange={(e) => setDocId(e.target.value)}>
                {docs.map((d) => <option key={d.id} value={d.id}>{CONSENT_TYPE_LABEL[d.consentType]} — versi {d.version}{d.title ? ` — ${d.title}` : ''}</option>)}
              </Select>
            </Field>
            {doc ? <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded border bg-muted/40 p-3 text-sm" data-testid="consent-text">{doc.content}</div> : null}
            <fieldset className="flex gap-4 text-sm">
              <legend className="sr-only">Keputusan</legend>
              <label className="flex items-center gap-2"><input type="radio" name="cs-granted" checked={granted} onChange={() => setGranted(true)} /> Setuju</label>
              <label className="flex items-center gap-2"><input type="radio" name="cs-granted" checked={!granted} onChange={() => setGranted(false)} /> Menolak</label>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="cs-name" label="Nama penanda tangan"><Input id="cs-name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field id="cs-rel" label="Hubungan dengan pasien"><Input id="cs-rel" maxLength={50} value={relation} onChange={(e) => setRelation(e.target.value)} /></Field>
            </div>
          </>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!docId}>Simpan</Button>
        </div>
      </form>
    </Dialog>
  );
}

function RevokeButton({ patientId, consentId, onDone }: { patientId: string; consentId: string; onDone: (m: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try { await api(`/patients/${patientId}/consents/${consentId}/revoke`, { method: 'POST', body: { reason: reason.trim() } }); setOpen(false); await onDone('Consent dicabut.'); }
    catch (err) { setError(errorText(err, 'Gagal mencabut consent')); }
  }
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Cabut</Button>
      {open ? (
        <Dialog open onClose={() => setOpen(false)} title="Cabut consent" description="Catatan consent tidak dihapus; ditandai dicabut beserta alasannya.">
          <form className="grid gap-3" onSubmit={submit} noValidate>
            {error ? <Alert tone="error">{error}</Alert> : null}
            <Field id="cs-revoke" label="Alasan *"><Textarea id="cs-revoke" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Batal</Button>
              <Button type="submit" variant="destructive" disabled={reason.trim().length < 5}>Cabut consent</Button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

function RestrictDialog({ p, onClose, onDone }: { p: Patient; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const on = !p.processingRestricted;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try { await api(`/patients/${p.id}/restriction`, { method: 'POST', body: { restricted: on, reason: reason.trim() } }); await onDone(on ? 'Pemrosesan dibatasi.' : 'Pembatasan dicabut.'); }
    catch (err) { setError(errorText(err, 'Gagal menyimpan')); }
  }
  return (
    <Dialog open onClose={onClose} title={on ? 'Batasi pemrosesan data' : 'Cabut pembatasan'}
            description={on ? 'Atas permintaan pasien: pengingat & pemrosesan opsional dihentikan. Rekam medis, tagihan, dan pelaporan wajib tetap berjalan (OD-068).' : undefined}>
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="rs-reason" label="Alasan / dasar permintaan *"><Textarea id="rs-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" disabled={reason.trim().length < 5}>Simpan</Button>
        </div>
      </form>
    </Dialog>
  );
}

function MergeDialog({ p, onClose }: { p: Patient; onClose: () => void }) {
  const [target, setTarget] = useState<PatientSummary | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true); setError(undefined);
    try {
      const r = await api<Patient>('/patients/merge', { method: 'POST', body: { sourcePatientId: p.id, targetPatientId: target.id, reason: reason.trim() } });
      window.location.assign(`/patients/${r.id}`);
    } catch (err) { setError(errorText(err, 'Gagal menggabungkan pasien')); setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title="Gabungkan pasien" className="max-w-2xl"
            description={`${p.fullName} (${p.mrn}) akan ditandai "digabung" ke pasien tujuan. Data tidak dihapus; penjamin & kontak disalin ke tujuan.`}>
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="mg-target" label="Pasien tujuan (data yang benar) *">
          {target ? (
            <div className="flex items-center justify-between gap-2 rounded border p-2">
              <PatientLine p={target} />
              <Button type="button" size="sm" variant="ghost" onClick={() => setTarget(null)}>Ganti</Button>
            </div>
          ) : <PatientPicker id="mg-target" label="Cari pasien tujuan" exclude={p.id} onPick={setTarget} />}
        </Field>
        <Field id="mg-reason" label="Alasan *" hint="Minimal 10 karakter; tercatat di log audit kedua pasien.">
          <Textarea id="mg-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" variant="destructive" loading={busy} disabled={!target || reason.trim().length < 10}>Gabungkan</Button>
        </div>
      </form>
    </Dialog>
  );
}
