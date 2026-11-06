import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { authenticator } from 'otplib';
import request from 'supertest';
import { encrypt } from '@clinicrme/shared';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 9 batch 2 — pengesahan rekam medis & addendum (CLN-FR-016–019; OD-034, OD-092 / DEC-038).
 * Gate Stage 9: catatan SIGNED tidak dapat diubah; addendum & hash integritas teruji; akses baca teraudit.
 */
const HOST = 'klinik-a.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const BRANCH = A(10), UNIT = A(11), DR = A(20);
const ICD10_R50 = 'c1000000-0000-0000-0000-000000000001';
const DR2 = A(28), DR3 = A(29), DOK2 = A(32), DOK3 = A(33), PERAWAT = A(27);
const KEY = 'a'.repeat(64);
let app: INestApplication;
let http: ReturnType<typeof request>;

type Jar = { cookie: string; csrf: string };
function jar(res: request.Response): Jar {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const csrf = get('crme_csrf');
  return { cookie: [get('crme_session'), csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '' };
}
const login = async (email: string) => {
  const r = await http.post('/api/v1/auth/login').set('Host', HOST).send({ email, password: PASSWORD });
  expect([email, r.status]).toEqual([email, 200]);
  return jar(r);
};
const get = (path: string, j: Jar) => http.get(path).set('Host', HOST).set('Cookie', j.cookie);
const post = (path: string, j: Jar) => http.post(path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
const put = (path: string, j: Jar, version?: number) => {
  const r = http.put(path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
  return version === undefined ? r : r.set('If-Match', String(version));
};

let signed: { id: string; noteId: string };
let daftar: Jar, dokter: Jar, dokter2: Jar, dokter3: Jar, perawat: Jar;
const P: string[] = [];
async function mkPatient(name: string) {
  const [{ id }] = await su(`insert into app.patient(tenant_id, mrn, full_name, birth_date, sex, identity_type, ihs_status)
                             values ($1, $2, $3, '1980-02-02', 'L', 'TANPA_IDENTITAS', 'NOT_APPLICABLE') returning id`,
  [ids.tenantA, `S${String(P.length + 1).padStart(6, '0')}`, name]);
  P.push(id);
  return id as string;
}
async function addUser(id: string, email: string, name: string, role: string, practitionerId?: string) {
  await su(`insert into app.app_user(id, tenant_id, email, full_name, practitioner_id) values ($1, $2, $3, $4, $5)`, [id, ids.tenantA, email, name, practitionerId ?? null]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and code = $3`, [ids.tenantA, id, role]);
  await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select tenant_id, $2, password_hash from app.user_credential where user_id = $1`, [ids.dokterA, id]);
}
/** Kunjungan siap disahkan: walk-in → mulai periksa → SOAP lengkap → diagnosis primer. */
async function ready(patientId: string, opts: { complete?: boolean } = {}) {
  const w = await post('/api/v1/encounters/walk-in', daftar).set('Idempotency-Key', `uji-${randomUUID()}`).send({ patientId, unitId: UNIT, practitionerId: DR });
  expect(w.status).toBe(201);
  const id = w.body.id as string;
  await post(`/api/v1/encounters/${id}/start-consultation`, dokter).send();
  await post(`/api/v1/encounters/${id}/vitals`, perawat).send({ temperature: 38.1, weight: 65, height: 170 });
  const n = await put(`/api/v1/encounters/${id}/note`, dokter, 0).send(opts.complete === false
    ? { subjective: 'Demam' } : { subjective: 'Demam 3 hari', objective: 'Suhu 38,1', assessment: 'Febris', plan: 'Parasetamol' });
  if (opts.complete !== false) await put(`/api/v1/encounters/${id}/diagnoses`, dokter).send([{ conceptId: ICD10_R50, rank: 'PRIMER' }]);
  return { id, noteId: n.body.id as string };
}
const sign = (id: string, j: Jar, body: object = { password: PASSWORD }) => post(`/api/v1/encounters/${id}/sign`, j).send(body);
const failures = async (userId: string) =>
  (await su(`select count(*)::int as n from app.audit_log where action = 'CLINICAL_REAUTH_FAILED' and actor_user_id = $1`, [userId]))[0].n as number;

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  await su(`update app.practitioner set sip_number = 'SIP/UJI/001', sip_valid_until = current_date + 365 where id = $1`, [DR]);
  await su(`insert into app.practitioner(id, tenant_id, full_name, practitioner_type, sip_number, sip_valid_until) values
            ($1, $3, 'dr. Pengganti', 'DOKTER', 'SIP/UJI/002', current_date + 365),
            ($2, $3, 'dr. Cabang Lain', 'DOKTER', 'SIP/UJI/003', current_date + 365)`, [DR2, DR3, ids.tenantA]);
  // dr. Pengganti berjadwal di cabang kunjungan (OD-092); dr. Cabang Lain tidak
  await su(`insert into app.practitioner_schedule(tenant_id, practitioner_id, branch_id, unit_id, day_of_week, start_time, end_time, slot_minutes, quota)
            values ($1, $2, $3, $4, 1, '08:00', '12:00', 15, 16)`, [ids.tenantA, DR2, BRANCH, UNIT]);
  await addUser(PERAWAT, 'perawat@a.test', 'Ners Uji', 'PERAWAT');
  await addUser(DOK2, 'dokter2@a.test', 'dr. Pengganti', 'DOKTER', DR2);
  await addUser(DOK3, 'dokter3@a.test', 'dr. Cabang Lain', 'DOKTER', DR3);
  daftar = await login('pendaftaran@a.test');
  dokter = await login('dokter@a.test');
  dokter2 = await login('dokter2@a.test');
  dokter3 = await login('dokter3@a.test');
  perawat = await login('perawat@a.test');
  for (let i = 0; i < 10; i++) await mkPatient(`Pasien Sah ${i + 1}`);
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('Pengesahan (CLN-FR-017, 018; OD-034)', () => {
  test('C11 prasyarat: izin, status Diperiksa, SOAP & diagnosis primer lengkap (422), konfirmasi ulang wajib salah satu', async () => {
    const e = await ready(P[0], { complete: false });
    expect((await sign(e.id, perawat)).status).toBe(403);
    expect((await sign(e.id, dokter, {})).status).toBe(400);
    expect((await sign(e.id, dokter, { password: PASSWORD, code: '123456' })).status).toBe(400);
    const r = await sign(e.id, dokter);
    expect([r.status, r.body.code]).toEqual([422, 'CLN-422-INCOMPLETE']);
    expect(r.body.missing).toEqual(['objective', 'assessment', 'plan', 'primaryDiagnosis']);
    // Belum dimulai pemeriksaan → 409
    const w = await post('/api/v1/encounters/walk-in', daftar).set('Idempotency-Key', `uji-${randomUUID()}`).send({ patientId: P[1], unitId: UNIT, practitionerId: DR });
    expect((await sign(w.body.id, dokter)).body.code).toBe('CLN-409-NOT-IN-CONSULTATION');
    expect(await failures(ids.dokterA)).toBe(0);                    // prasyarat gagal tidak dihitung sebagai percobaan konfirmasi
  });

  test('C12 kata sandi salah → 403 & tercatat; benar → SIGNED dengan hash, SIP & cara konfirmasi; semua penulisan terkunci', async () => {
    const e = await ready(P[2]);
    const bad = await sign(e.id, dokter, { password: 'salah-sekali' });
    expect([bad.status, bad.body.code]).toEqual([403, 'CLN-403-REAUTH']);
    expect(await failures(ids.dokterA)).toBe(1);
    const r = await sign(e.id, dokter);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ noteId: e.noteId, status: 'SIGNED', signedByName: 'dr. Uji a', contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const [n] = await su(`select status, signed_by, signer_user_id, signer_sip, sign_method, substitute_reason, content_hash from app.clinical_note where id = $1`, [e.noteId]);
    expect(n).toEqual({ status: 'SIGNED', signed_by: DR, signer_user_id: ids.dokterA, signer_sip: 'SIP/UJI/001', sign_method: 'PASSWORD',
      substitute_reason: null, content_hash: r.body.contentHash });
    expect((await sign(e.id, dokter)).body.code).toBe('CLN-409-SIGNED');
    const chart = (await get(`/api/v1/encounters/${e.id}/chart`, dokter)).body;
    expect(chart).toMatchObject({ editable: false, note: { status: 'SIGNED', signerSip: 'SIP/UJI/001', signMethod: 'PASSWORD', contentHash: r.body.contentHash } });
    expect((await put(`/api/v1/encounters/${e.id}/note`, dokter, chart.note.version).send({ plan: 'diubah' })).body.code).toBe('CLN-409-SIGNED');
    await expect(su(`set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);
                     update app.clinical_note set plan = 'diubah' where id = '${e.noteId}'`)).rejects.toThrow(/IMMUTABLE/);
    await expect(su(`set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);
                     insert into app.observation(tenant_id, encounter_id, code, value_num, recorded_by) values ('${ids.tenantA}', '${e.id}', 'SPO2', 99, '${ids.dokterA}')`))
      .rejects.toThrow(/IMMUTABLE/);
    const v = await get(`/api/v1/clinical-notes/${e.noteId}/verify`, perawat);
    expect(v.body).toEqual({ noteId: e.noteId, contentHash: r.body.contentHash, valid: true, addenda: [] });
    const [a] = await su(`select change_summary from app.audit_log where action = 'CLINICAL_NOTE_SIGNED' and resource_id = $1`, [e.noteId]);
    expect(a.change_summary).toMatchObject({ encounterId: e.id, method: 'PASSWORD', substitute: false });
  });

  test('C13 penandatangan wajib dokter aktif tertaut dengan SIP berlaku', async () => {
    const e = await ready(P[3]);
    await su(`update app.practitioner set sip_valid_until = current_date - 1 where id = $1`, [DR]);
    expect((await sign(e.id, dokter)).body.code).toBe('CLN-403-SIP');
    await su(`update app.practitioner set sip_valid_until = current_date + 365 where id = $1`, [DR]);
    await su(`update app.app_user set practitioner_id = null where id = $1`, [ids.dokterA]);
    expect((await sign(e.id, dokter)).body.code).toBe('CLN-409-NO-PRACTITIONER');
    await su(`update app.app_user set practitioner_id = $2 where id = $1`, [ids.dokterA, DR]);
    expect(await failures(ids.dokterA)).toBe(1);                   // tidak bertambah: ditolak sebelum konfirmasi ulang
    expect((await sign(e.id, dokter)).status).toBe(200);
  });

  test('C14 dokter pengganti (OD-092): harus berjadwal di cabang yang sama dan mengisi alasan', async () => {
    const e = await ready(P[4]);
    expect((await sign(e.id, dokter3)).body.code).toBe('CLN-403-SUBSTITUTE');
    const noReason = await sign(e.id, dokter2);
    expect([noReason.status, noReason.body.code]).toEqual([400, 'CLN-400-SUBSTITUTE-REASON']);
    const r = await sign(e.id, dokter2, { password: PASSWORD, substituteReason: 'Dokter kunjungan dipanggil ke IGD' });
    expect(r.body).toMatchObject({ status: 'SIGNED', signedByName: 'dr. Pengganti' });
    const [n] = await su(`select signed_by, signer_sip, substitute_reason from app.clinical_note where id = $1`, [e.noteId]);
    expect(n).toEqual({ signed_by: DR2, signer_sip: 'SIP/UJI/002', substitute_reason: 'Dokter kunjungan dipanggil ke IGD' });
  });

  test('C15 konfirmasi dengan kode TOTP; kode yang sama tidak dapat dipakai ulang', async () => {
    const secret = authenticator.generateSecret();
    await su(`insert into app.user_mfa(tenant_id, user_id, totp_secret_encrypted) values ($1, $2, $3)`, [ids.tenantA, DOK2, encrypt(KEY, secret)]);
    const e1 = await ready(P[5]), e2 = await ready(P[6]);
    const code = authenticator.generate(secret);
    const r = await sign(e1.id, dokter2, { code, substituteReason: 'Menggantikan sementara' });
    expect(r.status).toBe(200);
    expect((await su(`select sign_method from app.clinical_note where id = $1`, [e1.noteId]))[0].sign_method).toBe('TOTP');
    const replay = await sign(e2.id, dokter2, { code, substituteReason: 'Menggantikan sementara' });
    expect([replay.status, replay.body.code]).toEqual([403, 'CLN-403-REAUTH']);
    // Dokter tanpa autentikator terdaftar → diarahkan memakai kata sandi
    expect((await sign(e2.id, dokter, { code: '000000' })).body.code).toBe('CLN-400-NO-MFA');
  });
});

describe('Addendum & integritas (CLN-FR-019; ADR-0006)', () => {
  test('C16 addendum: hanya untuk catatan disahkan, alasan & konfirmasi ulang wajib, ber-hash, append-only', async () => {
    const draft = await ready(P[7], { complete: false });
    expect((await post(`/api/v1/clinical-notes/${draft.noteId}/addenda`, dokter).send({ reason: 'Koreksi dosis', content: 'x', password: PASSWORD })).body.code)
      .toBe('CLN-409-NOT-SIGNED');
    signed = await ready(P[8]);
    await sign(signed.id, dokter);
    const url = `/api/v1/clinical-notes/${signed.noteId}/addenda`;
    expect((await post(url, perawat).send({ reason: 'Koreksi dosis', content: 'x', password: PASSWORD })).status).toBe(403);
    expect((await post(url, dokter).send({ reason: 'abc', content: 'x', password: PASSWORD })).status).toBe(400);
    expect((await post(url, dokter).send({ reason: 'Koreksi rencana', content: 'x' })).status).toBe(400);
    const r = await post(url, dokter).send({ reason: 'Koreksi rencana terapi', content: 'Parasetamol 500 mg 3x1 bila demam.', password: PASSWORD });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ reason: 'Koreksi rencana terapi', authorName: 'dr. Uji a', authorSip: 'SIP/UJI/001', signMethod: 'PASSWORD',
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const chart = (await get(`/api/v1/encounters/${signed.id}/chart`, dokter)).body;
    expect(chart.note.addenda.map((a: { id: string }) => a.id)).toEqual([r.body.id]);
    expect(chart.note.plan).toBe('Parasetamol');                    // catatan asli tidak berubah
    expect((await get(`/api/v1/clinical-notes/${signed.noteId}/verify`, dokter)).body).toMatchObject({ valid: true, addenda: [{ id: r.body.id, valid: true }] });
    const app_ = `set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);`;
    await expect(su(`${app_} update app.clinical_addendum set content = 'ubah' where id = '${r.body.id}'`)).rejects.toThrow(/permission denied|IMMUTABLE/);
    await expect(su(`insert into app.clinical_addendum(tenant_id, note_id, reason, content, author_id, content_hash)
                     values ($1, $2, 'x', 'x', $3, 'x')`, [ids.tenantA, draft.noteId, DR])).rejects.toThrow(/sudah disahkan/);
  });

  test('C17 perubahan di luar aplikasi (trigger dimatikan superuser) terdeteksi oleh verifikasi hash', async () => {
    await su(`alter table app.clinical_note disable trigger trg_clinical_note_guard;
              update app.clinical_note set assessment = 'Diubah diam-diam' where id = '${signed.noteId}';
              alter table app.clinical_note enable trigger trg_clinical_note_guard`);
    const v = await get(`/api/v1/clinical-notes/${signed.noteId}/verify`, dokter);
    expect(v.body.valid).toBe(false);
    expect(v.body.addenda[0].valid).toBe(true);                     // addendum terikat hash catatan yang tersimpan
    await su(`alter table app.clinical_addendum disable trigger trg_addendum_immutable;
              update app.clinical_addendum set content = 'diubah' where note_id = '${signed.noteId}';
              alter table app.clinical_addendum enable trigger trg_addendum_immutable`);
    expect((await get(`/api/v1/clinical-notes/${signed.noteId}/verify`, dokter)).body.addenda[0].valid).toBe(false);
  });

  test('C18 batas percobaan konfirmasi ulang: 5 gagal dalam 15 menit → 429 walau kata sandi benar', async () => {
    const url = `/api/v1/clinical-notes/${signed.noteId}/addenda`;
    const body = (password: string) => ({ reason: 'Tambahan catatan', content: 'isi', password });
    for (let i = 0; i < 5; i++) expect((await post(url, dokter3).send(body('salah'))).body.code).toBe('CLN-403-REAUTH');
    const r = await post(url, dokter3).send(body(PASSWORD));
    expect([r.status, r.body.code]).toEqual([429, 'CLN-429-REAUTH']);
    expect(await failures(DOK3)).toBe(5);
  });
});

describe('Riwayat rekam medis (CLN-FR-016; AUD-FR-002)', () => {
  test('C19 lintas kunjungan, terbaru dulu, berhalaman, memuat catatan & addendum; akses tercatat', async () => {
    await su(`update app.encounter set status = 'FINISHED', finished_at = now() where id = $1`, [signed.id]);
    const e2 = await ready(P[8]);                                    // kunjungan kedua pasien yang sama (draft)
    const r = await get(`/api/v1/patients/${P[8]}/medical-records`, perawat);
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: { encounterId: string }) => x.encounterId)).toEqual([e2.id, signed.id]);
    expect(r.body.data[0]).toMatchObject({ note: { status: 'DRAFT' }, diagnoses: [{ code: 'R50.9' }], vitals: { values: { BMI: 22.5 } } });
    expect(r.body.data[1].note).toMatchObject({ status: 'SIGNED', addenda: [{ reason: 'Koreksi rencana terapi' }] });
    const p1 = await get(`/api/v1/patients/${P[8]}/medical-records?limit=1`, perawat);
    expect(p1.body.page).toEqual({ hasMore: true, nextCursor: '1' });
    expect((await get(`/api/v1/patients/${P[8]}/medical-records?limit=1&cursor=1`, perawat)).body.data[0].encounterId).toBe(signed.id);
    const audits = await su(`select actor_user_id from app.audit_log where action = 'MEDICAL_RECORD_HISTORY_READ' and patient_id = $1`, [P[8]]);
    expect(audits).toHaveLength(3);
    expect(audits[0].actor_user_id).toBe(PERAWAT);
    expect((await get(`/api/v1/patients/${P[8]}/medical-records`, daftar)).status).toBe(403);
  });
});
