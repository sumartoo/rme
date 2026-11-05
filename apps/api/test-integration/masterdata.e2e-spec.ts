import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { join } from 'node:path';
import { loadReference } from '@clinicrme/db/reference';
import ExcelJS from 'exceljs';
import { PASSWORD, REPO, ids, ownerUrl, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';
import { freshTotp } from './support/totp';

/**
 * Master data Stage 7 batch 1: fasilitas, cabang, poli/unit (MST-FR-001), tenaga kesehatan (MST-FR-002), audit
 * sebelum/sesudah (MST-FR-009), optimistic locking (GEN-FR-007), kuota cabang (PLT-FR-004), isolasi tenant.
 * NIK tenaga kesehatan: terenkripsi, tidak pernah utuh di respons maupun audit. Batch 2: layanan (MST-FR-004), tarif
 * berperiode (MST-FR-005), penjamin (MST-FR-006), satuan & konversi (MST-FR-007), supplier (MST-FR-010). Batch 3: wilayah
 * (MST-FR-011), ICD-10/ICD-9-CM (TRM-FR-001/002/004) & favorit tervalidasi dokter (TRM-FR-003, OD-084). Data sintetis saja.
 */
const HOST = 'klinik-a.clinicrme.test';
const FACILITY_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const BRANCH_A = 'aaaaaaaa-0000-0000-0000-000000000010';
const BRANCH_B = 'bbbbbbbb-0000-0000-0000-000000000010';
const PRACT_B = 'bbbbbbbb-0000-0000-0000-000000000020';
const SERVICE_A = 'aaaaaaaa-0000-0000-0000-000000000031';
const PAYER_UMUM_A = 'aaaaaaaa-0000-0000-0000-000000000030';
const UOM_TAB_A = 'aaaaaaaa-0000-0000-0000-000000000040';
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
const send = (method: 'post' | 'put' | 'delete', path: string, j: Jar) => http[method](path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
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
    expect(master.children.map((c: { code: string }) => c.code)).toEqual(expect.arrayContaining(['master.organization', 'master.practitioners']));
  });
});

describe('Layanan & tarif (MST-FR-004, MST-FR-005)', () => {
  test('M11 layanan: tambah, kode unik, ubah dengan If-Match, cari & filter jenis', async () => {
    const c = await send('post', '/api/v1/service-items', admin).send({ code: 'tdk-jahit', name: 'Jahit Luka', serviceType: 'TINDAKAN', icd9cmCode: '86.59' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ code: 'TDK-JAHIT', icd9cmCode: '86.59', isActive: true });
    expect((await send('post', '/api/v1/service-items', admin).send({ code: 'KONS', name: 'Dobel', serviceType: 'KONSULTASI' })).body.code).toBe('MST-409-CODE');
    expect((await send('post', '/api/v1/service-items', admin).send({ code: 'X1', name: 'ICD salah', serviceType: 'TINDAKAN', icd9cmCode: 'abc' })).status).toBe(400);
    const u = await send('put', `/api/v1/service-items/${c.body.id}`, admin).set('If-Match', '"1"').send({ name: 'Hecting / Jahit Luka' });
    expect(u.body).toMatchObject({ name: 'Hecting / Jahit Luka', serviceType: 'TINDAKAN', version: 2 });
    expect((await get('/api/v1/service-items?q=jahit', kasir)).body.data.map((x: { code: string }) => x.code)).toEqual(['TDK-JAHIT']);
    expect((await get('/api/v1/service-items?type=KONSULTASI', kasir)).body.data.map((x: { code: string }) => x.code)).toEqual(['KONS']);
  });

  test('M12 tarif: periode tidak boleh tumpang tindih; harga Rupiah bulat; tarif per cabang & per penjamin terpisah', async () => {
    const base = { serviceItemId: SERVICE_A, price: '75000', validFrom: '2026-01-01' };
    const t1 = await send('post', '/api/v1/tariffs', admin).send(base);
    expect(t1.status).toBe(201);
    expect(t1.body).toMatchObject({ price: '75000.00', validTo: null, branchId: null, payerType: null });
    expect((await send('post', '/api/v1/tariffs', admin).send({ ...base, validFrom: '2026-06-01' })).body.code).toBe('MST-409-OVERLAP');
    expect((await send('post', '/api/v1/tariffs', admin).send({ ...base, price: '75000.50' })).status).toBe(400);
    // Kunci berbeda (cabang tertentu / penjamin tertentu) boleh di periode yang sama
    expect((await send('post', '/api/v1/tariffs', admin).send({ ...base, branchId: BRANCH_A, price: 80000 })).status).toBe(201);
    const byPayer = await send('post', '/api/v1/tariffs', admin).send({ ...base, payerId: PAYER_UMUM_A, price: '70000' });
    expect(byPayer.body).toMatchObject({ payerId: PAYER_UMUM_A, payerType: 'UMUM' });                     // kategori dari penjamin
    expect((await send('post', '/api/v1/tariffs', admin).send({ ...base, payerId: PAYER_UMUM_A, payerType: 'ASURANSI' })).body.code).toBe('MST-400-PAYER');
    expect((await send('post', '/api/v1/tariffs', admin).send({ ...base, branchId: BRANCH_B })).body.code).toBe('MST-400-BRANCH');
  });

  test('M13 harga baru = periode baru (closePrevious); periode lama tertutup, tidak ditimpa; berlaku-pada-tanggal benar', async () => {
    const t = await send('post', '/api/v1/tariffs', admin).send({ serviceItemId: SERVICE_A, price: '90000', validFrom: '2026-07-01', closePrevious: true });
    expect(t.status).toBe(201);
    const june = await get(`/api/v1/tariffs?serviceItemId=${SERVICE_A}&on=2026-06-30`, kasir);
    const july = await get(`/api/v1/tariffs?serviceItemId=${SERVICE_A}&on=2026-07-01`, kasir);
    const general = (r: request.Response) => r.body.data.filter((x: { branchId: string | null; payerType: string | null }) => !x.branchId && !x.payerType);
    expect(general(june)).toEqual([expect.objectContaining({ price: '75000.00', validFrom: '2026-01-01', validTo: '2026-06-30' })]);
    expect(general(july)).toEqual([expect.objectContaining({ price: '90000.00', validFrom: '2026-07-01', validTo: null })]);
    const [old] = general(june);
    expect(await lastAudit('TARIFF_ENDED', old.id)).toEqual({ changed: ['validTo'], before: { validTo: null }, after: { validTo: '2026-06-30' } });
    // Database menolak penimpaan harga bahkan lewat SQL langsung oleh role aplikasi (trigger 0012)
    await expect(su(`set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);
                     update app.tariff set price = 1 where id = '${old.id}'`)).rejects.toThrow(/MST-409-TARIFF-IMMUTABLE/);
    await expect(su(`set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);
                     delete from app.tariff where id = '${old.id}'`)).rejects.toThrow(/permission denied/);
  });

  test('M14 tutup periode: hanya dapat dimajukan; tidak boleh sebelum tanggal mulai atau diperpanjang', async () => {
    const t = await send('post', '/api/v1/tariffs', admin).send({ serviceItemId: SERVICE_A, payerType: 'ASURANSI', price: '120000', validFrom: '2026-03-01' });
    const end = (validTo: string) => send('post', `/api/v1/tariffs/${t.body.id}/end`, admin).send({ validTo });
    expect((await end('2026-02-01')).body.code).toBe('MST-400-TARIFF-DATE');
    expect((await end('2026-12-31')).body).toMatchObject({ validTo: '2026-12-31' });
    expect((await end('2027-06-30')).body.code).toBe('MST-409-TARIFF-IMMUTABLE');
    expect((await end('2026-09-30')).body).toMatchObject({ validTo: '2026-09-30' });
    expect((await send('post', `/api/v1/tariffs/${t.body.id}/end`, kasir).send({ validTo: '2026-08-01' })).status).toBe(403);
  });
});

describe('Penjamin, satuan, supplier (MST-FR-006, 007, 010)', () => {
  test('M15 penjamin: kontrak tervalidasi & tersimpan; kategori terkunci bila sudah dipakai tarif', async () => {
    const c = await send('post', '/api/v1/payers', admin).send({ code: 'asr-sehat', name: 'Asuransi Sehat Sintetis', payerType: 'ASURANSI',
      contract: { contractNumber: 'K-001', plafon: '5000000', copayPercent: 10, paymentTermDays: 30 } });
    expect(c.status).toBe(201);
    expect(c.body.contract).toEqual({ contractNumber: 'K-001', plafon: '5000000', copayPercent: 10, paymentTermDays: 30 });
    expect((await send('post', '/api/v1/payers', admin).send({ code: 'X2', name: 'Salah', payerType: 'ASURANSI', contract: { copayPercent: 150 } })).status).toBe(400);
    const u = await send('put', `/api/v1/payers/${c.body.id}`, admin).set('If-Match', '"1"').send({ contract: { contractNumber: 'K-001', plafon: '7500000' } });
    expect(u.body.contract).toEqual({ contractNumber: 'K-001', plafon: '7500000' });
    expect((await send('put', `/api/v1/payers/${PAYER_UMUM_A}`, admin).set('If-Match', '"1"').send({ payerType: 'PERUSAHAAN' })).body.code).toBe('MST-409-PAYER-TYPE');
    expect((await get('/api/v1/payers?type=ASURANSI', kasir)).body.map((p: { code: string }) => p.code)).toEqual(['ASR-SEHAT']);
  });

  test('M16 satuan & konversi: 1 BOX = 10 STRIP = 100 TAB; konversi melingkar ditolak; hapus konversi', async () => {
    const mk = async (code: string, name: string) => (await send('post', '/api/v1/uoms', admin).send({ code, name })).body;
    const box = await mk('box', 'Box');
    const strip = await mk('STRIP', 'Strip');
    expect((await send('post', '/api/v1/uoms', admin).send({ code: 'TAB', name: 'Dobel' })).body.code).toBe('MST-409-CODE');
    const set = (from: string, to: string, factor: string | number) => send('put', `/api/v1/uoms/${from}/conversions/${to}`, admin).send({ factor });
    expect((await set(box.id, strip.id, 10)).body).toEqual({ fromUomId: box.id, toUomId: strip.id, factor: '10' });
    expect((await set(strip.id, UOM_TAB_A, '10.0')).body.factor).toBe('10');
    expect((await set(UOM_TAB_A, box.id, '0.01')).body.code).toBe('MST-409-UOM-CYCLE');        // TAB → BOX menutup lingkaran
    expect((await set(strip.id, box.id, '0.1')).body.code).toBe('MST-409-UOM-CYCLE');
    expect((await set(box.id, box.id, 1)).body.code).toBe('MST-400-UOM-SELF');
    expect((await set(box.id, strip.id, 0)).status).toBe(400);
    const list = await get('/api/v1/uoms', kasir);
    expect(list.body.find((u: { code: string }) => u.code === 'BOX').conversions).toEqual([{ toUomId: strip.id, factor: '10' }]);
    expect((await send('delete', `/api/v1/uoms/${strip.id}/conversions/${UOM_TAB_A}`, admin)).status).toBe(204);
    expect((await set(UOM_TAB_A, strip.id, '0.1')).status).toBe(200);                          // tanpa jalur STRIP → TAB, kini boleh
    const u = await send('put', `/api/v1/uoms/${box.id}`, admin).set('If-Match', '"1"').send({ name: 'Kotak' });
    expect(u.body).toMatchObject({ code: 'BOX', name: 'Kotak', version: 2 });
  });

  test('M17 supplier: tambah, ubah, cari; NPWP/email divalidasi; izin kelola admin & farmasi (bukan kasir)', async () => {
    const c = await send('post', '/api/v1/suppliers', admin).send({ code: 'pbf-01', name: 'PBF Sintetis Jaya', npwp: '01.234.567.8-901.000', email: 'Order@PBF.test', phone: '' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ code: 'PBF-01', email: 'order@pbf.test', phone: null });
    expect((await send('post', '/api/v1/suppliers', admin).send({ name: 'NPWP salah', npwp: '123' })).status).toBe(400);
    const u = await send('put', `/api/v1/suppliers/${c.body.id}`, admin).set('If-Match', '"1"').send({ contactPerson: 'Bu Sinta' });
    expect(u.body).toMatchObject({ contactPerson: 'Bu Sinta', npwp: '01.234.567.8-901.000' });
    expect((await get('/api/v1/suppliers?q=sintetis', kasir)).body).toHaveLength(1);
    expect((await send('post', '/api/v1/suppliers', kasir).send({ name: 'Tidak boleh' })).status).toBe(403);
    const perms = await su<{ code: string; perms: string[] }>(`select r.code, array_agg(rp.permission_code order by rp.permission_code) as perms from app.role r
      join app.role_permission rp on rp.role_id = r.id where r.tenant_id = $1 and rp.permission_code in ('master.supplier.manage', 'master.uom.manage')
      group by r.code order by r.code`, [ids.tenantA]);
    expect(perms).toEqual([{ code: 'FARMASI', perms: ['master.supplier.manage', 'master.uom.manage'] },
                           { code: 'TENANT_ADMIN', perms: ['master.supplier.manage', 'master.uom.manage'] }]);
  });

  test('M18 menu master batch 2 tampil untuk admin', async () => {
    const m = await get('/api/v1/me/menu', admin);
    const master = m.body.find((n: { code: string }) => n.code === 'master');
    expect(master.children.map((c: { code: string }) => c.code)).toEqual(['master.organization', 'master.practitioners', 'master.services', 'master.payers', 'master.supplies', 'master.terminology', 'master.transfer']);
  });
});

describe('Data referensi, terminologi & wilayah (TRM-FR-001–004, MST-FR-011)', () => {
  let loaded: Awaited<ReturnType<typeof loadReference>>;
  let dokter: Jar;
  beforeAll(async () => {
    loaded = await loadReference(ownerUrl(), join(REPO, 'db', 'reference'));
    dokter = await login('dokter@a.test');                         // tertaut ke tenaga kesehatan "dr. Uji a" (DOKTER)
  }, 120_000);
  const concept = async (system: string, code: string) => (await su<{ id: string }>(`select c.id from app.concept c join app.code_system s
    on s.id = c.system_id and s.is_current where s.code = $1 and c.code = $2`, [system, code]))[0].id;

  test('M19 pemuat referensi: wilayah 91.599 baris & ICD contoh dimuat dengan sumber/versi/lisensi; dijalankan ulang = dilewati; sha256 salah ditolak', async () => {
    expect(loaded.map((l) => [l.id, l.status])).toEqual([['region', 'loaded'], ['ICD10', 'loaded'], ['ICD9CM', 'loaded']]);
    expect(loaded[0].rows).toBe(91599);
    const again = await loadReference(ownerUrl(), join(REPO, 'db', 'reference'));
    expect(again.map((l) => l.status)).toEqual(['skipped', 'skipped', 'skipped']);
    const [ds] = await su(`select version, license from app.reference_dataset where id = 'region'`);
    expect(ds).toMatchObject({ version: expect.stringContaining('300.2.2-2138'), license: expect.stringContaining('MIT') });
    const levels = await su<{ level: number; n: number }>(`select level, count(*)::int as n from app.region group by level order by level`);
    expect(levels).toEqual([{ level: 1, n: 38 }, { level: 2, n: 514 }, { level: 3, n: 7285 }, { level: 4, n: 83762 }]);
    const cs = await get('/api/v1/terminology/code-systems', kasir);
    expect(cs.body).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ICD10', isCurrent: true, isSample: true, conceptCount: 40 })]));
  });

  test('M20 wilayah berjenjang: provinsi → kab/kota → kecamatan → desa; cari nama; data global hanya-baca bagi aplikasi', async () => {
    const prov = await get('/api/v1/regions', kasir);
    expect(prov.body).toHaveLength(38);
    expect(prov.body[0]).toEqual({ code: '11', name: 'Aceh', level: 1 });
    const jabar = await get('/api/v1/regions?parent=32&q=bandung', kasir);
    expect(jabar.body.map((r: { name: string }) => r.name)).toEqual(expect.arrayContaining(['Kabupaten Bandung', 'Kota Bandung']));
    const kec = await get(`/api/v1/regions?parent=${jabar.body[0].code}`, kasir);
    expect(kec.body.every((r: { level: number }) => r.level === 3)).toBe(true);
    expect((await get('/api/v1/regions?parent=32.04.0', kasir)).status).toBe(400);
    await expect(su(`set role clinicrme_app; update app.region set name = 'x' where code = '11'`)).rejects.toThrow(/permission denied/);
    // Cabang kini dapat memakai kode wilayah (MST-FR-011)
    const desa = (await get(`/api/v1/regions?parent=${kec.body[0].code}`, kasir)).body[0];
    const b = await send('post', '/api/v1/branches', admin).send({ facilityId: FACILITY_A, code: 'CBG-WIL', name: 'Cabang Wilayah', regionCode: desa.code });
    expect([b.status, b.body.regionCode]).toEqual([201, desa.code]);
  });

  test('M21 cari ICD-10 berdasarkan kode, kata kunci, dan sinonim; ICD-9-CM terpisah; kode asli tidak berubah', async () => {
    const names = (r: request.Response) => r.body.map((c: { code: string }) => c.code);
    expect(names(await get('/api/v1/terminology/concepts?q=J0', kasir))).toEqual(['J00', 'J02.9', 'J06.9']);
    expect(names(await get('/api/v1/terminology/concepts?q=i10', kasir))[0]).toBe('I10');
    expect(names(await get('/api/v1/terminology/concepts?q=darah%20tinggi', kasir))).toEqual(['I10']);        // sinonim
    expect(names(await get('/api/v1/terminology/concepts?q=tifoid', kasir))).toEqual(['A01.0']);
    expect(names(await get('/api/v1/terminology/concepts?system=ICD9CM&q=jahit', kasir))).toEqual(['86.59']);
    expect((await get('/api/v1/terminology/concepts?q=jahit', kasir)).body).toEqual([]);                        // tidak tercampur
    expect((await get('/api/v1/terminology/concepts?system=LOINC', kasir)).status).toBe(400);
    await expect(su(`set role clinicrme_app; update app.concept set display_id = 'x'`)).rejects.toThrow(/permission denied/);
  });

  test('M22 favorit: admin menandai; validasi hanya dokter tertaut dengan SIP berlaku (OD-084); ubah spesialisasi = validasi ulang', async () => {
    const i10 = await concept('ICD10', 'I10');
    const fav = (j: Jar, body: object) => send('put', `/api/v1/terminology/favorites/${i10}`, j).send(body);
    expect((await fav(admin, { specialty: 'Umum' })).status).toBe(204);
    expect((await fav(admin, { validated: true })).body.code).toBe('TRM-403-VALIDATOR');              // admin bukan dokter
    expect((await fav(dokter, { validated: true })).body.code).toBe('TRM-403-SIP');                    // SIP dr. Uji a belum diisi
    await su(`update app.practitioner set sip_number = 'SIP-UJI', sip_valid_until = current_date + 30 where id = 'aaaaaaaa-0000-0000-0000-000000000020'`);
    expect((await fav(dokter, { validated: true })).status).toBe(204);
    let r = await get('/api/v1/terminology/concepts?favorites=validated', kasir);
    expect(r.body).toEqual([expect.objectContaining({ code: 'I10', isFavorite: true, favorite: expect.objectContaining({ validated: true, validatedBy: 'dr. Uji', specialty: 'Umum' }) })]);
    expect((await fav(admin, { specialty: 'Penyakit dalam' })).status).toBe(204);
    expect((await get('/api/v1/terminology/concepts?favorites=validated', kasir)).body).toEqual([]);   // perlu validasi ulang
    r = await get('/api/v1/terminology/concepts?favorites=all', kasir);
    expect(r.body.map((c: { code: string; favorite: { validated: boolean } }) => [c.code, c.favorite.validated])).toEqual([['I10', false]]);
    await su(`update app.practitioner set sip_valid_until = current_date - 1 where id = 'aaaaaaaa-0000-0000-0000-000000000020'`);
    expect((await fav(dokter, { validated: true })).body.code).toBe('TRM-403-SIP');                    // SIP kedaluwarsa
    expect((await send('put', `/api/v1/terminology/favorites/${i10}`, kasir).send({})).status).toBe(403);
    // Favorit milik klinik: klinik lain tidak melihat
    const lb = await http.post('/api/v1/auth/login').set('Host', 'klinik-b.clinicrme.test').send({ email: 'dokter@b.test', password: PASSWORD });
    expect(lb.status).toBe(200);
    const favB = await http.get('/api/v1/terminology/concepts?favorites=all').set('Host', 'klinik-b.clinicrme.test').set('Cookie', jar(lb).cookie);
    expect([favB.status, favB.body]).toEqual([200, []]);
    expect((await send('delete', `/api/v1/terminology/favorites/${i10}`, admin)).status).toBe(204);
    expect((await send('delete', `/api/v1/terminology/favorites/${i10}`, admin)).body.code).toBe('TRM-404-CONCEPT');
    expect((await lastAudit('TERMINOLOGY_FAVORITE_REMOVED', i10))?.before).toMatchObject({ specialty: 'Penyakit dalam' });   // resource_id = konsep
  });
});

describe('Impor/ekspor master data (MST-FR-008, OD-083)', () => {
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const imp = (entity: string, body: string | Buffer, opts: { dryRun?: boolean; type?: string; j?: Jar } = {}) =>
    send('post', `/api/v1/imports/${entity}?dryRun=${opts.dryRun ?? true}`, opts.j ?? admin).set('Content-Type', opts.type ?? 'text/csv').send(Buffer.from(body));
  const csvText = (r: request.Response) => (r.body as Buffer).toString('utf8');
  const download = (path: string, j: Jar = admin) => get(path, j).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

  test('M23 template & ekspor CSV: BOM, kolom tetap, nilai berawalan = diberi petik (cegah formula injection), ekspor teraudit', async () => {
    const t = await download('/api/v1/exports/service-items?template=true');
    expect(t.status).toBe(200);
    expect(t.headers['content-disposition']).toContain('service-items-template.csv');
    expect(csvText(t)).toBe('\ufeffcode,name,serviceType,icd9cmCode,isActive\r\n');
    await send('post', '/api/v1/suppliers', admin).send({ code: 'EVIL', name: '=HYPERLINK("http://x","klik")' });
    const e = await download('/api/v1/exports/suppliers');
    expect(csvText(e)).toContain(`EVIL,"'=HYPERLINK(""http://x"",""klik"")"`);
    expect((await su(`select count(*)::int as n from app.audit_log where action = 'MASTER_EXPORTED'`))[0].n).toBeGreaterThan(0);
    expect((await download('/api/v1/exports/practitioners')).status).toBe(200);
    expect((await get('/api/v1/exports/rahasia', admin)).body.code).toBe('MST-404-ENTITY');
    expect((await get('/api/v1/exports/suppliers', kasir)).status).toBe(403);
  });

  test('M24 impor layanan: dry-run melaporkan error per baris tanpa menyimpan; commit hanya bila semua valid (satu transaksi)', async () => {
    const bad = 'code,name,serviceType,isActive\nIMP-1,Imunisasi,TINDAKAN,ya\nIMP-2,X,TINDAKAN,\nIMP-3,Rontgen,RADIOLOGI,\nIMP-1,Dobel,TINDAKAN,\nIMP-4,Lab darah,LAB,mungkin\n';
    const r = await imp('service-items', bad, { dryRun: false });
    expect(r.body).toMatchObject({ status: 'FAILED', dryRun: false, rowCount: 5 });
    expect(r.body.errors.map((x: { row: number; field: string }) => [x.row, x.field])).toEqual([[3, 'name'], [4, 'serviceType'], [5, ''], [6, 'isActive']]);
    expect((await su(`select count(*)::int as n from app.service_item where code like 'IMP-%'`))[0].n).toBe(0);         // tidak ada yang tersimpan
    const good = 'code;name;serviceType;isActive\r\nimp-1;Imunisasi;tindakan;ya\r\nKONS;Konsultasi Dokter Umum;KONSULTASI;\r\n';   // titik koma (Excel lokal)
    const dry = await imp('service-items', good);
    expect(dry.body).toMatchObject({ status: 'VALIDATED', created: 1, updated: 1, errors: [] });
    expect((await su(`select count(*)::int as n from app.service_item where code = 'IMP-1'`))[0].n).toBe(0);
    const ok = await imp('service-items', good, { dryRun: false });
    expect(ok.body).toMatchObject({ status: 'COMMITTED', created: 1, updated: 1 });
    const [kons] = await su<{ id: string; name: string }>(`select id, name from app.service_item where tenant_id = $1 and code = 'KONS'`, [ids.tenantA]);
    expect(kons.name).toBe('Konsultasi Dokter Umum');
    expect(await lastAudit('SERVICE_ITEM_UPDATED', kons.id)).toMatchObject({ changed: ['name'], before: { name: 'Konsultasi Umum' } });
    expect((await su(`select change_summary as s from app.audit_log where action = 'MASTER_IMPORTED' order by seq desc limit 1`))[0].s)
      .toEqual({ entity: 'service-items', rows: 2, created: 1, updated: 1 });
  });

  test('M25 impor tarif: periode bertabrakan dilaporkan per baris (validasi berlanjut), closePrevious; tanpa error → tersimpan', async () => {
    const csv = ['serviceCode,branchCode,payerType,payerCode,price,validFrom,validTo,closePrevious',
      'IMP-1,,,,50000,2026-01-01,,',                    // baru
      'IMP-1,,,,55000,2026-06-01,,',                    // tumpang tindih tanpa closePrevious → error
      'TIDAKADA,,,,1000,2026-01-01,,',                 // layanan tak dikenal
      `IMP-1,CBG1,,UMUM,45.000,2026-01-01,2026-12-31,`, // per cabang & penjamin, harga bertitik ribuan
    ].join('\n');
    const r = await imp('tariffs', csv, { dryRun: false });
    expect(r.body.status).toBe('FAILED');
    expect(r.body.errors.map((x: { row: number; field: string }) => [x.row, x.field])).toEqual([[3, 'validFrom'], [4, 'serviceCode']]);
    const ok = await imp('tariffs', csv.replace('IMP-1,,,,55000,2026-06-01,,', 'IMP-1,,,,55000,2026-06-01,,ya').replace('TIDAKADA,,,,1000,2026-01-01,,\n', ''), { dryRun: false });
    expect(ok.body).toMatchObject({ status: 'COMMITTED', created: 3 });
    const t = await su<{ price: string; valid_to: string | null }>(`select t.price::text, to_char(t.valid_to, 'YYYY-MM-DD') as valid_to from app.tariff t
      join app.service_item s on s.id = t.service_item_id where s.code = 'IMP-1' and t.branch_id is null order by t.valid_from`);
    expect(t).toEqual([{ price: '50000.00', valid_to: '2026-05-31' }, { price: '55000.00', valid_to: null }]);
  });

  test('M26 impor tenaga kesehatan dari Excel (tanggal sel Excel, NIK); ekspor tanpa NIK; impor ulang hasil ekspor = ubah by id', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Nakes');
    ws.addRow(['fullName', 'practitionerType', 'nik', 'sipNumber', 'sipValidUntil', 'isActive']);
    ws.addRow(['dr. Excel Sintetis', 'dokter', '3201011201900099', 'SIP-X1', new Date(Date.UTC(2029, 0, 31)), 'ya']);
    ws.addRow(['Bidan Excel', 'BIDAN', '123', '', '', '']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const bad = await imp('practitioners', buf, { type: XLSX });
    expect(bad.body.errors).toEqual([{ row: 3, field: 'nik', message: 'NIK harus 16 digit angka' }]);
    ws.getRow(3).getCell(3).value = '';
    const ok = await imp('practitioners', Buffer.from(await wb.xlsx.writeBuffer()), { type: XLSX, dryRun: false });
    expect(ok.body).toMatchObject({ status: 'COMMITTED', created: 2 });
    const [p] = await su<{ id: string; sip: string; nik_hash: string }>(`select id, to_char(sip_valid_until, 'YYYY-MM-DD') as sip, nik_hash from app.practitioner
      where full_name = 'dr. Excel Sintetis'`);
    expect([p.sip, p.nik_hash]).toEqual(['2029-01-31', expect.stringMatching(/^[0-9a-f]{64}$/)]);
    const ex = await download('/api/v1/exports/practitioners?format=xlsx');
    expect(ex.headers['content-type']).toContain(XLSX);
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(ex.body);
    const sheet = back.worksheets[0];
    const header = (sheet.getRow(1).values as string[]).slice(1);
    const rowOf = (name: string) => { let n = 0; sheet.eachRow((r, i) => { if (r.getCell(header.indexOf('fullName') + 1).value === name) n = i; }); return sheet.getRow(n); };
    expect(rowOf('dr. Excel Sintetis').getCell(header.indexOf('nik') + 1).value ?? '').toBe('');       // NIK tidak pernah diekspor
    rowOf('dr. Excel Sintetis').getCell(header.indexOf('sipNumber') + 1).value = 'SIP-X2';
    const again = await imp('practitioners', Buffer.from(await back.xlsx.writeBuffer()), { type: XLSX, dryRun: false });
    expect(again.body.status).toBe('COMMITTED');
    expect(again.body.created).toBe(0);
    const [after] = await su<{ sip_number: string; nik_hash: string }>(`select sip_number, nik_hash from app.practitioner where id = $1`, [p.id]);
    expect(after).toEqual({ sip_number: 'SIP-X2', nik_hash: p.nik_hash });                            // NIK kosong di berkas = tetap
  });

  test('M27 batas & izin: kolom asing 400, format lain 415, > 5.000 baris 400, kasir 403, tanpa izin kelola entitas 403', async () => {
    expect((await imp('uoms', 'code,nama\nBTL,Botol\n')).body.code).toBe('MST-400-HEADER');
    expect((await imp('uoms', '{"a":1}', { type: 'application/json' })).status).toBe(400);
    expect((await send('post', '/api/v1/imports/uoms', admin).set('Content-Type', 'text/plain').send('code,name')).status).toBe(400);
    const big = 'code,name\n' + Array.from({ length: 5001 }, (_, i) => `U${i},Satuan ${i}`).join('\n');
    expect((await imp('uoms', big)).body.code).toBe('MST-400-ROWS');
    expect((await imp('uoms', 'code,name\nBTL,Botol\n', { j: kasir })).status).toBe(403);
    // Role custom: punya master.import tetapi tidak master.supplier.manage
    await su(`insert into app.role_permission(tenant_id, role_id, permission_code) select tenant_id, id, 'master.import' from app.role
               where tenant_id = $1 and code = 'GUDANG'`, [ids.tenantA]);
    const gudang = await login('gudang@a.test');
    expect((await imp('suppliers', 'name\nPBF\n', { j: gudang })).body.code).toBe('IAM-403-FORBIDDEN');
  });
});
