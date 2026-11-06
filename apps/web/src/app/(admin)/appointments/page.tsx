'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Dialog, Field, Input, Select, TBody, TD, TH, THead, TR, Table, Textarea } from '@clinicrme/ui';
import { Appointment, Page, PatientSummary, SlotSession, api, errorText } from '../../../lib/api';
import { APPOINTMENT_STATUS, TZ_SHORT, fmtDate, slotTime, todayWib } from '../../../lib/format';
import { can, useSession } from '../../../lib/session';
import { PatientLine, PatientPicker } from '../../../components/patient-picker';

/** Janji temu per tanggal (SCH-FR-003, 010, 011): buat, batal (alasan wajib), jadwal ulang. Check-in di batch 3. */
export default function AppointmentsPage() {
  const s = useSession();
  const manage = can(s, 'appointment.manage');
  const [date, setDate] = useState(todayWib());
  const [status, setStatus] = useState('');
  const [doctor, setDoctor] = useState('');
  const [items, setItems] = useState<Appointment[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [dialog, setDialog] = useState<{ kind: 'new' } | { kind: 'cancel' | 'reschedule'; a: Appointment }>();

  const seq = useRef(0);   // respons lama (tanggal sebelumnya) tidak menimpa hasil terbaru
  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const p = new URLSearchParams({ date, limit: '200' });
      if (status) p.set('status', status);
      const r = await api<Page<Appointment>>(`/appointments?${p}`);
      if (my !== seq.current) return;
      setItems(r.data); setError(undefined);
    } catch (e) { setError(errorText(e, 'Gagal memuat janji temu')); }
  }, [date, status]);
  useEffect(() => { void load(); }, [load]);
  async function done(msg: string) { setDialog(undefined); await load(); setNotice(msg); }
  const doctors = useMemo(() => [...new Set((items ?? []).map((a) => a.practitionerName))].sort(), [items]);
  const shown = (items ?? []).filter((a) => !doctor || a.practitionerName === doctor);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Janji temu</h1>
        {manage ? <Button className="ml-auto" onClick={() => { setNotice(undefined); setDialog({ kind: 'new' }); }}>Buat janji temu</Button> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" aria-label="Tanggal" className="w-44" value={date} onChange={(e) => setDate(e.target.value || todayWib())} />
        <Select aria-label="Dokter" className="w-56" value={doctor} onChange={(e) => setDoctor(e.target.value)}>
          <option value="">Semua dokter</option>
          {doctors.map((d) => <option key={d} value={d}>{d}</option>)}
        </Select>
        <Select aria-label="Status" className="w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Semua status</option>
          {Object.entries(APPOINTMENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada janji temu pada {fmtDate(date)}.</p>
          ) : (
            <Table>
              <THead><TR><TH>Jam</TH><TH>Pasien</TH><TH>Dokter</TH><TH>Poli</TH><TH>Status</TH>{manage ? <TH /> : null}</TR></THead>
              <TBody>
                {shown.map((a) => {
                  const st = APPOINTMENT_STATUS[a.status];
                  return (
                    <TR key={a.id} data-testid="appointment-row">
                      <TD className="whitespace-nowrap font-mono text-sm">{a.localTime} <span className="text-xs text-muted-foreground">{TZ_SHORT[a.timezone]}</span></TD>
                      <TD><Link className="font-medium hover:underline" href={`/patients/${a.patient.id}`}>{a.patient.fullName}</Link>
                        <span className="block font-mono text-xs text-muted-foreground">{a.patient.mrn}{a.patient.phone ? ` · ${a.patient.phone}` : ''}</span></TD>
                      <TD className="text-sm">{a.practitionerName}</TD>
                      <TD className="text-xs">{a.unitName}<span className="block text-muted-foreground">{a.branchName}</span></TD>
                      <TD><Badge tone={st.tone}>{st.label}</Badge>{a.statusReason ? <span className="block text-xs text-muted-foreground">{a.statusReason}</span> : null}</TD>
                      {manage ? (
                        <TD className="whitespace-nowrap text-right">
                          {a.status === 'BOOKED' ? (
                            <>
                              <Button size="sm" variant="outline" onClick={() => { setNotice(undefined); setDialog({ kind: 'reschedule', a }); }}>Jadwal ulang</Button>{' '}
                              <Button size="sm" variant="ghost" onClick={() => { setNotice(undefined); setDialog({ kind: 'cancel', a }); }}>Batalkan</Button>
                            </>
                          ) : null}
                        </TD>
                      ) : null}
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {dialog?.kind === 'new' ? <BookDialog onClose={() => setDialog(undefined)} onDone={async (a) => { setDate(a.localDate); await done(`Janji temu ${a.patient.fullName} — ${fmtDate(a.localDate)} ${a.localTime} dibuat.`); }} /> : null}
      {dialog?.kind === 'reschedule' ? <BookDialog original={dialog.a} onClose={() => setDialog(undefined)} onDone={async (a) => { setDate(a.localDate); await done(`Dijadwalkan ulang ke ${fmtDate(a.localDate)} ${a.localTime}.`); }} /> : null}
      {dialog?.kind === 'cancel' ? <CancelDialog a={dialog.a} onClose={() => setDialog(undefined)} onDone={done} /> : null}
    </div>
  );
}

/** Pilih slot tersedia pada satu tanggal; slot dikelompokkan per sesi dokter. */
function SlotPicker({ date, value, onPick, practitionerId }: { date: string; value: string; onPick: (s: { start: string; practitionerId: string }) => void; practitionerId?: string }) {
  const [sessions, setSessions] = useState<SlotSession[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setSessions(undefined);
    void api<{ sessions: SlotSession[] }>(`/slots?date=${date}${practitionerId ? `&practitionerId=${practitionerId}` : ''}`)
      .then((r) => { setSessions(r.sessions); setError(undefined); }).catch((e) => setError(errorText(e, 'Gagal memuat slot')));
  }, [date, practitionerId]);
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!sessions) return <p className="text-sm text-muted-foreground" role="status">Memuat slot…</p>;
  if (sessions.length === 0) return <p className="text-sm text-muted-foreground">Tidak ada jadwal praktik pada {fmtDate(date)}.</p>;
  return (
    <div className="grid max-h-72 gap-3 overflow-y-auto" data-testid="slot-picker">
      {sessions.map((s) => (
        <div key={s.id} className="grid gap-1.5 rounded-md border p-2">
          <div className="text-sm"><span className="font-medium">{s.practitionerName}</span> · {s.unitName} · {s.startTime}–{s.endTime} {TZ_SHORT[s.timezone]}
            <span className="ml-2 text-xs text-muted-foreground">terisi {s.booked}/{s.quota}</span></div>
          {s.closed ? <p className="text-sm text-amber-700">{s.closed.type === 'CUTI_DOKTER' ? 'Dokter cuti' : 'Cabang libur'}: {s.closed.reason}</p> : (
            <div className="flex flex-wrap gap-1.5">
              {s.slots.map((x) => (
                <Button key={x.start} type="button" size="sm" variant={value === x.start ? 'default' : 'outline'} disabled={!x.available}
                        aria-label={`${s.practitionerName} ${slotTime(x.start)}${x.taken ? ' (terisi)' : ''}`} onClick={() => onPick({ start: x.start, practitionerId: s.practitionerId })}>
                  {slotTime(x.start)}
                </Button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function BookDialog({ original, onClose, onDone }: { original?: Appointment; onClose: () => void; onDone: (a: Appointment) => Promise<void> }) {
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [date, setDate] = useState(original?.localDate ?? todayWib());
  const [slot, setSlot] = useState<{ start: string; practitionerId: string }>();
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const idemKey = useMemo(() => `apt-${crypto.randomUUID()}`, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!slot) return;
    setBusy(true); setError(undefined);
    try {
      const a = original
        ? await api<Appointment>(`/appointments/${original.id}/reschedule`, { method: 'POST', body: { slotStart: slot.start, practitionerId: slot.practitionerId, reason: reason.trim() } })
        : await api<Appointment>('/appointments', { method: 'POST', headers: { 'idempotency-key': idemKey },
            body: { patientId: patient?.id, practitionerId: slot.practitionerId, slotStart: slot.start, notes: notes.trim() || null } });
      await onDone(a);
    } catch (err) { setError(errorText(err, 'Gagal menyimpan janji temu')); setBusy(false); }
  }
  const ok = slot && (original ? reason.trim().length >= 3 : !!patient);
  return (
    <Dialog open onClose={onClose} title={original ? 'Jadwal ulang janji temu' : 'Buat janji temu'} className="max-w-2xl"
            description={original ? `${original.patient.fullName} — semula ${fmtDate(original.localDate)} ${original.localTime}, ${original.practitionerName}` : undefined}>
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {original ? null : (
          <Field id="bk-patient" label="Pasien *">
            {patient ? (
              <div className="flex items-center justify-between gap-2 rounded border p-2">
                <PatientLine p={patient} />
                <Button type="button" size="sm" variant="ghost" onClick={() => setPatient(null)}>Ganti</Button>
              </div>
            ) : <PatientPicker id="bk-patient" label="Cari pasien" onPick={setPatient} />}
          </Field>
        )}
        <Field id="bk-date" label="Tanggal">
          <Input id="bk-date" type="date" min={todayWib()} value={date} onChange={(e) => { setDate(e.target.value || todayWib()); setSlot(undefined); }} />
        </Field>
        <SlotPicker date={date} value={slot?.start ?? ''} onPick={setSlot} />
        {original ? (
          <Field id="bk-reason" label="Alasan jadwal ulang *"><Textarea id="bk-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        ) : (
          <Field id="bk-notes" label="Catatan"><Input id="bk-notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!ok}>{original ? 'Jadwalkan ulang' : 'Simpan janji temu'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function CancelDialog({ a, onClose, onDone }: { a: Appointment; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try { await api(`/appointments/${a.id}/cancel`, { method: 'POST', body: { reason: reason.trim() } }); await onDone('Janji temu dibatalkan.'); }
    catch (err) { setError(errorText(err, 'Gagal membatalkan')); }
  }
  return (
    <Dialog open onClose={onClose} title="Batalkan janji temu" description={`${a.patient.fullName} — ${fmtDate(a.localDate)} ${a.localTime}, ${a.practitionerName}`}>
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="cn-reason" label="Alasan *"><Textarea id="cn-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Kembali</Button>
          <Button type="submit" variant="destructive" disabled={reason.trim().length < 3}>Batalkan janji</Button>
        </div>
      </form>
    </Dialog>
  );
}
