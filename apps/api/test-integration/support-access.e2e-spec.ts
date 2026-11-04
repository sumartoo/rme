import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client, Pool } from 'pg';
import { Mail, dispatchNotifications } from '@clinicrme/db/notifications';
import { createApp } from '../src/app/create-app';
import { PASSWORD, appUrl, ids, ownerUrl, platformUrl, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';
import { freshTotp } from './support/totp';

/**
 * Break-glass akses dukungan (PLT-FR-009, OD-076, OD-077) dan notifikasi email lewat outbox (Stage 5 batch 3b).
 * Pengirim email diganti penangkap; worker disimulasikan dengan memanggil dispatcher yang sama dengan koneksi pemilik skema.
 */
const ADMIN_HOST = 'admin.clinicrme.test';
let app: INestApplication;
let http: ReturnType<typeof request>;
let workerPool: Pool;
const sent: Mail[] = [];
const capture = async (m: Mail) => { sent.push(m); };
const NOTIFY = { clinicUrlTemplate: 'https://{code}.clinicrme.test' };

type Jar = Record<string, string>;
const jarFrom = (res: request.Response, prev: Jar = {}): Jar => {
  const jar = { ...prev };
  for (const c of ([] as string[]).concat(res.headers['set-cookie'] ?? [])) { const [k, v] = c.split(';')[0].split('='); if (v) jar[k] = v; else delete jar[k]; }
  return jar;
};
const cookie = (j: Jar) => Object.entries(j).map(([k, v]) => `${k}=${v}`).join('; ');
const p = {
  get: (path: string, j: Jar) => http.get(path).set('Host', ADMIN_HOST).set('Cookie', cookie(j)),
  post: (path: string, j: Jar, body?: object) => {
    const r = http.post(path).set('Host', ADMIN_HOST).set('Cookie', cookie(j)).set('x-csrf-token', j.crme_pcsrf ?? '');
    return body === undefined ? r : r.send(body);
  },
};
async function session(email: string): Promise<Jar> {
  const l = await http.post('/api/platform/v1/auth/login').set('Host', ADMIN_HOST).send({ email, password: PASSWORD });
  const jar = jarFrom(l);
  const e = await p.post('/api/platform/v1/auth/mfa/enroll', jar);
  const secret = new URL(e.body.otpauthUrl).searchParams.get('secret')!;
  const v = await p.post('/api/platform/v1/auth/mfa/verify', jar, { code: await freshTotp(secret) });
  expect(v.status).toBe(204);
  return jarFrom(v, jar);
}

let admin: Jar, support: Jar, support2: Jar, grantId: string;
beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  workerPool = new Pool({ connectionString: ownerUrl(), max: 2 });
  admin = await session('admin@platform.test');
  support = await session('support@platform.test');
  support2 = await session('support2@platform.test');
  // Riwayat audit sintetis tenant A agar paginasi keyset punya isi (data sintetis saja).
  await su(`begin; select set_config('app.tenant_id', $1, true), set_config('app.user_id', '', true);
    select app.write_audit('TENANT_PROFILE_UPDATED', 'tenant', $1::uuid, null, '{}'::jsonb, 'SYSTEM', null, null);
    select app.write_audit('TENANT_EXPORT_REQUESTED', 'tenant', $1::uuid, null, '{}'::jsonb, 'SYSTEM', null, null);
    commit;`.replace(/\$1/g, `'${ids.tenantA}'`));
});
afterAll(async () => { await app?.close(); await workerPool?.end(); });

describe('Break-glass: pemberian akses (PLT-FR-009)', () => {
  test('B01 hanya PLATFORM_SUPPORT, alasan ≥ 10 karakter, durasi 15–480 menit; tenant tak dikenal 404', async () => {
    const body = { tenantId: ids.tenantA, reason: 'Tiket #123: admin klinik tidak bisa login', durationMinutes: 60 };
    expect((await p.post('/api/platform/v1/support-access', admin, body)).status).toBe(403);
    expect((await p.post('/api/platform/v1/support-access', support, { ...body, reason: 'singkat' })).status).toBe(400);
    expect((await p.post('/api/platform/v1/support-access', support, { ...body, durationMinutes: 481 })).status).toBe(400);
    expect((await p.post('/api/platform/v1/support-access', support, { ...body, tenantId: '00000000-0000-0000-0000-000000000000' })).status).toBe(404);
    const r = await p.post('/api/platform/v1/support-access', support, body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ tenantId: ids.tenantA, tenantCode: 'klinik-a', active: true, supportName: 'Support Platform' });
    const minutes = (new Date(r.body.expiresAt).getTime() - new Date(r.body.startsAt).getTime()) / 60_000;
    expect(Math.round(minutes)).toBe(60);
    grantId = r.body.id;
    expect((await p.post('/api/platform/v1/support-access', support, body)).body.code).toBe('PLT-409-GRANT-ACTIVE');
  });

  test('B02 teraudit di rantai tenant (PLATFORM_SUPPORT) & platform; event email masuk outbox tanpa data pribadi', async () => {
    const [a] = await su(`select actor_kind, actor_user_id, change_summary from app.audit_log where tenant_id = $1 and action = 'SUPPORT_ACCESS_GRANTED'`, [ids.tenantA]);
    expect(a).toMatchObject({ actor_kind: 'PLATFORM_SUPPORT', actor_user_id: ids.platformSupport, change_summary: { durationMinutes: 60 } });
    const [pa] = await su(`select count(*)::int n from app.platform_audit_log where action = 'SUPPORT_ACCESS_GRANTED' and resource_id = $1`, [grantId]);
    expect(pa.n).toBe(1);
    const [o] = await su(`select status, payload from app.outbox_event where aggregate_id = $1 and event_type = 'SUPPORT_ACCESS_GRANTED'`, [grantId]);
    expect(o).toEqual({ status: 'PENDING', payload: {} });
    const [chain] = await su(`select ok from app.verify_audit_chain($1)`, [ids.tenantA]);
    expect(chain.ok).toBe(true);
  });
});

describe('Break-glass: selama akses berlaku (OD-077)', () => {
  test('B03 support membaca user & role tenant (tanpa kredensial); setiap pembacaan teraudit', async () => {
    const r = await p.get(`/api/platform/v1/support-access/${grantId}/users`, support);
    expect(r.status).toBe(200);
    const adminA = r.body.find((u: { email: string }) => u.email === 'admin@a.test');
    expect(adminA).toMatchObject({ status: 'ACTIVE', roles: ['TENANT_ADMIN'] });
    expect(JSON.stringify(r.body)).not.toMatch(/argon2|password|totp|token/i);
    expect(r.body.every((u: { email: string }) => !u.email.endsWith('@b.test'))).toBe(true);     // hanya tenant A
    const [a] = await su(`select count(*)::int n from app.audit_log where tenant_id = $1 and action = 'SUPPORT_VIEWED_USERS' and actor_kind = 'PLATFORM_SUPPORT'`, [ids.tenantA]);
    expect(a.n).toBe(1);
  });

  test('B04 support membaca log audit (tanpa patient_id/IP), keyset mundur; pembacaan support sendiri tidak membanjiri hasil', async () => {
    const r = await p.get(`/api/platform/v1/support-access/${grantId}/audit-log?limit=2`, support);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
    expect(Object.keys(r.body.data[0]).sort()).toEqual(['action', 'actorKind', 'actorUserId', 'occurredAt', 'resourceId', 'resourceType', 'seq']);
    expect(r.body.data.map((x: { action: string }) => x.action)).not.toContain('SUPPORT_VIEWED_USERS');
    const next = await p.get(`/api/platform/v1/support-access/${grantId}/audit-log?limit=2&cursor=${r.body.page.nextCursor}`, support);
    expect(next.body.data[0].seq).toBeLessThan(r.body.data[1].seq);
    expect((await p.get(`/api/platform/v1/support-access/${grantId}/audit-log?limit=999`, support)).status).toBe(400);
  });

  test('B05 grant milik support lain & admin platform tidak dapat dipakai untuk membaca', async () => {
    const other = await p.get(`/api/platform/v1/support-access/${grantId}/users`, support2);
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('PLT-403-GRANT');
    expect((await p.get(`/api/platform/v1/support-access/${grantId}/users`, admin)).status).toBe(403);   // tanpa platform.support.access
  });

  test('B06 grant kedaluwarsa → 403 PLT-403-GRANT (ditegakkan di database pada setiap panggilan)', async () => {
    await su(`update app.support_access_grant set starts_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where id = $1`, [grantId]);
    const r = await p.get(`/api/platform/v1/support-access/${grantId}/audit-log`, support);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PLT-403-GRANT');
    expect((await p.get(`/api/platform/v1/support-access/${grantId}/users`, support)).status).toBe(403);
    const list = await p.get(`/api/platform/v1/support-access?tenantId=${ids.tenantA}`, support);
    expect(list.body.find((g: { id: string }) => g.id === grantId).active).toBe(false);
  });

  test('B07 cabut: pemilik atau admin platform; setelah dicabut tidak dapat dipakai; teraudit + email', async () => {
    const g2 = await p.post('/api/platform/v1/support-access', support, { tenantId: ids.tenantA, reason: 'Tiket #124: cek role kasir', durationMinutes: 30 });
    expect(g2.status).toBe(201);
    expect((await p.post(`/api/platform/v1/support-access/${g2.body.id}/revoke`, support2)).status).toBe(403);
    const r = await p.post(`/api/platform/v1/support-access/${g2.body.id}/revoke`, support);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ active: false });
    expect((await p.get(`/api/platform/v1/support-access/${g2.body.id}/users`, support)).status).toBe(403);
    expect((await p.post(`/api/platform/v1/support-access/${g2.body.id}/revoke`, support)).body.code).toBe('PLT-409-GRANT-INACTIVE');
    const g3 = await p.post('/api/platform/v1/support-access', support2, { tenantId: ids.tenantA, reason: 'Tiket #125: verifikasi audit', durationMinutes: 15 });
    expect((await p.post(`/api/platform/v1/support-access/${g3.body.id}/revoke`, admin)).status).toBe(200);    // admin mengawasi
    const [a] = await su(`select count(*)::int n from app.audit_log where tenant_id = $1 and action = 'SUPPORT_ACCESS_REVOKED'`, [ids.tenantA]);
    expect(a.n).toBe(2);
    const adminList = await p.get('/api/platform/v1/support-access', admin);
    expect(adminList.body.length).toBeGreaterThanOrEqual(3);                       // admin melihat semua
    const mine = await p.get('/api/platform/v1/support-access', support2);
    expect(mine.body.every((g: { platformUserId: string }) => g.platformUserId === ids.platformSupport2)).toBe(true);
  });

  test('B08 grant tidak membuka tabel klinis: role DB platform tetap ditolak; aplikasi klinik tidak dapat memakai fungsi support', async () => {
    const plat = new Client({ connectionString: platformUrl() });
    const appc = new Client({ connectionString: appUrl() });
    await plat.connect(); await appc.connect();
    try {
      const g = await p.post('/api/platform/v1/support-access', support2, { tenantId: ids.tenantB, reason: 'Tiket #126: uji isolasi', durationMinutes: 15 });
      await plat.query('begin');
      await plat.query(`select * from app.support_read_users($1, $2)`, [g.body.id, ids.platformSupport2]);   // sah
      await expect(plat.query(`select 1 from app.patient limit 1`)).rejects.toMatchObject({ code: '42501' });  // tenant context sudah terpasang, tetap ditolak
      await plat.query('rollback');
      await appc.query(`select set_config('app.tenant_id', $1, false)`, [ids.tenantB]);
      await expect(appc.query(`select * from app.support_read_users($1, $2)`, [g.body.id, ids.platformSupport2])).rejects.toMatchObject({ code: '42501' });
      await expect(appc.query(`select app.enqueue_support_notification($1, 'SUPPORT_ACCESS_GRANTED')`, [g.body.id])).rejects.toMatchObject({ code: '42501' });
      await expect(appc.query(`select 1 from app.support_access_grant`)).rejects.toMatchObject({ code: '42501' });
    } finally { await plat.end(); await appc.end(); }
  });
});

describe('Notifikasi email (outbox → worker → SMTP)', () => {
  test('N01 break-glass dibuka/ditutup → satu email per tenant admin aktif, isi menjelaskan cakupan & alasan', async () => {
    sent.length = 0;
    const r = await dispatchNotifications(workerPool, capture, NOTIFY);
    expect(r.failed).toBe(0);
    const toA = sent.filter((m) => m.to === 'admin@a.test');
    const opened = toA.filter((m) => m.subject.includes('Akses dukungan dibuka'));
    expect(opened).toHaveLength(3);
    expect(opened[0].text).toContain('Data pasien & rekam medis TIDAK dapat dibuka');
    expect(opened.some((m) => m.text.includes('Tiket #123: admin klinik tidak bisa login'))).toBe(true);
    expect(toA.filter((m) => m.subject.includes('ditutup'))).toHaveLength(2);
    expect(sent.filter((m) => m.to === 'admin@b.test' && m.subject.includes('dibuka'))).toHaveLength(1);
    expect(sent.some((m) => m.to.endsWith('@a.test') && m.to !== 'admin@a.test')).toBe(false);   // hanya tenant admin
    const [o] = await su(`select count(*) filter (where status = 'DONE')::int done, count(*) filter (where status = 'PENDING')::int pending
                            from app.outbox_event where event_type like 'SUPPORT_%'`);
    expect(o).toEqual({ done: 6, pending: 0 });
    // Dijalankan lagi: tidak ada email ganda
    sent.length = 0;
    await dispatchNotifications(workerPool, capture, NOTIFY);
    expect(sent).toHaveLength(0);
  });

  test('N02 tenant baru → email undangan ke admin klinik dengan alamat klinik; gagal kirim diulang lalu FAILED', async () => {
    const plans = await p.get('/api/platform/v1/plans', admin);
    const t = await p.post('/api/platform/v1/tenants', admin, { code: 'klinik-surel', legalName: 'PT Klinik Surel (sintetis)', tenantType: 'KLINIK_PRATAMA',
                                                               planId: plans.body[0].id, adminEmail: 'Pemilik@Surel.test' });
    expect(t.status).toBe(201);
    sent.length = 0;
    await dispatchNotifications(workerPool, capture, NOTIFY);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'pemilik@surel.test', subject: 'Undangan ClinicRME — PT Klinik Surel (sintetis)' });
    expect(sent[0].text).toContain('https://klinik-surel.clinicrme.test');
    expect(sent[0].text).toContain('Masuk dengan Google');

    // SMTP gagal: event kembali PENDING (attempts naik) sampai batas, lalu FAILED
    const t2 = await p.post('/api/platform/v1/tenants', admin, { code: 'klinik-gagal', legalName: 'PT Gagal', tenantType: 'KLINIK_PRATAMA',
                                                                planId: plans.body[0].id, adminEmail: 'x@gagal.test' });
    const failing = async () => { throw new Error('SMTP mati'); };
    for (let i = 0; i < 4; i++) expect((await dispatchNotifications(workerPool, failing, NOTIFY)).retry).toBe(1);
    expect((await dispatchNotifications(workerPool, failing, NOTIFY)).failed).toBe(1);
    const [o] = await su(`select status, attempts from app.outbox_event where tenant_id = $1 and event_type = 'INVITATION_CREATED'`, [t2.body.id]);
    expect(o).toEqual({ status: 'FAILED', attempts: 5 });
  });

  test('N03 tenant tanpa admin aktif: event selesai tetapi dilaporkan noRecipient (worker memberi peringatan)', async () => {
    await su(`update app.app_user set status = 'DISABLED' where id = $1`, [ids.adminB]);
    const [g] = await su<{ id: string }>(`insert into app.support_access_grant(tenant_id, platform_user, reason, starts_at, expires_at)
      values ($1, $2, 'Tiket #777: tenant tanpa admin', now(), now() + interval '15 minutes') returning id`, [ids.tenantB, ids.platformSupport]);
    await su(`select app.enqueue_support_notification($1, 'SUPPORT_ACCESS_GRANTED')`, [g.id]);
    sent.length = 0;
    expect(await dispatchNotifications(workerPool, capture, NOTIFY)).toEqual({ done: 1, retry: 0, failed: 0, noRecipient: 1 });
    expect(sent).toHaveLength(0);
    await su(`update app.app_user set status = 'ACTIVE' where id = $1`, [ids.adminB]);
  });
});
