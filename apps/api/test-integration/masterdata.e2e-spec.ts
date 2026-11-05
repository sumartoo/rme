import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';
import { freshTotp } from './support/totp';

/**
 * Master data Stage 7 batch 1: fasilitas, cabang, poli/unit (MST-FR-001), tenaga kesehatan (MST-FR-002), audit
 * sebelum/sesudah (MST-FR-009), optimistic locking (GEN-FR-007), kuota cabang (PLT-FR-004), isolasi tenant.
 * NIK tenaga kesehatan: terenkripsi, tidak pernah utuh di respons maupun audit. Data sintetis saja.
 */
const HOST = 'klinik-a.clinicrme.test';
const FACILITY_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const BRANCH_A = 'aaaaaaaa-0000-0000-0000-000000000010';
const BRANCH_B = 'bbbbbbbb-0000-0000-0000-000000000010';
const PRACT_B = 'bbbbbbbb-0000-0000-0000-000000000020';
const NIK = '3201011201900001';   // NIK sintetis (struktur valid, bukan milik orang)
let app: INestApplication;
let http: ReturnType<typeof request>;

type Jar = { cookie: string; csrf: string };
function jar(res: request.Response, prev?: Jar): Jar {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const session = get('crme_session') ?? prev?.cookie.split('; ').find((c) => c.startsWith('crme_session='));
  const csrf = get('crme_csrf') ?? (prev ? `crme_csrf=${prev.csrf}` : undefined);
  return { cookie: [session, csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '' };
}
const login = async (email: string) => {
  const r = await http.post('/api/v1/auth/login').set('Host', HOST).send({ email, password: PASSWORD });
  expect([email, r.status]).toEqual([email, 200]);
  return jar(r);
};
const get = (path: string, j: Jar) => http.get(path).set('Host', HOST).set('Cookie', j.cookie);
const send = (method: 'post' | 'put', path: string, j: Jar) => http[method](path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
const lastAudit = async (action: string, id: string) => (await su<{ summary: Record<string, unknown> }>(
  `select change_summary as summary from app.audit_log where action = $1 and resource_id = $2 order by seq desc limit 1`, [action, id]))[0]?.summary;

let admin: Jar, kasir: Jar;
beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  let j = await login('admin@a.test');                                      // TENANT_ADMIN: wajib MFA (OD-080)
  const e = await send('post', '/api/v1/auth/mfa/enroll', j);
  const secret = new URL(e.body.otpauthUrl).searchParams.get('secret')!;
  const v = await send('post', '/api/v1/auth/mfa/verify', j).send({ code: await freshTotp(secret) });
  expect(v.status).toBe(200);
  admin = j = jar(v, j);
  kasir = await login('kasir@a.test');
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('Fasilitas, cabang, poli/unit (MST-FR-001, MST-FR-009)', () => {
  test('M01 fasilitas: tambah & ubah dengan If-Match (428 tanpa, 412 versi lama); audit berisi sebelum/sesudah', async () => {
    const c = await send('post', '/api/v1/facilities', admin).send({ name: 'Klinik Pratama Sehat', facilityType: 'KLINIK_PRATAMA', licenseNumber: '' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: 'Klinik Pratama Sehat', licenseNumber: null, isActive: true, version: 1 });
    expect((await lastAudit('FACILITY_CREATED', c.body.id))?.after).toMatchObject({ name: 'Klinik Pratama Sehat' });
    const id = c.body.id;
    expect((await send('put', `/api/v1/facilities/${id}`, admin).send({ licenseNumber: 'IZ-01' })).status).toBe(428);
    const u = await send('put', `/api/v1/facilities/${id}`, admin).set('If-Match', '"1"').send({ licenseNumber: 'IZ-01' });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ name: 'Klinik Pratama Sehat', licenseNumber: 'IZ-01', version: 2 });
    expect(u.headers.etag).toBe('"2"');
    expect((await send('put', `/api/v1/facilities/${id}`, admin).set('If-Match', '"1"').send({ name: 'Lain' })).body.code).toBe('GEN-412-VERSION');
    expect(await lastAudit('FACILITY_UPDATED', id)).toEqual({ changed: ['licenseNumber'],
      before: { licenseNumber: null }, after: { licenseNumber: 'IZ-01' } });
    const list = await get('/api/v1/facilities', kasir);
    expect(list.status).toBe(200);
    expect(list.body.map((f: { id: string }) => f.id)).toEqual(expect.arrayContaining([FACILITY_A, id]));
  });

  test('M02 cabang: kode unik (409), fasilitas/wilayah tak dikenal (400), nonaktif disembunyikan dari daftar default', async () => {
    const body = { facilityId: FACILITY_A, code: 'cbg2', name: 'Cabang Dua', timezone: 'Asia/Makassar' };
    const c = await send('post', '/api/v1/branches', admin).send(body);
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ code: 'CBG2', timezone: 'Asia/Makassar', isActive: true });
    expect((await send('post', '/api/v1/branches', admin).send({ ...body, code: 'CBG1' })).body.code).toBe('MST-409-CODE');
    expect((await send('post', '/api/v1/branches', admin).send({ ...body, code: 'CBG3', facilityId: '00000000-0000-4000-8000-000000000000' })).body.code).toBe('MST-400-FACILITY');
    expect((await send('post', '/api/v1/branches', admin).send({ ...body, code: 'CBG3', regionCode: '99.99' })).body.code).toBe('MST-400-REGION');
    // PUT parsial: timezone tidak dikirim → tetap (bukan kembali ke default)
    const off = await send('put', `/api/v1/branches/${c.body.id}`, admin).set('If-Match', '"1"').send({ isActive: false });
    expect(off.body).toMatchObject({ isActive: false, timezone: 'Asia/Makassar', name: 'Cabang Dua' });
    expect((await get('/api/v1/branches', admin)).body.map((b: { code: string }) => b.code)).not.toContain('CBG2');
    expect((await get('/api/v1/branches?includeInactive=true', admin)).body.map((b: { code: string }) => b.code)).toContain('CBG2');
    expect((await lastAudit('BRANCH_UPDATED', c.body.id))).toEqual({ changed: ['isActive'], before: { isActive: true }, after: { isActive: false } });
  });

  test('M03 kuota cabang paket ditegakkan saat tambah & aktifkan ulang (PLT-FR-004)', async () => {
    const active = Number((await su(`select count(*) from app.branch where tenant_id = $1 and is_active`, [ids.tenantA]))[0].count);
    // Klinik uji belum berlangganan: pasang paket uji dengan batas = jumlah cabang aktif sekarang
    const [plan] = await su<{ id: string }>(`insert into app.subscription_plan(code, name, max_users, max_branches, features, monthly_price)
                                              values ('UJI-M03', 'Paket uji', 100, $1, '{}', 0) returning id`, [active]);
    await su(`insert into app.tenant_subscription(tenant_id, plan_id, start_at) values ($1, $2, now())`, [ids.tenantA, plan.id]);
    const r = await send('post', '/api/v1/branches', admin).send({ facilityId: FACILITY_A, code: 'CBG9', name: 'Cabang Sembilan' });
    expect([r.status, r.body.code]).toEqual([403, 'PLT-403-QUOTA']);
    const [b2] = await su<{ id: string; version: number }>(`select id, version from app.branch where tenant_id = $1 and code = 'CBG2'`, [ids.tenantA]);
    const re = await send('put', `/api/v1/branches/${b2.id}`, admin).set('If-Match', `"${b2.version}"`).send({ isActive: true });
    expect(re.body.code).toBe('PLT-403-QUOTA');
    await su(`delete from app.tenant_subscription where tenant_id = $1 and plan_id = $2`, [ids.tenantA, plan.id]);
  });

  test('M04 poli/unit: kode unik per cabang, filter per cabang; cabang tenant lain tidak dapat dipakai', async () => {
    const c = await send('post', '/api/v1/service-units', admin).send({ branchId: BRANCH_A, code: 'gigi', name: 'Poli Gigi', unitType: 'POLI', specialty: 'Gigi' });
    expect(c.status).toBe(201);
    expect((await send('post', '/api/v1/service-units', admin).send({ branchId: BRANCH_A, code: 'UMUM', name: 'Dobel', unitType: 'POLI' })).body.code).toBe('MST-409-CODE');
    expect((await send('post', '/api/v1/service-units', admin).send({ branchId: BRANCH_B, code: 'X1', name: 'Curang', unitType: 'POLI' })).body.code).toBe('MST-400-BRANCH');
    const list = await get(`/api/v1/service-units?branchId=${BRANCH_A}`, kasir);
    expect(list.body.map((u: { code: string }) => u.code)).toEqual(expect.arrayContaining(['UMUM', 'GIGI']));
    const u = await send('put', `/api/v1/service-units/${c.body.id}`, admin).set('If-Match', '"1"').send({ name: 'Poli Gigi & Mulut' });
    expect(u.body).toMatchObject({ name: 'Poli Gigi & Mulut', specialty: 'Gigi', unitType: 'POLI', version: 2 });
  });

  test('M05 isolasi tenant: cabang/nakes tenant lain → 404 (bukan 403); kasir hanya baca (manage → 403)', async () => {
    expect((await send('put', `/api/v1/branches/${BRANCH_B}`, admin).set('If-Match', '"1"').send({ name: 'Curang' })).body.code).toBe('MST-404-BRANCH');
    expect((await get(`/api/v1/practitioners/${PRACT_B}`, admin)).status).toBe(404);
    expect((await get('/api/v1/branches', admin)).body.map((b: { id: string }) => b.id)).not.toContain(BRANCH_B);
    expect((await send('post', '/api/v1/facilities', kasir).send({ name: 'x', facilityType: 'KLINIK_PRATAMA' })).status).toBe(403);
    expect((await get('/api/v1/practitioners', kasir)).status).toBe(200);
  });
});

describe('Tenaga kesehatan (MST-FR-002)', () => {
  let id = '';
  test('M06 tambah dengan NIK: tersimpan terenkripsi + HMAC, respons hanya NIK tersamar, audit tanpa NIK', async () => {
    const r = await send('post', '/api/v1/practitioners', admin).send({ fullName: 'dr. Sinta Sintetis', nik: NIK, practitionerType: 'DOKTER',
      strNumber: 'STR-001', strValidUntil: '2030-12-31', sipNumber: 'SIP-001', sipValidUntil: '2027-06-30' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ fullName: 'dr. Sinta Sintetis', nikMasked: '3201********0001', sipValidUntil: '2027-06-30', linkedUserId: null });
    expect(JSON.stringify(r.body)).not.toContain(NIK);
    id = r.body.id;
    const [row] = await su<{ nik_encrypted: Buffer; nik_hash: string }>(`select nik_encrypted, nik_hash from app.practitioner where id = $1`, [id]);
    expect(row.nik_encrypted.toString('latin1')).not.toContain(NIK);
    expect(row.nik_hash).toMatch(/^[0-9a-f]{64}$/);
    const a = await lastAudit('PRACTITIONER_CREATED', id);
    expect(JSON.stringify(a)).not.toContain(NIK);
    expect((a as { after: { nik: string } }).after.nik).toBe('[rahasia]');
  });

  test('M07 validasi: NIK ganda 409, format NIK/tanggal salah 400, jenis tak dikenal 400', async () => {
    expect((await send('post', '/api/v1/practitioners', admin).send({ fullName: 'Orang Lain', nik: NIK, practitionerType: 'PERAWAT' })).body.code).toBe('MST-409-NIK');
    for (const bad of [{ nik: '12345' }, { nik: '0001011201900001' }, { sipValidUntil: '2027-02-30' }, { practitionerType: 'DUKUN' }]) {
      const r = await send('post', '/api/v1/practitioners', admin).send({ fullName: 'Uji Validasi', practitionerType: 'PERAWAT', ...bad });
      expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 400]);
    }
  });

  test('M08 ubah sebagian: field tak dikirim tetap; NIK tak dikirim tetap, null menghapus; audit hanya kolom berubah', async () => {
    const u = await send('put', `/api/v1/practitioners/${id}`, admin).set('If-Match', '"1"').send({ sipNumber: 'SIP-002', sipValidUntil: '2028-06-30' });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ sipNumber: 'SIP-002', strNumber: 'STR-001', nikMasked: '3201********0001', version: 2 });
    expect(await lastAudit('PRACTITIONER_UPDATED', id)).toEqual({ changed: ['sipNumber', 'sipValidUntil'],
      before: { sipNumber: 'SIP-001', sipValidUntil: '2027-06-30' }, after: { sipNumber: 'SIP-002', sipValidUntil: '2028-06-30' } });
    const n = await send('put', `/api/v1/practitioners/${id}`, admin).set('If-Match', '"2"').send({ nik: null });
    expect(n.body.nikMasked).toBeNull();
    expect((await lastAudit('PRACTITIONER_UPDATED', id))).toEqual({ changed: ['nik'], before: { nik: '[rahasia]' }, after: { nik: null } });
    // NIK yang dilepas dapat dipakai tenaga kesehatan lain
    expect((await send('post', '/api/v1/practitioners', admin).send({ fullName: 'Pemilik Baru', nik: NIK, practitionerType: 'BIDAN' })).status).toBe(201);
  });

  test('M09 daftar: cari nama/SIP, filter jenis & belum tertaut akun, halaman berikutnya', async () => {
    const q = await get('/api/v1/practitioners?q=sinta', kasir);
    expect(q.body.data.map((p: { fullName: string }) => p.fullName)).toEqual(['dr. Sinta Sintetis']);
    expect((await get('/api/v1/practitioners?q=SIP-002', kasir)).body.data).toHaveLength(1);
    expect((await get('/api/v1/practitioners?q=100%25', kasir)).body.data).toHaveLength(0);           // % tidak jadi wildcard
    const dokter = await get('/api/v1/practitioners?type=DOKTER', kasir);
    expect(dokter.body.data.every((p: { practitionerType: string }) => p.practitionerType === 'DOKTER')).toBe(true);
    const unlinked = await get('/api/v1/practitioners?unlinked=true', admin);
    expect(unlinked.body.data.map((p: { fullName: string }) => p.fullName)).not.toContain('dr. Uji a');    // tertaut ke dokter@a.test
    const p1 = await get('/api/v1/practitioners?limit=1', admin);
    expect(p1.body.page).toMatchObject({ hasMore: true, nextCursor: '1' });
    const p2 = await get(`/api/v1/practitioners?limit=1&cursor=${p1.body.page.nextCursor}`, admin);
    expect(p2.body.data[0].id).not.toBe(p1.body.data[0].id);
    expect((await get('/api/v1/practitioners?cursor=abc', admin)).status).toBe(400);
  });

  test('M10 menu master tampil sesuai permission (IAM-FR-010)', async () => {
    const m = await get('/api/v1/me/menu', admin);
    const master = m.body.find((n: { code: string }) => n.code === 'master');
    expect(master.children.map((c: { code: string }) => c.code)).toEqual(['master.organization', 'master.practitioners']);
  });
});
