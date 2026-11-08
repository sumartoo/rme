import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 10 batch 1 — lokasi stok, harga jual, penerimaan barang & posisi stok
 * (PHM-FR-002–004, 014, 019; OD-037, OD-097, OD-100 / DEC-039). Data obat sintetis.
 */
const HOST = 'klinik-a.clinicrme.test';
const HOST_B = 'klinik-b.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const BRANCH = A(10), TAB = A(40), PCT = A(41), AMX = A(42), GUDANG_UJI = A(50);
const FARMASI = A(34), FARMASI2 = A(35);
let app: INestApplication;
let http: ReturnType<typeof request>;

type Jar = { cookie: string; csrf: string; host: string };
function jar(res: request.Response, host: string): Jar {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const csrf = get('crme_csrf');
  return { cookie: [get('crme_session'), csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '', host };
}
const login = async (email: string, host = HOST) => {
  const r = await http.post('/api/v1/auth/login').set('Host', host).send({ email, password: PASSWORD });
  expect([email, r.status]).toEqual([email, 200]);
  return jar(r, host);
};
const get = (path: string, j: Jar) => http.get(path).set('Host', j.host).set('Cookie', j.cookie);
const post = (path: string, j: Jar) => http.post(path).set('Host', j.host).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
const put = (path: string, j: Jar, version?: number) => {
  const r = http.put(path).set('Host', j.host).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
  return version === undefined ? r : r.set('If-Match', String(version));
};
const receive = (j: Jar, body: object, key = `uji-${randomUUID()}`) => post('/api/v1/goods-receipts', j).set('Idempotency-Key', key).send(body);

let admin: Jar, farmasi: Jar, farmasiTanpaIzin: Jar, dokter: Jar, gudang: Jar, adminB: Jar;
let APOTEK: string, BOX: string, SUP: string, SUP_OFF: string, MORF: string;
const day = (n: number) => new Date(Date.now() + n * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 10);

async function addUser(id: string, email: string, name: string, role: string) {
  await su(`insert into app.app_user(id, tenant_id, email, full_name) values ($1, $2, $3, $4)`, [id, ids.tenantA, email, name]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and code = $3`, [ids.tenantA, id, role]);
  await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select tenant_id, $2, password_hash from app.user_credential where user_id = $1`, [ids.dokterA, id]);
}

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  await addUser(FARMASI, 'farmasi@a.test', 'Apoteker Uji', 'FARMASI');
  // Role custom: penerimaan barang tanpa izin obat terbatas (OD-100)
  await su(`with r as (insert into app.role(tenant_id, code, name) values ($1, 'TTK_TERBATAS', 'TTK tanpa izin terbatas') returning id)
            insert into app.role_permission(tenant_id, role_id, permission_code)
            select $1, r.id, p from r, unnest(array['pharmacy.stock.read', 'pharmacy.stock.receive', 'pharmacy.drug.read']) p`, [ids.tenantA]);
  await addUser(FARMASI2, 'ttk@a.test', 'TTK Uji', 'TTK_TERBATAS');
  [{ id: BOX }] = await su(`insert into app.uom(tenant_id, code, name) values ($1, 'BOX', 'Box') returning id`, [ids.tenantA]);
  // Konversi umum BOX→TAB = 100; khusus Amoksisilin BOX→TAB tidak didefinisikan → pakai umum
  await su(`insert into app.uom_conversion(tenant_id, from_uom_id, to_uom_id, factor) values ($1, $2, $3, 100)`, [ids.tenantA, BOX, TAB]);
  [{ id: SUP }] = await su(`insert into app.supplier(tenant_id, name) values ($1, 'PBF Sintetis') returning id`, [ids.tenantA]);
  [{ id: SUP_OFF }] = await su(`insert into app.supplier(tenant_id, name, is_active) values ($1, 'PBF Nonaktif', false) returning id`, [ids.tenantA]);
  [{ id: MORF }] = await su(`insert into app.drug_item(tenant_id, code, generic_name, dosage_form, base_uom_id, drug_class, ingredients)
                             values ($1, 'MRF10', 'Morfin sintetis 10 mg', 'Tablet', $2, 'NARKOTIKA', array['morfin']) returning id`, [ids.tenantA, TAB]);
  [{ id: APOTEK }] = await su(`select id from app.stock_location where branch_id = $1 and is_default`, [BRANCH]);
  await su(`update app.role set requires_mfa = false where code = 'TENANT_ADMIN' and tenant_id = $1`, [ids.tenantA]);
  admin = await login('admin@a.test');
  farmasi = await login('farmasi@a.test');
  farmasiTanpaIzin = await login('ttk@a.test');
  dokter = await login('dokter@a.test');
  gudang = await login('gudang@a.test');
  // Apoteker di tenant B (uji isolasi)
  const FB = 'bbbbbbbb-0000-0000-0000-000000000034';
  await su(`insert into app.app_user(id, tenant_id, email, full_name) values ($1, $2, 'farmasi@b.test', 'Apoteker B')`, [FB, ids.tenantB]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and code = 'FARMASI'`, [ids.tenantB, FB]);
  await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select $1, $2, password_hash from app.user_credential where user_id = $3`, [ids.tenantB, FB, ids.dokterB]);
  adminB = await login('farmasi@b.test', HOST_B);
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('Lokasi stok (OD-097)', () => {
  test('P01 lokasi bawaan "Apotek" per cabang otomatis; admin kelola; nama unik; bawaan & lokasi bersaldo tidak dapat dinonaktifkan', async () => {
    expect(APOTEK).toBeTruthy();
    const l = await get(`/api/v1/stock-locations?branchId=${BRANCH}`, farmasi);
    expect(l.status).toBe(200);
    expect(l.body.find((x: { id: string }) => x.id === APOTEK)).toMatchObject({ name: 'Apotek', isDefault: true, isActive: true });
    // Cabang baru → lokasi bawaan dibuat trigger
    const [{ id: br2 }] = await su(`insert into app.branch(tenant_id, facility_id, code, name) values ($1, $2, 'CBG2', 'Cabang 2') returning id`, [ids.tenantA, A(1)]);
    expect(await su(`select name from app.stock_location where branch_id = $1 and is_default`, [br2])).toEqual([{ name: 'Apotek' }]);

    expect((await post('/api/v1/stock-locations', farmasi).send({ branchId: BRANCH, name: 'Gudang' })).status).toBe(403);
    const c = await post('/api/v1/stock-locations', admin).send({ branchId: BRANCH, name: 'Gudang Belakang' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: 'Gudang Belakang', isDefault: false, version: 1 });
    expect((await post('/api/v1/stock-locations', admin).send({ branchId: BRANCH, name: ' gudang belakang ' })).status).toBe(409);
    const ap = (await get(`/api/v1/stock-locations?branchId=${BRANCH}`, admin)).body.find((x: { id: string }) => x.id === APOTEK);
    const d = await put(`/api/v1/stock-locations/${APOTEK}`, admin, ap.version).send({ isActive: false });
    expect([d.status, d.body.code]).toEqual([409, 'PHM-409-DEFAULT']);
    expect((await put(`/api/v1/stock-locations/${c.body.id}`, admin, 99).send({ name: 'X Y' })).status).toBe(412);
    const off = await put(`/api/v1/stock-locations/${c.body.id}`, admin, 1).send({ isActive: false, name: 'Gudang Lama' });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ isActive: false, name: 'Gudang Lama', version: 2 });
  });
});

describe('Harga jual obat (PHM-FR-002)', () => {
  test('P02 periode berlaku; tumpang tindih 409; harga > HET ditolak; tutup periode lalu harga baru; dokter hanya baca', async () => {
    const base = `/api/v1/drugs/${PCT}/prices`;
    const p1 = await post(base, farmasi).send({ sellPrice: '500', het: '600', hna: '300', validFrom: day(-30) });
    expect(p1.status).toBe(201);
    expect(p1.body).toMatchObject({ sellPrice: '500.00', validTo: null, branchId: null, payerType: null });
    const ov = await post(base, farmasi).send({ sellPrice: '550', validFrom: day(0) });
    expect([ov.status, ov.body.code]).toEqual([409, 'PHM-409-PRICE-OVERLAP']);
    const het = await post(base, farmasi).send({ sellPrice: '700', het: '600', validFrom: day(0), branchId: BRANCH });
    expect([het.status, het.body.code]).toEqual([400, 'PHM-400-HET']);
    // Harga khusus cabang & penjamin boleh berdampingan dengan harga umum
    expect((await post(base, farmasi).send({ sellPrice: '450', validFrom: day(-1), branchId: BRANCH, payerType: 'BPJS' })).status).toBe(201);
    expect((await post(base, dokter).send({ sellPrice: '1', validFrom: day(0) })).status).toBe(403);
    const end = await post(`${base}/${p1.body.id}/end`, farmasi).send({ validTo: day(-1) });
    expect([end.status, end.body.validTo]).toEqual([200, day(-1)]);
    // Hanya boleh memperpendek; tidak boleh sebelum tanggal mulai
    expect((await post(`${base}/${p1.body.id}/end`, farmasi).send({ validTo: day(5) })).status).toBe(400);
    expect((await post(`${base}/${p1.body.id}/end`, farmasi).send({ validTo: day(-40) })).status).toBe(400);
    expect((await post(base, farmasi).send({ sellPrice: '550', validFrom: day(0) })).status).toBe(201);
    const list = await get(base, dokter);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(3);
    expect((await get(`/api/v1/drugs/${randomUUID()}/prices`, dokter)).status).toBe(404);
  });
});

describe('Penerimaan barang (PHM-FR-003/004)', () => {
  test('P03 faktur → batch & mutasi RECEIPT dalam satuan dasar; nomor GR; idempoten; faktur ganda 409; saldo = ledger', async () => {
    const body = { supplierId: SUP, locationId: APOTEK, invoiceNo: 'FKT-001', invoiceDate: day(-1), notes: 'Pengiriman pertama',
      lines: [
        { drugItemId: PCT, batchNo: 'PCT-A1', expiryDate: day(400), qty: 2, uomId: BOX, unitPrice: 25000 },
        { drugItemId: PCT, batchNo: 'PCT-A2', expiryDate: day(30), qty: 50, uomId: TAB, unitPrice: 260 },
        { drugItemId: AMX, batchNo: 'AMX-A1', expiryDate: day(200), qty: 1, uomId: BOX, unitPrice: 80000 },
      ] };
    const key = `uji-${randomUUID()}`;
    const r = await receive(farmasi, body, key);
    expect(r.status).toBe(201);
    expect(r.body.receiptNo).toMatch(/^GR\d{6}\d{5}$/);
    expect(r.body).toMatchObject({ supplierName: 'PBF Sintetis', locationName: 'Apotek', invoiceNo: 'FKT-001', lineCount: 3, total: '143000.00' });
    expect(r.body.lines.find((l: { batchNo: string }) => l.batchNo === 'PCT-A1')).toMatchObject({ qty: 2, uomName: 'Box', qtyBase: 200, baseUomName: 'Tablet' });
    // Harga beli per satuan dasar disimpan di batch
    expect(await su(`select unit_cost::text from app.stock_batch where batch_no = 'PCT-A1'`)).toEqual([{ unit_cost: '250.0000' }]);
    // Idempoten: kunci sama → hasil sama, tanpa mutasi ganda
    const again = await receive(farmasi, body, key);
    expect([again.status, again.body.id]).toEqual([201, r.body.id]);
    const dup = await receive(farmasi, { ...body, invoiceNo: 'fkt-001' });
    expect([dup.status, dup.body.code]).toEqual([409, 'PHM-409-INVOICE']);
    const [{ ledger, bal }] = await su(`select (select sum(qty) from app.stock_movement)::text as ledger, (select sum(qty_on_hand) from app.stock_balance)::text as bal`);
    expect(ledger).toBe(bal);
    expect(Number(ledger)).toBe(350);
    expect(await su(`select movement_type, ref_type, actor_id from app.stock_movement where ref_id = $1 limit 1`, [r.body.id]))
      .toEqual([{ movement_type: 'RECEIPT', ref_type: 'goods_receipt', actor_id: FARMASI }]);
    expect(await su(`select count(*)::int as n from app.audit_log where action = 'GOODS_RECEIVED' and resource_id = $1`, [r.body.id])).toEqual([{ n: 1 }]);
    const g = await get(`/api/v1/goods-receipts/${r.body.id}`, gudang);
    expect([g.status, g.body.lines.length]).toEqual([200, 3]);
    const list = await get('/api/v1/goods-receipts', gudang);
    expect(list.body.data.map((x: { id: string }) => x.id)).toContain(r.body.id);
    // Lintas tenant: tidak terlihat
    expect((await get(`/api/v1/goods-receipts/${r.body.id}`, adminB)).status).toBe(404);
  });

  test('P04 validasi: supplier/lokasi nonaktif, kedaluwarsa, tanpa konversi, golongan terbatas butuh izin (OD-100), tanpa permission 403', async () => {
    const line = { drugItemId: PCT, batchNo: 'X1', expiryDate: day(100), qty: 1, uomId: TAB, unitPrice: 100 };
    const ok = { supplierId: SUP, locationId: APOTEK, invoiceNo: 'FKT-V', lines: [line] };
    expect((await receive(farmasi, { ...ok, supplierId: SUP_OFF })).body.code).toBe('PHM-400-SUPPLIER');
    const [{ id: offLoc }] = await su(`select id from app.stock_location where name = 'Gudang Lama'`);
    expect((await receive(farmasi, { ...ok, locationId: offLoc })).body.code).toBe('PHM-400-LOCATION');
    const exp = await receive(farmasi, { ...ok, lines: [{ ...line, expiryDate: day(0) }] });
    expect([exp.status, exp.body.errors[0].field]).toEqual([400, 'lines.0.expiryDate']);
    const [{ id: btl }] = await su(`insert into app.uom(tenant_id, code, name) values ($1, 'BTL', 'Botol') returning id`, [ids.tenantA]);
    const conv = await receive(farmasi, { ...ok, lines: [{ ...line, uomId: btl }] });
    expect([conv.status, conv.body.errors[0].field]).toEqual([400, 'lines.0.uomId']);
    expect((await receive(farmasi, { ...ok, lines: [] })).status).toBe(400);
    const restricted = { ...ok, invoiceNo: 'FKT-N', lines: [{ ...line, drugItemId: MORF, batchNo: 'MRF-1' }] };
    const no = await receive(farmasiTanpaIzin, restricted);
    expect([no.status, no.body.code]).toEqual([403, 'PHM-403-RESTRICTED']);
    expect((await receive(farmasi, restricted)).status).toBe(201);
    expect((await receive(dokter, { ...ok, invoiceNo: 'FKT-D' })).status).toBe(403);
    // Tidak ada mutasi dari penerimaan yang gagal
    expect(await su(`select count(*)::int as n from app.goods_receipt where invoice_no in ('FKT-V', 'FKT-D')`)).toEqual([{ n: 0 }]);
  });
});

describe('Posisi stok & peringatan (PHM-FR-014/019)', () => {
  test('P05 saldo per obat, layak pakai vs kedaluwarsa, akan kedaluwarsa, stok minimum; filter & rincian batch + ledger', async () => {
    // Batch kedaluwarsa bersaldo (masuk sebelum kedaluwarsa) di lokasi lain
    await su(`insert into app.stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id)
              values ($1, $2, $3, 'RECEIPT', 7, 'goods_receipt', gen_random_uuid())`, [ids.tenantA, A(52), GUDANG_UJI]);
    const put1 = await put(`/api/v1/drugs/${AMX}`, farmasi, 1).send({ minStock: 150, kfaCode: '93001234' });
    expect(put1.status).toBe(200);
    expect(put1.body).toMatchObject({ minStock: '150', kfaCode: '93001234' });
    expect((await put(`/api/v1/drugs/${PCT}`, farmasi, 1).send({ kfaCode: 'bad code!' })).status).toBe(400);

    const all = await get(`/api/v1/stock?branchId=${BRANCH}`, gudang);
    expect([all.status, all.body]).toEqual([200, expect.anything()]);
    expect(all.body.expiryWarningDays).toBe(90);
    const pct = all.body.data.find((x: { drugItemId: string }) => x.drugItemId === PCT);
    expect(pct).toMatchObject({ onHand: 257, usable: 250, expiringQty: 50, expiredQty: 7, nearestExpiry: day(30), low: false });
    const amx = all.body.data.find((x: { drugItemId: string }) => x.drugItemId === AMX);
    expect(amx).toMatchObject({ onHand: 100, usable: 100, minStock: 150, low: true });

    const ids_ = async (filter: string) => (await get(`/api/v1/stock?filter=${filter}`, gudang)).body.data.map((x: { drugItemId: string }) => x.drugItemId);
    expect(await ids_('LOW')).toEqual([AMX]);
    expect(await ids_('EXPIRING')).toEqual([PCT]);
    expect(await ids_('EXPIRED')).toEqual([PCT]);
    expect((await get(`/api/v1/stock?locationId=${GUDANG_UJI}`, gudang)).body.data.find((x: { drugItemId: string }) => x.drugItemId === PCT).onHand).toBe(7);
    expect((await get('/api/v1/stock?q=amoks', gudang)).body.data.map((x: { code: string }) => x.code)).toEqual(['AMX500']);

    // Ambang kedaluwarsa dari pengaturan tenant
    await su(`update app.tenant set settings = settings || '{"expiryWarningDays": 20}' where id = $1`, [ids.tenantA]);
    expect(await ids_('EXPIRING')).toEqual([]);
    await su(`update app.tenant set settings = settings - 'expiryWarningDays' where id = $1`, [ids.tenantA]);

    const al = await get(`/api/v1/stock/alerts?branchId=${BRANCH}`, gudang);
    expect(al.status).toBe(200);
    expect(al.body.map((x: { type: string; drugName: string }) => `${x.type}:${x.drugName}`)).toEqual(expect.arrayContaining([
      'BELOW_MINIMUM:Amoksisilin 500 mg', 'NEAR_EXPIRY:Parasetamol 500 mg', 'EXPIRED:Parasetamol 500 mg']));

    const det = await get(`/api/v1/stock/${PCT}?branchId=${BRANCH}`, gudang);
    expect(det.status).toBe(200);
    expect(det.body.batches.map((b: { batchNo: string; qtyOnHand: number }) => `${b.batchNo}=${b.qtyOnHand}`)).toEqual(['B-EXP=7', 'PCT-A2=50', 'PCT-A1=200']);
    expect(det.body.movements.length).toBe(3);
    expect((await get(`/api/v1/stock/${PCT}`, dokter)).status).toBe(403);
    expect((await get(`/api/v1/stock/${randomUUID()}`, gudang)).status).toBe(404);
    // Lintas tenant: obat tenant A tidak terlihat
    expect((await get(`/api/v1/stock/${PCT}`, adminB)).status).toBe(404);
  });
});
