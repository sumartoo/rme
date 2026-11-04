// Menyiapkan database bersih untuk uji E2E konsol platform: migrasi, role LOGIN aplikasi & platform, akun platform sintetis.
import { resolve } from 'node:path';
import { Client } from 'pg';
import { hash } from '@node-rs/argon2';
import { runMigrations } from '../../libs/db/src/lib/migrate';
import { rmSync } from 'node:fs';
import { ADMIN_URL, DB_PASSWORD, E2E_DB, STORAGE_DIR, USER_PASSWORD, dbUrl } from './config';

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${E2E_DB}`);
  for (const role of ['crme_e2e_app', 'crme_e2e_platform']) {
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN NOBYPASSRLS; END IF; END $$`);
    await admin.query(`SELECT set_config('crme.pw', $1, false)`, [DB_PASSWORD]);
    await admin.query(`DO $$ BEGIN EXECUTE format('ALTER ROLE ${role} LOGIN NOBYPASSRLS PASSWORD %L', current_setting('crme.pw')); END $$`);
  }
  await admin.end();

  const { applied } = await runMigrations(dbUrl(), resolve(__dirname, '../../db/migrations'));
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  try {
    await c.query('GRANT clinicrme_app TO crme_e2e_app');
    await c.query('GRANT clinicrme_platform TO crme_e2e_platform');
    const pw = await hash(USER_PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    for (const [email, name, role] of [['admin@platform.test', 'Admin Platform E2E', 'PLATFORM_ADMIN'],
                                       ['support@platform.test', 'Support Platform E2E', 'PLATFORM_SUPPORT']]) {
      const { rows: [u] } = await c.query(`INSERT INTO app.platform_user(email, full_name, roles) VALUES ($1, $2, ARRAY[$3]) RETURNING id`, [email, name, role]);
      await c.query(`INSERT INTO app.platform_credential(user_id, password_hash) VALUES ($1, $2)`, [u.id, pw]);
    }
  } finally {
    await c.end();
  }
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  console.log(`Database E2E ${E2E_DB} siap (${applied.length} migrasi, 2 akun platform sintetis)`);
}

main().catch((e) => { console.error(`prepare-db E2E gagal: ${e.message}`); process.exit(1); });
