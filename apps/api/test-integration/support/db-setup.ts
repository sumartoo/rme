import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { randomToken } from '@clinicrme/shared';
import { runMigrations } from '@clinicrme/db';
import { AuthService } from '@clinicrme/iam';

/**
 * Database uji bersih dibangun dari MIGRASI (db/migrations) — jalur yang sama dengan produksi —
 * lalu seed sintetis db/tests/001_seed.sql dan akun uji. Aplikasi terhubung sebagai role LOGIN
 * yang hanya anggota clinicrme_app (NOBYPASSRLS, bukan owner), sehingga RLS benar-benar berlaku.
 *
 * TEST_PG_ADMIN_URL: koneksi superuser ke database `postgres` (lokal: docker compose; CI: service postgres).
 */
export const REPO = join(__dirname, '..', '..', '..', '..');
export const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'; // pragma: allowlist secret — default docker compose lokal
export const TEST_DB = `clinicrme_it_${process.env.JEST_WORKER_ID ?? '1'}`;
export const APP_ROLE = 'crme_it_app';
/** Role LOGIN konsol platform: hanya anggota clinicrme_platform (CR-0001). */
export const PLATFORM_ROLE = 'crme_it_platform';
const APP_PASSWORD = randomToken(18);          // dibuat per run, tidak pernah disimpan
const PLATFORM_PASSWORD = randomToken(18);

const A = 'aaaaaaaa-0000-0000-0000-000000000000';
export const ids = {
  tenantA: A, tenantB: 'bbbbbbbb-0000-0000-0000-000000000000',
  patientA: 'aaaaaaaa-0000-0000-0000-000000000060', patientB: 'bbbbbbbb-0000-0000-0000-000000000060',
  dokterA: 'aaaaaaaa-0000-0000-0000-000000000021', kasirA: 'aaaaaaaa-0000-0000-0000-000000000022',
  manajerA: 'aaaaaaaa-0000-0000-0000-000000000023', adminA: 'aaaaaaaa-0000-0000-0000-000000000024',
  gudangA: 'aaaaaaaa-0000-0000-0000-000000000025',
  dokterB: 'bbbbbbbb-0000-0000-0000-000000000021', adminB: 'bbbbbbbb-0000-0000-0000-000000000024',
  platformAdmin: 'ffffffff-0000-0000-0000-000000000001', platformSupport: 'ffffffff-0000-0000-0000-000000000002',
  platformSupport2: 'ffffffff-0000-0000-0000-000000000003',
};
export const PASSWORD = 'Rahasia-Uji-2026!'; // pragma: allowlist secret — password sintetis khusus uji

const withDb = (database: string, user?: { name: string; password: string }) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${database}`;
  if (user) { u.username = user.name; u.password = user.password; }
  return u.toString();
};
export const ownerUrl = () => withDb(TEST_DB);
export const appUrl = () => withDb(TEST_DB, { name: APP_ROLE, password: APP_PASSWORD });
export const platformUrl = () => withDb(TEST_DB, { name: PLATFORM_ROLE, password: PLATFORM_PASSWORD });

export async function resetDatabase() {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${TEST_DB}`);
  await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${APP_ROLE}') THEN
                   CREATE ROLE ${APP_ROLE} LOGIN NOBYPASSRLS; END IF; END $$`);
  await c.query(`ALTER ROLE ${APP_ROLE} LOGIN NOBYPASSRLS PASSWORD '${APP_PASSWORD}'`);
  await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${PLATFORM_ROLE}') THEN
                   CREATE ROLE ${PLATFORM_ROLE} LOGIN NOBYPASSRLS; END IF; END $$`);
  await c.query(`ALTER ROLE ${PLATFORM_ROLE} LOGIN NOBYPASSRLS PASSWORD '${PLATFORM_PASSWORD}'`);
  // Hanya untuk uji mutasi M2 (tools/run_mutation_tests.sh): membuktikan uji isolasi gagal bila RLS dilewati.
  if (process.env.CRME_MUTATION === 'M2') await c.query(`ALTER ROLE ${APP_ROLE} BYPASSRLS`);
  await c.end();

  await runMigrations(ownerUrl(), join(REPO, 'db', 'migrations'));

  const d = new Client({ connectionString: ownerUrl() });
  await d.connect();
  await d.query('SET client_min_messages = warning');
  await d.query(readFileSync(join(REPO, 'db', 'tests', '001_seed.sql'), 'utf8'));
  await d.query(`GRANT clinicrme_app TO ${APP_ROLE}`);
  await d.query(`GRANT clinicrme_platform TO ${PLATFORM_ROLE}`);
  // Hanya untuk uji mutasi M6: membuktikan P17 gagal bila role platform diberi akses tabel klinis.
  if (process.env.CRME_MUTATION === 'M6') await d.query(`GRANT SELECT ON app.patient, app.clinical_note TO clinicrme_platform`);

  const hash = await AuthService.hashPassword(PASSWORD);
  for (const t of [ids.tenantA, ids.tenantB]) {
    await d.query(`SELECT set_config('app.tenant_id', $1, false)`, [t]);
    await d.query(`SELECT app.create_template_roles()`);
  }
  // Klinik uji mematikan MFA dokter (boleh oleh tenant, OD-024/OD-080) agar suite Stage 3 tetap memakai dokter tanpa TOTP.
  // Default (wajib) untuk tenant baru diuji di I-series.
  await d.query(`UPDATE app.role SET requires_mfa = false WHERE code = 'DOKTER'`);
  await d.query(`INSERT INTO app.app_user(id, tenant_id, email, full_name) VALUES ($1, $2, 'admin@a.test', 'Admin A')`, [ids.adminA, A]);
  // Role custom tanpa patient.read & tanpa MFA (IAM-FR-008) untuk uji 403
  await d.query(`INSERT INTO app.app_user(id, tenant_id, email, full_name) VALUES ($1, $2, 'gudang@a.test', 'Petugas Gudang')`, [ids.gudangA, A]);
  await d.query(`WITH r AS (INSERT INTO app.role(tenant_id, code, name) VALUES ($1, 'GUDANG', 'Petugas Gudang') RETURNING id)
                 INSERT INTO app.role_permission(tenant_id, role_id, permission_code) SELECT $1, id, 'pharmacy.stock.read' FROM r`, [A]);
  const assign = (tenant: string, user: string, role: string) =>
    d.query(`INSERT INTO app.user_role_assignment(tenant_id, user_id, role_id)
             SELECT $1, $2, id FROM app.role WHERE tenant_id = $1 AND code = $3`, [tenant, user, role]);
  await assign(A, ids.dokterA, 'DOKTER');
  await assign(A, ids.kasirA, 'KASIR');
  await assign(A, ids.manajerA, 'MANAJER');
  await assign(A, ids.adminA, 'TENANT_ADMIN');
  await assign(A, ids.gudangA, 'GUDANG');
  await assign(ids.tenantB, ids.dokterB, 'DOKTER');
  await d.query(`INSERT INTO app.app_user(id, tenant_id, email, full_name) VALUES ($1, $2, 'admin@b.test', 'Admin B')`, [ids.adminB, ids.tenantB]);
  await assign(ids.tenantB, ids.adminB, 'TENANT_ADMIN');
  for (const [t, u] of [[A, ids.dokterA], [A, ids.kasirA], [A, ids.manajerA], [A, ids.adminA], [A, ids.gudangA], [ids.tenantB, ids.dokterB], [ids.tenantB, ids.adminB]]) {
    await d.query(`INSERT INTO app.user_credential(tenant_id, user_id, password_hash) VALUES ($1, $2, $3)`, [t, u, hash]);
  }
  // Pengguna konsol platform (sintetis); TOTP didaftarkan di uji
  await d.query(`INSERT INTO app.platform_user(id, email, full_name, roles) VALUES
                   ($1, 'admin@platform.test', 'Admin Platform', ARRAY['PLATFORM_ADMIN']),
                   ($2, 'support@platform.test', 'Support Platform', ARRAY['PLATFORM_SUPPORT']),
                   ($3, 'support2@platform.test', 'Support Kedua', ARRAY['PLATFORM_SUPPORT'])`, [ids.platformAdmin, ids.platformSupport, ids.platformSupport2]);
  for (const u of [ids.platformAdmin, ids.platformSupport, ids.platformSupport2]) {
    await d.query(`INSERT INTO app.platform_credential(user_id, password_hash) VALUES ($1, $2)`, [u, hash]);
  }
  await d.end();
}

/** Akses superuser untuk pemeriksaan & manipulasi kondisi uji (mis. memajukan waktu sesi). */
export async function su<T = any>(sqlText: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: ownerUrl() });
  await c.connect();
  try { return (await c.query(sqlText, params)).rows; } finally { await c.end(); }
}
