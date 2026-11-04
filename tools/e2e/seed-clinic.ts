// Klinik uji aplikasi klinik (W##), dibuat SETELAH uji konsol (U02 mengharapkan daftar tenant kosong).
// Jalur resmi provision_tenant, lalu dua user sintetis ber-password: admin klinik (wajib TOTP) dan kasir.
import { Client } from 'pg';
import { hash } from '@node-rs/argon2';
import { CLINIC_CODE, USER_PASSWORD, dbUrl } from './config';

export async function seedClinic(): Promise<void> {
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  try {
    const pw = await hash(USER_PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const { rows: [t] } = await c.query(`SELECT app.provision_tenant($1, 'PT Klinik Web E2E (sintetis)', 'Klinik Web E2E', 'KLINIK_PRATAMA',
      (SELECT id FROM app.subscription_plan WHERE code = 'PILOT'), 14, 'admin@klinik-web.test', 'e2e-invite-hash', NULL) AS id`, [CLINIC_CODE]);
    for (const [email, name, role] of [['admin@klinik-web.test', 'Admin Klinik E2E', 'TENANT_ADMIN'], ['kasir@klinik-web.test', 'Kasir E2E', 'KASIR']]) {
      const { rows: [u] } = await c.query(`INSERT INTO app.app_user(tenant_id, email, full_name) VALUES ($1, $2, $3) RETURNING id`, [t.id, email, name]);
      await c.query(`INSERT INTO app.user_credential(tenant_id, user_id, password_hash) VALUES ($1, $2, $3)`, [t.id, u.id, pw]);
      await c.query(`INSERT INTO app.user_role_assignment(tenant_id, user_id, role_id) SELECT $1, $2, id FROM app.role WHERE tenant_id = $1 AND code = $3`, [t.id, u.id, role]);
    }
  } finally {
    await c.end();
  }
}
