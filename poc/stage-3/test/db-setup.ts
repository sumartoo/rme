import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { AuthService } from '../src/auth.service';

/**
 * Siapkan database uji bersih dari sumber kebenaran repo:
 * db/schema/*.sql → db/seed/*.sql → db/tests/001_seed.sql → seed khusus PoC.
 * Aplikasi terhubung sebagai role LOGIN `crme_poc_app` yang hanya anggota clinicrme_app (RLS berlaku).
 */
export const REPO = process.env.REPO_ROOT ?? join(__dirname, '..', '..', '..');
export const TEST_DB = process.env.POC_TEST_DB ?? 'clinicrme_poc_test';
export const APP_ROLE = 'crme_poc_app';
const A = 'aaaaaaaa-0000-0000-0000-000000000000';
export const ids = {
  tenantA: A, tenantB: 'bbbbbbbb-0000-0000-0000-000000000000',
  patientA: 'aaaaaaaa-0000-0000-0000-000000000060', patientB: 'bbbbbbbb-0000-0000-0000-000000000060',
  dokterA: 'aaaaaaaa-0000-0000-0000-000000000021', kasirA: 'aaaaaaaa-0000-0000-0000-000000000022',
  manajerA: 'aaaaaaaa-0000-0000-0000-000000000023', adminA: 'aaaaaaaa-0000-0000-0000-000000000024',
  gudangA: 'aaaaaaaa-0000-0000-0000-000000000025',
  dokterB: 'bbbbbbbb-0000-0000-0000-000000000021',
};
export const PASSWORD = 'Rahasia-Uji-2026!'; // pragma: allowlist secret — password sintetis khusus uji

const admin = (database: string) => new Client({ host: process.env.PGHOST ?? '/tmp', port: Number(process.env.PGPORT ?? 5432),
                                                 user: process.env.PGSUPERUSER ?? 'postgres', database });

export async function resetDatabase() {
  const c = admin('postgres');
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${TEST_DB}`);
  await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${APP_ROLE}') THEN
                   CREATE ROLE ${APP_ROLE} LOGIN NOBYPASSRLS; END IF; END $$`);
  await c.end();

  const d = admin(TEST_DB);
  await d.connect();
  await d.query('SET client_min_messages = warning');
  const run = async (dir: string, filter = (f: string) => f.endsWith('.sql')) => {
    for (const f of readdirSync(join(REPO, dir)).filter(filter).sort()) await d.query(readFileSync(join(REPO, dir, f), 'utf8'));
  };
  await run('db/schema');
  await run('db/seed');
  await d.query(readFileSync(join(REPO, 'db/tests/001_seed.sql'), 'utf8'));
  await d.query(`GRANT clinicrme_app TO ${APP_ROLE}`);

  // Seed PoC: role template, kredensial, penugasan role
  const hash = await AuthService.hashPassword(PASSWORD);
  for (const t of [ids.tenantA, ids.tenantB]) {
    await d.query(`SELECT set_config('app.tenant_id', $1, false)`, [t]);
    await d.query(`SELECT app.create_template_roles()`);
  }
  await d.query(`INSERT INTO app.app_user(id, tenant_id, email, full_name) VALUES ($1, $2, 'admin@a.test', 'Admin A')`, [ids.adminA, A]);
  // Role custom tanpa patient.read & tanpa MFA (IAM-FR-008) untuk uji 403
  await d.query(`INSERT INTO app.app_user(id, tenant_id, email, full_name) VALUES ($1, $2, 'gudang@a.test', 'Petugas Gudang')`, [ids.gudangA, A]);
  await d.query(`WITH r AS (INSERT INTO app.role(tenant_id, code, name) VALUES ($1, 'GUDANG', 'Petugas Gudang') RETURNING id)
                 INSERT INTO app.role_permission(tenant_id, role_id, permission_code) SELECT $1, id, 'pharmacy.stock.read' FROM r`, [A]);
  const assign = async (tenant: string, user: string, role: string) =>
    d.query(`INSERT INTO app.user_role_assignment(tenant_id, user_id, role_id)
             SELECT $1, $2, id FROM app.role WHERE tenant_id = $1 AND code = $3`, [tenant, user, role]);
  await assign(A, ids.dokterA, 'DOKTER');
  await assign(A, ids.kasirA, 'KASIR');
  await assign(A, ids.manajerA, 'MANAJER');
  await assign(A, ids.adminA, 'TENANT_ADMIN');
  await assign(A, ids.gudangA, 'GUDANG');
  await assign(ids.tenantB, ids.dokterB, 'DOKTER');
  for (const [t, u] of [[A, ids.dokterA], [A, ids.kasirA], [A, ids.manajerA], [A, ids.adminA], [A, ids.gudangA], [ids.tenantB, ids.dokterB]]) {
    await d.query(`INSERT INTO app.user_credential(tenant_id, user_id, password_hash) VALUES ($1, $2, $3)`, [t, u, hash]);
  }
  await d.end();
}

/** Akses superuser untuk pemeriksaan & manipulasi kondisi uji (mis. memajukan waktu sesi). */
export async function su<T = any>(sqlText: string, params: unknown[] = []): Promise<T[]> {
  const c = admin(TEST_DB);
  await c.connect();
  try { return (await c.query(sqlText, params)).rows; } finally { await c.end(); }
}
