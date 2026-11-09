import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Client, Pool } from 'pg';
import request from 'supertest';
import { closeExpiredRemainders } from '@clinicrme/db/rx-remainder';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, ownerUrl, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 10 batch 2 — worklist farmasi, telaah, penyerahan FEFO/sebagian, racikan, harga terkunci, etiket, tutup sisa
 * (PHM-FR-005–009, 011, 013; OD-037, OD-096, OD-098, OD-102–104 / DEC-039). Data obat & pasien sintetis.
 */
const HOST = 'klinik-a.clinicrme.test';
const HOST_B = 'klinik-b.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const BRANCH = A(10), UNIT = A(11), DR = A(20), TAB = A(40), PCT = A(41), AMX = A(42), PATIENT = A(60), GUDANG = A(50);
const FARMASI = A(34), TTK = A(35);
let app: INestApplication;
let http: ReturnType<typeof request>;
let pool: Pool;

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
const post = (path: string, j: Jar, version?: number) => {
  const r = http.post(path).set('Host', j.host).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
  return version === undefined ? r : r.set('If-Match', String(version));
};
let farmasi: Jar, ttk: Jar, dokter: Jar, farmasiB: Jar;
let CTM: string, MRF: string, VITC: string, BKS: string, APOTEK: string;
const B: Record<string, string> = {};

const ALL_OK = { ADM_PATIENT: { ok: true }, ADM_PRESCRIBER: { ok: true }, ADM_DATE: { ok: true }, PHA_FORM: { ok: true }, PHA_QTY: { ok: true },
  PHA_DIRECTIONS: { ok: true }, PHA_COMPOUND: { ok: true }, CLN_DOSE: { ok: true }, CLN_ALLERGY: { ok: true }, CLN_DUPLICATE: { ok: true }, CLN_SPECIAL: { ok: true } };

async function addUser(id: string, email: string, name: string, role: string) {
  await su(`insert into app.app_user(id, tenant_id, email, full_name) values ($1, $2, $3, $4)`, [id, ids.tenantA, email, name]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and code = $3`, [ids.tenantA, id, role]);
  await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select tenant_id, $2, password_hash from app.user_credential where user_id = $1`, [ids.dokterA, id]);
}
async function batch(drug: string, no: string, days: number, qty: number, loc = APOTEK) {
  const [{ id }] = await su(`insert into app.stock_batch(tenant_id, drug_item_id, batch_no, expiry_date, unit_cost)
                             values ($1, $2, $3, current_date + $4::int, 100) returning id`, [ids.tenantA, drug, no, days]);
  await su(`insert into app.stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id) values ($1, $2, $3, 'RECEIPT', $4, 'goods_receipt', gen_random_uuid())`,
    [ids.tenantA, id, loc, qty]);
  B[no] = id;
  return id;
}
async function price(drug: string, sell: number, payer: string | null = null) {
  await su(`insert into app.drug_price(tenant_id, drug_item_id, payer_type, sell_price, valid_from) values ($1, $2, $3, $4, current_date - 30)`, [ids.tenantA, drug, payer, sell]);
}
type Line = { drug: string; qty: number } | { compound: string; qty: number; comps: { drug: string; qty: number }[] };
/** Kunjungan di farmasi + resep diterbitkan (setara "Selesai konsultasi" Stage 9). */
async function makeRx(lines: Line[], o: { payer?: string; encStatus?: string } = {}) {
  let coverage: string | null = null;
  if (o.payer && o.payer !== 'UMUM') {
    const [{ id: payer }] = await su(`insert into app.payer(tenant_id, code, name, payer_type) values ($1, $2, 'Penjamin uji', $3) returning id`,
      [ids.tenantA, `P${randomUUID().slice(0, 6)}`, o.payer]);
    [{ id: coverage }] = await su(`insert into app.patient_coverage(tenant_id, patient_id, payer_id, member_no) values ($1, $2, $3, '0000000000001') returning id`,
      [ids.tenantA, PATIENT, payer]);
  }
  const [{ id: enc }] = await su(`insert into app.encounter(tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, arrival_type, status, payer_type, coverage_id)
    values ($1, $2, $3, $4, $5, $6, 'WALK_IN', $7, $8, $9) returning id`,
    [ids.tenantA, `KJ-${randomUUID().slice(0, 8)}`, PATIENT, BRANCH, UNIT, DR, o.encStatus ?? 'PHARMACY', o.payer ?? 'UMUM', coverage]);
  const [{ id: rx }] = await su(`insert into app.prescription(tenant_id, prescription_no, encounter_id, prescriber_id) values ($1, $2, $3, $4) returning id`,
    [ids.tenantA, `RX-${randomUUID().slice(0, 8)}`, enc, DR]);
  const items: string[] = [];
  for (const [n, l] of lines.entries()) {
    const c = 'compound' in l;
    const [{ id }] = await su(`insert into app.prescription_item(tenant_id, prescription_id, line_no, is_compound, drug_item_id, compound_name, compound_form,
                                 dose, dose_qty, times_per_day, frequency, route, qty, uom_id, instructions)
      values ($1, $2, $3, $4, $5, $6, $7, '1 Tablet', 1, 3, '3x sehari', 'ORAL', $8, $9, 'Sesudah makan') returning id`,
      [ids.tenantA, rx, n + 1, c, c ? null : l.drug, c ? l.compound : null, c ? 'Puyer' : null, l.qty, c ? BKS : TAB]);
    if (c) for (const k of l.comps) {
      await su(`insert into app.prescription_compound_component(tenant_id, prescription_item_id, drug_item_id, qty, uom_id) values ($1, $2, $3, $4, $5)`,
        [ids.tenantA, id, k.drug, k.qty, TAB]);
    }
    items.push(id);
  }
  await su(`update app.prescription set status = 'ISSUED', issued_at = now() where id = $1`, [rx]);
  return { rx, enc, items };
}
const detail = (rx: string, j = farmasi) => get(`/api/v1/pharmacy/prescriptions/${rx}`, j);
async function verify(rx: string) {
  const v = (await detail(rx)).body.version;
  const r = await post(`/api/v1/pharmacy/prescriptions/${rx}/review`, farmasi, v).send({ items: ALL_OK });
  expect([r.status, r.body.status]).toEqual([200, 'VERIFIED']);
  return r.body.version as number;
}
const dispense = (rx: string, version: number, body: object, j = farmasi, key = `uji-${randomUUID()}`) =>
  post(`/api/v1/pharmacy/prescriptions/${rx}/dispense`, j, version).set('Idempotency-Key', key).send(body);
const balance = async (batchNo: string) =>
  Number((await su(`select coalesce(sum(qty_on_hand), 0)::text as q from app.stock_balance where batch_id = $1`, [B[batchNo]]))[0].q);

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  pool = new Pool({ connectionString: ownerUrl(), max: 2 });
  await addUser(FARMASI, 'farmasi@a.test', 'Apoteker Uji', 'FARMASI');
  await su(`with r as (insert into app.role(tenant_id, code, name) values ($1, 'TTK_TERBATAS', 'TTK tanpa izin terbatas') returning id)
            insert into app.role_permission(tenant_id, role_id, permission_code)
            select $1, r.id, p from r, unnest(array['pharmacy.dispense', 'pharmacy.stock.read', 'pharmacy.drug.read']) p`, [ids.tenantA]);
  await addUser(TTK, 'ttk@a.test', 'TTK Uji', 'TTK_TERBATAS');
  [{ id: BKS }] = await su(`insert into app.uom(tenant_id, code, name) values ($1, 'BKS', 'Bungkus') returning id`, [ids.tenantA]);
  const drug = async (code: string, name: string, cls: string) => (await su(`insert into app.drug_item(tenant_id, code, generic_name, dosage_form, base_uom_id, drug_class, ingredients)
    values ($1, $2, $3, 'Tablet', $4, $5, array[lower($3)]) returning id`, [ids.tenantA, code, name, TAB, cls]))[0].id as string;
  CTM = await drug('CTM4', 'Klorfeniramin 4 mg', 'KERAS');
  MRF = await drug('MRF10', 'Morfin sintetis 10 mg', 'NARKOTIKA');
  VITC = await drug('VITC', 'Vitamin C sintetis', 'BEBAS');
  [{ id: APOTEK }] = await su(`select id from app.stock_location where branch_id = $1 and is_default`, [BRANCH]);
  await price(PCT, 500); await price(PCT, 300, 'BPJS'); await price(AMX, 1000); await price(CTM, 200); await price(MRF, 5000);
  await batch(PCT, 'P-LATE', 300, 50);      // diterima lebih dulu, kedaluwarsa lebih lama
  await batch(PCT, 'P-EARLY', 60, 10);      // diterima kemudian, kedaluwarsa lebih dekat → FEFO keluar dulu
  await batch(PCT, 'P-GUDANG', 30, 99, GUDANG);   // lokasi lain — tidak dipakai penyerahan dari Apotek
  await batch(AMX, 'A-1', 200, 5);
  await batch(CTM, 'C-1', 200, 100);
  await batch(MRF, 'M-1', 200, 10);
  await batch(VITC, 'V-1', 200, 10);
  await su(`insert into app.allergy_intolerance(tenant_id, patient_id, substance, category, recorded_by) values ($1, $2, 'Penisilin', 'OBAT', $3)`,
    [ids.tenantA, PATIENT, ids.dokterA]);
  farmasi = await login('farmasi@a.test');
  ttk = await login('ttk@a.test');
  dokter = await login('dokter@a.test');
  const FB = 'bbbbbbbb-0000-0000-0000-000000000034';
  await su(`insert into app.app_user(id, tenant_id, email, full_name) values ($1, $2, 'farmasi@b.test', 'Apoteker B')`, [FB, ids.tenantB]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and code = 'FARMASI'`, [ids.tenantB, FB]);
  await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select $1, $2, password_hash from app.user_credential where user_id = $3`, [ids.tenantB, FB, ids.dokterB]);
  farmasiB = await login('farmasi@b.test', HOST_B);
}, 60_000);
afterAll(async () => { await pool?.end(); await app?.close(); });

describe('Worklist & telaah (PHM-FR-005/006, OD-098)', () => {
  test('D01 resep terbit masuk worklist; rincian: alergi, sisa, stok & alokasi FEFO dari lokasi Apotek, harga; akses dicatat; lintas tenant 404', async () => {
    const { rx } = await makeRx([{ drug: PCT, qty: 15 }]);
    const wl = await get(`/api/v1/pharmacy/worklist?branchId=${BRANCH}`, farmasi);
    expect(wl.status).toBe(200);
    expect(wl.body.find((x: { id: string }) => x.id === rx)).toMatchObject({ status: 'ISSUED', reviewed: false, patient: { mrn: 'RM-a-0001' }, itemCount: 1 });
    const d = await detail(rx);
    expect(d.status).toBe(200);
    expect(d.body.patient.allergies).toEqual([{ substance: 'Penisilin', reaction: null, severity: null }]);
    expect(d.body.location.name).toBe('Apotek');
    expect(d.body.checklist).toHaveLength(11);
    const st = d.body.items[0].stock[0];
    expect(st).toMatchObject({ unitPrice: '500.00', available: 60, need: 15 });
    expect(st.allocation).toEqual([{ batchId: B['P-EARLY'], qty: 10 }, { batchId: B['P-LATE'], qty: 5 }]);
    expect(await su(`select count(*)::int as n from app.audit_log where action = 'PRESCRIPTION_VIEWED_PHARMACY' and resource_id = $1`, [rx])).toEqual([{ n: 1 }]);
    expect((await detail(rx, dokter)).status).toBe(403);
    expect((await detail(rx, farmasiB)).status).toBe(404);
    expect((await get('/api/v1/pharmacy/worklist', farmasiB)).body.find((x: { id: string }) => x.id === rx)).toBeUndefined();
  });

  test('D02 telaah: butir tidak sesuai wajib catatan; ada masalah → tetap ISSUED & tidak dapat diserahkan; semua sesuai → VERIFIED; If-Match', async () => {
    const { rx } = await makeRx([{ drug: PCT, qty: 1 }]);
    const v = (await detail(rx)).body.version;
    const bad = await post(`/api/v1/pharmacy/prescriptions/${rx}/review`, farmasi, v).send({ items: { ...ALL_OK, CLN_DOSE: { ok: false } } });
    expect([bad.status, bad.body.errors[0].field]).toEqual([400, 'items.CLN_DOSE.note']);
    expect((await post(`/api/v1/pharmacy/prescriptions/${rx}/review`, farmasi, v).send({ items: { ADM_PATIENT: { ok: true } } })).status).toBe(400);
    const p = await post(`/api/v1/pharmacy/prescriptions/${rx}/review`, farmasi, v)
      .send({ items: { ...ALL_OK, CLN_DOSE: { ok: false, note: 'Dosis perlu konfirmasi ke dokter' } } });
    expect([p.status, p.body.status, p.body.review.result]).toEqual([200, 'ISSUED', 'PROBLEM']);
    expect(p.body.review.items.CLN_DOSE).toEqual({ ok: false, note: 'Dosis perlu konfirmasi ke dokter' });
    const d = await dispense(rx, p.body.version, { lines: [] });
    expect(d.status).toBe(400);
    const d2 = await dispense(rx, p.body.version, { lines: [{ prescriptionItemId: randomUUID(), qty: 1 }] });
    expect(d2.body.code).toBe('PHM-409-NOT-REVIEWED');
    expect((await post(`/api/v1/pharmacy/prescriptions/${rx}/review`, farmasi, v).send({ items: ALL_OK })).status).toBe(412);
    const ok = await post(`/api/v1/pharmacy/prescriptions/${rx}/review`, farmasi, p.body.version).send({ items: ALL_OK });
    expect([ok.body.status, ok.body.review.result, ok.body.review.reviewerName]).toEqual(['VERIFIED', 'OK', 'Apoteker Uji']);
    expect((await get(`/api/v1/pharmacy/worklist?status=PENDING`, farmasi)).body.find((x: { id: string }) => x.id === rx)).toMatchObject({ reviewed: true, reviewProblem: false });
  });
});

describe('Penyerahan (PHM-FR-007–009, 011)', () => {
  test('D03 serahkan utuh: FEFO lintas batch, harga terkunci per penjamin, stok & ledger, resep DISPENSED, kunjungan → kasir; idempoten; etiket 80×50 mm', async () => {
    const { rx, enc, items } = await makeRx([{ drug: PCT, qty: 15 }]);
    const v = await verify(rx);
    const key = `uji-${randomUUID()}`;
    const r = await dispense(rx, v, { lines: [{ prescriptionItemId: items[0], qty: 15 }], handedTo: 'Pasien sendiri' }, farmasi, key);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ prescriptionStatus: 'DISPENSED', encounterStatus: 'BILLING' });
    expect(r.body.lines.map((l: { batchNo: string; qtyBase: number; unitPrice: string; amount: string; billingStatus: string }) =>
      [l.batchNo, l.qtyBase, l.unitPrice, l.amount, l.billingStatus])).toEqual([
      ['P-EARLY', 10, '500.00', '5000.00', 'UNBILLED'], ['P-LATE', 5, '500.00', '2500.00', 'UNBILLED']]);
    expect([await balance('P-EARLY'), await balance('P-LATE'), await balance('P-GUDANG')]).toEqual([0, 45, 99]);
    expect(await su(`select status from app.encounter where id = $1`, [enc])).toEqual([{ status: 'BILLING' }]);
    const again = await dispense(rx, v, { lines: [{ prescriptionItemId: items[0], qty: 15 }], handedTo: 'Pasien sendiri' }, farmasi, key);
    expect([again.status, again.body.dispenseId]).toEqual([201, r.body.dispenseId]);
    expect(await su(`select count(*)::int as n from app.stock_movement where ref_id = $1 and movement_type = 'DISPENSE'`, [r.body.dispenseId])).toEqual([{ n: 2 }]);
    expect((await dispense(rx, v + 1, { lines: [{ prescriptionItemId: items[0], qty: 1 }] })).body.code).toBe('PHM-409-RX-STATE');
    const [{ ledger, bal }] = await su(`select (select sum(qty) from app.stock_movement)::text as ledger, (select sum(qty_on_hand) from app.stock_balance)::text as bal`);
    expect(ledger).toBe(bal);
    expect(await su(`select count(*)::int as n from app.audit_log where action = 'MEDICATION_DISPENSED' and resource_id = $1`, [r.body.dispenseId])).toEqual([{ n: 1 }]);

    const lbl = await get(`/api/v1/pharmacy/dispenses/${r.body.dispenseId}/labels`, farmasi).buffer(true).parse((res, cb) => {
      const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect([lbl.status, lbl.headers['content-type']]).toEqual([200, 'application/pdf']);
    const pdf = (lbl.body as Buffer).toString('latin1');
    expect(pdf.startsWith('%PDF')).toBe(true);
    expect(pdf).toMatch(/MediaBox \[0 0 226\.77\d* 141\.73\d*\]/);
    expect((pdf.match(/\/Type \/Page\b/g) ?? []).length).toBe(1);
    expect((await get(`/api/v1/pharmacy/dispenses/${r.body.dispenseId}/labels`, dokter)).status).toBe(403);
    // Riwayat obat pasien tampil pada resep berikutnya
    const next = await makeRx([{ drug: CTM, qty: 1 }]);
    expect((await detail(next.rx)).body.medicationHistory.find((h: { drugName: string }) => h.drugName === 'Parasetamol 500 mg')).toMatchObject({ qty: 15 });
  });

  test('D04 stok kurang → serahkan sebagian; sisa tercatat; batas ambil 7 hari; tutup sisa (tidak ditagih); job otomatis menutup sisa kedaluwarsa', async () => {
    const { rx, items } = await makeRx([{ drug: AMX, qty: 10 }, { drug: CTM, qty: 6 }]);
    let v = await verify(rx);
    const short = await dispense(rx, v, { lines: [{ prescriptionItemId: items[0], qty: 10 }] });
    expect([short.status, short.body.errors[0].field]).toEqual([422, 'lines.0.qty']);
    expect(short.body.errors[0].message).toMatch(/tersedia 5/);
    const r = await dispense(rx, v, { lines: [{ prescriptionItemId: items[0], qty: 5 }, { prescriptionItemId: items[1], qty: 6 }] });
    expect([r.status, r.body.prescriptionStatus]).toEqual([201, 'PARTIALLY_DISPENSED']);
    const d = await detail(rx);
    expect(d.body.items.map((i: { remaining: number }) => i.remaining)).toEqual([5, 0]);
    expect(d.body.pickupDeadline).not.toBeNull();
    expect(Date.parse(d.body.pickupDeadline) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect((await get('/api/v1/pharmacy/worklist?status=PARTIAL', farmasi)).body.map((x: { id: string }) => x.id)).toContain(rx);
    v = d.body.version;
    const over = await dispense(rx, v, { lines: [{ prescriptionItemId: items[0], qty: 6 }] });
    expect(over.body.errors[0].message).toMatch(/Melebihi sisa resep/);
    expect((await dispense(rx, v, { lines: [{ prescriptionItemId: items[1], qty: 1 }] })).body.errors[0].message).toBe('Baris ini sudah selesai');
    const c = await post(`/api/v1/pharmacy/prescriptions/${rx}/close`, farmasi, v).send({ reason: 'Pasien memilih membeli di apotek lain' });
    expect([c.status, c.body.status]).toEqual([200, 'DISPENSED']);
    expect(c.body.items[0]).toMatchObject({ qtyDispensed: 5, qtyClosed: 5, remaining: 0, closeReason: 'Pasien memilih membeli di apotek lain' });

    // Lewat batas ambil: penyerahan ditolak; job menutup sisa sebagai "tidak diambil" (SYSTEM)
    await batch(AMX, 'A-2', 200, 3);
    const p2 = await makeRx([{ drug: AMX, qty: 8 }]);
    const v2 = await verify(p2.rx);
    expect((await dispense(p2.rx, v2, { lines: [{ prescriptionItemId: p2.items[0], qty: 3 }] })).body.prescriptionStatus).toBe('PARTIALLY_DISPENSED');
    await su(`update app.prescription set first_dispensed_at = now() - interval '8 days' where id = $1`, [p2.rx]);
    await batch(AMX, 'A-3', 200, 10);
    const late = await dispense(p2.rx, (await detail(p2.rx)).body.version, { lines: [{ prescriptionItemId: p2.items[0], qty: 5 }] });
    expect([late.status, late.body.code]).toEqual([409, 'PHM-409-PICKUP-EXPIRED']);
    const job = await closeExpiredRemainders(pool);
    expect(job.closed).toBe(1);
    expect(await su(`select p.status, i.qty_closed::int as closed, i.close_reason from app.prescription p join app.prescription_item i on i.prescription_id = p.id where p.id = $1`, [p2.rx]))
      .toEqual([{ status: 'DISPENSED', closed: 5, close_reason: 'Otomatis: sisa resep tidak diambil sampai batas waktu' }]);
    expect(await su(`select actor_kind from app.audit_log where action = 'PRESCRIPTION_REMAINDER_CLOSED' and resource_id = $1`, [p2.rx])).toEqual([{ actor_kind: 'SYSTEM' }]);
    expect((await closeExpiredRemainders(pool)).closed).toBe(0);
  });

  test('D05 racikan diserahkan utuh, stok tiap komponen berkurang proporsional; harga penjamin BPJS; etiket memakai jumlah racikan', async () => {
    const { rx, items } = await makeRx([{ compound: 'Puyer batuk anak', qty: 10, comps: [{ drug: PCT, qty: 5 }, { drug: CTM, qty: 10 }] }], { payer: 'BPJS' });
    const v = await verify(rx);
    const d = await detail(rx);
    expect(d.body.items[0].stock.map((s: { drugName: string; need: number; unitPrice: string }) => [s.drugName, s.need, s.unitPrice]).sort())
      .toEqual([['Klorfeniramin 4 mg', 10, '200.00'], ['Parasetamol 500 mg', 5, '300.00']]);
    const part = await dispense(rx, v, { lines: [{ prescriptionItemId: items[0], qty: 5 }] });
    expect(part.body.errors[0].message).toBe('Racikan diserahkan utuh sesuai sisa resep');
    const before = await balance('C-1');
    const r = await dispense(rx, v, { lines: [{ prescriptionItemId: items[0], qty: 10 }] });
    expect([r.status, r.body.prescriptionStatus]).toEqual([201, 'DISPENSED']);
    expect(r.body.lines.map((l: { drugName: string; qtyBase: number; unitPrice: string }) => [l.drugName, l.qtyBase, l.unitPrice]))
      .toEqual([['Klorfeniramin 4 mg', 10, '200.00'], ['Parasetamol 500 mg', 5, '300.00']]);
    expect(await balance('C-1')).toBe(before - 10);
    expect(await su(`select distinct item_qty::int as q from app.dispense_line where dispense_id = $1`, [r.body.dispenseId])).toEqual([{ q: 10 }]);
    const lbl = await get(`/api/v1/pharmacy/dispenses/${r.body.dispenseId}/labels`, farmasi);
    expect(lbl.status).toBe(200);
  });

  test('D06 batch manual wajib beralasan; obat golongan terbatas butuh izin (OD-100); tanpa harga berlaku ditolak; lokasi lain cabang', async () => {
    const { rx, items } = await makeRx([{ drug: PCT, qty: 2 }]);
    const v = await verify(rx);
    const noReason = await dispense(rx, v, { lines: [{ prescriptionItemId: items[0], qty: 2, batches: [{ batchId: B['P-LATE'], qty: 2 }] }] });
    expect(noReason.body.errors[0].field).toBe('lines.0.batchReason');
    const wrongSum = await dispense(rx, v, { lines: [{ prescriptionItemId: items[0], qty: 2, batches: [{ batchId: B['P-LATE'], qty: 1 }], batchReason: 'Kemasan sudah terbuka' }] });
    expect(wrongSum.body.errors[0].field).toBe('lines.0.batches');
    const [{ id: expired }] = await su(`select id from app.stock_batch where batch_no = 'B-EXP'`);
    await su(`insert into app.stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id) values ($1, $2, $3, 'RECEIPT', 5, 'goods_receipt', gen_random_uuid())`,
      [ids.tenantA, expired, APOTEK]);
    const exp = await dispense(rx, v, { lines: [{ prescriptionItemId: items[0], qty: 2, batches: [{ batchId: expired, qty: 2 }], batchReason: 'Uji batch kedaluwarsa' }] });
    expect(exp.body.errors[0].message).toMatch(/kedaluwarsa/);
    const ok = await dispense(rx, v, { lines: [{ prescriptionItemId: items[0], qty: 2, batches: [{ batchId: B['P-LATE'], qty: 2 }], batchReason: 'Kemasan sudah terbuka' }] });
    expect(ok.status).toBe(201);
    expect(ok.body.lines[0]).toMatchObject({ batchNo: 'P-LATE', batchReason: 'Kemasan sudah terbuka' });

    const m = await makeRx([{ drug: MRF, qty: 2 }]);
    const vm = await verify(m.rx);
    const no = await dispense(m.rx, vm, { lines: [{ prescriptionItemId: m.items[0], qty: 2 }] }, ttk);
    expect([no.status, no.body.code]).toEqual([403, 'PHM-403-RESTRICTED']);
    expect((await dispense(m.rx, vm, { lines: [{ prescriptionItemId: m.items[0], qty: 2 }] })).status).toBe(201);

    const n = await makeRx([{ drug: VITC, qty: 1 }]);
    const vn = await verify(n.rx);
    expect((await detail(n.rx)).body.items[0].stock[0].unitPrice).toBeNull();
    const np = await dispense(n.rx, vn, { lines: [{ prescriptionItemId: n.items[0], qty: 1 }] });
    expect([np.status, np.body.errors[0].message]).toEqual([422, 'Vitamin C sintetis belum memiliki harga jual berlaku']);
    // Dari lokasi lain cabang (Gudang Uji)
    await price(VITC, 1500);
    await batch(VITC, 'V-G', 100, 4, GUDANG);
    const g = await dispense(n.rx, vn, { locationId: GUDANG, lines: [{ prescriptionItemId: n.items[0], qty: 1 }] });
    expect([g.status, g.body.lines[0].batchNo]).toEqual([201, 'V-G']);
  });

  test('D07 tutup resep tanpa penyerahan → CLOSED & kunjungan lanjut; FIFO sesuai pengaturan; penyerahan immutable kecuali status tagih', async () => {
    const { rx, enc } = await makeRx([{ drug: CTM, qty: 3 }]);
    const v = (await detail(rx)).body.version;
    expect((await post(`/api/v1/pharmacy/prescriptions/${rx}/close`, farmasi, v).send({ reason: 'x' })).status).toBe(400);
    const c = await post(`/api/v1/pharmacy/prescriptions/${rx}/close`, farmasi, v).send({ reason: 'Pasien tidak menebus resep' });
    expect([c.body.status, c.body.closedReason]).toEqual(['CLOSED', 'Pasien tidak menebus resep']);
    expect(await su(`select status from app.encounter where id = $1`, [enc])).toEqual([{ status: 'BILLING' }]);
    expect((await post(`/api/v1/pharmacy/prescriptions/${rx}/close`, farmasi, c.body.version).send({ reason: 'Tutup lagi' })).body.code).toBe('PHM-409-RX-STATE');

    // Kasir dulu (pharmacyBeforeCashier=false): kunjungan yang tiba di farmasi selesai setelah penyerahan
    await su(`update app.tenant set settings = settings || '{"dispenseMethod": "FIFO", "pharmacyBeforeCashier": false}' where id = $1`, [ids.tenantA]);
    const f = await makeRx([{ drug: PCT, qty: 1 }]);
    const vf = await verify(f.rx);
    expect((await detail(f.rx)).body.dispenseMethod).toBe('FIFO');
    const r = await dispense(f.rx, vf, { lines: [{ prescriptionItemId: f.items[0], qty: 1 }] });
    expect([r.body.lines[0].batchNo, r.body.encounterStatus]).toEqual(['P-LATE', 'FINISHED']);
    await su(`update app.tenant set settings = settings - 'dispenseMethod' - 'pharmacyBeforeCashier' where id = $1`, [ids.tenantA]);

    const asApp = `set role clinicrme_app; select set_config('app.tenant_id', '${ids.tenantA}', false);`;
    await expect(su(`${asApp} update app.dispense_line set qty_base = 1 where dispense_id = '${r.body.dispenseId}'`)).rejects.toThrow(/permission denied/);
    await expect(su(`${asApp} delete from app.dispense where id = '${r.body.dispenseId}'`)).rejects.toThrow(/permission denied/);
    await su(`${asApp} update app.dispense_line set billing_status = 'BILLED' where dispense_id = '${r.body.dispenseId}'`);
    await expect(su(`${asApp} update app.prescription_item set qty_dispensed = 0 where id = '${f.items[0]}'`)).rejects.toThrow(/tidak dapat dikurangi/);
  });

  test('D08 konkurensi: penyerahan menunggu transaksi lain atas stok yang sama, lalu membaca saldo terbaru (422, bukan alokasi ganda); saldo = ledger', async () => {
    const [{ id: drugId }] = await su(`insert into app.drug_item(tenant_id, code, generic_name, dosage_form, base_uom_id, drug_class, ingredients)
      values ($1, 'IBU', 'Ibuprofen sintetis', 'Tablet', $2, 'BEBAS_TERBATAS', array['ibuprofen']) returning id`, [ids.tenantA, TAB]);
    await price(drugId, 700);
    await batch(drugId, 'I-1', 200, 10);
    const a = await makeRx([{ drug: drugId, qty: 10 }]);
    const va = await verify(a.rx);
    // Transaksi lain (mis. penyerahan di loket sebelah) sedang mengambil stok terakhir dan belum commit
    const other = new Client({ connectionString: ownerUrl() });
    await other.connect();
    try {
      await other.query('begin');
      await other.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`stock:${APOTEK}:${drugId}`]);
      await other.query(`insert into app.stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id)
                         values ($1, $2, $3, 'DISPENSE', -10, 'dispense', gen_random_uuid())`, [ids.tenantA, B['I-1'], APOTEK]);
      const pending = dispense(a.rx, va, { lines: [{ prescriptionItemId: a.items[0], qty: 10 }] }).then((r) => r);
      await new Promise((r) => setTimeout(r, 600));
      await other.query('commit');
      const r = await pending;
      expect([r.status, r.body.code]).toEqual([422, 'PHM-422-DISPENSE']);
      expect(r.body.errors[0].message).toMatch(/tidak cukup \(tersedia 0\)/);
    } finally { await other.end(); }
    // Dua penyerahan paralel atas stok yang tersisa: tepat satu berhasil
    await batch(drugId, 'I-2', 200, 10);
    const b1 = await makeRx([{ drug: drugId, qty: 10 }]);
    const b2 = await makeRx([{ drug: drugId, qty: 10 }]);
    const [v1, v2] = [await verify(b1.rx), await verify(b2.rx)];
    const [r1, r2] = await Promise.all([
      dispense(b1.rx, v1, { lines: [{ prescriptionItemId: b1.items[0], qty: 10 }] }),
      dispense(b2.rx, v2, { lines: [{ prescriptionItemId: b2.items[0], qty: 10 }] }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 422]);
    expect([await balance('I-1'), await balance('I-2')]).toEqual([0, 0]);
    const [{ neg }] = await su(`select count(*)::int as neg from app.stock_balance where qty_on_hand < 0`);
    expect(neg).toBe(0);
    const bad = await su(`select b.batch_id from app.stock_balance b left join (select batch_id, location_id, sum(qty) q from app.stock_movement group by 1, 2) m
                           using (batch_id, location_id) where b.qty_on_hand <> coalesce(m.q, 0)`);
    expect(bad).toEqual([]);
  });
});
