'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, Field, Input, Select, Switch, TBody, TD, TH, THead, TR, Table, Textarea,
} from '@clinicrme/ui';
import { Appointment, BranchItem, Page, Practitioner, Schedule, ScheduleException, ServiceUnit, api, errorText } from '../../../lib/api';
import { DAY_LABEL, TZ_SHORT, fmtDate, todayWib } from '../../../lib/format';
import { can, useSession } from '../../../lib/session';

/**
 * Jadwal praktik dokter (SCH-FR-001) & cuti/libur (SCH-FR-002). Jam = jam lokal cabang. Admin klinik mengelola;
 * petugas pendaftaran melihat. Kuota bawaan = jumlah slot (OD-090).
 */
export default function SchedulesPage() {
  const s = useSession();
  const manage = can(s, 'schedule.manage');
  const [items, setItems] = useState<Schedule[]>();
  const [exceptions, setExceptions] = useState<ScheduleException[]>([]);
  const [inactive, setInactive] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [affected, setAffected] = useState<Appointment[]>([]);
  const [dialog, setDialog] = useState<'new' | 'exception' | Schedule>();

  const load = useCallback(async () => {
    try {
      const [sch, ex] = await Promise.all([
        api<Schedule[]>(`/schedules${inactive ? '?includeInactive=true' : ''}`), api<ScheduleException[]>('/schedule-exceptions'),
      ]);
      setItems(sch); setExceptions(ex); setError(undefined);
    } catch (e) { setError(errorText(e, 'Gagal memuat jadwal')); }
  }, [inactive]);
  useEffect(() => { void load(); }, [load]);
  async function done(msg: string, aff: Appointment[] = []) { setDialog(undefined); await load(); setNotice(msg); setAffected(aff); }
  async function removeException(e: ScheduleException) {
    try { await api(`/schedule-exceptions/${e.id}`, { method: 'DELETE' }); await done('Cuti/libur dihapus.'); }
    catch (err) { setError(errorText(err, 'Gagal menghapus')); }
  }

  const groups = useMemo(() => {
    const m = new Map<string, Schedule[]>();
    for (const x of items ?? []) m.set(x.practitionerName, [...(m.get(x.practitionerName) ?? []), x]);
    return [...m.entries()];
  }, [items]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Jadwal dokter</h1>
        <label className="flex items-center gap-2 text-sm"><Switch checked={inactive} onChange={(e) => setInactive(e.target.checked)} aria-label="Tampilkan jadwal nonaktif" /> Tampilkan nonaktif/berakhir</label>
        {manage ? (
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => { setNotice(undefined); setDialog('exception'); }}>Tambah cuti/libur</Button>
            <Button onClick={() => { setNotice(undefined); setDialog('new'); }}>Tambah jadwal</Button>
          </div>
        ) : null}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {affected.length > 0 ? (
        <Alert tone="info" data-testid="affected-appointments">
          {affected.length} janji temu pada tanggal tersebut tetap terjadwal — hubungi pasien untuk menjadwalkan ulang:
          <ul className="mt-1 list-disc pl-5">{affected.map((a) => <li key={a.id}>{a.localTime} · {a.patient.fullName} ({a.patient.mrn}){a.patient.phone ? ` · ${a.patient.phone}` : ''}</li>)}</ul>
        </Alert>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card>
        <CardHeader><CardTitle>Jadwal praktik mingguan</CardTitle></CardHeader>
        <CardContent>
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada jadwal praktik.</p>
          ) : (
            <Table>
              <THead><TR><TH>Dokter</TH><TH>Hari</TH><TH>Jam</TH><TH>Poli / cabang</TH><TH>Slot</TH><TH>Kuota</TH><TH>Berlaku</TH><TH>Status</TH>{manage ? <TH /> : null}</TR></THead>
              <TBody>
                {groups.flatMap(([name, list]) => list.map((x, i) => (
                  <TR key={x.id} data-testid="schedule-row">
                    <TD className="font-medium">{i === 0 ? name : ''}</TD>
                    <TD>{DAY_LABEL[x.dayOfWeek]}</TD>
                    <TD className="whitespace-nowrap">{x.startTime}–{x.endTime} <span className="text-xs text-muted-foreground">{TZ_SHORT[x.timezone]}</span></TD>
                    <TD className="text-xs">{x.unitName}<span className="block text-muted-foreground">{x.branchName}</span></TD>
                    <TD className="text-xs">{x.slotMinutes} mnt</TD>
                    <TD className="text-xs">{x.quota} / {x.slotCount}</TD>
                    <TD className="text-xs">{fmtDate(x.validFrom)} – {x.validTo ? fmtDate(x.validTo) : '…'}</TD>
                    <TD><Badge tone={x.isActive ? 'success' : 'neutral'}>{x.isActive ? 'Aktif' : 'Nonaktif'}</Badge></TD>
                    {manage ? <TD className="text-right"><Button size="sm" variant="outline" onClick={() => { setNotice(undefined); setDialog(x); }}>Ubah</Button></TD> : null}
                  </TR>
                )))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Cuti dokter & libur cabang</CardTitle></CardHeader>
        <CardContent>
          {exceptions.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada cuti/libur mendatang.</p> : (
            <Table>
              <THead><TR><TH>Tanggal</TH><TH>Untuk</TH><TH>Alasan</TH>{manage ? <TH /> : null}</TR></THead>
              <TBody>
                {exceptions.map((e) => (
                  <TR key={e.id} data-testid="exception-row">
                    <TD className="whitespace-nowrap">{fmtDate(e.exceptionDate)}</TD>
                    <TD>{e.practitionerName ? <>Cuti — {e.practitionerName}</> : <>Libur — {e.branchName}</>}</TD>
                    <TD className="text-xs">{e.reason}</TD>
                    {manage ? <TD className="text-right"><Button size="sm" variant="ghost" onClick={() => void removeException(e)}>Hapus</Button></TD> : null}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {dialog === 'new' || (typeof dialog === 'object' && dialog) ? (
        <ScheduleDialog item={typeof dialog === 'object' ? dialog : undefined} onClose={() => setDialog(undefined)} onDone={done} />
      ) : null}
      {dialog === 'exception' ? <ExceptionDialog onClose={() => setDialog(undefined)} onDone={done} /> : null}
    </div>
  );
}

function ScheduleDialog({ item, onClose, onDone }: { item?: Schedule; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [practitioners, setPractitioners] = useState<Practitioner[]>([]);
  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [units, setUnits] = useState<ServiceUnit[]>([]);
  const [f, setF] = useState({
    practitionerId: item?.practitionerId ?? '', branchId: item?.branchId ?? '', unitId: item?.unitId ?? '', dayOfWeek: String(item?.dayOfWeek ?? 1),
    startTime: item?.startTime ?? '08:00', endTime: item?.endTime ?? '12:00', slotMinutes: String(item?.slotMinutes ?? 15), quota: item ? String(item.quota) : '',
    validFrom: item?.validFrom ?? todayWib(), validTo: item?.validTo ?? '', isActive: item?.isActive ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (item) return;
    void Promise.all([api<Page<Practitioner>>('/practitioners?limit=200'), api<BranchItem[]>('/branches'), api<ServiceUnit[]>('/service-units')])
      .then(([p, b, u]) => { setPractitioners(p.data); setBranches(b.filter((x) => x.isActive)); setUnits(u.filter((x) => x.isActive && x.unitType !== 'FARMASI' && x.unitType !== 'KASIR')); })
      .catch((e) => setError(errorText(e, 'Gagal memuat data master')));
  }, [item]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const slots = /^\d{2}:\d{2}$/.test(f.startTime) && /^\d{2}:\d{2}$/.test(f.endTime) && Number(f.slotMinutes) > 0
    ? Math.max(0, Math.floor((mins(f.endTime) - mins(f.startTime)) / Number(f.slotMinutes))) : 0;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined); setErrors({});
    const quota = f.quota.trim() === '' ? undefined : Number(f.quota);
    try {
      if (item) {
        await api(`/schedules/${item.id}`, { method: 'PUT', headers: { 'if-match': `"${item.version}"` }, body: {
          dayOfWeek: Number(f.dayOfWeek), startTime: f.startTime, endTime: f.endTime, slotMinutes: Number(f.slotMinutes),
          ...(quota !== undefined ? { quota } : {}), validFrom: f.validFrom, validTo: f.validTo || null, isActive: f.isActive } });
      } else {
        await api('/schedules', { method: 'POST', body: { practitionerId: f.practitionerId, branchId: f.branchId, unitId: f.unitId,
          dayOfWeek: Number(f.dayOfWeek), startTime: f.startTime, endTime: f.endTime, slotMinutes: Number(f.slotMinutes),
          ...(quota !== undefined ? { quota } : {}), validFrom: f.validFrom, validTo: f.validTo || null } });
      }
      await onDone(item ? 'Jadwal disimpan.' : 'Jadwal ditambahkan.');
    } catch (err) {
      const p = (err as { problem?: { errors?: { field: string; message: string }[] } }).problem;
      if (p?.errors?.length) setErrors(Object.fromEntries(p.errors.map((x) => [x.field, x.message])));
      setError(errorText(err, 'Gagal menyimpan jadwal'));
    } finally { setBusy(false); }
  }
  const unitsOfBranch = units.filter((u) => u.branchId === f.branchId);
  const ok = item ? true : !!(f.practitionerId && f.branchId && f.unitId);
  return (
    <Dialog open onClose={onClose} title={item ? `Ubah jadwal — ${item.practitionerName}` : 'Tambah jadwal praktik'} className="max-w-2xl"
            description={item ? `${item.unitName}, ${item.branchName}. Perubahan ditolak bila membuat janji temu mendatang keluar jadwal.` : 'Jam mengikuti zona waktu cabang.'}>
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {item ? null : (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field id="sc-pr" label="Dokter *">
              <Select id="sc-pr" value={f.practitionerId} onChange={(e) => set('practitionerId', e.target.value)}>
                <option value="">— pilih —</option>
                {practitioners.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
              </Select>
            </Field>
            <Field id="sc-br" label="Cabang *">
              <Select id="sc-br" value={f.branchId} onChange={(e) => setF((x) => ({ ...x, branchId: e.target.value, unitId: '' }))}>
                <option value="">— pilih —</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
            <Field id="sc-unit" label="Poli/ruang *">
              <Select id="sc-unit" value={f.unitId} disabled={!f.branchId} onChange={(e) => set('unitId', e.target.value)}>
                <option value="">— pilih —</option>
                {unitsOfBranch.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Select>
            </Field>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-4">
          <Field id="sc-day" label="Hari" error={errors.dayOfWeek}>
            <Select id="sc-day" value={f.dayOfWeek} onChange={(e) => set('dayOfWeek', e.target.value)}>
              {DAY_LABEL.slice(1).map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
            </Select>
          </Field>
          <Field id="sc-start" label="Mulai" error={errors.startTime}><Input id="sc-start" type="time" value={f.startTime} onChange={(e) => set('startTime', e.target.value)} /></Field>
          <Field id="sc-end" label="Selesai" error={errors.endTime}><Input id="sc-end" type="time" value={f.endTime} onChange={(e) => set('endTime', e.target.value)} /></Field>
          <Field id="sc-slot" label="Slot (menit)" error={errors.slotMinutes}><Input id="sc-slot" inputMode="numeric" value={f.slotMinutes} onChange={(e) => set('slotMinutes', e.target.value)} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="sc-quota" label="Kuota janji temu" hint={`Kosong = ${slots} (jumlah slot)`} error={errors.quota}>
            <Input id="sc-quota" inputMode="numeric" value={f.quota} onChange={(e) => set('quota', e.target.value)} />
          </Field>
          <Field id="sc-from" label="Berlaku mulai"><Input id="sc-from" type="date" value={f.validFrom} onChange={(e) => set('validFrom', e.target.value)} /></Field>
          <Field id="sc-to" label="Berlaku sampai" error={errors.validTo}><Input id="sc-to" type="date" value={f.validTo} onChange={(e) => set('validTo', e.target.value)} /></Field>
        </div>
        {item ? <label className="flex items-center gap-2 text-sm"><Switch checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} aria-label="Aktif" /> Aktif</label> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!ok}>Simpan</Button>
        </div>
      </form>
    </Dialog>
  );
}

function ExceptionDialog({ onClose, onDone }: { onClose: () => void; onDone: (m: string, aff?: Appointment[]) => Promise<void> }) {
  const [kind, setKind] = useState<'CUTI' | 'LIBUR'>('CUTI');
  const [practitioners, setPractitioners] = useState<Practitioner[]>([]);
  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [target, setTarget] = useState('');
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void Promise.all([api<Page<Practitioner>>('/practitioners?limit=200'), api<BranchItem[]>('/branches')])
      .then(([p, b]) => { setPractitioners(p.data); setBranches(b.filter((x) => x.isActive)); })
      .catch((e) => setError(errorText(e, 'Gagal memuat data master')));
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      const r = await api<ScheduleException>('/schedule-exceptions', { method: 'POST', body: {
        ...(kind === 'CUTI' ? { practitionerId: target } : { branchId: target }), exceptionDate: date, reason: reason.trim() } });
      await onDone(kind === 'CUTI' ? 'Cuti dokter dicatat.' : 'Libur cabang dicatat.', r.affectedAppointments ?? []);
    } catch (err) { setError(errorText(err, 'Gagal menyimpan')); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title="Tambah cuti/libur" description="Slot pada tanggal ini ditutup. Janji temu yang sudah ada ditampilkan untuk dijadwalkan ulang.">
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <fieldset className="flex gap-4 text-sm">
          <legend className="sr-only">Jenis</legend>
          <label className="flex items-center gap-2"><input type="radio" name="ex-kind" checked={kind === 'CUTI'} onChange={() => { setKind('CUTI'); setTarget(''); }} /> Cuti dokter</label>
          <label className="flex items-center gap-2"><input type="radio" name="ex-kind" checked={kind === 'LIBUR'} onChange={() => { setKind('LIBUR'); setTarget(''); }} /> Libur cabang</label>
        </fieldset>
        <Field id="ex-target" label={kind === 'CUTI' ? 'Dokter *' : 'Cabang *'}>
          <Select id="ex-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">— pilih —</option>
            {kind === 'CUTI' ? practitioners.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>) : branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field id="ex-date" label="Tanggal *"><Input id="ex-date" type="date" min={todayWib()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field id="ex-reason" label="Alasan *"><Textarea id="ex-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!target || !date || reason.trim().length < 3}>Simpan</Button>
        </div>
      </form>
    </Dialog>
  );
}
