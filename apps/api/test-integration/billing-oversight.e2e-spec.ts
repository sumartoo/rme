import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 11 batch 4 — pelunasan piutang, verifikasi & penutupan shift oleh manajer, transaksi tidak wajar, invarian gate
 * (BIL-FR-011, 013, 016; OD-041, OD-108, OD-111 / DEC-042). Data sintetis.
 */
const HOST = 'klinik-a.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const BRANCH = A(10), UNIT = A(11), DR = A(20), PATIENT = A(60), KONS = A(31), KASIR2 = A(45);
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
const put = (path: string, j: Jar, version?: number) => {
  const r = http.put(path).set('Host', j.host).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
  return version === undefined ? r : r.set('If-Match', String(version));
};
const post = (path: string, j: Jar, version?: number) => {
  const r = http.post(path).set('Host', j.host).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
  return version === undefined ? r : r.set('If-Match', String(version));
};
/** Pembayaran: Idempotency-Key unik per percobaan kecuali diberikan. */
const pay = (inv: string, body: Record<string, unknown>, j: Jar = kasir, key = `pay-${randomUUID()}`) =>
  post(`/api/v1/invoices/${inv}/payments`, j).set('Idempotency-Key', key).send(body);

let kasir: Jar, kasir2: Jar, manajer: Jar, admin: Jar;
let JAHIT: string, INSURER: string;
type Inv = { id: string; invoiceNo: string; version: number; status: string; patientPortion: string; payerPortion: string; netAmount: string; paidAmount: string; outstanding: string;
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
const qris = (inv: string, body: Record<string, unknown> = {}, key = `qr-${randomUUID()}`) =>
  post(`/api/v1/invoices/${inv}/qris`, kasir).set('Idempotency-Key', key).send(body);
const refund = (body: Record<string, unknown>, j: Jar = kasir) => post('/api/v1/refunds', j).set('Idempotency-Key', `rf-${randomUUID()}`).send(body);

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
  // Kasir kedua (role KASIR bawaan) untuk uji kepemilikan shift
  await su(`insert into app.app_user(id, tenant_id, email, full_name) values ($1, $2, 'kasir2@a.test', 'Kasir Dua')`, [KASIR2, ids.tenantA]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and code = 'KASIR'`, [ids.tenantA, KASIR2]);
  await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select tenant_id, $2, password_hash from app.user_credential where user_id = $1`, [ids.kasirA, KASIR2]);
  // Seed uji membuka satu shift untuk kasir; mulai dari keadaan tanpa shift terbuka
  await su(`update app.cashier_shift set status = 'CLOSED', closed_at = now(), counted_cash = opening_cash, expected_cash = opening_cash where tenant_id = $1`, [ids.tenantA]);
  kasir = await login('kasir@a.test');
  kasir2 = await login('kasir2@a.test');
  manajer = await login('manajer@a.test');
  admin = await login('admin@a.test');
  // Manajer juga boleh mengajukan void/refund — untuk menguji larangan menyetujui pengajuan sendiri
  await su(`insert into app.role_permission(tenant_id, role_id, permission_code) select r.tenant_id, r.id, p from app.role r,
            unnest(array['billing.invoice.void.request', 'billing.refund.request', 'billing.shift.manage', 'billing.invoice.issue', 'billing.payment.create']) p where r.tenant_id = $1 and r.code = 'MANAJER'
            on conflict do nothing`, [ids.tenantA]);
  manajer = await login('manajer@a.test');
  admin = await login('admin@a.test');
  expect((await post('/api/v1/cashier-shifts', kasir).send({ branchId: BRANCH, openingCash: 100000 })).status).toBe(201);
}, 60_000);
afterAll(async () => { await app?.close(); });



const rpay = (id: string, body: Record<string, unknown>, j: Jar = manajer, key = `rp-${randomUUID()}`) =>
  post(`/api/v1/receivables/${id}/payments`, j).set('Idempotency-Key', key).send(body);
const todayLocal = async () => (await su(`select to_char((now() at time zone 'Asia/Jakarta')::date, 'YYYY-MM-DD') as d`))[0].d as string;

describe('Piutang penjamin (BIL-FR-013, OD-108)', () => {
  test('H01 pelunasan sebagian/penuh mengurangi saldo; idempoten; tidak melebihi saldo / tanggal masa depan; piutang terbayar memblokir void', async () => {
    const inv = await issued(await encounter({ payer: INSURER, procedures: 1 }));
    const rcvId = (await su(`select id from app.receivable where invoice_id = $1`, [inv.id]))[0].id as string;
    const r0 = (await get(`/api/v1/receivables/${rcvId}`, kasir)).body;
    expect(r0).toMatchObject({ amount: '200000.00', paidAmount: '0.00', balance: '200000.00', status: 'OPEN', payerName: 'Asuransi Sintetis', payments: [] });
    const today = await todayLocal();
    const ok = { amount: 50000, paidOn: today, method: 'TRANSFER', reference: 'TRF-ASR-001' };
    expect((await rpay(rcvId, ok, kasir)).status).toBe(403);
    expect((await rpay(rcvId, { ...ok, paidOn: '2999-01-01' })).body.code).toBe('BIL-400-DATE');
    expect((await rpay(rcvId, { ...ok, amount: 200000.01 })).body.code).toBe('BIL-409-OVERPAY');
    expect((await rpay(rcvId, { ...ok, reference: 'x' })).status).toBe(400);
    expect((await post(`/api/v1/receivables/${rcvId}/payments`, manajer).send(ok)).body.code).toBe('GEN-400-IDEMPOTENCY-KEY');
    const key = `rp-${randomUUID()}`;
    const p1 = await rpay(rcvId, ok, manajer, key);
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ paidAmount: '50000.00', balance: '150000.00', status: 'PARTIAL' });
    expect((await rpay(rcvId, ok, manajer, key)).body.payments).toHaveLength(1);
    // Piutang sudah dibayar sebagian → tagihan tidak dapat di-void
    expect((await post(`/api/v1/invoices/${inv.id}/void-requests`, kasir).send({ reason: 'Uji void piutang terbayar' })).body.code).toBe('BIL-409-VOID-PAID');
    const p2 = await rpay(rcvId, { ...ok, amount: 150000, method: 'GIRO', reference: 'GIRO-778', note: 'Pelunasan klaim Okt' });
    expect(p2.body).toMatchObject({ paidAmount: '200000.00', balance: '0.00', status: 'PAID' });
    expect(p2.body.payments.map((x: { method: string; amount: string; recordedByName: string }) => [x.method, x.amount, x.recordedByName]))
      .toEqual([['TRANSFER', '50000.00', 'Manajer'], ['GIRO', '150000.00', 'Manajer']]);
    expect((await rpay(rcvId, { ...ok, amount: 1 })).body.code).toBe('BIL-409-RECEIVABLE-CLOSED');
    expect((await get('/api/v1/receivables?status=PAID', manajer)).body.map((x: { id: string }) => x.id)).toContain(rcvId);
    expect(await su(`select has_table_privilege('clinicrme_app', 'app.receivable_payment', 'UPDATE') as u,
                            has_table_privilege('clinicrme_app', 'app.receivable_payment', 'DELETE') as d`)).toEqual([{ u: false, d: false }]);
    expect(await su(`select action, change_summary->>'status' as s from app.audit_log where resource_id = $1 order by seq`, [rcvId]))
      .toEqual([{ action: 'RECEIVABLE_PAYMENT_RECORDED', s: 'PARTIAL' }, { action: 'RECEIVABLE_PAYMENT_RECORDED', s: 'PAID' }]);
  });
});

describe('Shift: penutupan & verifikasi manajer (OD-111)', () => {
  test('H02 manajer menutup shift lupa ditutup (tercatat) dan memverifikasi (≠ kasir; selisih wajib catatan); shift terverifikasi tidak berubah', async () => {
    const s = (await post('/api/v1/cashier-shifts', kasir2).send({ branchId: BRANCH, openingCash: 200000 })).body;
    const inv = await issued(await encounter());
    await pay(inv.id, { method: 'TUNAI', amount: 50000 }, kasir2);
    expect((await post(`/api/v1/cashier-shifts/${s.id}/verify`, manajer).send({})).body.code).toBe('BIL-409-SHIFT-STATE');
    expect((await post(`/api/v1/cashier-shifts/${s.id}/force-close`, kasir).send({ countedCash: 1, note: 'tidak berhak' })).status).toBe(403);
    expect((await post(`/api/v1/cashier-shifts/${s.id}/force-close`, manajer).send({ countedCash: 230000, note: 'lupa' })).status).toBe(400);
    const fc = await post(`/api/v1/cashier-shifts/${s.id}/force-close`, manajer).send({ countedCash: 230000, note: 'Kasir pulang tanpa tutup shift' });
    expect(fc.body).toMatchObject({ status: 'CLOSED', forceClosed: true, closedByName: 'Manajer', expectedCash: '250000.00', countedCash: '230000.00',
      variance: '-20000.00', varianceNote: 'Kasir pulang tanpa tutup shift' });
    expect((await post(`/api/v1/cashier-shifts/${s.id}/force-close`, manajer).send({ countedCash: 1, note: 'kedua kali' })).body.code).toBe('BIL-409-SHIFT-CLOSED');
    expect((await post(`/api/v1/cashier-shifts/${s.id}/verify`, kasir).send({})).status).toBe(403);
    expect((await post(`/api/v1/cashier-shifts/${s.id}/verify`, manajer).send({})).body.code).toBe('BIL-400-NOTE');
    const v = await post(`/api/v1/cashier-shifts/${s.id}/verify`, manajer).send({ note: 'Selisih diganti kasir esok hari' });
    expect(v.body).toMatchObject({ status: 'VERIFIED', verifiedByName: 'Manajer', verifyNote: 'Selisih diganti kasir esok hari' });
    expect((await post(`/api/v1/cashier-shifts/${s.id}/verify`, manajer).send({ note: 'lagi lagi' })).body.code).toBe('BIL-409-SHIFT-STATE');
    await expect(su(`update app.cashier_shift set variance_note = 'ubah' where id = $1`, [s.id])).rejects.toThrow(/IMMUTABLE/);
    const list = (await get('/api/v1/cashier-shifts?status=VERIFIED', manajer)).body as { id: string; overTolerance: boolean }[];
    expect(list.find((x) => x.id === s.id)).toMatchObject({ overTolerance: true });
    expect((await get('/api/v1/cashier-shifts', kasir)).status).toBe(403);
    // Manajer tidak dapat memverifikasi shift miliknya sendiri; shift sendiri ditutup lewat tutup biasa
    const own = (await post('/api/v1/cashier-shifts', manajer).send({ branchId: BRANCH, openingCash: 0 })).body;
    expect((await post(`/api/v1/cashier-shifts/${own.id}/force-close`, manajer).send({ countedCash: 0, note: 'shift sendiri' })).body.code).toBe('BIL-409-SHIFT-OWN');
    await post(`/api/v1/cashier-shifts/${own.id}/close`, manajer).send({ countedCash: 0 });
    expect((await post(`/api/v1/cashier-shifts/${own.id}/verify`, manajer).send({})).body.code).toBe('BIL-403-SELF-APPROVAL');
    expect(await su(`select action from app.audit_log where resource_id = $1 order by seq`, [s.id]))
      .toEqual([{ action: 'SHIFT_OPENED' }, { action: 'SHIFT_FORCE_CLOSED' }, { action: 'SHIFT_VERIFIED' }]);
  });
});

describe('Transaksi tidak wajar (BIL-FR-016, OD-041)', () => {
  test('H03 enam aturan menandai transaksi sesuai ambang Profil klinik; ekspor CSV; hanya pemegang report.finance.audit', async () => {
    // Jam operasional dibuat tidak mencakup "sekarang" agar void/refund uji jatuh di luar jam
    const [{ s, e }] = await su(`select to_char((now() at time zone 'Asia/Jakarta') + interval '1 hour', 'HH24:MI') as s,
                                        to_char((now() at time zone 'Asia/Jakarta') + interval '2 hours', 'HH24:MI') as e`);
    await su(`update app.tenant set settings = settings || jsonb_build_object('billingHoursStart', $2::text, 'billingHoursEnd', $3::text,
              'voidsPerShiftLimit', 1, 'cashVarianceTolerance', 10000) where id = $1`, [ids.tenantA, s, e]);
    // Dua void oleh kasir dalam shift yang sama (batas 1) → 2× di luar jam + 1× per shift
    for (const reason of ['Salah input layanan', 'Pasien batal berobat']) {
      const inv = await issued(await encounter());
      const v = (await post(`/api/v1/invoices/${inv.id}/void-requests`, kasir).send({ reason })).body;
      await post(`/api/v1/void-requests/${v.id}/decision`, manajer).send({ decision: 'APPROVE' });
    }
    // Refund di luar jam
    const inv2 = await issued(await encounter());
    const cash = (await pay(inv2.id, { method: 'TUNAI', amount: 50000 })).body;
    await refund({ paymentId: cash.id, amount: 5000, reason: 'Kelebihan bayar uji' });
    // Diskon di atas batas (10%) yang disetujui
    const enc = await encounter({ procedures: 1 });
    let d = (await post(`/api/v1/billing/encounters/${enc}/invoice`, kasir).send()).body;
    const tl = d.lines.find((l: { sourceType: string }) => l.sourceType === 'TINDAKAN');
    d = (await put(`/api/v1/invoices/${d.id}/lines/${tl.id}`, kasir, d.version).send({ discountAmount: 60000, discountReason: 'Keringanan sosial' })).body;
    d = (await post(`/api/v1/invoices/${d.id}/lines/${tl.id}/discount-decision`, manajer).send({ decision: 'APPROVE' })).body;
    await post(`/api/v1/invoices/${d.id}/issue`, kasir, d.version).send();
    // Tunai dibayar saat QR masih menunggu, lalu callback QRIS tetap masuk → kelebihan bayar
    const inv3 = await issued(await encounter());
    const q = (await qris(inv3.id)).body;
    await pay(inv3.id, { method: 'TUNAI', amount: 50000 });
    expect((await post(`/api/v1/qris/${q.id}/simulate`, kasir).send({ outcome: 'PAID' })).body).toMatchObject({ status: 'PAID', invoiceStatus: 'PAID' });
    expect(await su(`select change_summary->>'overpaid' as o from app.audit_log where action = 'PAYMENT_RECORDED' and change_summary->>'method' = 'QRIS'
                      and change_summary->>'invoiceNo' = $1`, [inv3.invoiceNo])).toEqual([{ o: 'true' }]);

    const today = await todayLocal();
    const r = await get(`/api/v1/reports/anomalies?from=${today}&to=${today}`, manajer);
    expect(r.status).toBe(200);
    expect(r.body.thresholds).toEqual({ billingHoursStart: s, billingHoursEnd: e, voidsPerShiftLimit: 1, cashVarianceTolerance: 10000 });
    expect(r.body.counts).toEqual({ VOID_OUTSIDE_HOURS: 2, REFUND_OUTSIDE_HOURS: 1, DISCOUNT_OVER_LIMIT: 1, VOIDS_PER_SHIFT: 1, CASH_VARIANCE: 1, CASH_AFTER_QRIS: 1 });
    const by = (rule: string) => r.body.items.filter((x: { rule: string }) => x.rule === rule);
    expect(by('VOIDS_PER_SHIFT')[0]).toMatchObject({ userName: 'Kasir', detail: '2 pengajuan void dalam satu shift (batas 1)' });
    expect(by('CASH_VARIANCE')[0]).toMatchObject({ userName: 'Kasir Dua', amount: '-20000.00' });
    expect(by('DISCOUNT_OVER_LIMIT')[0].detail).toContain('disetujui Manajer');
    expect(by('CASH_AFTER_QRIS')[0]).toMatchObject({ invoiceNo: inv3.invoiceNo, amount: '50000.00' });
    // Ambang dinaikkan → tanda hilang (tanda, bukan blokir)
    await su(`update app.tenant set settings = settings || '{"voidsPerShiftLimit": 5, "cashVarianceTolerance": 50000}' where id = $1`, [ids.tenantA]);
    const r2 = (await get(`/api/v1/reports/anomalies?from=${today}&to=${today}`, manajer)).body;
    expect([r2.counts.VOIDS_PER_SHIFT, r2.counts.CASH_VARIANCE]).toEqual([0, 0]);
    const csv = await get(`/api/v1/reports/anomalies?from=${today}&to=${today}&format=csv`, manajer);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.text.replace(/^\uFEFF/, '').split('\n')[0]).toBe('jenis,waktu,cabang,petugas,tagihan,nominal,keterangan');
    expect(csv.text).toContain('Bayar tunai + QRIS melebihi tagihan');
    expect((await get(`/api/v1/reports/anomalies?from=${today}&to=${today}`, kasir)).status).toBe(403);
    expect((await get('/api/v1/reports/anomalies?from=2026-02-01&to=2026-01-01', manajer)).status).toBe(400);
    expect((await get('/api/v1/reports/anomalies?from=2026-01-01&to=2026-06-01', manajer)).status).toBe(400);
    expect((await get('/api/v1/reports/anomalies?from=2026-01-01&to=2026-01-31', manajer)).body.items).toEqual([]);
  });

  test('H04 ambang anomali di Profil klinik tervalidasi', async () => {
    const cur = await get('/api/v1/tenant/profile', admin);
    const body = { displayName: cur.body.displayName, settings: { ...cur.body.settings, billingHoursStart: '25:00' } };
    expect((await put('/api/v1/tenant/profile', admin).set('If-Match', cur.headers.etag).send(body)).status).toBe(400);
    expect((await put('/api/v1/tenant/profile', admin).set('If-Match', cur.headers.etag).send({ ...body, settings: { ...cur.body.settings, voidsPerShiftLimit: 0 } })).status).toBe(400);
    const ok = await put('/api/v1/tenant/profile', admin).set('If-Match', cur.headers.etag)
      .send({ ...body, settings: { ...cur.body.settings, billingHoursStart: '07:30', billingHoursEnd: '20:00', voidsPerShiftLimit: 4, cashVarianceTolerance: 5000 } });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toMatchObject({ billingHoursStart: '07:30', billingHoursEnd: '20:00', voidsPerShiftLimit: 4, cashVarianceTolerance: 5000 });
  });
});

describe('Invarian gate Stage 11', () => {
  test('H05 terbayar = Σ pembayaran − Σ refund disetujui; porsi penjamin = piutang (void → batal); saldo piutang = nominal − Σ pelunasan', async () => {
    expect(await su(`
      select i.id from app.invoice i
        left join (select invoice_id, sum(amount) s from app.payment group by 1) p on p.invoice_id = i.id
        left join (select p.invoice_id, sum(r.amount) s from app.refund r join app.payment p on p.id = r.payment_id where r.status = 'APPROVED' group by 1) r on r.invoice_id = i.id
       where i.status <> 'DRAFT' and i.paid_amount <> coalesce(p.s, 0) - coalesce(r.s, 0)`)).toEqual([]);
    expect(await su(`
      select i.id from app.invoice i left join app.receivable r on r.invoice_id = i.id
       where i.status not in ('DRAFT', 'VOID') and i.payer_portion > 0 and (r.id is null or r.amount <> i.payer_portion or r.status = 'VOID')`)).toEqual([]);
    expect(await su(`select i.id from app.invoice i join app.receivable r on r.invoice_id = i.id where i.status = 'VOID' and r.status <> 'VOID'`)).toEqual([]);
    expect(await su(`
      select r.id from app.receivable r left join (select receivable_id, sum(amount) s from app.receivable_payment group by 1) p on p.receivable_id = r.id
       where r.paid_amount <> coalesce(p.s, 0)`)).toEqual([]);
    expect(await su(`select count(*)::int as n from app.receivable where status = 'PAID'`)).not.toEqual([{ n: 0 }]);
  });
});
