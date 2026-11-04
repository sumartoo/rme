import 'reflect-metadata';
import { Controller, Get, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Public, RequirePermission, als, decrypt } from '@clinicrme/shared';
import { Db } from '@clinicrme/db';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app/create-app';
import { MockIdp } from './support/mock-idp';
import { PASSWORD, appUrl, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';
import { freshTotp } from './support/totp';

/**
 * Uji keamanan end-to-end: HTTP → guard → service → PostgreSQL (RLS) nyata.
 * Dipindah utuh dari PoC Stage 3 (DEC-019, RSK-020); penomoran E## sama dengan laporan Stage 3.
 * Suite ini WAJIB lulus di CI — jangan dilemahkan tanpa CR.
 */
const HOST_A = 'klinik-a.clinicrme.test';
const HOST_B = 'klinik-b.clinicrme.test';
let app: INestApplication;
let idp: MockIdp;
let http: ReturnType<typeof request>;

type Jar = { session?: string; csrf?: string; raw: string[] };
function jarFrom(res: request.Response, prev?: Jar): Jar {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0].split('=')[1];
  return { session: get('crme_session') ?? prev?.session, csrf: get('crme_csrf') ?? prev?.csrf, raw: set };
}
const cookieHeader = (j: Jar) => [j.session && `crme_session=${j.session}`, j.csrf && `crme_csrf=${j.csrf}`].filter(Boolean).join('; ');

async function login(email: string, host = HOST_A, password = PASSWORD) {
  const res = await http.post('/api/v1/auth/login').set('Host', host).send({ email, password });
  return { res, jar: jarFrom(res) };
}

beforeAll(async () => {
  await resetDatabase();
  idp = new MockIdp();
  await idp.start();
  app = await createApp(testConfig({
    GOOGLE_ISSUER: idp.issuer, GOOGLE_CLIENT_ID: 'clinicrme-test', GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REDIRECT_URI: `https://${HOST_A}/api/v1/auth/google/callback`,
  }));
  http = request(app.getHttpServer());
});
afterAll(async () => { await app?.close(); await idp?.stop(); });

describe('Autentikasi password (IAM-FR-003, SC-AUTH-03/04/06)', () => {
  test('E01 login benar → cookie sesi HttpOnly, Secure, SameSite=Lax; /me berfungsi', async () => {
    const { res, jar } = await login('dokter@a.test');
    expect(res.status).toBe(200);
    const sessionCookie = jar.raw.find((c) => c.startsWith('crme_session='))!;
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/Secure/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(jar.session!.length).toBeGreaterThanOrEqual(43);              // 256-bit base64url
    const me = await http.get('/api/v1/me').set('Host', HOST_A).set('Cookie', cookieHeader(jar));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('dokter@a.test');
    expect(me.body.permissions).toContain('clinical.note.sign');
  });

  test('E02 token sesi tidak disimpan mentah di database', async () => {
    const { jar } = await login('dokter@a.test');
    const raw = await su(`select count(*)::int n from app.user_session where token_hash = $1`, [jar.session]);
    expect(raw[0].n).toBe(0);
  });

  test('E03 email tak terdaftar & password salah → respons identik', async () => {
    const a = await http.post('/api/v1/auth/login').set('Host', HOST_A).send({ email: 'tidakada@a.test', password: 'x' });
    const b = await http.post('/api/v1/auth/login').set('Host', HOST_A).send({ email: 'kasir@a.test', password: 'salah' }); // pragma: allowlist secret
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
    const [aud] = await su(`select count(*)::int n from app.audit_log where action = 'LOGIN_FAILED' and change_summary->>'reason' = 'unknown_or_no_password'`);
    expect(aud.n).toBe(1);
  });

  test('E04 5× password salah → akun terkunci; password benar pun ditolak; tercatat di audit', async () => {
    for (let i = 0; i < 5; i++) await login('manajer@a.test', HOST_A, 'salah');
    const locked = await login('manajer@a.test');
    expect(locked.res.status).toBe(401);
    const [c] = await su(`select locked_until > now() as locked from app.user_credential where user_id = $1`, [ids.manajerA]);
    expect(c.locked).toBe(true);
    const audits = await su(`select change_summary->>'reason' r from app.audit_log where tenant_id = $1 and action = 'LOGIN_FAILED' and resource_id = $2`,
                            [ids.tenantA, ids.manajerA]);
    expect(audits.filter((a) => a.r === 'bad_password').length).toBe(5);
    expect(audits.some((a) => a.r === 'locked')).toBe(true);
    await su(`update app.user_credential set locked_until = null where user_id = $1`, [ids.manajerA]);
  });

  test('E05 user tenant A tidak dapat login lewat subdomain tenant B', async () => {
    const { res } = await login('dokter@a.test', HOST_B);
    expect(res.status).toBe(401);
  });

  test('E06 subdomain tidak dikenal → 404', async () => {
    const res = await http.post('/api/v1/auth/login').set('Host', 'tidak-ada.clinicrme.test').send({ email: 'x@y.z', password: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('MFA TOTP (IAM-FR-005, SC-AUTH-05)', () => {
  let jar: Jar;
  let secret: string;

  test('E07 admin (role requires_mfa) → semua endpoint ditolak sampai MFA diverifikasi', async () => {
    ({ jar } = await login('admin@a.test'));
    const me = await http.get('/api/v1/me').set('Host', HOST_A).set('Cookie', cookieHeader(jar));
    expect(me.status).toBe(401);
    expect(me.body.code).toBe('AUTH-401-MFA-REQUIRED');
  });

  test('E08 enroll → kode salah ditolak → kode benar membuka akses; secret tersimpan terenkripsi', async () => {
    const en = await http.post('/api/v1/auth/mfa/enroll').set('Host', HOST_A).set('Cookie', cookieHeader(jar)).set('X-CSRF-Token', jar.csrf!);
    expect(en.status).toBe(200);   // sesuai kontrak api/openapi.yaml (sebelumnya 201 — ditemukan uji kontrak Stage 4)
    secret = new URL(en.body.otpauthUrl).searchParams.get('secret')!;
    expect(en.body.recoveryCodes).toHaveLength(8);
    const [row] = await su(`select encode(totp_secret_encrypted, 'escape') s from app.user_mfa where user_id = $1`, [ids.adminA]);
    expect(row.s).not.toContain(secret);

    const bad = await http.post('/api/v1/auth/mfa/verify').set('Host', HOST_A).set('Cookie', cookieHeader(jar)).set('X-CSRF-Token', jar.csrf!).send({ code: '000000' });
    expect(bad.status).toBe(401);
    const [fail] = await su(`select count(*)::int n from app.audit_log where action = 'MFA_FAILED' and resource_id = $1`, [ids.adminA]);
    expect(fail.n).toBe(1);   // kegagalan tetap tercatat walau request ditolak (tidak ikut rollback)
    const ok = await http.post('/api/v1/auth/mfa/verify').set('Host', HOST_A).set('Cookie', cookieHeader(jar)).set('X-CSRF-Token', jar.csrf!)
      .send({ code: await freshTotp(secret) });
    expect(ok.status).toBe(200);
    // rotasi sesi saat naik MFA (SC-AUTH-06): cookie lama mati, cookie baru berlaku
    const rotated = jarFrom(ok, jar);
    expect(rotated.session).toBeDefined();
    expect(rotated.session).not.toBe(jar.session);
    const old = await http.get('/api/v1/me').set('Host', HOST_A).set('Cookie', cookieHeader(jar));
    expect(old.status).toBe(401);
    expect(old.body.code).toBe('AUTH-401-SESSION');
    const me = await http.get('/api/v1/me').set('Host', HOST_A).set('Cookie', cookieHeader(rotated));
    expect(me.status).toBe(200);
  });

  test('E09 recovery code hanya bisa dipakai sekali', async () => {
    const verify = (j: Jar, code: string) => http.post('/api/v1/auth/mfa/verify').set('Host', HOST_A)
      .set('Cookie', cookieHeader(j)).set('X-CSRF-Token', j.csrf!).send({ code });
    const { jar: j0 } = await login('admin@a.test');
    const v1 = await verify(j0, await freshTotp(secret));
    expect(v1.status).toBe(200);
    const j1 = jarFrom(v1, j0);
    const re = await http.post('/api/v1/auth/mfa/enroll').set('Host', HOST_A).set('Cookie', cookieHeader(j1)).set('X-CSRF-Token', j1.csrf!);
    secret = new URL(re.body.otpauthUrl).searchParams.get('secret')!;     // authenticator baru (didaftar ulang dari sesi ber-MFA)
    const code = re.body.recoveryCodes[0];
    const { jar: j2 } = await login('admin@a.test');
    expect((await verify(j2, code)).status).toBe(200);
    const { jar: j3 } = await login('admin@a.test');
    expect((await verify(j3, code)).status).toBe(401);
  });

  test('E33 sesi password saja tidak dapat mendaftar ulang MFA (menimpa secret = melewati MFA); /auth/session memberi status MFA tanpa permission', async () => {
    const { jar: j } = await login('admin@a.test');
    const s = await http.get('/api/v1/auth/session').set('Host', HOST_A).set('Cookie', cookieHeader(j));
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ email: 'admin@a.test', mfaRequired: true, mfaEnrolled: true, mfaVerified: false, tenant: { code: 'klinik-a' } });
    expect(Object.keys(s.body)).not.toContain('permissions');
    const before = await su(`select totp_secret_encrypted from app.user_mfa where user_id = $1`, [ids.adminA]);
    const re = await http.post('/api/v1/auth/mfa/enroll').set('Host', HOST_A).set('Cookie', cookieHeader(j)).set('X-CSRF-Token', j.csrf!);
    expect(re.status).toBe(409);
    expect(re.body.code).toBe('AUTH-409-MFA-ENROLLED');
    expect(await su(`select totp_secret_encrypted from app.user_mfa where user_id = $1`, [ids.adminA])).toEqual(before);   // secret lama tidak tertimpa
  });

  test('E34 kode TOTP yang sudah diterima tidak dapat dipakai ulang dalam periodenya (anti-replay, RSK-024)', async () => {
    const verify = (j: Jar, code: string) => http.post('/api/v1/auth/mfa/verify').set('Host', HOST_A)
      .set('Cookie', cookieHeader(j)).set('X-CSRF-Token', j.csrf!).send({ code });
    const code = await freshTotp(secret);
    const { jar: j1 } = await login('admin@a.test');
    expect((await verify(j1, code)).status).toBe(200);
    const { jar: j2 } = await login('admin@a.test');                        // penyadap memakai kode yang sama
    const replay = await verify(j2, code);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('AUTH-401-MFA-INVALID');
    expect((await verify(j2, await freshTotp(secret))).status).toBe(200);   // periode berikutnya diterima
  });

  test('E32 kode MFA salah berulang (batas 5) → sesi dicabut; tebakan berikutnya tidak bisa dilanjutkan', async () => {
    const { jar: j } = await login('admin@a.test');
    const verify = (code: string) => http.post('/api/v1/auth/mfa/verify').set('Host', HOST_A)
      .set('Cookie', cookieHeader(j)).set('X-CSRF-Token', j.csrf!).send({ code });
    for (let i = 0; i < 4; i++) expect((await verify('000000')).status).toBe(401);
    const fifth = await verify('000000');
    expect(fifth.status).toBe(401);
    expect(fifth.body.code).toBe('AUTH-401-MFA-INVALID');
    const after = await verify(await freshTotp(secret));   // kode benar pun ditolak: sesinya sudah dicabut
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('AUTH-401-SESSION');
    const [s] = await su(`select revoke_reason, mfa_failed_attempts from app.user_session where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`, [j.session]);
    expect(s).toEqual({ revoke_reason: 'MFA_ATTEMPTS', mfa_failed_attempts: 5 });
  });
});

describe('Isolasi tenant melalui API (GEN-FR-001, SC-TEN-01..05)', () => {
  let jarA: Jar;
  beforeAll(async () => { ({ jar: jarA } = await login('dokter@a.test')); });

  test('E10 daftar pasien hanya berisi pasien tenant sendiri', async () => {
    const r = await http.get('/api/v1/patients').set('Host', HOST_A).set('Cookie', cookieHeader(jarA));
    expect(r.status).toBe(200);
    expect(r.body.data.map((p: any) => p.id)).toEqual([ids.patientA]);
  });

  test('E11 membuka pasien tenant B dengan ID-nya langsung → 404 (bukan 403)', async () => {
    const r = await http.get(`/api/v1/patients/${ids.patientB}`).set('Host', HOST_A).set('Cookie', cookieHeader(jarA));
    expect(r.status).toBe(404);
  });

  test('E12 cookie sesi tenant A dipakai di subdomain tenant B → 401', async () => {
    const r = await http.get('/api/v1/patients').set('Host', HOST_B).set('Cookie', cookieHeader(jarA));
    expect(r.status).toBe(401);
  });

  test('E13 kueri tanpa tenant context gagal (fail-closed) dan role aplikasi tidak bisa membaca data', async () => {
    const db = new Db({ url: appUrl(), poolMax: 1 });
    await expect(als.run({ requestId: 't' }, () => db.withTenantTx(async () => 1))).rejects.toThrow(/fail-closed/);
    const r = await db.preAuth<{ n: number }>(sql`select count(*)::int as n from app.patient`);
    expect(r[0].n).toBe(0);
    await db.close();
  });
});

describe('Otorisasi (IAM-FR-011, SC-AUTHZ-01)', () => {
  test('E14b role wajib MFA (MANAJER) diblok MFA sebelum pengecekan permission', async () => {
    const { jar } = await login('manajer@a.test');
    const r = await http.get('/api/v1/patients').set('Host', HOST_A).set('Cookie', cookieHeader(jar));
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('AUTH-401-MFA-REQUIRED');
  });

  test('E14 user tanpa permission patient.read (role custom GUDANG) → 403', async () => {
    const { jar } = await login('gudang@a.test');
    const r = await http.get('/api/v1/patients').set('Host', HOST_A).set('Cookie', cookieHeader(jar));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('IAM-403-FORBIDDEN');
  });

  test('E15 aplikasi menolak start bila ada endpoint tanpa deklarasi akses', async () => {
    @Controller('api/v1/lupa') class LupaController { @Get() lupa() { return 'bocor'; } }
    await expect(createApp(testConfig(), { controllers: [LupaController] }))
      .rejects.toThrow(/LupaController\.lupa/);
  });

  test('E16 aplikasi start normal bila semua endpoint berdeklarasi', async () => {
    @Controller('api/v1/ok') class OkController { @Public() @Get('a') a() { return 1; } @RequirePermission('patient.read') @Get('b') b() { return 2; } }
    const a2 = await createApp(testConfig(), { controllers: [OkController] });
    await a2.close();
  });
});

describe('CSRF, sesi, nonaktif (SC-WEB-02, SC-AUTH-06/07)', () => {
  test('E17 POST tanpa header CSRF → 403; dengan header → diproses', async () => {
    const { jar } = await login('dokter@a.test');
    const no = await http.post('/api/v1/auth/logout').set('Host', HOST_A).set('Cookie', cookieHeader(jar));
    expect(no.status).toBe(403);
    expect(no.body.code).toBe('AUTH-403-CSRF');
    const yes = await http.post('/api/v1/auth/logout').set('Host', HOST_A).set('Cookie', cookieHeader(jar)).set('X-CSRF-Token', jar.csrf!);
    expect(yes.status).toBe(204);
    const after = await http.get('/api/v1/me').set('Host', HOST_A).set('Cookie', cookieHeader(jar));
    expect(after.status).toBe(401);
  });

  test('E18 sesi idle > 30 menit → 401', async () => {
    const { jar } = await login('dokter@a.test');
    await su(`update app.user_session set last_seen_at = now() - interval '31 minutes' where tenant_id = $1 and user_id = $2`, [ids.tenantA, ids.dokterA]);
    const r = await http.get('/api/v1/me').set('Host', HOST_A).set('Cookie', cookieHeader(jar));
    expect(r.status).toBe(401);
    expect(r.body.title).toMatch(/IDLE_TIMEOUT/);
  });

  test('E19 menonaktifkan user mencabut seluruh sesinya seketika (AC-IAM-FR-014-1)', async () => {
    const { jar: kasir } = await login('kasir@a.test');
    expect((await http.get('/api/v1/me').set('Host', HOST_A).set('Cookie', cookieHeader(kasir))).status).toBe(200);
    const { jar: admin0 } = await login('admin@a.test');
    // admin sudah enroll (E08/E09) → verifikasi MFA dulu
    const s = await su(`select totp_secret_encrypted from app.user_mfa where user_id = $1`, [ids.adminA]);
    const totp = decrypt('a'.repeat(64), s[0].totp_secret_encrypted);
    const v = await http.post('/api/v1/auth/mfa/verify').set('Host', HOST_A).set('Cookie', cookieHeader(admin0)).set('X-CSRF-Token', admin0.csrf!).send({ code: await freshTotp(totp) });
    expect(v.status).toBe(200);
    const admin = jarFrom(v, admin0);   // sesi dirotasi setelah MFA
    const dis = await http.post(`/api/v1/users/${ids.kasirA}/disable`).set('Host', HOST_A).set('Cookie', cookieHeader(admin)).set('X-CSRF-Token', admin.csrf!).send({ reason: 'Uji E19' });
    expect(dis.status).toBe(200);
    expect(dis.body.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect((await http.get('/api/v1/me').set('Host', HOST_A).set('Cookie', cookieHeader(kasir))).status).toBe(401);
    expect((await login('kasir@a.test')).res.status).toBe(401);
  });
});

describe('Audit (AUD-FR-001..003)', () => {
  test('E20 membuka rekam pasien tercatat sebagai READ dengan patient_id & request_id; chain tetap valid', async () => {
    const { jar } = await login('dokter@a.test');
    const r = await http.get(`/api/v1/patients/${ids.patientA}`).set('Host', HOST_A).set('Cookie', cookieHeader(jar)).set('X-Request-Id', 'req-e20');
    expect(r.status).toBe(200);
    const [a] = await su(`select actor_user_id, patient_id, request_id from app.audit_log where tenant_id = $1 and action = 'READ' order by seq desc limit 1`, [ids.tenantA]);
    expect(a).toEqual({ actor_user_id: ids.dokterA, patient_id: ids.patientA, request_id: 'req-e20' });
    const [v] = await su(`select ok from app.verify_audit_chain($1)`, [ids.tenantA]);
    expect(v.ok).toBe(true);
  });
});

describe('Google Sign-In (IAM-FR-002, SC-AUTH-01/02)', () => {
  async function start(host = HOST_A) {
    const r = await http.get('/api/v1/auth/google').set('Host', host);
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.location);
    const oidc = ([] as string[]).concat(r.headers['set-cookie']).find((c) => c.startsWith('crme_oidc='))!.split(';')[0];
    return { params: loc.searchParams, oidc };
  }
  const callback = (q: Record<string, string>, oidc: string, host = HOST_A) =>
    http.get('/api/v1/auth/google/callback').query(q).set('Host', host).set('Cookie', oidc);
  const claims = (p: URLSearchParams, extra: Record<string, unknown> = {}) => ({
    iss: idp.issuer, aud: 'clinicrme-test', sub: 'google-sub-perawat', email: 'perawat.baru@a.test', email_verified: true,
    name: 'Perawat Baru', nonce: p.get('nonce'), ...extra,
  });

  test('E21 redirect memakai PKCE S256, state, nonce, scope minimum', async () => {
    const { params } = await start();
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('scope')).toBe('openid email profile');
    expect(params.get('state')).toBeTruthy();
    expect(params.get('nonce')).toBeTruthy();
  });

  test('E22 akun Google tanpa undangan → 403, tidak ada user dibuat', async () => {
    const { params, oidc } = await start();
    idp.issue('c-uninvited', claims(params, { sub: 'g-x', email: 'orang.asing@gmail.com' }));
    const r = await callback({ code: 'c-uninvited', state: params.get('state')! }, oidc);
    expect(r.status).toBe(403);
    expect((await su(`select count(*)::int n from app.app_user where email = 'orang.asing@gmail.com'`))[0].n).toBe(0);
    const [aud] = await su(`select count(*)::int n from app.audit_log where action = 'LOGIN_FAILED' and change_summary->>'reason' = 'google_not_invited'`);
    expect(aud.n).toBe(1);
  });

  test('E23 dengan undangan → akun dibuat & ditautkan via sub; role dari undangan; PKCE diverifikasi IdP', async () => {
    const [role] = await su(`select id from app.role where tenant_id = $1 and code = 'PERAWAT'`, [ids.tenantA]);
    await su(`insert into app.user_invitation(tenant_id, email, role_ids, token_hash, expires_at)
              values ($1, 'perawat.baru@a.test', ARRAY[$2::uuid], 'inv-hash-1', now() + interval '7 days')`, [ids.tenantA, role.id]);
    const { params, oidc } = await start();
    idp.issue('c-invited', claims(params), { challenge: params.get('code_challenge')! });
    const r = await callback({ code: 'c-invited', state: params.get('state')! }, oidc);
    expect(r.status).toBe(302);
    const [link] = await su(`select i.subject, u.email from app.user_identity i join app.app_user u on u.id = i.user_id where i.provider = 'google'`);
    expect(link).toEqual({ subject: 'google-sub-perawat', email: 'perawat.baru@a.test' });
    const jar = jarFrom(r);
    const me = await http.get('/api/v1/me').set('Host', HOST_A).set('Cookie', cookieHeader(jar));
    expect(me.body.permissions).toContain('clinical.vitals.write');
    expect(me.body.permissions).not.toContain('clinical.note.sign');
    expect((await su(`select accepted_at is not null as a from app.user_invitation where token_hash = 'inv-hash-1'`))[0].a).toBe(true);
  });

  test('E24 login berikutnya dengan sub yang sama tetap berhasil walau email Google berubah', async () => {
    const { params, oidc } = await start();
    idp.issue('c-email-changed', claims(params, { email: 'perawat.ganti.email@gmail.com' }));
    const r = await callback({ code: 'c-email-changed', state: params.get('state')! }, oidc);
    expect(r.status).toBe(302);
  });

  test('E25 state salah → 401', async () => {
    const { params, oidc } = await start();
    idp.issue('c-state', claims(params));
    expect((await callback({ code: 'c-state', state: 'palsu' }, oidc)).status).toBe(401);
  });

  test('E26 nonce tidak cocok → 401', async () => {
    const { params, oidc } = await start();
    idp.issue('c-nonce', claims(params, { nonce: 'lain' }));
    const r = await callback({ code: 'c-nonce', state: params.get('state')! }, oidc);
    expect(r.status).toBe(401); expect(r.body.code).toBe('AUTH-401-NONCE');
  });

  test('E27 audience salah → 401', async () => {
    const { params, oidc } = await start();
    idp.issue('c-aud', claims(params, { aud: 'aplikasi-lain' }));
    const r = await callback({ code: 'c-aud', state: params.get('state')! }, oidc);
    expect(r.status).toBe(401); expect(r.body.code).toBe('AUTH-401-ID-TOKEN');
  });

  test('E28 id_token ditandatangani kunci lain → 401', async () => {
    const { params, oidc } = await start();
    idp.issue('c-forged', claims(params), { signWithForeignKey: true });
    const r = await callback({ code: 'c-forged', state: params.get('state')! }, oidc);
    expect(r.status).toBe(401); expect(r.body.code).toBe('AUTH-401-ID-TOKEN');
  });

  test('E29 email belum terverifikasi → 401', async () => {
    const { params, oidc } = await start();
    idp.issue('c-unverified', claims(params, { email_verified: false }));
    expect((await callback({ code: 'c-unverified', state: params.get('state')! }, oidc)).status).toBe(401);
  });

  test('E30 state OIDC dari tenant A dipakai di callback tenant B → 401', async () => {
    const { params, oidc } = await start(HOST_A);
    idp.issue('c-cross', claims(params));
    expect((await callback({ code: 'c-cross', state: params.get('state')! }, oidc, HOST_B)).status).toBe(401);
  });

  test('E31 akun yang sudah ada tidak otomatis ditautkan hanya karena email Google sama', async () => {
    const { params, oidc } = await start();
    idp.issue('c-takeover', claims(params, { sub: 'g-penyerang', email: 'dokter@a.test' }));
    const r = await callback({ code: 'c-takeover', state: params.get('state')! }, oidc);
    expect(r.status).toBe(403);
    expect((await su(`select count(*)::int n from app.user_identity where subject = 'g-penyerang'`))[0].n).toBe(0);
    const [aud] = await su(`select count(*)::int n from app.audit_log where action = 'LOGIN_FAILED' and resource_id = $1
                              and change_summary->>'reason' = 'google_link_required'`, [ids.dokterA]);
    expect(aud.n).toBe(1);
  });

});
