// `pnpm dev:reset-mfa <email>` — LOKAL SAJA: menghapus TOTP pengguna konsol platform (mis. QR belum sempat di-scan),
// mencabut sesinya, dan membuka lockout. Login berikutnya akan diminta mendaftar TOTP lagi. Aksi dicatat di platform_audit_log.
// Di staging/produksi pemulihan TOTP lewat runbook dengan admin platform kedua (RSK-023), bukan skrip ini.
import { Client } from 'pg';
import { loadDotEnv, need } from './load-env';

async function main() {
  loadDotEnv();
  if (process.env.APP_ENV !== 'local') throw new Error('dev:reset-mfa hanya untuk APP_ENV=local');
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('Pemakaian: pnpm dev:reset-mfa <email pengguna platform>');
  const c = new Client({ connectionString: need('MIGRATION_DATABASE_URL') });
  await c.connect();
  try {
    await c.query('BEGIN');
    const { rows: [u] } = await c.query(`SELECT id FROM app.platform_user WHERE email = $1`, [email]);
    if (!u) throw new Error(`Pengguna platform ${email} tidak ditemukan`);
    const mfa = await c.query(`DELETE FROM app.platform_mfa WHERE user_id = $1`, [u.id]);
    const ses = await c.query(`UPDATE app.platform_session SET revoked_at = now(), revoke_reason = 'MFA_RESET'
                               WHERE user_id = $1 AND revoked_at IS NULL`, [u.id]);
    await c.query(`UPDATE app.platform_credential SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1`, [u.id]);
    await c.query(`INSERT INTO app.platform_audit_log(actor_platform_user, action, resource_type, resource_id, change_summary)
                   VALUES (NULL, 'PLATFORM_MFA_RESET', 'platform_user', $1, '{"via":"tools/dev/reset-platform-mfa (lokal)"}')`, [u.id]);
    await c.query('COMMIT');
    console.log(`${email}: TOTP ${mfa.rowCount ? 'dihapus' : 'memang belum terdaftar'}, ${ses.rowCount} sesi dicabut, lockout dibuka.`);
    console.log('Login lagi di http://localhost:4300 — Anda akan diminta mendaftarkan authenticator.');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(`dev:reset-mfa gagal: ${e.message}`); process.exit(1); });
