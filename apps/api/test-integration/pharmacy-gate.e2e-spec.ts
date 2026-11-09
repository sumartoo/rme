import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, ownerUrl, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 10 batch 4 & gate — penjualan obat bebas (PHM-FR-012, OD-101), laporan stok & mutasi (RPT-FR-005), dan uji gate:
 * rekonsiliasi saldo = ledger, resep ↔ penyerahan ↔ calon tagihan (termasuk parsial & substitusi), konkurensi penyerahan
 * vs penjualan bebas pada batch yang sama, kontrol golongan obat. Data sintetis.
 */
const HOST = 'klinik-a.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const BRANCH = A(10), UNIT = A(11), DR = A(20), TAB = A(40), PCT = A(41), AMX = A(42), PATIENT = A(60);
const FARMASI = A(34);
let app: INestApplication;
let http: ReturnType<typeof request>;

type Jar = { cookie: string; csrf: string };
async function login(email: string): Promise<Jar> {
  const r = await http.post('/api/v1/auth/login').set('Host', HOST).send({ email, password: PASSWORD });
  expect([email, r.status]).toEqual([email, 200]);
  const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const csrf = get('crme_csrf');
  return { cookie: [get('crme_session'), csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '' };
}
const get = (path: string, j: Jar) => http.get(path).set('Host', HOST).set('Cookie', j.cookie);
const post = (path: string, j: Jar, version?: number) => {
  const r = http.post(path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
  return version === undefined ? r : r.set('If-Match', String(version));
};
const put = (path: string, j: Jar, version: number) => http.put(path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf).set('If-Match', String(version));
const idem = () => `uji-${randomUUID()}`;

let farmasi: Jar, kasir: Jar, dokter: Jar, manajer: Jar;
let APOTEK: string, CTM: string, IBU: string, SUP: string;
const ALL_OK = Object.fromEntries(['ADM_PATIENT', 'ADM_PRESCRIBER', 'ADM_DATE', 'PHA_FORM', 'PHA_QTY', 'PHA_DIRECTIONS', 'PHA_COMPOUND', 'CLN_DOSE',
  'CLN_ALLERGY', 'CLN_DUPLICATE', 'CLN_SPECIAL'].map((k) => [k, { ok: true }]));
const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.now() + n * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 10);
const otc = (j: Jar, lines: { drugItemId: string; qty: number }[], extra: object = {}, key = idem()) =>
  post('/api/v1/otc-sales', j).set('Idempotency-Key', key).send({ branchId: BRANCH, lines, ...extra });
const usable = async (drug: string) => Number((await su(`select coalesce(sum(s.qty_on_hand), 0)::text as q from app.stock_balance s join app.stock_batch b on b.id = s.batch_id
  where b.drug_item_id = $1 and s.location_id = $2`, [drug, APOTEK]))[0].q);

async function receive(lines: { drugItemId: string; batchNo: string; qty: number; days?: number; price?: number }[]) {
  const r = await post('/api/v1/goods-receipts', farmasi).set('Idempotency-Key', idem()).send({ supplierId: SUP, locationId: APOTEK, invoiceNo: `F-${randomUUID().slice(0, 8)}`,
    lines: lines.map((l) => ({ drugItemId: l.drugItemId, batchNo: l.batchNo, expiryDate: day(l.days ?? 200), qty: l.qty, uomId: TAB, unitPrice: l.price ?? 100 })) });
  expect(r.status).toBe(201);
  return r.body;
}
async function makeRx(lines: { drug: string; qty: number }[]) {
  const [{ id: enc }] = await su(`insert into app.encounter(tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, arrival_type, status)
    values ($1, $2, $3, $4, $5, $6, 'WALK_IN', 'PHARMACY') returning id`, [ids.tenantA, `KJ-${randomUUID().slice(0, 8)}`, PATIENT, BRANCH, UNIT, DR]);
  const [{ id: rx }] = await su(`insert into app.prescription(tenant_id, prescription_no, encounter_id, prescriber_id) values ($1, $2, $3, $4) returning id`,
    [ids.tenantA, `RX-${randomUUID().slice(0, 8)}`, enc, DR]);
  const items: string[] = [];
  for (const [n, l] of lines.entries()) {
    const [{ id }] = await su(`insert into app.prescription_item(tenant_id, prescription_id, line_no, drug_item_id, dose, dose_qty, times_per_day, frequency, route, qty, uom_id)
      values ($1, $2, $3, $4, '1 Tablet', 1, 3, '3x sehari', 'ORAL', $5, $6) returning id`, [ids.tenantA, rx, n + 1, l.drug, l.qty, TAB]);
    items.push(id);
  }
  await su(`update app.prescription set status = 'ISSUED', issued_at = now() where id = $1`, [rx]);
  const d = await get(`/api/v1/pharmacy/prescriptions/${rx}`, farmasi);
  const v = await post(`/api/v1/pharmacy/prescriptions/${rx}/review`, farmasi, d.body.version).send({ items: ALL_OK });
  expect(v.body.status).toBe('VERIFIED');
  return { rx, enc, items };
}
const version = async (rx: string) => (await get(`/api/v1/pharmacy/prescriptions/${rx}`, farmasi)).body.version as number;
const dispense = async (rx: string, lines: object[]) =>
  post(`/api/v1/pharmacy/prescriptions/${rx}/dispense`, farmasi, await version(rx)).set('Idempotency-Key', idem()).send({ lines });

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  await su(`update app.role set requires_mfa = false where code in ('MANAJER', 'FARMASI', 'KASIR') and tenant_id = $1`, [ids.tenantA]);
  await su(`insert into app.app_user(id, tenant_id, email, full_name) values ($1, $2, 'farmasi@a.test', 'Apoteker Uji')`, [FARMASI, ids.tenantA]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and code = 'FARMASI'`, [ids.tenantA, FARMASI]);
  await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select tenant_id, $2, password_hash from app.user_credential where user_id = $1`, [ids.dokterA, FARMASI]);
  const drug = async (code: string, name: string, cls: string) => (await su(`insert into app.drug_item(tenant_id, code, generic_name, dosage_form, base_uom_id, drug_class, ingredients)
    values ($1, $2, $3, 'Tablet', $4, $5, array[lower($3)]) returning id`, [ids.tenantA, code, name, TAB, cls]))[0].id as string;
  CTM = await drug('CTM4', 'Klorfeniramin 4 mg', 'KERAS');
  IBU = await drug('IBU400', 'Ibuprofen sintetis 400 mg', 'BEBAS_TERBATAS');
  [{ id: SUP }] = await su(`insert into app.supplier(tenant_id, name) values ($1, 'PBF Sintetis') returning id`, [ids.tenantA]);
  [{ id: APOTEK }] = await su(`select id from app.stock_location where branch_id = $1 and is_default`, [BRANCH]);
  for (const [d, p, payer] of [[PCT, 500, null], [PCT, 450, 'UMUM'], [AMX, 1000, null], [CTM, 200, null]] as const) {
    await su(`insert into app.drug_price(tenant_id, drug_item_id, payer_type, sell_price, valid_from) values ($1, $2, $3, $4, current_date - 30)`, [ids.tenantA, d, payer, p]);
  }
  farmasi = await login('farmasi@a.test');
  kasir = await login('kasir@a.test');
  dokter = await login('dokter@a.test');
  manajer = await login('manajer@a.test');
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('Penjualan obat bebas (PHM-FR-012, OD-101)', () => {
  test('G01 hanya Bebas/Bebas terbatas; harga Umum terkunci; FEFO; menunggu bayar; idempoten; batal → stok kembali', async () => {
    await receive([{ drugItemId: PCT, batchNo: 'P-LAMA', qty: 20, days: 300 }, { drugItemId: PCT, batchNo: 'P-DEKAT', qty: 5, days: 40 },
      { drugItemId: AMX, batchNo: 'A-1', qty: 30 }, { drugItemId: CTM, batchNo: 'C-1', qty: 30 }, { drugItemId: IBU, batchNo: 'I-1', qty: 10 }]);
    const keras = await otc(farmasi, [{ drugItemId: AMX, qty: 1 }]);
    expect([keras.status, keras.body.errors[0].message]).toEqual([422, 'Amoksisilin 500 mg golongan keras — hanya dapat diserahkan dengan resep']);
    const noPrice = await otc(farmasi, [{ drugItemId: IBU, qty: 1 }]);
    expect(noPrice.body.errors[0].message).toBe('Ibuprofen sintetis 400 mg belum memiliki harga jual berlaku');
    expect((await otc(farmasi, [{ drugItemId: PCT, qty: 99 }])).body.errors[0].message).toMatch(/tidak cukup \(tersedia 25\)/);
    expect((await otc(dokter, [{ drugItemId: PCT, qty: 1 }])).status).toBe(403);
    const key = idem();
    const r = await otc(kasir, [{ drugItemId: PCT, qty: 8 }], { customerName: 'Pembeli umum' }, key);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'AWAITING_PAYMENT', customerName: 'Pembeli umum', total: '3600.00', patient: null, soldByName: 'Kasir' });
    expect(r.body.saleNo).toMatch(/^OTC\d{6}\d{5}$/);
    expect(r.body.lines.map((l: { batchNo: string; qtyBase: number; unitPrice: string }) => [l.batchNo, l.qtyBase, l.unitPrice]))
      .toEqual([['P-DEKAT', 5, '450.00'], ['P-LAMA', 3, '450.00']]);
    expect((await otc(kasir, [{ drugItemId: PCT, qty: 8 }], { customerName: 'Pembeli umum' }, key)).body.id).toBe(r.body.id);
    expect(await usable(PCT)).toBe(17);
    expect((await get(`/api/v1/otc-sales?branchId=${BRANCH}&status=AWAITING_PAYMENT`, farmasi)).body.map((x: { id: string }) => x.id)).toEqual([r.body.id]);
    expect((await post(`/api/v1/otc-sales/${r.body.id}/cancel`, farmasi).send({ reason: 'x' })).status).toBe(400);
    const c = await post(`/api/v1/otc-sales/${r.body.id}/cancel`, farmasi).send({ reason: 'Pembeli batal membeli' });
    expect([c.status, c.body.status, c.body.cancelReason]).toEqual([200, 'CANCELLED', 'Pembeli batal membeli']);
    expect(await usable(PCT)).toBe(25);
    expect(await su(`select movement_type, qty::int as q from app.stock_movement where ref_id = $1 order by occurred_at, qty`, [r.body.id]))
      .toEqual([{ movement_type: 'OTC_SALE', q: -5 }, { movement_type: 'OTC_SALE', q: -3 }, { movement_type: 'RETURN_IN', q: 3 }, { movement_type: 'RETURN_IN', q: 5 }]
        .sort((a, b) => (a.movement_type === b.movement_type ? a.q - b.q : a.movement_type < b.movement_type ? -1 : 1)));
    expect((await post(`/api/v1/otc-sales/${r.body.id}/cancel`, farmasi).send({ reason: 'Batal lagi' })).body.code).toBe('PHM-409-OTC-STATE');
    // Sudah dibayar (Stage 11) → tidak dapat dibatalkan
    const paid = await otc(farmasi, [{ drugItemId: PCT, qty: 1 }]);
    await su(`update app.otc_sale set status = 'PAID' where id = $1`, [paid.body.id]);
    expect((await post(`/api/v1/otc-sales/${paid.body.id}/cancel`, farmasi).send({ reason: 'Minta batal' })).body.code).toBe('PHM-409-OTC-STATE');
    // Lapisan DB: golongan keras ditolak trigger; baris penjualan tidak dapat diubah
    const asApp = `set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);`;
    await expect(su(`${asApp} insert into app.otc_sale_line(tenant_id, otc_sale_id, drug_item_id, batch_id, qty_base, unit_price)
      select tenant_id, '${paid.body.id}', '${AMX}', batch_id, 1, 1 from app.otc_sale_line where otc_sale_id = '${paid.body.id}'`)).rejects.toThrow(/tanpa resep/);
    await expect(su(`${asApp} update app.otc_sale_line set unit_price = 0 where otc_sale_id = '${paid.body.id}'`)).rejects.toThrow(/permission denied/);
    await expect(su(`${asApp} update app.otc_sale set total = 0 where id = '${paid.body.id}'`)).rejects.toThrow(/permission denied/);
  });
});

describe('Gate Stage 10', () => {
  test('G02 alur lengkap (terima, resep parsial+substitusi, bebas, penyesuaian, opname) → saldo = ledger; laporan stok & mutasi konsisten', async () => {
    // Resep: PCT utuh, AMX sebagian lalu ditutup, CTM disubstitusi ke AMX (setelah disetujui dokter)
    const r = await makeRx([{ drug: PCT, qty: 6 }, { drug: AMX, qty: 40 }, { drug: CTM, qty: 4 }]);
    const sub = await post(`/api/v1/pharmacy/prescriptions/${r.rx}/substitutions`, farmasi).send({ prescriptionItemId: r.items[2], newDrugItemId: AMX, reason: 'Uji substitusi gate' });
    expect((await post(`/api/v1/substitutions/${sub.body.id}/decision`, dokter).send({ decision: 'APPROVE' })).body.status).toBe('APPROVED');
    const d1 = await dispense(r.rx, [{ prescriptionItemId: r.items[0], qty: 6 }, { prescriptionItemId: r.items[1], qty: 25 }, { prescriptionItemId: r.items[2], qty: 4 }]);
    expect([d1.status, d1.body.prescriptionStatus]).toEqual([201, 'PARTIALLY_DISPENSED']);
    const close = await post(`/api/v1/pharmacy/prescriptions/${r.rx}/close`, farmasi, await version(r.rx)).send({ reason: 'Pasien tidak kembali' });
    expect(close.body.status).toBe('DISPENSED');
    const o = await otc(farmasi, [{ drugItemId: PCT, qty: 2 }]);
    expect(o.status).toBe(201);
    const [{ id: cBatch }] = await su(`select id from app.stock_batch where batch_no = 'C-1'`);
    const adj = await post('/api/v1/stock-adjustments', farmasi).send({ batchId: cBatch, locationId: APOTEK, qtyDelta: -2, reason: 'Kemasan rusak' });
    expect((await post(`/api/v1/stock-adjustments/${adj.body.id}/decision`, manajer).send({ decision: 'APPROVE' })).body.status).toBe('APPROVED');
    const op = await post('/api/v1/stock-opnames', farmasi).send({ locationId: APOTEK });
    const counts = op.body.lines.map((l: { batchId: string; batchNo: string; systemQty: number }) =>
      ({ batchId: l.batchId, countedQty: l.batchNo === 'I-1' ? l.systemQty - 1 : l.systemQty, note: l.batchNo === 'I-1' ? 'Satu tablet hilang' : null }));
    let v = (await put(`/api/v1/stock-opnames/${op.body.id}/counts`, farmasi, op.body.version).send({ lines: counts })).body.version;
    v = (await post(`/api/v1/stock-opnames/${op.body.id}/submit`, farmasi, v).send()).body.version;
    expect((await post(`/api/v1/stock-opnames/${op.body.id}/decision`, manajer, v).send({ decision: 'APPROVE' })).body.status).toBe('APPROVED');

    // Saldo = ledger untuk setiap batch & lokasi
    expect(await su(`select b.batch_id, b.location_id from app.stock_balance b
      full join (select batch_id, location_id, sum(qty) q from app.stock_movement group by 1, 2) m using (batch_id, location_id)
      where coalesce(b.qty_on_hand, 0) <> coalesce(m.q, 0)`)).toEqual([]);
    expect(await su(`select count(*)::int as n from app.stock_balance where qty_on_hand < 0`)).toEqual([{ n: 0 }]);

    const rep = await get(`/api/v1/reports/stock?from=${today()}&to=${today()}&branchId=${BRANCH}`, farmasi);
    expect(rep.status).toBe(200);
    const bal = new Map((await su(`select b.drug_item_id, sum(s.qty_on_hand)::float as q from app.stock_balance s join app.stock_batch b on b.id = s.batch_id
      join app.stock_location l on l.id = s.location_id where l.branch_id = $1 group by 1`, [BRANCH])).map((x) => [x.drug_item_id, x.q]));
    const codeOf = new Map((await su(`select code, id from app.drug_item where tenant_id = $1`, [ids.tenantA])).map((x) => [x.code, x.id]));
    for (const row of rep.body.rows as { code: string; opening: number; closing: number }[]) {
      expect([row.code, row.closing]).toEqual([row.code, bal.get(codeOf.get(row.code)) ?? 0]);
      expect(row.opening).toBe(0);
    }
    const pct = rep.body.rows.find((x: { code: string }) => x.code === 'PCT500');
    expect(pct).toMatchObject({ received: 25, returnedIn: 8, dispensed: 6, otcSold: 11, adjusted: 0, closing: 16 });
    const ibu = rep.body.rows.find((x: { code: string }) => x.code === 'IBU400');
    expect(ibu).toMatchObject({ received: 10, adjusted: -1, closing: 9, closingValue: '900.00' });
    // Periode sebelumnya: kosong; periode sesudah: saldo awal = saldo akhir hari ini
    const next = await get(`/api/v1/reports/stock?from=${day(1)}&to=${day(2)}&branchId=${BRANCH}`, farmasi);
    expect(next.body.rows.find((x: { code: string }) => x.code === 'PCT500')).toMatchObject({ opening: 16, closing: 16, dispensed: 0 });

    const mv = await get(`/api/v1/reports/stock-movements?from=${today()}&to=${today()}&drugId=${PCT}`, farmasi);
    const [{ n }] = await su(`select count(*)::int as n from app.stock_movement m join app.stock_batch b on b.id = m.batch_id where b.drug_item_id = $1`, [PCT]);
    expect(mv.body.rows).toHaveLength(n);
    expect(mv.body.rows.reduce((t: number, x: { qty: number }) => t + x.qty, 0)).toBe(16);
    expect(mv.body.rows.find((x: { type: string }) => x.type === 'DISPENSE').reference).toMatch(/^RX-/);
    expect(mv.body.rows.find((x: { type: string }) => x.type === 'OTC_SALE').reference).toMatch(/^OTC/);
    const csv = await get(`/api/v1/reports/stock?from=${today()}&to=${today()}&format=csv`, farmasi);
    expect([csv.status, csv.headers['content-type']]).toEqual([200, 'text/csv; charset=utf-8']);
    expect(csv.text).toContain('Kode,Nama obat,Golongan,Satuan,Saldo awal,Penerimaan');
    expect((await get(`/api/v1/reports/stock?from=${today()}&to=${today()}`, dokter)).status).toBe(403);
    expect((await get(`/api/v1/reports/stock?from=${day(2)}&to=${today()}`, farmasi)).status).toBe(400);
    expect((await get(`/api/v1/reports/stock?from=2024-01-01&to=2026-01-01`, farmasi)).body.title).toMatch(/Rentang maksimal/);
  });

  test('G03 resep ↔ penyerahan ↔ calon tagihan terekonsiliasi (parsial, ditutup, substitusi) + penjualan bebas ↔ ledger', async () => {
    // Setiap baris resep: jumlah diserahkan = Σ baris penyerahan; diserahkan + ditutup ≤ diresepkan; resep DISPENSED = lunas semua
    expect(await su(`select i.id from app.prescription_item i left join (select prescription_item_id, sum(qty_base) q from app.dispense_line group by 1) d
      on d.prescription_item_id = i.id where not i.is_compound and i.qty_dispensed <> coalesce(d.q, 0)`)).toEqual([]);
    expect(await su(`select i.id from app.prescription_item i join app.prescription p on p.id = i.prescription_id
      where p.status in ('DISPENSED', 'CLOSED') and i.qty_dispensed + i.qty_closed <> i.qty`)).toEqual([]);
    // Obat di baris penyerahan = obat baris resep (setelah substitusi)
    expect(await su(`select l.id from app.dispense_line l join app.prescription_item i on i.id = l.prescription_item_id
      where not i.is_compound and l.drug_item_id <> i.drug_item_id`)).toEqual([]);
    const [sub] = await su(`select i.substituted_from_drug_id, l.drug_item_id from app.prescription_item i join app.dispense_line l on l.prescription_item_id = i.id
      where i.substituted_from_drug_id is not null`);
    expect(sub).toEqual({ substituted_from_drug_id: CTM, drug_item_id: AMX });
    // Harga terkunci = harga berlaku yang dirujuk; ledger DISPENSE = Σ baris penyerahan
    expect(await su(`select l.id from app.dispense_line l join app.drug_price p on p.id = l.drug_price_id where p.sell_price <> l.unit_price or p.drug_item_id <> l.drug_item_id`)).toEqual([]);
    expect(await su(`select d.id from app.dispense d
      left join (select dispense_id, sum(qty_base) q from app.dispense_line group by 1) l on l.dispense_id = d.id
      left join (select ref_id, -sum(qty) q from app.stock_movement where movement_type = 'DISPENSE' group by 1) m on m.ref_id = d.id
      where coalesce(l.q, 0) <> coalesce(m.q, 0)`)).toEqual([]);
    // Calon tagihan per kunjungan: semua belum ditagih; sisa yang ditutup tidak ikut
    const [cand] = await su(`select e.id, sum(l.qty_base * l.unit_price)::numeric(18,2)::text as amount, bool_and(l.billing_status = 'UNBILLED') as unbilled,
      sum(l.qty_base)::int as qty from app.dispense_line l join app.dispense d on d.id = l.dispense_id join app.prescription p on p.id = d.prescription_id
      join app.encounter e on e.id = p.encounter_id where exists (select 1 from app.prescription_item i where i.prescription_id = p.id and i.substituted_from_drug_id is not null)
      group by e.id`);
    // PCT 6 × 450 (harga khusus Umum) + AMX 25 × 1.000 + substitusi CTM→AMX 4 × 1.000; sisa AMX 15 yang ditutup tidak ditagih
    expect(cand).toMatchObject({ amount: '31700.00', unbilled: true, qty: 35 });
    // Penjualan bebas: total = Σ baris; ledger OTC_SALE (− RETURN_IN bila batal) = Σ baris
    expect(await su(`select o.id from app.otc_sale o left join (select otc_sale_id, sum(qty_base * unit_price) t, sum(qty_base) q from app.otc_sale_line group by 1) x
      on x.otc_sale_id = o.id where o.total <> round(coalesce(x.t, 0), 2)`)).toEqual([]);
    expect(await su(`select o.id from app.otc_sale o
      join (select otc_sale_id, sum(qty_base) q from app.otc_sale_line group by 1) x on x.otc_sale_id = o.id
      join (select ref_id, -sum(qty) q from app.stock_movement where ref_type = 'otc_sale' group by 1) m on m.ref_id = o.id
      where m.q <> case when o.status = 'CANCELLED' then 0 else x.q end`)).toEqual([]);
  });

  test('G04 konkurensi: penjualan bebas & penyerahan resep atas stok terakhir — yang kedua membaca saldo terbaru; tepat satu berhasil', async () => {
    await receive([{ drugItemId: PCT, batchNo: 'P-TERAKHIR', qty: 10 }]);
    const left = await usable(PCT);
    // Transaksi lain sedang mengambil seluruh stok PCT dan belum commit → penjualan bebas menunggu lalu ditolak
    const other = new Client({ connectionString: ownerUrl() });
    await other.connect();
    try {
      await other.query('begin');
      await other.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`stock:${APOTEK}:${PCT}`]);
      const batches = await other.query(`select s.batch_id, s.qty_on_hand from app.stock_balance s join app.stock_batch b on b.id = s.batch_id
        where b.drug_item_id = $1 and s.location_id = $2 and s.qty_on_hand > 0`, [PCT, APOTEK]);
      for (const b of batches.rows) {
        await other.query(`insert into app.stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id)
          values ($1, $2, $3, 'DISPENSE', $4, 'dispense', gen_random_uuid())`, [ids.tenantA, b.batch_id, APOTEK, -Number(b.qty_on_hand)]);
      }
      const pending = otc(farmasi, [{ drugItemId: PCT, qty: left }]).then((r) => r);
      await new Promise((r) => setTimeout(r, 600));
      await other.query('commit');
      const r = await pending;
      expect([r.status, r.body.errors?.[0]?.message]).toEqual([422, expect.stringMatching(/tidak cukup \(tersedia 0\)/)]);
    } finally { await other.end(); }
    // Paralel: penjualan bebas vs penyerahan resep atas 10 tablet terakhir
    await receive([{ drugItemId: PCT, batchNo: 'P-RACE', qty: 10 }]);
    const rx = await makeRx([{ drug: PCT, qty: 10 }]);
    const v = await version(rx.rx);
    const [a, b] = await Promise.all([
      otc(farmasi, [{ drugItemId: PCT, qty: 10 }]),
      post(`/api/v1/pharmacy/prescriptions/${rx.rx}/dispense`, farmasi, v).set('Idempotency-Key', idem()).send({ lines: [{ prescriptionItemId: rx.items[0], qty: 10 }] }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    expect(await usable(PCT)).toBe(0);
    expect(await su(`select count(*)::int as n from app.stock_balance where qty_on_hand < 0`)).toEqual([{ n: 0 }]);
  });
});
