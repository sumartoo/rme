import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 9 batch 3 — master obat minimal & resep elektronik (CLN-FR-010–012; OD-033, OD-091, OD-094 / DEC-038).
 * Batas dosis & data obat sintetis [REVIEW-MEDIS].
 */
const HOST = 'klinik-a.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const UNIT = A(11), DR = A(20), TAB = A(40), PCT = A(41), AMX = A(42);
const ICD10_R50 = 'c1000000-0000-0000-0000-000000000001';
const FARMASI = A(34), PERAWAT = A(27);
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
const post = (path: string, j: Jar) => http.post(path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
const put = (path: string, j: Jar, version?: number) => {
  const r = http.put(path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
  return version === undefined ? r : r.set('If-Match', String(version));
};

let daftar: Jar, dokter: Jar, farmasi: Jar, perawat: Jar;
let BKS: string;
const P: string[] = [];
async function mkPatient(name: string) {
  const [{ id }] = await su(`insert into app.patient(tenant_id, mrn, full_name, birth_date, sex, identity_type, ihs_status)
                             values ($1, $2, $3, '1975-03-03', 'P', 'TANPA_IDENTITAS', 'NOT_APPLICABLE') returning id`,
  [ids.tenantA, `R${String(P.length + 1).padStart(6, '0')}`, name]);
  P.push(id);
  return id as string;
}
async function addUser(id: string, email: string, name: string, role: string) {
  await su(`insert into app.app_user(id, tenant_id, email, full_name) values ($1, $2, $3, $4)`, [id, ids.tenantA, email, name]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and code = $3`, [ids.tenantA, id, role]);
  await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select tenant_id, $2, password_hash from app.user_credential where user_id = $1`, [ids.dokterA, id]);
}
/** Kunjungan sedang diperiksa (opsional: catatan lengkap & disahkan). */
async function consult(patientId: string, signNote = false) {
  const w = await post('/api/v1/encounters/walk-in', daftar).set('Idempotency-Key', `uji-${randomUUID()}`).send({ patientId, unitId: UNIT, practitionerId: DR });
  expect(w.status).toBe(201);
  const id = w.body.id as string;
  await post(`/api/v1/encounters/${id}/start-consultation`, dokter).send();
  if (signNote) {
    await put(`/api/v1/encounters/${id}/note`, dokter, 0).send({ subjective: 'Demam', objective: 'Suhu 38', assessment: 'Febris', plan: 'Obat' });
    await put(`/api/v1/encounters/${id}/diagnoses`, dokter).send([{ conceptId: ICD10_R50, rank: 'PRIMER' }]);
    expect((await post(`/api/v1/encounters/${id}/sign`, dokter).send({ password: PASSWORD })).status).toBe(200);
  }
  return id;
}
const rx = (id: string, body: object) => put(`/api/v1/encounters/${id}/prescription`, dokter).send(body);
const pct = (o: object = {}) => ({ kind: 'DRUG', drugItemId: PCT, doseQty: 1, timesPerDay: 3, route: 'ORAL', durationDays: 3, qty: 9, instructions: 'Sesudah makan', ...o });

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  await su(`update app.practitioner set sip_number = 'SIP/UJI/001', sip_valid_until = current_date + 365 where id = $1`, [DR]);
  await addUser(FARMASI, 'farmasi@a.test', 'Apoteker Uji', 'FARMASI');
  await addUser(PERAWAT, 'perawat@a.test', 'Ners Uji', 'PERAWAT');
  [{ id: BKS }] = await su(`insert into app.uom(tenant_id, code, name) values ($1, 'BKS', 'Bungkus') returning id`, [ids.tenantA]);
  daftar = await login('pendaftaran@a.test');
  dokter = await login('dokter@a.test');
  farmasi = await login('farmasi@a.test');
  perawat = await login('perawat@a.test');
  for (let i = 0; i < 8; i++) await mkPatient(`Pasien Resep ${i + 1}`);
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('Master obat (OD-091)', () => {
  test('C20 farmasi mengelola obat; dokter hanya membaca; zat aktif dinormalisasi; batas dosis divalidasi; nonaktif tersembunyi', async () => {
    const body = { code: 'ctm4', genericName: 'Klorfeniramin maleat 4 mg', dosageForm: 'Tablet', strength: '4 mg', baseUomId: TAB, drugClass: 'BEBAS_TERBATAS',
      ingredients: ['  Klorfeniramin   Maleat '], maxDoseQty: 1, maxDailyQty: 4 };
    expect((await post('/api/v1/drugs', dokter).send(body)).status).toBe(403);
    const r = await post('/api/v1/drugs', farmasi).send(body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ code: 'CTM4', ingredients: ['klorfeniramin maleat'], maxDoseQty: '1', maxDailyQty: '4', uomName: 'Tablet', isActive: true });
    expect((await post('/api/v1/drugs', farmasi).send(body)).body.code).toBe('MST-409-CODE');
    expect((await post('/api/v1/drugs', farmasi).send({ ...body, code: 'X1', maxDoseQty: 2, maxDailyQty: 1 })).body.code).toBe('MST-400-DRUG-MAX');
    expect((await post('/api/v1/drugs', farmasi).send({ ...body, code: 'X2', ingredients: [] })).status).toBe(400);
    expect((await get('/api/v1/drugs?q=klorfen', dokter)).body.data.map((d: { code: string }) => d.code)).toEqual(['CTM4']);
    // Batas dosis untuk parasetamol (dipakai uji peringatan)
    const p = (await get('/api/v1/drugs?q=parasetamol', farmasi)).body.data[0];
    const u = await put(`/api/v1/drugs/${p.id}`, farmasi, p.version).send({ maxDoseQty: 2, maxDailyQty: 8 });
    expect(u.body).toMatchObject({ maxDoseQty: '2', maxDailyQty: '8', version: p.version + 1 });
    expect((await put(`/api/v1/drugs/${p.id}`, farmasi, p.version).send({ maxDoseQty: 1 })).status).toBe(412);
    await put(`/api/v1/drugs/${r.body.id}`, farmasi, r.body.version).send({ isActive: false });
    expect((await get('/api/v1/drugs?q=klorfen', dokter)).body.data).toEqual([]);
    expect((await get('/api/v1/drugs?q=klorfen&includeInactive=true', dokter)).body.data).toHaveLength(1);
    const [a] = await su(`select change_summary from app.audit_log where action = 'DRUG_UPDATED' and resource_id = $1 order by occurred_at limit 1`, [p.id]);
    expect(a.change_summary.after).toMatchObject({ maxDoseQty: '2', maxDailyQty: '8' });
  });

  test('C21 impor obat (CSV) memakai aturan yang sama; zat aktif dipisah |', async () => {
    await su(`insert into app.role_permission(tenant_id, role_id, permission_code) select $1, id, 'master.import' from app.role where tenant_id = $1 and code = 'FARMASI'`, [ids.tenantA]);
    const csv = 'code,genericName,dosageForm,strength,uomCode,drugClass,ingredients,maxDoseQty,maxDailyQty,isActive\n'
      + 'IBU400,Ibuprofen 400 mg,Tablet,400 mg,TAB,BEBAS_TERBATAS,ibuprofen,1,3,ya\n'
      + 'MIX1,Parasetamol + Kafein,Tablet,,TAB,BEBAS,Parasetamol|Kafein,,,\n'
      + 'BAD1,Salah,Tablet,,XXX,BEBAS,a,,,\n';
    const imp = (body: string, dryRun: boolean) => post(`/api/v1/imports/drugs?dryRun=${dryRun}`, farmasi).set('Content-Type', 'text/csv').send(Buffer.from(body));
    const bad = await imp(csv, true);
    expect(bad.body.errors.map((e: { row: number; field: string }) => [e.row, e.field])).toEqual([[4, 'uomCode']]);
    const ok = await imp(csv.split('\n').slice(0, 3).join('\n') + '\n', false);
    expect(ok.body).toMatchObject({ status: 'COMMITTED', created: 2 });
    const [d] = await su(`select ingredients from app.drug_item where code = 'MIX1'`);
    expect(d.ingredients).toEqual(['parasetamol', 'kafein']);
  });
});

describe('Resep elektronik (CLN-FR-010–012; OD-033)', () => {
  test('C22 draft resep: hanya saat diperiksa & oleh dokter; obat/satuan divalidasi; nomor resep; frekuensi & dosis tersusun', async () => {
    const w = await post('/api/v1/encounters/walk-in', daftar).set('Idempotency-Key', `uji-${randomUUID()}`).send({ patientId: P[0], unitId: UNIT, practitionerId: DR });
    expect((await rx(w.body.id, { items: [pct()] })).body.code).toBe('CLN-409-NOT-IN-CONSULTATION');
    const id = await consult(P[1]);
    expect((await put(`/api/v1/encounters/${id}/prescription`, perawat).send({ items: [] })).status).toBe(403);
    const inactive = (await su(`select id from app.drug_item where code = 'CTM4'`))[0].id;
    const bad = await rx(id, { items: [pct({ drugItemId: inactive }), { kind: 'COMPOUND', compoundName: 'Puyer batuk', compoundForm: 'Puyer', uomId: randomUUID(),
      components: [{ drugItemId: PCT, qty: 0.5 }], doseQty: 1, timesPerDay: 3, route: 'ORAL', qty: 10 }] });
    expect(bad.body.code).toBe('CLN-400-RX');
    expect(bad.body.errors.map((e: { field: string }) => e.field)).toEqual(['items.0.drugItemId', 'items.1.uomId']);
    expect((await rx(id, { items: [pct({ timesPerDay: 0 })] })).status).toBe(400);
    const r = await rx(id, { items: [pct(), { kind: 'COMPOUND', compoundName: 'Puyer demam anak', compoundForm: 'Puyer', uomId: BKS,
      components: [{ drugItemId: AMX, qty: 0.25 }], doseQty: 1, timesPerDay: 3, route: 'ORAL', durationDays: 3, qty: 9 }], notes: 'Kontrol bila demam > 3 hari' });
    expect(r.status).toBe(200);
    expect(r.body.prescription).toMatchObject({ prescriptionNo: expect.stringMatching(/^RX\d{6}000001$/), status: 'DRAFT', prescriberName: 'dr. Uji a',
      notes: 'Kontrol bila demam > 3 hari', alerts: [] });
    expect(r.body.prescription.items).toEqual([
      expect.objectContaining({ lineNo: 1, kind: 'DRUG', drugName: 'Parasetamol 500 mg', frequency: '3x sehari', doseQty: 1, qty: 9, uomName: 'Tablet', instructions: 'Sesudah makan' }),
      expect.objectContaining({ lineNo: 2, kind: 'COMPOUND', compoundName: 'Puyer demam anak', uomName: 'Bungkus',
        components: [{ drugItemId: AMX, drugName: 'Amoksisilin 500 mg', qty: 0.25, uomName: 'Tablet' }] }),
    ]);
    // Simpan ulang menggantikan seluruh baris; nomor resep tetap
    const r2 = await rx(id, { items: [pct({ qty: 6 })] });
    expect(r2.body.prescription.items).toHaveLength(1);
    expect(r2.body.prescription.prescriptionNo).toBe(r.body.prescription.prescriptionNo);
    expect((await get(`/api/v1/encounters/${id}/chart`, dokter)).body.prescription.items[0].qty).toBe(6);
  });

  test('C23 peringatan: alergi (termasuk komponen racikan), duplikasi zat aktif, batas dosis per pemberian & per hari; alasan tersimpan per peringatan', async () => {
    await post(`/api/v1/patients/${P[2]}/allergies`, dokter).send({ substance: 'Amoksisilin', category: 'OBAT', severity: 'BERAT' });
    const id = await consult(P[2]);
    const items = [
      { kind: 'COMPOUND', compoundName: 'Puyer', compoundForm: 'Puyer', uomId: BKS, components: [{ drugItemId: AMX, qty: 0.5 }, { drugItemId: PCT, qty: 0.5 }],
        doseQty: 1, timesPerDay: 3, route: 'ORAL', qty: 9 },
      pct({ doseQty: 3, timesPerDay: 4, qty: 36 }),
    ];
    const r = await rx(id, { items });
    expect(r.body.prescription.alerts.map((a: { key: string }) => a.key)).toEqual(['ALLERGY:1:amoksisilin', 'DUPLICATE:parasetamol', 'DOSE_MAX:2', 'DAILY_MAX:2']);
    expect(r.body.prescription.alerts[0]).toMatchObject({ type: 'ALLERGY', lineNo: 1, reason: null, message: expect.stringContaining('alergi amoksisilin') });
    expect(r.body.prescription.alerts[3].message).toContain('12 Tablet per hari melebihi batas 8 Tablet');
    const r2 = await rx(id, { items, overrides: [{ key: 'DUPLICATE:parasetamol', reason: 'Racikan sengaja mengandung parasetamol dosis kecil' }] });
    expect(r2.body.prescription.alerts.find((a: { key: string }) => a.key === 'DUPLICATE:parasetamol').reason).toBe('Racikan sengaja mengandung parasetamol dosis kecil');
    expect(r2.body.prescription.alerts.filter((a: { reason: string | null }) => !a.reason)).toHaveLength(3);
    expect((await rx(id, { items, overrides: [{ key: 'ALLERGY:1:amoksisilin', reason: 'abc' }] })).status).toBe(400);
    const [a] = await su(`select change_summary from app.audit_log where action = 'PRESCRIPTION_SAVED' order by occurred_at desc limit 1`);
    expect(a.change_summary).toMatchObject({ lines: 2, alerts: 4 });
    expect(JSON.stringify(a)).not.toContain('moksisilin');            // nama obat tidak disalin ke audit
  });

  test('C24 selesai konsultasi: wajib disahkan; peringatan tanpa alasan → 422; resep terbit & terkunci; ke Kasir (bawaan)', async () => {
    await post(`/api/v1/patients/${P[3]}/allergies`, dokter).send({ substance: 'Parasetamol', category: 'OBAT' });
    const id = await consult(P[3]);
    await rx(id, { items: [pct()] });
    expect((await post(`/api/v1/encounters/${id}/finish-consultation`, dokter).send()).body.code).toBe('CLN-409-NOT-SIGNED');
    await put(`/api/v1/encounters/${id}/note`, dokter, 0).send({ subjective: 'S', objective: 'O', assessment: 'A', plan: 'P' });
    await put(`/api/v1/encounters/${id}/diagnoses`, dokter).send([{ conceptId: ICD10_R50, rank: 'PRIMER' }]);
    await post(`/api/v1/encounters/${id}/sign`, dokter).send({ password: PASSWORD });
    expect((await post(`/api/v1/encounters/${id}/finish-consultation`, perawat).send()).status).toBe(403);
    const f1 = await post(`/api/v1/encounters/${id}/finish-consultation`, dokter).send();
    expect([f1.status, f1.body.code]).toEqual([422, 'CLN-422-RX-ALERTS']);
    expect(f1.body.alerts.map((a: { key: string }) => a.key)).toEqual(['ALLERGY:1:parasetamol']);
    await rx(id, { items: [pct()], overrides: [{ key: 'ALLERGY:1:parasetamol', reason: 'Riwayat alergi diragukan, sudah dikonfirmasi pasien' }] });
    const f2 = await post(`/api/v1/encounters/${id}/finish-consultation`, dokter).send();
    expect(f2.body).toMatchObject({ id, status: 'BILLING', prescriptionNo: expect.stringMatching(/^RX/) });
    const [p] = await su(`select p.id, p.status, p.issued_at, p.alerts, e.status as enc, e.consult_ended_at from app.prescription p
                          join app.encounter e on e.id = p.encounter_id where p.encounter_id = $1`, [id]);
    expect(p).toMatchObject({ status: 'ISSUED', enc: 'BILLING' });
    expect(p.issued_at).not.toBeNull();
    expect(p.consult_ended_at).not.toBeNull();
    expect(p.alerts[0].reason).toBe('Riwayat alergi diragukan, sudah dikonfirmasi pasien');
    expect((await rx(id, { items: [] })).body.code).toBe('CLN-409-NOT-IN-CONSULTATION');
    const app_ = `set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);`;
    await expect(su(`${app_} update app.prescription_item set qty = 99 where prescription_id = '${p.id}'`)).rejects.toThrow(/IMMUTABLE/);
    await expect(su(`${app_} update app.prescription set alerts = '[]' where id = '${p.id}'`)).rejects.toThrow(/IMMUTABLE/);
    await expect(su(`${app_} delete from app.prescription where id = '${p.id}'`)).rejects.toThrow(/permission denied/);
    await expect(su(`${app_} insert into app.prescription_compound_component(tenant_id, prescription_item_id, drug_item_id, qty, uom_id)
                     select tenant_id, id, '${PCT}', 1, '${TAB}' from app.prescription_item where prescription_id = '${p.id}'`)).rejects.toThrow(/IMMUTABLE/);
  });

  test('C25 pengaturan farmasi sebelum kasir → Farmasi; tanpa resep → Kasir & draft kosong dibatalkan; peringatan dihitung ulang saat selesai', async () => {
    await su(`update app.tenant set settings = settings || '{"pharmacyBeforeCashier": true}' where id = $1`, [ids.tenantA]);
    const a = await consult(P[4], true);
    await rx(a, { items: [pct()] });
    expect((await post(`/api/v1/encounters/${a}/finish-consultation`, dokter).send()).body).toMatchObject({ status: 'PHARMACY' });
    const b = await consult(P[5], true);
    await rx(b, { items: [] });
    expect((await post(`/api/v1/encounters/${b}/finish-consultation`, dokter).send()).body).toEqual({ id: b, status: 'BILLING', prescriptionNo: null });
    expect((await su(`select status from app.prescription where encounter_id = $1`, [b]))[0].status).toBe('CANCELLED');
    expect((await get(`/api/v1/encounters/${b}/prescription`, dokter)).body).toEqual({ prescription: null });
    // Alergi dicatat setelah draft disimpan (tanpa peringatan) → saat selesai tetap ditahan
    const c = await consult(P[6], true);
    expect((await rx(c, { items: [pct()] })).body.prescription.alerts).toEqual([]);
    await post(`/api/v1/patients/${P[6]}/allergies`, perawat).send({ substance: 'parasetamol', category: 'OBAT' });
    expect((await post(`/api/v1/encounters/${c}/finish-consultation`, dokter).send()).body.code).toBe('CLN-422-RX-ALERTS');
    await su(`update app.tenant set settings = settings - 'pharmacyBeforeCashier' where id = $1`, [ids.tenantA]);
  });
});
