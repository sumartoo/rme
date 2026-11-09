import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 11 batch 1 — tagihan kunjungan & penjualan bebas (BIL-FR-001–004; OD-041, OD-105–108, OD-110, OD-113 / DEC-042).
 * Harga snapshot, pembagian penjamin/pasien, diskon dengan persetujuan, tagihan obat susulan. Data sintetis.
 */
const HOST = 'klinik-a.clinicrme.test';
const HOST_B = 'klinik-b.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const BRANCH = A(10), UNIT = A(11), DR = A(20), TAB = A(40), PCT = A(41), PATIENT = A(60), KONS = A(31), LOC = A(50);
let app: INestApplication;
let http: ReturnType<typeof request>;

type Jar = { cookie: string; csrf: string; host: string };
async function login(email: string, host = HOST): Promise<Jar> {
  const r = await http.post('/api/v1/auth/login').set('Host', host).send({ email, password: PASSWORD });
  expect([email, r.status]).toEqual([email, 200]);
  const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const csrf = get('crme_csrf');
  return { cookie: [get('crme_session'), csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '', host };
}
const get = (path: string, j: Jar) => http.get(path).set('Host', j.host).set('Cookie', j.cookie);
const send = (m: 'post' | 'put' | 'delete', path: string, j: Jar, version?: number) => {
  const r = http[m](path).set('Host', j.host).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
  return version === undefined ? r : r.set('If-Match', String(version));
};
const post = (p: string, j: Jar, v?: number) => send('post', p, j, v);
const put = (p: string, j: Jar, v?: number) => send('put', p, j, v);
const del = (p: string, j: Jar, v?: number) => send('delete', p, j, v);

let admin: Jar, kasir: Jar, manajer: Jar, dokter: Jar, serba: Jar, adminB: Jar;
let JAHIT: string, GDS: string, ADM: string, KONS_SP: string, INSURER: string, BATCH: string;
type Inv = { id: string; version: number; status: string; lines: { id: string; lineNo: number; sourceType: string; description: string; qty: number; unitPrice: string;
  discountAmount: string; lineTotal: string; payerPortion: string; patientPortion: string; discountStatus: string; isManual: boolean }[];
  grossAmount: string; discountAmount: string; netAmount: string; payerPortion: string; patientPortion: string; invoiceNo: string | null; kind: string };

async function service(code: string, name: string, type: string, price: number) {
  const [{ id }] = await su(`insert into app.service_item(tenant_id, code, name, service_type) values ($1, $2, $3, $4) returning id`, [ids.tenantA, code, name, type]);
  await su(`insert into app.tariff(tenant_id, service_item_id, price, valid_from) values ($1, $2, $3, current_date - 30)`, [ids.tenantA, id, price]);
  return id as string;
}
/** Kunjungan di kasir dengan tindakan, lab, dan obat yang sudah diserahkan (setara alur Stage 8–10). */
async function encounter(o: { status?: string; payer?: string; procedures?: number; lab?: boolean; drugQty?: number } = {}) {
  let coverage: string | null = null;
  if (o.payer) {
    [{ id: coverage }] = await su(`insert into app.patient_coverage(tenant_id, patient_id, payer_id, member_no) values ($1, $2, $3, 'K-001') returning id`,
      [ids.tenantA, PATIENT, INSURER]);
  }
  const [{ id: enc }] = await su(`insert into app.encounter(tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, arrival_type, status,
      payer_type, coverage_id, coverage_verified_at, arrived_at) values ($1, $2, $3, $4, $5, $6, 'WALK_IN', $7, $8, $9, case when $9::uuid is null then null else now() end, now())
      returning id`, [ids.tenantA, `KJ-${randomUUID().slice(0, 8)}`, PATIENT, BRANCH, UNIT, DR, o.status ?? 'BILLING', o.payer ? 'ASURANSI' : 'UMUM', coverage]);
  for (let i = 0; i < (o.procedures ?? 0); i++) {
    await su(`insert into app.procedure_act(tenant_id, encounter_id, service_item_id, performed_by, qty) values ($1, $2, $3, $4, 2)`, [ids.tenantA, enc, JAHIT, DR]);
  }
  if (o.lab) {
    const [{ id: lo }] = await su(`insert into app.lab_order(tenant_id, order_no, encounter_id, ordered_by) values ($1, $2, $3, $4) returning id`,
      [ids.tenantA, `LAB-${randomUUID().slice(0, 6)}`, enc, DR]);
    await su(`insert into app.lab_order_item(tenant_id, lab_order_id, service_item_id) values ($1, $2, $3)`, [ids.tenantA, lo, GDS]);
  }
  if (o.drugQty) await dispensed(enc, o.drugQty);
  return enc as string;
}
async function dispensed(enc: string, qty: number) {
  const [{ id: rx }] = await su(`insert into app.prescription(tenant_id, prescription_no, encounter_id, prescriber_id) values ($1, $2, $3, $4) returning id`,
    [ids.tenantA, `RX-${randomUUID().slice(0, 8)}`, enc, DR]);
  const [{ id: item }] = await su(`insert into app.prescription_item(tenant_id, prescription_id, line_no, drug_item_id, frequency, route, qty, uom_id)
    values ($1, $2, 1, $3, '3x sehari', 'ORAL', $4, $5) returning id`, [ids.tenantA, rx, PCT, qty, TAB]);
  await su(`update app.prescription set status = 'ISSUED', issued_at = now(), review_checklist = '{}' where id = $1`, [rx]);
  const [{ id: d }] = await su(`insert into app.dispense(tenant_id, prescription_id, location_id, dispensed_by) values ($1, $2, $3, $4) returning id`,
    [ids.tenantA, rx, LOC, ids.dokterA]);
  // dua batch dengan harga terkunci sama → satu baris tagihan
  for (const q of [qty - 1, 1]) {
    await su(`insert into app.dispense_line(tenant_id, dispense_id, prescription_item_id, batch_id, qty_base, drug_item_id, unit_price, item_qty)
      values ($1, $2, $3, $4, $5, $6, 500, $5)`, [ids.tenantA, d, item, BATCH, q, PCT]);
  }
  await su(`update app.prescription_item set qty_dispensed = qty where id = $1`, [item]);
  return item as string;
}
const draft = (enc: string, j = kasir) => post(`/api/v1/billing/encounters/${enc}/invoice`, j);
const line = (inv: Inv, type: string) => inv.lines.find((l) => l.sourceType === type)!;

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  await su(`update app.role set requires_mfa = false where code in ('MANAJER', 'KASIR', 'TENANT_ADMIN')`);
  JAHIT = await service('JAHIT', 'Jahit luka', 'TINDAKAN', 100000);
  GDS = await service('GDS', 'Gula darah sewaktu', 'LAB', 30000);
  ADM = await service('ADM', 'Biaya administrasi', 'ADMINISTRASI', 5000);
  KONS_SP = await service('KONS-SP', 'Konsultasi spesialis', 'KONSULTASI', 150000);
  await su(`insert into app.tariff(tenant_id, service_item_id, price, valid_from) values ($1, $2, 50000, current_date - 30)`, [ids.tenantA, KONS]);
  [{ id: INSURER }] = await su(`insert into app.payer(tenant_id, code, name, payer_type, contract) values ($1, 'ASR1', 'Asuransi Sintetis', 'ASURANSI',
    '{"copayPercent": 20, "plafon": "150000", "paymentTermDays": 30}') returning id`, [ids.tenantA]);
  // Tarif khusus penjamin (lebih tinggi dari tarif umum) — OD-106
  await su(`insert into app.tariff(tenant_id, service_item_id, payer_id, price, valid_from) values ($1, $2, $3, 80000, current_date - 30)`, [ids.tenantA, KONS, INSURER]);
  await su(`insert into app.tariff(tenant_id, service_item_id, payer_type, price, valid_from) values ($1, $2, 'ASURANSI', 70000, current_date - 30)`, [ids.tenantA, KONS]);
  [{ id: BATCH }] = await su(`select id from app.stock_batch where batch_no = 'B-OK' and tenant_id = $1`, [ids.tenantA]);
  await su(`with r as (insert into app.role(tenant_id, code, name, requires_mfa) values ($1, 'KASIR_SERBA', 'Kasir serba', false) returning id)
            insert into app.role_permission(tenant_id, role_id, permission_code) select $1, r.id, p from r,
            unnest(array['billing.invoice.read', 'billing.invoice.issue', 'billing.invoice.discount', 'billing.invoice.void.approve']) p`, [ids.tenantA]);
  await su(`insert into app.app_user(id, tenant_id, email, full_name) values ($1, $2, 'serba@a.test', 'Kasir Serba')`, [A(44), ids.tenantA]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and code = 'KASIR_SERBA'`, [ids.tenantA, A(44)]);
  await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select tenant_id, $2, password_hash from app.user_credential where user_id = $1`, [ids.dokterA, A(44)]);
  admin = await login('admin@a.test');
  kasir = await login('kasir@a.test');
  manajer = await login('manajer@a.test');
  dokter = await login('dokter@a.test');
  serba = await login('serba@a.test');
  adminB = await login('admin@b.test', HOST_B);
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('Master: layanan konsultasi poli & biaya administrasi cabang (OD-105)', () => {
  test('B01 poli memakai layanan konsultasi bawaan; cabang biaya administrasi; jenis layanan divalidasi', async () => {
    const u = (await get('/api/v1/service-units?includeInactive=true', admin)).body.find((x: { id: string }) => x.id === UNIT);
    expect((await put(`/api/v1/service-units/${UNIT}`, admin, u.version).send({ consultServiceId: JAHIT })).body.code).toBe('MST-400-SERVICE');
    const ok = await put(`/api/v1/service-units/${UNIT}`, admin, u.version).send({ consultServiceId: KONS });
    expect([ok.status, ok.body.consultServiceId]).toEqual([200, KONS]);
    const b = (await get('/api/v1/branches', admin)).body.find((x: { id: string }) => x.id === BRANCH);
    const br = await put(`/api/v1/branches/${BRANCH}`, admin, b.version).send({ adminServiceId: ADM });
    expect([br.status, br.body.adminServiceId]).toEqual([200, ADM]);
  });
});

describe('Draf & penerbitan tagihan (BIL-FR-001/002)', () => {
  test('B02 draf otomatis: konsultasi, administrasi, tindakan, lab, obat diserahkan (harga terkunci); bangun ulang stabil; syarat kunjungan', async () => {
    const enc = await encounter({ procedures: 1, lab: true, drugQty: 10 });
    expect((await draft(enc, dokter)).status).toBe(403);
    const r = await draft(enc);
    expect(r.status).toBe(200);
    const inv: Inv = r.body;
    expect(inv).toMatchObject({ kind: 'ENCOUNTER', status: 'DRAFT', invoiceNo: null, payerType: 'UMUM' });
    expect(inv.lines.map((l) => [l.sourceType, l.description, l.qty, l.unitPrice, l.lineTotal])).toEqual([
      ['KONSULTASI', 'Konsultasi Umum', 1, '50000.00', '50000.00'],
      ['ADMINISTRASI', 'Biaya administrasi', 1, '5000.00', '5000.00'],
      ['TINDAKAN', 'Jahit luka', 2, '100000.00', '200000.00'],
      ['LAB', 'Lab: Gula darah sewaktu', 1, '30000.00', '30000.00'],
      ['OBAT', 'Parasetamol 500 mg — Tablet', 10, '500.00', '5000.00'],
    ]);
    expect(inv).toMatchObject({ grossAmount: '290000.00', netAmount: '290000.00', payerPortion: '0.00', patientPortion: '290000.00' });
    expect(await su(`select count(*)::int as n from app.dispense_line d join app.invoice_line l on l.id = d.invoice_line_id where l.invoice_id = $1 and d.billing_status = 'UNBILLED'`, [inv.id]))
      .toEqual([{ n: 2 }]);
    const again: Inv = (await draft(enc)).body;
    expect(again.id).toBe(inv.id);
    expect(again.lines.map((l) => l.lineTotal)).toEqual(inv.lines.map((l) => l.lineTotal));
    // Kunjungan belum di kasir
    const notYet = await encounter({ status: 'PHARMACY' });
    expect((await draft(notYet)).body.code).toBe('BIL-409-NOT-AT-CASHIER');
    // Layanan tanpa tarif berlaku → 422 dengan daftar
    const [{ id: noTariff }] = await su(`insert into app.service_item(tenant_id, code, name, service_type) values ($1, 'USG', 'USG sintetis', 'TINDAKAN') returning id`, [ids.tenantA]);
    const e2 = await encounter();
    await su(`insert into app.procedure_act(tenant_id, encounter_id, service_item_id, performed_by) values ($1, $2, $3, $4)`, [ids.tenantA, e2, noTariff, DR]);
    const m = await draft(e2);
    expect([m.status, m.body.code, m.body.errors[0].message]).toEqual([422, 'BIL-422-TARIFF', 'Layanan "USG sintetis" belum punya tarif berlaku untuk penjamin ini']);
    expect((await get(`/api/v1/invoices/${inv.id}`, adminB)).status).toBe(403);
  });

  test('B03 terbit: nomor INV, terkunci, obat BILLED; tarif berubah sesudahnya tidak memengaruhi; draf dapat dihapus, tagihan terbit tidak', async () => {
    const enc = await encounter({ procedures: 1, drugQty: 4 });
    const inv: Inv = (await draft(enc)).body;
    expect((await post(`/api/v1/invoices/${inv.id}/issue`, kasir, inv.version + 5).send()).status).toBe(412);
    const iss = await post(`/api/v1/invoices/${inv.id}/issue`, kasir, inv.version).send();
    expect(iss.status).toBe(200);
    expect(iss.body.invoiceNo).toMatch(/^INV\d{6}\d{6}$/);
    expect(iss.body).toMatchObject({ status: 'ISSUED', issuedByName: 'Kasir' });
    expect(await su(`select distinct d.billing_status from app.dispense_line d join app.invoice_line l on l.id = d.invoice_line_id where l.invoice_id = $1`, [inv.id]))
      .toEqual([{ billing_status: 'BILLED' }]);
    // Tarif baru tidak mengubah tagihan yang sudah dibuat (snapshot)
    await su(`update app.tariff set valid_to = current_date - 1 where service_item_id = $1 and valid_to is null`, [JAHIT]);
    await su(`insert into app.tariff(tenant_id, service_item_id, price, valid_from) values ($1, $2, 125000, current_date)`, [ids.tenantA, JAHIT]);
    const after: Inv = (await get(`/api/v1/invoices/${inv.id}`, kasir)).body;
    expect(line(after, 'TINDAKAN').unitPrice).toBe('100000.00');
    expect(after.netAmount).toBe(iss.body.netAmount);
    expect((await post(`/api/v1/invoices/${inv.id}/lines`, kasir, iss.body.version).send({ serviceItemId: GDS })).body.code).toBe('BIL-409-NOT-DRAFT');
    expect((await del(`/api/v1/invoices/${inv.id}`, kasir, iss.body.version).send()).body.code).toBe('BIL-409-NOT-DRAFT');
    expect((await draft(enc)).body.code).toBe('BIL-409-NOTHING');
    const asApp = `set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);`;
    await expect(su(`${asApp} update app.invoice_line set unit_price = 1 where invoice_id = '${inv.id}'`)).rejects.toThrow(/IMMUTABLE/);
    await expect(su(`${asApp} update app.invoice set net_amount = 1, gross_amount = 1 where id = '${inv.id}'`)).rejects.toThrow(/IMMUTABLE/);
    // Tarif baru dipakai pada draf baru
    const e2 = await encounter({ procedures: 1 });
    expect(line((await draft(e2)).body, 'TINDAKAN').unitPrice).toBe('125000.00');
    // Draf boleh dihapus; obat dilepas kembali
    const e3 = await encounter({ drugQty: 2 });
    const d3: Inv = (await draft(e3)).body;
    const gone = await del(`/api/v1/invoices/${d3.id}`, kasir, d3.version).send();
    expect(gone.body).toEqual({ id: d3.id, deleted: true });
    expect(await su(`select count(*)::int as n from app.dispense_line dl join app.dispense ds on ds.id = dl.dispense_id join app.prescription p on p.id = ds.prescription_id
      where p.encounter_id = $1 and dl.invoice_line_id is null`, [e3])).toEqual([{ n: 2 }]);
    expect(await su(`select action from app.audit_log where resource_id = $1 order by seq`, [inv.id])).toEqual([{ action: 'INVOICE_DRAFTED' }, { action: 'INVOICE_ISSUED' }]);
  });
});

describe('Diskon, pembagian penjamin, baris tambahan (BIL-FR-003/004)', () => {
  test('B04 diskon ≤ 10% langsung; di atas batas menunggu persetujuan orang lain; terbit ditahan; tolak menghapus diskon', async () => {
    const enc = await encounter({ procedures: 1 });
    let inv: Inv = (await draft(enc)).body;
    const t = line(inv, 'TINDAKAN');
    const k = line(inv, 'KONSULTASI');
    expect((await put(`/api/v1/invoices/${inv.id}/lines/${t.id}`, kasir, inv.version).send({ discountAmount: 5000 })).body.title).toBe('Alasan diskon wajib diisi');
    inv = (await put(`/api/v1/invoices/${inv.id}/lines/${k.id}`, kasir, inv.version).send({ discountAmount: 5000, discountReason: 'Pasien lansia' })).body;
    expect(line(inv, 'KONSULTASI')).toMatchObject({ discountAmount: '5000.00', lineTotal: '45000.00', discountStatus: 'WITHIN_LIMIT' });
    inv = (await put(`/api/v1/invoices/${inv.id}/lines/${t.id}`, kasir, inv.version).send({ discountAmount: 50000, discountReason: 'Keringanan sosial' })).body;
    expect(line(inv, 'TINDAKAN').discountStatus).toBe('PENDING');
    expect(inv).toMatchObject({ discountAmount: '55000.00', netAmount: String((inv.lines.reduce((s, l) => s + Number(l.lineTotal), 0)).toFixed(2)) });
    expect((await post(`/api/v1/invoices/${inv.id}/issue`, kasir, inv.version).send()).body.code).toBe('BIL-409-DISCOUNT-PENDING');
    const pending = await get('/api/v1/invoices?discountPending=true', manajer);
    expect(pending.body.map((x: { id: string }) => x.id)).toContain(inv.id);
    expect((await post(`/api/v1/invoices/${inv.id}/lines/${t.id}/discount-decision`, kasir).send({ decision: 'APPROVE' })).status).toBe(403);
    inv = (await post(`/api/v1/invoices/${inv.id}/lines/${t.id}/discount-decision`, manajer).send({ decision: 'APPROVE' })).body;
    expect(line(inv, 'TINDAKAN')).toMatchObject({ discountStatus: 'APPROVED', discountApprovedByName: 'Manajer', lineTotal: '200000.00' });
    expect((await post(`/api/v1/invoices/${inv.id}/issue`, kasir, inv.version).send()).body.status).toBe('ISSUED');
    // Pemegang dua izin tetap tidak dapat menyetujui diskonnya sendiri; penolakan menghapus diskon
    const e2 = await encounter({ procedures: 1 });
    let d2: Inv = (await draft(e2, serba)).body;
    d2 = (await put(`/api/v1/invoices/${d2.id}/lines/${line(d2, 'TINDAKAN').id}`, serba, d2.version).send({ discountAmount: 200000, discountReason: 'Gratis' })).body;
    const self = await post(`/api/v1/invoices/${d2.id}/lines/${line(d2, 'TINDAKAN').id}/discount-decision`, serba).send({ decision: 'APPROVE' });
    expect([self.status, self.body.code]).toEqual([403, 'BIL-403-SELF-APPROVAL']);
    d2 = (await post(`/api/v1/invoices/${d2.id}/lines/${line(d2, 'TINDAKAN').id}/discount-decision`, manajer).send({ decision: 'REJECT', note: 'Tanpa dasar' })).body;
    expect(line(d2, 'TINDAKAN')).toMatchObject({ discountAmount: '0.00', discountStatus: 'NONE' });
    expect((await put(`/api/v1/invoices/${d2.id}/lines/${line(d2, 'TINDAKAN').id}`, serba, d2.version).send({ discountAmount: 999999, discountReason: 'x lebih' })).body.code).toBe('BIL-400-DISCOUNT');
    // Batas klinik dapat diatur
    await su(`update app.tenant set settings = settings || '{"discountLimitPercent": 50}' where id = $1`, [ids.tenantA]);
    d2 = (await put(`/api/v1/invoices/${d2.id}/lines/${line(d2, 'TINDAKAN').id}`, serba, d2.version).send({ discountAmount: 90000, discountReason: 'Keringanan' })).body;
    expect(line(d2, 'TINDAKAN').discountStatus).toBe('WITHIN_LIMIT');
    await su(`update app.tenant set settings = settings - 'discountLimitPercent' where id = $1`, [ids.tenantA]);
    expect(await su(`select count(*)::int as n from app.audit_log where action in ('INVOICE_DISCOUNT_APPROVED', 'INVOICE_DISCOUNT_REJECTED')`)).toEqual([{ n: 2 }]);
  });

  test('B05 penjamin: tarif khusus penjamin, co-pay 20%, plafon per kunjungan (kelebihan ke pasien), pembagian manual beralasan', async () => {
    const enc = await encounter({ payer: 'ASURANSI', procedures: 1, drugQty: 10 });
    let inv: Inv = (await draft(enc)).body;
    expect(inv).toMatchObject({ payerType: 'ASURANSI', payerName: 'Asuransi Sintetis', contract: { copayPercent: 20, plafon: '150000' } });
    // KONS 80.000 (tarif penjamin), ADM 5.000, JAHIT 2×125.000, PCT 10×500
    const parts = inv.lines.map((l) => [l.sourceType, l.lineTotal, l.payerPortion, l.patientPortion]);
    expect(parts).toEqual([
      ['KONSULTASI', '80000.00', '64000.00', '16000.00'],
      ['ADMINISTRASI', '5000.00', '4000.00', '1000.00'],
      ['TINDAKAN', '250000.00', '82000.00', '168000.00'],   // sisa plafon 150.000 − 68.000
      ['OBAT', '5000.00', '0.00', '5000.00'],
    ]);
    expect(inv).toMatchObject({ netAmount: '340000.00', payerPortion: '150000.00', patientPortion: '190000.00' });
    expect((await put(`/api/v1/invoices/${inv.id}/lines/${line(inv, 'OBAT').id}`, kasir, inv.version).send({ payerPortion: 5000 })).body.code).toBe('BIL-400-SPLIT');
    inv = (await put(`/api/v1/invoices/${inv.id}/lines/${line(inv, 'OBAT').id}`, kasir, inv.version).send({ payerPortion: 5000, splitReason: 'Obat dijamin penuh sesuai polis' })).body;
    expect(line(inv, 'OBAT')).toMatchObject({ payerPortion: '5000.00', patientPortion: '0.00' });
    expect(line(inv, 'TINDAKAN').payerPortion).toBe('77000.00');   // plafon dikurangi baris manual
    expect(Number(inv.payerPortion) + Number(inv.patientPortion)).toBe(Number(inv.netAmount));
    inv = (await put(`/api/v1/invoices/${inv.id}/lines/${line(inv, 'OBAT').id}`, kasir, inv.version).send({ payerPortion: null })).body;
    expect(line(inv, 'OBAT').payerPortion).toBe('0.00');
    const umum = await encounter();
    const u: Inv = (await draft(umum)).body;
    expect((await put(`/api/v1/invoices/${u.id}/lines/${u.lines[0].id}`, kasir, u.version).send({ payerPortion: 1, splitReason: 'coba' })).body.code).toBe('BIL-409-SPLIT');
  });

  test('B06 baris tambahan & ganti konsultasi; baris otomatis tidak dapat dihapus/diubah jumlahnya; PDF rincian', async () => {
    const enc = await encounter({ procedures: 1 });
    let inv: Inv = (await draft(enc)).body;
    inv = (await post(`/api/v1/invoices/${inv.id}/lines`, kasir, inv.version).send({ serviceItemId: GDS, qty: 2 })).body;
    const added = inv.lines.find((l) => l.isManual)!;
    expect(added).toMatchObject({ sourceType: 'LAB', qty: 2, lineTotal: '60000.00' });
    inv = (await put(`/api/v1/invoices/${inv.id}/lines/${added.id}`, kasir, inv.version).send({ qty: 1 })).body;
    expect(inv.lines.find((l) => l.isManual)!.lineTotal).toBe('30000.00');
    expect((await put(`/api/v1/invoices/${inv.id}/lines/${line(inv, 'TINDAKAN').id}`, kasir, inv.version).send({ qty: 5 })).body.code).toBe('BIL-409-AUTO-LINE');
    expect((await del(`/api/v1/invoices/${inv.id}/lines/${line(inv, 'TINDAKAN').id}`, kasir, inv.version).send()).body.code).toBe('BIL-409-AUTO-LINE');
    expect((await put(`/api/v1/invoices/${inv.id}/lines/${line(inv, 'KONSULTASI').id}`, kasir, inv.version).send({ serviceItemId: JAHIT })).body.code).toBe('BIL-400-SERVICE');
    inv = (await put(`/api/v1/invoices/${inv.id}/lines/${line(inv, 'KONSULTASI').id}`, kasir, inv.version).send({ serviceItemId: KONS_SP })).body;
    expect(line(inv, 'KONSULTASI')).toMatchObject({ description: 'Konsultasi spesialis', unitPrice: '150000.00' });
    // Bangun ulang mempertahankan konsultasi pilihan kasir & baris tambahan
    inv = (await draft(enc)).body;
    expect(line(inv, 'KONSULTASI').description).toBe('Konsultasi spesialis');
    expect(inv.lines.filter((l) => l.isManual)).toHaveLength(1);
    inv = (await del(`/api/v1/invoices/${inv.id}/lines/${inv.lines.find((l) => l.isManual)!.id}`, kasir, inv.version).send()).body;
    expect(inv.lines.some((l) => l.isManual)).toBe(false);
    const pdf = await get(`/api/v1/invoices/${inv.id}/pdf`, kasir).buffer(true).parse((res, cb) => {
      const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect([pdf.status, pdf.headers['content-type'], (pdf.body as Buffer).subarray(0, 4).toString()]).toEqual([200, 'application/pdf', '%PDF']);
  });
});

describe('Obat susulan & penjualan bebas (OD-107, OD-113)', () => {
  test('B07 kasir-dulu: tagihan jasa terbit → obat diserahkan kemudian → tagihan obat susulan; worklist', async () => {
    const enc = await encounter({ procedures: 1 });
    const main: Inv = (await draft(enc)).body;
    const iss = (await post(`/api/v1/invoices/${main.id}/issue`, kasir, main.version).send()).body;
    expect(iss.status).toBe('ISSUED');
    await su(`update app.encounter set status = 'PHARMACY' where id = $1`, [enc]);   // dibayar → farmasi (batch 2)
    await dispensed(enc, 6);
    const wl = await get(`/api/v1/billing/worklist?branchId=${BRANCH}`, kasir);
    expect(wl.body.find((x: { refId: string; type: string }) => x.refId === enc && x.type === 'DRUG')).toMatchObject({ invoice: null, patient: { mrn: 'RM-a-0001' } });
    const sup: Inv = (await draft(enc)).body;
    expect(sup.kind).toBe('DRUG');
    expect(sup.lines.map((l) => [l.sourceType, l.qty, l.lineTotal])).toEqual([['OBAT', 6, '3000.00']]);
    expect((await post(`/api/v1/invoices/${sup.id}/issue`, kasir, sup.version).send()).body.status).toBe('ISSUED');
    expect((await draft(enc)).body.code).toBe('BIL-409-NOTHING');
    expect((await get(`/api/v1/billing/worklist`, kasir)).body.find((x: { refId: string; type: string }) => x.refId === enc && x.type === 'DRUG')).toBeUndefined();
  });

  test('B08 penjualan bebas menunggu bayar → tagihan OTC berisi obat yang dijual; tidak dapat ditambah layanan', async () => {
    const [{ id: sale }] = await su(`insert into app.otc_sale(tenant_id, sale_no, branch_id, location_id, sold_by, customer_name, total)
      values ($1, 'OTC-UJI-1', $2, $3, $4, 'Pembeli umum', 4500) returning id`, [ids.tenantA, BRANCH, LOC, ids.dokterA]);
    await su(`insert into app.otc_sale_line(tenant_id, otc_sale_id, drug_item_id, batch_id, qty_base, unit_price) values ($1, $2, $3, $4, 9, 500)`, [ids.tenantA, sale, PCT, BATCH]);
    const wl = await get('/api/v1/billing/worklist', kasir);
    expect(wl.body.find((x: { refId: string }) => x.refId === sale)).toMatchObject({ type: 'OTC', refNo: 'OTC-UJI-1', customerName: 'Pembeli umum', invoice: null });
    const inv: Inv = (await post(`/api/v1/billing/otc-sales/${sale}/invoice`, kasir).send()).body;
    expect(inv).toMatchObject({ kind: 'OTC', customerName: 'Pembeli umum', netAmount: '4500.00', patientPortion: '4500.00' });
    expect((await post(`/api/v1/invoices/${inv.id}/lines`, kasir, inv.version).send({ serviceItemId: GDS })).body.code).toBe('BIL-409-OTC-LINES');
    const iss = await post(`/api/v1/invoices/${inv.id}/issue`, kasir, inv.version).send();
    expect(iss.body.status).toBe('ISSUED');
    expect((await post(`/api/v1/billing/otc-sales/${sale}/invoice`, kasir).send()).body.id).toBe(inv.id);
    await su(`update app.otc_sale set status = 'CANCELLED', cancel_reason = 'uji', cancelled_at = now() where id = $1`, [sale]);
    expect((await post(`/api/v1/billing/otc-sales/${sale}/invoice`, kasir).send()).body.code).toBe('BIL-409-OTC-STATE');
  });
});
