import { sql } from 'drizzle-orm';
import { verify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { type AppConfig, acceptTotpStep, ctx, decrypt, problem } from '@clinicrme/shared';
import { type Db, audit, rows } from '@clinicrme/db';

/** Konfirmasi ulang identitas saat mengesahkan (OD-034): kata sandi akun ATAU kode TOTP dari aplikasi autentikator. */
export const ReauthFields = {
  password: z.string().min(1).max(200).optional(),
  code: z.string().regex(/^\d{6}$/, 'Kode 6 digit').optional(),
};
export const hasReauth = (b: { password?: string; code?: string }) => !!b.password !== !!b.code;
export const REAUTH_MESSAGE = 'Isi salah satu: kata sandi atau kode autentikator 6 digit';
const MAX_FAILURES = 5;
const WINDOW_MINUTES = 15;

/**
 * Memeriksa kata sandi / TOTP user yang login. Gagal dicatat di transaksi tersendiri (tidak ikut rollback) dan dibatasi
 * 5 kali per 15 menit per user. TOTP memakai penjaga replay yang sama dengan login (langkah waktu tidak boleh dipakai ulang).
 */
export async function reauthenticate(db: Db, cfg: AppConfig, b: { password?: string; code?: string }): Promise<'PASSWORD' | 'TOTP'> {
  const c = ctx();
  const method = b.code ? 'TOTP' : 'PASSWORD';
  const ok = await db.withTenantTx(async (tx) => {
    const [{ n }] = await rows<{ n: number }>(tx, sql`
      select count(*)::int as n from audit_log where actor_user_id = ${c.userId} and action = 'CLINICAL_REAUTH_FAILED'
         and occurred_at > now() - make_interval(mins => ${WINDOW_MINUTES})`);
    if (n >= MAX_FAILURES) throw problem(429, 'CLN-429-REAUTH', `Terlalu banyak percobaan. Coba lagi dalam ${WINDOW_MINUTES} menit.`);
    if (b.code) {
      const [m] = await rows<{ totp_secret_encrypted: Buffer; last_totp_step: string | null }>(tx, sql`
        select totp_secret_encrypted, last_totp_step from user_mfa where user_id = ${c.userId} for update`);
      if (!m) throw problem(400, 'CLN-400-NO-MFA', 'Aplikasi autentikator belum didaftarkan. Gunakan kata sandi.');
      const step = acceptTotpStep(authenticator.checkDelta(b.code, decrypt(cfg.encryptionKeyHex, m.totp_secret_encrypted)), m.last_totp_step);
      if (step === null) return false;
      await tx.execute(sql`update user_mfa set last_totp_step = ${step} where user_id = ${c.userId}`);
      return true;
    }
    const [cr] = await rows<{ password_hash: string }>(tx, sql`select password_hash from user_credential where user_id = ${c.userId}`);
    if (!cr) throw problem(400, 'CLN-400-NO-PASSWORD', 'Akun ini tidak memakai kata sandi. Gunakan kode autentikator.');
    return verify(cr.password_hash, b.password ?? '').catch(() => false);
  });
  if (!ok) {
    await db.withTenantTx((tx) => audit(tx, 'CLINICAL_REAUTH_FAILED', 'app_user', c.userId ?? null, null, { method }));
    throw problem(403, 'CLN-403-REAUTH', method === 'TOTP' ? 'Kode autentikator tidak cocok' : 'Kata sandi tidak cocok');
  }
  return method;
}
