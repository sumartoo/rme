'use client';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Field, Input, Select, Switch, Textarea } from '@clinicrme/ui';
import { ApiError, IdentityType, Patient, PatientContact, PatientSummary, Payer, Sex, api, errorText } from '../../../lib/api';
import { IDENTITY_LABEL, SEX_LABEL, todayWib } from '../../../lib/format';
import { PatientLine, PatientPicker } from '../../../components/patient-picker';
import { RegionPicker } from '../../../components/region-picker';

const NIK = /^(1[1-9]|[2-9]\d)\d{14}$/;
type Cov = { payerId: string; memberNo: string; validTo: string };

/**
 * Form pasien (REG-FR-001/002/006/007, OD-085). Tambah: kandidat duplikat dari server ditampilkan sebelum menyimpan;
 * petugas memilih pasien yang ada atau melanjutkan dengan alasan. Ubah: NIK/identitas kosong = tetap.
 */
export function PatientForm({ patient, onDone, onCancel }: {
  patient?: Patient; onDone: (p: Patient, created: boolean) => void; onCancel: () => void;
}) {
  const [f, setF] = useState({
    fullName: patient?.fullName ?? '', birthDate: patient?.birthDate ?? '', sex: (patient?.sex ?? '') as Sex | '',
    identityType: (patient?.identityType ?? 'NIK') as IdentityType, nik: '', identityValue: '', phone: patient?.phone ?? '',
    email: patient?.email ?? '', address: patient?.address ?? '', regionCode: patient?.regionCode ?? '',
  });
  const [mother, setMother] = useState<PatientSummary | null>(patient?.mother ?? null);
  const [contacts, setContacts] = useState<PatientContact[]>(patient?.contacts.map((c) => ({ ...c })) ?? []);
  const [covs, setCovs] = useState<Cov[]>([]);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [dups, setDups] = useState<{ exact: boolean; list: PatientSummary[] }>();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const idemKey = useMemo(() => `reg-${crypto.randomUUID()}`, []);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  useEffect(() => { if (!patient) void api<Payer[]>('/payers').then((p) => setPayers(p.filter((x) => x.isActive))).catch(() => undefined); }, [patient]);

  const storedId = patient && patient.identityType === f.identityType ? (patient.nikMasked ?? patient.identityMasked) : null;
  const local: Record<string, string> = {};
  if (f.nik && !NIK.test(f.nik)) local.nik = 'NIK harus 16 digit angka';
  if (f.birthDate && f.birthDate > todayWib()) local.birthDate = 'Tanggal lahir tidak boleh di masa depan';
  const err = (k: string) => local[k] ?? errors[k];

  function body(withReason: boolean) {
    const t = (v: string) => (v.trim() === '' ? null : v.trim());
    const b: Record<string, unknown> = {
      fullName: f.fullName.trim(), birthDate: f.birthDate, sex: f.sex, identityType: f.identityType, phone: t(f.phone), email: t(f.email),
      address: f.address.trim(), regionCode: t(f.regionCode), motherPatientId: f.identityType === 'BAYI_IDENTITAS_IBU' ? mother?.id ?? null : null,
      contacts: contacts.filter((c) => c.fullName.trim() || c.phone.trim())
        .map((c) => ({ relation: c.relation.trim(), fullName: c.fullName.trim(), phone: c.phone.trim(), isGuardian: c.isGuardian })),
    };
    if (f.identityType === 'NIK' && f.nik) b.nik = f.nik;
    if ((f.identityType === 'PASPOR' || f.identityType === 'KITAS') && f.identityValue.trim()) b.identityValue = f.identityValue.trim();
    if (!patient) {
      b.coverages = covs.filter((c) => c.payerId).map((c) => ({ payerId: c.payerId, memberNo: t(c.memberNo), validTo: t(c.validTo) }));
      if (withReason) b.duplicateOverrideReason = reason.trim();
    }
    return b;
  }

  async function submit(withReason = false) {
    if (Object.keys(local).length) return;
    setBusy(true); setError(undefined); setErrors({});
    try {
      const p = patient
        ? await api<Patient>(`/patients/${patient.id}`, { method: 'PUT', body: body(false), headers: { 'if-match': `"${patient.version}"` } })
        : await api<Patient>('/patients', { method: 'POST', body: body(withReason), headers: { 'idempotency-key': withReason ? `${idemKey}-ok` : idemKey } });
      onDone(p, !patient);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'PAT-409-DUPLICATE' || e.code === 'PAT-409-IDENTITY') && e.problem.candidates) {
        setDups({ exact: e.code === 'PAT-409-IDENTITY', list: e.problem.candidates });
      } else if (e instanceof ApiError && e.problem.errors?.length) {
        setErrors(Object.fromEntries(e.problem.errors.map((x) => [x.field.split('.')[0], x.message])));
        setError('Periksa kembali isian yang ditandai.');
      } else setError(errorText(e, 'Gagal menyimpan data pasien'));
    } finally { setBusy(false); }
  }

  const required = f.fullName.trim().length >= 2 && f.birthDate && f.sex && f.address.trim().length >= 5;
  return (
    <form className="grid gap-4" noValidate onSubmit={(e) => { e.preventDefault(); void submit(false); }}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {dups ? (
        <div className="grid gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/30" role="alert" data-testid="duplicate-panel">
          <p className="font-medium">{dups.exact ? 'Identitas ini sudah terdaftar.' : 'Ada pasien dengan data mirip. Pastikan bukan orang yang sama.'}</p>
          <ul className="grid gap-2">
            {dups.list.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 rounded border bg-card p-2">
                <PatientLine p={p} />
                <a className="shrink-0 text-sm font-medium text-primary underline" href={`/patients/${p.id}`}>Pakai pasien ini</a>
              </li>
            ))}
          </ul>
          {dups.exact ? null : (
            <>
              <Field id="pf-reason" label="Alasan tetap mendaftarkan sebagai pasien baru *" hint="Minimal 10 karakter; tercatat di log audit.">
                <Textarea id="pf-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <div className="flex justify-end">
                <Button type="button" variant="outline" disabled={reason.trim().length < 10} loading={busy} onClick={() => void submit(true)}>Tetap daftarkan baru</Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-semibold">Identitas</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="pf-idtype" label="Jenis identitas *">
            <Select id="pf-idtype" value={f.identityType} onChange={(e) => set('identityType', e.target.value as IdentityType)}>
              {Object.entries(IDENTITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          {f.identityType === 'NIK' ? (
            <Field id="pf-nik" label={storedId ? `NIK (tersimpan: ${storedId})` : 'NIK *'} error={err('nik')}
                   hint={storedId ? 'Kosongkan untuk tetap memakai NIK tersimpan.' : '16 digit sesuai KTP/KK.'}>
              <Input id="pf-nik" inputMode="numeric" autoComplete="off" maxLength={16} value={f.nik} aria-invalid={!!err('nik')}
                     onChange={(e) => set('nik', e.target.value.replace(/\D/g, ''))} />
            </Field>
          ) : f.identityType === 'PASPOR' || f.identityType === 'KITAS' ? (
            <Field id="pf-idv" label={storedId ? `Nomor ${IDENTITY_LABEL[f.identityType]} (tersimpan: ${storedId})` : `Nomor ${IDENTITY_LABEL[f.identityType]} *`}
                   error={err('identityValue')}>
              <Input id="pf-idv" autoComplete="off" maxLength={30} value={f.identityValue} onChange={(e) => set('identityValue', e.target.value.toUpperCase())} />
            </Field>
          ) : null}
        </div>
        {f.identityType === 'BAYI_IDENTITAS_IBU' ? (
          <Field id="pf-mother" label="Pasien ibu *" error={err('motherPatientId')}>
            {mother ? (
              <div className="flex items-center justify-between gap-2 rounded border p-2">
                <PatientLine p={mother} />
                <Button type="button" size="sm" variant="ghost" onClick={() => setMother(null)}>Ganti</Button>
              </div>
            ) : <PatientPicker id="pf-mother" label="Cari pasien ibu" onPick={setMother} exclude={patient?.id} />}
          </Field>
        ) : null}
        <Field id="pf-name" label="Nama lengkap *" error={err('fullName')}>
          <Input id="pf-name" maxLength={200} value={f.fullName} onChange={(e) => set('fullName', e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="pf-dob" label="Tanggal lahir *" error={err('birthDate')}>
            <Input id="pf-dob" type="date" max={todayWib()} value={f.birthDate} onChange={(e) => set('birthDate', e.target.value)} />
          </Field>
          <Field id="pf-sex" label="Jenis kelamin *" error={err('sex')}>
            <Select id="pf-sex" value={f.sex} onChange={(e) => set('sex', e.target.value as Sex)}>
              <option value="">— pilih —</option>
              {Object.entries(SEX_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
        </div>
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-semibold">Alamat & kontak</legend>
        <Field id="pf-address" label="Alamat *" error={err('address')}>
          <Textarea id="pf-address" rows={2} maxLength={500} value={f.address} onChange={(e) => set('address', e.target.value)} />
        </Field>
        <RegionPicker idPrefix="pf-region" value={f.regionCode} onChange={(c) => set('regionCode', c)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="pf-phone" label="Telepon pasien" error={err('phone')} hint="Wajib bila tidak ada kontak darurat.">
            <Input id="pf-phone" inputMode="tel" maxLength={20} value={f.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field id="pf-email" label="Email" error={err('email')}>
            <Input id="pf-email" type="email" maxLength={200} value={f.email} onChange={(e) => set('email', e.target.value)} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-semibold">Kontak darurat & wali</legend>
        {contacts.map((c, i) => (
          <div key={i} className="grid items-end gap-2 sm:grid-cols-[8rem_1fr_10rem_auto_auto]" data-testid="contact-row">
            <Field id={`pf-c-rel-${i}`} label="Hubungan"><Input id={`pf-c-rel-${i}`} maxLength={50} value={c.relation}
              onChange={(e) => setContacts((x) => x.map((y, j) => (j === i ? { ...y, relation: e.target.value } : y)))} /></Field>
            <Field id={`pf-c-name-${i}`} label="Nama"><Input id={`pf-c-name-${i}`} maxLength={200} value={c.fullName}
              onChange={(e) => setContacts((x) => x.map((y, j) => (j === i ? { ...y, fullName: e.target.value } : y)))} /></Field>
            <Field id={`pf-c-phone-${i}`} label="Telepon"><Input id={`pf-c-phone-${i}`} inputMode="tel" maxLength={20} value={c.phone}
              onChange={(e) => setContacts((x) => x.map((y, j) => (j === i ? { ...y, phone: e.target.value } : y)))} /></Field>
            <label className="flex h-9 items-center gap-2 text-sm"><Switch checked={c.isGuardian} aria-label={`Wali ${i + 1}`}
              onChange={(e) => setContacts((x) => x.map((y, j) => (j === i ? { ...y, isGuardian: e.target.checked } : y)))} /> Wali</label>
            <Button type="button" size="sm" variant="ghost" onClick={() => setContacts((x) => x.filter((_, j) => j !== i))}>Hapus</Button>
          </div>
        ))}
        {errors.contacts ? <p className="text-sm text-destructive">{errors.contacts}</p> : null}
        <div><Button type="button" size="sm" variant="outline" disabled={contacts.length >= 10}
          onClick={() => setContacts((x) => [...x, { relation: '', fullName: '', phone: '', isGuardian: false }])}>Tambah kontak</Button></div>
      </fieldset>

      {!patient ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-semibold">Penjamin</legend>
          <p className="text-xs text-muted-foreground">Kosongkan bila pasien umum (bayar sendiri). Penjamin dapat ditambah nanti di halaman pasien.</p>
          {covs.map((c, i) => (
            <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_10rem_10rem_auto]">
              <Field id={`pf-cov-payer-${i}`} label="Penjamin">
                <Select id={`pf-cov-payer-${i}`} value={c.payerId} onChange={(e) => setCovs((x) => x.map((y, j) => (j === i ? { ...y, payerId: e.target.value } : y)))}>
                  <option value="">— pilih —</option>
                  {payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </Field>
              <Field id={`pf-cov-no-${i}`} label="No. peserta/polis"><Input id={`pf-cov-no-${i}`} maxLength={50} value={c.memberNo}
                onChange={(e) => setCovs((x) => x.map((y, j) => (j === i ? { ...y, memberNo: e.target.value } : y)))} /></Field>
              <Field id={`pf-cov-to-${i}`} label="Berlaku sampai"><Input id={`pf-cov-to-${i}`} type="date" value={c.validTo}
                onChange={(e) => setCovs((x) => x.map((y, j) => (j === i ? { ...y, validTo: e.target.value } : y)))} /></Field>
              <Button type="button" size="sm" variant="ghost" onClick={() => setCovs((x) => x.filter((_, j) => j !== i))}>Hapus</Button>
            </div>
          ))}
          <div><Button type="button" size="sm" variant="outline" disabled={covs.length >= 5}
            onClick={() => setCovs((x) => [...x, { payerId: '', memberNo: '', validTo: '' }])}>Tambah penjamin</Button></div>
        </fieldset>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>Batal</Button>
        <Button type="submit" loading={busy && !dups} disabled={!required}>{patient ? 'Simpan perubahan' : 'Daftarkan pasien'}</Button>
      </div>
    </form>
  );
}
