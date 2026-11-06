'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, Field, Input, Select, Switch, Textarea } from '@clinicrme/ui';
import { ApiError, EncounterChart, Page, ServiceItem, SlotSession, api, apiUpload, errorText } from '../../../../lib/api';
import { fmtDateTime, todayWib } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

interface LabResult { id: string; labOrderItemId: string | null; source: 'CONNECTOR' | 'MANUAL' | 'UPLOAD'; testName: string | null; value: string | null;
  unit: string | null; referenceRange: string | null; flag: string | null; fileId: string | null; notes: string | null; resultedAt: string; enteredByName: string | null }
interface LabOrder { id: string; orderNo: string; status: string; connector: string | null; externalOrderId: string | null; clinicalInfo: string | null;
  orderedAt: string; orderedByName: string; cancelReason: string | null; items: { id: string; serviceItemId: string; code: string; name: string }[]; results: LabResult[] }
interface MedicalDocument { id: string; documentNo: string; docType: 'RESUME' | 'SURAT_SEHAT' | 'SURAT_SAKIT' | 'RUJUKAN'; issuedAt: string;
  doctorName: string | null; verificationCode: string }
const LAB_STATUS: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' }> = {
  ORDERED: { label: 'Dipesan', tone: 'info' }, SENT: { label: 'Terkirim ke lab', tone: 'info' }, RECEIVED: { label: 'Diterima lab', tone: 'info' },
  RESULTED: { label: 'Ada hasil', tone: 'success' }, CANCELLED: { label: 'Dibatalkan', tone: 'neutral' }, ERROR: { label: 'Gagal', tone: 'warning' },
};
const FLAG: Record<string, string> = { N: 'Normal', L: 'Rendah', H: 'Tinggi', LL: 'Sangat rendah', HH: 'Sangat tinggi', A: 'Abnormal' };
const DOC_LABEL: Record<MedicalDocument['docType'], string> = { RESUME: 'Resume medis', SURAT_SEHAT: 'Surat keterangan sehat', SURAT_SAKIT: 'Surat keterangan sakit', RUJUKAN: 'Surat rujukan' };

/** Order & hasil lab (CLN-FR-014, 015; OD-059): order saat diperiksa; hasil manual, unggah PDF, atau dari konektor. */
export function LabTab({ chart }: { chart: EncounterChart }) {
  const s = useSession();
  const canOrder = can(s, 'clinical.lab.order') && chart.encounter.status === 'IN_CONSULTATION';
  const canResult = can(s, 'clinical.lab.result.write');
  const [orders, setOrders] = useState<LabOrder[]>();
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [info, setInfo] = useState('');
  const [error, setError] = useState<string>();
  const [resultFor, setResultFor] = useState<LabOrder>();
  const load = useCallback(async () => {
    try { setOrders(await api<LabOrder[]>(`/encounters/${chart.encounter.id}/lab-orders`)); } catch (e) { setError(errorText(e, 'Gagal memuat order lab')); }
  }, [chart.encounter.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (canOrder) void api<Page<ServiceItem>>('/service-items?type=LAB&limit=200').then((r) => setServices(r.data)).catch(() => undefined); }, [canOrder]);
  async function run(fn: () => Promise<unknown>, fallback: string) {
    try { await fn(); setError(undefined); await load(); return true; } catch (e) { setError(errorText(e, fallback)); return false; }
  }
  async function upload(o: LabOrder, file: File) {
    await run(async () => {
      if (file.type !== 'application/pdf') throw new ApiError(400, 'CLN-400-PDF', 'Berkas harus PDF');
      await apiUpload(`/lab-orders/${o.id}/results/upload`, file, 'application/pdf');
    }, 'Gagal mengunggah PDF');
  }
  return (
    <div className="grid gap-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {canOrder ? (
        <Card>
          <CardHeader><CardTitle>Order lab</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            {services.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada layanan berjenis Lab di master Layanan & tarif.</p> : (
              <div className="flex flex-wrap gap-3">
                {services.map((x) => (
                  <label key={x.id} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
                    <input type="checkbox" checked={picked.includes(x.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, x.id] : p.filter((y) => y !== x.id)))} />
                    {x.name}
                  </label>
                ))}
              </div>
            )}
            <Field id="lab-info" label="Informasi klinis"><Input id="lab-info" maxLength={1000} value={info} onChange={(e) => setInfo(e.target.value)} /></Field>
            <Button className="justify-self-start" disabled={!picked.length} onClick={() => void run(async () => {
              await api(`/encounters/${chart.encounter.id}/lab-orders`, { method: 'POST', headers: { 'idempotency-key': `lab-${crypto.randomUUID()}` },
                body: { serviceItemIds: picked, clinicalInfo: info.trim() || null } });
              setPicked([]); setInfo('');
            }, 'Gagal membuat order lab')}>Kirim order lab</Button>
          </CardContent>
        </Card>
      ) : null}
      {!orders ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : orders.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada order lab.</p> : orders.map((o) => (
        <Card key={o.id} data-testid="lab-order">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <span className="font-mono text-sm">{o.orderNo}</span> <Badge tone={LAB_STATUS[o.status]?.tone ?? 'neutral'}>{LAB_STATUS[o.status]?.label ?? o.status}</Badge>
              <span className="text-sm font-normal text-muted-foreground">{o.items.map((i) => i.name).join(', ')}</span>
            </CardTitle>
            <p className="text-xs text-muted-foreground">{fmtDateTime(o.orderedAt)} · {o.orderedByName}{o.externalOrderId ? ` · ${o.externalOrderId}` : ''}{o.clinicalInfo ? ` · ${o.clinicalInfo}` : ''}{o.cancelReason ? ` · batal: ${o.cancelReason}` : ''}</p>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {o.results.map((r) => (
              <div key={r.id} data-testid="lab-result" className="flex flex-wrap gap-x-3 border-b pb-1 last:border-0">
                {r.source === 'UPLOAD'
                  ? <a className="underline" href={`/api/v1/lab-results/${r.id}/file`} target="_blank" rel="noreferrer">{r.testName}</a>
                  : <span><b>{r.testName}</b>: {r.value} {r.unit}{r.referenceRange ? ` (rujukan ${r.referenceRange})` : ''}{r.flag ? ` · ${FLAG[r.flag] ?? r.flag}` : ''}</span>}
                <span className="text-xs text-muted-foreground">{r.source === 'CONNECTOR' ? 'dari aplikasi lab' : r.enteredByName} · {fmtDateTime(r.resultedAt)}{r.notes ? ` · ${r.notes}` : ''}</span>
              </div>
            ))}
            {o.status !== 'CANCELLED' ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {canResult ? <Button size="sm" variant="outline" onClick={() => setResultFor(o)}>Input hasil</Button> : null}
                {canResult ? (
                  <label className="inline-flex h-8 cursor-pointer items-center rounded-md border px-3 text-sm font-medium hover:bg-muted">
                    Unggah PDF<input type="file" accept="application/pdf" className="sr-only" aria-label={`Unggah PDF ${o.orderNo}`}
                      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(o, f); }} />
                  </label>
                ) : null}
                {canResult && o.connector === 'MOCK' && o.status === 'SENT' ? <Button size="sm" variant="outline" onClick={() => void run(() => api(`/lab-orders/${o.id}/simulate-result`, { method: 'POST' }), 'Simulasi gagal')}>Simulasikan hasil (tiruan)</Button> : null}
                {can(s, 'clinical.lab.order') && o.status !== 'RESULTED' ? <Button size="sm" variant="ghost" onClick={() => {
                  const reason = window.prompt('Alasan membatalkan order lab (min. 5 huruf)');
                  if (reason && reason.trim().length >= 5) void run(() => api(`/lab-orders/${o.id}/cancel`, { method: 'POST', body: { reason: reason.trim() } }), 'Gagal membatalkan');
                }}>Batalkan</Button> : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ))}
      {resultFor ? <ResultDialog order={resultFor} onClose={() => setResultFor(undefined)} onSaved={async () => { setResultFor(undefined); await load(); }} /> : null}
    </div>
  );
}

function ResultDialog({ order, onClose, onSaved }: { order: LabOrder; onClose: () => void; onSaved: () => Promise<void> }) {
  const [rows, setRows] = useState(order.items.map((i) => ({ labOrderItemId: i.id, testName: i.name, value: '', unit: '', referenceRange: '', flag: '' })));
  const [error, setError] = useState<string>();
  const filled = rows.filter((r) => r.value.trim());
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api(`/lab-orders/${order.id}/results`, { method: 'POST', body: { results: filled.map((r) => ({ labOrderItemId: r.labOrderItemId, testName: r.testName,
        value: r.value.trim(), unit: r.unit.trim() || null, referenceRange: r.referenceRange.trim() || null, flag: r.flag || null })) } });
      await onSaved();
    } catch (err) { setError(errorText(err, 'Gagal menyimpan hasil')); }
  }
  const upd = (i: number, k: keyof (typeof rows)[number], v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <Dialog open onClose={onClose} title="Input hasil lab" description={order.orderNo}>
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {rows.map((r, i) => (
          <div key={r.labOrderItemId} className="grid gap-2 sm:grid-cols-[1fr_6rem_6rem_7rem_7rem] sm:items-end">
            <span className="text-sm font-medium">{r.testName}</span>
            <Field id={`rv-${i}`} label="Hasil"><Input id={`rv-${i}`} value={r.value} onChange={(e) => upd(i, 'value', e.target.value)} /></Field>
            <Field id={`ru-${i}`} label="Satuan"><Input id={`ru-${i}`} value={r.unit} onChange={(e) => upd(i, 'unit', e.target.value)} /></Field>
            <Field id={`rr-${i}`} label="Rujukan"><Input id={`rr-${i}`} value={r.referenceRange} onChange={(e) => upd(i, 'referenceRange', e.target.value)} /></Field>
            <Field id={`rf-${i}`} label="Penanda">
              <Select id={`rf-${i}`} value={r.flag} onChange={(e) => upd(i, 'flag', e.target.value)}>
                <option value="">—</option>{Object.entries(FLAG).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">Hasil yang tersimpan tidak dapat diubah; koreksi dengan menginput hasil baru.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" disabled={!filled.length}>Simpan hasil</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Dokumen medis PDF (CLN-FR-020–022) dan jadwal kontrol (CLN-FR-023). Dokumen hanya dari rekam medis yang sudah disahkan. */
export function DocumentsTab({ chart }: { chart: EncounterChart }) {
  const s = useSession();
  const canIssue = can(s, 'clinical.document.issue') && chart.note?.status === 'SIGNED' && chart.encounter.status !== 'CANCELLED';
  const [docs, setDocs] = useState<MedicalDocument[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [dialog, setDialog] = useState<'SURAT_SAKIT' | 'SURAT_SEHAT' | 'RUJUKAN' | 'KONTROL'>();
  const load = useCallback(async () => {
    try { setDocs(await api<MedicalDocument[]>(`/encounters/${chart.encounter.id}/documents`)); } catch (e) { setError(errorText(e, 'Gagal memuat dokumen')); }
  }, [chart.encounter.id]);
  useEffect(() => { void load(); }, [load]);
  async function issue(path: string, body: object) {
    try {
      const d = await api<MedicalDocument>(`/encounters/${chart.encounter.id}/${path}`, { method: 'POST', body });
      setDialog(undefined); setError(undefined); setNotice(`${DOC_LABEL[d.docType]} ${d.documentNo} diterbitkan.`); await load();
    } catch (e) { setError(errorText(e, 'Gagal menerbitkan dokumen')); }
  }
  return (
    <div className="grid gap-4">
      {notice ? <Alert tone="success" data-testid="doc-notice">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {canIssue || can(s, 'appointment.manage') ? (
        <div className="flex flex-wrap gap-2">
          {canIssue ? <>
            <Button variant="outline" onClick={() => void issue('documents', { docType: 'RESUME' })}>Resume medis</Button>
            <Button variant="outline" onClick={() => setDialog('SURAT_SAKIT')}>Surat sakit</Button>
            <Button variant="outline" onClick={() => setDialog('SURAT_SEHAT')}>Surat sehat</Button>
            <Button variant="outline" onClick={() => setDialog('RUJUKAN')}>Rujukan</Button>
          </> : null}
          {can(s, 'appointment.manage') ? <Button variant="outline" onClick={() => setDialog('KONTROL')}>Jadwalkan kontrol</Button> : null}
        </div>
      ) : null}
      {!canIssue && can(s, 'clinical.document.issue') ? <p className="text-sm text-muted-foreground">Dokumen dapat diterbitkan setelah rekam medis disahkan.</p> : null}
      <Card>
        <CardHeader><CardTitle>Dokumen kunjungan ini</CardTitle></CardHeader>
        <CardContent>
          {!docs ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : docs.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada dokumen.</p> : (
            <ul className="grid gap-2 text-sm">
              {docs.map((d) => (
                <li key={d.id} data-testid="doc-row" className="flex flex-wrap items-center gap-2 border-b pb-2 last:border-0">
                  <b>{DOC_LABEL[d.docType]}</b> <span className="font-mono text-xs">{d.documentNo}</span>
                  <span className="text-xs text-muted-foreground">{fmtDateTime(d.issuedAt)} · {d.doctorName} · kode {d.verificationCode}</span>
                  <a className="ml-auto underline" href={`/api/v1/medical-documents/${d.id}/file`} target="_blank" rel="noreferrer">Buka PDF</a>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {dialog === 'SURAT_SAKIT' ? <SickDialog onClose={() => setDialog(undefined)} onSubmit={(b) => issue('documents', { docType: 'SURAT_SAKIT', ...b })} /> : null}
      {dialog === 'SURAT_SEHAT' ? <HealthyDialog onClose={() => setDialog(undefined)} onSubmit={(b) => issue('documents', { docType: 'SURAT_SEHAT', ...b })} /> : null}
      {dialog === 'RUJUKAN' ? <ReferralDialog onClose={() => setDialog(undefined)} onSubmit={(b) => issue('referrals', b)} /> : null}
      {dialog === 'KONTROL' ? <FollowUpDialog chart={chart} onClose={() => setDialog(undefined)} onDone={(t) => { setDialog(undefined); setNotice(t); }} /> : null}
    </div>
  );
}

function SickDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (b: object) => Promise<void> }) {
  const [days, setDays] = useState('1');
  const [start, setStart] = useState(todayWib());
  const [dx, setDx] = useState(false);
  const ok = Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 30;
  return (
    <Dialog open onClose={onClose} title="Surat keterangan sakit">
      <form className="grid gap-3" noValidate onSubmit={(e) => { e.preventDefault(); void onSubmit({ restDays: Number(days), startDate: start, includeDiagnosis: dx }); }}>
        <Field id="sk-days" label="Lama istirahat (hari)" error={ok ? undefined : '1–30 hari'}><Input id="sk-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
        <Field id="sk-start" label="Mulai tanggal"><Input id="sk-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm"><Switch checked={dx} onChange={(e) => setDx(e.target.checked)} aria-label="Cantumkan diagnosis" /> Cantumkan diagnosis (hanya atas persetujuan pasien)</label>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Batal</Button><Button type="submit" disabled={!ok || !start}>Terbitkan</Button></div>
      </form>
    </Dialog>
  );
}

function HealthyDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (b: object) => Promise<void> }) {
  const [purpose, setPurpose] = useState('');
  const [notes, setNotes] = useState('');
  return (
    <Dialog open onClose={onClose} title="Surat keterangan sehat">
      <form className="grid gap-3" noValidate onSubmit={(e) => { e.preventDefault(); void onSubmit({ purpose: purpose.trim(), notes: notes.trim() || null }); }}>
        <Field id="sh-purpose" label="Keperluan *"><Input id="sh-purpose" maxLength={200} value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
        <Field id="sh-notes" label="Catatan"><Input id="sh-notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Batal</Button><Button type="submit" disabled={purpose.trim().length < 3}>Terbitkan</Button></div>
      </form>
    </Dialog>
  );
}

function ReferralDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (b: object) => Promise<void> }) {
  const [f, setF] = useState({ destination: '', destinationUnit: '', reason: '', clinicalSummary: '' });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Dialog open onClose={onClose} title="Surat rujukan">
      <form className="grid gap-3" noValidate onSubmit={(e) => { e.preventDefault(); void onSubmit({ destination: f.destination.trim(), destinationUnit: f.destinationUnit.trim() || null,
        reason: f.reason.trim(), clinicalSummary: f.clinicalSummary.trim() || null }); }}>
        <Field id="rj-dest" label="Tujuan (fasilitas) *"><Input id="rj-dest" maxLength={200} value={f.destination} onChange={(e) => set('destination', e.target.value)} /></Field>
        <Field id="rj-unit" label="Poli / dokter tujuan"><Input id="rj-unit" maxLength={200} value={f.destinationUnit} onChange={(e) => set('destinationUnit', e.target.value)} /></Field>
        <Field id="rj-reason" label="Alasan rujukan *"><Textarea id="rj-reason" rows={2} maxLength={1000} value={f.reason} onChange={(e) => set('reason', e.target.value)} /></Field>
        <Field id="rj-summary" label="Ringkasan klinis"><Textarea id="rj-summary" rows={3} maxLength={2000} value={f.clinicalSummary} onChange={(e) => set('clinicalSummary', e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" disabled={f.destination.trim().length < 3 || f.reason.trim().length < 5}>Terbitkan</Button></div>
      </form>
    </Dialog>
  );
}

/** CLN-FR-023: rencana kontrol → janji temu pada slot jadwal dokter kunjungan (aturan pemesanan dari modul janji temu). */
function FollowUpDialog({ chart, onClose, onDone }: { chart: EncounterChart; onClose: () => void; onDone: (text: string) => void }) {
  const [date, setDate] = useState('');
  const [sessions, setSessions] = useState<SlotSession[]>();
  const [slot, setSlot] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!date) return;
    setSessions(undefined); setSlot('');
    void api<{ sessions: SlotSession[] }>(`/slots?date=${date}&practitionerId=${chart.encounter.practitionerId}`)
      .then((r) => setSessions(r.sessions)).catch((e) => setError(errorText(e, 'Gagal memuat slot')));
  }, [date, chart.encounter.practitionerId]);
  async function book() {
    try {
      const a = await api<{ localDate: string; localTime: string }>('/appointments', { method: 'POST', headers: { 'idempotency-key': `ktl-${crypto.randomUUID()}` },
        body: { patientId: chart.patient.id, practitionerId: chart.encounter.practitionerId, slotStart: slot, notes: `Kontrol dari kunjungan ${chart.encounter.encounterNo}` } });
      onDone(`Jadwal kontrol dibuat: ${a.localDate} pukul ${a.localTime}.`);
    } catch (e) { setError(errorText(e, 'Gagal membuat jadwal kontrol')); }
  }
  const open = (sessions ?? []).flatMap((x) => (x.closed ? [] : x.slots.filter((sl) => sl.available).map((sl) => ({ ...sl, unit: x.unitName, tz: x.timezone }))));
  return (
    <Dialog open onClose={onClose} title="Jadwalkan kontrol" description={chart.encounter.practitionerName}>
      <div className="grid gap-3">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="fu-date" label="Tanggal kontrol"><Input id="fu-date" type="date" min={todayWib()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        {date && !sessions ? <p className="text-sm text-muted-foreground" role="status">Memuat slot…</p> : null}
        {sessions && open.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada slot tersedia pada tanggal ini.</p> : null}
        {open.length ? (
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Slot">
            {open.map((sl) => (
              <button key={sl.start} type="button" role="radio" aria-checked={slot === sl.start}
                      className={`rounded-md border px-2 py-1 text-sm ${slot === sl.start ? 'bg-primary text-primary-foreground' : ''}`} onClick={() => setSlot(sl.start)}>
                {new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: sl.tz }).format(new Date(sl.start))}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Batal</Button><Button disabled={!slot} onClick={() => void book()}>Buat jadwal</Button></div>
      </div>
    </Dialog>
  );
}
