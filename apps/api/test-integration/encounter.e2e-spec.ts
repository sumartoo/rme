import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 8 batch 3 — kunjungan & antrean (SCH-FR-005..008, 013; OD-032, OD-086, OD-087, OD-090 / DEC-035).
 * Gate Stage 8: nomor antrean tidak pernah ganda saat banyak loket mendaftar bersamaan.
 */
const HOST = 'klinik-a.clinicrme.test';
const HOST_B = 'klinik-b.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const BRANCH = A(10), UNIT = A(11), DR = A(20);
let app: INestApplication;
let http: ReturnType<typeof request>;

type Jar = { cookie: string; csrf: string };
function jar(res: request.Response): Jar {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const csrf = get('crme_csrf');
  return { cookie: [get('crme_session'), csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '' };
}
const login = async (email: string, host = HOST) => {
  const r = await http.post('/api/v1/auth/login').set('Host', host).send({ email, password: PASSWORD });
  expect([email, r.status]).toEqual([email, 200]);
  return jar(r);
};
const get = (path: string, j: Jar, host = HOST) => http.get(path).set('Host', host).set('Cookie', j.cookie);
const post = (path: string, j: Jar) => http.post(path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
const idem = () => `uji-${randomUUID()}`;
const walkIn = (j: Jar, body: object, key = idem()) => post('/api/v1/encounters/walk-in', j).set('Idempotency-Key', key).send(body);
const checkIn = (j: Jar, apptId: string, body: object = {}, key = idem()) =>
  post(`/api/v1/appointments/${apptId}/check-in`, j).set('Idempotency-Key', key).send(body);

let daftar: Jar, dokter: Jar;
let UNIT_G: string;
const P: string[] = [];
async function mkPatient(name: string) {
  const [{ id }] = await su(`insert into app.patient(tenant_id, mrn, full_name, birth_date, sex, identity_type, ihs_status)
                             values ($1, $2, $3, '1985-05-05', 'P', 'TANPA_IDENTITAS', 'NOT_APPLICABLE') returning id`,
  [ids.tenantA, `K${String(P.length + 1).padStart(6, '0')}`, name]);
  P.push(id);
  return id as string;
}
/** Janji temu langsung di database (aturan pemesanan sudah diuji di batch 2); `minutes` relatif terhadap sekarang. */
async function mkAppointment(patientId: string, minutes: number, unitId = UNIT) {
  const [{ id }] = await su(`insert into app.appointment(tenant_id, patient_id, practitioner_id, branch_id, unit_id, slot_start, slot_end)
                             values ($1, $2, $3, $4, $5, date_trunc('minute', now()) + make_interval(mins => $6),
                                     date_trunc('minute', now()) + make_interval(mins => $6 + 15)) returning id`,
  [ids.tenantA, patientId, DR, BRANCH, unitId, minutes]);
  return id as string;
}
const queueOf = async (unitId: string) => (await get(`/api/v1/queue?unitId=${unitId}`, daftar)).body as
  { id: string; displayCode: string; status: string; callCount: number; patient: { id: string }; arrivedLate: boolean }[];

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  daftar = await login('pendaftaran@a.test');
  dokter = await login('dokter@a.test');
  [{ id: UNIT_G }] = await su(`insert into app.service_unit(tenant_id, branch_id, code, name, unit_type, queue_prefix)
                               values ($1, $2, 'GIGI', 'Poli Gigi', 'POLI', 'G') returning id`, [ids.tenantA, BRANCH]);
  for (let i = 0; i < 45; i++) await mkPatient(`Pasien Antre ${i + 1}`);
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('Walk-in & penjamin (SCH-FR-005, 007; OD-032, OD-086)', () => {
  test('Q01 walk-in: nomor kunjungan KJ{YYYY}{MM}{SEQ:6} & antrean U-001; Idempotency-Key; kunjungan aktif ganda ditolak', async () => {
    expect((await walkIn(dokter, { patientId: P[0], unitId: UNIT, practitionerId: DR })).status).toBe(403);
    const k = idem();
    const r = await walkIn(daftar, { patientId: P[0], unitId: UNIT, practitionerId: DR }, k);
    expect(r.status).toBe(201);
    expect(r.body.encounterNo).toMatch(/^KJ\d{6}000001$/);
    expect(r.body).toMatchObject({ status: 'ARRIVED', arrivalType: 'WALK_IN', payerType: 'UMUM', coverage: null, unitName: 'Poli Umum',
      practitionerName: 'dr. Uji a', patient: { id: P[0] }, queue: { displayCode: 'U-001', queueNumber: 1, status: 'WAITING', callCount: 0 } });
    expect(r.body.warnings).toEqual(['dr. Uji a tidak punya jadwal praktik di poli ini hari ini.']);
    expect((await walkIn(daftar, { patientId: P[0], unitId: UNIT, practitionerId: DR }, k)).body.id).toBe(r.body.id);
    const dup = await walkIn(daftar, { patientId: P[0], unitId: UNIT, practitionerId: DR });
    expect([dup.status, dup.body.code]).toEqual([409, 'ENC-409-ACTIVE']);
    const two = await walkIn(daftar, { patientId: P[1], unitId: UNIT, practitionerId: DR });
    expect(two.body.queue.displayCode).toBe('U-002');
    expect(two.body.encounterNo).toMatch(/000002$/);
    // Awalan per poli diatur di master (OD-086); nomor tetap berlanjut hari itu
    await su(`update app.service_unit set queue_prefix = 'UM' where id = $1`, [UNIT]);
    expect((await walkIn(daftar, { patientId: P[2], unitId: UNIT, practitionerId: DR })).body.queue.displayCode).toBe('UM-003');
    // Poli lain punya nomor sendiri
    expect((await walkIn(daftar, { patientId: P[0], unitId: UNIT_G, practitionerId: DR })).body.queue.displayCode).toBe('G-001');
    const [a] = await su(`select patient_id, change_summary from app.audit_log where action = 'ENCOUNTER_CREATED' and resource_id = $1`, [r.body.id]);
    expect(a.patient_id).toBe(P[0]);
    expect(a.change_summary).toMatchObject({ arrivalType: 'WALK_IN', queue: 'U-001', payerType: 'UMUM' });
    await su(`update app.patient set status = 'MERGED', merged_into_id = $2 where id = $1`, [P[44], P[43]]);
    expect((await walkIn(daftar, { patientId: P[44], unitId: UNIT, practitionerId: DR })).body.code).toBe('PAT-409-MERGED');
  });

  test('Q02 penjamin: Asuransi wajib catatan verifikasi; kedaluwarsa / milik pasien lain ditolak; penjamin Umum = pasien umum', async () => {
    const [{ id: payer }] = await su(`insert into app.payer(tenant_id, code, name, payer_type) values ($1, 'ASR', 'Asuransi Uji', 'ASURANSI') returning id`, [ids.tenantA]);
    const cov = async (patient: string, validTo: string | null) => (await su(`insert into app.patient_coverage(tenant_id, patient_id, payer_id, member_no, valid_to)
      values ($1, $2, $3, 'POL-1', $4) returning id`, [ids.tenantA, patient, payer, validTo]))[0].id as string;
    const ok = await cov(P[3], null), expired = await cov(P[4], '2020-01-01');
    const base = { unitId: UNIT, practitionerId: DR };
    expect((await walkIn(daftar, { ...base, patientId: P[3], coverageId: ok })).body.code).toBe('ENC-400-ELIGIBILITY');
    expect((await walkIn(daftar, { ...base, patientId: P[4], coverageId: expired, eligibilityNote: 'Telp 12' })).body.code).toBe('ENC-400-COVERAGE-EXPIRED');
    expect((await walkIn(daftar, { ...base, patientId: P[5], coverageId: ok, eligibilityNote: 'Telp 12' })).body.code).toBe('ENC-400-COVERAGE');
    const r = await walkIn(daftar, { ...base, patientId: P[3], coverageId: ok, eligibilityNote: 'Dikonfirmasi telepon, no. ref ABC-778' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ payerType: 'ASURANSI', coverage: { id: ok, payerName: 'Asuransi Uji', memberNo: 'POL-1' },
      coverageVerificationNote: 'Dikonfirmasi telepon, no. ref ABC-778' });
    expect(r.body.coverageVerifiedAt).not.toBeNull();
    const [{ id: umumCov }] = await su(`insert into app.patient_coverage(tenant_id, patient_id, payer_id) values ($1, $2, $3) returning id`,
      [ids.tenantA, P[5], A(30)]);
    const u = await walkIn(daftar, { ...base, patientId: P[5], coverageId: umumCov });
    expect(u.body).toMatchObject({ payerType: 'UMUM', coverage: null });
  });
});

describe('Check-in janji temu (SCH-FR-006, OD-087)', () => {
  test('Q03 tepat waktu: urutan antrean = jam slot (walk-in yang datang lebih dulu tetap di depan); terlambat → paling belakang', async () => {
    const onTime = await mkAppointment(P[6], 20, UNIT_G);
    const late = await mkAppointment(P[7], -60, UNIT_G);
    const tomorrow = await mkAppointment(P[8], 24 * 60 + 10, UNIT_G);
    const c = await checkIn(daftar, onTime);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ arrivalType: 'APPOINTMENT', arrivedLate: false, appointment: { id: onTime }, unitName: 'Poli Gigi',
      queue: { displayCode: 'G-002' }, warnings: [] });
    expect((await get(`/api/v1/appointments/${onTime}`, daftar)).body.status).toBe('CHECKED_IN');
    expect((await checkIn(daftar, onTime)).body.code).toBe('SCH-409-STATUS');
    const l = await checkIn(daftar, late);
    expect(l.body).toMatchObject({ arrivedLate: true, queue: { displayCode: 'G-003' } });
    expect((await checkIn(daftar, tomorrow)).body.code).toBe('ENC-409-NOT-TODAY');
    // Walk-in setelah check-in: datang sekarang (sebelum jam slot janji) → di depan pasien janji; pasien terlambat di belakang walk-in sebelumnya
    await walkIn(daftar, { patientId: P[9], unitId: UNIT_G, practitionerId: DR });
    const order = (await queueOf(UNIT_G)).filter((t) => t.status === 'WAITING').map((t) => t.displayCode);
    expect(order).toEqual(['G-001', 'G-003', 'G-004', 'G-002']);
    const [a] = await su(`select change_summary from app.audit_log where action = 'APPOINTMENT_CHECKED_IN' and resource_id = $1`, [late]);
    expect(a.change_summary).toMatchObject({ late: true, queue: 'G-003' });
  });

  test('Q04 toleransi terlambat dari pengaturan klinik; check-in Asuransi juga wajib verifikasi', async () => {
    await su(`update app.tenant set settings = settings || '{"lateToleranceMinutes": 90}' where id = $1`, [ids.tenantA]);
    const a = await mkAppointment(P[10], -45, UNIT_G);
    expect((await checkIn(daftar, a)).body.arrivedLate).toBe(false);
    await su(`update app.tenant set settings = settings - 'lateToleranceMinutes' where id = $1`, [ids.tenantA]);
    const [{ id: cov }] = await su(`insert into app.patient_coverage(tenant_id, patient_id, payer_id) select $1, $2, id from app.payer where code = 'ASR' returning id`, [ids.tenantA, P[11]]);
    const b = await mkAppointment(P[11], 40, UNIT_G);
    expect((await checkIn(daftar, b, { coverageId: cov })).body.code).toBe('ENC-400-ELIGIBILITY');
    expect((await get(`/api/v1/appointments/${b}`, daftar)).body.status).toBe('BOOKED');
    expect((await checkIn(daftar, b, { coverageId: cov, eligibilityNote: 'Kartu dicek' })).body.payerType).toBe('ASURANSI');
  });
});

describe('Konkurensi & panggil antrean (gate Stage 8, SCH-FR-008)', () => {
  test('Q05 30 walk-in bersamaan di satu poli: nomor antrean & nomor kunjungan unik dan berurutan', async () => {
    const [{ id: unit }] = await su(`insert into app.service_unit(tenant_id, branch_id, code, name, unit_type) values ($1, $2, 'ANAK', 'Poli Anak', 'POLI') returning id`, [ids.tenantA, BRANCH]);
    const rs = await Promise.all(P.slice(12, 42).map((p) => walkIn(daftar, { patientId: p, unitId: unit, practitionerId: DR })));
    expect(rs.map((r) => r.status)).toEqual(Array(30).fill(201));
    const nums = rs.map((r) => r.body.queue.queueNumber as number).sort((x, y) => x - y);
    expect(nums).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(new Set(rs.map((r) => r.body.queue.displayCode)).size).toBe(30);
    expect(rs.every((r) => /^A-\d{3}$/.test(r.body.queue.displayCode))).toBe(true);
    expect(new Set(rs.map((r) => r.body.encounterNo)).size).toBe(30);
  }, 60_000);

  test('Q06 panggil berikutnya mengikuti urutan layanan; panggil ulang; lewati; dua petugas bersamaan dapat tiket berbeda', async () => {
    const first = await post('/api/v1/queue/call-next', dokter).send({ unitId: UNIT_G });
    expect(first.status).toBe(200);
    // G-005: janji temu dalam toleransi (Q04) → urutan jam slot (45 menit lalu) = paling depan
    expect(first.body).toMatchObject({ displayCode: 'G-005', status: 'CALLED', callCount: 1 });
    const again = await post(`/api/v1/queue/${first.body.id}/call`, dokter).send();
    expect(again.body.callCount).toBe(2);
    const skip = await post(`/api/v1/queue/${first.body.id}/skip`, daftar).send();
    expect(skip.body.status).toBe('SKIPPED');
    const [x, y] = await Promise.all([post('/api/v1/queue/call-next', dokter).send({ unitId: UNIT_G }), post('/api/v1/queue/call-next', daftar).send({ unitId: UNIT_G })]);
    expect(new Set([x.body.displayCode, y.body.displayCode])).toEqual(new Set(['G-001', 'G-003']));
    const recall = await post(`/api/v1/queue/${first.body.id}/call`, dokter).send();
    expect(recall.body).toMatchObject({ status: 'CALLED', callCount: 3 });
    const list = await queueOf(UNIT_G);
    expect(list[0].displayCode).toBe('G-005');
    const [a] = await su(`select actor_user_id, patient_id, change_summary from app.audit_log where action = 'QUEUE_CALLED' order by seq limit 1`);
    expect(a).toMatchObject({ actor_user_id: ids.dokterA, patient_id: P[10], change_summary: { displayCode: 'G-005', callCount: 1 } });
    // Kosongkan sisa antrean poli gigi → panggil berikutnya 409
    for (const t of (await queueOf(UNIT_G)).filter((q) => q.status === 'WAITING')) await post(`/api/v1/queue/${t.id}/skip`, daftar).send();
    expect((await post('/api/v1/queue/call-next', dokter).send({ unitId: UNIT_G })).body.code).toBe('QUE-409-EMPTY');
    expect((await post(`/api/v1/queue/${first.body.id}/call`, dokter).send({ x: 1 })).status).toBe(400);
  });
});

describe('Batal, papan kunjungan, isolasi (SCH-FR-010, 013)', () => {
  test('Q07 batal kunjungan: wajib alasan, tiket & janji temu ikut batal; yang sudah dilayani ditolak', async () => {
    const appt = await mkAppointment(P[42], 50);
    const e = await checkIn(daftar, appt);
    expect((await post(`/api/v1/encounters/${e.body.id}/cancel`, daftar).send({ reason: '' })).status).toBe(400);
    expect((await post(`/api/v1/encounters/${e.body.id}/cancel`, dokter).send({ reason: 'Uji' })).status).toBe(403);
    const c = await post(`/api/v1/encounters/${e.body.id}/cancel`, daftar).send({ reason: 'Pasien pulang sebelum dipanggil' });
    expect(c.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Pasien pulang sebelum dipanggil', queue: { status: 'CANCELLED' } });
    expect((await get(`/api/v1/appointments/${appt}`, daftar)).body).toMatchObject({ status: 'CANCELLED', statusReason: 'Kunjungan dibatalkan: Pasien pulang sebelum dipanggil' });
    expect((await post(`/api/v1/queue/${c.body.queue.id}/call`, dokter).send()).body.code).toBe('QUE-409-STATUS');
    expect((await post(`/api/v1/encounters/${e.body.id}/cancel`, daftar).send({ reason: 'Lagi' })).body.code).toBe('ENC-409-STATUS');
    expect((await post(`/api/v1/encounters/${A(70)}/cancel`, daftar).send({ reason: 'Sedang konsultasi' })).body.code).toBe('ENC-409-STATUS');
    // Setelah batal, pasien boleh didaftarkan lagi hari itu
    expect((await walkIn(daftar, { patientId: P[42], unitId: UNIT, practitionerId: DR })).status).toBe(201);
  });

  test('Q08 papan hari ini (urutan layanan, filter poli/status), riwayat pasien; klinik B tidak melihat; DELETE dicabut', async () => {
    const board = await get(`/api/v1/encounters?unitId=${UNIT_G}`, dokter);
    expect(board.status).toBe(200);
    expect(board.body.data.map((e: { queue: { displayCode: string } }) => e.queue.displayCode)).toEqual(['G-005', 'G-001', 'G-003', 'G-004', 'G-002', 'G-006']);
    const cancelled = await get(`/api/v1/encounters?status=CANCELLED`, daftar);
    expect(cancelled.body.data).toHaveLength(1);
    const hist = await get(`/api/v1/encounters?patientId=${P[0]}`, daftar);
    expect(hist.body.data.map((e: { unitName: string }) => e.unitName).sort()).toEqual(['Poli Gigi', 'Poli Umum']);
    const detail = await get(`/api/v1/encounters/${hist.body.data[0].id}`, daftar);
    expect(detail.body.patient.id).toBe(P[0]);
    const b = await login('dokter@b.test', HOST_B);
    expect((await get('/api/v1/encounters', b, HOST_B)).body.data).toEqual([]);
    expect((await get(`/api/v1/encounters/${detail.body.id}`, b, HOST_B)).status).toBe(404);
    await expect(su(`set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);
                     delete from app.queue_ticket where id = '${detail.body.queue.id}'`)).rejects.toThrow(/permission denied/);
  });

  test('Q09 peringatan kuota walk-in (OD-090): jadwal hari ini kuota 1 → walk-in berikutnya diberi peringatan, tetap terdaftar', async () => {
    const [{ dow }] = await su(`select extract(isodow from now() at time zone 'Asia/Jakarta')::int as dow`);
    const [{ id: unit }] = await su(`insert into app.service_unit(tenant_id, branch_id, code, name, unit_type) values ($1, $2, 'KIA', 'Poli KIA', 'POLI') returning id`, [ids.tenantA, BRANCH]);
    await su(`insert into app.practitioner_schedule(tenant_id, practitioner_id, branch_id, unit_id, day_of_week, start_time, end_time, slot_minutes, quota, valid_from)
              values ($1, $2, $3, $4, $5, '00:00', '23:55', 5, 1, current_date - 1)`, [ids.tenantA, DR, BRANCH, unit, dow]);
    const one = await walkIn(daftar, { patientId: P[1], unitId: unit, practitionerId: DR });
    expect(one.body.warnings).toEqual([]);
    const two = await walkIn(daftar, { patientId: P[2], unitId: unit, practitionerId: DR });
    expect(two.status).toBe(201);
    expect(two.body.warnings).toEqual(['Total pasien dr. Uji a hari ini (2) melebihi kuota (1).']);
  });
});
