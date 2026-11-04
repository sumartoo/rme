import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { Mail, dispatchNotifications } from '@clinicrme/db/notifications';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, ownerUrl, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';
import { freshTotp } from './support/totp';

/**
 * Administrasi IAM klinik (Stage 6 batch 1): undangan + terima dengan password (IAM-FR-001, OD-078), kebijakan password
 * (IAM-FR-003, OD-079), reset password (IAM-FR-004), role custom & MFA per role (IAM-FR-005/008, OD-080), menu dinamis
 * (IAM-FR-010), sesi saya & cabut sesi (IAM-FR-013), aktif/nonaktif (IAM-FR-014), cabang aktif (IAM-FR-009), cegah eskalasi.
 * Email ditangkap dari dispatcher outbox yang sama dengan worker. Data sintetis saja.
 */
const HOST = 'klinik-a.clinicrme.test';
const BRANCH_A = 'aaaaaaaa-0000-0000-0000-000000000010';
let app: INestApplication;
let http: ReturnType<typeof request>;
let workerPool: Pool;
const sent: Mail[] = [];
const capture = async (m: Mail) => { sent.push(m); };
const NOTIFY = { clinicUrlTemplate: 'https://{code}.clinicrme.test' };
/** Jalankan dispatcher (seperti worker), lalu ambil email untuk satu alamat dari kotak keluar uji. */
const mailTo = async (to: string) => {
  await dispatchNotifications(workerPool, capture, NOTIFY);
  const mine = sent.filter((m) => m.to === to);
  for (const m of mine) sent.splice(sent.indexOf(m), 1);
  return mine;
};
const tokenIn = (m: Mail, kind: 'invitation' | 'reset-password') => new RegExp(`/${kind}/([A-Za-z0-9_-]+)`).exec(m.text)![1];

type Jar = { cookie: string; csrf: string };
function jar(res: request.Response, prev?: Jar): Jar {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const session = get('crme_session') ?? prev?.cookie.split('; ').find((c) => c.startsWith('crme_session='));
  const csrf = get('crme_csrf') ?? (prev ? `crme_csrf=${prev.csrf}` : undefined);
  return { cookie: [session, csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '' };
}
const login = async (email: string, password = PASSWORD) => {
  const r = await http.post('/api/v1/auth/login').set('Host', HOST).send({ email, password });
  expect([email, r.status]).toEqual([email, 200]);
  return jar(r);
};
const get = (path: string, j: Jar) => http.get(path).set('Host', HOST).set('Cookie', j.cookie);
const send = (method: 'post' | 'put' | 'delete', path: string, j: Jar) => http[method](path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
const pub = (path: string) => http.post(path).set('Host', HOST);

let adminSecret = '';
async function adminSession(): Promise<Jar> {
  let j = await login('admin@a.test');
  if (!adminSecret) {
    const e = await send('post', '/api/v1/auth/mfa/enroll', j);
    adminSecret = new URL(e.body.otpauthUrl).searchParams.get('secret')!;
  }
  const v = await send('post', '/api/v1/auth/mfa/verify', j).send({ code: await freshTotp(adminSecret) });
  expect(v.status).toBe(200);
  j = jar(v, j);
  return j;
}

let admin: Jar, kasir: Jar;
const roleId = async (code: string) => (await su<{ id: string }>(`select id from app.role where tenant_id = $1 and code = $2`, [ids.tenantA, code]))[0].id;
beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  workerPool = new Pool({ connectionString: ownerUrl(), max: 2 });
  admin = await adminSession();
  kasir = await login('kasir@a.test');
});
afterAll(async () => { await app?.close(); await workerPool?.end(); });

describe('Undangan & terima dengan password (IAM-FR-001, OD-078)', () => {
  let token = '';
  test('I01 admin mengundang → email berisi tautan undangan (token hanya di email); undangan ganda 409; kasir 403', async () => {
    const r = await send('post', '/api/v1/users/invitations', admin).send({ email: 'Perawat.Baru@A.test', fullName: 'Perawat Baru', roleIds: [await roleId('PERAWAT')] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ email: 'perawat.baru@a.test', acceptedAt: null });
    const [m] = await mailTo('perawat.baru@a.test');
    expect(m.text).toContain('https://klinik-a.clinicrme.test/invitation/');
    token = tokenIn(m, 'invitation');
    const [row] = await su(`select token_hash from app.user_invitation where id = $1`, [r.body.id]);
    expect(row.token_hash).not.toContain(token);                                     // hanya hash
    expect((await send('post', '/api/v1/users/invitations', admin).send({ email: 'perawat.baru@a.test', roleIds: [await roleId('PERAWAT')] })).body.code).toBe('IAM-409-INVITED');
    expect((await send('post', '/api/v1/users/invitations', admin).send({ email: 'kasir@a.test', roleIds: [await roleId('KASIR')] })).body.code).toBe('IAM-409-USER-EXISTS');
    expect((await send('post', '/api/v1/users/invitations', kasir).send({ email: 'x@a.test', roleIds: [await roleId('KASIR')] })).status).toBe(403);
    const list = await get('/api/v1/users/invitations', admin);
    expect(list.body.map((i: { email: string }) => i.email)).toContain('perawat.baru@a.test');
  });

  test('I02 detail undangan sebelum login; token salah / klinik lain → 404 yang sama', async () => {
    const r = await http.get(`/api/v1/invitations/${token}`).set('Host', HOST);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ email: 'perawat.baru@a.test', roles: ['Perawat / Bidan'] });
    expect((await http.get(`/api/v1/invitations/${'x'.repeat(43)}`).set('Host', HOST)).body.code).toBe('IAM-404-INVITATION');
    expect((await http.get(`/api/v1/invitations/${token}`).set('Host', 'klinik-b.clinicrme.test')).body.code).toBe('IAM-404-INVITATION');
  });

  test('I03 terima dengan password: kebijakan password ditegakkan; sukses → bisa login dengan role undangan; token sekali pakai', async () => {
    for (const [pw, msg] of [['pendek', 'minimal 10'], ['1234567890', 'terlalu umum'], ['perawat.baru-2026', 'nama email']]) {
      const r = await pub(`/api/v1/invitations/${token}/accept`).send({ fullName: 'Perawat Baru', password: pw });
      expect([pw, r.status, r.body.title]).toEqual([pw, 400, expect.stringContaining(msg)]);
    }
    expect((await pub(`/api/v1/invitations/${token}/accept`).send({ fullName: 'Perawat Baru', password: 'teh-hangat-pagi-77' })).status).toBe(201);   // pragma: allowlist secret gitleaks:allow — password uji sintetis
    const j = await login('perawat.baru@a.test', 'teh-hangat-pagi-77');
    const me = await get('/api/v1/me', j);
    expect(me.body.permissions).toContain('clinical.vitals.write');
    expect((await pub(`/api/v1/invitations/${token}/accept`).send({ fullName: 'Orang Lain', password: 'teh-hangat-pagi-78' })).status).toBe(404);   // pragma: allowlist secret gitleaks:allow — password uji sintetis
    const [a] = await su(`select count(*)::int n from app.audit_log where tenant_id = $1 and action = 'INVITATION_ACCEPTED'`, [ids.tenantA]);
    expect(a.n).toBe(1);
  });

  test('I04 cegah eskalasi: pemegang iam.user.manage tanpa izin admin lain tidak dapat mengundang TENANT_ADMIN', async () => {
    const r = await send('post', '/api/v1/roles', admin).send({ code: 'HRD', name: 'HRD', permissions: ['iam.user.manage', 'iam.user.read', 'iam.role.read'] });
    expect(r.status).toBe(201);
    await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) values ($1, $2, $3)`, [ids.tenantA, ids.gudangA, r.body.id]);
    const hrd = await login('gudang@a.test');
    const esc = await send('post', '/api/v1/users/invitations', hrd).send({ email: 'calon.admin@a.test', roleIds: [await roleId('TENANT_ADMIN')] });
    expect(esc.status).toBe(403);
    expect(esc.body.code).toBe('IAM-403-ESCALATION');
    // Izin klinis boleh diberikan (admin mengundang dokter tanpa memegang izin klinis)
    expect((await send('post', '/api/v1/users/invitations', hrd).send({ email: 'dokter.baru@a.test', roleIds: [await roleId('DOKTER')] })).status).toBe(201);
  });
});

describe('Reset password (IAM-FR-004, AC-IAM-FR-004-1)', () => {
  test('I05 respons identik untuk email terdaftar & tidak; tautan hanya terkirim untuk akun ber-password yang aktif', async () => {
    const a = await pub('/api/v1/auth/password-reset').send({ email: 'kasir@a.test' });
    const b = await pub('/api/v1/auth/password-reset').send({ email: 'tidak-ada@a.test' });
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body).toEqual(b.body);
    expect(await mailTo('tidak-ada@a.test')).toHaveLength(0);
  });

  test('I06 tautan reset: kebijakan password, sekali pakai, mencabut semua sesi & membuka kunci akun', async () => {
    const [m] = await mailTo('kasir@a.test');
    expect(m.subject).toContain('Reset password');
    const token = tokenIn(m, 'reset-password');
    await su(`update app.user_credential set failed_attempts = 4, locked_until = now() + interval '10 minutes' where user_id = $1`, [ids.kasirA]);
    expect((await pub('/api/v1/auth/password-reset/confirm').send({ token, password: 'basketball' })).status).toBe(400);   // pragma: allowlist secret gitleaks:allow — password uji sintetis
    expect((await pub('/api/v1/auth/password-reset/confirm').send({ token, password: 'payung-biru-di-hujan-9' })).status).toBe(204);   // pragma: allowlist secret gitleaks:allow — password uji sintetis
    expect((await get('/api/v1/me', kasir)).status).toBe(401);                      // sesi lama dicabut
    kasir = await login('kasir@a.test', 'payung-biru-di-hujan-9');                    // kunci dibuka
    expect((await pub('/api/v1/auth/password-reset/confirm').send({ token, password: 'payung-biru-di-hujan-10' })).body.code).toBe('IAM-400-RESET-TOKEN');   // pragma: allowlist secret gitleaks:allow — password uji sintetis
    const [{ n }] = await su(`select count(*)::int n from app.audit_log where tenant_id = $1 and action = 'PASSWORD_RESET'`, [ids.tenantA]);
    expect(n).toBe(1);
  });

  test('I07 tautan kedaluwarsa (30 menit) & batas 3 permintaan per jam', async () => {
    await pub('/api/v1/auth/password-reset').send({ email: 'manajer@a.test' });
    const [m] = await mailTo('manajer@a.test');
    await su(`update app.password_reset_request set expires_at = now() - interval '1 second' where user_id = $1`, [ids.manajerA]);
    expect((await pub('/api/v1/auth/password-reset/confirm').send({ token: tokenIn(m, 'reset-password'), password: 'lampu-jalan-sore-31' })).status).toBe(400);
    for (let i = 0; i < 4; i++) expect((await pub('/api/v1/auth/password-reset').send({ email: 'manajer@a.test' })).status).toBe(202);
    const [{ n }] = await su(`select count(*)::int n from app.password_reset_request where user_id = $1`, [ids.manajerA]);
    expect(n).toBe(3);
  });
});

describe('Role & MFA per role (IAM-FR-007/008/005, OD-080)', () => {
  test('I08 daftar role template + permission; buat role custom: kode ganda 409, permission tak dikenal 400, kasir 403', async () => {
    const roles = await get('/api/v1/roles', admin);
    expect(roles.body.filter((r: { isTemplate: boolean }) => r.isTemplate).map((r: { code: string }) => r.code))
      .toEqual(expect.arrayContaining(['TENANT_ADMIN', 'DOKTER', 'PERAWAT', 'PENDAFTARAN', 'FARMASI', 'KASIR', 'MANAJER', 'AUDITOR']));
    expect((await get('/api/v1/permissions', admin)).body.length).toBeGreaterThan(80);
    expect((await send('post', '/api/v1/roles', admin).send({ code: 'HRD', name: 'Dup', permissions: [] })).body.code).toBe('IAM-409-ROLE-CODE');
    expect((await send('post', '/api/v1/roles', admin).send({ code: 'ANEH', name: 'Aneh', permissions: ['tidak.ada'] })).body.code).toBe('IAM-400-PERMISSION');
    expect((await send('post', '/api/v1/roles', kasir).send({ code: 'X_ROLE', name: 'X', permissions: [] })).status).toBe(403);
  });

  test('I09 ubah role: If-Match wajib/412; role template hanya MFA; TENANT_ADMIN & MANAJER selalu wajib MFA; teraudit', async () => {
    const roles = (await get('/api/v1/roles', admin)).body as { id: string; code: string; version: number; requiresMfa: boolean }[];
    const dokter = roles.find((r) => r.code === 'DOKTER')!, ta = roles.find((r) => r.code === 'TENANT_ADMIN')!;
    expect((await send('put', `/api/v1/roles/${dokter.id}`, admin).send({ requiresMfa: true })).status).toBe(428);
    expect((await send('put', `/api/v1/roles/${dokter.id}`, admin).set('If-Match', '"999"').send({ requiresMfa: true })).status).toBe(412);
    expect((await send('put', `/api/v1/roles/${dokter.id}`, admin).set('If-Match', `"${dokter.version}"`).send({ permissions: ['patient.read'] })).body.code).toBe('IAM-409-TEMPLATE');
    const on = await send('put', `/api/v1/roles/${dokter.id}`, admin).set('If-Match', `"${dokter.version}"`).send({ requiresMfa: true });
    expect(on.status).toBe(200);
    expect(on.body.requiresMfa).toBe(true);
    expect(on.headers.etag).toBe(`"${on.body.version}"`);
    // Dokter yang sudah login tanpa MFA langsung diminta MFA pada request berikutnya
    const dokter1 = await login('dokter@a.test');
    expect((await get('/api/v1/patients', dokter1)).body.code).toBe('AUTH-401-MFA-REQUIRED');
    expect((await send('put', `/api/v1/roles/${ta.id}`, admin).set('If-Match', `"${ta.version}"`).send({ requiresMfa: false })).body.code).toBe('IAM-409-MFA-LOCKED');
    const back = await send('put', `/api/v1/roles/${dokter.id}`, admin).set('If-Match', `"${on.body.version}"`).send({ requiresMfa: false });
    expect(back.status).toBe(200);
    const audits = await su(`select change_summary as summary from app.audit_log where tenant_id = $1 and action = 'ROLE_UPDATED' order by seq`, [ids.tenantA]);
    expect(audits.map((a) => a.summary.requiresMfa)).toEqual([true, false]);
  });

  test('I10 perubahan permission role custom berlaku pada request berikutnya (bukan menunggu login ulang)', async () => {
    const hrd = await login('gudang@a.test');
    expect((await get('/api/v1/roles', hrd)).status).toBe(200);
    const role = (await get('/api/v1/roles', admin)).body.find((r: { code: string }) => r.code === 'HRD');
    const r = await send('put', `/api/v1/roles/${role.id}`, admin).set('If-Match', `"${role.version}"`).send({ permissions: ['iam.user.read'] });
    expect(r.status).toBe(200);
    expect((await get('/api/v1/roles', hrd)).status).toBe(403);
    expect((await get('/api/v1/users', hrd)).status).toBe(200);
  });

  test('I11 klinik baru: MFA dokter wajib secara default (DEC-019)', async () => {
    const [{ requires_mfa }] = await su(`select requires_mfa from app.role where code = 'DOKTER' and is_template and tenant_id = $1`, [ids.tenantA]);
    expect(requires_mfa).toBe(false);                                                // klinik uji mematikannya (db-setup)
    const def = await su<{ def: string }>(`select pg_get_functiondef('app.create_template_roles()'::regprocedure) as def`);
    expect(def[0].def).toContain(`'DOKTER', 'Dokter', true, true)`);
  });
});

describe('Menu, cabang, sesi, status akun (IAM-FR-009/010/013/014)', () => {
  test('I12 menu mengikuti permission; menu bukan kontrol akses — API tetap menolak', async () => {
    const codes = (tree: { code: string; children: unknown[] }[]): string[] => tree.flatMap((n) => [n.code, ...codes(n.children as never)]);
    const adminMenu = codes((await get('/api/v1/me/menu', admin)).body);
    expect(adminMenu).toEqual(expect.arrayContaining(['admin', 'admin.users', 'admin.roles', 'admin.profile', 'admin.exports', 'account.sessions']));
    const kasirMenu = codes((await get('/api/v1/me/menu', kasir)).body);
    expect(kasirMenu).not.toContain('admin');                                         // grup tanpa anak terlihat disembunyikan
    expect(kasirMenu).toContain('account.sessions');
    expect((await get('/api/v1/users', kasir)).status).toBe(403);
  });

  test('I13 pilih cabang aktif: hanya cabang yang ditugaskan; tersimpan di sesi', async () => {
    const ok = await send('post', '/api/v1/me/branch', kasir).send({ branchId: BRANCH_A });
    expect(ok.status).toBe(200);
    const [s] = await su(`select branch_id from app.user_session where user_id = $1 and revoked_at is null order by created_at desc limit 1`, [ids.kasirA]);
    expect(s.branch_id).toBe(BRANCH_A);
    const me = await get('/api/v1/me', kasir);
    expect(me.body.activeBranchId).toBe(BRANCH_A);
    expect(me.body.branches).toEqual([expect.objectContaining({ id: BRANCH_A, name: 'Cabang 1' })]);   // hanya cabang tenant sendiri
    expect((await send('post', '/api/v1/me/branch', kasir).send({ branchId: 'bbbbbbbb-0000-0000-0000-000000000010' })).body.code).toBe('IAM-403-BRANCH');
  });

  test('I14 sesi saya: daftar perangkat, cabut sesi lain → tidak bisa dipakai; cabut sesi sendiri → keluar', async () => {
    const other = await login('kasir@a.test', 'payung-biru-di-hujan-9');
    const list = await get('/api/v1/me/sessions', kasir);
    expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const otherId = list.body.find((s: { current: boolean }) => !s.current).id;
    expect((await send('delete', `/api/v1/me/sessions/${otherId}`, kasir)).status).toBe(204);
    expect((await get('/api/v1/me', other)).status).toBe(401);
    // Sesi user lain tidak dapat dicabut lewat endpoint ini
    const adminSessions = await su(`select id from app.user_session where user_id = $1 and revoked_at is null limit 1`, [ids.adminA]);
    expect((await send('delete', `/api/v1/me/sessions/${adminSessions[0].id}`, kasir)).status).toBe(404);
    const mine = list.body.find((s: { current: boolean }) => s.current).id;
    const self = await send('delete', `/api/v1/me/sessions/${mine}`, kasir);
    expect(self.status).toBe(204);
    expect(String(self.headers['set-cookie'])).toContain('crme_session=;');
    expect((await get('/api/v1/me', kasir)).status).toBe(401);
    kasir = await login('kasir@a.test', 'payung-biru-di-hujan-9');
  });

  test('I15 admin: daftar user, cabut semua sesi user, nonaktif (bukan diri sendiri) lalu aktifkan kembali', async () => {
    const users = await get('/api/v1/users?limit=2', admin);
    expect(users.body.data).toHaveLength(2);
    expect(users.body.page.hasMore).toBe(true);
    const next = await get(`/api/v1/users?limit=200&cursor=${encodeURIComponent(users.body.page.nextCursor)}`, admin);
    expect(next.body.data.some((u: { email: string }) => users.body.data.some((v: { email: string }) => v.email === u.email))).toBe(false);
    expect((await send('delete', `/api/v1/users/${ids.kasirA}/sessions`, admin)).status).toBe(204);
    expect((await get('/api/v1/me', kasir)).status).toBe(401);
    expect((await send('post', `/api/v1/users/${ids.adminA}/disable`, admin).send({ reason: 'uji diri sendiri' })).body.code).toBe('IAM-409-SELF');
    expect((await send('post', `/api/v1/users/${ids.kasirA}/disable`, admin).send({ reason: 'cuti panjang' })).status).toBe(200);
    expect((await http.post('/api/v1/auth/login').set('Host', HOST).send({ email: 'kasir@a.test', password: 'payung-biru-di-hujan-9' })).status).toBe(401);   // pragma: allowlist secret gitleaks:allow — password uji sintetis
    expect((await send('post', `/api/v1/users/${ids.kasirA}/enable`, admin)).status).toBe(200);
    await login('kasir@a.test', 'payung-biru-di-hujan-9');
  });

  test('I16 reset MFA oleh admin: authenticator dihapus & sesi dicabut; bukan diri sendiri; tanpa eskalasi; teraudit', async () => {
    // Manajer (wajib MFA) mendaftar TOTP
    let m = await login('manajer@a.test');
    const e = await send('post', '/api/v1/auth/mfa/enroll', m);
    const secret = new URL(e.body.otpauthUrl).searchParams.get('secret')!;
    m = jar(await send('post', '/api/v1/auth/mfa/verify', m).send({ code: await freshTotp(secret) }), m);
    expect((await get('/api/v1/me', m)).status).toBe(200);
    expect((await send('delete', `/api/v1/users/${ids.adminA}/mfa`, admin)).body.code).toBe('IAM-409-SELF');
    kasir = await login('kasir@a.test', 'payung-biru-di-hujan-9');   // pragma: allowlist secret gitleaks:allow — password uji sintetis
    expect((await send('delete', `/api/v1/users/${ids.manajerA}/mfa`, kasir)).status).toBe(403);
    expect((await send('delete', `/api/v1/users/${ids.manajerA}/mfa`, admin)).status).toBe(204);
    expect((await get('/api/v1/me', m)).status).toBe(401);                            // sesi lama dicabut
    const again = await login('manajer@a.test');
    expect((await get('/api/v1/auth/session', again)).body).toMatchObject({ mfaRequired: true, mfaEnrolled: false });
    expect((await send('delete', `/api/v1/users/${ids.manajerA}/mfa`, admin)).body.code).toBe('IAM-409-MFA-NOT-ENROLLED');
    // HRD (iam.user.manage tanpa izin admin lain) tidak dapat me-reset MFA admin klinik
    await su(`insert into app.role_permission(tenant_id, role_id, permission_code) select tenant_id, id, 'iam.user.manage' from app.role where tenant_id = $1 and code = 'HRD'`, [ids.tenantA]);
    const hrd = await login('gudang@a.test');
    expect((await send('delete', `/api/v1/users/${ids.adminA}/mfa`, hrd)).body.code).toBe('IAM-403-ESCALATION');
    const [{ n }] = await su(`select count(*)::int n from app.audit_log where tenant_id = $1 and action = 'MFA_RESET'`, [ids.tenantA]);
    expect(n).toBe(1);
  });

  test('I17 tautan tenaga kesehatan (IAM-FR-016): lewat undangan atau langsung; satu nakes satu akun; nakes klinik lain ditolak', async () => {
    const DOKTER_PRAC_A = 'aaaaaaaa-0000-0000-0000-000000000020';                // nakes seed tenant A (sudah tertaut ke dokter@a.test)
    const [p2] = await su<{ id: string }>(`insert into app.practitioner(tenant_id, full_name, practitioner_type) values ($1, 'drg. Uji Baru', 'DOKTER_GIGI') returning id`, [ids.tenantA]);
    expect((await send('post', '/api/v1/users/invitations', admin).send({ email: 'drg.baru@a.test', roleIds: [await roleId('DOKTER')], practitionerId: DOKTER_PRAC_A })).body.code)
      .toBe('IAM-409-PRACTITIONER-LINKED');
    expect((await send('post', '/api/v1/users/invitations', admin).send({ email: 'drg.baru@a.test', roleIds: [await roleId('DOKTER')], practitionerId: 'bbbbbbbb-0000-0000-0000-000000000020' })).body.code)
      .toBe('IAM-400-PRACTITIONER');                                                // nakes tenant B tidak terlihat (RLS)
    const inv = await send('post', '/api/v1/users/invitations', admin).send({ email: 'drg.baru@a.test', roleIds: [await roleId('DOKTER')], practitionerId: p2.id });
    expect(inv.status).toBe(201);
    const [m] = await mailTo('drg.baru@a.test');
    expect((await pub(`/api/v1/invitations/${tokenIn(m, 'invitation')}/accept`).send({ fullName: 'drg. Uji Baru', password: 'gigi-sehat-tiap-hari-8' })).status).toBe(201);   // pragma: allowlist secret gitleaks:allow — password uji sintetis
    const [u] = await su(`select id, practitioner_id from app.app_user where email = 'drg.baru@a.test'`);
    expect(u.practitioner_id).toBe(p2.id);
    // Lepas lalu tautkan langsung; akun lain tidak dapat memakai nakes yang sama
    expect((await send('post', `/api/v1/users/${u.id}/practitioner`, admin).send({ practitionerId: null })).body.practitionerId).toBeNull();
    expect((await send('post', `/api/v1/users/${ids.kasirA}/practitioner`, admin).send({ practitionerId: DOKTER_PRAC_A })).body.code).toBe('IAM-409-PRACTITIONER-LINKED');
    expect((await send('post', `/api/v1/users/${u.id}/practitioner`, admin).send({ practitionerId: p2.id })).status).toBe(200);
    expect((await send('post', `/api/v1/users/${u.id}/practitioner`, kasir).send({ practitionerId: null })).status).toBe(403);
    const list = await get('/api/v1/users?limit=200', admin);
    expect(list.body.data.find((x: { email: string }) => x.email === 'drg.baru@a.test').practitionerId).toBe(p2.id);
    const audits = await su(`select action from app.audit_log where tenant_id = $1 and action like 'PRACTITIONER_%' order by seq`, [ids.tenantA]);
    expect(audits.map((a) => a.action)).toEqual(['PRACTITIONER_UNLINKED', 'PRACTITIONER_LINKED']);
  });
});
