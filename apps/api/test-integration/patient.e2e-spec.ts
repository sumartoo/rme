import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';
import { freshTotp } from './support/totp';

/**
 * Stage 8 batch 1 — master pasien (REG-FR-001..009, 012; OD-068, OD-081, OD-085 / DEC-035). Data sintetis saja:
 * NIK di bawah ini berstruktur valid tetapi bukan milik orang.
 * Gate: NIK terenkripsi & dicari via hash, tidak pernah utuh di respons/audit; deteksi duplikat; registrasi bersamaan aman.
 */
const HOST = 'klinik-a.clinicrme.test';
const HOST_B = 'klinik-b.clinicrme.test';
const PAYER_UMUM_A = 'aaaaaaaa-0000-0000-0000-000000000030';
const NIK1 = '3201014503850001', NIK2 = '3201016708900002', NIK3 = '3171010101700003', NIK4 = '3301011010100004';
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
const login = async (email: string, host = HOST) => {
  const r = await http.post('/api/v1/auth/login').set('Host', host).send({ email, password: PASSWORD });
  expect([email, r.status]).toEqual([email, 200]);
  return jar(r);
};
const get = (path: string, j: Jar) => http.get(path).set('Host', HOST).set('Cookie', j.cookie);
const send = (method: 'post' | 'put', path: string, j: Jar) => http[method](path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
const key = () => `uji-${randomUUID()}`;
const register = (j: Jar, body: object, k = key()) => send('post', '/api/v1/patients', j).set('Idempotency-Key', k).send(body);
const auditOf = (action: string, id: string) => su<{ summary: Record<string, unknown>; patient_id: string | null }>(
  `select change_summary as summary, patient_id from app.audit_log where action = $1 and resource_id = $2 order by seq desc`, [action, id]);

const siti = { fullName: 'Siti  Rahmawati', birthDate: '1985-03-12', sex: 'P', identityType: 'NIK', nik: NIK1,
  phone: '+62 812-3456-7001', address: 'Jl. Melati No. 1, Bandung', regionCode: '32.73' };

let admin: Jar, daftar: Jar, dokter: Jar;
beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  let j = await login('admin@a.test');                                      // TENANT_ADMIN wajib MFA (OD-080)
  const e = await send('post', '/api/v1/auth/mfa/enroll', j);
  const secret = new URL(e.body.otpauthUrl).searchParams.get('secret')!;
  const v = await send('post', '/api/v1/auth/mfa/verify', j).send({ code: await freshTotp(secret) });
  expect(v.status).toBe(200);
  admin = j = jar(v, j);
  daftar = await login('pendaftaran@a.test');
  dokter = await login('dokter@a.test');
  // Wilayah minimal untuk validasi kode (data lengkap dimuat pemuat referensi)
  await su(`insert into app.region(code, name, level, parent_code) values ('32', 'JAWA BARAT', 1, null), ('32.73', 'KOTA BANDUNG', 2, '32')
            on conflict do nothing`);
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('Registrasi pasien (REG-FR-001/002/009, OD-081, OD-085)', () => {
  let sitiId: string;

  test('P01 registrasi NIK: MRN 8 digit otomatis, NIK hanya tersamar di respons, terenkripsi + hash di database, tidak ada di audit', async () => {
    const r = await register(daftar, { ...siti, contacts: [{ relation: 'Suami', fullName: 'Andi Pratama', phone: '0812 3456 7002', isGuardian: false }] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ mrn: '00000001', fullName: 'Siti Rahmawati', nikMasked: '3201********0001', phone: '081234567001',
      status: 'ACTIVE', ihsStatus: 'PENDING', processingRestricted: false, hasConsent: false, version: 1 });
    expect(r.body.contacts).toEqual([expect.objectContaining({ relation: 'Suami', phone: '081234567002' })]);
    expect(JSON.stringify(r.body)).not.toContain(NIK1);
    sitiId = r.body.id;
    const [row] = await su(`select encode(nik_encrypted, 'hex') as enc, nik_hash, registered_branch_id from app.patient where id = $1`, [sitiId]);
    expect(row.enc).not.toContain(Buffer.from(NIK1).toString('hex'));
    expect(row.nik_hash).toMatch(/^[0-9a-f]{64}$/);
    const [a] = await auditOf('PATIENT_CREATED', sitiId);
    expect(a.patient_id).toBe(sitiId);
    expect(JSON.stringify(a.summary)).not.toContain(NIK1);
    expect(JSON.stringify(a.summary)).not.toContain('3201********0001');
    // Nomor berikutnya berurutan; awalan dari pengaturan klinik (OD-081)
    await su(`update app.tenant set settings = settings || '{"mrnPrefix":"RM"}' where id = $1`, [ids.tenantA]);
    const n = await register(daftar, { fullName: 'Budi Hartono', birthDate: '1970-01-01', sex: 'L', identityType: 'NIK', nik: NIK3,
      phone: '081300000003', address: 'Jl. Kenanga 3, Jakarta' });
    expect(n.body.mrn).toBe('RM00000002');
    await su(`update app.tenant set settings = settings - 'mrnPrefix' where id = $1`, [ids.tenantA]);
  });

  test('P02 Idempotency-Key: kirim ulang = pasien yang sama; kunci sama isi beda → 409; tanpa kunci → 400', async () => {
    const k = key();
    const body = { fullName: 'Rina Kartika', birthDate: '1992-07-01', sex: 'P', identityType: 'TANPA_IDENTITAS', phone: '081300000010',
      address: 'Jl. Anggrek 10, Bogor' };
    const [a, b] = await Promise.all([register(daftar, body, k), register(daftar, body, k)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.id).toBe(a.body.id);
    const [{ n }] = await su(`select count(*)::int as n from app.patient where full_name = 'Rina Kartika'`);
    expect(n).toBe(1);
    expect((await register(daftar, { ...body, phone: '081300000011' }, k)).body.code).toBe('GEN-409-IDEMPOTENCY');
    const noKey = await send('post', '/api/v1/patients', daftar).send(body);
    expect([noKey.status, noKey.body.code]).toEqual([400, 'GEN-400-IDEMPOTENCY-KEY']);
  });

  test('P03 data wajib (OD-085): identitas sesuai jenis, telepon atau kontak darurat, tanggal lahir wajar, bayi tertaut ibu', async () => {
    const base = { fullName: 'Uji Wajib', birthDate: '1990-01-01', sex: 'L', address: 'Jl. Uji 1, Kota' };
    const fields = async (body: object) => {
      const r = await register(daftar, body);
      expect(r.status).toBe(400);
      return r.body.errors.map((x: { field: string }) => x.field);
    };
    expect(await fields({ ...base, identityType: 'NIK', phone: '081300000020' })).toContain('nik');
    expect(await fields({ ...base, identityType: 'PASPOR', phone: '081300000020' })).toContain('identityValue');
    expect(await fields({ ...base, identityType: 'TANPA_IDENTITAS', nik: NIK4, phone: '081300000020' })).toContain('nik');
    expect(await fields({ ...base, identityType: 'TANPA_IDENTITAS' })).toContain('phone');
    expect(await fields({ ...base, identityType: 'TANPA_IDENTITAS', phone: '081300000020', birthDate: '2999-01-01' })).toContain('birthDate');
    expect(await fields({ ...base, identityType: 'BAYI_IDENTITAS_IBU', phone: '081300000020' })).toContain('motherPatientId');
    expect(await fields({ ...base, identityType: 'NIK', nik: '1234', phone: '081300000020' })).toContain('nik');
    expect(await fields({ ...base, identityType: 'TANPA_IDENTITAS', phone: '081300000020', address: '' })).toContain('address');
    const region = await register(daftar, { ...base, identityType: 'TANPA_IDENTITAS', phone: '081300000020', regionCode: '99.99' });
    expect(region.body.code).toBe('PAT-400-REGION');
  });

  test('P04 identitas tanpa NIK (REG-FR-002): paspor tersamar, tanpa identitas dengan kontak saja, bayi tertaut ibu', async () => {
    const wna = await register(daftar, { fullName: 'John Carter', birthDate: '1980-05-05', sex: 'L', identityType: 'PASPOR',
      identityValue: 'x1234567', phone: '081300000030', address: 'Hotel Uji, Denpasar' });
    expect(wna.status).toBe(201);
    expect(wna.body).toMatchObject({ identityType: 'PASPOR', identityMasked: 'X1****567', nikMasked: null, ihsStatus: 'NOT_APPLICABLE' });
    expect(JSON.stringify(wna.body)).not.toContain('X1234567');
    // Paspor sama → identitas pasti sama
    const again = await register(daftar, { fullName: 'J. Carter', birthDate: '1980-05-05', sex: 'L', identityType: 'PASPOR',
      identityValue: 'X1234567', phone: '081300000031', address: 'Hotel Uji, Denpasar' });
    expect(again.body.code).toBe('PAT-409-IDENTITY');
    const anon = await register(daftar, { fullName: 'Tn. Tanpa Nama', birthDate: '1960-01-01', sex: 'TIDAK_DIKETAHUI', identityType: 'TANPA_IDENTITAS',
      address: 'Ditemukan di Jl. Raya Uji', contacts: [{ relation: 'Pengantar', fullName: 'Petugas Uji', phone: '081300000032' }] });
    expect(anon.status).toBe(201);
    const [{ id: mother }] = await su(`select id from app.patient where full_name = 'Siti Rahmawati'`);
    const baby = await register(daftar, { fullName: 'Bayi Ny. Siti', birthDate: new Date().toISOString().slice(0, 10), sex: 'P',
      identityType: 'BAYI_IDENTITAS_IBU', motherPatientId: mother, address: 'Jl. Melati No. 1, Bandung',
      contacts: [{ relation: 'Ibu', fullName: 'Siti Rahmawati', phone: '081234567001', isGuardian: true }] });
    expect(baby.status).toBe(201);
    expect(baby.body.mother).toMatchObject({ id: mother, fullName: 'Siti Rahmawati' });
    expect(baby.body.contacts[0].isGuardian).toBe(true);
  });
});

describe('Duplikat (REG-FR-004) & pencarian (REG-FR-003)', () => {
  test('P05 NIK sama → 409 PAT-409-IDENTITY dengan pasien yang ada; nama mirip + tgl lahir sama → kandidat, simpan wajib alasan', async () => {
    const same = await register(daftar, { ...siti, fullName: 'S. Rahmawati' });
    expect(same.status).toBe(409);
    expect(same.body).toMatchObject({ code: 'PAT-409-IDENTITY', candidates: [expect.objectContaining({ mrn: '00000001' })] });
    const typo = { ...siti, fullName: 'Siti Rahmawaty', identityType: 'TANPA_IDENTITAS', nik: undefined, phone: '081399999999' };
    const chk = await send('post', '/api/v1/patients/duplicate-check', daftar).send(typo);
    expect(chk.status).toBe(200);
    expect(chk.body.exactNikMatch).toBe(false);
    expect(chk.body.candidates[0]).toMatchObject({ mrn: '00000001', fullName: 'Siti Rahmawati' });
    expect(chk.body.candidates[0].score).toBeGreaterThan(0.5);
    expect(chk.body.candidates[0].score).toBeLessThan(1);
    const blocked = await register(daftar, typo);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('PAT-409-DUPLICATE');
    expect(blocked.body.candidates.map((c: { mrn: string }) => c.mrn)).toContain('00000001');
    const ok = await register(daftar, { ...typo, duplicateOverrideReason: 'Pasien berbeda, dikonfirmasi lewat KTP keluarga' });
    expect(ok.status).toBe(201);
    const [a] = await auditOf('PATIENT_CREATED', ok.body.id);
    expect(a.summary.duplicateOverride).toMatchObject({ reason: 'Pasien berbeda, dikonfirmasi lewat KTP keluarga' });
    // Nama berbeda jauh dengan tanggal lahir sama bukan kandidat
    const far = await send('post', '/api/v1/patients/duplicate-check', daftar).send({ ...typo, fullName: 'Agus Salim Wijaya' });
    expect(far.body.candidates).toEqual([]);
  });

  test('P06 cari: nama salah ketik, NIK (hash), MRN, telepon format +62, tanggal lahir; pasien klinik lain tidak muncul', async () => {
    const names = async (qs: string) => (await get(`/api/v1/patients?${qs}`, daftar)).body.data.map((p: { fullName: string }) => p.fullName);
    expect((await names('q=siti%20rahmawti'))[0]).toBe('Siti Rahmawati');
    expect(await names(`q=${NIK1}`)).toEqual(['Siti Rahmawati']);
    expect(await names(`nik=${NIK1}`)).toEqual(['Siti Rahmawati']);
    expect(await names('q=00000001')).toEqual(['Siti Rahmawati']);
    expect(await names('mrn=00000001')).toEqual(['Siti Rahmawati']);
    expect(await names('q=%2B6281234567001')).toEqual(['Siti Rahmawati']);
    expect(await names('phone=0812-3456-7001')).toEqual(['Siti Rahmawati']);
    expect(await names('birthDate=1980-05-05')).toEqual(['John Carter']);
    expect(await names('q=Pasien%20Uji')).toContain('Pasien Uji a');
    expect(await names('q=Pasien%20Uji')).not.toContain('Pasien Uji b');
    const r = await get('/api/v1/patients?q=siti', daftar);
    expect(JSON.stringify(r.body)).not.toContain(NIK1);
    const paged = await get('/api/v1/patients?limit=2', daftar);
    expect(paged.body.data).toHaveLength(2);
    expect(paged.body.page).toEqual({ hasMore: true, nextCursor: '2' });
    expect((await get('/api/v1/patients?nik=123', daftar)).status).toBe(400);
  });
});

describe('Ubah, penjamin, consent (REG-FR-001/006/007/008)', () => {
  let id: string;
  beforeAll(async () => { [{ id }] = await su(`select id from app.patient where full_name = 'Siti Rahmawati'`); });

  test('P07 ubah: If-Match wajib, audit hanya kolom berubah, NIK baru milik pasien lain → 409, NIK tercatat [rahasia]', async () => {
    expect((await send('put', `/api/v1/patients/${id}`, daftar).send({ phone: '081300000099' })).status).toBe(428);
    const u = await send('put', `/api/v1/patients/${id}`, daftar).set('If-Match', '"1"').send({ phone: '081300000099' });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ phone: '081300000099', version: 2 });
    expect(u.headers.etag).toBe('"2"');
    expect((await auditOf('PATIENT_UPDATED', id))[0].summary).toEqual({ changed: ['phone'],
      before: { phone: '081234567001' }, after: { phone: '081300000099' } });
    expect((await send('put', `/api/v1/patients/${id}`, daftar).set('If-Match', '"1"').send({ address: 'Jl. Lain 2' })).body.code).toBe('GEN-412-VERSION');
    const taken = await send('put', `/api/v1/patients/${id}`, daftar).set('If-Match', '"2"').send({ nik: NIK3 });
    expect(taken.body.code).toBe('PAT-409-IDENTITY');
    const nik = await send('put', `/api/v1/patients/${id}`, daftar).set('If-Match', '"2"').send({ nik: NIK2 });
    expect(nik.body.nikMasked).toBe('3201********0002');
    const [a] = await auditOf('PATIENT_UPDATED', id);
    expect(a.summary).toEqual({ changed: ['nik'], before: { nik: '[rahasia]' }, after: { nik: '[rahasia]' } });
    // Kontak menggantikan daftar; tanpa telepon & tanpa kontak → ditolak
    const c = await send('put', `/api/v1/patients/${id}`, daftar).set('If-Match', '"3"').send({ phone: null, contacts: [] });
    expect(c.body.errors.map((x: { field: string }) => x.field)).toContain('phone');
    // Dokter (tanpa patient.update) tidak dapat mengubah
    expect((await send('put', `/api/v1/patients/${id}`, dokter).set('If-Match', '"3"').send({ phone: '081300000098' })).status).toBe(403);
  });

  test('P08 penjamin: tambah (penjamin tidak aktif ditolak), ubah dengan If-Match, nonaktif; tidak dapat dihapus di database', async () => {
    const [{ id: ins }] = await su(`insert into app.payer(tenant_id, code, name, payer_type) values ($1, 'ASR1', 'Asuransi Uji', 'ASURANSI') returning id`, [ids.tenantA]);
    const [{ id: off }] = await su(`insert into app.payer(tenant_id, code, name, payer_type, is_active) values ($1, 'ASR0', 'Asuransi Lama', 'ASURANSI', false) returning id`, [ids.tenantA]);
    expect((await send('post', `/api/v1/patients/${id}/coverages`, daftar).send({ payerId: off })).body.code).toBe('PAT-400-PAYER');
    expect((await send('post', `/api/v1/patients/${id}/coverages`, daftar).send({ payerId: ins, validFrom: '2026-12-31', validTo: '2026-01-01' })).body.code).toBe('PAT-400-PERIOD');
    const c = await send('post', `/api/v1/patients/${id}/coverages`, daftar).send({ payerId: ins, memberNo: 'POL-778', validFrom: '2026-01-01', validTo: '2026-12-31' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ payerName: 'Asuransi Uji', payerType: 'ASURANSI', memberNo: 'POL-778', isActive: true, version: 1 });
    const u = await send('put', `/api/v1/patients/${id}/coverages/${c.body.id}`, daftar).set('If-Match', '"1"').send({ isActive: false });
    expect(u.body).toMatchObject({ isActive: false, version: 2 });
    expect((await auditOf('PATIENT_COVERAGE_UPDATED', c.body.id))[0].summary).toMatchObject({ changed: ['isActive'] });
    await send('post', `/api/v1/patients/${id}/coverages`, daftar).send({ payerId: PAYER_UMUM_A });
    const d = await get(`/api/v1/patients/${id}`, daftar);
    expect(d.body.coverages.map((x: { payerName: string; isActive: boolean }) => [x.payerName, x.isActive])).toEqual([['Umum', true], ['Asuransi Uji', false]]);
    await expect(su(`set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);
                     delete from app.patient_coverage where id = '${c.body.id}'`)).rejects.toThrow(/permission denied/);
  });

  test('P09 consent berversi: admin menerbitkan (versi sama 409, teks tidak dapat diubah), petugas mencatat & mencabut', async () => {
    const doc = { consentType: 'UMUM', version: '1', title: 'Persetujuan Umum (CONTOH)', content: 'Teks contoh persetujuan umum pelayanan — wajib ditinjau klinik.' };
    expect((await send('post', '/api/v1/consent-documents', daftar).send(doc)).status).toBe(403);
    const d = await send('post', '/api/v1/consent-documents', admin).send(doc);
    expect(d.status).toBe(201);
    expect((await send('post', '/api/v1/consent-documents', admin).send(doc)).body.code).toBe('PAT-409-CONSENT-VERSION');
    expect((await get('/api/v1/consent-documents', daftar)).body.map((x: { version: string }) => x.version)).toEqual(['1']);
    await expect(su(`set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);
                     update app.consent_document set content = 'diubah'`)).rejects.toThrow(/permission denied/);
    const c = await send('post', `/api/v1/patients/${id}/consents`, daftar).send({ consentDocumentId: d.body.id, granted: true, signedByName: 'Siti Rahmawati', signedByRelation: 'Diri sendiri' });
    expect(c.status).toBe(201);
    expect((await get(`/api/v1/patients/${id}`, daftar)).body.hasConsent).toBe(true);
    const r = await send('post', `/api/v1/patients/${id}/consents/${c.body.id}/revoke`, daftar).send({ reason: 'Pasien menarik persetujuan' });
    expect(r.body.hasConsent).toBe(false);
    expect(r.body.consents[0].revokedAt).not.toBeNull();
    expect((await send('post', `/api/v1/patients/${id}/consents/${c.body.id}/revoke`, daftar).send({ reason: 'Ulang lagi' })).body.code).toBe('PAT-409-REVOKED');
  });

  test('P10 pembatasan pemrosesan (OD-068): wajib alasan, teraudit, dapat dicabut', async () => {
    expect((await send('post', `/api/v1/patients/${id}/restriction`, daftar).send({ restricted: true, reason: '' })).status).toBe(400);
    const on = await send('post', `/api/v1/patients/${id}/restriction`, daftar).send({ restricted: true, reason: 'Permintaan tertulis pasien' });
    expect(on.body).toMatchObject({ processingRestricted: true, restrictionReason: 'Permintaan tertulis pasien' });
    expect((await auditOf('PATIENT_RESTRICTION_SET', id))[0].summary).toEqual({ reason: 'Permintaan tertulis pasien' });
    const off = await send('post', `/api/v1/patients/${id}/restriction`, daftar).send({ restricted: false, reason: 'Pasien mencabut permintaan' });
    expect(off.body).toMatchObject({ processingRestricted: false, restrictionReason: null });
  });

  test('P11 detail tercatat READ dengan patient_id; pasien klinik lain → 404', async () => {
    expect((await get(`/api/v1/patients/${id}`, dokter)).status).toBe(200);
    const [a] = await su(`select actor_user_id, patient_id from app.audit_log where action = 'READ' order by seq desc limit 1`);
    expect(a).toEqual({ actor_user_id: ids.dokterA, patient_id: id });
    expect((await get(`/api/v1/patients/${ids.patientB}`, daftar)).status).toBe(404);
  });
});

describe('Gabung pasien (REG-FR-005)', () => {
  test('P12 hanya izin patient.merge; sumber jadi MERGED (tidak dihapus), NIK & penjamin pindah ke tujuan, NIK berbeda ditolak', async () => {
    const a = await register(daftar, { fullName: 'Dewi Lestari', birthDate: '1995-02-02', sex: 'P', identityType: 'NIK', nik: NIK4,
      phone: '081300000040', address: 'Jl. Dahlia 4, Solo' });
    const b = await register(daftar, { fullName: 'Dewi Lestary', birthDate: '1995-02-02', sex: 'P', identityType: 'TANPA_IDENTITAS',
      phone: '081300000041', address: 'Jl. Dahlia 4, Solo', duplicateOverrideReason: 'Belum yakin, dibuat sementara oleh petugas' });
    await send('post', `/api/v1/patients/${a.body.id}/coverages`, daftar).send({ payerId: PAYER_UMUM_A });
    const body = { sourcePatientId: a.body.id, targetPatientId: b.body.id, reason: 'Orang yang sama, terdaftar dua kali' };
    expect((await send('post', '/api/v1/patients/merge', daftar).send(body)).status).toBe(403);
    expect((await send('post', '/api/v1/patients/merge', admin).send({ ...body, targetPatientId: a.body.id })).status).toBe(400);
    const m = await send('post', '/api/v1/patients/merge', admin).send(body);
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ id: b.body.id, identityType: 'NIK', nikMasked: '3301********0004', status: 'ACTIVE' });
    expect(m.body.coverages.map((c: { payerName: string }) => c.payerName)).toEqual(['Umum']);
    const src = await get(`/api/v1/patients/${a.body.id}`, admin);
    expect(src.body).toMatchObject({ status: 'MERGED', mergedInto: { id: b.body.id }, mergeReason: body.reason });
    expect((await auditOf('PATIENT_MERGED', a.body.id))[0].summary).toMatchObject({ targetPatientId: b.body.id, nikMoved: true });
    // Pencarian NIK kini menemukan tujuan; sumber hanya muncul bila diminta
    expect((await get(`/api/v1/patients?nik=${NIK4}`, daftar)).body.data.map((p: { id: string }) => p.id)).toEqual([b.body.id]);
    expect((await get('/api/v1/patients?q=Dewi&includeMerged=true', daftar)).body.data).toHaveLength(2);
    expect((await send('put', `/api/v1/patients/${a.body.id}`, daftar).set('If-Match', `"${src.body.version}"`).send({ phone: '081300000042' })).body.code).toBe('PAT-409-MERGED');
    expect((await send('post', '/api/v1/patients/merge', admin).send(body)).body.code).toBe('PAT-409-MERGED');
    const [{ id: budi }] = await su(`select id from app.patient where full_name = 'Budi Hartono'`);
    expect((await send('post', '/api/v1/patients/merge', admin).send({ sourcePatientId: budi, targetPatientId: b.body.id, reason: 'Uji NIK berbeda' })).body.code).toBe('PAT-409-MERGE-NIK');
    await expect(su(`set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);
                     delete from app.patient where id = '${a.body.id}'`)).rejects.toThrow(/permission denied/);
  });
});

describe('Konkurensi & isolasi (gate Stage 8)', () => {
  test('P13 20 registrasi bersamaan: MRN unik berurutan; 10 registrasi NIK sama bersamaan: tepat satu berhasil', async () => {
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => register(daftar, { fullName: `Pasien Paralel ${String.fromCharCode(65 + i)}${i * 7}`,
      birthDate: `19${50 + i}-0${(i % 9) + 1}-1${i % 9}`, sex: i % 2 ? 'L' : 'P', identityType: 'TANPA_IDENTITAS', phone: `0813111100${String(i).padStart(2, '0')}`,
      address: `Jl. Paralel ${i}, Kota Uji`, duplicateOverrideReason: 'Uji konkurensi registrasi' })));
    expect(many.map((r) => r.status)).toEqual(Array(20).fill(201));
    const mrns = many.map((r) => r.body.mrn as string);
    expect(new Set(mrns).size).toBe(20);
    const nums = mrns.map(Number).sort((x, y) => x - y);
    expect(nums[19] - nums[0]).toBe(19);
    const nik = '3578015505990005';
    const same = await Promise.all(Array.from({ length: 10 }, (_, i) => register(daftar, { fullName: `Kembar Uji ${i}`, birthDate: '1999-05-15',
      sex: 'P', identityType: 'NIK', nik, phone: '081300000050', address: 'Jl. Uji Bersamaan 1', duplicateOverrideReason: 'Uji konkurensi NIK sama' })));
    expect(same.filter((r) => r.status === 201)).toHaveLength(1);
    expect(same.filter((r) => r.status === 409).every((r) => r.body.code === 'PAT-409-IDENTITY')).toBe(true);
  }, 60_000);

  test('P14 tidak ada NIK utuh di tabel audit maupun di kolom teks pasien mana pun', async () => {
    const [{ hits }] = await su(`select count(*)::int as hits from app.audit_log
                                  where change_summary::text ~ '(3201014503850001|3201016708900002|3171010101700003|3301011010100004)'`);
    expect(hits).toBe(0);
    const [{ n }] = await su(`select count(*)::int as n from app.patient
                               where concat_ws('|', full_name, nik_masked, phone, address) ~ '\\d{16}'`);
    expect(n).toBe(0);
  });

  test('P15 sesi klinik B tidak melihat pasien klinik A', async () => {
    const b = await login('dokter@b.test', HOST_B);
    const r = await http.get('/api/v1/patients?q=Siti').set('Host', HOST_B).set('Cookie', b.cookie);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
  });
});
