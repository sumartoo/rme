import 'reflect-metadata';
import { createHmac, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 11 batch 3 — QRIS (adapter + simulator), rekonsiliasi settlement, void & refund (BIL-FR-006, 009, 010, 012; OD-039, OD-041, OD-112 / DEC-042).
 * Data sintetis; kunci simulator diturunkan dari kunci enkripsi uji (sama seperti konfigurasi lokal).
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

let kasir: Jar, kasir2: Jar, manajer: Jar;
const SECRET = createHmac('sha256', 'a'.repeat(64)).update('payment-simulator').digest('hex');
let JAHIT: string, INSURER: string, BATCH: string;
type Inv = { id: string; version: number; status: string; patientPortion: string; payerPortion: string; netAmount: string; paidAmount: string; outstanding: string;
  payments: { id: string; receiptNo: string; method: string; amount: string; change: string | null; reference: string | null }[];
  refunds: { id: string; status: string; amount: string }[]; voids: { id: string; status: string }[];
  replaces: { id: string } | null; replacedBy: { id: string; status: string } | null; lines: { sourceType: string }[];
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
async function dispensed(enc: string) {
  const [{ id: rx }] = await su(`insert into app.prescription(tenant_id, prescription_no, encounter_id, prescriber_id) values ($1, $2, $3, $4) returning id`,
    [ids.tenantA, `RX-${randomUUID().slice(0, 8)}`, enc, DR]);
  const [{ id: item }] = await su(`insert into app.prescription_item(tenant_id, prescription_id, line_no, drug_item_id, frequency, route, qty, uom_id)
    values ($1, $2, 1, $3, '3x sehari', 'ORAL', 6, $4) returning id`, [ids.tenantA, rx, PCT, TAB]);
  await su(`update app.prescription set status = 'ISSUED', issued_at = now(), review_checklist = '{}' where id = $1`, [rx]);
  const [{ id: d }] = await su(`insert into app.dispense(tenant_id, prescription_id, location_id, dispensed_by) values ($1, $2, $3, $4) returning id`,
    [ids.tenantA, rx, LOC, ids.dokterA]);
  await su(`insert into app.dispense_line(tenant_id, dispense_id, prescription_item_id, batch_id, qty_base, drug_item_id, unit_price, item_qty)
    values ($1, $2, $3, $4, 6, $5, 500, 6)`, [ids.tenantA, d, item, BATCH, PCT]);
  await su(`update app.prescription_item set qty_dispensed = qty where id = $1`, [item]);
}
/** Callback simulator ber-signature ke host klinik. */
const callback = (body: Record<string, unknown>, opts: { host?: string; sig?: string } = {}) => {
  const raw = JSON.stringify(body);
  return http.post('/api/integrations/payment-gateway/callback').set('Host', opts.host ?? HOST).set('Content-Type', 'application/json')
    .set('X-Signature', opts.sig ?? createHmac('sha256', SECRET).update(raw).digest('hex')).send(raw);
};
const qris = (inv: string, body: Record<string, unknown> = {}, key = `qr-${randomUUID()}`) =>
  post(`/api/v1/invoices/${inv}/qris`, kasir).set('Idempotency-Key', key).send(body);
const refund = (body: Record<string, unknown>, j: Jar = kasir) => post('/api/v1/refunds', j).set('Idempotency-Key', `rf-${randomUUID()}`).send(body);
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
  // Manajer juga boleh mengajukan void/refund — untuk menguji larangan menyetujui pengajuan sendiri
  await su(`insert into app.role_permission(tenant_id, role_id, permission_code) select r.tenant_id, r.id, p from app.role r,
            unnest(array['billing.invoice.void.request', 'billing.refund.request', 'billing.shift.manage']) p where r.tenant_id = $1 and r.code = 'MANAJER'
            on conflict do nothing`, [ids.tenantA]);
  manajer = await login('manajer@a.test');
  expect((await post('/api/v1/cashier-shifts', kasir).send({ branchId: BRANCH, openingCash: 100000 })).status).toBe(201);
}, 60_000);
afterAll(async () => { await app?.close(); });


describe('QRIS dinamis & rekonsiliasi (BIL-FR-006, 012; OD-039)', () => {
  let paidRef: string, paidRef2: string, unrecordedRef: string;

  test('R01 QR dibuat lewat adapter (butuh shift); pembayaran tercatat hanya setelah callback ber-signature; callback ganda tidak mencatat ganda', async () => {
    const inv = await issued(await encounter({ procedures: 1 }));
    expect((await post(`/api/v1/invoices/${inv.id}/qris`, kasir2).set('Idempotency-Key', `qr-${randomUUID()}`).send({})).body.code).toBe('BIL-409-NO-SHIFT');
    expect((await qris(inv.id, { amount: 250000.01 })).body.code).toBe('BIL-409-OVERPAY');
    const key = `qr-${randomUUID()}`;
    const q1 = await qris(inv.id, {}, key);
    expect(q1.status).toBe(201);
    expect(q1.body).toMatchObject({ status: 'PENDING', amount: '250000.00', provider: 'SIMULATOR', simulator: true, paymentId: null, callbackCount: 0 });
    expect(q1.body.providerRef).toMatch(/^SIM-[0-9A-F]{20}$/);
    expect(q1.body.qrPayload).toContain('SIMULASI');
    expect((await qris(inv.id, {}, key)).body.id).toBe(q1.body.id);
    // QR baru membatalkan QR menunggu sebelumnya
    const q2 = (await qris(inv.id)).body;
    expect((await get(`/api/v1/qris/${q1.body.id}`, kasir)).body.status).toBe('CANCELLED');
    expect((await invoice(inv.id) as unknown as { pendingQrisId: string }).pendingQrisId).toBe(q2.id);
    const ev = { eventId: 'ev-1', providerRef: q2.providerRef, status: 'PAID', amount: 250000, paidAt: new Date().toISOString() };
    // Signature salah / tanpa signature / host tak dikenal → ditolak tanpa efek
    expect((await callback(ev, { sig: 'f'.repeat(64) })).body.code).toBe('BIL-401-SIGNATURE');
    expect((await callback(ev, { sig: 'bukan-hex' })).status).toBe(401);
    expect((await callback(ev, { host: 'tidak-ada.clinicrme.test' })).status).toBe(404);
    // Callback valid ke host klinik lain: transaksi milik klinik A tidak terlihat (RLS)
    expect((await callback(ev, { host: HOST_B })).body.code).toBe('BIL-404-QRIS');
    expect((await invoice(inv.id)).payments).toEqual([]);
    expect((await callback({ ...ev, amount: 1 })).body.code).toBe('BIL-409-QRIS-AMOUNT');
    const ok = await callback(ev);
    expect([ok.status, ok.body]).toEqual([200, { ok: true, recorded: true }]);
    const cur = await invoice(inv.id);
    expect(cur).toMatchObject({ status: 'PAID', paidAmount: '250000.00' });
    expect(cur.payments.map((p) => [p.method, p.amount, p.reference])).toEqual([['QRIS', '250000.00', q2.providerRef]]);
    expect((await callback(ev)).body).toEqual({ ok: true, duplicate: true });
    expect((await callback({ ...ev, eventId: 'ev-2' })).body).toEqual({ ok: true, duplicate: true });
    expect(await su(`select count(*)::int as n from app.payment where invoice_id = $1`, [inv.id])).toEqual([{ n: 1 }]);
    const t = (await get(`/api/v1/qris/${q2.id}`, kasir)).body;
    expect(t).toMatchObject({ status: 'PAID', callbackCount: 4, invoiceStatus: 'PAID' });
    expect(await su(`select action, actor_kind from app.audit_log where resource_id = $1 order by seq`, [q2.id])).toEqual([
      { action: 'QRIS_CREATED', actor_kind: 'USER' }, { action: 'QRIS_CALLBACK_REJECTED', actor_kind: 'SYSTEM' },
      { action: 'QRIS_CALLBACK_DUPLICATE', actor_kind: 'SYSTEM' }, { action: 'QRIS_CALLBACK_DUPLICATE', actor_kind: 'SYSTEM' }]);
    expect(await su(`select count(*)::int as n from app.audit_log where action = 'QRIS_CALLBACK_REJECTED' and change_summary->>'reason' = 'SIGNATURE'`)).toEqual([{ n: 2 }]);
    paidRef = q2.providerRef;
  });

  test('R02 kedaluwarsa, simulator bayar/gagal, dan uang masuk saat shift pembuat sudah ditutup (ditandai, tidak hilang)', async () => {
    const inv = await issued(await encounter());
    const q = (await qris(inv.id)).body;
    await su(`update app.payment_gateway_txn set expires_at = now() - interval '1 minute' where id = $1`, [q.id]);
    expect((await get(`/api/v1/qris/${q.id}`, kasir)).body.status).toBe('EXPIRED');
    const q2 = (await qris(inv.id)).body;
    const f = await post(`/api/v1/qris/${q2.id}/simulate`, kasir).send({ outcome: 'FAILED' });
    expect(f.body).toMatchObject({ status: 'FAILED', paymentId: null });
    const q3 = (await qris(inv.id)).body;
    const s = await post(`/api/v1/qris/${q3.id}/simulate`, kasir).send({ outcome: 'PAID' });
    expect(s.body).toMatchObject({ status: 'PAID', invoiceStatus: 'PAID' });
    expect(s.body.paymentId).toEqual(expect.any(String));
    paidRef2 = q3.providerRef;
    // Kasir 2 membuat QR lalu menutup shift sebelum pembeli membayar
    const inv2 = await issued(await encounter());
    const s2 = (await post('/api/v1/cashier-shifts', kasir2).send({ branchId: BRANCH, openingCash: 0 })).body;
    const q4 = (await post(`/api/v1/invoices/${inv2.id}/qris`, kasir2).set('Idempotency-Key', `qr-${randomUUID()}`).send({})).body;
    await post(`/api/v1/cashier-shifts/${s2.id}/close`, kasir2).send({ countedCash: 0 });
    const r = await callback({ eventId: 'ev-late', providerRef: q4.providerRef, status: 'PAID', amount: 50000 });
    expect(r.body).toEqual({ ok: true, recorded: false });
    expect((await get(`/api/v1/qris/${q4.id}`, kasir)).body).toMatchObject({ status: 'PAID', paymentId: null, invoiceStatus: 'ISSUED' });
    expect(await su(`select change_summary->>'reason' as r from app.audit_log where action = 'QRIS_PAID_UNRECORDED' and resource_id = $1`, [q4.id]))
      .toEqual([{ r: 'NO_OPEN_SHIFT' }]);
    unrecordedRef = q4.providerRef;
  });

  test('R03 rekonsiliasi harian: lunas tanpa settlement, settlement tanpa transaksi, nominal beda, lunas tanpa pembayaran', async () => {
    const [{ today }] = await su(`select to_char((now() at time zone 'Asia/Jakarta')::date, 'YYYY-MM-DD') as today`);
    const sim = (await get(`/api/v1/billing/qris-settlements/simulated?date=${today}`, manajer)).body.csv as string;
    expect(sim.split('\n')[0]).toBe('provider_ref,amount,settled_at');
    expect(sim).toContain(paidRef);
    expect(sim).toContain(unrecordedRef);
    expect((await get(`/api/v1/billing/qris-settlements/simulated?date=${today}`, kasir)).status).toBe(403);
    expect((await post('/api/v1/billing/qris-settlements', manajer).send({ settlementDate: today, csv: 'provider_ref,amount\nSIM-1,abc' })).body.code)
      .toBe('BIL-400-SETTLEMENT');
    // Settlement: paidRef cocok, paidRef2 nominal beda, unrecordedRef cocok, satu baris tak dikenal
    const csv = ['provider_ref,amount,settled_at', `${paidRef},250000,${new Date().toISOString()}`, `${paidRef2},49000,`, `${unrecordedRef},50000,`,
      'SIM-FFFFFFFFFFFFFFFFFFFF,12000,'].join('\n');
    const up = await post('/api/v1/billing/qris-settlements', manajer).send({ settlementDate: today, fileName: 'settlement.csv', csv });
    expect(up.body).toMatchObject({ lineCount: 4, matched: 3, total: '361000.00' });
    const rec = (await get(`/api/v1/billing/reconciliation/qris?date=${today}`, manajer)).body;
    expect(rec).toMatchObject({ paidCount: 3, paidTotal: '350000.00', settledCount: 4, settledTotal: '361000.00', batches: 1 });
    expect(rec.issues.map((x: { issue: string; providerRef: string }) => [x.issue, x.providerRef])).toEqual([
      ['AMOUNT_MISMATCH', paidRef2], ['PAID_WITHOUT_PAYMENT', unrecordedRef], ['SETTLED_NOT_PAID', 'SIM-FFFFFFFFFFFFFFFFFFFF']]);
    expect((await get('/api/v1/billing/reconciliation/qris?date=kemarin', manajer)).status).toBe(400);
    expect((await get(`/api/v1/billing/reconciliation/qris?date=${today}`, kasir)).status).toBe(403);
    // Tanpa settlement sama sekali → semua yang lunas "belum settle"
    const prev = (await get(`/api/v1/billing/reconciliation/qris?date=2026-01-01`, manajer)).body;
    expect(prev).toMatchObject({ paidCount: 0, issues: [] });
  });
});

describe('Void & refund (BIL-FR-009, 010; OD-041, OD-112)', () => {
  test('R04 void: hanya tagihan belum dibayar, maker–checker, pembayaran ditahan selama diajukan; disetujui → VOID, piutang batal, obat kembali belum ditagih, tagihan pengganti', async () => {
    const paid = await issued(await encounter());
    await pay(paid.id, { method: 'TUNAI', amount: 50000 });
    expect((await post(`/api/v1/invoices/${paid.id}/void-requests`, kasir).send({ reason: 'Salah pasien' })).body.code).toBe('BIL-409-VOID-PAID');
    const enc = await encounter({ payer: INSURER, procedures: 1 });
    await dispensed(enc);
    const inv = await issued(enc);
    expect(inv.receivable).toMatchObject({ status: 'OPEN' });
    expect(await su(`select distinct d.billing_status from app.dispense_line d join app.invoice_line l on l.id = d.invoice_line_id where l.invoice_id = $1`, [inv.id]))
      .toEqual([{ billing_status: 'BILLED' }]);
    expect((await post(`/api/v1/invoices/${inv.id}/void-requests`, kasir).send({ reason: 'abc' })).status).toBe(400);
    const v1 = await post(`/api/v1/invoices/${inv.id}/void-requests`, kasir).send({ reason: 'Tindakan salah input' });
    expect(v1.body).toMatchObject({ status: 'REQUESTED', invoiceStatus: 'ISSUED', mine: true, requestedByName: 'Kasir' });
    expect((await post(`/api/v1/invoices/${inv.id}/void-requests`, kasir).send({ reason: 'Tindakan salah input' })).body.code).toBe('BIL-409-VOID-PENDING');
    expect((await pay(inv.id, { method: 'TUNAI', amount: 1000 })).body.code).toBe('BIL-409-VOID-PENDING');
    expect((await qris(inv.id)).body.code).toBe('BIL-409-VOID-PENDING');
    expect((await post(`/api/v1/void-requests/${v1.body.id}/decision`, kasir).send({ decision: 'APPROVE' })).status).toBe(403);
    expect((await get('/api/v1/void-requests?status=REQUESTED', manajer)).body.map((x: { id: string }) => x.id)).toEqual([v1.body.id]);
    expect((await post(`/api/v1/void-requests/${v1.body.id}/decision`, manajer).send({ decision: 'REJECT' })).body.code).toBe('BIL-400-NOTE');
    const rj = await post(`/api/v1/void-requests/${v1.body.id}/decision`, manajer).send({ decision: 'REJECT', note: 'Tindakan benar, cek ulang' });
    expect(rj.body).toMatchObject({ status: 'REJECTED', approvedByName: 'Manajer', decisionNote: 'Tindakan benar, cek ulang' });
    expect((await post(`/api/v1/void-requests/${v1.body.id}/decision`, manajer).send({ decision: 'APPROVE' })).body.code).toBe('BIL-409-DECIDED');
    // Manajer mengajukan sendiri → tidak dapat menyetujui sendiri
    const v2 = (await post(`/api/v1/invoices/${inv.id}/void-requests`, manajer).send({ reason: 'Pasien batal tindakan' })).body;
    expect((await post(`/api/v1/void-requests/${v2.id}/decision`, manajer).send({ decision: 'APPROVE' })).body.code).toBe('BIL-403-SELF-APPROVAL');
    await su(`update app.invoice_void set status = 'REJECTED', approved_by = $2, decided_at = now(), decision_note = 'uji' where id = $1`, [v2.id, ids.kasirA]);
    const v3 = (await post(`/api/v1/invoices/${inv.id}/void-requests`, kasir).send({ reason: 'Pasien batal tindakan' })).body;
    const ap = await post(`/api/v1/void-requests/${v3.id}/decision`, manajer).send({ decision: 'APPROVE', note: 'Sesuai konfirmasi dokter' });
    expect(ap.body).toMatchObject({ status: 'APPROVED', invoiceStatus: 'VOID' });
    const old = await invoice(inv.id);
    expect(old).toMatchObject({ status: 'VOID', receivable: { status: 'VOID' }, replacedBy: null });
    expect(old.lines.length).toBeGreaterThan(0);
    expect(old.voids.map((v) => v.status)).toEqual(['REJECTED', 'REJECTED', 'APPROVED']);
    expect(await su(`select count(*)::int as n from app.dispense_line d join app.dispense ds on ds.id = d.dispense_id join app.prescription p on p.id = ds.prescription_id
                      where p.encounter_id = $1 and d.billing_status = 'UNBILLED' and d.invoice_line_id is null`, [enc])).toEqual([{ n: 1 }]);
    expect(await encStatus(enc)).toBe('BILLING');
    // Tagihan pengganti: kunjungan masih di kasir, obat ikut lagi, merujuk tagihan lama
    const rep = (await post(`/api/v1/billing/encounters/${enc}/invoice`, kasir).send()).body;
    expect(rep).toMatchObject({ kind: 'ENCOUNTER', status: 'DRAFT', replaces: { id: inv.id } });
    expect(rep.lines.map((l: { sourceType: string }) => l.sourceType)).toContain('OBAT');
    expect((await invoice(inv.id)).replacedBy).toMatchObject({ id: rep.id, status: 'DRAFT' });
    expect(await su(`select action from app.audit_log where resource_id = $1 and action like 'INVOICE_VOID%' order by seq`, [inv.id])).toEqual([
      { action: 'INVOICE_VOID_REQUESTED' }, { action: 'INVOICE_VOID_REJECTED' }, { action: 'INVOICE_VOID_REQUESTED' }, { action: 'INVOICE_VOID_REQUESTED' },
      { action: 'INVOICE_VOIDED' }]);
    await expect(su(`update app.invoice_void set reason = 'ubah' where id = $1`, [v3.id])).rejects.toThrow(/IMMUTABLE/);
  });

  test('R05 refund: batas per pembayaran, maker–checker, tunai dari kas shift, non-tunai sebagai transfer; status tagihan dihitung ulang, pembayaran asal utuh', async () => {
    const inv = await issued(await encounter({ procedures: 1 }));
    const cash = (await pay(inv.id, { method: 'TUNAI', amount: 100000 })).body;
    const debit = (await pay(inv.id, { method: 'DEBIT', amount: 150000, reference: 'EDC-1' })).body;
    expect(debit.invoiceStatus).toBe('PAID');
    const before = (await get('/api/v1/cashier-shifts/current', kasir)).body.shift.expectedCash;
    expect((await refund({ paymentId: cash.id, amount: 100000.01, reason: 'Kelebihan bayar' })).body.code).toBe('BIL-409-REFUND-EXCEEDS');
    expect((await refund({ paymentId: cash.id, amount: 1000, reason: 'abc' })).status).toBe(400);
    expect((await post('/api/v1/refunds', kasir).send({ paymentId: cash.id, amount: 1000, reason: 'Kelebihan bayar' })).body.code).toBe('GEN-400-IDEMPOTENCY-KEY');
    const r1 = await refund({ paymentId: cash.id, amount: 30000, reason: 'Tindakan dibatalkan sebagian' });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ status: 'REQUESTED', method: 'TUNAI', amount: '30000.00', receiptNo: cash.receiptNo, mine: true });
    expect(r1.body.refundNo).toMatch(/^RF\d{6}\d{5}$/);
    expect((await refund({ paymentId: cash.id, amount: 80000, reason: 'Kelebihan bayar' })).body.code).toBe('BIL-409-REFUND-EXCEEDS');
    expect((await refund({ paymentId: debit.id, amount: 10000, reason: 'Kelebihan bayar' })).body.code).toBe('BIL-400-REFERENCE');
    const r2 = (await refund({ paymentId: debit.id, amount: 10000, reason: 'Kelebihan bayar', reference: 'BCA 1234567890 a.n. Pasien' })).body;
    expect(r2).toMatchObject({ method: 'TRANSFER', reference: 'BCA 1234567890 a.n. Pasien' });
    expect((await post(`/api/v1/refunds/${r1.body.id}/decision`, kasir).send({ decision: 'APPROVE' })).status).toBe(403);
    const own = (await refund({ paymentId: debit.id, amount: 5000, reason: 'Uji maker-checker', reference: 'TRF-9' }, manajer)).body;
    expect((await post(`/api/v1/refunds/${own.id}/decision`, manajer).send({ decision: 'APPROVE' })).body.code).toBe('BIL-403-SELF-APPROVAL');
    expect((await get('/api/v1/refunds?status=REQUESTED', manajer)).body.map((x: { id: string }) => x.id).sort()).toEqual([r1.body.id, r2.id, own.id].sort());
    const a1 = await post(`/api/v1/refunds/${r1.body.id}/decision`, manajer).send({ decision: 'APPROVE' });
    expect(a1.body).toMatchObject({ status: 'APPROVED', approvedByName: 'Manajer' });
    let cur = await invoice(inv.id);
    expect(cur).toMatchObject({ status: 'PARTIALLY_PAID', paidAmount: '220000.00', outstanding: '30000.00' });
    expect(cur.payments.map((p) => p.amount)).toEqual(['100000.00', '150000.00']);
    expect((await get('/api/v1/cashier-shifts/current', kasir)).body.shift).toMatchObject({ cashRefunds: '30000.00',
      expectedCash: (Number(before) - 30000).toFixed(2) });
    expect((await post(`/api/v1/refunds/${r2.id}/decision`, manajer).send({ decision: 'REJECT' })).body.code).toBe('BIL-400-NOTE');
    expect((await post(`/api/v1/refunds/${r2.id}/decision`, manajer).send({ decision: 'REJECT', note: 'Tidak ada kelebihan bayar' })).body.status).toBe('REJECTED');
    // Pasien membayar lagi sisa 30.000 → lunas kembali
    expect((await pay(inv.id, { method: 'TUNAI', amount: 30000 })).body.invoiceStatus).toBe('PAID');
    // Refund tunai yang shift pengajunya sudah ditutup tidak dapat disetujui
    const r3 = (await refund({ paymentId: cash.id, amount: 1000, reason: 'Uji shift ditutup' })).body;
    const sh = (await get('/api/v1/cashier-shifts/current', kasir)).body.shift;
    await post(`/api/v1/cashier-shifts/${sh.id}/close`, kasir).send({ countedCash: Number(sh.expectedCash) });
    expect((await post(`/api/v1/refunds/${r3.id}/decision`, manajer).send({ decision: 'APPROVE' })).body.code).toBe('BIL-409-SHIFT-CLOSED');
    expect((await refund({ paymentId: cash.id, amount: 1000, reason: 'Tanpa shift terbuka' })).body.code).toBe('BIL-409-NO-SHIFT');
    await expect(su(`update app.refund set amount = 1 where id = $1`, [r1.body.id])).rejects.toThrow(/IMMUTABLE/);
    cur = await invoice(inv.id);
    expect(cur.refunds.map((r) => [r.amount, r.status])).toEqual([['30000.00', 'APPROVED'], ['10000.00', 'REJECTED'], ['5000.00', 'REQUESTED'], ['1000.00', 'REQUESTED']]);
  });

  test('R06 invarian kasir: untuk setiap tagihan, terbayar = Σ pembayaran − Σ refund disetujui', async () => {
    const bad = await su(`
      select i.id, i.paid_amount, coalesce(p.s, 0) - coalesce(r.s, 0) as calc from app.invoice i
        left join (select invoice_id, sum(amount) s from app.payment group by 1) p on p.invoice_id = i.id
        left join (select p.invoice_id, sum(r.amount) s from app.refund r join app.payment p on p.id = r.payment_id where r.status = 'APPROVED' group by 1) r on r.invoice_id = i.id
       where i.status <> 'DRAFT' and i.paid_amount <> coalesce(p.s, 0) - coalesce(r.s, 0)`);
    expect(bad).toEqual([]);
    expect(await su(`select count(*)::int as n from app.invoice where status <> 'DRAFT'`)).not.toEqual([{ n: 0 }]);
  });
});
