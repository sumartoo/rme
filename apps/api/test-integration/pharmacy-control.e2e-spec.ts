import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 10 batch 3 — substitusi dengan persetujuan dokter, penyesuaian stok maker–checker, stock opname, laporan obat
 * golongan terbatas (PHM-FR-010, 016, 017, 019; OD-099, OD-100 / DEC-039, DEC-013/OD-064). Data sintetis.
 */
const HOST = 'klinik-a.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const BRANCH = A(10), UNIT = A(11), DR = A(20), TAB = A(40), PCT = A(41), AMX = A(42), PATIENT = A(60), GUDANG = A(50);
const FARMASI = A(34), TTK = A(35), DR2 = A(36), DR3 = A(37), PRAC2 = A(38), PRAC3 = A(39), SUPER = A(43);
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
const send = (m: 'post' | 'put', path: string, j: Jar, version?: number) => {
  const r = http[m](path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
  return version === undefined ? r : r.set('If-Match', String(version));
};
const post = (path: string, j: Jar, version?: number) => send('post', path, j, version);
const put = (path: string, j: Jar, version?: number) => send('put', path, j, version);

let farmasi: Jar, ttk: Jar, dokter: Jar, dokter2: Jar, dokter3: Jar, manajer: Jar, superUser: Jar;
let APOTEK: string, AMX2: string, CEF: string, MRF: string, BKS: string;
const B: Record<string, string> = {};
const ALL_OK = Object.fromEntries(['ADM_PATIENT', 'ADM_PRESCRIBER', 'ADM_DATE', 'PHA_FORM', 'PHA_QTY', 'PHA_DIRECTIONS', 'PHA_COMPOUND', 'CLN_DOSE',
  'CLN_ALLERGY', 'CLN_DUPLICATE', 'CLN_SPECIAL'].map((k) => [k, { ok: true }]));

async function addUser(id: string, email: string, name: string, role: string, practitionerId: string | null = null) {
  await su(`insert into app.app_user(id, tenant_id, email, full_name, practitioner_id) values ($1, $2, $3, $4, $5)`, [id, ids.tenantA, email, name, practitionerId]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and code = $3`, [ids.tenantA, id, role]);
  await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select tenant_id, $2, password_hash from app.user_credential where user_id = $1`, [ids.dokterA, id]);
}
async function customRole(code: string, perms: string[]) {
  await su(`with r as (insert into app.role(tenant_id, code, name) values ($1, $2, $2) returning id)
            insert into app.role_permission(tenant_id, role_id, permission_code) select $1, r.id, p from r, unnest($3::text[]) p`, [ids.tenantA, code, perms]);
}
async function batch(drug: string, no: string, days: number, qty: number, loc = APOTEK, at: string | null = null) {
  const [{ id }] = await su(`insert into app.stock_batch(tenant_id, drug_item_id, batch_no, expiry_date, unit_cost)
                             values ($1, $2, $3, current_date + $4::int, 100) returning id`, [ids.tenantA, drug, no, days]);
  await su(`insert into app.stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id, occurred_at)
            values ($1, $2, $3, 'RECEIPT', $4, 'goods_receipt', gen_random_uuid(), coalesce($5::timestamptz, now()))`, [ids.tenantA, id, loc, qty, at]);
  B[no] = id;
  return id;
}
const balance = async (no: string, loc = APOTEK) =>
  Number((await su(`select coalesce(sum(qty_on_hand), 0)::text as q from app.stock_balance where batch_id = $1 and location_id = $2`, [B[no], loc]))[0].q);
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
  return { rx, items, version: v.body.version as number };
}
const rxVersion = async (rx: string) => (await get(`/api/v1/pharmacy/prescriptions/${rx}`, farmasi)).body.version as number;
const dispense = (rx: string, version: number, lines: object[]) =>
  post(`/api/v1/pharmacy/prescriptions/${rx}/dispense`, farmasi, version).set('Idempotency-Key', `uji-${randomUUID()}`).send({ lines });

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  await su(`update app.role set requires_mfa = false where code in ('MANAJER', 'FARMASI') and tenant_id = $1`, [ids.tenantA]);
  await addUser(FARMASI, 'farmasi@a.test', 'Apoteker Uji', 'FARMASI');
  await customRole('TTK_TERBATAS', ['pharmacy.dispense', 'pharmacy.stock.read', 'pharmacy.stock.adjust', 'pharmacy.stock.opname', 'pharmacy.drug.read']);
  await addUser(TTK, 'ttk@a.test', 'TTK Uji', 'TTK_TERBATAS');
  // Role kustom yang (keliru) memegang ajukan + setujui: maker–checker tetap ditegakkan per transaksi
  await customRole('SERBA', ['pharmacy.stock.read', 'pharmacy.stock.adjust', 'pharmacy.stock.approve', 'pharmacy.stock.opname']);
  await addUser(SUPER, 'serba@a.test', 'Petugas Serba', 'SERBA');
  await su(`insert into app.practitioner(id, tenant_id, full_name, practitioner_type) values ($1, $2, 'dr. Jaga Uji', 'DOKTER'), ($3, $2, 'dr. Lain Uji', 'DOKTER')`,
    [PRAC2, ids.tenantA, PRAC3]);
  await addUser(DR2, 'dokter2@a.test', 'dr. Jaga Uji', 'DOKTER', PRAC2);
  await addUser(DR3, 'dokter3@a.test', 'dr. Lain Uji', 'DOKTER', PRAC3);
  // dr. Jaga bertugas di cabang ini hari ini; dr. Lain bertugas di hari lain saja
  await su(`insert into app.practitioner_schedule(tenant_id, practitioner_id, branch_id, unit_id, day_of_week, start_time, end_time, quota)
            select $1, $2, $3, $4, extract(isodow from now() at time zone 'Asia/Jakarta')::int, '00:00', '23:59', 10`, [ids.tenantA, PRAC2, BRANCH, UNIT]);
  await su(`insert into app.practitioner_schedule(tenant_id, practitioner_id, branch_id, unit_id, day_of_week, start_time, end_time, quota)
            select $1, $2, $3, $4, (extract(isodow from now() at time zone 'Asia/Jakarta')::int % 7) + 1, '08:00', '12:00', 10`, [ids.tenantA, PRAC3, BRANCH, UNIT]);
  [{ id: BKS }] = await su(`insert into app.uom(tenant_id, code, name) values ($1, 'BTL', 'Botol') returning id`, [ids.tenantA]);
  const drug = async (code: string, name: string, cls: string, ing: string, uom = TAB) => (await su(`insert into app.drug_item(tenant_id, code, generic_name, dosage_form,
    base_uom_id, drug_class, ingredients) values ($1, $2, $3, 'Tablet', $4, $5, array[$6]) returning id`, [ids.tenantA, code, name, uom, cls, ing]))[0].id as string;
  AMX2 = await drug('AMX500B', 'Amoksisilin 500 mg (merek lain)', 'KERAS', 'amoksisilin');
  CEF = await drug('CFD500', 'Sefadroksil 500 mg', 'KERAS', 'sefadroksil');
  MRF = await drug('MRF10', 'Morfin sintetis 10 mg', 'NARKOTIKA', 'morfin');
  await drug('SYR', 'Sirup sintetis', 'BEBAS', 'gliserin', BKS);
  [{ id: APOTEK }] = await su(`select id from app.stock_location where branch_id = $1 and is_default`, [BRANCH]);
  for (const [d, p] of [[PCT, 500], [AMX, 1000], [AMX2, 1200], [CEF, 1500], [MRF, 5000]] as const) {
    await su(`insert into app.drug_price(tenant_id, drug_item_id, sell_price, valid_from) values ($1, $2, $3, current_date - 30)`, [ids.tenantA, d, p]);
  }
  await batch(PCT, 'P-1', 300, 50);
  await batch(AMX2, 'X-1', 300, 30);
  await batch(CEF, 'C-1', 300, 30);
  await batch(MRF, 'M-1', 300, 10, APOTEK, new Date(Date.now() - 40 * 86_400_000).toISOString());
  await su(`insert into app.allergy_intolerance(tenant_id, patient_id, substance, category, recorded_by) values ($1, $2, 'Sefadroksil', 'OBAT', $3)`,
    [ids.tenantA, PATIENT, ids.dokterA]);
  farmasi = await login('farmasi@a.test');
  ttk = await login('ttk@a.test');
  dokter = await login('dokter@a.test');
  dokter2 = await login('dokter2@a.test');
  dokter3 = await login('dokter3@a.test');
  manajer = await login('manajer@a.test');
  superUser = await login('serba@a.test');
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('Substitusi obat (PHM-FR-010, OD-099)', () => {
  test('S01 apoteker mengajukan pengganti beralasan; validasi; baris tertahan saat menunggu, baris lain tetap dapat diserahkan', async () => {
    const { rx, items, version } = await makeRx([{ drug: AMX, qty: 10 }, { drug: PCT, qty: 5 }]);
    const base = `/api/v1/pharmacy/prescriptions/${rx}/substitutions`;
    const [{ id: syr }] = await su(`select id from app.drug_item where code = 'SYR'`);
    expect((await post(base, farmasi).send({ prescriptionItemId: items[0], newDrugItemId: syr, reason: 'Stok kosong' })).body.code).toBe('PHM-400-SUB-UOM');
    expect((await post(base, farmasi).send({ prescriptionItemId: items[0], newDrugItemId: AMX, reason: 'Stok kosong' })).body.code).toBe('PHM-400-DRUG');
    expect((await post(base, farmasi).send({ prescriptionItemId: items[0], newDrugItemId: AMX2, reason: 'x' })).status).toBe(400);
    expect((await post(base, dokter).send({ prescriptionItemId: items[0], newDrugItemId: AMX2, reason: 'Stok kosong' })).status).toBe(403);
    const r = await post(base, farmasi).send({ prescriptionItemId: items[0], newDrugItemId: AMX2, reason: 'Stok amoksisilin generik kosong' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'REQUESTED', fromDrug: { id: AMX }, toDrug: { id: AMX2 }, requestedByName: 'Apoteker Uji', allergyWarnings: [] });
    expect((await post(base, farmasi).send({ prescriptionItemId: items[0], newDrugItemId: CEF, reason: 'Pengganti kedua' })).body.code).toBe('PHM-409-SUB-PENDING');
    const held = await dispense(rx, version, [{ prescriptionItemId: items[0], qty: 10 }]);
    expect([held.status, held.body.errors[0].message]).toEqual([422, 'Baris ini menunggu persetujuan substitusi dokter']);
    const other = await dispense(rx, version, [{ prescriptionItemId: items[1], qty: 5 }]);
    expect([other.status, other.body.prescriptionStatus]).toEqual([201, 'PARTIALLY_DISPENSED']);
    const d = await get(`/api/v1/pharmacy/prescriptions/${rx}`, farmasi);
    expect(d.body.items[0].substitution).toMatchObject({ status: 'REQUESTED', toDrugName: 'Amoksisilin 500 mg (merek lain)' });
    expect((await post(base, farmasi).send({ prescriptionItemId: items[1], newDrugItemId: CEF, reason: 'Sudah diserahkan' })).body.code).toBe('PHM-409-SUB-STARTED');
  });

  test('S02 hanya dokter penulis resep / bertugas di cabang hari ini; tolak wajib alasan; setuju → baris resep diganti, asli tercatat; peringatan alergi; batal', async () => {
    const { rx, items } = await makeRx([{ drug: AMX, qty: 6 }]);
    const s = (await post(`/api/v1/pharmacy/prescriptions/${rx}/substitutions`, farmasi)
      .send({ prescriptionItemId: items[0], newDrugItemId: CEF, reason: 'Stok amoksisilin kosong' })).body;
    expect(s.allergyWarnings).toEqual(['Sefadroksil']);
    const ids_ = async (j: Jar) => (await get('/api/v1/substitutions', j)).body.map((x: { id: string }) => x.id);
    expect(await ids_(dokter)).toContain(s.id);
    expect(await ids_(dokter2)).toContain(s.id);
    expect(await ids_(dokter3)).not.toContain(s.id);
    expect((await get('/api/v1/substitutions', farmasi)).status).toBe(403);
    const d3 = await post(`/api/v1/substitutions/${s.id}/decision`, dokter3).send({ decision: 'APPROVE' });
    expect([d3.status, d3.body.code]).toEqual([403, 'PHM-403-NOT-APPROVER']);
    expect((await post(`/api/v1/substitutions/${s.id}/decision`, dokter2).send({ decision: 'REJECT' })).status).toBe(400);
    const rej = await post(`/api/v1/substitutions/${s.id}/decision`, dokter2).send({ decision: 'REJECT', note: 'Pasien alergi sefadroksil' });
    expect(rej.body).toMatchObject({ status: 'REJECTED', decidedByName: 'dr. Jaga Uji', decisionNote: 'Pasien alergi sefadroksil' });
    expect((await post(`/api/v1/substitutions/${s.id}/decision`, dokter).send({ decision: 'APPROVE' })).body.code).toBe('PHM-409-SUB-DECIDED');

    const s2 = (await post(`/api/v1/pharmacy/prescriptions/${rx}/substitutions`, farmasi)
      .send({ prescriptionItemId: items[0], newDrugItemId: AMX2, reason: 'Stok amoksisilin generik kosong' })).body;
    const before = await rxVersion(rx);
    const ok = await post(`/api/v1/substitutions/${s2.id}/decision`, dokter).send({ decision: 'APPROVE', note: 'Setara, lanjutkan' });
    expect(ok.body).toMatchObject({ status: 'APPROVED', decidedByName: 'dr. Uji a' });
    expect(await su(`select drug_item_id, substituted_from_drug_id, substitution_approved_by, substitution_reason from app.prescription_item where id = $1`, [items[0]]))
      .toEqual([{ drug_item_id: AMX2, substituted_from_drug_id: AMX, substitution_approved_by: DR, substitution_reason: 'Stok amoksisilin generik kosong' }]);
    const v = await rxVersion(rx);
    expect(v).toBe(before + 1);
    const det = (await get(`/api/v1/pharmacy/prescriptions/${rx}`, farmasi)).body;
    expect(det.items[0]).toMatchObject({ drugName: 'Amoksisilin 500 mg (merek lain)', substitutedFromName: 'Amoksisilin 500 mg', substitution: { status: 'APPROVED' } });
    const r = await dispense(rx, v, [{ prescriptionItemId: items[0], qty: 6 }]);
    expect([r.status, r.body.lines[0].batchNo, r.body.lines[0].unitPrice]).toEqual([201, 'X-1', '1200.00']);
    expect(await su(`select action from app.audit_log where resource_id = $1 and action like 'SUBSTITUTION_%' order by seq`, [rx]))
      .toEqual([{ action: 'SUBSTITUTION_REQUESTED' }, { action: 'SUBSTITUTION_REJECTED' }, { action: 'SUBSTITUTION_REQUESTED' }, { action: 'SUBSTITUTION_APPROVED' }]);

    // Pembatalan oleh apoteker
    const p3 = await makeRx([{ drug: AMX, qty: 2 }]);
    const s3 = (await post(`/api/v1/pharmacy/prescriptions/${p3.rx}/substitutions`, farmasi)
      .send({ prescriptionItemId: p3.items[0], newDrugItemId: AMX2, reason: 'Stok kosong sementara' })).body;
    expect((await post(`/api/v1/pharmacy/substitutions/${s3.id}/cancel`, farmasi).send()).body.status).toBe('CANCELLED');
    expect((await post(`/api/v1/substitutions/${s3.id}/decision`, dokter).send({ decision: 'APPROVE' })).body.code).toBe('PHM-409-SUB-DECIDED');
    // Riwayat substitusi tidak dapat diubah
    const asApp = `set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);`;
    await expect(su(`${asApp} update app.prescription_substitution set reason = 'diubah' where id = '${s2.id}'`)).rejects.toThrow(/IMMUTABLE/);
  });
});

describe('Penyesuaian stok (PHM-FR-016)', () => {
  test('S03 diajukan beralasan, disetujui orang lain; saldo tidak boleh negatif; obat terbatas butuh izin; tolak wajib alasan', async () => {
    const body = { batchId: B['P-1'], locationId: APOTEK, qtyDelta: -3, reason: 'Tablet hancur saat penyimpanan' };
    expect((await post('/api/v1/stock-adjustments', manajer).send(body)).status).toBe(403);
    expect((await post('/api/v1/stock-adjustments', farmasi).send({ ...body, qtyDelta: -999 })).body.code).toBe('PHM-409-NEGATIVE');
    expect((await post('/api/v1/stock-adjustments', farmasi).send({ ...body, qtyDelta: 0 })).status).toBe(400);
    const r = await post('/api/v1/stock-adjustments', farmasi).send(body);
    expect([r.status, r.body.status, r.body.qtyDelta, r.body.qtyOnHand]).toEqual([201, 'REQUESTED', -3, 45]);
    expect(await balance('P-1')).toBe(45);
    expect((await post(`/api/v1/stock-adjustments/${r.body.id}/decision`, farmasi).send({ decision: 'APPROVE' })).status).toBe(403);
    const ok = await post(`/api/v1/stock-adjustments/${r.body.id}/decision`, manajer).send({ decision: 'APPROVE' });
    expect([ok.status, ok.body.status, ok.body.approvedByName]).toEqual([200, 'APPROVED', 'Manajer']);
    expect(await balance('P-1')).toBe(42);
    expect(await su(`select movement_type, qty::int as qty, actor_id from app.stock_movement where ref_id = $1`, [r.body.id]))
      .toEqual([{ movement_type: 'ADJUSTMENT', qty: -3, actor_id: ids.manajerA }]);
    expect((await post(`/api/v1/stock-adjustments/${r.body.id}/decision`, manajer).send({ decision: 'REJECT', note: 'Salah' })).body.code).toBe('PHM-409-DECIDED');

    // Maker–checker per transaksi meski role memegang dua izin
    const own = await post('/api/v1/stock-adjustments', superUser).send({ ...body, qtyDelta: 2, reason: 'Ditemukan di laci' });
    const self = await post(`/api/v1/stock-adjustments/${own.body.id}/decision`, superUser).send({ decision: 'APPROVE' });
    expect([self.status, self.body.code]).toEqual([403, 'PHM-403-SELF-APPROVAL']);
    expect((await post(`/api/v1/stock-adjustments/${own.body.id}/decision`, manajer).send({ decision: 'REJECT' })).status).toBe(400);
    const rej = await post(`/api/v1/stock-adjustments/${own.body.id}/decision`, manajer).send({ decision: 'REJECT', note: 'Tidak ada bukti fisik' });
    expect([rej.body.status, rej.body.decisionNote]).toEqual(['REJECTED', 'Tidak ada bukti fisik']);
    expect(await balance('P-1')).toBe(42);

    // Saldo turun setelah diajukan → persetujuan ditolak
    const big = await post('/api/v1/stock-adjustments', farmasi).send({ ...body, qtyDelta: -40, reason: 'Kemasan basah terkena air' });
    await su(`insert into app.stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id) values ($1, $2, $3, 'DISPENSE', -10, 'dispense', gen_random_uuid())`,
      [ids.tenantA, B['P-1'], APOTEK]);
    expect((await post(`/api/v1/stock-adjustments/${big.body.id}/decision`, manajer).send({ decision: 'APPROVE' })).body.code).toBe('PHM-409-NEGATIVE');

    const m = await post('/api/v1/stock-adjustments', ttk).send({ batchId: B['M-1'], locationId: APOTEK, qtyDelta: -1, reason: 'Ampul pecah' });
    expect([m.status, m.body.code]).toEqual([403, 'PHM-403-RESTRICTED']);
    const m2 = await post('/api/v1/stock-adjustments', farmasi).send({ batchId: B['M-1'], locationId: APOTEK, qtyDelta: -1, reason: 'Ampul pecah' });
    expect((await post(`/api/v1/stock-adjustments/${m2.body.id}/decision`, manajer).send({ decision: 'APPROVE' })).body.status).toBe('APPROVED');
    const list = await get('/api/v1/stock-adjustments?status=REQUESTED', farmasi);
    expect(list.body.map((x: { id: string }) => x.id)).toEqual([big.body.id]);
  });
});

describe('Stock opname (PHM-FR-017)', () => {
  test('S04 mulai → hitung (obat terbatas butuh izin) → kirim (lengkap, selisih beralasan) → tolak → hitung ulang → disetujui orang lain → mutasi OPNAME', async () => {
    const st = await post('/api/v1/stock-opnames', farmasi).send({ locationId: APOTEK, notes: 'Opname akhir bulan' });
    expect(st.status).toBe(201);
    expect((await post('/api/v1/stock-opnames', farmasi).send({ locationId: APOTEK })).body.code).toBe('PHM-409-OPNAME-ACTIVE');
    const id = st.body.id;
    const line = (no: string) => st.body.lines.find((l: { batchNo: string }) => l.batchNo === no);
    expect(line('P-1')).toMatchObject({ systemQty: 32, countedQty: null });
    expect(line('M-1')).toMatchObject({ restricted: true, systemQty: 9 });
    let v = st.body.version;
    expect((await post(`/api/v1/stock-opnames/${id}/submit`, farmasi, v).send()).body.code).toBe('PHM-422-OPNAME-INCOMPLETE');
    const mrf = await put(`/api/v1/stock-opnames/${id}/counts`, ttk, v).send({ lines: [{ batchId: B['M-1'], countedQty: 9 }] });
    expect([mrf.status, mrf.body.errors[0].message]).toEqual([403, expect.stringMatching(/butuh izin khusus/)]);
    const counts = st.body.lines.map((l: { batchId: string; batchNo: string; systemQty: number }) =>
      ({ batchId: l.batchId, countedQty: l.batchNo === 'P-1' ? 30 : l.batchNo === 'C-1' ? 31 : l.systemQty }));
    const c1 = await put(`/api/v1/stock-opnames/${id}/counts`, farmasi, v).send({ lines: counts });
    expect(c1.status).toBe(200);
    expect((await put(`/api/v1/stock-opnames/${id}/counts`, farmasi, v).send({ lines: counts })).status).toBe(412);
    v = c1.body.version;
    const sub1 = await post(`/api/v1/stock-opnames/${id}/submit`, farmasi, v).send();
    expect([sub1.status, sub1.body.errors.length]).toEqual([422, 2]);
    const c2 = await put(`/api/v1/stock-opnames/${id}/counts`, farmasi, v).send({ lines: [
      { batchId: B['P-1'], countedQty: 30, note: 'Dua tablet hilang' }, { batchId: B['C-1'], countedQty: 31, note: 'Satu tablet lebih (salah input penerimaan)' }] });
    v = c2.body.version;
    const sub = await post(`/api/v1/stock-opnames/${id}/submit`, farmasi, v).send();
    expect([sub.status, sub.body.status]).toEqual([200, 'SUBMITTED']);
    v = sub.body.version;
    expect((await put(`/api/v1/stock-opnames/${id}/counts`, farmasi, v).send({ lines: counts })).body.code).toBe('PHM-409-OPNAME-STATE');
    expect((await post(`/api/v1/stock-opnames/${id}/decision`, farmasi, v).send({ decision: 'APPROVE' })).status).toBe(403);
    const rj = await post(`/api/v1/stock-opnames/${id}/decision`, manajer, v).send({ decision: 'REJECT', note: 'Hitung ulang rak sefadroksil' });
    expect([rj.body.status, rj.body.decisionNote]).toEqual(['COUNTING', 'Hitung ulang rak sefadroksil']);
    v = rj.body.version;
    // Hitung ulang P-1, lalu ada penyerahan 5 tablet sebelum disetujui: koreksi tetap selisih saat dihitung (−2)
    v = (await put(`/api/v1/stock-opnames/${id}/counts`, farmasi, v).send({ lines: [{ batchId: B['P-1'], countedQty: 30, note: 'Dua tablet hilang' }] })).body.version;
    await su(`insert into app.stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id) values ($1, $2, $3, 'DISPENSE', -5, 'dispense', gen_random_uuid())`,
      [ids.tenantA, B['P-1'], APOTEK]);
    v = (await post(`/api/v1/stock-opnames/${id}/submit`, farmasi, v).send()).body.version;
    const self = await post(`/api/v1/stock-opnames/${id}/decision`, superUser, v).send({ decision: 'APPROVE' });
    expect(self.status).toBe(200);   // bukan yang memulai → boleh
    expect(self.body).toMatchObject({ status: 'APPROVED', approvedByName: 'Petugas Serba' });
    expect([await balance('P-1'), await balance('C-1'), await balance('M-1')]).toEqual([25, 31, 9]);
    expect(await su(`select movement_type, qty::int as qty from app.stock_movement where ref_id = $1 order by qty`, [id]))
      .toEqual([{ movement_type: 'OPNAME', qty: -2 }, { movement_type: 'OPNAME', qty: 1 }]);
    const asApp = `set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);`;
    await expect(su(`${asApp} update app.stock_opname_line set counted_qty = 0 where opname_id = '${id}'`)).rejects.toThrow(/IMMUTABLE/);
    const [{ ledger, bal }] = await su(`select (select sum(qty) from app.stock_movement)::text as ledger, (select sum(qty_on_hand) from app.stock_balance)::text as bal`);
    expect(ledger).toBe(bal);
  });

  test('S05 yang memulai tidak dapat menyetujui; batal; satu sesi aktif per lokasi; daftar', async () => {
    const st = await post('/api/v1/stock-opnames', superUser).send({ locationId: GUDANG });
    expect(st.status).toBe(201);
    expect(st.body.lines).toEqual([]);
    let v = (await put(`/api/v1/stock-opnames/${st.body.id}/counts`, superUser, st.body.version).send({ lines: [{ batchId: B['C-1'], countedQty: 2, note: 'Ditemukan di gudang' }] })).body.version;
    v = (await post(`/api/v1/stock-opnames/${st.body.id}/submit`, superUser, v).send()).body.version;
    const self = await post(`/api/v1/stock-opnames/${st.body.id}/decision`, superUser, v).send({ decision: 'APPROVE' });
    expect([self.status, self.body.code]).toEqual([403, 'PHM-403-SELF-APPROVAL']);
    const c = await post(`/api/v1/stock-opnames/${st.body.id}/cancel`, superUser, v).send();
    expect(c.body.status).toBe('CANCELLED');
    expect((await post('/api/v1/stock-opnames', farmasi).send({ locationId: GUDANG })).status).toBe(201);
    const list = await get(`/api/v1/stock-opnames?locationId=${GUDANG}`, farmasi);
    expect(list.body.map((x: { status: string }) => x.status)).toEqual(['COUNTING', 'CANCELLED']);
  });
});

describe('Laporan obat golongan terbatas (OD-100)', () => {
  test('S06 per bulan: saldo awal, masuk, keluar resep, penyesuaian/opname, saldo akhir; CSV; izin laporan; audit', async () => {
    const m = await makeRx([{ drug: MRF, qty: 2 }]);
    expect((await dispense(m.rx, m.version, [{ prescriptionItemId: m.items[0], qty: 2 }])).status).toBe(201);
    const now = new Date(Date.now() + 7 * 3_600_000);
    const month = now.toISOString().slice(0, 7);
    const r = await get(`/api/v1/reports/controlled-drugs?month=${month}&branchId=${BRANCH}`, farmasi);
    expect(r.status).toBe(200);
    expect(r.body.columns.map((c: { key: string }) => c.key)).toContain('closing');
    expect(r.body.note).toMatch(/belum diverifikasi/);
    const row = r.body.rows.find((x: { code: string }) => x.code === 'MRF10');
    // 10 masuk 40 hari lalu (bulan lalu atau awal bulan ini)
    const openedEarlier = new Date(Date.now() - 40 * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 7) < month;
    expect(row).toMatchObject({ drugClass: 'NARKOTIKA', opening: openedEarlier ? 10 : 0, received: openedEarlier ? 0 : 10, dispensed: 2, adjusted: -1, closing: 7 });
    expect(r.body.rows.every((x: { drugClass: string }) => ['NARKOTIKA', 'PSIKOTROPIKA', 'PREKURSOR'].includes(x.drugClass))).toBe(true);
    const csv = await get(`/api/v1/reports/controlled-drugs?month=${month}&format=csv`, farmasi);
    expect([csv.status, csv.headers['content-type']]).toEqual([200, 'text/csv; charset=utf-8']);
    expect(csv.text).toContain('Kode,Nama obat,Golongan,Satuan,Saldo awal');
    expect(csv.text).toContain('MRF10,Morfin sintetis 10 mg,NARKOTIKA');
    expect((await get(`/api/v1/reports/controlled-drugs?month=2026-13`, farmasi)).status).toBe(400);
    expect((await get(`/api/v1/reports/controlled-drugs?month=${month}`, dokter)).status).toBe(403);
    const past = await get(`/api/v1/reports/controlled-drugs?month=2020-01`, manajer);
    expect(past.body.rows.find((x: { code: string }) => x.code === 'MRF10')).toMatchObject({ opening: 0, closing: 0 });
    expect(await su(`select count(*)::int as n from app.audit_log where action = 'REPORT_CONTROLLED_DRUGS_VIEWED'`)).toEqual([{ n: 3 }]);
  });
});
