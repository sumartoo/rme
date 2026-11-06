'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, Field, Input, Select, TBody, TD, TH, THead, TR, Table, Textarea } from '@clinicrme/ui';
import { Appointment, Encounter, Page, Patient, PatientSummary, Practitioner, ServiceUnit, api, errorText } from '../../../lib/api';
import { ENCOUNTER_STATUS, NEEDS_ELIGIBILITY, PAYER_TYPE_LABEL, TICKET_STATUS, TZ_SHORT, fmtDate, todayWib } from '../../../lib/format';
import { can, useSession } from '../../../lib/session';
import { PatientLine, PatientPicker } from '../../../components/patient-picker';

/**
 * Kunjungan hari ini (SCH-FR-005, 006, 013): daftar walk-in, check-in janji temu, papan status, batal. Setiap kunjungan
 * langsung mendapat nomor antrean poli. Penjamin Asuransi/Perusahaan wajib diverifikasi manual oleh petugas (OD-032).
 */
export default function VisitsPage() {
  const s = useSession();
  const create = can(s, 'encounter.create');
  const [date, setDate] = useState(todayWib());
  const [unit, setUnit] = useState('');
  const [units, setUnits] = useState<ServiceUnit[]>([]);
  const [items, setItems] = useState<Encounter[]>();
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<{ text: string; warnings: string[] }>();
  const [dialog, setDialog] = useState<{ kind: 'walkin' } | { kind: 'checkin'; a: Appointment } | { kind: 'cancel'; e: Encounter }>();

  useEffect(() => { void api<ServiceUnit[]>('/service-units').then((u) => setUnits(u.filter((x) => x.unitType !== 'FARMASI' && x.unitType !== 'KASIR'))).catch(() => undefined); }, []);
  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ date, limit: '200' });
      if (unit) p.set('unitId', unit);
      const [e, a] = await Promise.all([
        api<Page<Encounter>>(`/encounters?${p}`),
        create && date === todayWib() && can(s, 'appointment.read') ? api<Page<Appointment>>(`/appointments?date=${date}&status=BOOKED&limit=200`) : Promise.resolve({ data: [] as Appointment[] }),
      ]);
      setItems(e.data); setAppts(a.data.filter((x) => !unit || x.unitId === unit)); setError(undefined);
    } catch (err) { setError(errorText(err, 'Gagal memuat kunjungan')); }
  }, [date, unit, create, s]);
  useEffect(() => { void load(); }, [load]);
  async function done(e: Encounter | null, text: string) {
    setDialog(undefined); await load();
    setNotice({ text: e?.queue ? `${text} Nomor antrean ${e.queue.displayCode} (${e.encounterNo}).` : text, warnings: e?.warnings ?? [] });
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Kunjungan</h1>
        {create ? <Button className="ml-auto" onClick={() => { setNotice(undefined); setDialog({ kind: 'walkin' }); }}>Daftar walk-in</Button> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" aria-label="Tanggal" className="w-44" max={todayWib()} value={date} onChange={(e) => setDate(e.target.value || todayWib())} />
        <Select aria-label="Poli" className="w-56" value={unit} onChange={(e) => setUnit(e.target.value)}>
          <option value="">Semua poli</option>
          {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
      </div>
      {notice ? (
        <Alert tone="success" data-testid="visit-notice">{notice.text}
          {notice.warnings.length ? <ul className="mt-1 list-disc pl-5 text-amber-800">{notice.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
        </Alert>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      {create && appts.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>Janji temu hari ini — belum check-in</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <THead><TR><TH>Jam</TH><TH>Pasien</TH><TH>Dokter / poli</TH><TH /></TR></THead>
              <TBody>
                {appts.map((a) => (
                  <TR key={a.id} data-testid="checkin-row">
                    <TD className="font-mono text-sm">{a.localTime}</TD>
                    <TD>{a.patient.fullName} <span className="font-mono text-xs text-muted-foreground">{a.patient.mrn}</span></TD>
                    <TD className="text-xs">{a.practitionerName}<span className="block text-muted-foreground">{a.unitName}</span></TD>
                    <TD className="text-right"><Button size="sm" onClick={() => { setNotice(undefined); setDialog({ kind: 'checkin', a }); }}>Check-in</Button></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>Kunjungan {date === todayWib() ? 'hari ini' : fmtDate(date)}</CardTitle></CardHeader>
        <CardContent>
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada kunjungan.</p>
          ) : (
            <Table>
              <THead><TR><TH>Antrean</TH><TH>Datang</TH><TH>Pasien</TH><TH>Poli / dokter</TH><TH>Penjamin</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {items.map((e) => {
                  const st = ENCOUNTER_STATUS[e.status];
                  return (
                    <TR key={e.id} data-testid="visit-row">
                      <TD><span className="font-mono text-base font-semibold">{e.queue?.displayCode ?? '—'}</span>
                        {e.queue ? <Badge tone={TICKET_STATUS[e.queue.status].tone} className="ml-1">{TICKET_STATUS[e.queue.status].label}</Badge> : null}</TD>
                      <TD className="whitespace-nowrap text-xs">{e.localTime} {TZ_SHORT[e.timezone]}
                        <span className="block text-muted-foreground">{e.arrivalType === 'WALK_IN' ? 'Walk-in' : 'Janji temu'}{e.arrivedLate ? ' · terlambat' : ''}</span></TD>
                      <TD><Link className="font-medium hover:underline" href={`/patients/${e.patient.id}`}>{e.patient.fullName}</Link>
                        <span className="block font-mono text-xs text-muted-foreground">{e.patient.mrn} · {e.encounterNo}</span></TD>
                      <TD className="text-xs">{e.unitName}<span className="block text-muted-foreground">{e.practitionerName}</span></TD>
                      <TD className="text-xs">{PAYER_TYPE_LABEL[e.payerType]}{e.coverage ? <span className="block text-muted-foreground">{e.coverage.payerName}</span> : null}</TD>
                      <TD><Badge tone={st.tone}>{st.label}</Badge>{e.cancelReason ? <span className="block text-xs text-muted-foreground">{e.cancelReason}</span> : null}</TD>
                      <TD className="text-right">
                        {can(s, 'encounter.cancel') && ['REGISTERED', 'ARRIVED', 'TRIAGED'].includes(e.status)
                          ? <Button size="sm" variant="ghost" onClick={() => { setNotice(undefined); setDialog({ kind: 'cancel', e }); }}>Batalkan</Button> : null}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {dialog?.kind === 'walkin' ? <RegisterDialog units={units} onClose={() => setDialog(undefined)} onDone={(e) => done(e, 'Kunjungan walk-in didaftarkan.')} /> : null}
      {dialog?.kind === 'checkin' ? <RegisterDialog units={units} appointment={dialog.a} onClose={() => setDialog(undefined)} onDone={(e) => done(e, `${dialog.a.patient.fullName} sudah check-in.`)} /> : null}
      {dialog?.kind === 'cancel' ? <CancelDialog e={dialog.e} onClose={() => setDialog(undefined)} onDone={() => done(null, 'Kunjungan dibatalkan.')} /> : null}
    </div>
  );
}

/** Walk-in (pilih pasien, poli, dokter) atau check-in janji temu (poli & dokter mengikuti janji). Penjamin dipilih di sini. */
function RegisterDialog({ units, appointment, onClose, onDone }: { units: ServiceUnit[]; appointment?: Appointment; onClose: () => void; onDone: (e: Encounter) => Promise<void> }) {
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [detail, setDetail] = useState<Patient>();
  const [unitId, setUnitId] = useState('');
  const [practitioners, setPractitioners] = useState<Practitioner[]>([]);
  const [practitionerId, setPractitionerId] = useState('');
  const [coverageId, setCoverageId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const idemKey = useMemo(() => `enc-${crypto.randomUUID()}`, []);
  const patientId = appointment?.patient.id ?? patient?.id;
  useEffect(() => {
    if (!patientId) { setDetail(undefined); return; }
    void api<Patient>(`/patients/${patientId}`).then(setDetail).catch((e) => setError(errorText(e, 'Gagal memuat data pasien')));
  }, [patientId]);
  useEffect(() => {
    if (appointment) return;
    void api<Page<Practitioner>>('/practitioners?limit=200').then((p) => setPractitioners(p.data.filter((x) => x.practitionerType.startsWith('DOKTER') || x.practitionerType === 'BIDAN'))).catch(() => undefined);
  }, [appointment]);
  const today = todayWib();
  const coverages = (detail?.coverages ?? []).filter((c) => c.isActive && (!c.validTo || c.validTo >= today) && (!c.validFrom || c.validFrom <= today));
  const chosen = coverages.find((c) => c.id === coverageId);
  const needNote = !!chosen && NEEDS_ELIGIBILITY(chosen.payerType);
  const ok = !!patientId && (appointment || (unitId && practitionerId)) && (!needNote || note.trim().length >= 3) && detail?.status !== 'MERGED';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    const cov = { coverageId: coverageId || null, eligibilityNote: needNote ? note.trim() : null };
    try {
      const r = appointment
        ? await api<Encounter>(`/appointments/${appointment.id}/check-in`, { method: 'POST', body: cov, headers: { 'idempotency-key': idemKey } })
        : await api<Encounter>('/encounters/walk-in', { method: 'POST', body: { patientId, unitId, practitionerId, ...cov }, headers: { 'idempotency-key': idemKey } });
      await onDone(r);
    } catch (err) { setError(errorText(err, 'Gagal mendaftarkan kunjungan')); setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} title={appointment ? 'Check-in janji temu' : 'Daftar kunjungan walk-in'} className="max-w-2xl"
            description={appointment ? `${appointment.patient.fullName} — ${appointment.localTime}, ${appointment.practitionerName} (${appointment.unitName})` : undefined}>
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {appointment ? null : (
          <Field id="wi-patient" label="Pasien *">
            {patient ? (
              <div className="flex items-center justify-between gap-2 rounded border p-2">
                <PatientLine p={patient} />
                <Button type="button" size="sm" variant="ghost" onClick={() => { setPatient(null); setCoverageId(''); }}>Ganti</Button>
              </div>
            ) : <PatientPicker id="wi-patient" label="Cari pasien" onPick={setPatient} />}
          </Field>
        )}
        {detail?.processingRestricted ? <Alert tone="info">Pasien meminta pembatasan pemrosesan data — layanan tetap berjalan.</Alert> : null}
        {appointment ? null : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="wi-unit" label="Poli *">
              <Select id="wi-unit" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                <option value="">— pilih —</option>
                {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Select>
            </Field>
            <Field id="wi-dr" label="Dokter *">
              <Select id="wi-dr" value={practitionerId} onChange={(e) => setPractitionerId(e.target.value)}>
                <option value="">— pilih —</option>
                {practitioners.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
              </Select>
            </Field>
          </div>
        )}
        {patientId ? (
          <Field id="wi-cov" label="Penjamin" hint={coverages.length === 0 ? 'Pasien belum punya penjamin aktif — tambahkan di halaman pasien bila perlu.' : undefined}>
            <Select id="wi-cov" value={coverageId} onChange={(e) => { setCoverageId(e.target.value); setNote(''); }}>
              <option value="">Umum (bayar sendiri)</option>
              {coverages.map((c) => <option key={c.id} value={c.id}>{c.payerName} ({PAYER_TYPE_LABEL[c.payerType]}){c.memberNo ? ` — ${c.memberNo}` : ''}</option>)}
            </Select>
          </Field>
        ) : null}
        {needNote ? (
          <Field id="wi-note" label="Verifikasi kepesertaan *" hint="Wajib (OD-032): catat cara verifikasi, mis. nomor konfirmasi telepon ke asuransi/HRD.">
            <Textarea id="wi-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!ok}>{appointment ? 'Check-in' : 'Daftarkan & ambil nomor antrean'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function CancelDialog({ e, onClose, onDone }: { e: Encounter; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    try { await api(`/encounters/${e.id}/cancel`, { method: 'POST', body: { reason: reason.trim() } }); await onDone(); }
    catch (err) { setError(errorText(err, 'Gagal membatalkan')); }
  }
  return (
    <Dialog open onClose={onClose} title="Batalkan kunjungan" description={`${e.patient.fullName} — ${e.encounterNo}, antrean ${e.queue?.displayCode ?? '—'}. Nomor antrean ikut batal.`}>
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="vc-reason" label="Alasan *"><Textarea id="vc-reason" rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} /></Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Kembali</Button>
          <Button type="submit" variant="destructive" disabled={reason.trim().length < 3}>Batalkan kunjungan</Button>
        </div>
      </form>
    </Dialog>
  );
}
