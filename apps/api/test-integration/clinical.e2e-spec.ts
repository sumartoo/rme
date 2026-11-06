import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 9 batch 1 — worklist & pencatatan klinis (CLN-FR-001, 002, 004–009, 016; OD-035, OD-092 / DEC-038).
 * Data sintetis. Batas tanda vital & isian template berlabel [REVIEW-MEDIS].
 */
const HOST = 'klinik-a.clinicrme.test';
const HOST_B = 'klinik-b.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const BRANCH = A(10), UNIT = A(11), DR = A(20), KONS = A(31);
const ICD10_R50 = 'c1000000-0000-0000-0000-000000000001', ICD10_J06 = 'c1000000-0000-0000-0000-000000000002';
const ICD9 = 'c2000000-0000-0000-0000-000000000001';
const PERAWAT = A(27);
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
const post = (path: string, j: Jar, host = HOST) => http.post(path).set('Host', host).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
const put = (path: string, j: Jar, version?: number) => {
  const r = http.put(path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
  return version === undefined ? r : r.set('If-Match', String(version));
};
const del = (path: string, j: Jar) => http.delete(path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);

let daftar: Jar, dokter: Jar, perawat: Jar;
let UNIT_G: string;
const P: string[] = [];
const E: Record<string, string> = {};
async function mkPatient(name: string, birth = '1985-05-05', sex = 'P') {
  const [{ id }] = await su(`insert into app.patient(tenant_id, mrn, full_name, birth_date, sex, identity_type, ihs_status)
                             values ($1, $2, $3, $4, $5, 'TANPA_IDENTITAS', 'NOT_APPLICABLE') returning id`,
  [ids.tenantA, `C${String(P.length + 1).padStart(6, '0')}`, name, birth, sex]);
  P.push(id);
  return id as string;
}
const walkIn = async (patientId: string, unitId = UNIT) => {
  const r = await post('/api/v1/encounters/walk-in', daftar).set('Idempotency-Key', `uji-${randomUUID()}`).send({ patientId, unitId, practitionerId: DR });
  expect(r.status).toBe(201);
  return r.body as { id: string; queue: { id: string; displayCode: string } };
};
const chart = async (id: string, j = dokter) => (await get(`/api/v1/encounters/${id}/chart`, j)).body;

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  // Perawat (role template PERAWAT) — password sama dengan user uji lain
  await su(`insert into app.app_user(id, tenant_id, email, full_name) values ($1, $2, 'perawat@a.test', 'Ners Uji')`, [PERAWAT, ids.tenantA]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and code = 'PERAWAT'`, [ids.tenantA, PERAWAT]);
  await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select tenant_id, $2, password_hash from app.user_credential where user_id = $1`, [ids.dokterA, PERAWAT]);
  await su(`insert into app.code_system(id, code, version, source, is_current) values ('c2000000-0000-0000-0000-000000000000', 'ICD9CM', '2010-ID', 'Data uji sintetis', true)`);
  await su(`insert into app.concept(id, system_id, code, display_id) values ($1, 'c2000000-0000-0000-0000-000000000000', '96.59', 'Irigasi luka lainnya')`, [ICD9]);
  daftar = await login('pendaftaran@a.test');
  dokter = await login('dokter@a.test');
  perawat = await login('perawat@a.test');
  [{ id: UNIT_G }] = await su(`insert into app.service_unit(tenant_id, branch_id, code, name, unit_type, queue_prefix, default_template)
                               values ($1, $2, 'GIGI', 'Poli Gigi', 'POLI', 'G', 'GIGI') returning id`, [ids.tenantA, BRANCH]);
  for (let i = 0; i < 6; i++) await mkPatient(`Pasien Klinis ${i + 1}`);
  E['a'] = (await walkIn(P[0])).id;
  E['b'] = (await walkIn(P[1])).id;
  E['g'] = (await walkIn(P[2], UNIT_G)).id;
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('Worklist & tanda vital (CLN-FR-001, 002)', () => {
  test('C01 worklist hari ini per tampilan; pendaftaran tidak berhak; mine=true hanya pasien dokter yang login', async () => {
    expect((await get('/api/v1/clinical/worklist', daftar)).status).toBe(403);
    const nurse = await get('/api/v1/clinical/worklist?view=NURSE', perawat);
    expect(nurse.status).toBe(200);
    expect(nurse.body.map((w: { id: string }) => w.id)).toEqual([E['a'], E['b'], E['g']]);
    expect(nurse.body[0]).toMatchObject({ status: 'ARRIVED', triagedAt: null, noteStatus: null, allergyCount: 0, unitName: 'Poli Umum',
      queue: { displayCode: 'U-001', status: 'WAITING' }, patient: { id: P[0], fullName: 'Pasien Klinis 1', age: expect.stringMatching(/tahun$/) } });
    const gigi = await get(`/api/v1/clinical/worklist?unitId=${UNIT_G}`, dokter);
    expect(gigi.body.map((w: { id: string }) => w.id)).toEqual([E['g']]);
    expect((await get('/api/v1/clinical/worklist?mine=true', dokter)).body).toHaveLength(3);
    expect((await get('/api/v1/clinical/worklist?mine=true', perawat)).status).toBe(409);       // perawat tanpa data nakes
    expect((await get('/api/v1/clinical/worklist?view=X', perawat)).status).toBe(400);
  });

  test('C02 tanda vital: satu set per simpan, IMT otomatis (juga dari TB sebelumnya), batas wajar, status → Ditriase', async () => {
    const url = `/api/v1/encounters/${E['a']}/vitals`;
    expect((await post(url, daftar).send({ temperature: 37 })).status).toBe(403);
    for (const bad of [{}, { systolic: 120 }, { systolic: 80, diastolic: 90 }, { temperature: 50 }, { spo2: 120 }, { weight: 70, nadi: 80 }]) {
      expect([JSON.stringify(bad), (await post(url, perawat).send(bad)).status]).toEqual([JSON.stringify(bad), 400]);
    }
    const r = await post(url, perawat).send({ systolic: 120, diastolic: 80, heartRate: 88, respRate: 20, temperature: 37.8, spo2: 98, weight: 70, height: 170 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ recordedByName: 'Ners Uji', values: { SYSTOLIC: 120, DIASTOLIC: 80, HEART_RATE: 88, RESP_RATE: 20,
      TEMPERATURE: 37.8, SPO2: 98, WEIGHT: 70, HEIGHT: 170, BMI: 24.2 } });
    const [e] = await su(`select status, triaged_at from app.encounter where id = $1`, [E['a']]);
    expect(e.status).toBe('TRIAGED');
    expect(e.triaged_at).not.toBeNull();
    // Set kedua hanya BB → IMT dari TB set sebelumnya; status tetap
    const r2 = await post(url, dokter).send({ weight: 72.5 });
    expect(r2.body.values).toEqual({ WEIGHT: 72.5, BMI: 25.1 });
    const c = await chart(E['a']);
    expect(c.vitals.map((v: { values: object }) => Object.keys(v.values).length)).toEqual([2, 9]);
    expect(c.encounter.status).toBe('TRIAGED');
    const w = await get('/api/v1/clinical/worklist?view=NURSE', perawat);
    expect(w.body.find((x: { id: string }) => x.id === E['a']).triagedAt).not.toBeNull();
  });
});

describe('SOAP & template (CLN-FR-004, 005; OD-035, OD-092)', () => {
  test('C03 perawat mengisi anamnesis awal (membuat draft); tidak dapat menulis SOAP lengkap; If-Match wajib & diperiksa', async () => {
    const url = `/api/v1/encounters/${E['a']}/anamnesis`;
    expect((await put(url, perawat).send({ subjective: 'x' })).status).toBe(428);
    expect((await put(url, perawat, 3).send({ subjective: 'x' })).status).toBe(412);
    const r = await put(url, perawat, 0).send({ subjective: 'Demam 2 hari, batuk pilek.' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ templateCode: 'UMUM', subjective: 'Demam 2 hari, batuk pilek.', status: 'DRAFT', version: 1, updatedByName: 'Ners Uji' });
    expect((await put(`/api/v1/encounters/${E['a']}/note`, perawat, 1).send({ assessment: 'ISPA' })).status).toBe(403);
    expect((await put(url, daftar, 1).send({ subjective: 'x' })).status).toBe(403);
  });

  test('C04 dokter menyimpan SOAP; template dari poli; isian terstruktur divalidasi; audit tanpa isi klinis', async () => {
    const url = `/api/v1/encounters/${E['a']}/note`;
    const r = await put(url, dokter, 1).send({ objective: 'Faring hiperemis', assessment: 'ISPA', plan: 'Simptomatik', structured: { kesadaran: 'Compos mentis' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ subjective: 'Demam 2 hari, batuk pilek.', objective: 'Faring hiperemis', assessment: 'ISPA', plan: 'Simptomatik',
      structured: { kesadaran: 'Compos mentis' }, version: 2, updatedByName: 'dr. Uji' });
    expect((await put(url, dokter, 1).send({ plan: 'lama' })).status).toBe(412);
    expect((await put(url, dokter, 2).send({ structured: { kesadaran: 'Mengantuk' } })).body.code).toBe('CLN-400-STRUCTURED');
    expect((await put(url, dokter, 2).send({ structured: { tidakDikenal: 1 } })).status).toBe(400);
    expect((await put(url, dokter, 2).send({ templateCode: 'BEDAH' })).status).toBe(400);
    // Poli gigi → template GIGI otomatis; ganti ke UMUM membuang isian khusus gigi
    const g = `/api/v1/encounters/${E['g']}/note`;
    expect((await chart(E['g'])).templateCode).toBe('GIGI');
    const n = await put(g, dokter, 0).send({ subjective: 'Gigi berlubang', structured: { elemenGigi: '36', kesadaran: 'Compos mentis' } });
    expect(n.body).toMatchObject({ templateCode: 'GIGI', structured: { elemenGigi: '36', kesadaran: 'Compos mentis' } });
    const u = await put(g, dokter, n.body.version).send({ templateCode: 'UMUM' });
    expect(u.body).toMatchObject({ templateCode: 'UMUM', structured: { kesadaran: 'Compos mentis' } });
    const k = await put(g, dokter, u.body.version).send({ templateCode: 'KEBIDANAN', structured: { hpht: '2026-05-01', gravida: 2, para: 1, abortus: 0 } });
    expect(k.body.structured).toEqual({ hpht: '2026-05-01', gravida: 2, para: 1, abortus: 0 });
    // Audit hanya mencatat bagian yang berubah, bukan teks klinis
    const audits = await su(`select action, change_summary as summary from app.audit_log where resource_type = 'clinical_note' and patient_id = $1 order by occurred_at`, [P[0]]);
    expect(audits.map((a) => a.action)).toEqual(['CLINICAL_NOTE_CREATED', 'CLINICAL_NOTE_UPDATED']);
    expect(audits[1].summary.fields.sort()).toEqual(['assessment', 'objective', 'plan', 'structured']);
    expect(JSON.stringify(audits)).not.toContain('Faring');
    const tpl = await get('/api/v1/clinical/templates', perawat);
    expect(tpl.body.map((t: { code: string }) => t.code)).toEqual(['UMUM', 'GIGI', 'ANAK', 'KEBIDANAN']);
  });
});

describe('Diagnosis & tindakan (CLN-FR-008, 009)', () => {
  test('C05 diagnosis ICD-10: maksimal satu primer, kode harus ICD-10 versi berlaku, daftar menggantikan, teraudit', async () => {
    const url = `/api/v1/encounters/${E['a']}/diagnoses`;
    expect((await put(url, perawat).send([])).status).toBe(403);
    expect((await put(url, dokter).send([{ conceptId: ICD10_R50, rank: 'PRIMER' }, { conceptId: ICD10_J06, rank: 'PRIMER' }])).status).toBe(400);
    expect((await put(url, dokter).send([{ conceptId: ICD10_R50, rank: 'PRIMER' }, { conceptId: ICD10_R50, rank: 'SEKUNDER' }])).status).toBe(400);
    const bad = await put(url, dokter).send([{ conceptId: ICD9, rank: 'PRIMER' }]);
    expect([bad.status, bad.body.code]).toEqual([400, 'CLN-400-CONCEPT']);
    const r = await put(url, dokter).send([{ conceptId: ICD10_R50, rank: 'SEKUNDER' }, { conceptId: ICD10_J06, rank: 'PRIMER', caseStatus: 'BARU', note: 'klinis' }]);
    expect(r.status).toBe(200);
    expect(r.body.map((d: { code: string; rank: string }) => `${d.rank}:${d.code}`)).toEqual(['PRIMER:J06.9', 'SEKUNDER:R50.9']);
    const r2 = await put(url, dokter).send([{ conceptId: ICD10_J06, rank: 'PRIMER', caseStatus: 'LAMA' }]);
    expect(r2.body).toHaveLength(1);
    expect(r2.body[0]).toMatchObject({ code: 'J06.9', display: 'ISPA akut, tidak spesifik', caseStatus: 'LAMA' });
    const a = await su(`select change_summary as s from app.audit_log where action = 'DIAGNOSES_SET' and resource_id = $1 order by occurred_at`, [E['a']]);
    expect(a.map((x) => x.s)).toEqual([{ before: 0, after: 2 }, { before: 2, after: 1 }]);
    expect(JSON.stringify(a)).not.toContain('J06');
  });

  test('C06 tindakan: layanan aktif + ICD-9-CM opsional, pelaksana bawaan dokter kunjungan, hapus selama draft', async () => {
    const url = `/api/v1/encounters/${E['a']}/procedures`;
    expect((await post(url, dokter).send({ serviceItemId: KONS, conceptId: ICD10_R50 })).body.code).toBe('CLN-400-CONCEPT');
    expect((await post(url, dokter).send({ serviceItemId: randomUUID() })).body.code).toBe('CLN-400-SERVICE');
    expect((await post(url, dokter).send({ serviceItemId: KONS, qty: 0 })).status).toBe(400);
    const r = await post(url, dokter).send({ serviceItemId: KONS, conceptId: ICD9 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ serviceName: 'Konsultasi Umum', code: '96.59', performedBy: DR, performedByName: 'dr. Uji a', qty: 1 });
    const r2 = await post(url, dokter).send({ serviceItemId: KONS, qty: 2 });
    expect((await chart(E['a'])).procedures).toHaveLength(2);
    expect((await del(`${url}/${r2.body.id}`, dokter)).status).toBe(204);
    expect((await del(`${url}/${r2.body.id}`, dokter)).status).toBe(404);
    expect((await chart(E['a'])).procedures.map((p: { id: string }) => p.id)).toEqual([r.body.id]);
  });
});

describe('Alergi, riwayat & layar encounter (CLN-FR-006, 007, 016; AUD-FR-002)', () => {
  test('C07 alergi & riwayat di tingkat pasien: tidak dihapus, nonaktif wajib alasan, header hanya yang aktif', async () => {
    const url = `/api/v1/patients/${P[0]}/allergies`;
    expect((await post(url, daftar).send({ substance: 'Amoksisilin', category: 'OBAT' })).status).toBe(403);
    const a = await post(url, perawat).send({ substance: 'Amoksisilin', category: 'OBAT', reaction: 'Ruam', severity: 'BERAT' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ substance: 'Amoksisilin', status: 'ACTIVE', recordedByName: 'Ners Uji' });
    expect((await post(url, dokter).send({ substance: 'amoksisilin', category: 'OBAT' })).body.code).toBe('CLN-409-ALLERGY-EXISTS');
    const b = await post(url, dokter).send({ substance: 'Udang', category: 'MAKANAN' });
    expect((await post(`${url}/${b.body.id}/status`, dokter).send({ status: 'ENTERED_IN_ERROR' })).status).toBe(400);
    const s = await post(`${url}/${b.body.id}/status`, dokter).send({ status: 'ENTERED_IN_ERROR', reason: 'Pasien lain' });
    expect(s.body).toMatchObject({ status: 'ENTERED_IN_ERROR', statusReason: 'Pasien lain' });
    expect((await post(`${url}/${b.body.id}/status`, dokter).send({ status: 'INACTIVE', reason: 'lagi' })).status).toBe(409);
    expect((await get(url, perawat)).body.map((x: { substance: string; status: string }) => `${x.substance}:${x.status}`))
      .toEqual(['Amoksisilin:ACTIVE', 'Udang:ENTERED_IN_ERROR']);
    const h = await post(`/api/v1/patients/${P[0]}/history`, perawat).send({ historyType: 'OBAT_RUTIN', description: 'Amlodipin 5 mg 1x sehari' });
    expect(h.status).toBe(201);
    await post(`/api/v1/patients/${P[0]}/history`, dokter).send({ historyType: 'PENYAKIT', description: 'Hipertensi sejak 2020' });
    const c = await chart(E['a']);
    expect(c.patient.allergies.map((x: { substance: string }) => x.substance)).toEqual(['Amoksisilin']);
    expect(c.patient.history.map((x: { historyType: string }) => x.historyType).sort()).toEqual(['OBAT_RUTIN', 'PENYAKIT']);
    expect((await get('/api/v1/clinical/worklist?view=NURSE', perawat)).body.find((w: { id: string }) => w.id === E['a']).allergyCount).toBe(1);
    // Klinik lain tidak melihat; tidak ada DELETE untuk role aplikasi
    const other = await login('dokter@b.test', HOST_B);
    expect((await get(url, other, HOST_B)).status).toBe(404);
    await expect(su(`set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);
                     delete from app.allergy_intolerance where id = '${a.body.id}'`)).rejects.toThrow(/permission denied/);
  });

  test('C08 layar encounter: header pasien, riwayat kunjungan dengan diagnosis primer, akses baca tercatat dengan patient_id', async () => {
    // Kunjungan lama pasien yang sama (selesai, diagnosis primer R50.9)
    const [{ id: old }] = await su(`insert into app.encounter(tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, arrival_type, status, arrived_at)
                                    values ($1, 'KJ-LAMA-1', $2, $3, $4, $5, 'WALK_IN', 'FINISHED', now() - interval '30 days') returning id`,
    [ids.tenantA, P[0], BRANCH, UNIT, DR]);
    await su(`insert into app.condition_dx(tenant_id, encounter_id, concept_id, rank) values ($1, $2, $3, 'PRIMER')`, [ids.tenantA, old, ICD10_R50]);
    const before = (await su(`select count(*)::int as n from app.audit_log where action = 'CLINICAL_RECORD_READ' and patient_id = $1`, [P[0]]))[0].n;
    const r = await get(`/api/v1/encounters/${E['a']}/chart`, perawat);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ editable: true, templateCode: 'UMUM',
      encounter: { id: E['a'], status: 'TRIAGED', unitName: 'Poli Umum', practitionerName: 'dr. Uji a', payerType: 'UMUM' },
      patient: { id: P[0], fullName: 'Pasien Klinis 1', sex: 'P', birthDate: '1985-05-05', processingRestricted: false },
      note: { assessment: 'ISPA' }, diagnoses: [{ code: 'J06.9', rank: 'PRIMER' }] });
    expect(r.body.previousVisits).toEqual([expect.objectContaining({ id: old, encounterNo: 'KJ-LAMA-1', status: 'FINISHED',
      primaryDiagnosis: { code: 'R50.9', display: 'Demam, tidak spesifik' } })]);
    const after = await su(`select actor_user_id, resource_id from app.audit_log where action = 'CLINICAL_RECORD_READ' and patient_id = $1 order by occurred_at`, [P[0]]);
    expect(after).toHaveLength(before + 1);
    expect(after[after.length - 1]).toMatchObject({ actor_user_id: PERAWAT, resource_id: E['a'] });
    expect((await get(`/api/v1/encounters/${E['a']}/chart`, daftar)).status).toBe(403);
    const other = await login('dokter@b.test', HOST_B);
    expect((await get(`/api/v1/encounters/${E['a']}/chart`, other, HOST_B)).status).toBe(404);
  });

  test('C09 mulai pemeriksaan: status Diperiksa, tiket antrean selesai, idempoten; status lain ditolak', async () => {
    const url = `/api/v1/encounters/${E['b']}/start-consultation`;
    expect((await post(url, perawat).send()).status).toBe(403);
    const r = await post(url, dokter).send();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: E['b'], status: 'IN_CONSULTATION' });
    expect((await post(url, dokter).send()).body.consultStartedAt).toBe(r.body.consultStartedAt);
    const [t] = await su(`select status from app.queue_ticket where encounter_id = $1`, [E['b']]);
    expect(t.status).toBe('SERVED');
    const w = await get('/api/v1/clinical/worklist', dokter);
    expect(w.body[0].id).toBe(E['b']);                                          // yang sedang diperiksa paling atas
    expect((await get('/api/v1/clinical/worklist?view=NURSE', perawat)).body.map((x: { id: string }) => x.id)).not.toContain(E['b']);
    await su(`update app.encounter set status = 'CONSULT_DONE' where id = $1`, [E['g']]);
    expect((await post(`/api/v1/encounters/${E['g']}/start-consultation`, dokter).send()).status).toBe(409);
  });

  test('C10 catatan disahkan / kunjungan batal → semua penulisan ditolak (API 409, database menolak juga)', async () => {
    const e = (await walkIn(P[3])).id;
    const n = await put(`/api/v1/encounters/${e}/note`, dokter, 0).send({ subjective: 'S', assessment: 'A' });
    await put(`/api/v1/encounters/${e}/diagnoses`, dokter).send([{ conceptId: ICD10_R50, rank: 'PRIMER' }]);
    // Pengesahan dibuat di batch 2 — di sini disimulasikan langsung
    await su(`update app.clinical_note set status = 'SIGNED', signed_by = $2, signed_at = now(), content_hash = 'uji', signer_user_id = $3, sign_method = 'PASSWORD' where id = $1`, [n.body.id, DR, ids.dokterA]);
    const writes = [
      () => put(`/api/v1/encounters/${e}/note`, dokter, n.body.version + 1).send({ plan: 'P' }),
      () => put(`/api/v1/encounters/${e}/anamnesis`, perawat, n.body.version + 1).send({ subjective: 'x' }),
      () => post(`/api/v1/encounters/${e}/vitals`, perawat).send({ temperature: 37 }),
      () => put(`/api/v1/encounters/${e}/diagnoses`, dokter).send([]),
      () => post(`/api/v1/encounters/${e}/procedures`, dokter).send({ serviceItemId: KONS }),
    ];
    for (const w of writes) expect((await w()).body.code).toBe('CLN-409-SIGNED');
    expect((await chart(e)).editable).toBe(false);
    await expect(su(`set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);
                     delete from app.condition_dx where encounter_id = '${e}'`)).rejects.toThrow(/IMMUTABLE/);
    // Kunjungan batal
    const c = (await walkIn(P[4])).id;
    await post(`/api/v1/encounters/${c}/cancel`, daftar).send({ reason: 'Pasien pulang' });
    expect((await post(`/api/v1/encounters/${c}/vitals`, perawat).send({ temperature: 37 })).body.code).toBe('CLN-409-ENCOUNTER-CLOSED');
  });
});
