import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 9 batch 4 — order & hasil lab, dokumen medis PDF, rujukan (CLN-FR-014, 015, 020–022; OD-059, OD-093 / DEC-038).
 * Gate Stage 9: order & hasil lab teruji dengan vendor tiruan. Data sintetis.
 */
const HOST = 'klinik-a.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const UNIT = A(11), DR = A(20), KONS = A(31);
const ICD10_R50 = 'c1000000-0000-0000-0000-000000000001';
const PERAWAT = A(27);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');
let app: INestApplication;
let http: ReturnType<typeof request>;

type Jar = { cookie: string; csrf: string };
function jar(res: request.Response): Jar {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const csrf = get('crme_csrf');
  return { cookie: [get('crme_session'), csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '' };
}
const login = async (email: string) => {
  const r = await http.post('/api/v1/auth/login').set('Host', HOST).send({ email, password: PASSWORD });
  expect([email, r.status]).toEqual([email, 200]);
  return jar(r);
};
const get = (path: string, j: Jar) => http.get(path).set('Host', HOST).set('Cookie', j.cookie);
const getBin = (path: string, j: Jar) => get(path, j).buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
});
const post = (path: string, j: Jar) => http.post(path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
const put = (path: string, j: Jar, version?: number) => {
  const r = http.put(path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
  return version === undefined ? r : r.set('If-Match', String(version));
};

let daftar: Jar, dokter: Jar, perawat: Jar;
let HB: string, GDS: string;
const P: string[] = [];
async function mkPatient(name: string) {
  const [{ id }] = await su(`insert into app.patient(tenant_id, mrn, full_name, birth_date, sex, identity_type, ihs_status, address)
                             values ($1, $2, $3, '1990-07-07', 'L', 'TANPA_IDENTITAS', 'NOT_APPLICABLE', 'Jl. Contoh No. 1') returning id`,
  [ids.tenantA, `D${String(P.length + 1).padStart(6, '0')}`, name]);
  P.push(id);
  return id as string;
}
async function consult(patientId: string, sign = false) {
  const w = await post('/api/v1/encounters/walk-in', daftar).set('Idempotency-Key', `uji-${randomUUID()}`).send({ patientId, unitId: UNIT, practitionerId: DR });
  expect(w.status).toBe(201);
  const id = w.body.id as string;
  await post(`/api/v1/encounters/${id}/start-consultation`, dokter).send();
  if (sign) {
    await post(`/api/v1/encounters/${id}/vitals`, perawat).send({ systolic: 120, diastolic: 80, weight: 70, height: 175 });
    await put(`/api/v1/encounters/${id}/note`, dokter, 0).send({ subjective: 'Demam 2 hari', objective: 'Suhu 38', assessment: 'Febris', plan: 'Istirahat' });
    await put(`/api/v1/encounters/${id}/diagnoses`, dokter).send([{ conceptId: ICD10_R50, rank: 'PRIMER' }]);
    await post(`/api/v1/encounters/${id}/procedures`, dokter).send({ serviceItemId: KONS });
    expect((await post(`/api/v1/encounters/${id}/sign`, dokter).send({ password: PASSWORD })).status).toBe(200);
  }
  return id;
}
const order = (id: string, body: object, key = `uji-${randomUUID()}`) => post(`/api/v1/encounters/${id}/lab-orders`, dokter).set('Idempotency-Key', key).send(body);

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  await su(`update app.practitioner set sip_number = 'SIP/UJI/001', sip_valid_until = current_date + 365 where id = $1`, [DR]);
  await su(`update app.tenant set letterhead = '{"name": "Klinik Uji Sintetis", "address": "Jl. Sintetis 1", "license": "IZIN-UJI"}' where id = $1`, [ids.tenantA]);
  await su(`insert into app.app_user(id, tenant_id, email, full_name) values ($1, $2, 'perawat@a.test', 'Ners Uji')`, [PERAWAT, ids.tenantA]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and code = 'PERAWAT'`, [ids.tenantA, PERAWAT]);
  await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select tenant_id, $2, password_hash from app.user_credential where user_id = $1`, [ids.dokterA, PERAWAT]);
  [{ id: HB }] = await su(`insert into app.service_item(tenant_id, code, name, service_type) values ($1, 'LAB-HB', 'Hemoglobin', 'LAB') returning id`, [ids.tenantA]);
  [{ id: GDS }] = await su(`insert into app.service_item(tenant_id, code, name, service_type) values ($1, 'LAB-GDS', 'Gula darah sewaktu', 'LAB') returning id`, [ids.tenantA]);
  daftar = await login('pendaftaran@a.test');
  dokter = await login('dokter@a.test');
  perawat = await login('perawat@a.test');
  for (let i = 0; i < 6; i++) await mkPatient(`Pasien Dok ${i + 1}`);
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('Order & hasil lab (CLN-FR-014, 015; OD-059)', () => {
  test('C26 order: saat diperiksa, oleh dokter, layanan LAB; nomor & idempotensi; konektor tiruan mengirim & mengembalikan hasil', async () => {
    const w = await post('/api/v1/encounters/walk-in', daftar).set('Idempotency-Key', `uji-${randomUUID()}`).send({ patientId: P[0], unitId: UNIT, practitionerId: DR });
    expect((await order(w.body.id, { serviceItemIds: [HB] })).body.code).toBe('CLN-409-NOT-IN-CONSULTATION');
    const id = await consult(P[1]);
    expect((await post(`/api/v1/encounters/${id}/lab-orders`, perawat).set('Idempotency-Key', `uji-${randomUUID()}`).send({ serviceItemIds: [HB] })).status).toBe(403);
    expect((await order(id, { serviceItemIds: [KONS] })).body.code).toBe('CLN-400-LAB-SERVICE');
    const key = `uji-${randomUUID()}`;
    const r = await order(id, { serviceItemIds: [HB, GDS], clinicalInfo: 'Curiga anemia' }, key);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ orderNo: expect.stringMatching(/^LAB\d{6}000001$/), status: 'ORDERED', connector: null, orderedByName: 'dr. Uji a',
      clinicalInfo: 'Curiga anemia', results: [] });
    expect(r.body.items.map((i: { name: string }) => i.name)).toEqual(['Gula darah sewaktu', 'Hemoglobin']);
    expect((await order(id, { serviceItemIds: [HB, GDS], clinicalInfo: 'Curiga anemia' }, key)).body.id).toBe(r.body.id);
    expect((await post(`/api/v1/lab-orders/${r.body.id}/simulate-result`, perawat).send()).body.code).toBe('CLN-409-NOT-MOCK');
    // Konektor tiruan
    await su(`update app.tenant set settings = settings || '{"labConnector": "MOCK"}' where id = $1`, [ids.tenantA]);
    const m = await order(id, { serviceItemIds: [HB] });
    expect(m.body).toMatchObject({ status: 'SENT', connector: 'MOCK', externalOrderId: `MOCK-${m.body.orderNo}` });
    const s = await post(`/api/v1/lab-orders/${m.body.id}/simulate-result`, perawat).send();
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ status: 'RESULTED', results: [{ source: 'CONNECTOR', testName: 'Hemoglobin', value: '12.5', unit: 'g/dL', flag: 'N' }] });
    expect(s.body.resultedAt).not.toBeNull();
    await su(`update app.tenant set settings = settings - 'labConnector' where id = $1`, [ids.tenantA]);
    const list = await get(`/api/v1/encounters/${id}/lab-orders`, perawat);
    expect(list.body.map((o: { status: string }) => o.status)).toEqual(['RESULTED', 'ORDERED']);
  });

  test('C27 hasil manual (perawat/analis), batal order beralasan; hasil tidak dapat diubah/dihapus', async () => {
    const id = await consult(P[2]);
    const o = (await order(id, { serviceItemIds: [HB, GDS] })).body;
    expect((await post(`/api/v1/lab-orders/${o.id}/results`, perawat).send({ results: [{ labOrderItemId: randomUUID(), testName: 'Hb', value: '9' }] })).body.code)
      .toBe('CLN-400-LAB-ITEM');
    expect((await post(`/api/v1/lab-orders/${o.id}/results`, daftar).send({ results: [{ testName: 'Hb', value: '9' }] })).status).toBe(403);
    const hb = o.items.find((i: { name: string }) => i.name === 'Hemoglobin');
    const r = await post(`/api/v1/lab-orders/${o.id}/results`, perawat).send({ results: [
      { labOrderItemId: hb.id, testName: 'Hemoglobin', value: '9.1', unit: 'g/dL', referenceRange: '13–17', flag: 'L' },
      { testName: 'Gula darah sewaktu', value: '110', unit: 'mg/dL', referenceRange: '< 200', flag: 'N', notes: 'Puasa 2 jam' },
    ] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'RESULTED' });
    expect(r.body.results.map((x: { testName: string; flag: string; enteredByName: string }) => [x.testName, x.flag, x.enteredByName]))
      .toEqual([['Gula darah sewaktu', 'N', 'Ners Uji'], ['Hemoglobin', 'L', 'Ners Uji']]);
    expect((await post(`/api/v1/lab-orders/${o.id}/cancel`, dokter).send({ reason: 'Tidak jadi diperiksa' })).body.code).toBe('CLN-409-LAB-RESULTED');
    const app_ = `set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);`;
    await expect(su(`${app_} update app.lab_result set value_text = '15' where lab_order_id = '${o.id}'`)).rejects.toThrow(/permission denied/);
    await expect(su(`${app_} delete from app.lab_result where lab_order_id = '${o.id}'`)).rejects.toThrow(/permission denied/);
    const o2 = (await order(id, { serviceItemIds: [GDS] })).body;
    expect((await post(`/api/v1/lab-orders/${o2.id}/cancel`, dokter).send({ reason: 'abc' })).status).toBe(400);
    const c = await post(`/api/v1/lab-orders/${o2.id}/cancel`, dokter).send({ reason: 'Pasien menolak diambil darah' });
    expect(c.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Pasien menolak diambil darah' });
    expect((await post(`/api/v1/lab-orders/${o2.id}/results`, perawat).send({ results: [{ testName: 'GDS', value: '1' }] })).body.code).toBe('CLN-409-LAB-CANCELLED');
  });

  test('C28 unggah PDF hasil lab: isi harus PDF; berkas tersimpan ber-hash; unduhan tercatat di audit', async () => {
    const id = await consult(P[3]);
    const o = (await order(id, { serviceItemIds: [HB] })).body;
    const up = (buf: Buffer, type = 'application/pdf') => post(`/api/v1/lab-orders/${o.id}/results/upload`, perawat).set('Content-Type', type).send(buf);
    expect((await up(Buffer.from('<html>bukan pdf</html>'))).body.code).toBe('CLN-400-PDF');
    const r = await up(PDF);
    expect(r.status).toBe(201);
    const res = r.body.results.find((x: { source: string }) => x.source === 'UPLOAD');
    expect(res).toMatchObject({ testName: 'Dokumen hasil lab (PDF)', fileId: expect.any(String) });
    const [f] = await su(`select category, content_type, size_bytes::int as n, sha256, patient_id from app.stored_file where id = $1`, [res.fileId]);
    expect(f).toEqual({ category: 'LAB_RESULT', content_type: 'application/pdf', n: PDF.length, sha256: createHash('sha256').update(PDF).digest('hex'), patient_id: P[3] });
    const d = await getBin(`/api/v1/lab-results/${res.id}/file`, dokter);
    expect(d.status).toBe(200);
    expect(d.headers['content-type']).toContain('application/pdf');
    expect(Buffer.compare(d.body as Buffer, PDF)).toBe(0);
    expect((await su(`select count(*)::int as n from app.audit_log where action = 'LAB_RESULT_FILE_READ' and patient_id = $1`, [P[3]]))[0].n).toBe(1);
    expect((await getBin(`/api/v1/lab-results/${res.id}/file`, daftar)).status).toBe(403);
  });
});

describe('Dokumen medis PDF & rujukan (CLN-FR-020–022; OD-093)', () => {
  let enc: string;
  test('C29 surat sakit/sehat & resume: hanya dari rekam medis disahkan; nomor per jenis per bulan; kode verifikasi; data tidak dapat diubah', async () => {
    const draft = await consult(P[4]);
    expect((await post(`/api/v1/encounters/${draft}/documents`, dokter).send({ docType: 'RESUME' })).body.code).toBe('CLN-409-NOT-SIGNED');
    enc = await consult(P[5], true);
    expect((await post(`/api/v1/encounters/${enc}/documents`, perawat).send({ docType: 'RESUME' })).status).toBe(403);
    expect((await post(`/api/v1/encounters/${enc}/documents`, dokter).send({ docType: 'SURAT_SAKIT', restDays: 0 })).status).toBe(400);
    const yyyymm = (await su(`select to_char(now() at time zone 'Asia/Jakarta', 'YYYY/MM') as m`))[0].m as string;
    const s1 = await post(`/api/v1/encounters/${enc}/documents`, dokter).send({ docType: 'SURAT_SAKIT', restDays: 3, startDate: '2026-11-06' });
    expect(s1.status).toBe(201);
    expect(s1.body).toMatchObject({ documentNo: `SKS/${yyyymm}/0001`, docType: 'SURAT_SAKIT', doctorName: 'dr. Uji a', issuedByName: 'dr. Uji',
      verificationCode: expect.stringMatching(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/) });
    const s2 = await post(`/api/v1/encounters/${enc}/documents`, dokter).send({ docType: 'SURAT_SAKIT', restDays: 1, includeDiagnosis: true });
    expect(s2.body.documentNo).toBe(`SKS/${yyyymm}/0002`);
    const h = await post(`/api/v1/encounters/${enc}/documents`, dokter).send({ docType: 'SURAT_SEHAT', purpose: 'Persyaratan kerja' });
    expect(h.body.documentNo).toBe(`SKH/${yyyymm}/0001`);
    const r = await post(`/api/v1/encounters/${enc}/documents`, dokter).send({ docType: 'RESUME' });
    expect(r.body.documentNo).toBe(`RES/${yyyymm}/0001`);
    const [d1] = await su(`select data, content_hash from app.medical_document where id = $1`, [s1.body.id]);
    expect(d1.data).toMatchObject({ restDays: 3, startDate: '2026-11-06', endDate: '2026-11-08', diagnoses: null,
      patient: { name: 'Pasien Dok 6', mrn: 'D000006', address: 'Jl. Contoh No. 1' }, doctor: { name: 'dr. Uji a', sip: 'SIP/UJI/001' },
      clinic: { name: 'Klinik Uji Sintetis', license: 'IZIN-UJI' } });
    expect((await su(`select data from app.medical_document where id = $1`, [s2.body.id]))[0].data.diagnoses).toEqual(['R50.9 Demam, tidak spesifik']);
    const [res] = await su(`select data from app.medical_document where id = $1`, [r.body.id]);
    expect(res.data).toMatchObject({ soap: { assessment: 'Febris' }, diagnoses: [{ code: 'R50.9', rank: 'PRIMER' }], procedures: [{ name: 'Konsultasi Umum' }],
      vitals: { BMI: 22.9 } });
    expect(s1.body.verificationCode.replace(/-/g, '').toLowerCase()).toBe(d1.content_hash.slice(0, 12));
    const pdf = await getBin(`/api/v1/medical-documents/${s1.body.id}/file`, perawat);
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.headers['content-disposition']).toContain(`SKS-${yyyymm.replace('/', '-')}-0001.pdf`);
    expect((await su(`select count(*)::int as n from app.audit_log where action = 'MEDICAL_DOCUMENT_READ' and resource_id = $1`, [s1.body.id]))[0].n).toBe(1);
    const app_ = `set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);`;
    await expect(su(`${app_} update app.medical_document set data = '{}' where id = '${s1.body.id}'`)).rejects.toThrow(/permission denied/);
    await expect(su(`${app_} delete from app.stored_file where patient_id = '${P[5]}'`)).rejects.toThrow(/permission denied/);
  });

  test('C30 rujukan keluar: tercatat + surat RJK; daftar dokumen kunjungan', async () => {
    expect((await post(`/api/v1/encounters/${enc}/referrals`, dokter).send({ destination: 'RS', reason: 'x' })).status).toBe(400);
    const r = await post(`/api/v1/encounters/${enc}/referrals`, dokter).send({ destination: 'RSUD Sintetis', destinationUnit: 'Poli Penyakit Dalam',
      reason: 'Demam berkepanjangan, perlu pemeriksaan lanjutan', clinicalSummary: 'Demam 2 hari, suhu 38' });
    expect(r.status).toBe(201);
    expect(r.body.documentNo).toMatch(/^RJK\/\d{4}\/\d{2}\/0001$/);
    const [ref] = await su(`select destination, destination_unit, document_id from app.referral where encounter_id = $1`, [enc]);
    expect(ref).toEqual({ destination: 'RSUD Sintetis', destination_unit: 'Poli Penyakit Dalam', document_id: r.body.id });
    expect((await su(`select data->>'destination' as d from app.medical_document where id = $1`, [r.body.id]))[0].d).toBe('RSUD Sintetis');
    const list = await get(`/api/v1/encounters/${enc}/documents`, perawat);
    expect(list.body.map((d: { docType: string }) => d.docType).sort()).toEqual(['RESUME', 'RUJUKAN', 'SURAT_SAKIT', 'SURAT_SAKIT', 'SURAT_SEHAT']);
    expect((await get(`/api/v1/medical-documents/${r.body.id}`, perawat)).body).toMatchObject({ id: r.body.id, docType: 'RUJUKAN' });
  });
});
