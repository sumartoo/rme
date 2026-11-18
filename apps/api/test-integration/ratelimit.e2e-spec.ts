import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { RateLimiter } from '@clinicrme/shared';
import { ensureLoginRoles, loginRolesFromEnv } from '@clinicrme/db';
import { Client } from 'pg';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, ownerUrl, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 15 batch 1 — pembatas laju aplikasi (OD-137 / DEC-050): login per akun & alamat, permintaan per pengguna & per tenant,
 * ekspor laporan per pengguna per jam. Batas dikecilkan lewat konfigurasi agar uji cepat; nilai produksi = bawaan konfigurasi.
 */
const HOST = 'klinik-a.clinicrme.test';
let app: INestApplication;
let http: ReturnType<typeof request>;

type Jar = { cookie: string; csrf: string };
async function login(email: string, ip = '203.0.113.10') {
  return http.post('/api/v1/auth/login').set('Host', HOST).set('X-Forwarded-For', ip).send({ email, password: PASSWORD });
}
function jar(r: request.Response): Jar {
  const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const csrf = get('crme_csrf');
  return { cookie: [get('crme_session'), csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '' };
}
const get = (path: string, j: Jar) => http.get(path).set('Host', HOST).set('Cookie', j.cookie);

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig({ RATE_LIMIT_LOGIN_PER_MIN: '3', RATE_LIMIT_USER_PER_MIN: '5', RATE_LIMIT_TENANT_PER_MIN: '8', RATE_LIMIT_EXPORT_PER_HOUR: '2' }));
  http = request(app.getHttpServer());
  await su(`update app.role set requires_mfa = false where code = 'MANAJER'`);
});
afterAll(async () => { await app?.close(); });

describe('Pembatas laju (OD-137)', () => {
  it('Z07 login: per akun per alamat → 429 + Retry-After; akun lain & alamat lain tidak terdampak', async () => {
    for (let i = 0; i < 3; i++) expect((await login('dokter@a.test')).status).toBe(200);
    const blocked = await login('dokter@a.test');
    expect([blocked.status, blocked.body.code]).toEqual([429, 'GEN-429-RATE-LIMIT']);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(blocked.headers['set-cookie']).toBeUndefined();
    expect((await login('kasir@a.test')).status).toBe(200);
    expect((await login('dokter@a.test', '198.51.100.7')).status).toBe(200);
    // Password salah tetap dihitung (tebakan berulang ditahan sebelum lockout akun)
    for (let i = 0; i < 3; i++) await http.post('/api/v1/auth/login').set('Host', HOST).set('X-Forwarded-For', '192.0.2.1').send({ email: 'manajer@a.test', password: 'salah-salah' });
    expect((await http.post('/api/v1/auth/login').set('Host', HOST).set('X-Forwarded-For', '192.0.2.1').send({ email: 'manajer@a.test', password: PASSWORD })).status).toBe(429);
  });

  it('Z08 per pengguna & per tenant: 429 setelah batas; tenant lain tetap dilayani', async () => {
    const dokter = jar(await login('dokter@a.test', '198.51.100.20'));
    const ok: number[] = [];
    for (let i = 0; i < 6; i++) ok.push((await get('/api/v1/me', dokter)).status);
    expect(ok).toEqual([200, 200, 200, 200, 200, 429]);
    // Batas tenant (8/menit) terlampaui oleh gabungan pengguna lain klinik A
    const kasir = jar(await login('kasir@a.test', '198.51.100.21'));
    const k: number[] = [];
    for (let i = 0; i < 4; i++) k.push((await get('/api/v1/me', kasir)).status);
    expect(k.filter((s) => s === 429).length).toBeGreaterThan(0);
    const b = jar(await http.post('/api/v1/auth/login').set('Host', 'klinik-b.clinicrme.test').send({ email: 'dokter@b.test', password: PASSWORD }));
    expect((await http.get('/api/v1/me').set('Host', 'klinik-b.clinicrme.test').set('Cookie', b.cookie)).status).toBe(200);
    // Endpoint publik/infra tidak dibatasi lapisan pengguna
    expect((await http.get('/healthz')).status).toBe(200);
  });

  it('Z09 ekspor laporan per pengguna per jam (dihitung dari tabel job, akurat lintas instance)', async () => {
    await su(`insert into app.report_export_job(tenant_id, report_code, format, status, requested_by) values ($1, 'visits', 'CSV', 'FAILED', $2), ($1, 'visits', 'CSV', 'FAILED', $2)`,
      [ids.tenantA, ids.manajerA]);
    // Aplikasi baru dengan batas pengguna besar agar yang diuji hanya batas ekspor
    const app2 = await createApp(testConfig({ RATE_LIMIT_EXPORT_PER_HOUR: '2' }));
    try {
      const h = request(app2.getHttpServer());
      const m = jar(await h.post('/api/v1/auth/login').set('Host', HOST).send({ email: 'manajer@a.test', password: PASSWORD }));
      const r = await h.post('/api/v1/reports/visits/exports').set('Host', HOST).set('Cookie', m.cookie).set('X-CSRF-Token', m.csrf)
        .send({ format: 'CSV', parameters: { from: '2026-10-01', to: '2026-10-31' } });
      expect([r.status, r.body.code]).toEqual([429, 'GEN-429-RATE-LIMIT']);
      expect(r.headers['retry-after']).toBe('600');
      await su(`update app.report_export_job set created_at = now() - interval '2 hours' where requested_by = $1`, [ids.manajerA]);
      const ok = await h.post('/api/v1/reports/visits/exports').set('Host', HOST).set('Cookie', m.cookie).set('X-CSRF-Token', m.csrf)
        .send({ format: 'CSV', parameters: { from: '2026-10-01', to: '2026-10-31' } });
      expect(ok.status).toBe(202);
    } finally { await app2.close(); }
  });

  it('Z10 unit: jendela tetap, reset setelah jendela, nonaktif = tanpa batas, memori terbatas', () => {
    let t = 0;
    const l = new RateLimiter({ enabled: true, loginPerMinute: 1, userPerMinute: 2, tenantPerMinute: 1, exportPerHour: 1 }, () => t);
    expect([l.hit('a', 2, 1000).ok, l.hit('a', 2, 1000).ok, l.hit('a', 2, 1000).ok]).toEqual([true, true, false]);
    expect(l.hit('a', 2, 1000).retryAfter).toBe(1);
    t = 1000;
    expect(l.hit('a', 2, 1000).ok).toBe(true);
    const off = new RateLimiter({ enabled: false, loginPerMinute: 1, userPerMinute: 1, tenantPerMinute: 1, exportPerHour: 1 });
    expect(Array.from({ length: 5 }, () => off.hit('x', 1, 1000).ok).every(Boolean)).toBe(true);
    for (let i = 0; i < 60_000; i++) l.hit(`k${i}`, 1, 1_000_000);
    expect((l as unknown as { windows: Map<string, unknown> }).windows.size).toBeLessThanOrEqual(50_000);
  });
});

describe('Role LOGIN untuk Cloud Run (Stage 15)', () => {
  it('Z11 ensureLoginRoles: anggota grup saja, NOBYPASSRLS, idempoten & rotasi password; RLS tetap berlaku', async () => {
    const pw1 = 'a'.repeat(30), pw2 = 'b'.repeat(30);   // pragma: allowlist secret — password uji sintetis
    expect(loginRolesFromEnv({ APP_DB_USER: 'crme_z_api', APP_DB_PASSWORD: pw1 })).toEqual([{ user: 'crme_z_api', password: pw1, group: 'clinicrme_app' }]);
    expect(() => loginRolesFromEnv({ PLATFORM_DB_USER: 'x_only' })).toThrow(/berpasangan/);
    await ensureLoginRoles(ownerUrl(), [{ user: 'crme_z_api', password: pw1, group: 'clinicrme_app' }]);
    await ensureLoginRoles(ownerUrl(), [{ user: 'crme_z_api', password: pw2, group: 'clinicrme_app' }]);   // idempoten + rotasi
    expect(await su(`select rolsuper, rolbypassrls, rolcreaterole, pg_has_role('crme_z_api', 'clinicrme_app', 'member') as member
                       from pg_roles where rolname = 'crme_z_api'`)).toEqual([{ rolsuper: false, rolbypassrls: false, rolcreaterole: false, member: true }]);
    const u = new URL(ownerUrl()); u.username = 'crme_z_api'; u.password = pw2;
    const c = new Client({ connectionString: u.toString() });
    await c.connect();
    try {
      // Tanpa konteks tenant: RLS menyembunyikan semua pasien
      expect((await c.query(`select count(*)::int as n from app.patient`)).rows).toEqual([{ n: 0 }]);
      await c.query(`select set_config('app.tenant_id', $1, false)`, [ids.tenantA]);
      expect((await c.query(`select count(distinct tenant_id)::int as n from app.patient`)).rows).toEqual([{ n: 1 }]);
    } finally { await c.end(); }
    await expect(ensureLoginRoles(ownerUrl(), [{ user: 'Bad-Name', password: pw1, group: 'clinicrme_app' }])).rejects.toThrow(/tidak valid/);
    await expect(ensureLoginRoles(ownerUrl(), [{ user: 'crme_z_api', password: 'pendek', group: 'clinicrme_app' }])).rejects.toThrow(/terlalu pendek/);
    await su(`drop role crme_z_api`);
  });
});
