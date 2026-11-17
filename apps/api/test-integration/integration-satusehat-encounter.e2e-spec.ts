import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { blindIndex } from '@clinicrme/shared';
import { encrypt } from '@clinicrme/shared/crypto';
import { simulatorReset } from '@clinicrme/db/satusehat';
import { sendPendingEncounters } from '@clinicrme/db/satusehat-encounter';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, ownerUrl, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 12 batch 2 — kunjungan rawat jalan → Bundle SATUSEHAT setelah RM disahkan (INT-FR-004, INT-FR-008; OD-115, OD-118, OD-119 / DEC-044).
 * Semua terhadap **simulator** (bukan SATUSEHAT resmi). Data sintetis.
 */
const HOST = 'klinik-a.clinicrme.test';
const KEY = 'a'.repeat(64);
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const FACILITY = A(1), BRANCH = A(10), UNIT = A(11), DR = A(20);
const ICD10_R50 = 'c1000000-0000-0000-0000-000000000001', ICD10_J06 = 'c1000000-0000-0000-0000-000000000002';
const SECRET = 'rahasia-simulator-uji';   // pragma: allowlist secret — nilai sintetis untuk simulator
let app: INestApplication;
let http: ReturnType<typeof request>;
let pool: Pool;

type Jar = { cookie: string; csrf: string };
async function login(email: string): Promise<Jar> {
  const r = await http.post('/api/v1/auth/login').set('Host', HOST).send({ email, password: PASSWORD });
  expect([email, r.status]).toEqual([email, 200]);
  const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const csrf = get('crme_csrf');
  return { cookie: [get('crme_session'), csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '' };
}
const get = (path: string, j: Jar) => http.get(path).set('Host', HOST).set('Cookie', j.cookie);
const send = (m: 'post' | 'put', path: string, j: Jar) => http[m](path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
let admin: Jar, dokter: Jar, kasir: Jar;

const run = (now?: Date) => sendPendingEncounters(pool, { keyHex: KEY, now });
const status = async (encId: string) => (await get(`/api/v1/encounters/${encId}/satusehat`, dokter)).body;
const rec = async (encId: string) => (await su(`select status, attempts, last_error, problems, satusehat_id, next_attempt_at from app.fhir_sync_record
  where resource_type = 'Encounter' and local_id = $1`, [encId]))[0];
const minutes = (n: number) => new Date(Date.now() + n * 60_000);

let seq = 0;
interface EncOpts { no?: string; ihs?: boolean; restricted?: boolean; dx?: { concept: string; rank: 'PRIMER' | 'SEKUNDER' }[]; signed?: boolean; cancelled?: boolean;
  vitals?: [string, number | null][]; procedures?: (string | null)[]; arrived?: boolean }
/** Kunjungan selesai dengan catatan klinis disahkan (langsung di DB — alur klinis sudah diuji di clinical-*.e2e-spec). */
async function encounter(o: EncOpts = {}) {
  const n = ++seq;
  const nik = `317101010190${String(1000 + n).slice(-4)}`;
  const [{ id: pid }] = await su(`insert into app.patient(tenant_id, mrn, full_name, birth_date, sex, identity_type, nik_encrypted, nik_hash, ihs_status, ihs_number,
      processing_restricted, restriction_reason, restricted_at)
    values ($1, $2, 'Pasien Sintetis U', '1990-01-01', 'P', 'NIK', $3, $4, $5, $6, $7, case when $7 then 'Permintaan pasien (uji)' end, case when $7 then now() end) returning id`,
    [ids.tenantA, `RM-U-${n}`, encrypt(KEY, nik), blindIndex(KEY, 'patient-nik', nik), o.ihs === false ? 'PENDING' : 'FOUND',
     o.ihs === false ? null : `P${String(2000000000 + n)}`, o.restricted ?? false]);
  const [{ id }] = await su(`insert into app.encounter(tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, arrival_type, status, cancel_reason,
      arrived_at, consult_started_at, consult_ended_at, finished_at)
    values ($1, $2, $3, $4, $5, $6, 'WALK_IN', $7, $8, $9, now() - interval '50 minutes', now() - interval '30 minutes', now() - interval '10 minutes') returning id`,
    [ids.tenantA, o.no ?? `KJ-U-${n}`, pid, BRANCH, UNIT, DR, o.cancelled ? 'CANCELLED' : 'FINISHED', o.cancelled ? 'Batal (uji)' : null,
     o.arrived === false ? null : new Date(Date.now() - 60 * 60_000)]);
  for (const d of o.dx ?? [{ concept: ICD10_R50, rank: 'PRIMER' }]) {
    await su(`insert into app.condition_dx(tenant_id, encounter_id, concept_id, rank) values ($1, $2, $3, $4)`, [ids.tenantA, id, d.concept, d.rank]);
  }
  for (const [code, v] of o.vitals ?? [['SYSTOLIC', 120], ['DIASTOLIC', 80], ['TEMPERATURE', 37.8]]) {
    await su(`insert into app.observation(tenant_id, encounter_id, code, value_num, value_text, recorded_by) values ($1, $2, $3, $4, $5, $6)`,
      [ids.tenantA, id, code, v, v === null ? 'catatan' : null, ids.dokterA]);
  }
  for (const icd9 of o.procedures ?? []) {
    const [{ id: si }] = await su(`insert into app.service_item(tenant_id, code, name, service_type, icd9cm_code) values ($1, $2, $3, 'TINDAKAN', $4) returning id`,
      [ids.tenantA, `TND-U-${n}-${icd9 ?? 'x'}`, icd9 ? 'Rawat luka' : 'Nebulisasi', icd9]);
    await su(`insert into app.procedure_act(tenant_id, encounter_id, service_item_id, performed_by) values ($1, $2, $3, $4)`, [ids.tenantA, id, si, DR]);
  }
  // Catatan disahkan terakhir: setelah disahkan diagnosis/tindakan tidak dapat diubah (trigger IMMUTABLE)
  await su(`insert into app.clinical_note(tenant_id, encounter_id, subjective, assessment) values ($1, $2, 'Keluhan sintetis', 'Penilaian sintetis')`, [ids.tenantA, id]);
  if (o.signed !== false) {
    await su(`update app.clinical_note set status = 'SIGNED', signed_by = $2, signed_at = now() - interval '5 minutes', content_hash = 'hash-uji', signer_user_id = $3,
      sign_method = 'PASSWORD' where encounter_id = $1`, [id, DR, ids.dokterA]);
  }
  return id as string;
}

beforeAll(async () => {
  await resetDatabase();
  simulatorReset();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  pool = new Pool({ connectionString: ownerUrl(), max: 2 });
  await su(`update app.role set requires_mfa = false where code in ('TENANT_ADMIN', 'KASIR')`);
  admin = await login('admin@a.test');
  dokter = await login('dokter@a.test');
  kasir = await login('kasir@a.test');
  // Koneksi simulator + master (IHS dokter dari NIK, Location Poli Umum)
  expect((await send('put', '/api/v1/integrations/satusehat', admin).send({ facilityId: FACILITY, environment: 'SIMULATOR', clientId: 'client-simulasi-001',
    clientSecret: SECRET, organizationId: '10000004' })).status).toBe(200);
  await su(`update app.practitioner set nik_encrypted = $2, nik_hash = $3 where id = $1`, [DR, encrypt(KEY, '3171010101900001'), blindIndex(KEY, 'practitioner-nik', '3171010101900001')]);
  expect((await send('post', '/api/v1/integrations/satusehat/sync-master', admin).send({ facilityId: FACILITY })).body.locations.failed).toBe(0);
}, 60_000);
afterAll(async () => { await pool?.end(); await app?.close(); });

describe('Validasi sebelum kirim (INT-FR-008)', () => {
  test('U01 data belum lengkap → BLOCKED dengan pesan yang dapat ditindaklanjuti; dicek ulang tiap putaran; setelah dilengkapi → SENT', async () => {
    const id = await encounter({ ihs: false });
    const noDx = await encounter({ dx: [{ concept: ICD10_J06, rank: 'SEKUNDER' }], arrived: false });
    const before = await su(`select count(*)::int as n from app.audit_log where action like 'SATUSEHAT_ENCOUNTER%'`);
    expect((await run()).BLOCKED).toBe(2);
    expect((await status(noDx)).blocking).toEqual(['Waktu kedatangan pasien kosong', 'Diagnosis primer belum diisi']);
    let s = await status(id);
    expect(s).toMatchObject({ configured: true, environment: 'SIMULATOR', signed: true, status: 'BLOCKED', satusehatId: null });
    expect(s.blocking).toEqual([expect.stringMatching(/belum punya nomor IHS/)]);
    expect(JSON.stringify(s)).not.toMatch(/Pasien Sintetis|3171010101/);   // tanpa identitas pasien
    expect(await su(`select count(*)::int as n from app.audit_log where action like 'SATUSEHAT_ENCOUNTER%'`)).toEqual(before);   // BLOCKED tidak membanjiri audit
    expect((await run()).BLOCKED).toBe(2);   // tetap tertahan, dicek ulang
    // Dokter tanpa IHS & poli tanpa Location juga dilaporkan
    await su(`update app.practitioner set satusehat_ihs_id = null where id = $1`, [DR]);
    await su(`update app.fhir_sync_record set status = 'ERROR' where resource_type = 'Location'`);
    await run();
    s = await status(id);
    expect(s.blocking).toEqual(expect.arrayContaining([expect.stringMatching(/^Dokter .* belum punya IHS/), expect.stringMatching(/Poli Umum belum terdaftar sebagai Location/)]));
    await su(`update app.fhir_sync_record set status = 'SENT' where resource_type = 'Location'`);
    expect((await send('post', '/api/v1/integrations/satusehat/sync-master', admin).send({ facilityId: FACILITY })).body.practitioners.found).toBe(1);
    // Dilengkapi
    await su(`update app.patient set ihs_status = 'FOUND', ihs_number = 'P2999999999' where id = (select patient_id from app.encounter where id = $1)`, [id]);
    expect((await run()).SENT).toBe(1);
    expect(await status(id)).toMatchObject({ status: 'SENT', blocking: [], attempts: 1 });
    expect((await status(noDx)).status).toBe('BLOCKED');
  });

  test('U02 bukan sasaran: catatan belum disahkan, kunjungan batal, pasien membatasi pemrosesan (SKIPPED); endpoint status butuh clinical.record.read', async () => {
    const draft = await encounter({ signed: false });
    const batal = await encounter({ cancelled: true });
    const restricted = await encounter({ restricted: true });
    const r = await run();
    expect(r).toMatchObject({ SENT: 0, SKIPPED: 1 });
    expect(await rec(draft)).toBeUndefined();
    expect(await rec(batal)).toBeUndefined();
    expect(await rec(restricted)).toMatchObject({ status: 'SKIPPED', satusehat_id: null });
    expect(await status(draft)).toMatchObject({ status: 'NOT_SIGNED', signed: false });
    expect((await run()).SKIPPED).toBe(0);   // SKIPPED tidak dipindai ulang
    expect((await get(`/api/v1/encounters/${draft}/satusehat`, kasir)).status).toBe(403);
    expect((await get(`/api/v1/encounters/${A(999)}/satusehat`, dokter)).status).toBe(404);
  });
});

describe('Pengiriman Bundle (INT-FR-004, OD-115)', () => {
  test('U03 Bundle terkirim: Encounter + Condition + Observation + Procedure tercatat dengan ID SATUSEHAT; yang tak terpetakan → peringatan; tidak dikirim dua kali', async () => {
    const id = await encounter({ dx: [{ concept: ICD10_R50, rank: 'PRIMER' }, { concept: ICD10_J06, rank: 'SEKUNDER' }],
      vitals: [['SYSTOLIC', 120], ['DIASTOLIC', 80], ['HEART_RATE', 88], ['PAIN_SCALE', 3], ['OTHER', null]], procedures: ['93.57', null] });
    expect((await run()).SENT).toBe(1);
    const s = await status(id);
    expect(s).toMatchObject({ status: 'SENT', attempts: 1, lastError: null, lastSentAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) });
    expect(s.satusehatId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/PAIN_SCALE belum dipetakan/), expect.stringMatching(/OTHER/), expect.stringMatching(/Nebulisasi belum punya kode ICD-9-CM/)]));
    const kinds = s.resources.map((x: { resourceType: string }) => x.resourceType).sort();
    expect(kinds).toEqual(['Condition', 'Condition', 'Observation', 'Observation', 'Observation', 'Procedure']);
    expect(s.resources.every((x: { status: string; satusehatId: string }) => x.status === 'SENT' && /^[0-9a-f-]{36}$/.test(x.satusehatId))).toBe(true);
    expect(await su(`select satusehat_id from app.encounter where id = $1`, [id])).toEqual([{ satusehat_id: s.satusehatId }]);
    const [{ payload_hash: h }] = await su(`select payload_hash from app.fhir_sync_record where resource_type = 'Encounter' and local_id = $1`, [id]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Audit SYSTEM tanpa isi rekam medis / identitas
    const [a] = await su(`select actor_kind, change_summary::text as s from app.audit_log where action = 'SATUSEHAT_ENCOUNTER_SENT' and resource_id = $1`, [id]);
    expect(a.actor_kind).toBe('SYSTEM');
    expect(JSON.parse(a.s)).toMatchObject({ conditions: 2, observations: 3, procedures: 1, warnings: 3, reusedEncounter: false, environment: 'SIMULATOR' });
    expect(a.s).not.toMatch(/Pasien Sintetis|R50|120|Keluhan|P2\d{9}/);
    // Putaran berikutnya tidak mengirim ulang
    const n = await su(`select count(*)::int as n from app.fhir_sync_record`);
    expect((await run()).SENT).toBe(0);
    expect(await su(`select count(*)::int as n from app.fhir_sync_record`)).toEqual(n);
  });

  test('U04 respons hilang setelah tersimpan → percobaan ulang mencari Encounter per identifier dan tidak membuat duplikat (idempoten)', async () => {
    const id = await encounter({ no: 'KJ-U-LOST' });
    expect((await run()).RETRY).toBe(1);
    const r1 = await rec(id);
    expect(r1).toMatchObject({ status: 'PENDING', attempts: 1, satusehat_id: null });
    expect(new Date(r1.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    expect((await run()).RETRY + (await run()).SENT).toBe(0);   // belum waktunya
    expect((await run(minutes(2))).SENT).toBe(1);
    const s = await status(id);
    expect(s).toMatchObject({ status: 'SENT', attempts: 2 });
    expect(s.satusehatId).toMatch(/^[0-9a-f-]{36}$/);
    const [a] = await su(`select change_summary as summary from app.audit_log where action = 'SATUSEHAT_ENCOUNTER_SENT' and resource_id = $1`, [id]);
    expect(a.summary).toMatchObject({ reusedEncounter: true, attempts: 2 });
  });

  test('U05 gangguan sementara → dicoba ulang dengan backoff (1m, 5m, 30m, 2j) lalu DEAD sesudah 5 percobaan; ditolak (422) → ERROR tanpa retry', async () => {
    const id = await encounter({ no: 'KJ-U-503' });
    const at = [0, 2, 8, 40, 170];
    const out: string[] = [];
    for (const m of at) {
      const r = await run(minutes(m));
      out.push(r.DEAD ? 'DEAD' : r.RETRY ? 'RETRY' : '-');
    }
    expect(out).toEqual(['RETRY', 'RETRY', 'RETRY', 'RETRY', 'DEAD']);
    expect(await rec(id)).toMatchObject({ status: 'DEAD', attempts: 5, next_attempt_at: null, last_error: expect.stringMatching(/sementara/) });
    expect((await run(minutes(2000))).DEAD).toBe(0);   // DEAD tidak dipindai ulang (kirim ulang manual: batch 3)
    expect(await su(`select count(*)::int as n from app.audit_log where action = 'SATUSEHAT_ENCOUNTER_RETRY' and resource_id = $1`, [id])).toEqual([{ n: 4 }]);

    const bad = await encounter({ no: 'KJ-U-422' });
    expect((await run()).ERROR).toBe(1);
    const s = await status(bad);
    expect(s).toMatchObject({ status: 'ERROR', attempts: 1, nextAttemptAt: null });
    expect(s.blocking).toEqual(['Encounter.period.start tidak boleh di masa depan (Encounter.period.start)']);
    expect((await run(minutes(500))).ERROR).toBe(0);
  });

  test('U06 kredensial ditolak → klinik itu gagal tanpa mengubah status; klinik tanpa koneksi diabaikan', async () => {
    const id = await encounter();
    await su(`update app.integration_connection set secret_encrypted = $1 where kind = 'SATUSEHAT'`, [encrypt(KEY, 'ditolak')]);
    const r = await run();
    expect(r).toMatchObject({ failedTenants: 1, SENT: 0 });
    expect(await rec(id)).toBeUndefined();
    await su(`update app.integration_connection set secret_encrypted = $1 where kind = 'SATUSEHAT'`, [encrypt(KEY, SECRET)]);
    expect((await run()).SENT).toBe(1);
    // Tanpa koneksi aktif: status endpoint melaporkan belum dikonfigurasi
    await su(`update app.integration_connection set is_active = false where kind = 'SATUSEHAT'`);
    const other = await encounter();
    expect((await run()).SENT).toBe(0);
    expect(await status(other)).toMatchObject({ configured: false, status: null });
    await su(`update app.integration_connection set is_active = true where kind = 'SATUSEHAT'`);
  });
});
