// `pnpm dev:seed` — data DEMO sintetis untuk pengembangan lokal (tenant "demo"). Idempoten.
// TIDAK untuk staging/produksi: skrip menolak berjalan bila APP_ENV bukan local.
import { Client } from 'pg';
import { hash } from '@node-rs/argon2';
import { loadDotEnv, need } from './load-env';

const TENANT = 'dddddddd-0000-0000-0000-000000000000';
const USERS = [
  { email: 'admin@demo.test', name: 'Admin Demo', role: 'TENANT_ADMIN' },
  { email: 'dokter@demo.test', name: 'dr. Demo', role: 'DOKTER' },
  { email: 'perawat@demo.test', name: 'Perawat Demo', role: 'PERAWAT' },
  { email: 'pendaftaran@demo.test', name: 'Pendaftaran Demo', role: 'PENDAFTARAN' },
  { email: 'kasir@demo.test', name: 'Kasir Demo', role: 'KASIR' },
];

async function main() {
  loadDotEnv();
  if (process.env.APP_ENV !== 'local') throw new Error('dev:seed hanya untuk APP_ENV=local');
  const password = need('DEV_SEED_PASSWORD');
  const pwHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const c = new Client({ connectionString: need('MIGRATION_DATABASE_URL') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET search_path = app, public`);
    await c.query(`INSERT INTO tenant(id, code, legal_name, display_name, tenant_type, status)
                   VALUES ($1, 'demo', 'PT Klinik Demo (sintetis)', 'Klinik Demo', 'KLINIK_PRATAMA', 'ACTIVE')
                   ON CONFLICT (id) DO NOTHING`, [TENANT]);
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
    await c.query(`SELECT app.create_template_roles()`);
    for (const u of USERS) {
      const { rows: [row] } = await c.query(
        `INSERT INTO app_user(tenant_id, email, full_name) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING id`, [TENANT, u.email, u.name]);
      const id = row?.id ?? (await c.query(`SELECT id FROM app_user WHERE tenant_id = $1 AND lower(email) = $2`, [TENANT, u.email])).rows[0].id;
      await c.query(`INSERT INTO user_credential(tenant_id, user_id, password_hash) VALUES ($1, $2, $3)
                     ON CONFLICT (tenant_id, user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash,
                       failed_attempts = 0, locked_until = NULL`, [TENANT, id, pwHash]);
      await c.query(`INSERT INTO user_role_assignment(tenant_id, user_id, role_id)
                     SELECT $1, $2, id FROM role WHERE tenant_id = $1 AND code = $3
                     AND NOT EXISTS (SELECT 1 FROM user_role_assignment a JOIN role r ON r.id = a.role_id
                                      WHERE a.user_id = $2 AND r.code = $3)`, [TENANT, id, u.role]);
    }
    // Admin konsol platform (CR-0001): http://admin.localhost:3000 — TOTP didaftarkan saat login pertama
    const { rows: [pu] } = await c.query(
      `INSERT INTO platform_user(email, full_name, roles) VALUES ('admin@platform.test', 'Admin Platform Demo', ARRAY['PLATFORM_ADMIN'])
       ON CONFLICT (email) DO UPDATE SET status = 'ACTIVE' RETURNING id`);
    await c.query(`INSERT INTO platform_credential(user_id, password_hash) VALUES ($1, $2)
                   ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_attempts = 0, locked_until = NULL`,
                  [pu.id, pwHash]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
  console.log('Tenant demo siap: aplikasi klinik http://demo.localhost:4200 · API http://demo.localhost:3000');
  console.log(`Akun: ${USERS.map((u) => `${u.email} (${u.role})`).join(', ')}`);
  console.log('Konsol platform: http://admin.localhost:3000 — akun admin@platform.test (PLATFORM_ADMIN, wajib TOTP)');
  console.log('Password semua akun demo: nilai DEV_SEED_PASSWORD di .env');
}

main().catch((e) => { console.error(`dev:seed gagal: ${e.message}`); process.exit(1); });
