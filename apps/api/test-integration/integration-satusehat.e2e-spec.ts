import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { blindIndex } from '@clinicrme/shared';
import { encrypt } from '@clinicrme/shared/crypto';
import { lookupPendingIhs, simulatorReset } from '@clinicrme/db/satusehat';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, ownerUrl, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 12 batch 1 — koneksi SATUSEHAT, uji koneksi, sinkron master, lookup IHS (INT-FR-001–003; OD-114, OD-116, OD-117, OD-121 / DEC-044).
 * Semua terhadap **simulator** (bukan SATUSEHAT resmi). Data sintetis; NIK uji bukan NIK orang sungguhan.
 */
const HOST = 'klinik-a.clinicrme.test';
const HOST_B = 'klinik-b.clinicrme.test';
const KEY = 'a'.repeat(64);
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const FACILITY = A(1), DR = A(20);
const SECRET = 'rahasia-simulator-uji';   // pragma: allowlist secret — nilai sintetis untuk simulator
let app: INestApplication;
let http: ReturnType<typeof request>;
let pool: Pool;

type Jar = { cookie: string; csrf: string; host: string };
async function login(email: string, host = HOST): Promise<Jar> {
  const r = await http.post('/api/v1/auth/login').set('Host', host).send({ email, password: PASSWORD });
  expect([email, r.status]).toEqual([email, 200]);
  const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const csrf = get('crme_csrf');
  return { cookie: [get('crme_session'), csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '', host };
}
const get = (path: string, j: Jar) => http.get(path).set('Host', j.host).set('Cookie', j.cookie);
const send = (m: 'post' | 'put', path: string, j: Jar) => http[m](path).set('Host', j.host).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
let admin: Jar, adminB: Jar, daftar: Jar, kasir: Jar;

const configure = (body: Record<string, unknown>, j: Jar = admin) => send('put', '/api/v1/integrations/satusehat', j).send(body);
const sim = { facilityId: FACILITY, environment: 'SIMULATOR', clientId: 'client-simulasi-001', clientSecret: SECRET, organizationId: '10000004' };
let mrnSeq = 100;
async function patient(nik: string | null, o: { createdDaysAgo?: number; restricted?: boolean } = {}) {
  const [{ id }] = await su(`insert into app.patient(tenant_id, mrn, full_name, birth_date, sex, identity_type, nik_encrypted, nik_hash, ihs_status, processing_restricted,
      restriction_reason, restricted_at, created_at)
    values ($1, $2, 'Pasien Sintetis', '1990-01-01', 'P', $3, $4, $5, $6, $7, case when $7 then 'Permintaan pasien (uji)' end, case when $7 then now() end,
            now() - make_interval(days => $8)) returning id`,
    [ids.tenantA, `RM-IT-${++mrnSeq}`, nik ? 'NIK' : 'TANPA_IDENTITAS', nik ? encrypt(KEY, nik) : null, nik ? blindIndex(KEY, 'patient-nik', nik) : null,
     nik ? 'PENDING' : 'NOT_APPLICABLE', o.restricted ?? false, o.createdDaysAgo ?? 0]);
  return id as string;
}
const ihs = async (id: string) => (await su(`select ihs_status, ihs_number, ihs_last_error from app.patient where id = $1`, [id]))[0];

beforeAll(async () => {
  await resetDatabase();
  simulatorReset();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  pool = new Pool({ connectionString: ownerUrl(), max: 2 });
  await su(`update app.role set requires_mfa = false where code in ('TENANT_ADMIN', 'KASIR')`);
  // Unit uji: dua poli + satu farmasi (bukan Location) di cabang fasilitas A
  await su(`insert into app.service_unit(tenant_id, branch_id, code, name, unit_type) values ($1, $2, 'GIGI', 'Poli Gigi', 'POLI'), ($1, $2, 'APT', 'Apotek', 'FARMASI')`,
    [ids.tenantA, A(10)]);
  admin = await login('admin@a.test');
  adminB = await login('admin@b.test', HOST_B);
  daftar = await login('pendaftaran@a.test');
  kasir = await login('kasir@a.test');
}, 60_000);
afterAll(async () => { await pool?.end(); await app?.close(); });

describe('Koneksi SATUSEHAT (INT-FR-001, OD-114)', () => {
  test('J01 kredensial terenkripsi & tidak pernah dikembalikan; secret wajib pertama kali; hanya integration.manage; terisolasi per tenant', async () => {
    expect((await configure({ ...sim, clientSecret: undefined })).body.code).toBe('INT-400-SECRET');
    expect((await configure(sim, kasir)).status).toBe(403);
    expect((await configure({ ...sim, facilityId: A(999) })).body.code).toBe('MST-404-FACILITY');
    const r = await configure(sim);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ environment: 'SIMULATOR', clientIdMasked: 'cli••••001', hasSecret: true, organizationId: '10000004', lastTestOk: null });
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    const [row] = await su(`select secret_ref, encode(secret_encrypted, 'escape') like '%' || $1 || '%' as plain from app.integration_connection where id = $2`, [SECRET, r.body.id]);
    expect(row).toEqual({ secret_ref: 'db:integration_connection.secret_encrypted', plain: false });
    const audit = await su(`select change_summary::text as s from app.audit_log where action = 'SATUSEHAT_CONNECTION_SAVED' and resource_id = $1`, [r.body.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].s).not.toContain(SECRET);
    expect(audit[0].s).not.toContain('client-simulasi-001');
    // Simpan ulang tanpa secret → secret lama dipakai
    expect((await configure({ ...sim, clientSecret: undefined, clientId: 'client-simulasi-002' })).body).toMatchObject({ id: r.body.id, clientIdMasked: 'cli••••002' });
    const ov = (await get('/api/v1/integrations/satusehat', admin)).body;
    expect(ov.simulatorAllowed).toBe(true);
    expect(ov.facilities.find((f: { facilityId: string }) => f.facilityId === FACILITY).connection).toMatchObject({ id: r.body.id, environment: 'SIMULATOR' });
    expect(JSON.stringify(ov)).not.toContain(SECRET);
    expect((await get('/api/v1/integrations/satusehat', kasir)).status).toBe(403);
    const ovB = (await get('/api/v1/integrations/satusehat', adminB)).body;
    expect(ovB.facilities.every((f: { connection: unknown }) => f.connection === null)).toBe(true);
    expect(await su(`select has_table_privilege('clinicrme_app', 'app.integration_connection', 'DELETE') as d`)).toEqual([{ d: false }]);
  });

  test('J02 uji koneksi: berhasil, kredensial ditolak, Organization tidak ditemukan — hasil tersimpan & teraudit', async () => {
    const t = await send('post', '/api/v1/integrations/satusehat/test', admin).send({ facilityId: FACILITY });
    expect(t.body).toMatchObject({ ok: true, environment: 'SIMULATOR', message: 'Terhubung ke SATUSEHAT simulator — Organisasi Simulasi 10000004' });
    await configure({ ...sim, clientSecret: 'ditolak' });
    expect((await send('post', '/api/v1/integrations/satusehat/test', admin).send({ facilityId: FACILITY })).body)
      .toMatchObject({ ok: false, message: 'Client ID / client secret ditolak SATUSEHAT (simulator)' });
    await configure({ ...sim, organizationId: 'X-salah' });
    expect((await send('post', '/api/v1/integrations/satusehat/test', admin).send({ facilityId: FACILITY })).body)
      .toMatchObject({ ok: false, message: 'Organization ID tidak ditemukan di SATUSEHAT' });
    await configure(sim);
    await send('post', '/api/v1/integrations/satusehat/test', admin).send({ facilityId: FACILITY });
    const ov = (await get('/api/v1/integrations/satusehat', admin)).body;
    expect(ov.facilities.find((f: { facilityId: string }) => f.facilityId === FACILITY).connection).toMatchObject({ lastTestOk: true });
    expect(await su(`select change_summary->>'ok' as ok from app.audit_log where action = 'SATUSEHAT_CONNECTION_TESTED' order by seq`))
      .toEqual([{ ok: 'true' }, { ok: 'false' }, { ok: 'false' }, { ok: 'true' }]);
    expect((await send('post', '/api/v1/integrations/satusehat/test', adminB).send({ facilityId: FACILITY })).body.code).toBe('INT-404-CONNECTION');
  });
});

describe('Sinkron master & lookup IHS (INT-FR-002, 003; OD-116, OD-117)', () => {
  test('J03 Location per poli/ruang dibuat sekali (idempoten); IHS tenaga kesehatan dari NIK; nakes tanpa NIK dilaporkan', async () => {
    await su(`update app.practitioner set nik_encrypted = $2, nik_hash = $3 where id = $1`, [DR, encrypt(KEY, '3171010101900001'), blindIndex(KEY, 'practitioner-nik', '3171010101900001')]);
    await su(`insert into app.practitioner(tenant_id, full_name, practitioner_type, nik_encrypted, nik_hash) values ($1, 'drg. Tidak Terdaftar', 'DOKTER', $2, $3),
              ($1, 'Bidan Tanpa NIK', 'BIDAN', null, null)`, [ids.tenantA, encrypt(KEY, '0000010101900002'), blindIndex(KEY, 'practitioner-nik', '0000010101900002')]);
    const s1 = await send('post', '/api/v1/integrations/satusehat/sync-master', admin).send({ facilityId: FACILITY });
    expect(s1.status).toBe(200);
    expect(s1.body).toMatchObject({ environment: 'SIMULATOR', locations: { created: 2, existing: 0, failed: 0 }, practitioners: { found: 1, notFound: 1, noNik: 1, failed: 0 } });
    const [{ ihs: drIhs }] = await su(`select satusehat_ihs_id as ihs from app.practitioner where id = $1`, [DR]);
    expect(drIhs).toMatch(/^1\d{10}$/);
    const recs = await su(`select local_id, satusehat_id, status from app.fhir_sync_record where resource_type = 'Location' order by local_id`);
    expect(recs).toHaveLength(2);
    expect(recs.every((r: { status: string; satusehat_id: string }) => r.status === 'SENT' && /^[0-9a-f-]{36}$/.test(r.satusehat_id))).toBe(true);
    const s2 = await send('post', '/api/v1/integrations/satusehat/sync-master', admin).send({ facilityId: FACILITY });
    expect(s2.body).toMatchObject({ locations: { created: 0, existing: 2, failed: 0 }, practitioners: { found: 0, notFound: 1, noNik: 1 } });
    expect(await su(`select local_id, satusehat_id, status from app.fhir_sync_record where resource_type = 'Location' order by local_id`)).toEqual(recs);
    const ov = (await get('/api/v1/integrations/satusehat', admin)).body;
    const f = ov.facilities.find((x: { facilityId: string }) => x.facilityId === FACILITY);
    expect(f.locations.map((l: { unitName: string; status: string }) => [l.unitName, l.status]).sort()).toEqual([['Poli Gigi', 'SENT'], ['Poli Umum', 'SENT']].sort());
    expect(ov.identity).toMatchObject({ practitionersFound: 1 });
    expect((await send('post', '/api/v1/integrations/satusehat/sync-master', kasir).send({ facilityId: FACILITY })).status).toBe(403);
    expect(await su(`select change_summary->'locations'->>'created' as c from app.audit_log where action = 'SATUSEHAT_MASTER_SYNCED' order by seq`))
      .toEqual([{ c: '2' }, { c: '0' }]);
  });

  test('J04 lookup IHS manual: ditemukan, tidak ditemukan, gangguan (pesan aman), tanpa NIK; NIK tidak tercatat di audit', async () => {
    const pFound = await patient('3171020202900003');
    const pNot = await patient('0000020202900004');
    const pErr = await patient('5000020202900005');
    const pNone = await patient(null);
    const r = await send('post', `/api/v1/patients/${pFound}/ihs-lookup`, daftar).send();
    expect(r.body).toMatchObject({ ihsStatus: 'FOUND', environment: 'SIMULATOR', error: null });
    expect(r.body.ihsNumber).toMatch(/^P\d{10}$/);
    expect(await ihs(pFound)).toMatchObject({ ihs_status: 'FOUND', ihs_number: r.body.ihsNumber });
    expect((await send('post', `/api/v1/patients/${pNot}/ihs-lookup`, daftar).send()).body).toMatchObject({ ihsStatus: 'NOT_FOUND', error: 'NIK tidak ditemukan di SATUSEHAT' });
    expect((await send('post', `/api/v1/patients/${pErr}/ihs-lookup`, daftar).send()).body).toMatchObject({ ihsStatus: 'ERROR', error: 'SATUSEHAT sementara gagal (HTTP 503)' });
    expect((await send('post', `/api/v1/patients/${pNone}/ihs-lookup`, daftar).send()).body.code).toBe('INT-409-NO-NIK');
    expect((await send('post', `/api/v1/patients/${pFound}/ihs-lookup`, kasir).send()).status).toBe(403);
    expect((await send('post', `/api/v1/patients/${pFound}/ihs-lookup`, adminB).send()).status).toBe(403);
    const a = await su(`select change_summary::text as s from app.audit_log where action = 'PATIENT_IHS_LOOKUP' and resource_id = $1`, [pFound]);
    expect(a).toHaveLength(1);
    expect(a[0].s).not.toContain('3171020202900003');
  });

  test('J05 worker: PENDING dicari segera, gagal diulang sehari sekali, > 7 hari & dibatasi dilewati; klinik tanpa koneksi diabaikan', async () => {
    const p1 = await patient('3171030303900006');
    const p2 = await patient('0000030303900007');
    const old = await patient('3171030303900008', { createdDaysAgo: 8 });
    const restricted = await patient('3171030303900009', { restricted: true });
    await su(`insert into app.patient(tenant_id, mrn, full_name, birth_date, sex, identity_type, nik_encrypted, nik_hash, ihs_status)
              values ($1, 'RM-IT-B1', 'Pasien B', '1990-01-01', 'L', 'NIK', $2, 'hash-b-it', 'PENDING')`, [ids.tenantB, encrypt(KEY, '3171030303900010')]);
    const r = await lookupPendingIhs(pool, { keyHex: KEY });
    expect(r).toMatchObject({ tenants: 1, failedTenants: 0 });
    expect(await ihs(p1)).toMatchObject({ ihs_status: 'FOUND' });
    expect(await ihs(p2)).toMatchObject({ ihs_status: 'NOT_FOUND' });
    expect(await ihs(old)).toMatchObject({ ihs_status: 'PENDING' });
    expect(await ihs(restricted)).toMatchObject({ ihs_status: 'PENDING' });
    expect(await su(`select ihs_status from app.patient where mrn = 'RM-IT-B1'`)).toEqual([{ ihs_status: 'PENDING' }]);
    // Langsung dijalankan lagi: yang gagal belum diulang; 25 jam kemudian diulang
    const again = await lookupPendingIhs(pool, { keyHex: KEY });
    expect(again.checked).toBe(0);
    const later = await lookupPendingIhs(pool, { keyHex: KEY, now: new Date(Date.now() + 25 * 3600_000) });
    expect(later.checked).toBeGreaterThanOrEqual(1);
    expect(await su(`select actor_kind, change_summary->>'status' as s from app.audit_log where action = 'PATIENT_IHS_LOOKUP' and resource_id = $1 order by seq`, [p2]))
      .toEqual([{ actor_kind: 'SYSTEM', s: 'NOT_FOUND' }, { actor_kind: 'SYSTEM', s: 'NOT_FOUND' }]);
    // Di produksi koneksi simulator diabaikan
    expect((await lookupPendingIhs(pool, { keyHex: KEY, allowSimulator: false })).tenants).toBe(0);
    // Kredensial ditolak → klinik itu gagal, tidak menghentikan job
    await configure({ ...sim, clientSecret: 'ditolak' });
    await patient('3171030303900011');
    expect(await lookupPendingIhs(pool, { keyHex: KEY })).toMatchObject({ failedTenants: 1, tenants: 0 });
    await configure(sim);
  });

  test('J06 ganti lingkungan: koneksi lama nonaktif, IHS pasien & nakes direset untuk dicari ulang; simpan kembali memakai secret tersimpan', async () => {
    expect((await su(`select count(*)::int as n from app.patient where ihs_status = 'FOUND'`))[0].n).toBeGreaterThan(0);
    const before = (await su(`select count(*)::int as n from app.patient where identity_type = 'NIK' and ihs_status <> 'PENDING' and tenant_id = $1`, [ids.tenantA]))[0].n;
    const sb = await configure({ ...sim, environment: 'SANDBOX', clientSecret: undefined });
    expect(sb.body.code).toBe('INT-400-SECRET');
    const s = await configure({ ...sim, environment: 'SANDBOX', clientId: 'client-sandbox-01', clientSecret: 'rahasia-sandbox-uji' });   // pragma: allowlist secret
    expect(s.body).toMatchObject({ environment: 'SANDBOX', hasSecret: true });
    expect(await su(`select environment, is_active from app.integration_connection where facility_id = $1 order by environment`, [FACILITY]))
      .toEqual([{ environment: 'SANDBOX', is_active: true }, { environment: 'SIMULATOR', is_active: false }]);
    expect(await su(`select count(*)::int as n from app.patient where ihs_status = 'FOUND'`)).toEqual([{ n: 0 }]);
    expect(await su(`select count(*)::int as n from app.practitioner where satusehat_ihs_id is not null`)).toEqual([{ n: 0 }]);
    const [a] = await su(`select change_summary->>'switchedFrom' as f, (change_summary->'reset'->>'patients')::int as p from app.audit_log
                           where action = 'SATUSEHAT_CONNECTION_SAVED' order by seq desc limit 1`);
    expect(a).toEqual({ f: 'SIMULATOR', p: before });
    // Kembali ke simulator tanpa mengetik ulang secret (tersimpan di baris simulator)
    expect((await configure({ ...sim, clientSecret: undefined })).body).toMatchObject({ environment: 'SIMULATOR' });
    expect(await su(`select environment from app.integration_connection where facility_id = $1 and is_active`, [FACILITY])).toEqual([{ environment: 'SIMULATOR' }]);
  });
});
