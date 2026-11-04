// `pnpm dev:db` — migrasi + role LOGIN aplikasi untuk database lokal (idempoten).
import { resolve } from 'node:path';
import { Client } from 'pg';
import { runMigrations } from '../../libs/db/src/lib/migrate';
import { loadDotEnv, need } from './load-env';

async function main() {
  loadDotEnv();
  const ownerUrl = need('MIGRATION_DATABASE_URL');
  const { applied } = await runMigrations(ownerUrl, resolve('db/migrations'));
  console.log(applied.length ? `Migrasi diterapkan: ${applied.join(', ')}` : 'Database sudah terbaru');

  const c = new Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await loginRole(c, need('POSTGRES_API_USER'), need('POSTGRES_API_PASSWORD'), 'clinicrme_app');
    await loginRole(c, need('POSTGRES_PLATFORM_USER'), need('POSTGRES_PLATFORM_PASSWORD'), 'clinicrme_platform');
  } finally {
    await c.end();
  }
  await ensureEmulatorBuckets();
}

/** Emulator GCS (docker compose): buat bucket bila belum ada. Bucket cloud dibuat Terraform, bukan skrip ini. */
async function ensureEmulatorBuckets() {
  const endpoint = process.env.STORAGE_GCS_ENDPOINT ?? '';
  if (process.env.STORAGE_DRIVER !== 'gcs' || !endpoint.startsWith('http://')) return;
  for (const name of [process.env.STORAGE_BUCKET_FILES ?? 'clinicrme-files', process.env.STORAGE_BUCKET_EXPORTS ?? 'clinicrme-exports']) {
    const r = await fetch(`${endpoint}/storage/v1/b`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    if (!r.ok && r.status !== 409) throw new Error(`gagal membuat bucket emulator ${name} (${r.status})`);
  }
  console.log('Bucket emulator GCS siap ✓');
}

/** Role LOGIN yang hanya anggota satu role grup; tidak pernah superuser/BYPASSRLS. */
async function loginRole(c: Client, user: string, password: string, group: 'clinicrme_app' | 'clinicrme_platform') {
  if (!/^[a-z_][a-z0-9_]{2,40}$/.test(user)) throw new Error(`Nama role tidak valid untuk ${group}`);
  await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${user}') THEN
                   CREATE ROLE ${user} LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$`);
  // Password lewat format() di server agar tidak pernah disusun sebagai string SQL di sisi klien
  await c.query(`SELECT set_config('crme.pw', $1, false)`, [password]);
  await c.query(`DO $$ BEGIN EXECUTE format('ALTER ROLE ${user} LOGIN NOBYPASSRLS PASSWORD %L', current_setting('crme.pw')); END $$`);
  await c.query(`SELECT set_config('crme.pw', '', false)`);
  await c.query(`GRANT ${group} TO ${user}`);
  const [r] = (await c.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, [user])).rows;
  if (r.rolsuper || r.rolbypassrls) throw new Error(`${user} tidak boleh superuser/BYPASSRLS`);
  console.log(`Role ${user}: LOGIN, anggota ${group}, NOBYPASSRLS ✓`);
}

main().catch((e) => { console.error(`dev:db gagal: ${e.message}`); process.exit(1); });
