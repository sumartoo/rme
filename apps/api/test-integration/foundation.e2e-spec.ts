import 'reflect-metadata';
import { Body, Controller, Get, INestApplication, Post } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import request from 'supertest';
import { z } from 'zod';
import { BodySchema, Public, RequirePermission } from '@clinicrme/shared';
import { Db } from '@clinicrme/db';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app/create-app';
import { PASSWORD, appUrl, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Kontrol fondasi Stage 4 (F##): health probe, header keamanan, validasi body global,
 * batas ukuran body, format error, dan redaksi log. Melengkapi suite E## dari Stage 3.
 */
const HOST_A = 'klinik-a.clinicrme.test';

const EchoBody = z.object({ name: z.string().min(2).max(50) });
@Controller('api/v1/test')
class TestController {
  @Public() @BodySchema(EchoBody) @Post('echo')
  echo(@Body() b: unknown) { return { received: b }; }

  @Public() @Get('boom')
  boom() { throw new Error('detail internal: koneksi ke 10.0.0.5 gagal'); }

  @RequirePermission('patient.read') @Get('needs-perm')
  needsPerm() { return { ok: true }; }
}

let app: INestApplication;
let http: ReturnType<typeof request>;
const logLines: string[] = [];

beforeAll(async () => {
  await resetDatabase();
  const stream = new PassThrough();
  stream.on('data', (d: Buffer) => logLines.push(...d.toString('utf8').split('\n').filter(Boolean)));
  app = await createApp(testConfig({ LOG_LEVEL: 'info', BODY_LIMIT: '2kb' }), { controllers: [TestController], logStream: stream });
  http = request(app.getHttpServer());
});
afterAll(async () => { await app?.close(); });

describe('Probe & header (SC-WEB-01)', () => {
  test('F01 /healthz dan /readyz tanpa subdomain tenant; readyz memeriksa database', async () => {
    const live = await http.get('/healthz');
    expect(live.status).toBe(200);
    const ready = await http.get('/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  test('F02 header keamanan terpasang; tidak ada x-powered-by; request id dikembalikan', async () => {
    const r = await http.get('/api/v1/me').set('Host', HOST_A).set('X-Request-Id', 'req-f02');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['strict-transport-security']).toBeDefined();
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-request-id']).toBe('req-f02');
  });

  test('F03 request id dengan karakter berbahaya diganti id baru (mencegah injeksi log)', async () => {
    const r = await http.get('/healthz').set('X-Request-Id', '" ,"evil":"1');
    expect(r.headers['x-request-id']).not.toContain('evil');
  });
});

describe('Validasi body & format error (SC-WEB-05, API_CONTRACTS §4)', () => {
  test('F04 body tidak valid → 400 problem+json dengan daftar field', async () => {
    const r = await http.post('/api/v1/auth/login').set('Host', HOST_A).send({ email: 'bukan-email' });
    expect(r.status).toBe(400);
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(r.body.code).toBe('GEN-400-VALIDATION');
    expect(r.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['email', 'password']);
  });

  test('F05 field yang tidak dideklarasikan dibuang sebelum sampai ke handler', async () => {
    const r = await http.post('/api/v1/test/echo').set('Host', HOST_A).send({ name: 'Ani', tenant_id: ids.tenantB, role: 'ADMIN' });
    expect(r.status).toBe(201);
    expect(r.body.received).toEqual({ name: 'Ani' });
  });

  test('F06 endpoint @NoBody menolak body', async () => {
    const login = await http.post('/api/v1/auth/login').set('Host', HOST_A).send({ email: 'dokter@a.test', password: PASSWORD });
    const cookies = ([] as string[]).concat(login.headers['set-cookie'] ?? []);
    const csrf = cookies.find((c) => c.startsWith('crme_csrf='))!.split(';')[0].split('=')[1];
    const r = await http.post('/api/v1/auth/logout').set('Host', HOST_A)
      .set('Cookie', cookies.map((c) => c.split(';')[0]).join('; ')).set('X-CSRF-Token', csrf).send({ x: 1 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('GEN-400-UNEXPECTED-BODY');
  });

  test('F07 body melebihi batas → 413 problem+json', async () => {
    const r = await http.post('/api/v1/test/echo').set('Host', HOST_A).send({ name: 'x'.repeat(4000) });
    expect(r.status).toBe(413);
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(r.body.code).toBe('GEN-413');
  });

  test('F08 JSON rusak → 400 problem+json', async () => {
    const r = await http.post('/api/v1/test/echo').set('Host', HOST_A).set('Content-Type', 'application/json').send('{"name":');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('GEN-400');
  });

  test('F09 tanpa sesi, endpoint berizin menolak dengan 401 SEBELUM validasi body (tidak membocorkan bentuk input)', async () => {
    const r = await http.post(`/api/v1/users/${ids.kasirA}/disable`).set('Host', HOST_A).send({});
    expect(r.status).toBe(401);
  });

  test('F10 error tak terduga → 500 tanpa detail internal', async () => {
    const r = await http.get('/api/v1/test/boom').set('Host', HOST_A);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ type: 'about:blank', title: 'Terjadi kesalahan pada server', status: 500, code: 'GEN-500' });
    expect(JSON.stringify(r.body)).not.toContain('10.0.0.5');
  });

  test('F11 route tidak dikenal → 404 problem+json', async () => {
    const r = await http.get('/api/v1/tidak-ada').set('Host', HOST_A);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('GEN-404');
  });

  test('F12 aplikasi menolak start bila endpoint tulis tidak mendeklarasikan @BodySchema/@NoBody', async () => {
    @Controller('api/v1/lupa-body') class LupaBody { @Public() @Post() simpan(@Body() b: unknown) { return b; } }
    await expect(createApp(testConfig(), { controllers: [LupaBody] })).rejects.toThrow(/tanpa @BodySchema\/@NoBody: LupaBody\.simpan/);
  });
});

describe('Log (SC-LOG-01)', () => {
  test('F13 log JSON memuat request_id & tenant_id, tanpa password, cookie, token, query OAuth, atau NIK pencarian pasien', async () => {
    logLines.length = 0;
    const login = await http.post('/api/v1/auth/login').set('Host', HOST_A).set('X-Request-Id', 'req-f13')
      .send({ email: 'dokter@a.test', password: PASSWORD });
    expect(login.status).toBe(200);
    const cookies = ([] as string[]).concat(login.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]);
    const token = cookies.find((c) => c.startsWith('crme_session='))!.split('=')[1];
    await http.get(`/api/v1/patients/${ids.patientA}`).set('Host', HOST_A).set('Cookie', cookies.join('; '));
    await http.get('/api/v1/auth/google/callback?code=KODE-RAHASIA-OAUTH&state=s').set('Host', HOST_A);
    // REG-FR-009: pencarian NIK (lewat query) tidak membuka NIK di log
    const nikSearch = await http.get('/api/v1/patients?q=3201019999990009&nik=3201019999990009').set('Host', HOST_A).set('Cookie', cookies.join('; '));
    expect(nikSearch.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    const all = logLines.join('\n');
    expect(logLines.length).toBeGreaterThanOrEqual(3);
    for (const line of logLines) expect(() => JSON.parse(line)).not.toThrow();
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(token);
    expect(all).not.toContain('KODE-RAHASIA-OAUTH');
    expect(all).not.toContain('3201019999990009');
    const loginLog = logLines.map((l) => JSON.parse(l)).find((l) => l.request_id === 'req-f13');
    expect(loginLog).toMatchObject({ tenant_id: ids.tenantA, req: { method: 'POST', path: '/api/v1/auth/login' } });
    const patientLog = logLines.map((l) => JSON.parse(l)).find((l) => l.req?.path === `/api/v1/patients/${ids.patientA}`);
    expect(patientLog).toMatchObject({ tenant_id: ids.tenantA, user_id: ids.dokterA });
    expect(patientLog.req.headers?.cookie ?? '[REDACTED]').toBe('[REDACTED]');
  });
});

describe('Audit log berpartisi (migrasi 0002, temuan Stage 4)', () => {
  test('F14 role aplikasi tidak dapat membaca/menulis partisi audit langsung (melewati RLS); lewat induk tetap terisolasi', async () => {
    const db = new Db({ url: appUrl(), poolMax: 1 });
    // Drizzle membungkus error PostgreSQL; periksa pesan aslinya
    const denied = async (p: Promise<unknown>) => {
      const e = await p.then(() => null, (err) => err);
      expect(e).not.toBeNull();
      expect(String(e.cause?.message ?? e.message)).toMatch(/permission denied/);
    };
    try {
      const month = new Date().toISOString().slice(0, 7).replace('-', '_');
      await denied(db.preAuth(sql`select count(*) from app.audit_log_default`));
      await denied(db.preAuth(sql`select count(*) from ${sql.identifier('app')}.${sql.identifier(`audit_log_${month}`)}`));
      await denied(db.preAuth(sql`insert into app.audit_log_default(tenant_id, seq, action, resource_type, prev_hash, hash)
                                  values (${ids.tenantA}, 999999, 'FORGED', 'x', 'x', 'x')`));
      // tanpa tenant context, tabel induk tidak mengembalikan apa pun (RLS fail-closed)
      const [r] = await db.preAuth<{ n: number }>(sql`select count(*)::int as n from app.audit_log`);
      expect(r.n).toBe(0);
    } finally {
      await db.close();
    }
  });

  test('F15 audit baru tersimpan di partisi bulan berjalan, bukan partisi default', async () => {
    await http.post('/api/v1/auth/login').set('Host', HOST_A).send({ email: 'dokter@a.test', password: PASSWORD });
    const month = new Date().toISOString().slice(0, 7).replace('-', '_');
    const [m] = await su(`select count(*)::int n from app.audit_log_${month} where tenant_id = $1`, [ids.tenantA]);
    const [d] = await su(`select count(*)::int n from app.audit_log_default where occurred_at >= date_trunc('month', now(), 'UTC')`);
    expect(m.n).toBeGreaterThan(0);
    expect(d.n).toBe(0);
  });

  test('F16 izin TLS on-demand (deploy VPS, CR-0003): hanya konsol & klinik yang dilayani; tidak terjangkau lewat proxy klinik', async () => {
    const ask = async (d: string) => (await http.get(`/internal/tls-allowed?domain=${encodeURIComponent(d)}`)).status;
    expect(await ask('admin.clinicrme.test')).toBe(200);
    expect(await ask(HOST_A)).toBe(200);
    expect(await ask('tidak-ada.clinicrme.test')).toBe(404);
    expect(await ask('klinik-a.evil.test')).toBe(404);
    expect(await ask('a.b.clinicrme.test')).toBe(404);
    expect(await ask('')).toBe(404);
  });
});
