import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { REPORTS } from '@clinicrme/db/reports';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 14 batch 4 — gate pelaporan: dashboard manajer (RPT-FR-009, OD-131), validasi angka laporan terhadap hitungan independen
 * dari dataset acak berbenih (Z02), dan uji keamanan menyeluruh (izin tiap role × tiap laporan, isolasi tenant, cakupan cabang,
 * tanpa identitas pasien). Data sintetis.
 */
const HOST_A = 'klinik-a.clinicrme.test', HOST_B = 'klinik-b.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const FACILITY = A(1), B1 = A(10), U1 = A(11), DR = A(20), PCT = A(41);
const B2 = A(950), U2 = A(951), PAYER = A(952), SCOPED = A(953);
const ROLE_USERS: Record<string, string> = {};
let app: INestApplication;
let http: ReturnType<typeof request>;

type Jar = { cookie: string; csrf: string; host: string };
async function login(email: string, host = HOST_A): Promise<Jar> {
  const r = await http.post('/api/v1/auth/login').set('Host', host).send({ email, password: PASSWORD });
  expect([email, r.status]).toEqual([email, 200]);
  const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const csrf = get('crme_csrf');
  return { cookie: [get('crme_session'), csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '', host };
}
const get = (path: string, j: Jar) => http.get(path).set('Host', j.host).set('Cookie', j.cookie);
const post = (path: string, j: Jar) => http.post(path).set('Host', j.host).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);

/** PRNG berbenih (mulberry32) — dataset sama setiap kali. */
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pad = (n: number) => String(n).padStart(2, '0');
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const r2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

let seq = 0;
async function patient() {
  const n = ++seq;
  const [{ id }] = await su(`insert into app.patient(tenant_id, mrn, full_name, birth_date, sex, identity_type) values ($1, $2, $3, '1985-05-05', 'P', 'TANPA_IDENTITAS') returning id`,
    [ids.tenantA, `RM-Z-${n}`, `Pasien Gerbang ${n}`]);
  return id as string;
}
async function encounter(o: { patient: string; branch: string; unit: string; status: string; at: string; payer?: boolean }) {
  const n = ++seq;
  let cov: string | null = null;
  if (o.payer) [{ id: cov }] = await su(`insert into app.patient_coverage(tenant_id, patient_id, payer_id, member_no) values ($1, $2, $3, $4) returning id`, [ids.tenantA, o.patient, PAYER, `MZ-${n}`]);
  const [{ id }] = await su(`insert into app.encounter(tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, arrival_type, status, arrived_at,
      coverage_id, payer_type, coverage_verified_at, cancel_reason) values ($1, $2, $3, $4, $5, $6, 'WALK_IN', $7, $8::timestamptz, $9, $10, $11,
      case when $7 = 'CANCELLED' then 'Batal uji' end) returning id`,
  [ids.tenantA, `KJ-Z-${n}`, o.patient, o.branch, o.unit, DR, o.status, o.at, cov, o.payer ? 'ASURANSI' : 'UMUM', o.payer ? o.at : null]);
  return { id: id as string, coverage: cov };
}
interface Line { type: string; qty: number; price: number; payer: number }
async function invoice(e: { id: string; coverage: string | null }, patientId: string, branch: string, issuedAt: string, lines: Line[], status: 'ISSUED' | 'VOID' | 'DRAFT', due?: string) {
  const n = ++seq;
  const [{ id }] = await su(`insert into app.invoice(tenant_id, branch_id, patient_id, encounter_id, kind, payer_type, payer_id, coverage_id)
    values ($1, $2, $3, $4, 'ENCOUNTER', $5, $6, $7) returning id`, [ids.tenantA, branch, patientId, e.id, e.coverage ? 'ASURANSI' : 'UMUM', e.coverage ? PAYER : null, e.coverage]);
  let net = 0, payer = 0;
  for (const [i, l] of lines.entries()) {
    const total = Math.round(l.qty * l.price * 100) / 100;
    net += total; payer += l.payer;
    await su(`insert into app.invoice_line(tenant_id, invoice_id, line_no, source_type, description, qty, unit_price, discount_amount, line_total, payer_portion, patient_portion, discount_status)
      values ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, 'NONE')`, [ids.tenantA, id, i + 1, l.type, `${l.type} uji`, l.qty, l.price, total, l.payer, total - l.payer]);
  }
  if (status === 'DRAFT') return { id: id as string, patientPortion: net - payer };
  await su(`update app.invoice set status = 'ISSUED', invoice_no = $2, issued_at = $3::timestamptz, gross_amount = $4, discount_amount = 0, net_amount = $4,
      payer_portion = $5, patient_portion = $6, issued_by = $7 where id = $1`, [id, `INV-Z-${n}`, issuedAt, net, payer, net - payer, ids.kasirA]);
  let receivable: string | null = null;
  if (payer > 0) [{ id: receivable }] = await su(`insert into app.receivable(tenant_id, invoice_id, payer_id, amount, due_date) values ($1, $2, $3, $4, $5) returning id`,
    [ids.tenantA, id, PAYER, payer, due]);
  if (status === 'VOID') await su(`update app.invoice set status = 'VOID' where id = $1`, [id]);
  return { id: id as string, patientPortion: net - payer, receivable };
}
async function pay(invoiceId: string, shiftId: string, method: string, amount: number, at: string) {
  const n = ++seq;
  const [{ id }] = await su(`with sp as (select set_config('search_path', 'app, public', true))
    insert into app.payment(tenant_id, receipt_no, invoice_id, shift_id, method, amount, reference, idempotency_key, received_by, received_at)
    select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz from sp returning id`,
  [ids.tenantA, `KW-Z-${n}`, invoiceId, shiftId, method, amount, method === 'TUNAI' ? null : `REF-Z-${n}`, `idem-z-${n}`, ids.kasirA, at]);
  return id as string;
}
/** Sama dengan settleInvoice aplikasi: terbayar = Σ pembayaran − Σ refund disetujui → status tagihan. */
async function settle(invoiceId: string) {
  await su(`with x as (select i.id, i.patient_portion, coalesce((select sum(p.amount) from app.payment p where p.invoice_id = i.id), 0)
                 - coalesce((select sum(r.amount) from app.refund r join app.payment p on p.id = r.payment_id where p.invoice_id = i.id and r.status = 'APPROVED'), 0) as paid
                from app.invoice i where i.id = $1)
            update app.invoice i set paid_amount = x.paid, status = case when x.paid >= x.patient_portion then 'PAID' when x.paid > 0 then 'PARTIALLY_PAID' else 'ISSUED' end
              from x where i.id = x.id`, [invoiceId]);
}
async function refund(paymentId: string, shiftId: string, amount: number, at: string) {
  const n = ++seq;
  await su(`insert into app.refund(tenant_id, refund_no, payment_id, amount, reason, method, requested_by, requested_at, approved_by, decided_at, status, shift_id)
    values ($1, $2, $3, $4, 'Uji gerbang', 'TUNAI', $5, $6::timestamptz, $7, $6::timestamptz, 'APPROVED', $8)`, [ids.tenantA, `RF-Z-${n}`, paymentId, amount, ids.kasirA, at, ids.manajerA, shiftId]);
}

let manajer: Jar, kasir: Jar, scoped: Jar, adminB: Jar;
let shift1: string, shift2: string;

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  await su(`update app.role set requires_mfa = false`);
  await su(`insert into app.branch(id, tenant_id, facility_id, code, name, timezone) values ($1, $2, $3, 'CBG2', 'Cabang Timur', 'Asia/Makassar')`, [B2, ids.tenantA, FACILITY]);
  await su(`insert into app.service_unit(id, tenant_id, branch_id, code, name, unit_type) values ($1, $2, $3, 'UMUM2', 'Poli Umum Timur', 'POLI')`, [U2, ids.tenantA, B2]);
  await su(`insert into app.payer(id, tenant_id, code, name, payer_type) values ($1, $2, 'Z-ASR', 'Asuransi Gerbang', 'ASURANSI')`, [PAYER, ids.tenantA]);
  // Satu pengguna per role template
  for (const role of ['TENANT_ADMIN', 'DOKTER', 'PERAWAT', 'PENDAFTARAN', 'FARMASI', 'KASIR', 'MANAJER', 'AUDITOR']) {
    const email = `z-${role.toLowerCase()}@a.test`;
    const [{ id }] = await su(`insert into app.app_user(tenant_id, email, full_name) values ($1, $2, $3) returning id`, [ids.tenantA, email, `Uji ${role}`]);
    await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and code = $3`, [ids.tenantA, id, role]);
    await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select tenant_id, $2, password_hash from app.user_credential where user_id = $1`, [ids.dokterA, id]);
    ROLE_USERS[role] = email;
  }
  // Manajer yang hanya bertugas di Cabang Timur
  await su(`insert into app.app_user(id, tenant_id, email, full_name) values ($1, $2, 'z-manajer-timur@a.test', 'Manajer Timur')`, [SCOPED, ids.tenantA]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id, branch_id) select $1, $2, id, $3 from app.role where tenant_id = $1 and code = 'MANAJER'`, [ids.tenantA, SCOPED, B2]);
  await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select tenant_id, $2, password_hash from app.user_credential where user_id = $1`, [ids.dokterA, SCOPED]);
  manajer = await login('manajer@a.test');
  kasir = await login('kasir@a.test');
  scoped = await login('z-manajer-timur@a.test');
  expect((await post('/api/v1/me/branch', scoped).send({ branchId: B2 })).status).toBe(200);
  adminB = await login('admin@b.test', HOST_B);
  shift1 = A(80);   // shift terbuka kasir uji di Cabang 1 (seed)
  [{ id: shift2 }] = await su(`insert into app.cashier_shift(tenant_id, branch_id, cashier_id, opened_at, opening_cash) values ($1, $2, $3, '2026-09-01T07:00:00+08:00', 0) returning id`,
    [ids.tenantA, B2, ids.manajerA]);
}, 120_000);
afterAll(async () => { await app?.close(); });

describe('Validasi angka laporan terhadap hitungan independen (gate Stage 14)', () => {
  const FROM = '2026-10-01', TO = '2026-11-09', AS_OF = '2026-11-09';
  const exp = {
    visitsByDay: {} as Record<string, number>, visitsByBranch: { [B1]: 0, [B2]: 0 } as Record<string, number>, patients: new Set<string>(), firstSeen: new Map<string, { t: number; day: string }>(),
    billedByCat: {} as Record<string, number>, billedTotal: 0, invoices: 0, cashByMethod: {} as Record<string, { pay: number; settle: number; ref: number }>,
    aging: { notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0 },
  };
  const cash = (m: string) => (exp.cashByMethod[m] ??= { pay: 0, settle: 0, ref: 0 });

  beforeAll(async () => {
    const rand = rng(20261118);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const pool: string[] = [];
    for (let i = 0; i < 25; i++) pool.push(await patient());
    // 30 hari sebelum periode: kunjungan lama sebagian pasien (pasien lama), + 40 hari periode; 2 cabang dengan zona waktu berbeda
    const days = Array.from({ length: 50 }, (_, i) => addDays('2026-09-21', i));
    let n = 0;
    for (const day of days) {
      for (const [branch, unit, off] of [[B1, U1, '+07:00'], [B2, U2, '+08:00']] as const) {
        const k = Math.floor(rand() * 4);
        for (let i = 0; i < k; i++) {
          n++;
          const p = pick(pool), h = Math.floor(rand() * 22), mi = Math.floor(rand() * 50);
          const status = rand() < 0.1 ? 'CANCELLED' : pick(['FINISHED', 'FINISHED', 'FINISHED', 'ARRIVED', 'IN_CONSULTATION']);
          const insured = rand() < 0.3;
          const at = `${day}T${pad(h)}:${pad(mi)}:00${off}`;
          const e = await encounter({ patient: p, branch, unit, status, at, payer: insured });
          const inRange = day >= FROM && day <= TO;
          if (status !== 'CANCELLED') {
            const t = Date.parse(at), f = exp.firstSeen.get(p);
            if (!f || t < f.t) exp.firstSeen.set(p, { t, day });
            if (inRange) { exp.visitsByDay[day] = (exp.visitsByDay[day] ?? 0) + 1; exp.visitsByBranch[branch]++; exp.patients.add(p); }
          }
          if (status === 'CANCELLED' || rand() < 0.4) continue;
          // Tagihan terbit 1 jam setelah datang (hari lokal sama): konsultasi + obat; sebagian void / draf
          const kons = pick([75000, 100000, 125000]), qty = 1 + Math.floor(rand() * 10), price = pick([500, 1250, 3000]);
          const payerPart = insured ? Math.round(kons * 0.8) : 0;
          const lines = [{ type: 'KONSULTASI', qty: 1, price: kons, payer: payerPart }, { type: 'OBAT', qty, price, payer: 0 }];
          const st = rand() < 0.08 ? 'VOID' : rand() < 0.08 ? 'DRAFT' : 'ISSUED';
          const issuedAt = `${day}T${pad(h + 1)}:${pad(mi)}:00${off}`;
          const due = addDays(day, 30);
          const inv = await invoice(e, p, branch, issuedAt, lines, st, due);
          if (st !== 'ISSUED') continue;
          if (inRange) {
            exp.invoices++;
            exp.billedByCat.KONSULTASI = (exp.billedByCat.KONSULTASI ?? 0) + kons;
            exp.billedByCat.OBAT = (exp.billedByCat.OBAT ?? 0) + qty * price;
            exp.billedTotal += kons + qty * price;
          }
          const method = pick(['TUNAI', 'TUNAI', 'QRIS', 'DEBIT']);
          const paidAt = `${day}T${pad(h + 1)}:${pad(mi + 5)}:00${off}`;
          const pid = await pay(inv.id, branch === B1 ? shift1 : shift2, method, inv.patientPortion, paidAt);
          if (inRange) cash(method).pay += inv.patientPortion;
          if (rand() < 0.1) {
            const amt = Math.min(5000, inv.patientPortion);
            await refund(pid, branch === B1 ? shift1 : shift2, amt, `${day}T${pad(h + 1)}:${pad(mi + 9)}:00${off}`);
            if (inRange) cash('TUNAI').ref += amt;
          }
          await settle(inv.id);
          // Piutang penjamin: sebagian dilunasi sebagian pada tanggal acak
          if (inv.receivable) {
            let remaining = payerPart;
            if (rand() < 0.5) {
              const part = Math.round(payerPart / 2), d0 = addDays(day, 5 + Math.floor(rand() * 20)), paidOn = d0 > '2026-11-15' ? '2026-11-15' : d0;
              await su(`insert into app.receivable_payment(tenant_id, receivable_id, amount, paid_on, method, reference, idempotency_key, recorded_by, recorded_at)
                values ($1, $2, $3, $4, 'TRANSFER', $5, $6, $7, now())`, [ids.tenantA, inv.receivable, part, paidOn, `TRF-Z-${n}`, `idem-rp-z-${n}`, ids.manajerA]);
              if (paidOn >= FROM && paidOn <= TO) cash('TRANSFER').settle += part;
              if (paidOn <= AS_OF) remaining -= part;
            }
            if (day <= AS_OF && remaining > 0) {
              const age = (Date.parse(AS_OF) - Date.parse(due)) / 86_400_000;
              const b = age <= 0 ? 'notDue' : age <= 30 ? 'd1_30' : age <= 60 ? 'd31_60' : age <= 90 ? 'd61_90' : 'over90';
              exp.aging[b as keyof typeof exp.aging] += remaining;
            }
          }
        }
      }
    }
  }, 180_000);

  it('Z01 kunjungan: per tanggal lokal cabang, per cabang, pasien unik & baru sama dengan hitungan independen', async () => {
    const r = await get(`/api/v1/reports/visits?from=${FROM}&to=${TO}&period=day`, manajer);
    expect(r.status).toBe(200);
    const byDay = Object.fromEntries(r.body.rows.map((x: { period: string; visits: number }) => [x.period, x.visits]));
    expect(byDay).toEqual(exp.visitsByDay);
    const total = Object.values(exp.visitsByDay).reduce((a, b) => a + b, 0);
    const newInRange = [...exp.firstSeen.values()].filter((v) => v.day >= FROM && v.day <= TO).length;
    expect(r.body.totals).toMatchObject({ visits: total, uniquePatients: exp.patients.size, newPatients: newInRange, returningPatients: total - newInRange });
    const br = await get(`/api/v1/reports/visits?from=${FROM}&to=${TO}&period=month&groupBy=branch`, manajer);
    const sum = (b: string) => br.body.rows.filter((x: { groupKey: string }) => x.groupKey === b).reduce((a: number, x: { visits: number }) => a + x.visits, 0);
    expect([sum(B1), sum(B2)]).toEqual([exp.visitsByBranch[B1], exp.visitsByBranch[B2]]);
    // Cakupan cabang: manajer Cabang Timur hanya melihat angkanya sendiri
    expect((await get(`/api/v1/reports/visits?from=${FROM}&to=${TO}`, scoped)).body.totals.visits).toBe(exp.visitsByBranch[B2]);
  });

  it('Z02 pendapatan tagihan terbit & kas per metode sama dengan hitungan independen', async () => {
    const b = await get(`/api/v1/reports/revenue?from=${FROM}&to=${TO}&view=billed&groupBy=category`, manajer);
    expect(Object.fromEntries(b.body.rows.map((x: { groupKey: string; net: string }) => [x.groupKey, x.net])))
      .toEqual(Object.fromEntries(Object.entries(exp.billedByCat).map(([k, v]) => [k, r2(v)])));
    expect(b.body.totals).toMatchObject({ invoices: exp.invoices, net: r2(exp.billedTotal) });
    const c = await get(`/api/v1/reports/revenue?from=${FROM}&to=${TO}&view=cash&groupBy=payer`, manajer);
    const got = Object.fromEntries(c.body.rows.map((x: { groupKey: string; payments: string; receivableSettlements: string; refunds: string; net: string }) =>
      [x.groupKey, [x.payments, x.receivableSettlements, x.refunds, x.net]]));
    expect(got).toEqual(Object.fromEntries(Object.entries(exp.cashByMethod).map(([m, v]) => [m, [r2(v.pay), r2(v.settle), r2(v.ref), r2(v.pay + v.settle - v.ref)]])));
  });

  it('Z03 umur piutang per tanggal posisi sama dengan hitungan independen', async () => {
    const r = await get(`/api/v1/reports/receivables?asOf=${AS_OF}`, manajer);
    expect(r.status).toBe(200);
    const e = exp.aging;
    expect(r.body.totals).toMatchObject({ notDue: r2(e.notDue), d1_30: r2(e.d1_30), d31_60: r2(e.d31_60), d61_90: r2(e.d61_90), over90: r2(e.over90),
      total: r2(e.notDue + e.d1_30 + e.d31_60 + e.d61_90 + e.over90) });
  });
});

describe('Dashboard manajer hari ini (RPT-FR-009, OD-131)', () => {
  it('Z04 kunjungan per status, antrean, kas, tagihan belum lunas, stok kritis, SATUSEHAT, tren; cakupan cabang & izin', async () => {
    const before = (await get('/api/v1/dashboard/today', manajer)).body;
    const sBefore = (await get('/api/v1/dashboard/today', scoped)).body;
    expect(before.trend).toHaveLength(14);
    const p = await patient();
    const now = new Date().toISOString();
    const e1 = await encounter({ patient: p, branch: B1, unit: U1, status: 'ARRIVED', at: now });
    await encounter({ patient: p, branch: B1, unit: U1, status: 'IN_CONSULTATION', at: now });
    const e3 = await encounter({ patient: p, branch: B1, unit: U1, status: 'FINISHED', at: now });
    await encounter({ patient: p, branch: B1, unit: U1, status: 'CANCELLED', at: now });
    const e5 = await encounter({ patient: p, branch: B2, unit: U2, status: 'ARRIVED', at: now });
    for (const [i, [e, br, u]] of ([[e1, B1, U1], [e5, B2, U2]] as const).entries()) {
      await su(`insert into app.queue_ticket(tenant_id, branch_id, unit_id, queue_date, queue_number, display_code, encounter_id)
                select $1, $2, $3, (now() at time zone timezone)::date, 900 + $5, 'Z' || $5, $4 from app.branch where id = $2`, [ids.tenantA, br, u, e.id, i]);
    }
    // Kas hari ini: tunai 60.000 − refund 10.000 di Cabang 1; tagihan Cabang Timur belum dibayar 45.000
    const inv = await invoice(e3, p, B1, now, [{ type: 'KONSULTASI', qty: 1, price: 60000, payer: 0 }], 'ISSUED');
    const pid = await pay(inv.id, shift1, 'TUNAI', 60000, now);
    await refund(pid, shift1, 10000, now);
    await settle(inv.id);   // terbayar 50.000 dari 60.000 → sisa 10.000
    await invoice(e5, p, B2, now, [{ type: 'KONSULTASI', qty: 1, price: 45000, payer: 0 }], 'ISSUED');
    // Stok: PCT minimum 10, tersedia 4 (Cabang 1); batch 10 hari lagi; batch sudah kedaluwarsa
    await su(`update app.drug_item set min_stock = 10 where id = $1`, [PCT]);
    for (const [no, days, qty] of [['Z-OK', 10, 4], ['Z-EXP', -3, 2]] as const) {
      const [{ id }] = await su(`insert into app.stock_batch(tenant_id, drug_item_id, batch_no, expiry_date, unit_cost) values ($1, $2, $3, current_date + $4::int, 100) returning id`,
        [ids.tenantA, PCT, no, days]);
      await su(`insert into app.stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id)
                select $1, $2, l.id, 'RECEIPT', $3, 'goods_receipt', gen_random_uuid() from app.stock_location l where l.branch_id = $4 and l.is_default`, [ids.tenantA, id, qty, B1]);
    }
    // SATUSEHAT: ditolak (Cabang 1), gagal (Cabang Timur); terkirim tidak dihitung
    for (const [e, st] of [[e1, 'ERROR'], [e5, 'DEAD'], [e3, 'SENT']] as const) {
      await su(`insert into app.fhir_sync_record(tenant_id, resource_type, local_type, local_id, status) values ($1, 'Encounter', 'encounter', $2, $3)`, [ids.tenantA, e.id, st]);
    }
    const d = (await get('/api/v1/dashboard/today', manajer)).body;
    expect(d.visits).toEqual({ total: before.visits.total + 4, waiting: before.visits.waiting + 2, inService: before.visits.inService + 1, finished: before.visits.finished + 1 });
    expect(Object.fromEntries(d.queue.map((q: { unitName: string; waiting: number }) => [q.unitName, q.waiting]))).toEqual({ 'Poli Umum': 1, 'Poli Umum Timur': 1 });
    expect(d.cash).toEqual({ payments: r2(+before.cash.payments + 60000), receivableSettlements: before.cash.receivableSettlements,
      refunds: r2(+before.cash.refunds + 10000), net: r2(+before.cash.net + 50000) });
    expect(d.unpaid).toEqual({ invoices: before.unpaid.invoices + 2, amount: r2(+before.unpaid.amount + 10000 + 45000) });
    expect(d.stock).toMatchObject({ lowStock: 1, expiringSoon: 1, expired: 1, low: [{ code: 'PCT500', usable: 4, minStock: 10 }] });
    expect(d.satusehat).toEqual({ needsAction: 2, error: 1, dead: 1, blocked: 0 });
    expect(d.trend.at(-1)).toEqual({ date: d.date, visits: d.visits.total, cash: d.cash.net });
    expect(d.allBranches).toBe(true);
    // Manajer Cabang Timur: hanya cabangnya
    const s = (await get('/api/v1/dashboard/today', scoped)).body;
    expect(s).toMatchObject({ allBranches: false, satusehat: { needsAction: 1, dead: 1 }, stock: { lowStock: 1, expired: 0 },
      unpaid: { invoices: sBefore.unpaid.invoices + 1, amount: r2(+sBefore.unpaid.amount + 45000) }, visits: { total: sBefore.visits.total + 1 } });
    expect(s.queue.map((q: { unitName: string }) => q.unitName)).toEqual(['Poli Umum Timur']);
    expect(s.cash.payments).toBe(sBefore.cash.payments);
    expect((await get(`/api/v1/dashboard/today?branchId=${B1}`, scoped)).status).toBe(403);
    expect((await get('/api/v1/dashboard/today', kasir)).status).toBe(403);
    // Tenant lain tidak melihat angka klinik A
    const b = (await get('/api/v1/dashboard/today', adminB)).body;
    const [own] = await su(`select count(*)::int as n from app.encounter where tenant_id = $1 and status <> 'CANCELLED'
                             and (coalesce(arrived_at, created_at) at time zone 'Asia/Jakarta')::date = (now() at time zone 'Asia/Jakarta')::date`, [ids.tenantB]);
    expect(b).toMatchObject({ visits: { total: own.n }, unpaid: { invoices: 0 }, satusehat: { needsAction: 0 }, queue: [] });
    expect(JSON.stringify(d)).not.toMatch(/Pasien Gerbang|RM-Z-/);
  });
});

describe('Keamanan laporan (gate Stage 14)', () => {
  const QUERY: Record<string, string> = {
    visits: 'from=2026-10-01&to=2026-10-31', 'top-diagnoses': 'from=2026-10-01&to=2026-10-31', revenue: 'from=2026-10-01&to=2026-10-31',
    'cashier-closing': 'from=2026-10-01&to=2026-10-31', receivables: 'asOf=2026-11-09', stock: 'from=2026-10-01&to=2026-10-31',
    'stock-movements': 'from=2026-10-01&to=2026-10-31', 'near-expiry': '', 'controlled-drugs': 'month=2026-10',
  };

  it('Z05 setiap role template × setiap laporan & dashboard: 200 tepat bila role memiliki izinnya (matriks dari DB)', async () => {
    expect(Object.keys(QUERY).sort()).toEqual(Object.keys(REPORTS).sort());
    const mismatches: string[] = [];
    for (const [role, email] of Object.entries(ROLE_USERS)) {
      const j = await login(email);
      const perms = new Set((await su(`select rp.permission_code as p from app.role_permission rp join app.role r on r.id = rp.role_id where r.tenant_id = $1 and r.code = $2`,
        [ids.tenantA, role])).map((x) => x.p as string));
      const checks: [string, string, string][] = [
        ...Object.entries(REPORTS).map(([code, d]) => [code, d.permission, `/api/v1/reports/${code}?${QUERY[code]}`] as [string, string, string]),
        ['dashboard', 'report.dashboard.read', '/api/v1/dashboard/today'],
      ];
      for (const [code, perm, url] of checks) {
        const st = (await get(url, j)).status;
        const want = perms.has(perm) ? 200 : 403;
        if (st !== want) mismatches.push(`${role} ${code}: ${st} (harus ${want})`);
      }
      // CSV & ekspor mengikuti report.export (OD-132)
      const csv = (await get(`/api/v1/reports/visits?${QUERY.visits}&format=csv`, j)).status;
      const wantCsv = perms.has('report.operational.read') ? (perms.has('report.export') ? 200 : 403) : 403;
      if (csv !== wantCsv) mismatches.push(`${role} visits csv: ${csv} (harus ${wantCsv})`);
    }
    expect(mismatches).toEqual([]);
    // KASIR tidak memiliki izin laporan apa pun
    expect(await su(`select count(*)::int as n from app.role_permission rp join app.role r on r.id = rp.role_id
                      where r.tenant_id = $1 and r.code = 'KASIR' and rp.permission_code like 'report.%'`, [ids.tenantA])).toEqual([{ n: 0 }]);
  });

  it('Z06 isolasi tenant & tanpa identitas pasien di seluruh laporan; parameter tidak valid ditolak', async () => {
    for (const code of Object.keys(REPORTS)) {
      const a = await get(`/api/v1/reports/${code}?${QUERY[code]}`, manajer);
      expect([code, a.status]).toEqual([code, 200]);
      expect([code, JSON.stringify(a.body)]).not.toEqual([code, expect.stringMatching(/Pasien Gerbang|RM-Z-|Pasien Uji/)]);
    }
    // Tenant B (admin, izin laporan operasional) tidak melihat kunjungan klinik A
    expect((await get('/api/v1/reports/visits?from=2026-10-01&to=2026-11-09', adminB)).body.totals.visits).toBe(0);
    // Cabang milik tenant lain = tidak ditemukan
    expect((await get(`/api/v1/reports/visits?from=2026-10-01&to=2026-10-31&branchId=${B1.replace(/^a{8}/, 'bbbbbbbb')}`, manajer)).status).toBe(404);
    for (const q of ['from=2026-10-01&to=2026-10-31&groupBy=patient', 'from=2026-10-01&to=2026-10-31&groupBy=1;drop', 'from=2026-13-01&to=2026-10-31',
      'from=2025-01-01&to=2026-10-31', "from=2026-10-01&to=2026-10-31&branchId=' or 1=1--"]) {
      expect([q, (await get(`/api/v1/reports/visits?${q}`, manajer)).status]).toEqual([q, 400]);
    }
  });
});
