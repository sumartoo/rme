import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { blindIndex } from '@clinicrme/shared';
import { encrypt } from '@clinicrme/shared/crypto';
import { SimulatorSatuSehatClient, simulatorDropEncounter, simulatorReset, type SatuSehatConnection } from '@clinicrme/db/satusehat';
import { sendPendingEncounters } from '@clinicrme/db/satusehat-encounter';
import { RECONCILE_MISSING, reconcileRemote } from '@clinicrme/db/satusehat-reconcile';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, ownerUrl, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 12 batch 4 — dashboard (INT-FR-010), rekonsiliasi lokal & jarak jauh (INT-FR-011), dan butir gate privasi.
 * Semua terhadap **simulator** SATUSEHAT. Data sintetis.
 */
const HOST = 'klinik-a.clinicrme.test';
const KEY = 'a'.repeat(64);
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const FACILITY = A(1), BRANCH = A(10), UNIT = A(11), DR = A(20);
const ICD10_R50 = 'c1000000-0000-0000-0000-000000000001';
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
const post = (path: string, j: Jar) => http.post(path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
let admin: Jar, kasir: Jar;

const run = (now?: Date) => sendPendingEncounters(pool, { keyHex: KEY, now });
const reconcile = () => reconcileRemote(pool, { keyHex: KEY });
const summary = async (q = '') => (await get(`/api/v1/integrations/satusehat/summary?facilityId=${FACILITY}${q}`, admin)).body;
const recon = async () => (await get(`/api/v1/integrations/satusehat/reconciliation?facilityId=${FACILITY}`, admin)).body;
const minutes = (n: number) => new Date(Date.now() + n * 60_000);

let seq = 0;
const PATIENTS: string[] = [];
async function encounter(o: { no?: string; ihs?: boolean; restricted?: boolean; signed?: boolean } = {}) {
  const n = ++seq;
  const nik = `317101010192${String(1000 + n).slice(-4)}`;
  const name = `Pasien Rekon ${n}`;
  PATIENTS.push(name);
  const [{ id: pid }] = await su(`insert into app.patient(tenant_id, mrn, full_name, birth_date, sex, identity_type, nik_encrypted, nik_hash, ihs_status, ihs_number,
      processing_restricted, restriction_reason, restricted_at)
    values ($1, $2, $3, '1990-01-01', 'L', 'NIK', $4, $5, $6, $7, $8, case when $8 then 'Permintaan pasien (uji)' end, case when $8 then now() end) returning id`,
  [ids.tenantA, `RM-O-${n}`, name, encrypt(KEY, nik), blindIndex(KEY, 'patient-nik', nik), o.ihs === false ? 'PENDING' : 'FOUND',
    o.ihs === false ? null : `P${4000000000 + n}`, o.restricted ?? false]);
  const [{ id }] = await su(`insert into app.encounter(tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, arrival_type, status,
      arrived_at, consult_started_at, consult_ended_at, finished_at)
    values ($1, $2, $3, $4, $5, $6, 'WALK_IN', 'FINISHED', now() - interval '60 minutes', now() - interval '50 minutes', now() - interval '30 minutes', now()) returning id`,
  [ids.tenantA, o.no ?? `KJ-O-${n}`, pid, BRANCH, UNIT, DR]);
  await su(`insert into app.condition_dx(tenant_id, encounter_id, concept_id, rank) values ($1, $2, $3, 'PRIMER')`, [ids.tenantA, id, ICD10_R50]);
  await su(`insert into app.observation(tenant_id, encounter_id, code, value_num, recorded_by) values ($1, $2, 'SYSTOLIC', 118, $3)`, [ids.tenantA, id, ids.dokterA]);
  const [{ id: noteId }] = await su(`insert into app.clinical_note(tenant_id, encounter_id, subjective, assessment) values ($1, $2, 'Keluhan', 'Penilaian') returning id`, [ids.tenantA, id]);
  if (o.signed !== false) {
    await su(`update app.clinical_note set status = 'SIGNED', signed_by = $2, signed_at = now() - interval '20 minutes', content_hash = 'hash-uji', signer_user_id = $3,
      sign_method = 'PASSWORD' where id = $1`, [noteId, DR, ids.dokterA]);
  }
  return { id: id as string, patientId: pid as string, noteId: noteId as string };
}

beforeAll(async () => {
  await resetDatabase();
  simulatorReset();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  pool = new Pool({ connectionString: ownerUrl(), max: 2 });
  await su(`update app.role set requires_mfa = false where code in ('TENANT_ADMIN', 'KASIR')`);
  admin = await login('admin@a.test');
  kasir = await login('kasir@a.test');
}, 60_000);
afterAll(async () => { await pool?.end(); await app?.close(); });

const S: Record<string, { id: string; patientId: string; noteId: string }> = {};

describe('Dashboard (INT-FR-010)', () => {
  test('O01 tanpa koneksi → belum dikonfigurasi; dengan data → jumlah per hari & total per status, antrean, validasi, izin', async () => {
    expect(await summary()).toMatchObject({ configured: false, data: [] });
    expect((await http.put('/api/v1/integrations/satusehat').set('Host', HOST).set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf)
      .send({ facilityId: FACILITY, environment: 'SIMULATOR', clientId: 'client-simulasi-001', clientSecret: SECRET, organizationId: '10000004' })).status).toBe(200);
    await su(`update app.practitioner set nik_encrypted = $2, nik_hash = $3 where id = $1`, [DR, encrypt(KEY, '3171010101900001'), blindIndex(KEY, 'practitioner-nik', '3171010101900001')]);
    expect((await post('/api/v1/integrations/satusehat/sync-master', admin).send({ facilityId: FACILITY })).status).toBe(200);
    S.a = await encounter();
    S.b = await encounter();
    S.blocked = await encounter({ ihs: false });
    S.restricted = await encounter({ restricted: true });
    S.lost = await encounter({ no: 'KJ-O-LOST' });
    S.draft = await encounter({ signed: false });
    await run();
    S.queued = await encounter();                                  // disahkan setelah putaran worker → antrean
    const s = await summary();
    expect(s).toMatchObject({ configured: true, environment: 'SIMULATOR', timezone: 'Asia/Jakarta', queued: 1 });
    expect(s.data).toHaveLength(14);
    expect(s.data[0]).toMatchObject({ sent: 2, pending: 1, blocked: 1, skipped: 1, error: 0, dead: 0 });
    expect(s.data[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.data.slice(1).every((d: { sent: number; pending: number }) => d.sent + d.pending === 0)).toBe(true);
    expect(s.totals).toMatchObject({ SENT: 2, PENDING: 1, BLOCKED: 1, SKIPPED: 1 });
    expect(s.byKind).toEqual(expect.arrayContaining([{ localType: 'encounter', status: 'SENT', count: 2 }]));
    expect(s.unchecked).toBe(2);
    expect((await summary('&days=3')).data).toHaveLength(3);
    expect((await get(`/api/v1/integrations/satusehat/summary?facilityId=${FACILITY}&days=91`, admin)).status).toBe(400);
    expect((await get(`/api/v1/integrations/satusehat/summary?facilityId=x`, admin)).status).toBe(400);
    expect((await get(`/api/v1/integrations/satusehat/summary?facilityId=${FACILITY}`, kasir)).status).toBe(403);
    expect(JSON.stringify(s)).not.toMatch(/Pasien Rekon|KJ-O/);
  });
});

describe('Rekonsiliasi (INT-FR-011)', () => {
  test('O02 kunjungan disahkan vs terkirim: selisih & alasan per kunjungan; setelah ditindaklanjuti → 0 selisih', async () => {
    let r = await recon();
    expect(r.summary).toEqual({ signed: 6, sent: 2, skipped: 1, notSent: 3, idMismatch: 0, difference: 3, remoteUnchecked: 2, duplicates: 0, openFollowUps: 0, missingIds: 0 });
    const why = Object.fromEntries(r.data.map((x: { encounterId: string; reason: string }) => [x.encounterId, x.reason]));
    expect(why[S.blocked.id]).toMatch(/belum punya nomor IHS/);
    expect(why[S.lost.id]).toBe('SATUSEHAT tidak merespons (timeout)');
    expect(why[S.queued.id]).toBe('Belum diproses (antrean pengiriman berikutnya)');
    expect(why[S.restricted.id]).toMatch(/pemrosesan data dibatasi/);
    expect(why[S.a.id]).toBeUndefined();
    expect(why[S.draft.id]).toBeUndefined();                      // belum disahkan → bukan sasaran
    // ID di kunjungan tidak cocok dengan catatan kirim → dihitung sebagai selisih
    await su(`update app.encounter set satusehat_id = 'id-lain' where id = $1`, [S.a.id]);
    r = await recon();
    expect(r.summary).toMatchObject({ idMismatch: 1, difference: 4 });
    expect(r.data.find((x: { encounterId: string }) => x.encounterId === S.a.id).reason).toBe('ID SATUSEHAT di kunjungan tidak cocok dengan catatan kirim');
    // Ditindaklanjuti: IHS dilengkapi, putaran ulang (respons hilang ditemukan per identifier), rekonsiliasi jarak jauh memperbaiki ID
    await su(`update app.patient set ihs_status = 'FOUND', ihs_number = 'P4999999999' where id = $1`, [S.blocked.patientId]);
    await run(minutes(2));
    const rr = await reconcile();
    expect(rr).toMatchObject({ checked: 5, missingRemote: 0, idsCorrected: 1, duplicates: 0, failedTenants: 0 });
    expect(rr.idsFilled).toBe(2);                                  // Condition & Observation kunjungan "respons hilang"
    r = await recon();
    expect(r.summary).toEqual({ signed: 6, sent: 5, skipped: 1, notSent: 0, idMismatch: 0, difference: 0, remoteUnchecked: 0, duplicates: 0, openFollowUps: 0, missingIds: 0 });
    expect(r.data.map((x: { status: string }) => x.status)).toEqual(['SKIPPED']);
    expect((await reconcile()).checked).toBe(0);                  // sudah dicocokkan; tidak diulang sampai ada pengiriman baru
    // Validasi
    expect((await get(`/api/v1/integrations/satusehat/reconciliation?facilityId=${FACILITY}&from=2026-01-01&to=2026-06-30`, admin)).status).toBe(400);
    expect((await get(`/api/v1/integrations/satusehat/reconciliation?facilityId=${FACILITY}&from=17-11-2026`, admin)).status).toBe(400);
    expect((await get(`/api/v1/integrations/satusehat/reconciliation?facilityId=${FACILITY}`, kasir)).status).toBe(403);
    expect((await get(`/api/v1/integrations/satusehat/reconciliation?facilityId=${A(2)}`, admin)).status).toBe(404);
  });

  test('O03 pencocokan jarak jauh: data ganda di SATUSEHAT dilaporkan; Encounter yang hilang di SATUSEHAT → ERROR, dapat dikirim ulang', async () => {
    const [ra] = await su(`select id, satusehat_id from app.fhir_sync_record where resource_type = 'Encounter' and local_id = $1`, [S.b.id]);
    // Condition ganda (mis. respons hilang saat koreksi diagnosis) dibuat langsung di simulator
    const sim = new SimulatorSatuSehatClient({ id: 'x', facilityId: FACILITY, environment: 'SIMULATOR', clientId: 'c', clientSecret: 's', organizationId: '10000004' } as SatuSehatConnection);
    await sim.request('POST', '', { resourceType: 'Bundle', type: 'transaction', entry: [{ fullUrl: 'urn:uuid:dup', request: { method: 'POST', url: 'Condition' }, resource: {
      resourceType: 'Condition', code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'R50.9' }] }, subject: { reference: 'Patient/P4000000002' },
      encounter: { reference: `Encounter/${ra.satusehat_id}` } } }] });
    await su(`update app.fhir_sync_record set remote_checked_at = null where id = $1`, [ra.id]);
    expect(await reconcile()).toMatchObject({ checked: 1, duplicates: 1 });
    let r = await recon();
    expect(r.summary.duplicates).toBe(1);
    expect(r.data.find((x: { encounterId: string }) => x.encounterId === S.b.id)).toMatchObject({ status: 'SENT', reason: '1 data ganda ditemukan di SATUSEHAT', duplicates: 1 });
    expect((await summary()).duplicates).toBe(1);

    // Encounter tidak ada di SATUSEHAT (mis. dihapus/ditolak belakangan) → ERROR + Perlu tindakan
    simulatorDropEncounter('KJ-O-1');
    const [r1] = await su(`select id from app.fhir_sync_record where resource_type = 'Encounter' and local_id = $1`, [S.a.id]);
    await su(`update app.fhir_sync_record set remote_checked_at = null where id = $1`, [r1.id]);
    expect(await reconcile()).toMatchObject({ checked: 1, missingRemote: 1 });
    expect(await su(`select status, last_error from app.fhir_sync_record where id = $1`, [r1.id])).toEqual([{ status: 'ERROR', last_error: RECONCILE_MISSING }]);
    r = await recon();
    expect(r.summary).toMatchObject({ sent: 4, notSent: 1, difference: 1 });
    const issues = (await get(`/api/v1/integrations/satusehat/records?facilityId=${FACILITY}`, admin)).body.data;
    expect(issues.find((x: { id: string }) => x.id === r1.id)).toMatchObject({ status: 'ERROR', resendable: true, blocking: [RECONCILE_MISSING] });
    expect((await post(`/api/v1/integrations/satusehat/records/${r1.id}/retry`, admin).send()).body.status).toBe('PENDING');
    expect((await run()).SENT).toBe(1);
    expect((await reconcile()).missingRemote).toBe(0);
    expect((await recon()).summary).toMatchObject({ sent: 5, difference: 0 });
    const [au] = await su(`select actor_kind, change_summary from app.audit_log where action = 'SATUSEHAT_RECONCILE_MISSING'`);
    expect(au).toEqual({ actor_kind: 'SYSTEM', change_summary: { environment: 'SIMULATOR' } });
  });
});

describe('Gate privasi (OD-122)', () => {
  test('O04 payload, identitas pasien & kredensial tidak tersimpan di audit/log integrasi/outbox; kredensial terenkripsi', async () => {
    const texts = [
      ...(await su(`select change_summary::text as t from app.audit_log where action like 'SATUSEHAT%' or action like 'INTEGRATION%'`)).map((x) => x.t as string),
      ...(await su(`select coalesce(problems::text, '') || coalesce(last_error, '') as t from app.fhir_sync_record`)).map((x) => x.t as string),
      ...(await su(`select payload::text as t from app.outbox_event`)).map((x) => x.t as string),
    ];
    expect(texts.length).toBeGreaterThan(10);
    const all = texts.join('\n');
    for (const name of PATIENTS) expect(all).not.toContain(name);
    expect(all).not.toMatch(/P4\d{9}|31710101019\d{5}|Bundle|"entry"|valueQuantity|rahasia-simulator|access_token/);
    const [k] = await su(`select encode(secret_encrypted, 'escape') as raw from app.integration_connection where kind = 'SATUSEHAT'`);
    expect(k.raw).not.toContain(SECRET);
    expect(JSON.stringify((await get(`/api/v1/integrations/satusehat`, admin)).body)).not.toContain(SECRET);
  });
});
