// Klinik uji aplikasi klinik (W##), dibuat SETELAH uji konsol (U02 mengharapkan daftar tenant kosong).
// Jalur resmi provision_tenant, lalu dua user sintetis ber-password: admin klinik (wajib TOTP) dan kasir.
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { hash } from '@node-rs/argon2';
import { CLINIC_CODE, USER_PASSWORD, dbUrl } from './config';

/** Uji E2E tidak menjalankan pengirim email: tetapkan token tautan yang diketahui langsung (hanya hash yang disimpan, seperti worker). */
export async function setLinkToken(kind: 'invitation' | 'reset', email: string, token: string): Promise<void> {
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  try {
    const hash = createHash('sha256').update(token).digest('hex');
    const q = kind === 'invitation'
      ? `UPDATE app.user_invitation SET token_hash = $2 WHERE lower(email) = lower($1) AND accepted_at IS NULL`
      : `UPDATE app.password_reset_request SET token_hash = $2 WHERE user_id = (SELECT id FROM app.app_user WHERE lower(email) = lower($1)) AND used_at IS NULL`;
    const r = await c.query(q, [email, hash]);
    if (!r.rowCount) throw new Error(`tidak ada ${kind} aktif untuk ${email}`);
  } finally {
    await c.end();
  }
}

export async function seedClinic(): Promise<void> {
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  try {
    const pw = await hash(USER_PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const { rows: [t] } = await c.query(`SELECT app.provision_tenant($1, 'PT Klinik Web E2E (sintetis)', 'Klinik Web E2E', 'KLINIK_PRATAMA',
      (SELECT id FROM app.subscription_plan WHERE code = 'PILOT'), 14, 'admin@klinik-web.test', 'e2e-invite-hash', NULL) AS id`, [CLINIC_CODE]);
    // Dua cabang (kuota paket PILOT = 2) untuk uji pilih cabang aktif (IAM-FR-009)
    const { rows: [f] } = await c.query(`INSERT INTO app.facility(tenant_id, name, facility_type) VALUES ($1, 'Klinik Web E2E', 'KLINIK_PRATAMA') RETURNING id`, [t.id]);
    for (const [code, name] of [['UTM', 'Cabang Utama'], ['TMR', 'Cabang Timur']]) {
      await c.query(`INSERT INTO app.branch(tenant_id, facility_id, code, name) VALUES ($1, $2, $3, $4)`, [t.id, f.id, code, name]);
    }
    for (const [email, name, role] of [['admin@klinik-web.test', 'Admin Klinik E2E', 'TENANT_ADMIN'], ['kasir@klinik-web.test', 'Kasir E2E', 'KASIR']]) {
      const { rows: [u] } = await c.query(`INSERT INTO app.app_user(tenant_id, email, full_name) VALUES ($1, $2, $3) RETURNING id`, [t.id, email, name]);
      await c.query(`INSERT INTO app.user_credential(tenant_id, user_id, password_hash) VALUES ($1, $2, $3)`, [t.id, u.id, pw]);
      await c.query(`INSERT INTO app.user_role_assignment(tenant_id, user_id, role_id) SELECT $1, $2, id FROM app.role WHERE tenant_id = $1 AND code = $3`, [t.id, u.id, role]);
    }
  } finally {
    await c.end();
  }
}

/** User sintetis tambahan untuk uji tahap berikutnya (Stage 8+); ditambah saat uji itu mulai agar jumlah user uji lama tidak berubah. */
export async function addClinicUser(email: string, name: string, role: string): Promise<void> {
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  try {
    const pw = await hash(USER_PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const { rows: [t] } = await c.query(`SELECT id FROM app.tenant WHERE code = $1`, [CLINIC_CODE]);
    const { rows: [u] } = await c.query(`INSERT INTO app.app_user(tenant_id, email, full_name) VALUES ($1, $2, $3)
                                         ON CONFLICT DO NOTHING RETURNING id`, [t.id, email, name]);
    if (!u) return;
    await c.query(`INSERT INTO app.user_credential(tenant_id, user_id, password_hash) VALUES ($1, $2, $3)`, [t.id, u.id, pw]);
    await c.query(`INSERT INTO app.user_role_assignment(tenant_id, user_id, role_id) SELECT $1, $2, id FROM app.role WHERE tenant_id = $1 AND code = $3`, [t.id, u.id, role]);
  } finally {
    await c.end();
  }
}
