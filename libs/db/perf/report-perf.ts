/**
 * Uji performa laporan Stage 14 (OD-130): volume target per tenant 3 tahun × 300 kunjungan/hari (≈ 328.500 kunjungan) beserta
 * RM disahkan + diagnosis, tagihan + baris + pembayaran, piutang penjamin, dan mutasi stok. Target: setiap laporan ≤ 3 detik.
 *
 * Jalankan (database uji lokal, data sintetis; database `crme_perf` dibuat ulang):
 *   PERF_ADMIN_URL=postgres://postgres:postgres@localhost:5544/postgres npx tsx libs/db/perf/report-perf.ts
 *
 * Laporan diukur lewat fungsi hitung yang sama dengan API (`libs/db/src/lib/reports`), dalam transaksi sebagai `clinicrme_app` dengan
 * konteks tenant (RLS aktif) dan `statement_timeout` 30 detik — persis seperti endpoint. Hasil dicetak sebagai tabel Markdown.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import { runMigrations } from '../src/lib/migrate';
import { type Q, reportTimeout } from '../src/lib/reports/common';
import { topDiagnoses, visits } from '../src/lib/reports/clinical';
import { cashierClosing, receivables, revenue } from '../src/lib/reports/finance';
import { controlledDrugs, nearExpiry, stockMovements, stockSummary } from '../src/lib/reports/pharmacy';
import { dashboard } from '../src/lib/reports/dashboard';

const REPO = resolve(__dirname, '../../..');
const ADMIN = process.env.PERF_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5544/postgres';
const DB = 'crme_perf';
const url = (db: string) => { const u = new URL(ADMIN); u.pathname = `/${db}`; return u.toString(); };
const DAYS = Number(process.env.PERF_DAYS ?? 1095), PER_DAY = Number(process.env.PERF_PER_DAY ?? 300);
const T = 'aaaaaaaa-0000-0000-0000-000000000000';
const id = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const B1 = id(10), U1 = id(11), DR = id(20), MANAJER = id(23), KASIR = id(22), SHIFT = id(80), B2 = id(990), U2 = id(991), PAYER = id(992);

async function build() {
  const a = new Client({ connectionString: ADMIN });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await a.query(`CREATE DATABASE ${DB}`);
  await a.end();
  await runMigrations(url(DB), join(REPO, 'db', 'migrations'));
  const c = new Client({ connectionString: url(DB) });
  await c.connect();
  await c.query(readFileSync(join(REPO, 'db', 'tests', '001_seed.sql'), 'utf8'));
  const t0 = Date.now();
  const q = async (label: string, s: string) => { const s0 = Date.now(); const r = await c.query(s); console.error(`  ${label}: ${r.rowCount ?? ''} (${Date.now() - s0} ms)`); };
  await c.query(`SET search_path = app, public; SET session_replication_role = replica`);   // pemuatan massal: trigger dimatikan, CHECK tetap berlaku
  await c.query(`INSERT INTO branch(id, tenant_id, facility_id, code, name, timezone) VALUES ('${B2}', '${T}', '${id(1)}', 'CBG2', 'Cabang Timur', 'Asia/Makassar')`);
  await c.query(`INSERT INTO stock_location(tenant_id, branch_id, name, is_default) VALUES ('${T}', '${B2}', 'Apotek', true)`);
  await c.query(`INSERT INTO service_unit(id, tenant_id, branch_id, code, name, unit_type) VALUES ('${U2}', '${T}', '${B2}', 'UMUM2', 'Poli Umum Timur', 'POLI')`);
  await c.query(`INSERT INTO payer(id, tenant_id, code, name, payer_type) VALUES ('${PAYER}', '${T}', 'P-ASR', 'Asuransi Uji', 'ASURANSI')`);
  const N = DAYS * PER_DAY;
  console.error(`Membangun ${N.toLocaleString('id-ID')} kunjungan (${DAYS} hari × ${PER_DAY})…`);
  await q('pasien', `INSERT INTO patient(tenant_id, mrn, full_name, birth_date, sex, identity_type)
    SELECT '${T}', 'P-' || g, 'Pasien Sintetis ' || g, date '1950-01-01' + (g % 25000), CASE WHEN g % 2 = 0 THEN 'L' ELSE 'P' END, 'TANPA_IDENTITAS'
      FROM generate_series(1, ${Math.round(N / 6)}) g`);
  await q('kunjungan', `CREATE TEMP TABLE pid AS SELECT row_number() OVER () AS n, id FROM patient WHERE tenant_id = '${T}' AND mrn LIKE 'P-%';
    INSERT INTO encounter(tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, arrival_type, status, arrived_at, payer_type, cancel_reason, created_at)
    SELECT '${T}', 'E-' || g, p.id, CASE WHEN g % 3 = 0 THEN '${B2}'::uuid ELSE '${B1}'::uuid END, CASE WHEN g % 3 = 0 THEN '${U2}'::uuid ELSE '${U1}'::uuid END, '${DR}', 'WALK_IN',
           CASE WHEN g % 33 = 0 THEN 'CANCELLED' WHEN g % 50 = 0 THEN 'ARRIVED' ELSE 'FINISHED' END,
           ts, 'UMUM', CASE WHEN g % 33 = 0 THEN 'Batal' END, ts
      FROM (SELECT g, now() - make_interval(days => ${DAYS} - (g - 1) / ${PER_DAY}) + make_interval(hours => -((g * 7) % 11), mins => (g * 13) % 60) AS ts
              FROM generate_series(1, ${N}) g) x
      JOIN pid p ON p.n = 1 + (x.g::bigint * 7919) % (SELECT count(*) FROM pid)`);
  await q('RM disahkan', `INSERT INTO clinical_note(tenant_id, encounter_id, status, signed_by, signed_at, content_hash, signer_user_id, sign_method)
    SELECT tenant_id, id, 'SIGNED', '${DR}', arrived_at + interval '20 minutes', md5(id::text), '${id(21)}', 'PASSWORD'
      FROM encounter WHERE tenant_id = '${T}' AND status = 'FINISHED' AND encounter_no LIKE 'E-%' AND abs(hashtext(id::text)) % 10 <> 0`);
  await q('diagnosis', `INSERT INTO concept(system_id, code, display_id)
      SELECT (SELECT id FROM code_system WHERE code = 'ICD10' ORDER BY id LIMIT 1), 'Q' || lpad(g::text, 2, '0') || '.' || (g % 10), 'Diagnosis sintetis ' || g
        FROM generate_series(1, 300) g ON CONFLICT DO NOTHING;
    CREATE TEMP TABLE cx AS SELECT row_number() OVER (ORDER BY code) AS n, id FROM concept WHERE display_id LIKE 'Diagnosis sintetis %';
    INSERT INTO condition_dx(tenant_id, encounter_id, concept_id, rank, case_status)
    SELECT n.tenant_id, n.encounter_id, (SELECT id FROM cx WHERE cx.n = 1 + abs(hashtext(n.encounter_id::text || r)) % (SELECT count(*) FROM cx)),
           CASE WHEN r = 1 THEN 'PRIMER' ELSE 'SEKUNDER' END, CASE WHEN abs(hashtext(n.encounter_id::text)) % 3 = 0 THEN 'LAMA' ELSE 'BARU' END
      FROM clinical_note n CROSS JOIN generate_series(1, 2) r WHERE n.tenant_id = '${T}' AND (r = 1 OR abs(hashtext(n.encounter_id::text)) % 2 = 0)`);
  await q('tagihan', `INSERT INTO invoice(tenant_id, branch_id, patient_id, encounter_id, kind, payer_type, payer_id, status, invoice_no, issued_at,
      gross_amount, discount_amount, net_amount, payer_portion, patient_portion, paid_amount, issued_by)
    SELECT e.tenant_id, e.branch_id, e.patient_id, e.id, 'ENCOUNTER', CASE WHEN ins THEN 'ASURANSI' ELSE 'UMUM' END, CASE WHEN ins THEN '${PAYER}'::uuid END,
           'PAID', 'INV-' || e.encounter_no, e.arrived_at + interval '1 hour', 150000, 0, 150000, CASE WHEN ins THEN 100000 ELSE 0 END,
           CASE WHEN ins THEN 50000 ELSE 150000 END, CASE WHEN ins THEN 50000 ELSE 150000 END, '${KASIR}'
      FROM (SELECT *, abs(hashtext(id::text)) % 5 = 0 AS ins FROM encounter WHERE tenant_id = '${T}' AND status = 'FINISHED' AND encounter_no LIKE 'E-%') e`);
  await q('baris tagihan', `INSERT INTO invoice_line(tenant_id, invoice_id, line_no, source_type, description, qty, unit_price, discount_amount, line_total, payer_portion, patient_portion, discount_status)
    SELECT tenant_id, id, 1, 'KONSULTASI', 'Konsultasi', 1, 100000, 0, 100000, payer_portion, 100000 - payer_portion, 'NONE' FROM invoice WHERE tenant_id = '${T}' AND invoice_no LIKE 'INV-E-%'
    UNION ALL
    SELECT tenant_id, id, 2, 'OBAT', 'Obat', 10, 5000, 0, 50000, 0, 50000, 'NONE' FROM invoice WHERE tenant_id = '${T}' AND invoice_no LIKE 'INV-E-%'`);
  await q('pembayaran', `INSERT INTO payment(tenant_id, receipt_no, invoice_id, shift_id, method, amount, reference, idempotency_key, received_by, received_at)
    SELECT tenant_id, 'KW-' || invoice_no, id, '${SHIFT}', CASE WHEN abs(hashtext(id::text)) % 3 = 0 THEN 'QRIS' ELSE 'TUNAI' END, patient_portion,
           CASE WHEN abs(hashtext(id::text)) % 3 = 0 THEN 'R-' || invoice_no END, 'IDEM-' || invoice_no, '${KASIR}', issued_at + interval '5 minutes'
      FROM invoice WHERE tenant_id = '${T}' AND invoice_no LIKE 'INV-E-%'`);
  await q('piutang', `INSERT INTO receivable(tenant_id, invoice_id, payer_id, amount, due_date, paid_amount, status)
    SELECT tenant_id, id, payer_id, payer_portion, (issued_at)::date + 30, CASE WHEN issued_at < now() - interval '60 days' THEN payer_portion ELSE 0 END,
           CASE WHEN issued_at < now() - interval '60 days' THEN 'PAID' ELSE 'OPEN' END
      FROM invoice WHERE tenant_id = '${T}' AND payer_portion > 0 AND invoice_no LIKE 'INV-E-%'`);
  await q('pelunasan piutang', `INSERT INTO receivable_payment(tenant_id, receivable_id, amount, paid_on, method, reference, idempotency_key, recorded_by, recorded_at)
    SELECT tenant_id, id, amount, due_date - 5, 'TRANSFER', 'TRF-' || id, 'RP-' || id, '${MANAJER}', now() FROM receivable WHERE tenant_id = '${T}' AND status = 'PAID'`);
  await q('obat & batch', `INSERT INTO drug_item(tenant_id, code, generic_name, dosage_form, base_uom_id, drug_class, ingredients, min_stock)
    SELECT '${T}', 'D' || g, 'Obat sintetis ' || g, 'Tablet', '${id(40)}', CASE WHEN g % 40 = 0 THEN 'PSIKOTROPIKA' ELSE 'KERAS' END, ARRAY['zat' || g], 50
      FROM generate_series(1, 300) g;
    INSERT INTO stock_batch(tenant_id, drug_item_id, batch_no, expiry_date, unit_cost)
    SELECT d.tenant_id, d.id, 'BT-' || d.code || '-' || b, current_date - 400 + b * 120, 1000 FROM drug_item d CROSS JOIN generate_series(1, 10) b WHERE d.code LIKE 'D%'`);
  await q('mutasi stok', `INSERT INTO stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id, occurred_at)
    SELECT sb.tenant_id, sb.id, l.id, 'RECEIPT', 5000, 'goods_receipt', gen_random_uuid(), now() - interval '${DAYS} days'
      FROM stock_batch sb CROSS JOIN stock_location l WHERE sb.batch_no LIKE 'BT-%' AND l.tenant_id = '${T}' AND l.is_default
    UNION ALL
    SELECT sb.tenant_id, sb.id, l.id, 'DISPENSE', -1, 'dispense', gen_random_uuid(), now() - make_interval(days => (g * 37) % ${DAYS}, hours => g % 9)
      FROM stock_batch sb CROSS JOIN generate_series(1, 100) g CROSS JOIN stock_location l WHERE sb.batch_no LIKE 'BT-%' AND l.tenant_id = '${T}' AND l.is_default`);
  await q('saldo stok', `INSERT INTO stock_balance(tenant_id, batch_id, location_id, qty_on_hand)
    SELECT tenant_id, batch_id, location_id, sum(qty) FROM stock_movement WHERE tenant_id = '${T}' GROUP BY 1, 2, 3
    ON CONFLICT (tenant_id, batch_id, location_id) DO UPDATE SET qty_on_hand = EXCLUDED.qty_on_hand`);
  await c.query(`SET session_replication_role = origin; ANALYZE`);
  const [{ e, n, d, i, p, m }] = (await c.query(`SELECT (SELECT count(*) FROM encounter) e, (SELECT count(*) FROM clinical_note) n, (SELECT count(*) FROM condition_dx) d,
    (SELECT count(*) FROM invoice) i, (SELECT count(*) FROM payment) p, (SELECT count(*) FROM stock_movement) m`)).rows;
  await c.end();
  console.error(`Data siap dalam ${Math.round((Date.now() - t0) / 1000)} detik: ${e} kunjungan, ${n} RM disahkan, ${d} diagnosis, ${i} tagihan, ${p} pembayaran, ${m} mutasi stok`);
  return { encounters: +e, notes: +n, diagnoses: +d, invoices: +i, payments: +p, movements: +m };
}

async function measure() {
  const pool = new Pool({ connectionString: url(DB), max: 1 });
  const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  const back = (n: number) => new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10);
  const month = { from: `${today.slice(0, 7)}-01`, to: today };
  const year = { from: back(365), to: today };
  const base = { format: 'json' as const };
  const cases: [string, (tx: Q) => Promise<unknown>][] = [
    ['Kunjungan — 1 bulan, harian', (tx) => visits(tx, { ...base, ...month, period: 'day', groupBy: 'none' }, null)],
    ['Kunjungan — 366 hari, bulanan per dokter', (tx) => visits(tx, { ...base, ...year, period: 'month', groupBy: 'practitioner' }, null)],
    ['Kunjungan — 366 hari, per cabang (cakupan 1 cabang)', (tx) => visits(tx, { ...base, ...year, period: 'month', groupBy: 'branch' }, [B2])],
    ['10 besar diagnosis — 1 bulan', (tx) => topDiagnoses(tx, { ...base, ...month, scope: 'primary', limit: 10 }, null)],
    ['10 besar diagnosis — 366 hari, semua diagnosis', (tx) => topDiagnoses(tx, { ...base, ...year, scope: 'all', limit: 10 }, null)],
    ['Pendapatan tagihan — 366 hari per kategori', (tx) => revenue(tx, { ...base, ...year, view: 'billed', groupBy: 'category' }, null)],
    ['Pendapatan tagihan — 366 hari per hari', (tx) => revenue(tx, { ...base, ...year, view: 'billed', groupBy: 'day' }, null)],
    ['Penerimaan kas — 366 hari per metode', (tx) => revenue(tx, { ...base, ...year, view: 'cash', groupBy: 'payer' }, null)],
    ['Closing kasir — 366 hari', (tx) => cashierClosing(tx, { ...base, ...year }, null)],
    ['Umur piutang — hari ini', (tx) => receivables(tx, { ...base }, null)],
    ['Stok — 366 hari', (tx) => stockSummary(tx, { ...base, ...year }, null)],
    ['Mutasi stok — 1 bulan (maks. 5.000 baris)', (tx) => stockMovements(tx, { ...base, ...month }, null)],
    ['Obat golongan terbatas — bulan ini', (tx) => controlledDrugs(tx, { ...base, month: today.slice(0, 7) }, null)],
    ['Mendekati kedaluwarsa', (tx) => nearExpiry(tx, { ...base, includeExpired: 'true' }, null)],
    ['Dashboard manajer hari ini', (tx) => dashboard(tx, {}, null)],
  ];
  const out: { name: string; ms: number[] }[] = [];
  for (const [name, fn] of cases) {
    const ms: number[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('set local role clinicrme_app');
        await c.query(`select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('search_path', 'app, public', true)`, [T, MANAJER]);
        const tx = drizzle(c) as unknown as Q;
        await reportTimeout(tx);
        const s0 = performance.now();
        await fn(tx);
        ms.push(Math.round(performance.now() - s0));
        await c.query('rollback');
      } finally { c.release(); }
    }
    out.push({ name, ms });
    console.error(`  ${name}: ${ms.join(' / ')} ms`);
  }
  await pool.end();
  return out;
}

(async () => {
  const vol = process.env.PERF_SKIP_BUILD ? null : await build();
  const res = await measure();
  const lines = ['| Laporan | Percobaan 1 / 2 / 3 (ms) | Terlama | ≤ 3 detik |', '|---|---|---|---|',
    ...res.map((r) => `| ${r.name} | ${r.ms.join(' / ')} | ${Math.max(...r.ms)} | ${Math.max(...r.ms) <= 3000 ? '✅' : '❌'} |`)];
  if (vol) console.log(`Volume: ${JSON.stringify(vol)}`);
  console.log(lines.join('\n'));
  process.exit(res.every((r) => Math.max(...r.ms) <= 3000) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
