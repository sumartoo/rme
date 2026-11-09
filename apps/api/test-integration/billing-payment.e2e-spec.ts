import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 11 batch 2 — shift kasir, pembayaran, kwitansi, pembentukan piutang (BIL-FR-005, 007, 008, 011, 013; OD-107–111, OD-113 / DEC-042).
 * Data sintetis.
 */
const HOST = 'klinik-a.clinicrme.test';
const HOST_B = 'klinik-b.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const BRANCH = A(10), UNIT = A(11), DR = A(20), TAB = A(40), PCT = A(41), PATIENT = A(60), KONS = A(31), LOC = A(50), KASIR2 = A(45);
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
const post = (path: string, j: Jar, version?: number) => {
  const r = http.post(path).set('Host', j.host).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
  return version === undefined ? r : r.set('If-Match', String(version));
};
/** Pembayaran: Idempotency-Key unik per percobaan kecuali diberikan. */
const pay = (inv: string, body: Record<string, unknown>, j: Jar = kasir, key = `pay-${randomUUID()}`) =>
  post(`/api/v1/invoices/${inv}/payments`, j).set('Idempotency-Key', key).send(body);

let kasir: Jar, kasir2: Jar, manajer: Jar, adminB: Jar;
let JAHIT: string, INSURER: string, FULLCOVER: string, BATCH: string;
type Inv = { id: string; version: number; status: string; patientPortion: string; payerPortion: string; netAmount: string; paidAmount: string; outstanding: string;
  payments: { id: string; receiptNo: string; method: string; amount: string; change: string | null }[];
  receivable: { amount: string; dueDate: string; status: string } | null };

async function encounter(o: { payer?: string; procedures?: number } = {}) {
  let coverage: string | null = null;
  if (o.payer) {
    [{ id: coverage }] = await su(`insert into app.patient_coverage(tenant_id, patient_id, payer_id, member_no) values ($1, $2, $3, $4) returning id`,
      [ids.tenantA, PATIENT, o.payer, `K-${randomUUID().slice(0, 6)}`]);
  }
  const [{ id }] = await su(`insert into app.encounter(tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, arrival_type, status,
      payer_type, coverage_id, coverage_verified_at, arrived_at) values ($1, $2, $3, $4, $5, $6, 'WALK_IN', 'BILLING', $7, $8, case when $8::uuid is null then null else now() end, now())
      returning id`, [ids.tenantA, `KJ-${randomUUID().slice(0, 8)}`, PATIENT, BRANCH, UNIT, DR, o.payer ? 'ASURANSI' : 'UMUM', coverage]);
  for (let i = 0; i < (o.procedures ?? 0); i++) {
    await su(`insert into app.procedure_act(tenant_id, encounter_id, service_item_id, performed_by, qty) values ($1, $2, $3, $4, 2)`, [ids.tenantA, id, JAHIT, DR]);
  }
  return id as string;
}
/** Draf → terbit; kembalikan tagihan terbit. */
async function issued(enc: string): Promise<Inv> {
  const d = (await post(`/api/v1/billing/encounters/${enc}/invoice`, kasir).send()).body;
  const r = await post(`/api/v1/invoices/${d.id}/issue`, kasir, d.version).send();
  expect(r.status).toBe(200);
  return r.body;
}
const invoice = async (id: string): Promise<Inv> => (await get(`/api/v1/invoices/${id}`, kasir)).body;
const encStatus = async (id: string) => (await su(`select status from app.encounter where id = $1`, [id]))[0].status as string;

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  await su(`update app.role set requires_mfa = false where code in ('MANAJER', 'KASIR', 'TENANT_ADMIN')`);
  [{ id: JAHIT }] = await su(`insert into app.service_item(tenant_id, code, name, service_type) values ($1, 'JAHIT', 'Jahit luka', 'TINDAKAN') returning id`, [ids.tenantA]);
  await su(`insert into app.tariff(tenant_id, service_item_id, price, valid_from) values ($1, $2, 100000, current_date - 30)`, [ids.tenantA, JAHIT]);
  await su(`insert into app.tariff(tenant_id, service_item_id, price, valid_from) values ($1, $2, 50000, current_date - 30)`, [ids.tenantA, KONS]);
  await su(`update app.service_unit set consult_service_id = $1 where id = $2`, [KONS, UNIT]);
  [{ id: INSURER }] = await su(`insert into app.payer(tenant_id, code, name, payer_type, contract) values ($1, 'ASR1', 'Asuransi Sintetis', 'ASURANSI',
    '{"copayPercent": 20, "paymentTermDays": 45}') returning id`, [ids.tenantA]);
  [{ id: FULLCOVER }] = await su(`insert into app.payer(tenant_id, code, name, payer_type, contract) values ($1, 'PRS1', 'Perusahaan Sintetis', 'ASURANSI', '{}') returning id`,
    [ids.tenantA]);
  [{ id: BATCH }] = await su(`select id from app.stock_batch where batch_no = 'B-OK' and tenant_id = $1`, [ids.tenantA]);
  // Kasir kedua (role KASIR bawaan) untuk uji kepemilikan shift
  await su(`insert into app.app_user(id, tenant_id, email, full_name) values ($1, $2, 'kasir2@a.test', 'Kasir Dua')`, [KASIR2, ids.tenantA]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and code = 'KASIR'`, [ids.tenantA, KASIR2]);
  await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select tenant_id, $2, password_hash from app.user_credential where user_id = $1`, [ids.kasirA, KASIR2]);
  // Seed uji membuka satu shift untuk kasir; mulai dari keadaan tanpa shift terbuka
  await su(`update app.cashier_shift set status = 'CLOSED', closed_at = now(), counted_cash = opening_cash, expected_cash = opening_cash where tenant_id = $1`, [ids.tenantA]);
  kasir = await login('kasir@a.test');
  kasir2 = await login('kasir2@a.test');
  manajer = await login('manajer@a.test');
  // Klinik B dapat membaca tagihan & piutang miliknya sendiri — untuk uji isolasi tenant
  await su(`insert into app.role_permission(tenant_id, role_id, permission_code) select r.tenant_id, r.id, p from app.role r,
            unnest(array['billing.invoice.read', 'billing.receivable.read']) p where r.tenant_id = $1 and r.code = 'TENANT_ADMIN' on conflict do nothing`, [ids.tenantB]);
  adminB = await login('admin@b.test', HOST_B);
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('Shift kasir & pembayaran (BIL-FR-005, 007, 008, 011)', () => {
  let shiftId: string;
  let paidInv: Inv;

  test('L01 pembayaran tanpa shift ditolak; buka shift dengan kas awal, satu shift terbuka per kasir', async () => {
    const inv = await issued(await encounter({ procedures: 1 }));
    expect((await pay(inv.id, { method: 'TUNAI', amount: 1000 })).body.code).toBe('BIL-409-NO-SHIFT');
    expect((await get('/api/v1/cashier-shifts/current', kasir)).body.shift).toBeNull();
    expect((await post('/api/v1/cashier-shifts', kasir).send({ openingCash: 200000 })).body.code).toBe('BIL-400-BRANCH');
    const s = await post('/api/v1/cashier-shifts', kasir).send({ branchId: BRANCH, openingCash: 200000 });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ status: 'OPEN', openingCash: '200000.00', expectedCash: '200000.00', cashierName: 'Kasir', paymentCount: 0 });
    shiftId = s.body.id;
    expect((await post('/api/v1/cashier-shifts', kasir).send({ branchId: BRANCH, openingCash: 0 })).body.code).toBe('BIL-409-SHIFT-OPEN');
    expect((await get('/api/v1/cashier-shifts/current', kasir)).body.shift.id).toBe(shiftId);
    expect((await post('/api/v1/cashier-shifts', manajer).send({ branchId: BRANCH, openingCash: 0 })).status).toBe(403);
  });

  test('L02 tunai dengan kembalian, idempoten; validasi referensi & nominal; sebagian lalu debit → lunas; kunjungan selesai; kwitansi 80 mm', async () => {
    const enc = await encounter({ procedures: 1 });
    const inv = await issued(enc);
    expect(inv).toMatchObject({ status: 'ISSUED', patientPortion: '250000.00', outstanding: '250000.00', payments: [], receivable: null });
    expect((await pay(inv.id, { method: 'DEBIT', amount: 1000 })).body.code).toBe('BIL-400-REFERENCE');
    expect((await pay(inv.id, { method: 'TUNAI', amount: 100000, cashTendered: 50000 })).body.code).toBe('BIL-400-TENDERED');
    expect((await pay(inv.id, { method: 'TUNAI', amount: 250000.01 })).body.code).toBe('BIL-409-OVERPAY');
    expect((await pay(inv.id, { method: 'TUNAI', amount: 0 })).status).toBe(400);
    expect((await post(`/api/v1/invoices/${inv.id}/payments`, kasir).send({ method: 'TUNAI', amount: 1000 })).body.code).toBe('GEN-400-IDEMPOTENCY-KEY');
    const key = `pay-${randomUUID()}`;
    const p1 = await pay(inv.id, { method: 'TUNAI', amount: 100000, cashTendered: 150000 }, kasir, key);
    expect(p1.status).toBe(201);
    expect(p1.body).toMatchObject({ method: 'TUNAI', amount: '100000.00', cashTendered: '150000.00', change: '50000.00', invoiceStatus: 'PARTIALLY_PAID',
      receivedByName: 'Kasir' });
    expect(p1.body.receiptNo).toMatch(/^KW\d{4}\d{2}\d{6}$/);
    // Klien mengulang permintaan yang sama → tidak tercatat dua kali; kunci sama untuk isi lain → ditolak
    expect((await pay(inv.id, { method: 'TUNAI', amount: 100000, cashTendered: 150000 }, kasir, key)).body.id).toBe(p1.body.id);
    expect((await pay(inv.id, { method: 'TUNAI', amount: 5000 }, kasir, key)).body.code).toBe('GEN-409-IDEMPOTENCY');
    expect(await su(`select count(*)::int as n from app.payment where invoice_id = $1`, [inv.id])).toEqual([{ n: 1 }]);
    let cur = await invoice(inv.id);
    expect(cur).toMatchObject({ status: 'PARTIALLY_PAID', paidAmount: '100000.00', outstanding: '150000.00' });
    expect(await encStatus(enc)).toBe('BILLING');
    const p2 = await pay(inv.id, { method: 'DEBIT', amount: 150000, reference: 'EDC-778899', cashTendered: 999999 });
    expect(p2.body).toMatchObject({ method: 'DEBIT', reference: 'EDC-778899', cashTendered: null, change: null, invoiceStatus: 'PAID' });
    cur = await invoice(inv.id);
    expect(cur).toMatchObject({ status: 'PAID', paidAmount: '250000.00', outstanding: '0.00' });
    expect(cur.payments.map((p) => [p.method, p.amount])).toEqual([['TUNAI', '100000.00'], ['DEBIT', '150000.00']]);
    expect(await encStatus(enc)).toBe('FINISHED');
    expect((await pay(inv.id, { method: 'TUNAI', amount: 1 })).body.code).toBe('BIL-409-NOT-PAYABLE');
    // Draf belum terbit tidak dapat dibayar
    const d = (await post(`/api/v1/billing/encounters/${await encounter()}/invoice`, kasir).send()).body;
    expect((await pay(d.id, { method: 'TUNAI', amount: 1 })).body.code).toBe('BIL-409-NOT-PAYABLE');
    // Kwitansi PDF; pembayaran tidak dapat diubah (append-only)
    const r = await get(`/api/v1/payments/${p1.body.id}/receipt`, kasir).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect([r.status, r.headers['content-type']]).toEqual([200, 'application/pdf']);
    expect((r.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await get(`/api/v1/payments/${p1.body.id}/receipt`, adminB)).status).toBe(404);
    await expect(su(`update app.payment set amount = 1 where id = $1`, [p1.body.id])).rejects.toThrow();
    expect(await su(`select action from app.audit_log where resource_id = $1 order by occurred_at`, [p1.body.id]))
      .toEqual([{ action: 'PAYMENT_RECORDED' }, { action: 'RECEIPT_VIEWED' }]);
    paidInv = cur;
  });

  test('L03 tutup shift: kas diharapkan = kas awal + tunai; selisih di atas toleransi wajib keterangan; hanya pemilik; sesudah tutup tidak bisa menerima bayar', async () => {
    const cur = (await get('/api/v1/cashier-shifts/current', kasir)).body.shift;
    expect(cur).toMatchObject({ id: shiftId, expectedCash: '300000.00', paymentCount: 2,
      totals: [{ method: 'DEBIT', count: 1, total: '150000.00' }, { method: 'TUNAI', count: 1, total: '100000.00' }] });
    // Kasir lain tidak dapat menutup shift ini
    expect((await post(`/api/v1/cashier-shifts/${shiftId}/close`, kasir2).send({ countedCash: 300000 })).body.code).toBe('BIL-403-SHIFT-OWNER');
    const bad = await post(`/api/v1/cashier-shifts/${shiftId}/close`, kasir).send({ countedCash: 280000 });
    expect([bad.status, bad.body.code]).toEqual([400, 'BIL-400-VARIANCE-NOTE']);
    const ok = await post(`/api/v1/cashier-shifts/${shiftId}/close`, kasir).send({ countedCash: 280000, varianceNote: 'Uang kembalian salah hitung', denominations: { '100000': 2, '50000': 1, '10000': 3 } });
    expect(ok.body).toMatchObject({ status: 'CLOSED', expectedCash: '300000.00', countedCash: '280000.00', variance: '-20000.00', varianceNote: 'Uang kembalian salah hitung' });
    expect((await post(`/api/v1/cashier-shifts/${shiftId}/close`, kasir).send({ countedCash: 1 })).body.code).toBe('BIL-409-SHIFT-CLOSED');
    expect((await get('/api/v1/cashier-shifts/current', kasir)).body.shift).toBeNull();
    const inv = await issued(await encounter());
    expect((await pay(inv.id, { method: 'TUNAI', amount: 1000 })).body.code).toBe('BIL-409-NO-SHIFT');
    // Selisih dalam toleransi (bawaan Rp 10.000) tanpa keterangan
    const s2 = (await post('/api/v1/cashier-shifts', kasir2).send({ branchId: BRANCH, openingCash: 50000 })).body;
    expect((await pay(inv.id, { method: 'TUNAI', amount: 50000 }, kasir2)).body.invoiceStatus).toBe('PAID');
    const c2 = await post(`/api/v1/cashier-shifts/${s2.id}/close`, kasir2).send({ countedCash: 95000 });
    expect(c2.body).toMatchObject({ status: 'CLOSED', expectedCash: '100000.00', variance: '-5000.00', varianceNote: null });
    expect(await su(`select action, change_summary->>'variance' as v from app.audit_log where resource_id = $1 order by occurred_at`, [s2.id]))
      .toEqual([{ action: 'SHIFT_OPENED', v: null }, { action: 'SHIFT_CLOSED', v: '-5000' }]);
    expect(paidInv.status).toBe('PAID');
  });
});

describe('Penjamin, alur kasir-dulu, obat bebas (OD-107, OD-108, OD-113)', () => {
  beforeAll(async () => {
    const s = await post('/api/v1/cashier-shifts', kasir).send({ branchId: BRANCH, openingCash: 100000 });
    expect(s.status).toBe(201);
  });

  test('L04 porsi penjamin menjadi piutang (jatuh tempo sesuai kontrak); ditanggung penuh → langsung lunas; daftar piutang', async () => {
    const enc = await encounter({ payer: INSURER, procedures: 1 });
    const inv = await issued(enc);
    expect(inv).toMatchObject({ status: 'ISSUED', payerPortion: '200000.00', patientPortion: '50000.00' });
    const [{ due }] = await su(`select to_char((now() at time zone 'Asia/Jakarta')::date + 45, 'YYYY-MM-DD') as due`);
    expect(inv.receivable).toMatchObject({ amount: '200000.00', paidAmount: '0.00', dueDate: due, status: 'OPEN' });
    expect((await pay(inv.id, { method: 'TRANSFER', amount: 50000, reference: 'TRF-0001' })).body.invoiceStatus).toBe('PAID');
    expect(await encStatus(enc)).toBe('FINISHED');
    // Ditanggung penuh (tanpa co-pay): porsi pasien Rp 0 → lunas saat terbit
    const enc2 = await encounter({ payer: FULLCOVER });
    const full = await issued(enc2);
    expect(full).toMatchObject({ status: 'PAID', patientPortion: '0.00', payerPortion: '50000.00', receivable: { amount: '50000.00' } });
    expect(await encStatus(enc2)).toBe('FINISHED');
    const list = (await get('/api/v1/receivables?status=OPEN', manajer)).body as { invoiceId: string; payerName: string; balance: string; overdue: boolean }[];
    expect(list.map((x) => [x.invoiceId, x.payerName, x.balance, x.overdue])).toEqual([
      [full.id, 'Perusahaan Sintetis', '50000.00', false], [inv.id, 'Asuransi Sintetis', '200000.00', false]]);
    expect((await get(`/api/v1/receivables?payerId=${INSURER}`, kasir)).body.map((x: { invoiceId: string }) => x.invoiceId)).toEqual([inv.id]);
    await su(`update app.receivable set due_date = current_date - 1 where invoice_id = $1`, [inv.id]);
    expect((await get('/api/v1/receivables?overdue=true', manajer)).body.map((x: { invoiceId: string }) => x.invoiceId)).toEqual([inv.id]);
    expect((await get('/api/v1/receivables', adminB)).body).toEqual([]);
    expect((await get('/api/v1/receivables?status=X', manajer)).status).toBe(400);
  });

  test('L05 kasir-dulu: lunas dengan resep terbuka → kunjungan ke farmasi; tanpa resep → selesai', async () => {
    await su(`update app.tenant set settings = settings || '{"pharmacyBeforeCashier": false}' where id = $1`, [ids.tenantA]);
    try {
      const enc = await encounter();
      const [{ id: rx }] = await su(`insert into app.prescription(tenant_id, prescription_no, encounter_id, prescriber_id) values ($1, $2, $3, $4) returning id`,
        [ids.tenantA, `RX-${randomUUID().slice(0, 8)}`, enc, DR]);
      await su(`insert into app.prescription_item(tenant_id, prescription_id, line_no, drug_item_id, frequency, route, qty, uom_id)
        values ($1, $2, 1, $3, '3x sehari', 'ORAL', 10, $4)`, [ids.tenantA, rx, PCT, TAB]);
      await su(`update app.prescription set status = 'ISSUED', issued_at = now() where id = $1`, [rx]);
      const inv = await issued(enc);
      await pay(inv.id, { method: 'TUNAI', amount: Number(inv.patientPortion) });
      expect(await encStatus(enc)).toBe('PHARMACY');
      const enc2 = await encounter();
      const inv2 = await issued(enc2);
      await pay(inv2.id, { method: 'TUNAI', amount: Number(inv2.patientPortion) });
      expect(await encStatus(enc2)).toBe('FINISHED');
      expect(await su(`select change_summary->>'next' as next from app.audit_log where action = 'ENCOUNTER_BILLING_SETTLED' and resource_id = $1`, [enc])).toEqual([{ next: 'PHARMACY' }]);
    } finally {
      await su(`update app.tenant set settings = settings - 'pharmacyBeforeCashier' where id = $1`, [ids.tenantA]);
    }
  });

  test('L06 obat bebas: lunas → penjualan PAID & keluar dari worklist', async () => {
    const [{ id: sale }] = await su(`insert into app.otc_sale(tenant_id, sale_no, branch_id, location_id, sold_by, customer_name, total)
      values ($1, 'OTC-BYR-1', $2, $3, $4, 'Pembeli umum', 4500) returning id`, [ids.tenantA, BRANCH, LOC, ids.dokterA]);
    await su(`insert into app.otc_sale_line(tenant_id, otc_sale_id, drug_item_id, batch_id, qty_base, unit_price) values ($1, $2, $3, $4, 9, 500)`, [ids.tenantA, sale, PCT, BATCH]);
    const d = (await post(`/api/v1/billing/otc-sales/${sale}/invoice`, kasir).send()).body;
    const inv = (await post(`/api/v1/invoices/${d.id}/issue`, kasir, d.version).send()).body;
    expect((await pay(inv.id, { method: 'TUNAI', amount: 4500, cashTendered: 5000 })).body).toMatchObject({ change: '500.00', invoiceStatus: 'PAID' });
    expect(await su(`select status from app.otc_sale where id = $1`, [sale])).toEqual([{ status: 'PAID' }]);
    expect((await get('/api/v1/billing/worklist', kasir)).body.find((x: { refId: string }) => x.refId === sale)).toBeUndefined();
  });
});
