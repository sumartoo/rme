import { sql } from 'drizzle-orm';
import { type Tx, audit, rows } from '@clinicrme/db';
import { ctx, problem } from '@clinicrme/shared';

export interface EncounterRow {
  id: string; encounter_no: string; status: string; arrival_type: string; arrived_at: string; arrived_late: boolean; local_date: string;
  local_time: string; timezone: string; cancel_reason: string | null; cancelled_at: string | null;
  patient_id: string; mrn: string; full_name: string; birth_date: string; sex: string; phone: string | null;
  branch_id: string; branch_name: string; unit_id: string; unit_name: string; practitioner_id: string; practitioner_name: string;
  payer_type: string; coverage_id: string | null; payer_name: string | null; member_no: string | null;
  coverage_verified_at: string | null; coverage_verification_note: string | null;
  appointment_id: string | null; slot_start: string | null;
  ticket_id: string | null; display_code: string | null; queue_number: number | null; ticket_status: string | null;
  called_at: string | null; call_count: number | null; version: number;
}
export const ENCOUNTER_SELECT = sql`
  select e.id, e.encounter_no, e.status, e.arrival_type, e.arrived_at, e.arrived_late,
         to_char(e.arrived_at at time zone b.timezone, 'YYYY-MM-DD') as local_date,
         to_char(e.arrived_at at time zone b.timezone, 'HH24:MI') as local_time, b.timezone, e.cancel_reason, e.cancelled_at,
         e.patient_id, p.mrn, p.full_name, to_char(p.birth_date, 'YYYY-MM-DD') as birth_date, p.sex, p.phone,
         e.branch_id, b.name as branch_name, e.unit_id, u.name as unit_name, e.practitioner_id, pr.full_name as practitioner_name,
         e.payer_type, e.coverage_id, y.name as payer_name, c.member_no, e.coverage_verified_at, e.coverage_verification_note,
         e.appointment_id, a.slot_start,
         q.id as ticket_id, q.display_code, q.queue_number, q.status as ticket_status, q.called_at, q.call_count, e.version
    from encounter e
    join patient p on p.id = e.patient_id
    join branch b on b.id = e.branch_id
    join service_unit u on u.id = e.unit_id
    join practitioner pr on pr.id = e.practitioner_id
    left join patient_coverage c on c.id = e.coverage_id
    left join payer y on y.id = c.payer_id
    left join appointment a on a.id = e.appointment_id
    left join queue_ticket q on q.encounter_id = e.id`;
export const encounterDto = (r: EncounterRow) => ({
  id: r.id, encounterNo: r.encounter_no, status: r.status, arrivalType: r.arrival_type, arrivedAt: r.arrived_at, arrivedLate: r.arrived_late,
  localDate: r.local_date, localTime: r.local_time, timezone: r.timezone, cancelReason: r.cancel_reason, cancelledAt: r.cancelled_at,
  patient: { id: r.patient_id, mrn: r.mrn, fullName: r.full_name, birthDate: r.birth_date, sex: r.sex, phone: r.phone },
  branchId: r.branch_id, branchName: r.branch_name, unitId: r.unit_id, unitName: r.unit_name,
  practitionerId: r.practitioner_id, practitionerName: r.practitioner_name,
  payerType: r.payer_type, coverage: r.coverage_id ? { id: r.coverage_id, payerName: r.payer_name, memberNo: r.member_no } : null,
  coverageVerifiedAt: r.coverage_verified_at, coverageVerificationNote: r.coverage_verification_note,
  appointment: r.appointment_id ? { id: r.appointment_id, slotStart: r.slot_start ? new Date(r.slot_start).toISOString() : null } : null,
  queue: r.ticket_id ? { id: r.ticket_id, displayCode: r.display_code, queueNumber: r.queue_number, status: r.ticket_status,
    calledAt: r.called_at, callCount: r.call_count } : null,
  version: r.version,
});

export async function getEncounter(tx: Tx, id: string) {
  const [r] = await rows<EncounterRow>(tx, sql`${ENCOUNTER_SELECT} where e.id = ${id}`);
  if (!r) throw problem(404, 'ENC-404', 'Kunjungan tidak ditemukan');
  return encounterDto(r);
}

/** Sinyal untuk layar antrean realtime (batch 4, OD-089): payload hanya tenant & cabang, tanpa data pasien. */
export async function notifyQueue(tx: Tx, branchId: string) {
  await tx.execute(sql`select pg_notify('clinicrme_queue', app.current_tenant_id()::text || ':' || ${branchId}::text)`);
}

export interface RegisterInput {
  patientId: string; unitId: string; practitionerId: string; coverageId?: string | null; eligibilityNote?: string | null;
  appointment?: { id: string; sortKey: string; late: boolean };
}

/**
 * Daftarkan kunjungan + nomor antrean dalam satu transaksi (SCH-FR-005..007). Baris pasien dikunci sehingga
 * pendaftaran ganda bersamaan untuk pasien yang sama berurutan. Nomor kunjungan dari document_sequence (OD-086
 * `KJ{YYYY}{MM}{SEQ:6}`), nomor antrean dari queue_counter per cabang × poli × hari lokal — keduanya diambil dengan
 * UPDATE atomik, sehingga tidak pernah ganda walau banyak loket mendaftar bersamaan.
 * Penjamin Asuransi/Perusahaan/BPJS wajib verifikasi kepesertaan manual oleh petugas (OD-032).
 */
export async function registerEncounter(tx: Tx, b: RegisterInput) {
  const [pt] = await rows<{ status: string }>(tx, sql`select status from patient where id = ${b.patientId} for update`);
  if (!pt) throw problem(400, 'ENC-400-PATIENT', 'Pasien tidak ditemukan');
  if (pt.status === 'MERGED') throw problem(409, 'PAT-409-MERGED', 'Pasien ini sudah digabung ke pasien lain; gunakan data tujuan');
  if (pt.status !== 'ACTIVE') throw problem(409, 'ENC-409-PATIENT-INACTIVE', 'Pasien tidak aktif');
  const [u] = await rows<{ branch_id: string; unit_type: string; is_active: boolean; branch_active: boolean; prefix: string; today: string }>(tx, sql`
    select u.branch_id, u.unit_type, u.is_active, b.is_active as branch_active,
           coalesce(u.queue_prefix, nullif(upper(left(regexp_replace(u.code, '[^A-Za-z]', '', 'g'), 1)), ''), 'A') as prefix,
           to_char(now() at time zone b.timezone, 'YYYY-MM-DD') as today
      from service_unit u join branch b on b.id = u.branch_id where u.id = ${b.unitId}`);
  if (!u?.is_active || !u.branch_active || u.unit_type === 'FARMASI' || u.unit_type === 'KASIR') {
    throw problem(400, 'ENC-400-UNIT', 'Poli/unit pelayanan tidak ditemukan atau tidak aktif');
  }
  const [pr] = await rows<{ is_active: boolean; full_name: string }>(tx, sql`select is_active, full_name from practitioner where id = ${b.practitionerId}`);
  if (!pr?.is_active) throw problem(400, 'ENC-400-PRACTITIONER', 'Tenaga kesehatan tidak ditemukan atau tidak aktif');

  const [active] = await rows<{ encounter_no: string }>(tx, sql`
    select e.encounter_no from encounter e join branch br on br.id = e.branch_id
     where e.patient_id = ${b.patientId} and e.unit_id = ${b.unitId} and e.status not in ('FINISHED', 'CANCELLED')
       and (e.arrived_at at time zone br.timezone)::date = ${u.today}::date`);
  if (active) throw problem(409, 'ENC-409-ACTIVE', `Pasien sudah punya kunjungan aktif di poli ini hari ini (${active.encounter_no})`);

  let payerType = 'UMUM';
  if (b.coverageId) {
    const [c] = await rows<{ patient_id: string; is_active: boolean; valid_from: string | null; valid_to: string | null; payer_type: string; payer_active: boolean }>(tx, sql`
      select c.patient_id, c.is_active, to_char(c.valid_from, 'YYYY-MM-DD') as valid_from, to_char(c.valid_to, 'YYYY-MM-DD') as valid_to,
             y.payer_type, y.is_active as payer_active
        from patient_coverage c join payer y on y.id = c.payer_id where c.id = ${b.coverageId}`);
    if (!c || c.patient_id !== b.patientId) throw problem(400, 'ENC-400-COVERAGE', 'Penjamin bukan milik pasien ini');
    if (!c.is_active || !c.payer_active) throw problem(400, 'ENC-400-COVERAGE', 'Penjamin tidak aktif');
    if ((c.valid_from && c.valid_from > u.today) || (c.valid_to && c.valid_to < u.today)) {
      throw problem(400, 'ENC-400-COVERAGE-EXPIRED', 'Masa berlaku penjamin tidak mencakup hari ini. Perbarui data penjamin atau daftarkan sebagai pasien umum.');
    }
    payerType = c.payer_type;
    if (payerType === 'UMUM') b = { ...b, coverageId: null };
    else if (!b.eligibilityNote?.trim()) {
      throw problem(400, 'ENC-400-ELIGIBILITY', 'Verifikasi kepesertaan penjamin wajib: isi catatan verifikasi (mis. nomor konfirmasi dari asuransi/perusahaan)');
    }
  }
  const verified = payerType !== 'UMUM';

  const [{ no }] = await rows<{ no: string }>(tx, sql`select app.next_document_number('ENCOUNTER', 'TENANT', 'KJ{YYYY}{MM}{SEQ:6}') as no`);
  const [{ id }] = await rows<{ id: string }>(tx, sql`
    insert into encounter(tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, appointment_id, coverage_id, payer_type,
                          arrival_type, status, arrived_at, arrived_late, coverage_verified_at, coverage_verified_by, coverage_verification_note,
                          created_by, updated_by)
    values (app.current_tenant_id(), ${no}, ${b.patientId}, ${u.branch_id}, ${b.unitId}, ${b.practitionerId}, ${b.appointment?.id ?? null}::uuid,
            ${b.coverageId ?? null}::uuid, ${payerType}, ${b.appointment ? 'APPOINTMENT' : 'WALK_IN'}, 'ARRIVED', now(), ${b.appointment?.late ?? false},
            ${verified ? sql`now()` : null}, ${verified ? ctx().userId : null}::uuid, ${verified ? b.eligibilityNote!.trim() : null},
            ${ctx().userId}, ${ctx().userId})
    returning id`);
  const [{ n }] = await rows<{ n: number }>(tx, sql`
    insert into queue_counter(tenant_id, branch_id, unit_id, queue_date, last_number)
    values (app.current_tenant_id(), ${u.branch_id}, ${b.unitId}, ${u.today}::date, 1)
    on conflict (tenant_id, branch_id, unit_id, queue_date) do update set last_number = queue_counter.last_number + 1
    returning last_number as n`);
  const display = `${u.prefix}-${String(n).padStart(3, '0')}`;
  await tx.execute(sql`
    insert into queue_ticket(tenant_id, branch_id, unit_id, queue_date, queue_number, display_code, encounter_id, practitioner_id, sort_key, updated_by)
    values (app.current_tenant_id(), ${u.branch_id}, ${b.unitId}, ${u.today}::date, ${n}, ${display}, ${id}, ${b.practitionerId},
            coalesce(${b.appointment?.sortKey ?? null}::timestamptz, now()), ${ctx().userId})`);
  return finishRegistration(tx, id, b, u.branch_id, u.today, pr.full_name);
}

async function finishRegistration(tx: Tx, id: string, b: RegisterInput, branchId: string, today: string, practitionerName: string) {
  const warnings: string[] = [];
  if (!b.appointment) {
    // OD-090: walk-in tidak memakai kuota janji temu, tetapi petugas diberi tahu bila total pasien melampaui kuota sesi hari ini
    const [q] = await rows<{ sessions: number; quota: number; patients: number }>(tx, sql`
      select (select count(*)::int from practitioner_schedule s
               where s.practitioner_id = ${b.practitionerId} and s.unit_id = ${b.unitId} and s.is_active
                 and s.day_of_week = extract(isodow from ${today}::date) and s.valid_from <= ${today}::date
                 and (s.valid_to is null or s.valid_to >= ${today}::date)) as sessions,
             (select coalesce(sum(s.quota), 0)::int from practitioner_schedule s
               where s.practitioner_id = ${b.practitionerId} and s.unit_id = ${b.unitId} and s.is_active
                 and s.day_of_week = extract(isodow from ${today}::date) and s.valid_from <= ${today}::date
                 and (s.valid_to is null or s.valid_to >= ${today}::date)) as quota,
             (select count(*)::int from appointment a join branch br on br.id = a.branch_id
               where a.practitioner_id = ${b.practitionerId} and a.unit_id = ${b.unitId} and a.status = 'BOOKED'
                 and (a.slot_start at time zone br.timezone)::date = ${today}::date)
           + (select count(*)::int from encounter e join branch br on br.id = e.branch_id
               where e.practitioner_id = ${b.practitionerId} and e.unit_id = ${b.unitId} and e.status <> 'CANCELLED'
                 and (e.arrived_at at time zone br.timezone)::date = ${today}::date) as patients`);
    if (q.sessions === 0) warnings.push(`${practitionerName} tidak punya jadwal praktik di poli ini hari ini.`);
    else if (q.patients > q.quota) warnings.push(`Total pasien ${practitionerName} hari ini (${q.patients}) melebihi kuota (${q.quota}).`);
  }
  const d = await getEncounter(tx, id);
  await audit(tx, 'ENCOUNTER_CREATED', 'encounter', id, b.patientId, {
    encounterNo: d.encounterNo, arrivalType: d.arrivalType, unitId: d.unitId, practitionerId: d.practitionerId, payerType: d.payerType,
    queue: d.queue?.displayCode, arrivedLate: d.arrivedLate, ...(d.coverageVerificationNote ? { coverageVerificationNote: d.coverageVerificationNote } : {}),
  });
  await notifyQueue(tx, branchId);
  return { ...d, warnings };
}
