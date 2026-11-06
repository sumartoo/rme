import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { type Tx, audit, rows } from '@clinicrme/db';
import { ctx, pgError, problem } from '@clinicrme/shared';

export interface AppointmentRow {
  id: string; status: string; status_reason: string | null; channel: string; notes: string | null; slot_start: string; slot_end: string | null;
  local_date: string; local_time: string; timezone: string; rescheduled_to_id: string | null; schedule_id: string | null;
  practitioner_id: string; practitioner_name: string; branch_id: string; branch_name: string; unit_id: string; unit_name: string;
  patient_id: string; mrn: string; full_name: string; birth_date: string; sex: string; phone: string | null; patient_status: string;
  created_at: string; version: number;
}
export const APPOINTMENT_SELECT = sql`
  select a.id, a.status, a.status_reason, a.channel, a.notes, a.slot_start, a.slot_end,
         to_char(a.slot_start at time zone b.timezone, 'YYYY-MM-DD') as local_date,
         to_char(a.slot_start at time zone b.timezone, 'HH24:MI') as local_time, b.timezone,
         a.rescheduled_to_id, a.schedule_id, a.practitioner_id, pr.full_name as practitioner_name, a.branch_id, b.name as branch_name,
         a.unit_id, u.name as unit_name, a.patient_id, p.mrn, p.full_name, to_char(p.birth_date, 'YYYY-MM-DD') as birth_date, p.sex,
         p.phone, p.status as patient_status, a.created_at, a.version
    from appointment a
    join patient p on p.id = a.patient_id
    join practitioner pr on pr.id = a.practitioner_id
    join branch b on b.id = a.branch_id
    join service_unit u on u.id = a.unit_id`;
export const appointmentDto = (r: AppointmentRow) => ({
  id: r.id, status: r.status, statusReason: r.status_reason, channel: r.channel, notes: r.notes,
  slotStart: new Date(r.slot_start).toISOString(), slotEnd: r.slot_end ? new Date(r.slot_end).toISOString() : null,
  localDate: r.local_date, localTime: r.local_time, timezone: r.timezone, rescheduledToId: r.rescheduled_to_id, scheduleId: r.schedule_id,
  practitionerId: r.practitioner_id, practitionerName: r.practitioner_name, branchId: r.branch_id, branchName: r.branch_name,
  unitId: r.unit_id, unitName: r.unit_name,
  patient: { id: r.patient_id, mrn: r.mrn, fullName: r.full_name, birthDate: r.birth_date, sex: r.sex, phone: r.phone, status: r.patient_status },
  createdAt: r.created_at, version: r.version,
});

export async function getAppointment(tx: Tx, id: string) {
  const [r] = await rows<AppointmentRow>(tx, sql`${APPOINTMENT_SELECT} where a.id = ${id}`);
  if (!r) throw problem(404, 'SCH-404-APPOINTMENT', 'Janji temu tidak ditemukan');
  return appointmentDto(r);
}

export interface BookInput { patientId: string; practitionerId: string; slotStart: string; unitId?: string; notes?: string | null;
  channel?: 'STAFF' | 'PATIENT_APP' | 'FOLLOW_UP'; id?: string }

/**
 * Buat janji temu pada slot jadwal (SCH-FR-003, OD-090). Baris jadwal dikunci (FOR UPDATE) sehingga pemesanan
 * bersamaan pada sesi yang sama berurutan: kuota dan slot diperiksa tanpa celah; indeks unik database menjadi
 * pengaman terakhir. Aturan: slot harus tepat di batas slot sesi aktif, belum lewat, tidak cuti/libur, kuota belum
 * penuh, slot belum terisi, pasien aktif dan belum punya janji di jam itu atau dengan dokter yang sama di hari itu.
 */
export async function book(tx: Tx, b: BookInput) {
  const [pt] = await rows<{ status: string }>(tx, sql`select status from patient where id = ${b.patientId}`);
  if (!pt) throw problem(400, 'SCH-400-PATIENT', 'Pasien tidak ditemukan');
  if (pt.status === 'MERGED') throw problem(409, 'PAT-409-MERGED', 'Pasien ini sudah digabung ke pasien lain; gunakan data tujuan');
  if (pt.status !== 'ACTIVE') throw problem(409, 'SCH-409-PATIENT-INACTIVE', 'Pasien tidak aktif');
  const [s] = await rows<{ id: string; branch_id: string; unit_id: string; quota: number; slot_minutes: number; local_date: string; timezone: string }>(tx, sql`
    select s.id, s.branch_id, s.unit_id, s.quota, s.slot_minutes, to_char(l.ts, 'YYYY-MM-DD') as local_date, b.timezone
      from practitioner_schedule s
      join branch b on b.id = s.branch_id
      join practitioner pr on pr.id = s.practitioner_id
      cross join lateral (select (${b.slotStart}::timestamptz at time zone b.timezone) as ts) l
     where s.practitioner_id = ${b.practitionerId} and s.is_active and pr.is_active
       and (${b.unitId ?? null}::uuid is null or s.unit_id = ${b.unitId ?? null}::uuid)
       and s.day_of_week = extract(isodow from l.ts)
       and s.valid_from <= l.ts::date and (s.valid_to is null or s.valid_to >= l.ts::date)
       and l.ts::time >= s.start_time and l.ts::time < s.end_time
       and (extract(epoch from (l.ts::time - s.start_time)) / 60)::numeric % s.slot_minutes = 0
     for update of s`);
  if (!s) throw problem(400, 'SCH-400-NO-SLOT', 'Tidak ada slot jadwal praktik dokter ini pada waktu tersebut');
  if (new Date(b.slotStart).getTime() <= Date.now()) throw problem(400, 'SCH-400-PAST', 'Waktu slot sudah lewat');
  const [ex] = await rows<{ reason: string }>(tx, sql`
    select reason from schedule_exception where exception_date = ${s.local_date}::date
       and (practitioner_id = ${b.practitionerId} or branch_id = ${s.branch_id})`);
  if (ex) throw problem(409, 'SCH-409-CLOSED', `Tidak ada praktik pada tanggal tersebut: ${ex.reason}`);
  const [{ n }] = await rows<{ n: number }>(tx, sql`
    select count(*)::int as n from appointment a
     where a.schedule_id = ${s.id} and a.status in ('BOOKED', 'CHECKED_IN')
       and (a.slot_start at time zone ${s.timezone})::date = ${s.local_date}::date`);
  if (n >= s.quota) throw problem(409, 'SCH-409-QUOTA', 'Kuota janji temu sesi ini sudah penuh');
  const [dup] = await rows(tx, sql`
    select 1 from appointment a where a.patient_id = ${b.patientId} and a.practitioner_id = ${b.practitionerId}
       and a.status = 'BOOKED' and (a.slot_start at time zone ${s.timezone})::date = ${s.local_date}::date`);
  if (dup) throw problem(409, 'SCH-409-DUPLICATE-DAY', 'Pasien sudah punya janji temu dengan dokter ini pada hari yang sama');
  const id = b.id ?? randomUUID();
  try {
    await tx.execute(sql`
      insert into appointment(id, tenant_id, patient_id, practitioner_id, branch_id, unit_id, schedule_id, slot_start, slot_end,
                              channel, notes, created_by, updated_by)
      values (${id}, app.current_tenant_id(), ${b.patientId}, ${b.practitionerId}, ${s.branch_id}, ${s.unit_id}, ${s.id},
              ${b.slotStart}::timestamptz, ${b.slotStart}::timestamptz + make_interval(mins => ${s.slot_minutes}),
              ${b.channel ?? 'STAFF'}, ${b.notes ?? null}, ${ctx().userId}, ${ctx().userId})`);
  } catch (e) {
    const pg = pgError(e);
    if (pg?.code === '23505' && pg.constraint === 'ux_appointment_practitioner_slot') throw problem(409, 'SCH-409-SLOT-TAKEN', 'Slot ini baru saja terisi. Pilih slot lain.');
    if (pg?.code === '23505' && pg.constraint === 'ux_appointment_patient_slot') throw problem(409, 'SCH-409-PATIENT-BUSY', 'Pasien sudah punya janji temu lain pada jam yang sama');
    throw e;
  }
  const d = await getAppointment(tx, id);
  await audit(tx, 'APPOINTMENT_CREATED', 'appointment', id, b.patientId, {
    practitionerId: b.practitionerId, unitId: d.unitId, slotStart: d.slotStart, channel: d.channel });
  return d;
}
