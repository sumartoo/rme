import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { markNoShows } from '@clinicrme/db/no-show';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, ownerUrl, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';
import { freshTotp } from './support/totp';

/**
 * Stage 8 batch 2 — jadwal dokter, cuti/libur, slot, janji temu (SCH-FR-001..003, 010, 011; OD-087, OD-090 / DEC-035).
 * Tanggal uji selalu 1–2 minggu ke depan (WIB) agar tidak bergantung hari uji dijalankan.
 */
const HOST = 'klinik-a.clinicrme.test';
const HOST_B = 'klinik-b.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const BRANCH = A(10), UNIT = A(11), DR = A(20);
let app: INestApplication;
let http: ReturnType<typeof request>;
let pool: Pool;

type Jar = { cookie: string; csrf: string };
function jar(res: request.Response, prev?: Jar): Jar {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const session = get('crme_session') ?? prev?.cookie.split('; ').find((c) => c.startsWith('crme_session='));
  const csrf = get('crme_csrf') ?? (prev ? `crme_csrf=${prev.csrf}` : undefined);
  return { cookie: [session, csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '' };
}
const login = async (email: string, host = HOST) => {
  const r = await http.post('/api/v1/auth/login').set('Host', host).send({ email, password: PASSWORD });
  expect([email, r.status]).toEqual([email, 200]);
  return jar(r);
};
const get = (path: string, j: Jar, host = HOST) => http.get(path).set('Host', host).set('Cookie', j.cookie);
const send = (method: 'post' | 'put' | 'delete', path: string, j: Jar) => http[method](path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
const book = (j: Jar, body: object, key = `uji-${randomUUID()}`) => send('post', '/api/v1/appointments', j).set('Idempotency-Key', key).send(body);

const wibToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
/** Tanggal hari ISO `dow` (1 = Senin) pada minggu ke-`weeks` ke depan (selalu ≥ 7 hari dari hari ini). */
function nextDow(dow: number, weeks = 1): string {
  const d = new Date(`${wibToday()}T00:00:00Z`);
  const cur = ((d.getUTCDay() + 6) % 7) + 1;
  d.setUTCDate(d.getUTCDate() + ((dow - cur + 7) % 7) + 7 * weeks);
  return d.toISOString().slice(0, 10);
}
const at = (date: string, hhmm: string) => `${date}T${hhmm}:00+07:00`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const MON = nextDow(1), WED = addDays(MON, 2), MON2 = addDays(MON, 7), WED2 = addDays(MON, 9);

let admin: Jar, daftar: Jar, dokter: Jar;
let DR2: string, UNIT2: string, UNIT_OTHER_BRANCH: string;
const patients: string[] = [];
async function mkPatient(name: string) {
  const [{ id }] = await su(`insert into app.patient(tenant_id, mrn, full_name, birth_date, sex, identity_type, ihs_status)
                             values ($1, $2, $3, '1990-01-01', 'L', 'TANPA_IDENTITAS', 'NOT_APPLICABLE') returning id`,
  [ids.tenantA, `J${String(patients.length + 1).padStart(6, '0')}`, name]);
  patients.push(id);
  return id as string;
}

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  pool = new Pool({ connectionString: ownerUrl(), max: 2 });
  let j = await login('admin@a.test');
  const e = await send('post', '/api/v1/auth/mfa/enroll', j);
  const secret = new URL(e.body.otpauthUrl).searchParams.get('secret')!;
  const v = await send('post', '/api/v1/auth/mfa/verify', j).send({ code: await freshTotp(secret) });
  admin = j = jar(v, j);
  daftar = await login('pendaftaran@a.test');
  dokter = await login('dokter@a.test');
  [{ id: DR2 }] = await su(`insert into app.practitioner(tenant_id, full_name, practitioner_type) values ($1, 'drg. Kedua', 'DOKTER_GIGI') returning id`, [ids.tenantA]);
  [{ id: UNIT2 }] = await su(`insert into app.service_unit(tenant_id, branch_id, code, name, unit_type) values ($1, $2, 'GIGI', 'Poli Gigi', 'POLI') returning id`, [ids.tenantA, BRANCH]);
  const [{ id: br2 }] = await su(`insert into app.branch(tenant_id, facility_id, code, name) values ($1, $2, 'CBG2', 'Cabang 2') returning id`, [ids.tenantA, A(1)]);
  [{ id: UNIT_OTHER_BRANCH }] = await su(`insert into app.service_unit(tenant_id, branch_id, code, name, unit_type) values ($1, $2, 'UMUM2', 'Poli Umum 2', 'POLI') returning id`, [ids.tenantA, br2]);
  for (let i = 0; i < 22; i++) await mkPatient(`Pasien Jadwal ${i + 1}`);
}, 60_000);
afterAll(async () => { await app?.close(); await pool?.end(); });

let schedMon: { id: string; version: number };
describe('Jadwal praktik (SCH-FR-001, OD-090)', () => {
  test('S01 admin membuat jadwal: kuota bawaan = jumlah slot; bentrok jam (cabang mana pun) ditolak; petugas pendaftaran hanya membaca', async () => {
    const body = { practitionerId: DR, branchId: BRANCH, unitId: UNIT, dayOfWeek: 1, startTime: '08:00', endTime: '10:00', slotMinutes: 15 };
    expect((await send('post', '/api/v1/schedules', daftar).send(body)).status).toBe(403);
    const r = await send('post', '/api/v1/schedules', admin).send(body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ practitionerName: 'dr. Uji a', unitName: 'Poli Umum', dayOfWeek: 1, startTime: '08:00', endTime: '10:00',
      slotMinutes: 15, quota: 8, slotCount: 8, timezone: 'Asia/Jakarta', isActive: true, version: 1 });
    schedMon = r.body;
    const overlap = await send('post', '/api/v1/schedules', admin).send({ ...body, unitId: UNIT2, startTime: '09:30', endTime: '11:00' });
    expect([overlap.status, overlap.body.code]).toEqual([409, 'SCH-409-OVERLAP']);
    const adj = await send('post', '/api/v1/schedules', admin).send({ ...body, startTime: '10:00', endTime: '12:00', slotMinutes: 20, quota: 4 });
    expect(adj.status).toBe(201);
    const quota = await send('post', '/api/v1/schedules', admin).send({ ...body, dayOfWeek: 2, quota: 9 });
    expect(quota.body.errors.map((x: { field: string }) => x.field)).toContain('quota');
    expect((await send('post', '/api/v1/schedules', admin).send({ ...body, dayOfWeek: 2, startTime: '10:00', endTime: '09:00' })).status).toBe(400);
    expect((await send('post', '/api/v1/schedules', admin).send({ ...body, dayOfWeek: 2, unitId: UNIT_OTHER_BRANCH })).body.code).toBe('SCH-400-UNIT');
    // drg. Kedua: Rabu 08:00–09:00, kuota 2 dari 4 slot
    expect((await send('post', '/api/v1/schedules', admin).send({ practitionerId: DR2, branchId: BRANCH, unitId: UNIT2, dayOfWeek: 3,
      startTime: '08:00', endTime: '09:00', slotMinutes: 15, quota: 2 })).status).toBe(201);
    const list = await get('/api/v1/schedules', daftar);
    // Urutan nama mengikuti collation database (berbeda antar lingkungan) — bandingkan sebagai himpunan
    expect(list.body.map((s: { practitionerName: string; startTime: string }) => `${s.practitionerName} ${s.startTime}`).sort())
      .toEqual(['dr. Uji a 08:00', 'dr. Uji a 10:00', 'drg. Kedua 08:00'].sort());
    const [a] = await su(`select change_summary from app.audit_log where action = 'SCHEDULE_CREATED' and resource_id = $1`, [schedMon.id]);
    expect(a.change_summary.after).toMatchObject({ dayOfWeek: 1, startTime: '08:00', quota: 8 });
  });

  test('S02 slot per tanggal: sesi & slot ber-zona waktu cabang; hari tanpa jadwal kosong', async () => {
    const r = await get(`/api/v1/slots?date=${MON}&practitionerId=${DR}`, daftar);
    expect(r.status).toBe(200);
    expect(r.body.sessions.map((s: { startTime: string; slots: unknown[] }) => [s.startTime, s.slots.length])).toEqual([['08:00', 8], ['10:00', 6]]);
    expect(r.body.sessions[0].slots[0]).toEqual({ start: at(MON, '08:00'), end: at(MON, '08:15'), taken: false, available: true });
    expect(r.body.sessions[0]).toMatchObject({ booked: 0, closed: null, quota: 8 });
    expect((await get(`/api/v1/slots?date=${nextDow(2)}&practitionerId=${DR}`, daftar)).body.sessions).toEqual([]);
    expect((await get('/api/v1/slots', daftar)).status).toBe(400);
  });
});

describe('Janji temu (SCH-FR-003, 010, 011)', () => {
  let appt: { id: string };
  test('S03 pesan slot: Idempotency-Key, slot terisi, aturan slot/pasien; admin tidak berhak memesan', async () => {
    const body = { patientId: patients[0], practitionerId: DR, slotStart: at(MON, '08:00'), notes: 'Kontrol tekanan darah' };
    const k = `uji-${randomUUID()}`;
    const r = await book(daftar, body, k);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'BOOKED', localDate: MON, localTime: '08:00', unitName: 'Poli Umum', practitionerName: 'dr. Uji a',
      slotEnd: new Date(at(MON, '08:15')).toISOString(), channel: 'STAFF', patient: { id: patients[0], fullName: 'Pasien Jadwal 1' } });
    appt = r.body;
    expect((await book(daftar, body, k)).body.id).toBe(appt.id);
    const s = await get(`/api/v1/slots?date=${MON}&practitionerId=${DR}`, daftar);
    expect(s.body.sessions[0].slots[0]).toMatchObject({ taken: true, available: false });
    expect(s.body.sessions[0].booked).toBe(1);
    const code = async (b: object) => (await book(daftar, b)).body.code;
    expect(await code({ ...body, patientId: patients[1] })).toBe('SCH-409-SLOT-TAKEN');
    expect(await code({ ...body, slotStart: at(MON, '09:00') })).toBe('SCH-409-DUPLICATE-DAY');
    expect(await code({ ...body, patientId: patients[1], slotStart: at(MON, '08:07') })).toBe('SCH-400-NO-SLOT');
    expect(await code({ ...body, patientId: patients[1], slotStart: at(MON, '12:30') })).toBe('SCH-400-NO-SLOT');
    expect(await code({ ...body, patientId: patients[1], slotStart: at(MON, '08:15'), unitId: UNIT2 })).toBe('SCH-400-NO-SLOT');
    expect(await code({ ...body, patientId: patients[1], slotStart: `${MON}T08:15:00` })).toBe('GEN-400-VALIDATION');
    // Zona waktu: 09:15 WITA = 08:15 WIB → slot 08:15 cabang WIB
    const tz = await book(daftar, { ...body, patientId: patients[1], slotStart: `${MON}T09:15:00+08:00` });
    expect(tz.body.localTime).toBe('08:15');
    await su(`update app.patient set status = 'MERGED', merged_into_id = $2 where id = $1`, [patients[13], patients[12]]);
    expect(await code({ ...body, patientId: patients[13], slotStart: at(MON, '08:30') })).toBe('PAT-409-MERGED');
    expect((await book(admin, { ...body, patientId: patients[2], slotStart: at(MON, '08:30') })).status).toBe(403);
    expect((await book(dokter, { ...body, patientId: patients[2], slotStart: at(MON, '08:30') })).status).toBe(201);
    const [a] = await su(`select patient_id, change_summary from app.audit_log where action = 'APPOINTMENT_CREATED' and resource_id = $1`, [appt.id]);
    expect(a.patient_id).toBe(patients[0]);
  });

  test('S04 kuota sesi (OD-090): drg. Kedua kuota 2 dari 4 slot — pemesanan ketiga ditolak, slot lain tidak tersedia', async () => {
    expect((await book(daftar, { patientId: patients[3], practitionerId: DR2, slotStart: at(WED, '08:00') })).status).toBe(201);
    expect((await book(daftar, { patientId: patients[4], practitionerId: DR2, slotStart: at(WED, '08:30') })).status).toBe(201);
    expect((await book(daftar, { patientId: patients[5], practitionerId: DR2, slotStart: at(WED, '08:45') })).body.code).toBe('SCH-409-QUOTA');
    const s = await get(`/api/v1/slots?date=${WED}&practitionerId=${DR2}`, daftar);
    expect(s.body.sessions[0].slots.map((x: { available: boolean }) => x.available)).toEqual([false, false, false, false]);
    expect(s.body.sessions[0].slots.map((x: { taken: boolean }) => x.taken)).toEqual([true, false, true, false]);
  });

  test('S05 bersamaan: 8 pasien memesan slot yang sama → tepat satu; 6 pasien memesan slot berbeda di sesi kuota 4 → tepat empat', async () => {
    const same = await Promise.all(patients.slice(14, 22).map((p) => book(daftar, { patientId: p, practitionerId: DR, slotStart: at(MON2, '08:00') })));
    expect(same.filter((r) => r.status === 201)).toHaveLength(1);
    expect(same.filter((r) => r.status === 409).every((r) => r.body.code === 'SCH-409-SLOT-TAKEN')).toBe(true);
    const times = ['10:00', '10:20', '10:40', '11:00', '11:20', '11:40'];
    const quota = await Promise.all(times.map((t, i) => book(daftar, { patientId: patients[i], practitionerId: DR, slotStart: at(MON2, t) })));
    expect(quota.filter((r) => r.status === 201)).toHaveLength(4);
    expect(quota.filter((r) => r.status === 409).every((r) => r.body.code === 'SCH-409-QUOTA')).toBe(true);
  }, 60_000);

  test('S06 batal: wajib alasan, slot tersedia lagi, tidak dapat dibatalkan dua kali', async () => {
    const r = await book(daftar, { patientId: patients[6], practitionerId: DR, slotStart: at(MON, '09:00') });
    expect((await send('post', `/api/v1/appointments/${r.body.id}/cancel`, daftar).send({ reason: '' })).status).toBe(400);
    const c = await send('post', `/api/v1/appointments/${r.body.id}/cancel`, daftar).send({ reason: 'Pasien berhalangan' });
    expect(c.body).toMatchObject({ status: 'CANCELLED', statusReason: 'Pasien berhalangan' });
    expect((await send('post', `/api/v1/appointments/${r.body.id}/cancel`, daftar).send({ reason: 'Lagi' })).body.code).toBe('SCH-409-STATUS');
    expect((await book(daftar, { patientId: patients[7], practitionerId: DR, slotStart: at(MON, '09:00') })).status).toBe(201);
    const [a] = await su(`select change_summary from app.audit_log where action = 'APPOINTMENT_CANCELLED' and resource_id = $1`, [r.body.id]);
    expect(a.change_summary).toEqual({ reason: 'Pasien berhalangan' });
  });

  test('S07 jadwal ulang: janji lama RESCHEDULED menunjuk janji baru; slot tujuan terisi → gagal & janji lama tetap', async () => {
    const r = await send('post', `/api/v1/appointments/${appt.id}/reschedule`, daftar).send({ slotStart: at(MON, '08:45'), reason: 'Minta lebih siang' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'BOOKED', localTime: '08:45', patient: { id: patients[0] } });
    const old = await get(`/api/v1/appointments/${appt.id}`, daftar);
    expect(old.body).toMatchObject({ status: 'RESCHEDULED', statusReason: 'Minta lebih siang', rescheduledToId: r.body.id });
    const taken = await send('post', `/api/v1/appointments/${r.body.id}/reschedule`, daftar).send({ slotStart: at(MON, '08:15'), reason: 'Coba slot terisi' });
    expect(taken.body.code).toBe('SCH-409-SLOT-TAKEN');
    expect((await get(`/api/v1/appointments/${r.body.id}`, daftar)).body.status).toBe('BOOKED');
    // Ke dokter lain pada hari yang sama
    const moved = await send('post', `/api/v1/appointments/${r.body.id}/reschedule`, daftar).send({ slotStart: at(WED, '08:15'), practitionerId: DR2, reason: 'Pindah ke drg.' });
    expect(moved.body.code).toBe('SCH-409-QUOTA');
    appt = r.body;
  });
});

describe('Cuti/libur & perubahan jadwal (SCH-FR-001, 002)', () => {
  test('S08 cuti dokter: janji terdampak dikembalikan, slot ditutup, pemesanan ditolak; libur cabang; dapat dihapus', async () => {
    expect((await send('post', '/api/v1/schedule-exceptions', admin).send({ practitionerId: DR, exceptionDate: '2020-01-06', reason: 'Lama' })).body.code).toBe('SCH-400-PAST');
    expect((await send('post', '/api/v1/schedule-exceptions', admin).send({ practitionerId: DR, branchId: BRANCH, exceptionDate: MON, reason: 'Keduanya' })).status).toBe(400);
    const ex = await send('post', '/api/v1/schedule-exceptions', admin).send({ practitionerId: DR, exceptionDate: MON, reason: 'Seminar' });
    expect(ex.status).toBe(201);
    expect(ex.body.affectedAppointments.map((a: { localTime: string }) => a.localTime)).toEqual(['08:15', '08:30', '08:45', '09:00']);
    const s = await get(`/api/v1/slots?date=${MON}&practitionerId=${DR}`, daftar);
    expect(s.body.sessions[0].closed).toEqual({ reason: 'Seminar', type: 'CUTI_DOKTER' });
    expect(s.body.sessions[0].slots.some((x: { available: boolean }) => x.available)).toBe(false);
    expect((await book(daftar, { patientId: patients[8], practitionerId: DR, slotStart: at(MON, '09:15') })).body.code).toBe('SCH-409-CLOSED');
    expect((await send('post', '/api/v1/schedule-exceptions', admin).send({ practitionerId: DR, exceptionDate: MON, reason: 'Ulang' })).body.code).toBe('SCH-409-EXCEPTION-EXISTS');
    expect((await send('delete', `/api/v1/schedule-exceptions/${ex.body.id}`, admin)).status).toBe(204);
    expect((await book(daftar, { patientId: patients[8], practitionerId: DR, slotStart: at(MON, '09:15') })).status).toBe(201);
    const hol = await send('post', '/api/v1/schedule-exceptions', admin).send({ branchId: BRANCH, exceptionDate: WED2, reason: 'Libur nasional' });
    expect(hol.body).toMatchObject({ branchName: 'Cabang 1', affectedAppointments: [] });
    const s2 = await get(`/api/v1/slots?date=${WED2}&practitionerId=${DR2}`, daftar);
    expect(s2.body.sessions[0].closed).toEqual({ reason: 'Libur nasional', type: 'LIBUR_CABANG' });
    expect((await get('/api/v1/schedule-exceptions', daftar)).body.map((e: { reason: string }) => e.reason)).toEqual(['Libur nasional']);
  });

  test('S09 ubah jadwal: If-Match; ditolak bila janji mendatang keluar jadwal/kuota atau jadwal dinonaktifkan; audit hanya yang berubah', async () => {
    const put = (body: object, v: number) => send('put', `/api/v1/schedules/${schedMon.id}`, admin).set('If-Match', `"${v}"`).send(body);
    expect((await send('put', `/api/v1/schedules/${schedMon.id}`, admin).send({ quota: 7 })).status).toBe(428);
    expect((await put({ startTime: '08:30' }, 1)).body.code).toBe('SCH-409-HAS-APPOINTMENTS');
    expect((await put({ quota: 2 }, 1)).body.code).toBe('SCH-409-HAS-APPOINTMENTS');
    expect((await put({ isActive: false }, 1)).body.code).toBe('SCH-409-HAS-APPOINTMENTS');
    expect((await put({ validTo: wibToday() }, 1)).body.code).toBe('SCH-409-HAS-APPOINTMENTS');
    const ok = await put({ endTime: '10:00', quota: 7 }, 1);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ quota: 7, version: 2 });
    expect(ok.headers.etag).toBe('"2"');
    expect((await put({ quota: 6 }, 1)).body.code).toBe('GEN-412-VERSION');
    const [a] = await su(`select change_summary from app.audit_log where action = 'SCHEDULE_UPDATED' and resource_id = $1`, [schedMon.id]);
    expect(a.change_summary).toEqual({ changed: ['quota'], before: { quota: 8 }, after: { quota: 7 } });
    expect((await put({ endTime: '10:30' }, 2)).body.code).toBe('SCH-409-OVERLAP');   // menabrak sesi 10:00
  });
});

describe('Daftar, no-show otomatis, isolasi', () => {
  test('S10 daftar janji per tanggal & riwayat pasien; dokter dapat membaca; klinik B tidak melihat', async () => {
    const day = await get(`/api/v1/appointments?date=${MON}&practitionerId=${DR}&status=BOOKED`, daftar);
    expect(day.body.data.map((a: { localTime: string }) => a.localTime)).toEqual(['08:15', '08:30', '08:45', '09:00', '09:15']);
    const hist = await get(`/api/v1/appointments?patientId=${patients[0]}&from=${MON}&to=${MON}`, dokter);
    expect(hist.body.data.map((a: { status: string }) => a.status)).toEqual(['BOOKED', 'RESCHEDULED']);
    const b = await login('dokter@b.test', HOST_B);
    expect((await get(`/api/v1/appointments?date=${MON}`, b, HOST_B)).body.data).toEqual([]);
    const first = day.body.data[0].id;
    expect((await get(`/api/v1/appointments/${first}`, b, HOST_B)).status).toBe(404);
    await expect(su(`set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);
                     delete from app.appointment where id = '${first}'`)).rejects.toThrow(/permission denied/);
  });

  test('S11 no-show otomatis (OD-087): belum check-in saat sesi berakhir → NO_SHOW teraudit SYSTEM; sebelum sesi berakhir tetap BOOKED', async () => {
    const during = await markNoShows(pool, new Date(at(MON, '09:30')));
    expect(during.marked).toBe(0);
    const r = await markNoShows(pool, new Date(at(MON, '10:00')));
    expect(r.marked).toBe(5);
    const day = await get(`/api/v1/appointments?date=${MON}&practitionerId=${DR}`, daftar);
    expect(day.body.data.filter((a: { status: string }) => a.status === 'NO_SHOW')).toHaveLength(5);
    const [a] = await su(`select actor_kind, actor_user_id, patient_id from app.audit_log where action = 'APPOINTMENT_NO_SHOW' order by seq limit 1`);
    expect(a).toMatchObject({ actor_kind: 'SYSTEM', actor_user_id: null });
    expect(a.patient_id).not.toBeNull();
    // Janji Rabu (sesi belum berakhir pada waktu uji) tidak tersentuh
    expect((await get(`/api/v1/appointments?date=${WED}&status=BOOKED`, daftar)).body.data).toHaveLength(2);
    const [{ ok }] = await su(`select bool_and(v.ok) as ok from app.audit_chain_head h cross join lateral app.verify_audit_chain(h.tenant_id) v`);
    expect(ok).toBe(true);
  });
});
