import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import { toProblem } from '@clinicrme/shared';
import { TENANT_STATUSES, canTransition } from '@clinicrme/platform';
import { createApp } from '../src/app/create-app';
import { PASSWORD, appUrl, ids, platformUrl, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';
import { freshTotp } from './support/totp';

/**
 * Uji konsol platform (Stage 5 batch 1, CR-0001): identitas & sesi platform, pemisahan host/cookie,
 * provisioning, mesin status tenant, PLT-FR-006 (suspended), feature flag, kuota, pemisahan role DB.
 * Database nyata, role LOGIN aplikasi & platform tanpa BYPASSRLS. Penomoran P## dipakai di laporan & uji mutasi.
 */
const ADMIN_HOST = 'admin.clinicrme.test';
const HOST_A = 'klinik-a.clinicrme.test';
let app: INestApplication;
let http: ReturnType<typeof request>;

type Jar = Record<string, string>;
function jarFrom(res: request.Response, prev: Jar = {}): Jar {
  const jar = { ...prev };
  for (const c of ([] as string[]).concat(res.headers['set-cookie'] ?? [])) {
    const [kv] = c.split(';');
    const [k, v] = kv.split('=');
    if (v) jar[k] = v; else delete jar[k];
  }
  return jar;
}
const cookie = (j: Jar) => Object.entries(j).map(([k, v]) => `${k}=${v}`).join('; ');
const rawCookies = (res: request.Response) => ([] as string[]).concat(res.headers['set-cookie'] ?? []);

/** Request ke konsol platform dengan cookie + header CSRF dari jar. */
const p = {
  get: (path: string, j: Jar = {}) => http.get(path).set('Host', ADMIN_HOST).set('Cookie', cookie(j)),
  post: (path: string, j: Jar = {}, body?: object) => {
    const r = http.post(path).set('Host', ADMIN_HOST).set('Cookie', cookie(j)).set('x-csrf-token', j.crme_pcsrf ?? '');
    return body === undefined ? r : r.send(body);
  },
  put: (path: string, j: Jar, body: object) =>
    http.put(path).set('Host', ADMIN_HOST).set('Cookie', cookie(j)).set('x-csrf-token', j.crme_pcsrf ?? '').send(body),
};

async function platformLogin(email: string, password = PASSWORD) {
  const res = await http.post('/api/platform/v1/auth/login').set('Host', ADMIN_HOST).send({ email, password });
  return { res, jar: jarFrom(res) };
}

const secrets: Record<string, string> = {};
/** Login + (daftar bila perlu) + verifikasi TOTP → jar sesi terverifikasi MFA. */
async function platformSession(email: string): Promise<Jar> {
  const { res, jar } = await platformLogin(email);
  expect(res.status).toBe(200);
  if (!secrets[email]) {
    const e = await p.post('/api/platform/v1/auth/mfa/enroll', jar);
    expect(e.status).toBe(200);
    secrets[email] = new URL(e.body.otpauthUrl).searchParams.get('secret')!;
  }
  const v = await p.post('/api/platform/v1/auth/mfa/verify', jar, { code: await freshTotp(secrets[email]) });
  expect(v.status).toBe(204);
  return jarFrom(v, jar);
}

let admin: Jar;
let pilotPlanId: string;
async function createTenant(code: string, extra: object = {}) {
  return p.post('/api/platform/v1/tenants', admin, {
    code, legalName: `PT ${code} (sintetis)`, tenantType: 'KLINIK_PRATAMA', planId: pilotPlanId, adminEmail: `Admin@${code}.test`, ...extra,
  });
}
const tenantLogin = (host: string, email: string) =>
  http.post('/api/v1/auth/login').set('Host', host).send({ email, password: PASSWORD });

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
});
afterAll(async () => { await app?.close(); });

describe('Identitas & sesi platform (CR-0001, IAM-FR-005)', () => {
  test('P01 login platform → cookie crme_psession HttpOnly/Secure/SameSite=Strict; sebelum TOTP hanya /me & langkah MFA', async () => {
    const { res, jar } = await platformLogin('admin@platform.test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mfaEnrolled: false });
    const sc = rawCookies(res).find((c) => c.startsWith('crme_psession='))!;
    expect(sc).toMatch(/HttpOnly/i); expect(sc).toMatch(/Secure/i); expect(sc).toMatch(/SameSite=Strict/i);
    expect(rawCookies(res).some((c) => c.startsWith('crme_session='))).toBe(false);
    const me = await p.get('/api/platform/v1/me', jar);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: 'admin@platform.test', roles: ['PLATFORM_ADMIN'], mfaVerified: false, mfaEnrolled: false });
    const list = await p.get('/api/platform/v1/tenants', jar);
    expect(list.status).toBe(401);
    expect(list.body.code).toBe('AUTH-401-MFA-REQUIRED');
    const [s] = await su(`select count(*)::int n from app.platform_session where token_hash = $1`, [jar.crme_psession]);
    expect(s.n).toBe(0);   // token tidak disimpan mentah
  });

  test('P02 TOTP: daftar → verifikasi → sesi dirotasi (token lama dicabut); TOTP tidak bisa didaftar ulang dengan password saja', async () => {
    const { jar } = await platformLogin('admin@platform.test');
    const e = await p.post('/api/platform/v1/auth/mfa/enroll', jar);
    expect(e.status).toBe(200);
    expect(e.body.recoveryCodes).toHaveLength(8);
    secrets['admin@platform.test'] = new URL(e.body.otpauthUrl).searchParams.get('secret')!;
    const v = await p.post('/api/platform/v1/auth/mfa/verify', jar, { code: await freshTotp(secrets['admin@platform.test']) });
    expect(v.status).toBe(204);
    admin = jarFrom(v, jar);
    expect(admin.crme_psession).not.toBe(jar.crme_psession);
    expect((await p.get('/api/platform/v1/tenants', jar)).status).toBe(401);     // sesi lama dicabut
    expect((await p.get('/api/platform/v1/tenants', admin)).status).toBe(200);
    const [m] = await su(`select totp_secret_encrypted::text like '%' || $1 || '%' as plain from app.platform_mfa where user_id = $2`,
                         [secrets['admin@platform.test'], ids.platformAdmin]);
    expect(m.plain).toBe(false);                                                   // secret terenkripsi

    const again = await platformLogin('admin@platform.test');
    const re = await p.post('/api/platform/v1/auth/mfa/enroll', again.jar);
    expect(re.status).toBe(409);
    expect(re.body.code).toBe('AUTH-409-MFA-ENROLLED');
    const plans = await p.get('/api/platform/v1/plans', admin);
    expect(plans.status).toBe(200);
    pilotPlanId = plans.body.find((x: { code: string }) => x.code === 'PILOT').id;
  });

  test('P03 password salah & email tak dikenal → respons identik; tercatat di platform_audit_log; lockout setelah 5×', async () => {
    const a = await platformLogin('tidakada@platform.test', 'x');
    const b = await platformLogin('support@platform.test', 'salah');
    expect(a.res.status).toBe(401); expect(b.res.status).toBe(401);
    expect(a.res.body).toEqual(b.res.body);
    for (let i = 0; i < 4; i++) await platformLogin('support@platform.test', 'salah');
    expect((await platformLogin('support@platform.test')).res.status).toBe(401);          // terkunci
    const audits = await su(`select change_summary->>'reason' r from app.platform_audit_log
                              where action = 'PLATFORM_LOGIN_FAILED' and actor_platform_user = $1`, [ids.platformSupport]);
    expect(audits.filter((x) => x.r === 'bad_password')).toHaveLength(5);
    expect(audits.some((x) => x.r === 'locked')).toBe(true);
    await su(`update app.platform_credential set locked_until = null, failed_attempts = 0 where user_id = $1`, [ids.platformSupport]);
  });

  test('P04 pemisahan host & cookie: endpoint platform tidak ada di host klinik, endpoint klinik tidak ada di host admin', async () => {
    expect((await http.post('/api/platform/v1/auth/login').set('Host', HOST_A)
      .send({ email: 'admin@platform.test', password: PASSWORD })).status).toBe(404);
    expect((await http.get('/api/platform/v1/tenants').set('Host', HOST_A).set('Cookie', cookie(admin))).status).toBe(404);
    expect((await http.post('/api/v1/auth/login').set('Host', ADMIN_HOST).send({ email: 'dokter@a.test', password: PASSWORD })).status).toBe(404);
    // Sesi klinik tidak berlaku di konsol, dan token platform tidak berlaku sebagai sesi klinik
    const t = await tenantLogin(HOST_A, 'dokter@a.test');
    const tj = jarFrom(t);
    expect((await p.get('/api/platform/v1/me', tj)).status).toBe(401);
    expect((await http.get('/api/v1/me').set('Host', HOST_A).set('Cookie', `crme_session=${admin.crme_psession}`)).status).toBe(401);
    expect((await http.get('/api/v1/me').set('Host', ADMIN_HOST).set('Cookie', cookie(tj))).status).toBe(404);
  });

  test('P05 CSRF wajib untuk perubahan di konsol platform', async () => {
    const r = await http.post('/api/platform/v1/tenants').set('Host', ADMIN_HOST).set('Cookie', cookie(admin)).send({});
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('AUTH-403-CSRF');
  });

  test('P06 PLATFORM_SUPPORT hanya membaca: daftar/detail boleh, buat/ubah status/flag ditolak', async () => {
    const sup = await platformSession('support@platform.test');
    expect((await p.get('/api/platform/v1/tenants', sup)).status).toBe(200);
    expect((await p.get(`/api/platform/v1/tenants/${ids.tenantA}`, sup)).status).toBe(200);
    const c = await p.post('/api/platform/v1/tenants', sup, { code: 'tidak-boleh', legalName: 'PT X', tenantType: 'KLINIK_PRATAMA',
                                                              planId: pilotPlanId, adminEmail: 'x@x.test' });
    expect(c.status).toBe(403);
    expect(c.body.code).toBe('IAM-403-FORBIDDEN');
    expect((await p.post(`/api/platform/v1/tenants/${ids.tenantA}/status`, sup, { status: 'SUSPENDED', reason: 'uji' })).status).toBe(403);
    expect((await p.put(`/api/platform/v1/tenants/${ids.tenantA}/feature-flags/lab`, sup, { enabled: false })).status).toBe(403);
  });
});

describe('Provisioning & status tenant (PLT-FR-001/003/005/013)', () => {
  test('P07 mesin status di kode sama persis dengan aturan di database (36 pasangan)', async () => {
    const db = await su(`select f, t, app.tenant_status_transition_allowed(f, t) ok
                           from unnest($1::text[]) f cross join unnest($1::text[]) t`, [TENANT_STATUSES]);
    expect(db).toHaveLength(36);
    for (const r of db) expect([r.f, r.t, r.ok]).toEqual([r.f, r.t, canTransition(r.f, r.t)]);
  });

  test('P08 buat tenant → TRIAL + langganan + 8 role template + undangan admin + audit tenant (PLATFORM) & platform', async () => {
    const r = await createTenant('klinik-baru', { trialDays: 14 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ code: 'klinik-baru', status: 'TRIAL', plan: { code: 'PILOT' }, featureFlags: {},
                                 allowedTransitions: ['ACTIVE', 'GRACE', 'SUSPENDED'] });
    const days = (new Date(r.body.trialEndsAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9); expect(days).toBeLessThanOrEqual(14);
    const id = r.body.id;
    const [roles] = await su(`select count(*)::int n from app.role where tenant_id = $1 and is_template`, [id]);
    expect(roles.n).toBe(8);
    const [inv] = await su(`select i.email, r.code, i.expires_at > now() + interval '6 days' as week, length(i.token_hash) as hl
                              from app.user_invitation i join app.role r on r.id = any(i.role_ids) where i.tenant_id = $1`, [id]);
    expect(inv).toEqual({ email: 'admin@klinik-baru.test', code: 'TENANT_ADMIN', week: true, hl: 64 });
    expect(JSON.stringify(r.body)).not.toMatch(/token/i);            // token undangan tidak pernah ke pengguna platform
    const hist = await su(`select from_status, to_status from app.tenant_status_history where tenant_id = $1 order by occurred_at, to_status`, [id]);
    expect(hist).toEqual([{ from_status: null, to_status: 'PROVISIONING' }, { from_status: 'PROVISIONING', to_status: 'TRIAL' }]);
    const [aud] = await su(`select actor_kind, actor_user_id from app.audit_log where tenant_id = $1 and action = 'TENANT_PROVISIONED'`, [id]);
    expect(aud).toEqual({ actor_kind: 'PLATFORM', actor_user_id: ids.platformAdmin });
    const [chain] = await su(`select ok from app.verify_audit_chain($1)`, [id]);
    expect(chain.ok).toBe(true);
    const [pa] = await su(`select count(*)::int n from app.platform_audit_log where action = 'TENANT_PROVISIONED' and target_tenant_id = $1`, [id]);
    expect(pa.n).toBe(1);
    // Subdomain baru langsung dilayani (login gagal 401, bukan 404 tenant tidak dikenal)
    expect((await tenantLogin('klinik-baru.clinicrme.test', 'siapa@klinik-baru.test')).status).toBe(401);
  });

  test('P09 validasi pembuatan: kode ganda 409, kode tercadang 400, paket tak dikenal 400, field asing 400', async () => {
    const dup = await createTenant('klinik-baru');
    expect(dup.status).toBe(409); expect(dup.body.code).toBe('PLT-409-CODE');
    const reserved = await createTenant('admin');
    expect(reserved.status).toBe(400); expect(reserved.body.code).toBe('PLT-400-CODE-RESERVED');
    const plan = await createTenant('klinik-plan', { planId: '00000000-0000-0000-0000-000000000000' });
    expect(plan.status).toBe(400); expect(plan.body.code).toBe('PLT-400-PLAN');
    expect((await createTenant('klinik-extra', { tenantId: ids.tenantA })).status).toBe(400);
    expect((await createTenant('Klinik Spasi')).status).toBe(400);
    const [n] = await su(`select count(*)::int n from app.tenant where code in ('klinik-plan', 'klinik-extra')`);
    expect(n.n).toBe(0);                                              // gagal = tidak ada sisa (transaksi)
  });

  test('P10 transisi status: tidak sah → 409 dengan daftar yang diizinkan; alasan wajib; sah → histori + audit', async () => {
    const [t] = await su(`select id from app.tenant where code = 'klinik-baru'`);
    const bad = await p.post(`/api/platform/v1/tenants/${t.id}/status`, admin, { status: 'TERMINATED', reason: 'tes langsung' });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('PLT-409-STATUS');
    expect(bad.body.title).toContain('ACTIVE, GRACE, SUSPENDED');
    expect((await p.post(`/api/platform/v1/tenants/${t.id}/status`, admin, { status: 'ACTIVE' })).status).toBe(400);
    expect((await p.post(`/api/platform/v1/tenants/${t.id}/status`, admin, { status: 'ACTIVE', reason: '  ' })).status).toBe(400);
    const ok = await p.post(`/api/platform/v1/tenants/${t.id}/status`, admin, { status: 'ACTIVE', reason: 'Invoice pilot dibayar' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('ACTIVE');
    const [h] = await su(`select from_status, reason, actor_id from app.tenant_status_history where tenant_id = $1 and to_status = 'ACTIVE'`, [t.id]);
    expect(h).toEqual({ from_status: 'TRIAL', reason: 'Invoice pilot dibayar', actor_id: ids.platformAdmin });
    const [a] = await su(`select change_summary from app.audit_log where tenant_id = $1 and action = 'TENANT_STATUS_CHANGED'`, [t.id]);
    expect(a.change_summary).toEqual({ from: 'TRIAL', to: 'ACTIVE', reason: 'Invoice pilot dibayar' });
    // Database tetap penegak terakhir bila kode dilewati
    await expect(su(`update app.tenant set status = 'PROVISIONING' where id = $1`, [t.id])).rejects.toMatchObject({ code: 'CRS01' });
  });
});

describe('Tenant ditangguhkan & dihentikan (PLT-FR-006, PLT-FR-013)', () => {
  let dokterJar: Jar;
  test('P11 SUSPENDED: login user biasa ditolak (TEN-403-SUSPENDED, teraudit); tenant admin tetap bisa login', async () => {
    dokterJar = jarFrom(await tenantLogin(HOST_A, 'dokter@a.test'));          // sesi yang sudah ada sebelum ditangguhkan
    expect((await p.post(`/api/platform/v1/tenants/${ids.tenantA}/status`, admin,
                         { status: 'SUSPENDED', reason: 'Tagihan belum dibayar' })).status).toBe(200);
    const k = await tenantLogin(HOST_A, 'kasir@a.test');
    expect(k.status).toBe(403);
    expect(k.body.code).toBe('TEN-403-SUSPENDED');
    const [aud] = await su(`select count(*)::int n from app.audit_log where tenant_id = $1 and action = 'LOGIN_FAILED'
                              and resource_id = $2 and change_summary->>'reason' = 'tenant_suspended'`, [ids.tenantA, ids.kasirA]);
    expect(aud.n).toBe(1);
    expect((await tenantLogin(HOST_A, 'admin@a.test')).status).toBe(200);
    // Password salah tetap 401 biasa (status tenant tidak dibocorkan sebelum password benar)
    expect((await http.post('/api/v1/auth/login').set('Host', HOST_A).send({ email: 'kasir@a.test', password: 'salah' })).status).toBe(401);   // pragma: allowlist secret — password salah sintetis
  });

  test('P12 SUSPENDED: sesi user biasa yang sudah ada ikut diblokir; pulih saat tenant diaktifkan lagi', async () => {
    const blocked = await http.get('/api/v1/me').set('Host', HOST_A).set('Cookie', cookie(dokterJar));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('TEN-403-SUSPENDED');
    expect((await p.post(`/api/platform/v1/tenants/${ids.tenantA}/status`, admin, { status: 'ACTIVE', reason: 'Tagihan lunas' })).status).toBe(200);
    expect((await http.get('/api/v1/me').set('Host', HOST_A).set('Cookie', cookie(dokterJar))).status).toBe(200);
  });

  test('P13 TERMINATED: hanya dari SUSPENDED, subdomain tidak dilayani (404), data tetap tersimpan, status final', async () => {
    const r = await createTenant('klinik-tutup');
    const id = r.body.id;
    expect(r.body.status).toBe('ACTIVE');                                     // tanpa trial
    expect((await p.post(`/api/platform/v1/tenants/${id}/status`, admin, { status: 'SUSPENDED', reason: 'Kontrak berakhir' })).status).toBe(200);
    expect((await p.post(`/api/platform/v1/tenants/${id}/status`, admin, { status: 'TERMINATED', reason: 'Kontrak berakhir' })).status).toBe(200);
    const login = await tenantLogin('klinik-tutup.clinicrme.test', 'admin@klinik-tutup.test');
    expect(login.status).toBe(404);
    expect(login.body.code).toBe('TEN-404-UNKNOWN');
    const [kept] = await su(`select (select count(*) from app.role where tenant_id = $1)::int roles,
                                    (select count(*) from app.audit_log where tenant_id = $1)::int audits`, [id]);
    expect(kept.roles).toBe(8);
    expect(kept.audits).toBeGreaterThanOrEqual(3);
    const again = await p.post(`/api/platform/v1/tenants/${id}/status`, admin, { status: 'ACTIVE', reason: 'Coba aktifkan' });
    expect(again.status).toBe(409);
    expect(again.body.title).toContain('status final');
    expect((await p.get(`/api/platform/v1/tenants/${id}`, admin)).body).toMatchObject({ status: 'TERMINATED', allowedTransitions: [] });
  });
});

describe('Feature flag, kuota, pemisahan role database', () => {
  test('P14 feature flag: PUT → 204, tampil di detail, teraudit; kode/tenant tidak valid ditolak', async () => {
    const r = await p.put(`/api/platform/v1/tenants/${ids.tenantB}/feature-flags/pharmacy.v2`, admin, { enabled: true });
    expect(r.status).toBe(204);
    expect((await p.put(`/api/platform/v1/tenants/${ids.tenantB}/feature-flags/pharmacy.v2`, admin, { enabled: false })).status).toBe(204);
    const d = await p.get(`/api/platform/v1/tenants/${ids.tenantB}`, admin);
    expect(d.body.featureFlags).toEqual({ 'pharmacy.v2': false });
    const aud = await su(`select change_summary->>'enabled' e from app.audit_log where tenant_id = $1 and action = 'FEATURE_FLAG_CHANGED' order by seq`, [ids.tenantB]);
    expect(aud.map((a) => a.e)).toEqual(['true', 'false']);
    expect((await p.put(`/api/platform/v1/tenants/${ids.tenantB}/feature-flags/Bad%20Code`, admin, { enabled: true })).status).toBe(400);
    expect((await p.put(`/api/platform/v1/tenants/${ids.tenantB}/feature-flags/lab`, admin, { enabled: 'ya' })).status).toBe(400);
    expect((await p.put('/api/platform/v1/tenants/00000000-0000-0000-0000-000000000000/feature-flags/lab', admin, { enabled: true })).status).toBe(404);
    expect((await p.get('/api/platform/v1/tenants/bukan-uuid', admin)).status).toBe(404);
  });

  test('P15 role DB platform tidak dapat membaca tabel klinis; role aplikasi tidak dapat menyentuh tabel/fungsi platform', async () => {
    const plat = new Client({ connectionString: platformUrl() });
    const appc = new Client({ connectionString: appUrl() });
    await plat.connect(); await appc.connect();
    try {
      const denied = async (c: Client, q: string) => {
        await c.query('BEGIN');
        try { await c.query(q); return false; } catch (e) { return (e as { code?: string }).code === '42501'; } finally { await c.query('ROLLBACK'); }
      };
      await plat.query(`select set_config('app.tenant_id', $1, false)`, [ids.tenantA]);   // bahkan dengan tenant context
      for (const t of ['patient', 'clinical_note', 'app_user', 'user_session', 'user_credential', 'audit_log', 'encounter']) {
        expect([t, await denied(plat, `select 1 from app.${t} limit 1`)]).toEqual([t, true]);
      }
      expect(await denied(plat, `update app.tenant_subscription set is_current = is_current where false`)).toBe(false);
      await appc.query(`select set_config('app.tenant_id', $1, false)`, [ids.tenantA]);
      for (const t of ['platform_user', 'platform_credential', 'platform_mfa', 'platform_session', 'platform_audit_log']) {
        expect([t, await denied(appc, `select 1 from app.${t} limit 1`)]).toEqual([t, true]);
      }
      expect(await denied(appc, `select app.provision_tenant('x-y-z','x','', 'KLINIK_PRATAMA', gen_random_uuid(), 0, 'a@b.test', 'h', null)`)).toBe(true);
      expect(await denied(appc, `update app.tenant set status = 'ACTIVE' where id = '${ids.tenantA}'`)).toBe(true);
    } finally { await plat.end(); await appc.end(); }
  });

  test('P16 kuota paket ditegakkan di database untuk semua jalur tulis (user aktif & cabang) → PLT-403-QUOTA', async () => {
    const [plan] = await su(`insert into app.subscription_plan(code, name, max_users, max_branches) values ('MINI', 'Mini uji', 2, 1) returning id`);
    const r = await createTenant('klinik-kecil', { planId: plan.id });
    const tid = r.body.id;
    const c = new Client({ connectionString: appUrl() });
    await c.connect();
    const asApp = async (q: string, params: unknown[] = []) => {
      await c.query('BEGIN');
      try {
        await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
        const res = await c.query(q, params);
        await c.query('COMMIT');
        return res;
      } catch (e) { await c.query('ROLLBACK'); throw e; }
    };
    try {
      await asApp(`insert into app.app_user(tenant_id, email, full_name) values ($1, 'u1@k.test', 'U1'), ($1, 'u2@k.test', 'U2')`, [tid]);
      const over = await asApp(`insert into app.app_user(tenant_id, email, full_name) values ($1, 'u3@k.test', 'U3')`, [tid]).catch((e) => e);
      expect(over.code).toBe('CRQ01');
      expect(toProblem(over)).toMatchObject({ status: 403, code: 'PLT-403-QUOTA', title: expect.stringContaining('(2)') });
      // user nonaktif tidak dihitung, tapi mengaktifkannya kembali melewati batas juga ditolak
      await asApp(`insert into app.app_user(tenant_id, email, full_name, status) values ($1, 'u4@k.test', 'U4', 'DISABLED')`, [tid]);
      expect((await asApp(`update app.app_user set status = 'ACTIVE' where email = 'u4@k.test'`).catch((e) => e)).code).toBe('CRQ01');
      await asApp(`update app.app_user set status = 'DISABLED' where email = 'u1@k.test'`);
      await asApp(`update app.app_user set status = 'ACTIVE' where email = 'u4@k.test'`);
      const [f] = (await asApp(`insert into app.facility(tenant_id, name, facility_type) values ($1, 'F', 'KLINIK_PRATAMA') returning id`, [tid])).rows;
      await asApp(`insert into app.branch(tenant_id, facility_id, code, name) values ($1, $2, 'C1', 'Cabang 1')`, [tid, f.id]);
      const b2 = await asApp(`insert into app.branch(tenant_id, facility_id, code, name) values ($1, $2, 'C2', 'Cabang 2')`, [tid, f.id]).catch((e) => e);
      expect(b2.code).toBe('CRQ01');
      expect(toProblem(b2).title).toContain('cabang');
    } finally { await c.end(); }
  });

  test('P17 daftar tenant: keyset pagination lengkap tanpa duplikat; parameter tidak valid 400; detail tak dikenal 404', async () => {
    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 20; i++) {
      const r = await p.get(`/api/platform/v1/tenants?limit=2${cursor ? `&cursor=${cursor}` : ''}`, admin);
      expect(r.status).toBe(200);
      seen.push(...r.body.data.map((t: { code: string }) => t.code));
      if (!r.body.page.hasMore) break;
      cursor = r.body.page.nextCursor;
    }
    const [all] = await su(`select array_agg(code order by code) codes from app.tenant`);
    expect(seen).toEqual(all.codes);
    expect((await p.get('/api/platform/v1/tenants?limit=500', admin)).status).toBe(400);
    expect((await p.get('/api/platform/v1/tenants?cursor=%27%3B--', admin)).status).toBe(400);
    expect((await p.get('/api/platform/v1/tenants/00000000-0000-0000-0000-000000000000', admin)).body.code).toBe('PLT-404-TENANT');
  });

  test('P18 batas percobaan TOTP: 5× salah → sesi platform dicabut', async () => {
    const { jar } = await platformLogin('admin@platform.test');
    for (let i = 0; i < 5; i++) expect((await p.post('/api/platform/v1/auth/mfa/verify', jar, { code: '000000' })).status).toBe(401);
    const v = await p.post('/api/platform/v1/auth/mfa/verify', jar, { code: await freshTotp(secrets['admin@platform.test']) });
    expect(v.status).toBe(401);
    expect(v.body.code).toBe('AUTH-401-SESSION');
  });

  test('P20 konsol platform: kode TOTP yang sudah diterima tidak dapat dipakai ulang (anti-replay, RSK-024)', async () => {
    const code = await freshTotp(secrets['admin@platform.test']);
    const { jar: a } = await platformLogin('admin@platform.test');
    expect((await p.post('/api/platform/v1/auth/mfa/verify', a, { code })).status).toBe(204);
    const { jar: b } = await platformLogin('admin@platform.test');               // penyadap memakai kode yang sama
    const replay = await p.post('/api/platform/v1/auth/mfa/verify', b, { code });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('AUTH-401-MFA-INVALID');
  });

  test('P19 logout mencabut sesi; audit platform append-only (UPDATE/DELETE ditolak, juga untuk owner)', async () => {
    const j = await platformSession('admin@platform.test');
    expect((await p.post('/api/platform/v1/auth/logout', j)).status).toBe(204);
    expect((await p.get('/api/platform/v1/me', j)).status).toBe(401);
    await expect(su(`update app.platform_audit_log set action = 'X'`)).rejects.toThrow(/IMMUTABLE/);
    await expect(su(`delete from app.platform_audit_log`)).rejects.toThrow(/IMMUTABLE/);
    const actions = (await su(`select distinct action from app.platform_audit_log`)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['PLATFORM_LOGIN', 'PLATFORM_MFA_ENROLLED', 'PLATFORM_MFA_VERIFIED', 'PLATFORM_MFA_FAILED',
                                                    'PLATFORM_LOGOUT', 'TENANT_PROVISIONED', 'TENANT_STATUS_CHANGED', 'FEATURE_FLAG_CHANGED']));
  });
});
