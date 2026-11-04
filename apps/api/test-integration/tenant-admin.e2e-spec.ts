import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client, Pool } from 'pg';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEncryptedArchive } from '@clinicrme/shared';
import { FsStorage } from '@clinicrme/storage';
import { EXCLUDED_TABLES, expireExports, runNextExport } from '@clinicrme/db/tenant-export';
import { createApp } from '../src/app/create-app';
import { PASSWORD, appUrl, ids, ownerUrl, platformUrl, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';
import { freshTotp } from './support/totp';

/**
 * Administrasi klinik oleh tenant admin (Stage 5 batch 3): profil & kop (PLT-FR-007), ekspor data terenkripsi (PLT-FR-008).
 * Worker disimulasikan dengan memanggil mesin ekspor yang sama (`@clinicrme/db/tenant-export`) memakai koneksi pemilik skema —
 * persis seperti worker — sehingga uji membuktikan isolasi tetap berlaku walau koneksinya bisa melewati RLS.
 */
const HOST_A = 'klinik-a.clinicrme.test', HOST_B = 'klinik-b.clinicrme.test';
const KEY = 'a'.repeat(64);
const BUCKETS = { files: 'files', exports: 'exports' };
let app: INestApplication;
let http: ReturnType<typeof request>;
let storageDir: string;
let workerPool: Pool;

type Jar = { cookie: string; csrf: string };
function jar(res: request.Response, prev?: Jar): Jar {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const session = get('crme_session') ?? prev?.cookie.split('; ').find((c) => c.startsWith('crme_session='));
  const csrf = get('crme_csrf') ?? (prev ? `crme_csrf=${prev.csrf}` : undefined);
  return { cookie: [session, csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '' };
}

/** Login admin klinik + MFA (role TENANT_ADMIN wajib MFA). */
async function adminSession(host: string, email: string): Promise<Jar> {
  const l = await http.post('/api/v1/auth/login').set('Host', host).send({ email, password: PASSWORD });
  expect(l.status).toBe(200);
  let j = jar(l);
  const e = await http.post('/api/v1/auth/mfa/enroll').set('Host', host).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
  const secret = new URL(e.body.otpauthUrl).searchParams.get('secret')!;
  const v = await http.post('/api/v1/auth/mfa/verify').set('Host', host).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf)
    .send({ code: await freshTotp(secret) });
  expect(v.status).toBe(200);
  j = jar(v, j);
  return j;
}
const get = (host: string, path: string, j: Jar) => http.get(path).set('Host', host).set('Cookie', j.cookie);
const send = (method: 'post' | 'put', host: string, path: string, j: Jar) =>
  http[method](path).set('Host', host).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
const exportOpts = { encryptionKeyHex: KEY, ttlHours: 24 };

let adminA: Jar, adminB: Jar, dokterA: Jar;
beforeAll(async () => {
  await resetDatabase();
  storageDir = await mkdtemp(join(tmpdir(), 'crme-it-storage-'));
  app = await createApp(testConfig({ STORAGE_DRIVER: 'fs', STORAGE_FS_DIR: storageDir, STORAGE_BUCKET_FILES: 'files', STORAGE_BUCKET_EXPORTS: 'exports' }));
  http = request(app.getHttpServer());
  workerPool = new Pool({ connectionString: ownerUrl(), max: 2 });   // = koneksi worker (pemilik skema)
  adminA = await adminSession(HOST_A, 'admin@a.test');
  adminB = await adminSession(HOST_B, 'admin@b.test');
  dokterA = jar(await http.post('/api/v1/auth/login').set('Host', HOST_A).send({ email: 'dokter@a.test', password: PASSWORD }));
});
afterAll(async () => { await app?.close(); await workerPool?.end(); await rm(storageDir, { recursive: true, force: true }); });

describe('Profil & kop klinik (PLT-FR-007)', () => {
  test('K01 admin membaca profil + ETag versi; dokter tanpa izin → 403', async () => {
    const r = await get(HOST_A, '/api/v1/tenant/profile', adminA);
    expect(r.status).toBe(200);
    expect(r.headers.etag).toBe(`"${r.body.version}"`);
    expect(r.body).toMatchObject({ displayName: 'klinik-a', letterhead: null, logoFileId: null, settings: {} });
    expect((await get(HOST_A, '/api/v1/tenant/profile', dokterA)).status).toBe(403);
  });

  test('K02 ubah profil: If-Match wajib (428), versi lama 412, sukses → versi naik & teraudit; input asing ditolak', async () => {
    const cur = await get(HOST_A, '/api/v1/tenant/profile', adminA);
    const body = {
      displayName: 'Klinik Pratama A', settings: { pharmacyBeforeCashier: true, noShowMinutes: 30 },
      letterhead: { name: 'Klinik Pratama A', address: 'Jl. Sintetis No. 1, Jakarta', phone: '021-000000', license: 'Izin 123/SINTETIS' },
    };
    expect((await send('put', HOST_A, '/api/v1/tenant/profile', adminA).send(body)).status).toBe(428);
    expect((await send('put', HOST_A, '/api/v1/tenant/profile', adminA).set('If-Match', '"999"').send(body)).status).toBe(412);
    const ok = await send('put', HOST_A, '/api/v1/tenant/profile', adminA).set('If-Match', cur.headers.etag).send(body);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ displayName: 'Klinik Pratama A', letterhead: body.letterhead, version: cur.body.version + 1 });
    expect((await send('put', HOST_A, '/api/v1/tenant/profile', adminA).set('If-Match', cur.headers.etag).send(body)).status).toBe(412);
    const [a] = await su(`select change_summary from app.audit_log where tenant_id = $1 and action = 'TENANT_PROFILE_UPDATED'`, [ids.tenantA]);
    expect(a.change_summary.changed).toEqual(['display_name', 'letterhead', 'settings']);
    for (const bad of [{ ...body, status: 'ACTIVE' }, { ...body, settings: { lockoutThreshold: 1 } }, { ...body, displayName: 'x' },
                       { ...body, logoFileId: '00000000-0000-0000-0000-000000000000' }]) {
      expect((await send('put', HOST_A, '/api/v1/tenant/profile', adminA).set('If-Match', ok.headers.etag).send(bad)).status).toBe(400);
    }
    // Profil tenant B tidak berubah
    expect((await get(HOST_B, '/api/v1/tenant/profile', adminB)).body.displayName).toBe('klinik-b');
  });

  test('K03 role DB aplikasi hanya dapat mengubah kolom profil, hanya baris tenant sendiri', async () => {
    const c = new Client({ connectionString: appUrl() });
    await c.connect();
    try {
      await c.query(`select set_config('app.tenant_id', $1, false)`, [ids.tenantA]);
      await expect(c.query(`update app.tenant set status = 'SUSPENDED' where id = $1`, [ids.tenantA])).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`update app.tenant set code = 'curang' where id = $1`, [ids.tenantA])).rejects.toMatchObject({ code: '42501' });
      const other = await c.query(`update app.tenant set display_name = 'diambil alih' where id = $1`, [ids.tenantB]);
      expect(other.rowCount).toBe(0);
    } finally { await c.end(); }
  });
});

describe('Ekspor data tenant (PLT-FR-008, OD-028)', () => {
  let jobId: string;
  test('K04 permintaan ekspor → 202 QUEUED, teraudit; satu ekspor aktif per tenant (409); dokter → 403', async () => {
    const r = await send('post', HOST_A, '/api/v1/tenant/exports', adminA);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'QUEUED', downloadUrl: null });
    jobId = r.body.id;
    const again = await send('post', HOST_A, '/api/v1/tenant/exports', adminA);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PLT-409-EXPORT-ACTIVE');
    expect((await send('post', HOST_A, '/api/v1/tenant/exports', dokterA)).status).toBe(403);
    expect((await get(HOST_A, `/api/v1/tenant/exports/${jobId}/file`, adminA)).body.code).toBe('PLT-409-EXPORT-NOT-READY');
    const [a] = await su(`select count(*)::int n from app.audit_log where tenant_id = $1 and action = 'EXPORT_REQUESTED' and resource_id = $2`, [ids.tenantA, jobId]);
    expect(a.n).toBe(1);
  });

  test('K05 worker membuat arsip terenkripsi berisi SELURUH & HANYA data tenant A; unduh + kunci teraudit', async () => {
    // Tenant B juga punya ekspor antre: worker memproses keduanya, isinya tidak boleh bercampur
    expect((await send('post', HOST_B, '/api/v1/tenant/exports', adminB)).status).toBe(202);
    expect(await runNextExport(workerPool, new FsStorage(storageDir, BUCKETS), exportOpts)).toBe(jobId);
    const st = await get(HOST_A, `/api/v1/tenant/exports/${jobId}`, adminA);
    expect(st.body).toMatchObject({ status: 'DONE', downloadUrl: `/api/v1/tenant/exports/${jobId}/file`, error: null });
    expect(st.body.tableCount).toBeGreaterThan(40);
    const hours = (new Date(st.body.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9); expect(hours).toBeLessThanOrEqual(24);

    const key = await get(HOST_A, `/api/v1/tenant/exports/${jobId}/key`, adminA);
    expect(key.body.algorithm).toBe('AES-256-GCM');
    const dl = await get(HOST_A, `/api/v1/tenant/exports/${jobId}/file`, adminA).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/clinicrme-export-klinik-a-\d{4}-\d{2}-\d{2}\.crmex/);
    const blob = dl.body as Buffer;
    expect(blob.length).toBe(st.body.sizeBytes);
    expect(blob.includes(Buffer.from('Klinik Pratama A'))).toBe(false);     // terenkripsi

    const tmp = join(storageDir, 'unduhan.crmex');
    await writeFile(tmp, blob);
    const files = await readEncryptedArchive(tmp, Buffer.from(key.body.key, 'base64'));
    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    expect(manifest).toMatchObject({ format: 'clinicrme-export/1', exportId: jobId, tenant: { id: ids.tenantA, code: 'klinik-a' } });
    // Lengkap: setiap tabel ber-tenant_id yang dapat dibaca aplikasi ada di arsip (kecuali yang sengaja dikecualikan)
    const expected = (await su(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'app'
       where c.relkind in ('r','p') and not c.relispartition and has_table_privilege('clinicrme_app', c.oid, 'SELECT')
         and (c.relname = 'tenant' or exists(select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id'))
       order by 1`)).map((r) => r.relname).filter((t) => !(t in EXCLUDED_TABLES));
    expect(manifest.tables.map((t: { name: string }) => t.name)).toEqual(expected);
    let total = 0;
    for (const t of manifest.tables as { name: string; file: string; rows: number; sha256: string }[]) {
      const content = files.get(t.file)!;
      const lines = content.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect([t.name, lines.length]).toEqual([t.name, t.rows]);
      expect(require('node:crypto').createHash('sha256').update(content).digest('hex')).toBe(t.sha256);
      for (const row of lines) expect([t.name, row.tenant_id ?? row.id]).toEqual([t.name, ids.tenantA]);
      total += t.rows;
    }
    expect(total).toBe(st.body.rowCount);
    for (const ex of Object.keys(EXCLUDED_TABLES)) expect(files.has(`tables/${ex}.ndjson`)).toBe(false);
    const all = [...files.values()].map((b) => b.toString()).join('');
    expect(all).toContain(ids.patientA);
    expect(all).not.toContain(ids.patientB);
    expect(all).not.toContain('$argon2');                                     // hash password tidak pernah ikut
    // Alat dekripsi mandiri untuk klinik (tools/export/decrypt-export.mjs) menghasilkan isi yang sama
    const out = join(storageDir, 'buka');
    execFileSync(process.execPath, [join(__dirname, '..', '..', '..', 'tools', 'export', 'decrypt-export.mjs'), tmp, key.body.key, out]);
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).exportId).toBe(jobId);
    expect(readFileSync(join(out, 'tables', 'patient.ndjson'))).toEqual(files.get('tables/patient.ndjson'));

    const audits = (await su(`select action, actor_kind from app.audit_log where tenant_id = $1 and resource_id = $2 order by seq`, [ids.tenantA, jobId]));
    expect(audits).toEqual([{ action: 'EXPORT_REQUESTED', actor_kind: 'USER' }, { action: 'EXPORT_COMPLETED', actor_kind: 'SYSTEM' },
                            { action: 'EXPORT_KEY_VIEWED', actor_kind: 'USER' }, { action: 'EXPORT_DOWNLOADED', actor_kind: 'USER' }]);
    const [chain] = await su(`select ok from app.verify_audit_chain($1)`, [ids.tenantA]);
    expect(chain.ok).toBe(true);
  });

  test('K06 isolasi: admin B tidak dapat melihat, mengambil kunci, atau mengunduh ekspor A (404); daftar hanya milik sendiri', async () => {
    for (const p of [`/api/v1/tenant/exports/${jobId}`, `/api/v1/tenant/exports/${jobId}/key`, `/api/v1/tenant/exports/${jobId}/file`]) {
      expect([p, (await get(HOST_B, p, adminB)).status]).toEqual([p, 404]);
    }
    const listB = await get(HOST_B, '/api/v1/tenant/exports', adminB);
    expect(listB.body.every((j: { id: string }) => j.id !== jobId)).toBe(true);
    // Ekspor B diproses terpisah dan hanya berisi B
    await runNextExport(workerPool, new FsStorage(storageDir, BUCKETS), exportOpts);
    const [jb] = await su(`select status, row_count from app.tenant_export_job where tenant_id = $1`, [ids.tenantB]);
    expect(jb.status).toBe('DONE');
  });

  test('K07 kedaluwarsa: kunci & unduhan → 410; job pembersih menghapus objek & status EXPIRED', async () => {
    await su(`update app.tenant_export_job set expires_at = now() - interval '1 minute' where id = $1`, [jobId]);
    expect((await get(HOST_A, `/api/v1/tenant/exports/${jobId}/file`, adminA)).body.code).toBe('PLT-410-EXPORT-EXPIRED');
    expect((await get(HOST_A, `/api/v1/tenant/exports/${jobId}/key`, adminA)).status).toBe(410);
    const [f] = await su(`select f.object_path from app.tenant_export_job j join app.stored_file f on f.id = j.file_id where j.id = $1`, [jobId]);
    const objectFile = join(storageDir, 'exports', f.object_path);
    expect(existsSync(objectFile)).toBe(true);
    expect((await expireExports(workerPool, new FsStorage(storageDir, BUCKETS))).expired).toBe(1);
    expect(existsSync(objectFile)).toBe(false);
    const [j] = await su(`select status, key_encrypted from app.tenant_export_job where id = $1`, [jobId]);
    expect(j).toEqual({ status: 'EXPIRED', key_encrypted: null });
    // Ekspor baru boleh diminta lagi
    expect((await send('post', HOST_A, '/api/v1/tenant/exports', adminA)).status).toBe(202);
  });

  test('K08 konsol platform tidak dapat membaca kunci ekspor; endpoint klinik tidak ada di host admin', async () => {
    const c = new Client({ connectionString: platformUrl() });
    await c.connect();
    try {
      await c.query(`select set_config('app.tenant_id', $1, false)`, [ids.tenantA]);
      await expect(c.query(`select key_encrypted from app.tenant_export_job`)).rejects.toMatchObject({ code: '42501' });
      const ok = await c.query(`select status from app.tenant_export_job`);
      expect(ok.rows.length).toBeGreaterThan(0);                                     // status boleh (offboarding)
    } finally { await c.end(); }
    expect((await http.get('/api/v1/tenant/profile').set('Host', 'admin.clinicrme.test')).status).toBe(404);
  });

  test('K09 tenant SUSPENDED: admin klinik tetap dapat melihat & meminta ekspor (PLT-FR-006)', async () => {
    await su(`update app.tenant set status = 'SUSPENDED' where id = $1`, [ids.tenantB]);
    try {
      expect((await get(HOST_B, '/api/v1/tenant/exports', adminB)).status).toBe(200);
      expect((await send('post', HOST_B, '/api/v1/tenant/exports', adminB)).status).toBe(202);
    } finally { await su(`update app.tenant set status = 'ACTIVE' where id = $1`, [ids.tenantB]); }
  });

  test('K10 feature flag klinik lain tidak terlihat aplikasi; ekspor tetap berhasil bila klinik lain punya flag (migrasi 0006)', async () => {
    await su(`insert into app.tenant_feature_flag(tenant_id, feature_code, enabled) values ($1, 'pharmacy.v2', true)`, [ids.tenantB]);
    const c = new Client({ connectionString: appUrl() });
    await c.connect();
    try {
      await c.query(`select set_config('app.tenant_id', $1, false)`, [ids.tenantA]);
      expect((await c.query(`select count(*)::int n from app.tenant_feature_flag`)).rows[0].n).toBe(0);
    } finally { await c.end(); }
    // Ekspor A yang antre (K07) & ekspor B (K09) diproses: keduanya DONE, tidak gagal karena baris tenant lain
    while (await runNextExport(workerPool, new FsStorage(storageDir, BUCKETS), exportOpts)) { /* proses semua antrean */ }
    const jobs = await su(`select tenant_id, status, error from app.tenant_export_job where status <> 'EXPIRED' order by created_at`);
    expect(jobs.every((j) => j.status === 'DONE')).toBe(true);
  });
});
