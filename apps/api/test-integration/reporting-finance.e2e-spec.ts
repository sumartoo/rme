import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 14 batch 2 — pendapatan (RPT-FR-003), closing kasir (RPT-FR-004), umur piutang (RPT-FR-007); OD-126, OD-127 (DEC-047).
 * Dataset uji kecil; setiap angka dibandingkan dengan hitungan manual di komentar. Data sintetis.
 */
const HOST = 'klinik-a.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const FACILITY = A(1), B1 = A(10), U1 = A(11), DR = A(20), PCT = A(41);
const B2 = A(810), U2 = A(811), S1 = A(820), S2 = A(821), PAYER1 = A(830), PAYER2 = A(831);
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
let manajer: Jar, kasir: Jar, admin: Jar;

let seq = 0;
async function encounter(branch: string, unit: string, payer: string | null, at: string) {
  const n = ++seq;
  const [{ id: pid }] = await su(`insert into app.patient(tenant_id, mrn, full_name, birth_date, sex, identity_type) values ($1, $2, $3, '1990-01-01', 'L', 'TANPA_IDENTITAS') returning id`,
    [ids.tenantA, `RM-F-${n}`, `Pasien Keuangan ${n}`]);
  let cov: string | null = null;
  if (payer) [{ id: cov }] = await su(`insert into app.patient_coverage(tenant_id, patient_id, payer_id, member_no) values ($1, $2, $3, $4) returning id`, [ids.tenantA, pid, payer, `M-${n}`]);
  const [{ id }] = await su(`insert into app.encounter(tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, arrival_type, status, arrived_at,
      coverage_id, payer_type, coverage_verified_at) values ($1, $2, $3, $4, $5, $6, 'WALK_IN', 'FINISHED', $7::timestamptz, $8, $9, $10) returning id`,
  [ids.tenantA, `KJ-F-${n}`, pid, branch, unit, DR, at, cov, payer ? 'ASURANSI' : 'UMUM', payer ? at : null]);
  return { id: id as string, patient: pid as string, coverage: cov };
}
interface Line { type: string; service?: string; drug?: string; desc: string; qty: number; price: number; discount?: number; payer?: number }
/** Tagihan dibuat DRAFT, baris ditambahkan, lalu diterbitkan (isi terkunci sesudahnya). */
async function invoice(branch: string, unit: string, payer: string | null, issuedAt: string, lines: Line[], o: { status?: string; due?: string } = {}) {
  const e = await encounter(branch, unit, payer, issuedAt);
  const n = ++seq;
  const [{ id }] = await su(`insert into app.invoice(tenant_id, branch_id, patient_id, encounter_id, kind, payer_type, payer_id, coverage_id)
    values ($1, $2, $3, $4, 'ENCOUNTER', $5, $6, $7) returning id`, [ids.tenantA, branch, e.patient, e.id, payer ? 'ASURANSI' : 'UMUM', payer, e.coverage]);
  let gross = 0, disc = 0, payerTotal = 0;
  for (const [i, l] of lines.entries()) {
    const g = Math.round(l.qty * l.price * 100) / 100, d = l.discount ?? 0, total = g - d, p = l.payer ?? 0;
    gross += g; disc += d; payerTotal += p;
    await su(`insert into app.invoice_line(tenant_id, invoice_id, line_no, source_type, description, qty, unit_price, discount_amount, line_total, payer_portion, patient_portion,
        service_item_id, drug_item_id, discount_reason, discount_status)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [ids.tenantA, id, i + 1, l.type, l.desc, l.qty, l.price, d, total, p, total - p, l.service ?? null, l.drug ?? null, d ? 'Diskon uji' : null, d ? 'WITHIN_LIMIT' : 'NONE']);
  }
  const net = gross - disc;
  if (o.status === 'DRAFT') return { id: id as string, net };
  await su(`update app.invoice set status = 'ISSUED', invoice_no = $2, issued_at = $3::timestamptz, gross_amount = $4, discount_amount = $5, net_amount = $6,
      payer_portion = $7, patient_portion = $8, issued_by = $9 where id = $1`, [id, `INV-F-${n}`, issuedAt, gross, disc, net, payerTotal, net - payerTotal, ids.kasirA]);
  if (payerTotal > 0) {
    await su(`insert into app.receivable(tenant_id, invoice_id, payer_id, amount, due_date) values ($1, $2, $3, $4, $5)`, [ids.tenantA, id, payer, payerTotal, o.due]);
  }
  if (o.status === 'VOID') await su(`update app.invoice set status = 'VOID' where id = $1`, [id]);
  return { id: id as string, net };
}
async function shift(branch: string, cashier: string, openedAt: string, opening: number) {
  const [{ id }] = await su(`insert into app.cashier_shift(tenant_id, branch_id, cashier_id, opened_at, opening_cash) values ($1, $2, $3, $4::timestamptz, $5) returning id`,
    [ids.tenantA, branch, cashier, openedAt, opening]);
  return id as string;
}
async function pay(invoiceId: string, shiftId: string, method: string, amount: number, at: string) {
  const n = ++seq;
  // Trigger shift memakai search_path aplikasi (app) — diset lokal untuk transaksi ini
  const [{ id }] = await su(`with sp as (select set_config('search_path', 'app, public', true))
    insert into app.payment(tenant_id, receipt_no, invoice_id, shift_id, method, amount, reference, idempotency_key, received_by, received_at)
    select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz from sp returning id`,
  [ids.tenantA, `KW-F-${n}`, invoiceId, shiftId, method, amount, method === 'TUNAI' ? null : `REF-${n}`, `idem-f-${n}`, ids.kasirA, at]);
  return id as string;
}

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  await su(`update app.role set requires_mfa = false where code in ('MANAJER', 'KASIR', 'TENANT_ADMIN')`);
  await su(`insert into app.branch(id, tenant_id, facility_id, code, name, timezone) values ($1, $2, $3, 'CBG2', 'Cabang Timur', 'Asia/Makassar')`, [B2, ids.tenantA, FACILITY]);
  await su(`insert into app.service_unit(id, tenant_id, branch_id, code, name, unit_type) values ($1, $2, $3, 'UMUM2', 'Poli Umum Timur', 'POLI')`, [U2, ids.tenantA, B2]);
  await su(`insert into app.service_item(id, tenant_id, code, name, service_type) values ($1, $2, 'RPT-KONS', 'Konsultasi dokter umum', 'KONSULTASI'), ($3, $2, 'RPT-TND', 'Rawat luka', 'TINDAKAN')`,
    [S1, ids.tenantA, S2]);
  await su(`insert into app.payer(id, tenant_id, code, name, payer_type) values ($1, $2, 'RPT-ASR1', 'Asuransi Sehat', 'ASURANSI'), ($3, $2, 'RPT-ASR2', 'Asuransi Prima', 'ASURANSI')`,
    [PAYER1, ids.tenantA, PAYER2]);
  manajer = await login('manajer@a.test');
  kasir = await login('kasir@a.test');
  admin = await login('admin@a.test');

  // INV1 (B1, umum) 5 Okt: konsultasi 100.000 + obat 10 × 1.000 diskon 2.000 → neto 108.000
  const inv1 = await invoice(B1, U1, null, '2026-10-05T10:00:00+07:00', [
    { type: 'KONSULTASI', service: S1, desc: 'Konsultasi', qty: 1, price: 100000 },
    { type: 'OBAT', drug: PCT, desc: 'Parasetamol', qty: 10, price: 1000, discount: 2000 }]);
  // INV2 (B1, asuransi) 5 Okt 23.30 WIB: tindakan 200.000, penjamin 150.000 (jatuh tempo 20 Okt), pasien 50.000
  const inv2 = await invoice(B1, U1, PAYER1, '2026-10-05T23:30:00+07:00', [{ type: 'TINDAKAN', service: S2, desc: 'Rawat luka', qty: 1, price: 200000, payer: 150000 }],
    { due: '2026-10-20' });
  // INV3 (B2 WITA) 6 Okt 00.30 WITA (= 5 Okt 16.30 UTC) → 6 Okt: konsultasi 100.000
  const inv3 = await invoice(B2, U2, null, '2026-10-06T00:30:00+08:00', [{ type: 'KONSULTASI', service: S1, desc: 'Konsultasi', qty: 1, price: 100000 }]);
  // Tidak dihitung: void, draf; di luar periode: INV6 Juli (piutang 70.000 jatuh tempo 31 Jul, Asuransi Prima)
  await invoice(B1, U1, null, '2026-10-07T09:00:00+07:00', [{ type: 'LAINNYA', desc: 'Salah input', qty: 1, price: 999000 }], { status: 'VOID' });
  await invoice(B1, U1, null, '2026-10-07T09:00:00+07:00', [{ type: 'LAINNYA', desc: 'Draf', qty: 1, price: 555000 }], { status: 'DRAFT' });
  await invoice(B1, U1, PAYER2, '2026-07-01T09:00:00+07:00', [{ type: 'TINDAKAN', service: S2, desc: 'Rawat luka', qty: 1, price: 70000, payer: 70000 }], { due: '2026-07-31' });

  // Shift 1 (B1) 5 Okt: kas awal 100.000; tunai 108.000 (INV1), QRIS 50.000 (INV2), refund tunai 8.000 → kas seharusnya 200.000; dihitung 199.000
  const sh1 = await shift(B1, ids.manajerA, '2026-10-05T08:00:00+07:00', 100000);
  const p1 = await pay(inv1.id, sh1, 'TUNAI', 108000, '2026-10-05T10:05:00+07:00');
  await pay(inv2.id, sh1, 'QRIS', 50000, '2026-10-05T23:35:00+07:00');
  await su(`insert into app.refund(tenant_id, refund_no, payment_id, amount, reason, method, requested_by, requested_at, approved_by, decided_at, status, shift_id)
    values ($1, 'RF-F-1', $2, 8000, 'Obat dikembalikan', 'TUNAI', $3, '2026-10-05T14:00:00+07:00', $4, '2026-10-05T15:00:00+07:00', 'APPROVED', $5)`,
  [ids.tenantA, p1, ids.kasirA, ids.manajerA, sh1]);
  // Refund ditolak (sudah diputuskan) & yang masih diajukan tidak dihitung
  await su(`insert into app.refund(tenant_id, refund_no, payment_id, amount, reason, method, requested_by, requested_at, approved_by, decided_at, status, shift_id, decision_note)
    values ($1, 'RF-F-3', $2, 7000, 'Ditolak', 'TUNAI', $3, '2026-10-05T12:00:00+07:00', $4, '2026-10-05T12:30:00+07:00', 'REJECTED', $5, 'Tidak sesuai')`,
  [ids.tenantA, p1, ids.kasirA, ids.manajerA, sh1]);
  // Refund yang masih diajukan (belum disetujui) tidak dihitung
  await su(`insert into app.refund(tenant_id, refund_no, payment_id, amount, reason, method, requested_by, requested_at, status, shift_id)
    values ($1, 'RF-F-2', $2, 5000, 'Masih diajukan', 'TUNAI', $3, '2026-10-05T16:00:00+07:00', 'REQUESTED', $4)`, [ids.tenantA, p1, ids.kasirA, sh1]);
  await su(`update app.cashier_shift set status = 'CLOSED', closed_at = '2026-10-05T23:50:00+07:00', counted_cash = 199000, expected_cash = 200000,
    variance_note = 'Uang receh kurang', closed_by = $2 where id = $1`, [sh1, ids.manajerA]);
  // Shift 2 (B2) 6 Okt, masih terbuka: debit 100.000 (INV3)
  const sh2 = await shift(B2, ids.adminA, '2026-10-06T08:00:00+08:00', 50000);
  await pay(inv3.id, sh2, 'DEBIT', 100000, '2026-10-06T09:00:00+08:00');
  // Pelunasan piutang INV2: 100.000 transfer 25 Okt
  await su(`insert into app.receivable_payment(tenant_id, receivable_id, amount, paid_on, method, reference, idempotency_key, recorded_by, recorded_at)
    select $1, id, 100000, '2026-10-25', 'TRANSFER', 'TRF-1', 'idem-rp-1', $2, now() from app.receivable where invoice_id = $3`, [ids.tenantA, ids.manajerA, inv2.id]);
}, 60_000);
afterAll(async () => { await app?.close(); });

const rev = (q: string, j = manajer) => get(`/api/v1/reports/revenue?${q}`, j);
const by = (rows: { groupLabel: string; net?: string }[]) => Object.fromEntries(rows.map((r) => [r.groupLabel, r]));

describe('Pendapatan (RPT-FR-003, OD-126)', () => {
  test('A01 tagihan terbit per kategori/layanan/penjamin/hari: void & draf tidak dihitung, tanggal terbit menurut zona waktu cabang', async () => {
    const r = await rev('from=2026-10-01&to=2026-10-31');
    expect(r.status).toBe(200);
    expect(r.body.view).toBe('billed');
    expect(by(r.body.rows)).toEqual({
      Konsultasi: { groupKey: 'KONSULTASI', groupLabel: 'Konsultasi', lines: 2, gross: '200000.00', discount: '0.00', net: '200000.00', patientPortion: '200000.00', payerPortion: '0.00' },
      Tindakan: { groupKey: 'TINDAKAN', groupLabel: 'Tindakan', lines: 1, gross: '200000.00', discount: '0.00', net: '200000.00', patientPortion: '50000.00', payerPortion: '150000.00' },
      Obat: { groupKey: 'OBAT', groupLabel: 'Obat', lines: 1, gross: '10000.00', discount: '2000.00', net: '8000.00', patientPortion: '8000.00', payerPortion: '0.00' },
    });
    expect(r.body.totals).toEqual({ invoices: 3, gross: '410000.00', discount: '2000.00', net: '408000.00', patientPortion: '258000.00', payerPortion: '150000.00' });
    // Total = jumlah neto tagihan langsung dari tabel invoice (validasi sumber)
    const [src] = await su(`select sum(net_amount)::text as s from app.invoice where status in ('ISSUED','PARTIALLY_PAID','PAID') and issued_at >= '2026-09-30T17:00:00Z' and issued_at < '2026-10-31T17:00:00Z'`);
    expect(Number(src.s)).toBe(408000);
    const day = (await rev('from=2026-10-01&to=2026-10-31&groupBy=day')).body.rows;
    expect(day.map((x: { groupLabel: string; net: string }) => [x.groupLabel, x.net])).toEqual([['2026-10-05', '308000.00'], ['2026-10-06', '100000.00']]);
    const svc = by((await rev('from=2026-10-01&to=2026-10-31&groupBy=service')).body.rows);
    expect(Object.keys(svc)).toEqual(['Konsultasi dokter umum', 'Rawat luka', 'Parasetamol 500 mg']);
    const payer = by((await rev('from=2026-10-01&to=2026-10-31&groupBy=payer')).body.rows);
    expect(payer['Asuransi Sehat'].net).toBe('200000.00');
    expect(payer['Umum'].net).toBe('208000.00');
    expect((await rev(`from=2026-10-01&to=2026-10-31&branchId=${B2}`)).body.totals.net).toBe('100000.00');
    expect((await rev('from=2026-10-01&to=2026-10-31&payerType=ASURANSI')).body.totals.net).toBe('200000.00');
  });

  test('A02 penerimaan kas per metode/hari: pembayaran + pelunasan piutang − refund disetujui', async () => {
    const r = await rev('from=2026-10-01&to=2026-10-31&view=cash');
    expect(r.body.groupBy).toBe('payer');
    expect(r.body.rows).toEqual([
      { groupKey: 'DEBIT', groupLabel: 'Kartu debit', payments: '100000.00', receivableSettlements: '0.00', refunds: '0.00', net: '100000.00' },
      { groupKey: 'QRIS', groupLabel: 'QRIS', payments: '50000.00', receivableSettlements: '0.00', refunds: '0.00', net: '50000.00' },
      { groupKey: 'TRANSFER', groupLabel: 'Transfer', payments: '0.00', receivableSettlements: '100000.00', refunds: '0.00', net: '100000.00' },
      { groupKey: 'TUNAI', groupLabel: 'Tunai', payments: '108000.00', receivableSettlements: '0.00', refunds: '8000.00', net: '100000.00' },
    ]);
    expect(r.body.totals).toEqual({ payments: '258000.00', receivableSettlements: '100000.00', refunds: '8000.00', net: '350000.00' });
    const d = (await rev('from=2026-10-01&to=2026-10-31&view=cash&groupBy=day')).body.rows;
    expect(d.map((x: { groupKey: string; net: string }) => [x.groupKey, x.net])).toEqual([['2026-10-05', '150000.00'], ['2026-10-06', '100000.00'], ['2026-10-25', '100000.00']]);
    expect((await rev('from=2026-10-01&to=2026-10-20&view=cash')).body.totals.net).toBe('250000.00');
  });
});

describe('Closing kasir & umur piutang (RPT-FR-004, RPT-FR-007, OD-127)', () => {
  test('A03 closing kasir: rekap shift per tanggal buka — kas seharusnya, selisih, non-tunai, status', async () => {
    const r = await get('/api/v1/reports/cashier-closing?from=2026-10-01&to=2026-10-31', manajer);
    expect(r.status).toBe(200);
    expect(r.body.rows.map((x: { shiftId?: string }) => { const y = { ...x }; delete y.shiftId; return y; })).toEqual([
      { date: '2026-10-05', branchName: 'Cabang 1', cashierName: 'Manajer', status: 'CLOSED', statusLabel: 'Ditutup', openingCash: '100000.00', cashIn: '108000.00',
        cashRefunds: '8000.00', expectedCash: '200000.00', countedCash: '199000.00', variance: '-1000.00', nonCash: '50000.00', verifiedByName: null, varianceNote: 'Uang receh kurang' },
      { date: '2026-10-06', branchName: 'Cabang Timur', cashierName: 'Admin A', status: 'OPEN', statusLabel: 'Terbuka', openingCash: '50000.00', cashIn: '0.00',
        cashRefunds: '0.00', expectedCash: '50000.00', countedCash: null, variance: null, nonCash: '100000.00', verifiedByName: null, varianceNote: null },
    ]);
    expect(r.body.totals).toEqual({ shifts: 2, open: 1, unverified: 1, cashIn: '108000.00', cashRefunds: '8000.00', nonCash: '150000.00', variance: '-1000.00' });
    const csv = await get('/api/v1/reports/cashier-closing?from=2026-10-01&to=2026-10-31&format=csv', manajer);
    expect(csv.text.split('\r\n')[1]).toBe('2026-10-05,Cabang 1,Manajer,Ditutup,100000.00,108000.00,8000.00,200000.00,199000.00,-1000.00,50000.00,');
  });

  test('A04 umur piutang dari jatuh tempo per tanggal posisi; pelunasan sesudah tanggal posisi tidak mengurangi', async () => {
    const aging = async (asOf: string) => (await get(`/api/v1/reports/receivables?asOf=${asOf}`, manajer)).body;
    let r = await aging('2026-11-30');
    // Sehat: 150.000 − 100.000 = 50.000, lewat 41 hari → 31–60. Prima: 70.000, lewat 122 hari → > 90
    expect(r.rows.map((x: { payerId?: string }) => { const y = { ...x }; delete y.payerId; return y; })).toEqual([
      { payerName: 'Asuransi Prima', count: 1, notDue: '0.00', d1_30: '0.00', d31_60: '0.00', d61_90: '0.00', over90: '70000.00', total: '70000.00' },
      { payerName: 'Asuransi Sehat', count: 1, notDue: '0.00', d1_30: '0.00', d31_60: '50000.00', d61_90: '0.00', over90: '0.00', total: '50000.00' },
    ]);
    expect(r.totals).toMatchObject({ count: 2, total: '120000.00' });
    r = await aging('2026-10-22');                                     // sebelum pelunasan 25 Okt, lewat 2 hari
    expect(r.rows.find((x: { payerName: string }) => x.payerName === 'Asuransi Sehat')).toMatchObject({ d1_30: '150000.00', total: '150000.00' });
    r = await aging('2026-10-15');
    expect(r.rows.find((x: { payerName: string }) => x.payerName === 'Asuransi Sehat')).toMatchObject({ notDue: '150000.00' });
    r = await aging('2026-06-30');                                     // sebelum tagihan terbit
    expect(r.rows).toEqual([]);
    expect((await get('/api/v1/reports/receivables', manajer)).body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('A05 izin, cakupan cabang, validasi & audit', async () => {
    for (const p of ['revenue?from=2026-10-01&to=2026-10-31', 'cashier-closing?from=2026-10-01&to=2026-10-31', 'receivables']) {
      expect([p, (await get(`/api/v1/reports/${p}`, kasir)).status]).toEqual([p, 403]);
      expect([p, (await get(`/api/v1/reports/${p}`, admin)).status]).toEqual([p, 403]);
    }
    expect((await rev('from=2026-10-01&to=2026-10-31&view=laba')).status).toBe(400);
    expect((await rev('from=2025-01-01&to=2026-10-31')).status).toBe(400);
    expect((await get('/api/v1/reports/receivables?asOf=30-11-2026', manajer)).status).toBe(400);
    // Pengguna laporan keuangan khusus Cabang Timur
    await su(`with r as (insert into app.role(tenant_id, code, name) values ($1, 'KEU_CBG2', 'Keuangan cabang timur') returning id)
              insert into app.role_permission(tenant_id, role_id, permission_code) select $1, id, 'report.finance.read' from r`, [ids.tenantA]);
    await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id, branch_id) select $1, $2, id, $3 from app.role where tenant_id = $1 and code = 'KEU_CBG2'`,
      [ids.tenantA, ids.gudangA, B2]);
    const g = await login('gudang@a.test');
    await http.post('/api/v1/me/branch').set('Host', HOST).set('Cookie', g.cookie).set('X-CSRF-Token', g.csrf).send({ branchId: B2 });
    expect((await rev('from=2026-10-01&to=2026-10-31', g)).body.totals.net).toBe('100000.00');
    expect((await get('/api/v1/reports/cashier-closing?from=2026-10-01&to=2026-10-31', g)).body.rows.map((x: { branchName: string }) => x.branchName)).toEqual(['Cabang Timur']);
    expect((await get('/api/v1/reports/receivables?asOf=2026-11-30', g)).body.rows).toEqual([]);
    expect((await rev(`from=2026-10-01&to=2026-10-31&branchId=${B1}`, g)).body.code).toBe('RPT-403-BRANCH');
    const acts = await su(`select action, count(*)::int as n from app.audit_log where action in ('REPORT_REVENUE_VIEWED', 'REPORT_CASHIER_CLOSING_VIEWED', 'REPORT_RECEIVABLES_VIEWED')
      group by action order by action`);
    expect(acts.map((x) => x.action)).toEqual(['REPORT_CASHIER_CLOSING_VIEWED', 'REPORT_RECEIVABLES_VIEWED', 'REPORT_REVENUE_VIEWED']);
    expect(JSON.stringify((await rev('from=2026-10-01&to=2026-10-31&groupBy=service')).body)).not.toMatch(/Pasien Keuangan|INV-F|KJ-F/);
  });
});
