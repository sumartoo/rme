import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { Pool } from 'pg';
import request from 'supertest';
import { expireReportExports, runNextReportExport } from '@clinicrme/db/reports';
import { FsStorage } from '@clinicrme/storage';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, ownerUrl, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 14 batch 3 — laporan farmasi di menu Laporan (RPT-FR-005, 006) & ekspor seragam (RPT-FR-008, OD-128 / DEC-047):
 * mendekati kedaluwarsa, cakupan cabang laporan farmasi, ekspor XLSX/CSV/PDF ber-watermark ≤ 10.000 baris langsung, di atasnya worker,
 * tautan 24 jam hanya untuk pemohon, audit tanpa isi laporan. Worker disimulasikan dengan mesin yang sama memakai koneksi pemilik skema.
 * Data sintetis.
 */
const HOST = 'klinik-a.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const FACILITY = A(1), B1 = A(10), PCT = A(41), AMX = A(42);
const B2 = A(910), FARMASI = A(911), SCOPED = A(912), EXPORTER = A(913), BULK = A(914);
const BUCKETS = { files: 'files', exports: 'exports' };
let app: INestApplication;
let http: ReturnType<typeof request>;
let storageDir: string;
let workerPool: Pool;
let storage: FsStorage;

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
const post = (path: string, j: Jar) => http.post(path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
const binary = (r: request.Request) => r.buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});
async function addUser(id: string, email: string, name: string, role: string, branch: string | null = null) {
  await su(`insert into app.app_user(id, tenant_id, email, full_name) values ($1, $2, $3, $4)`, [id, ids.tenantA, email, name]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id, branch_id) select $1, $2, id, $4 from app.role where tenant_id = $1 and code = $3`,
    [ids.tenantA, id, role, branch]);
  await su(`insert into app.user_credential(tenant_id, user_id, password_hash) select tenant_id, $2, password_hash from app.user_credential where user_id = $1`, [ids.dokterA, id]);
}
/** Batch baru + penerimaan (harga beli 100/unit) di lokasi bawaan cabang. */
async function batch(drug: string, no: string, days: number, qty: number, branch = B1) {
  const [{ id }] = await su(`insert into app.stock_batch(tenant_id, drug_item_id, batch_no, expiry_date, unit_cost)
                             values ($1, $2, $3, (now() at time zone 'Asia/Jakarta')::date + $4::int, 100) returning id`, [ids.tenantA, drug, no, days]);
  await su(`insert into app.stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id)
            select $1, $2, l.id, 'RECEIPT', $4, 'goods_receipt', gen_random_uuid() from app.stock_location l where l.branch_id = $3 and l.is_default`,
  [ids.tenantA, id, branch, qty]);
  return id as string;
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
let manajer: Jar, kasir: Jar, farmasi: Jar, scoped: Jar, exporter: Jar;

beforeAll(async () => {
  await resetDatabase();
  storageDir = await mkdtemp(join(tmpdir(), 'crme-it-report-'));
  app = await createApp(testConfig({ STORAGE_DRIVER: 'fs', STORAGE_FS_DIR: storageDir, STORAGE_BUCKET_FILES: 'files', STORAGE_BUCKET_EXPORTS: 'exports' }));
  http = request(app.getHttpServer());
  workerPool = new Pool({ connectionString: ownerUrl(), max: 2 });   // = koneksi worker (pemilik skema)
  storage = new FsStorage(storageDir, BUCKETS);
  await su(`update app.role set requires_mfa = false where code in ('MANAJER', 'KASIR', 'FARMASI') and tenant_id = $1`, [ids.tenantA]);
  await su(`insert into app.branch(id, tenant_id, facility_id, code, name, timezone) values ($1, $2, $3, 'CBG2', 'Cabang Timur', 'Asia/Makassar')`, [B2, ids.tenantA, FACILITY]);
  await addUser(FARMASI, 'farmasi@a.test', 'Apoteker Laporan', 'FARMASI');
  // Manajer yang hanya bertugas di Cabang 1 (OD-129)
  await addUser(SCOPED, 'manajer-cbg1@a.test', 'Manajer Cabang 1', 'MANAJER', B1);
  // Boleh ekspor & lihat laporan kunjungan saja (tanpa izin laporan farmasi)
  await su(`with r as (insert into app.role(tenant_id, code, name) values ($1, 'EKSPOR_KUNJUNGAN', 'Ekspor kunjungan') returning id)
            insert into app.role_permission(tenant_id, role_id, permission_code) select $1, r.id, p from r, unnest(array['report.export', 'report.operational.read']) p`,
  [ids.tenantA]);
  await addUser(EXPORTER, 'ekspor@a.test', 'Petugas Ekspor', 'EKSPOR_KUNJUNGAN');
  manajer = await login('manajer@a.test');
  kasir = await login('kasir@a.test');
  farmasi = await login('farmasi@a.test');
  exporter = await login('ekspor@a.test');
  scoped = await login('manajer-cbg1@a.test');
  expect((await post('/api/v1/me/branch', scoped).send({ branchId: B1 })).status).toBe(200);

  // Cabang 1: PCT kedaluwarsa 10 hari lagi (20), AMX 200 hari lagi (5), PCT sudah kedaluwarsa 5 hari lalu (3). Cabang Timur: PCT 20 hari lagi (7).
  await batch(PCT, 'NE-10', 10, 20);
  await batch(AMX, 'NE-200', 200, 5);
  await batch(PCT, 'NE-EXP', -5, 3);
  await batch(PCT, 'NE-B2', 20, 7, B2);
}, 60_000);
afterAll(async () => { await app?.close(); await workerPool?.end(); await rm(storageDir, { recursive: true, force: true }); });

describe('Laporan farmasi di menu Laporan (RPT-FR-005, 006)', () => {
  it('Y01 mendekati kedaluwarsa: bawaan 90 hari termasuk yang sudah kedaluwarsa, urut tanggal; cakupan cabang & izin', async () => {
    const r = await get('/api/v1/reports/near-expiry', manajer);
    expect(r.status).toBe(200);
    expect(r.body.rows.map((x: { batchNo: string; daysLeft: number; qty: number; value: string }) => [x.batchNo, x.daysLeft, x.qty, x.value]))
      .toEqual([['NE-EXP', -5, 3, '300.00'], ['NE-10', 10, 20, '2000.00'], ['NE-B2', 20, 7, '700.00']]);
    expect(r.body).toMatchObject({ days: 90, today: today(), allBranches: true, totals: { batches: 3, expired: 1, value: '3000.00' } });
    expect((await get('/api/v1/reports/near-expiry?includeExpired=false', manajer)).body.rows.map((x: { batchNo: string }) => x.batchNo)).toEqual(['NE-10', 'NE-B2']);
    expect((await get('/api/v1/reports/near-expiry?days=365', manajer)).body.rows).toHaveLength(4);
    // Pengaturan tenant expiryWarningDays dipakai bila days tidak diisi
    await su(`update app.tenant set settings = settings || '{"expiryWarningDays": 15}'::jsonb where id = $1`, [ids.tenantA]);
    expect((await get('/api/v1/reports/near-expiry', farmasi)).body).toMatchObject({ days: 15, totals: { batches: 2 } });
    await su(`update app.tenant set settings = settings - 'expiryWarningDays' where id = $1`, [ids.tenantA]);
    // Manajer Cabang 1 tidak melihat Cabang Timur; filter cabang lain ditolak
    const s = await get('/api/v1/reports/near-expiry', scoped);
    expect(s.body.rows.map((x: { batchNo: string }) => x.batchNo)).toEqual(['NE-EXP', 'NE-10']);
    expect(s.body.allBranches).toBe(false);
    expect((await get(`/api/v1/reports/near-expiry?branchId=${B2}`, scoped)).status).toBe(403);
    expect((await get('/api/v1/reports/near-expiry', kasir)).status).toBe(403);
    expect((await get('/api/v1/reports/near-expiry?days=0', manajer)).status).toBe(400);
    const csv = await get('/api/v1/reports/near-expiry?format=csv', farmasi);
    expect(csv.headers['content-disposition']).toBe('attachment; filename="mendekati-kedaluwarsa.csv"');
    expect(csv.text.split('\r\n')[0]).toBe('\uFEFFKedaluwarsa,Sisa hari,Kode,Nama obat,Golongan,Batch,Lokasi,Jumlah,Satuan,Nilai (harga beli)');
    expect(await su(`select count(*)::int as n from app.audit_log where action = 'REPORT_NEAR_EXPIRY_VIEWED'`)).toEqual([{ n: 6 }]);   // hanya yang berhasil
  });

  it('Y02 stok & mutasi memakai cakupan cabang pengguna (OD-129)', async () => {
    const from = today(), to = today();
    // Semua cabang: (3 + 20 + 5 + 7) × 100 = 3.500; Cabang 1 saja: 2.800
    expect((await get(`/api/v1/reports/stock?from=${from}&to=${to}`, manajer)).body.totals).toEqual({ closingValue: '3500.00' });
    expect((await get(`/api/v1/reports/stock?from=${from}&to=${to}`, scoped)).body.totals).toEqual({ closingValue: '2800.00' });
    expect((await get(`/api/v1/reports/stock-movements?from=${from}&to=${to}`, scoped)).body.rows).toHaveLength(3);
    expect((await get(`/api/v1/reports/stock-movements?from=${from}&to=${to}`, manajer)).body.rows).toHaveLength(4);
    expect((await get(`/api/v1/reports/stock?from=${from}&to=${to}&branchId=${B2}`, scoped)).status).toBe(403);
    expect((await get(`/api/v1/reports/controlled-drugs?month=${from.slice(0, 7)}&branchId=${B2}`, scoped)).status).toBe(403);
  });
});

describe('Ekspor laporan seragam (RPT-FR-008, OD-128)', () => {
  let xlsxJob: string;

  it('Y03 XLSX ≤ 10.000 baris dibuat langsung: watermark, kolom & total; audit filter + jumlah baris tanpa isi', async () => {
    const r = await post('/api/v1/reports/near-expiry/exports', manajer).send({ format: 'XLSX', parameters: { days: 90 } });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ reportCode: 'near-expiry', format: 'XLSX', status: 'DONE', rowCount: 3, error: null,
      downloadUrl: `/api/v1/report-exports/${r.body.id}/download` });
    expect(Date.parse(r.body.expiresAt) - Date.parse(r.body.finishedAt)).toBe(24 * 3600_000);
    xlsxJob = r.body.id;
    const d = await binary(get(r.body.downloadUrl, manajer));
    expect(d.status).toBe(200);
    expect(d.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(d.headers['content-disposition']).toBe('attachment; filename="mendekati-kedaluwarsa.xlsx"');
    expect(d.headers['cache-control']).toBe('no-store');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(d.body as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Laporan')!;
    const lines: string[] = [];
    ws.eachRow((row) => lines.push((row.values as unknown[]).slice(1).map((v) => (v ?? '')).join('|')));
    expect(lines[0]).toBe('Laporan obat mendekati kedaluwarsa');
    expect(lines).toContain('Klinik: klinik-a');
    expect(lines).toContain('Filter: Hari: 90 · Termasuk kedaluwarsa: true');
    expect(lines.find((l) => l.startsWith('Diekspor oleh: Manajer — '))).toMatch(/\(Asia\/Jakarta\)$/);
    expect(lines).toContain('Rahasia — untuk internal klinik');
    const h = lines.indexOf('Kedaluwarsa|Sisa hari|Kode|Nama obat|Golongan|Batch|Lokasi|Jumlah|Satuan|Nilai (harga beli)');
    expect(h).toBeGreaterThan(0);
    expect(lines.slice(h + 1).map((l) => l.split('|')[5])).toEqual(['NE-EXP', 'NE-10', 'NE-B2', '']);
    expect(lines.at(-1)).toBe('Total|||||||||3000');
    expect(ws.headerFooter.oddHeader).toContain('Rahasia — untuk internal klinik');
    expect(ws.headerFooter.oddFooter).toContain('Diekspor oleh Manajer');
    // Audit: laporan, filter, jumlah baris, format — tanpa isi laporan
    const [a] = await su(`select actor_user_id, change_summary from app.audit_log where action = 'REPORT_EXPORTED' and resource_id = $1`, [xlsxJob]);
    expect(a).toEqual({ actor_user_id: ids.manajerA, change_summary: { report: 'near-expiry', format: 'XLSX', rowCount: 3, filters: { days: 90, includeExpired: 'true' } } });
    expect(await su(`select change_summary from app.audit_log where action = 'REPORT_EXPORT_DOWNLOADED' and resource_id = $1`, [xlsxJob]))
      .toEqual([{ change_summary: { report: 'near-expiry', format: 'XLSX', rowCount: 3 } }]);
    expect(JSON.stringify(await su(`select change_summary from app.audit_log where action like 'REPORT_EXPORT%'`))).not.toMatch(/Parasetamol|NE-10/);
    expect(await su(`select f.category, f.content_type, j.download_count from app.report_export_job j join app.stored_file f on f.id = j.file_id where j.id = $1`, [xlsxJob]))
      .toEqual([{ category: 'REPORT', content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', download_count: 1 }]);
  });

  it('Y04 CSV (UTF-8 BOM, preamble watermark) dan PDF A4 lanskap', async () => {
    const from = today();
    const c = await post('/api/v1/reports/stock/exports', manajer).send({ format: 'CSV', parameters: { from, to: from, branchId: B1 } });
    expect(c.body).toMatchObject({ status: 'DONE', format: 'CSV' });
    const d = await binary(get(c.body.downloadUrl, manajer));
    expect(d.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(d.headers['content-disposition']).toBe(`attachment; filename="stok-${from}-${from}.csv"`);
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(d.body as Buffer);
    expect(text.startsWith('\uFEFFLaporan stok\r\nKlinik: klinik-a\r\n')).toBe(true);
    expect(text).toContain(`Filter: Dari: ${from} · Sampai: ${from} · Cabang: Cabang 1`);
    expect(text).toContain('\r\nRahasia — untuk internal klinik\r\n\r\nKode,Nama obat,');
    expect(text.trimEnd().split('\r\n').at(-1)).toBe('Total,,,,,,,,,,,,2800.00');
    const p = await post('/api/v1/reports/near-expiry/exports', manajer).send({ format: 'PDF', parameters: {} });
    expect(p.body).toMatchObject({ status: 'DONE', format: 'PDF', rowCount: 3 });
    const pdf = await binary(get(p.body.downloadUrl, manajer));
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const raw = (pdf.body as Buffer).toString('latin1');
    expect(raw.startsWith('%PDF-')).toBe(true);
    expect(raw).toMatch(/\/MediaBox \[0 0 841\.89 595\.28\]/);   // A4 lanskap
  });

  it('Y05 izin: report.export + izin lihat laporan itu, cakupan cabang, parameter, pemohon saja', async () => {
    const body = { format: 'XLSX', parameters: { days: 30 } };
    // OD-132 (DEC-048): Apoteker/TTK kini punya report.export (dulu mengunduh CSV dari halaman laporan farmasi)
    expect((await post('/api/v1/reports/near-expiry/exports', farmasi).send(body)).body.status).toBe('DONE');
    expect((await post('/api/v1/reports/near-expiry/exports', kasir).send(body)).status).toBe(403);
    const no = await post('/api/v1/reports/near-expiry/exports', exporter).send(body);
    expect([no.status, no.body.code]).toEqual([403, 'IAM-403-FORBIDDEN']);
    expect((await post('/api/v1/reports/visits/exports', exporter).send({ format: 'CSV', parameters: { from: '2026-10-01', to: '2026-10-31' } })).body.status).toBe('DONE');
    expect((await post('/api/v1/reports/tidak-ada/exports', manajer).send(body)).status).toBe(404);
    expect((await post('/api/v1/reports/__proto__/exports', manajer).send(body)).status).toBe(404);
    expect((await post('/api/v1/reports/visits/exports', manajer).send({ format: 'XLSX', parameters: {} })).status).toBe(400);
    expect((await post('/api/v1/reports/visits/exports', manajer).send({ format: 'DOCX', parameters: {} })).status).toBe(400);
    expect((await post('/api/v1/reports/near-expiry/exports', manajer).send({ ...body, extra: 1 })).status).toBe(400);
    expect((await post('/api/v1/reports/near-expiry/exports', scoped).send({ format: 'CSV', parameters: { branchId: B2 } })).status).toBe(403);
    // Ekspor cabang-terbatas memakai cakupan pemohon
    const s = await post('/api/v1/reports/near-expiry/exports', scoped).send({ format: 'CSV', parameters: {} });
    expect(s.body.rowCount).toBe(2);
    expect(await su(`select branch_scope::text from app.report_export_job where id = $1`, [s.body.id])).toEqual([{ branch_scope: `{${B1}}` }]);
    // Job & berkas hanya untuk pemohon
    expect((await get(`/api/v1/report-exports/${xlsxJob}`, scoped)).status).toBe(404);
    expect((await get(`/api/v1/report-exports/${xlsxJob}/download`, scoped)).status).toBe(404);
    expect((await get(`/api/v1/report-exports/${xlsxJob}/download`, farmasi)).status).toBe(404);
    expect((await get(`/api/v1/report-exports/${xlsxJob}/download`, kasir)).status).toBe(403);
    expect((await get('/api/v1/report-exports/bukan-uuid', manajer)).status).toBe(404);
  });

  it('Y06 > 10.000 baris diproses worker; PDF besar ditolak', async () => {
    const [{ id: bulkBatch }] = await su(`insert into app.stock_batch(id, tenant_id, drug_item_id, batch_no, expiry_date, unit_cost)
                                          values ($1, $2, $3, 'BULK', current_date + 900, 1) returning id`, [BULK, ids.tenantA, PCT]);
    await su(`insert into app.stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id)
              select $1, $2, l.id, 'RECEIPT', 1, 'goods_receipt', gen_random_uuid() from app.stock_location l, generate_series(1, 10001)
               where l.branch_id = $3 and l.is_default`, [ids.tenantA, bulkBatch, B1]);
    const params = { from: today(), to: today(), drugId: PCT };
    const big = await post('/api/v1/reports/stock-movements/exports', manajer).send({ format: 'PDF', parameters: params });
    expect([big.status, big.body.code]).toEqual([422, 'RPT-422-PDF-TOO-LARGE']);
    const q = await post('/api/v1/reports/stock-movements/exports', manajer).send({ format: 'CSV', parameters: params });
    expect(q.status).toBe(202);
    expect(q.body).toMatchObject({ status: 'QUEUED', rowCount: null, downloadUrl: null });
    expect(await su(`select change_summary->>'rowCount' as n from app.audit_log where action = 'REPORT_EXPORT_REQUESTED' and resource_id = $1`, [q.body.id]))
      .toEqual([{ n: '10004' }]);   // 10.001 BULK + NE-10 + NE-EXP + NE-B2 (semua PCT, hari ini)
    expect((await get(`/api/v1/report-exports/${q.body.id}/download`, manajer)).status).toBe(409);
    expect(await runNextReportExport(workerPool, storage)).toBe(q.body.id);
    expect(await runNextReportExport(workerPool, storage)).toBeNull();
    const done = await get(`/api/v1/report-exports/${q.body.id}`, manajer);
    expect(done.body).toMatchObject({ status: 'DONE', rowCount: 10004 });
    const d = await binary(get(done.body.downloadUrl, manajer));
    const lines = new TextDecoder('utf-8', { ignoreBOM: true }).decode(d.body as Buffer).trimEnd().split('\r\n');
    expect(lines[0]).toBe('\uFEFFLaporan mutasi stok');
    expect(lines.filter((l) => l.includes(',BULK,'))).toHaveLength(10001);
    expect(await su(`select actor_kind, actor_user_id, change_summary->>'rowCount' as n, change_summary->>'async' as a from app.audit_log
                      where action = 'REPORT_EXPORTED' and resource_id = $1`, [q.body.id]))
      .toEqual([{ actor_kind: 'SYSTEM', actor_user_id: ids.manajerA, n: '10004', a: 'true' }]);
  });

  it('Y07 tautan berlaku 24 jam: kedaluwarsa → 410, berkas dihapus worker; job macet & gagal tercatat', async () => {
    const [{ object_path }] = await su(`select f.object_path from app.report_export_job j join app.stored_file f on f.id = j.file_id where j.id = $1`, [xlsxJob]);
    const file = join(storageDir, 'exports', object_path);
    expect(existsSync(file)).toBe(true);
    await su(`update app.report_export_job set expires_at = now() - interval '1 minute' where id = $1`, [xlsxJob]);
    expect((await get(`/api/v1/report-exports/${xlsxJob}`, manajer)).body).toMatchObject({ status: 'EXPIRED', downloadUrl: null });
    const g = await get(`/api/v1/report-exports/${xlsxJob}/download`, manajer);
    expect([g.status, g.body.code]).toEqual([410, 'RPT-410-EXPORT-EXPIRED']);
    // Job RUNNING > 1 jam → FAILED; job dengan parameter rusak → FAILED + audit
    const [{ id: stale }] = await su(`insert into app.report_export_job(tenant_id, report_code, format, status, requested_by, started_at)
      values ($1, 'visits', 'CSV', 'RUNNING', $2, now() - interval '2 hours') returning id`, [ids.tenantA, ids.manajerA]);
    expect(await expireReportExports(workerPool, storage)).toEqual({ expired: 1, stale: 1 });
    expect(existsSync(file)).toBe(false);
    expect(await su(`select id, status from app.report_export_job where id = any($1::uuid[]) order by status`, [[xlsxJob, stale]]))
      .toEqual(expect.arrayContaining([{ id: xlsxJob, status: 'EXPIRED' }, { id: stale, status: 'FAILED' }]));
    const [{ id: bad }] = await su(`insert into app.report_export_job(tenant_id, report_code, format, params, requested_by)
      values ($1, 'visits', 'CSV', '{"from": "2026-13-01"}', $2) returning id`, [ids.tenantA, ids.manajerA]);
    expect(await runNextReportExport(workerPool, storage)).toBe(bad);
    const f = await get(`/api/v1/report-exports/${bad}`, manajer);
    expect(f.body).toMatchObject({ status: 'FAILED', downloadUrl: null });
    expect(f.body.error).toMatch(/^Parameter tidak valid/);
    expect(await su(`select count(*)::int as n from app.audit_log where action = 'REPORT_EXPORT_FAILED' and resource_id = $1`, [bad])).toEqual([{ n: 1 }]);
  });
});

describe('Unduhan CSV cepat wajib izin ekspor (OD-132 / DEC-048)', () => {
  it('Y08 tanpa report.export: tampilan JSON tetap boleh, CSV ditolak dan tidak diaudit sebagai tampilan', async () => {
    const dokter = await login('dokter@a.test');
    const before = await su(`select count(*)::int as n from app.audit_log where action = 'REPORT_TOP_DIAGNOSES_VIEWED'`);
    expect((await get('/api/v1/reports/top-diagnoses?from=2026-10-01&to=2026-10-31', dokter)).status).toBe(200);
    const csv = await get('/api/v1/reports/top-diagnoses?from=2026-10-01&to=2026-10-31&format=csv', dokter);
    expect([csv.status, csv.body.code]).toEqual([403, 'RPT-403-EXPORT']);
    expect(await su(`select count(*)::int as n from app.audit_log where action = 'REPORT_TOP_DIAGNOSES_VIEWED'`)).toEqual([{ n: before[0].n + 1 }]);
    // Laporan transaksi tidak wajar (billing) mengikuti aturan yang sama
    await su(`with r as (insert into app.role(tenant_id, code, name) values ($1, 'AUDIT_TANPA_EKSPOR', 'Audit tanpa ekspor') returning id)
              insert into app.role_permission(tenant_id, role_id, permission_code) select $1, r.id, 'report.finance.audit' from r`, [ids.tenantA]);
    await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and code = 'AUDIT_TANPA_EKSPOR'`,
      [ids.tenantA, ids.dokterA]);
    const d2 = await login('dokter@a.test');
    expect((await get(`/api/v1/reports/anomalies?from=${today()}&to=${today()}`, d2)).status).toBe(200);
    expect((await get(`/api/v1/reports/anomalies?from=${today()}&to=${today()}&format=csv`, d2)).status).toBe(403);
    // Template Admin Klinik & Apoteker/TTK punya report.export (migrasi 0038)
    expect(await su(`select r.code from app.role r join app.role_permission rp on rp.role_id = r.id and rp.permission_code = 'report.export'
                      where r.tenant_id = $1 and r.is_template order by r.code`, [ids.tenantA])).toEqual([{ code: 'FARMASI' }, { code: 'MANAJER' }, { code: 'TENANT_ADMIN' }]);
  });
});
