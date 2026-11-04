import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { hash, verify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import type { Response } from 'express';
import type { AppConfig } from '@clinicrme/shared';
import { CONFIG, acceptTotpStep, ctx, decrypt, encrypt, problem, randomToken, sha256Hex } from '@clinicrme/shared';
import { PlatformDb, platformAudit, rows } from '@clinicrme/db';
import { PlatformSessionService } from './platform-session.service';

/** Parameter Argon2id sama dengan aplikasi klinik (SC-AUTH-03). */
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
let DUMMY_HASH: Promise<string> | undefined;

/**
 * Login konsol platform (CR-0001): email + password, lalu TOTP WAJIB untuk semua pengguna platform.
 * Tanpa Google. Setiap kegagalan diaudit di transaksi tersendiri (tidak ikut rollback).
 */
@Injectable()
export class PlatformAuthService {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig, private readonly db: PlatformDb,
              private readonly sessions: PlatformSessionService) {}

  static hashPassword(p: string) { return hash(p, ARGON2); }

  async login(email: string, password: string, res: Response, ua?: string): Promise<{ mfaEnrolled: boolean }> {
    const failed = () => problem(401, 'AUTH-401-INVALID', 'Email atau password salah');
    const recordFailure = (userId: string | null, summary: object, counters?: { attempts: number; lock: boolean }) =>
      this.db.tx(async (tx) => {
        if (userId && counters) {
          await tx.execute(sql`update platform_credential set failed_attempts = ${counters.lock ? 0 : counters.attempts},
                               locked_until = ${counters.lock ? new Date(Date.now() + this.cfg.lockoutMinutes * 60_000).toISOString() : null}
                               where user_id = ${userId}`);
        }
        await platformAudit(tx, 'PLATFORM_LOGIN_FAILED', { actor: userId, resourceType: 'platform_user', resourceId: userId, summary });
      });

    const [u] = await this.db.tx((tx) => rows(tx, sql`
      select u.id, u.status, c.password_hash, c.failed_attempts, c.locked_until,
             exists(select 1 from platform_mfa m where m.user_id = u.id) as mfa_enrolled
        from platform_user u left join platform_credential c on c.user_id = u.id
       where u.email = lower(${email})`));
    if (!u || !u.password_hash) {
      await verify(await (DUMMY_HASH ??= hash('dummy-password', ARGON2)), password).catch(() => false);
      await recordFailure(null, { reason: 'unknown_or_no_password' });
      throw failed();
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      await recordFailure(u.id, { reason: 'locked' });
      throw failed();
    }
    const ok = await verify(u.password_hash, password);
    if (!ok || u.status !== 'ACTIVE') {
      const attempts = (u.failed_attempts ?? 0) + 1;
      const lock = !ok && attempts >= this.cfg.lockoutThreshold;
      await recordFailure(u.id, { reason: ok ? 'disabled' : 'bad_password', attempts, locked: lock }, ok ? undefined : { attempts, lock });
      throw failed();
    }
    await this.db.tx(async (tx) => {
      await tx.execute(sql`update platform_credential set failed_attempts = 0, locked_until = null where user_id = ${u.id}`);
      await tx.execute(sql`update platform_user set last_login_at = now() where id = ${u.id}`);
      await this.sessions.create(tx, res, u.id, false, ctx().ip, ua);
      await platformAudit(tx, 'PLATFORM_LOGIN', { actor: u.id, resourceType: 'platform_user', resourceId: u.id,
                                                  summary: { mfaEnrolled: u.mfa_enrolled } });
    }, u.id);
    return { mfaEnrolled: u.mfa_enrolled === true };
  }

  /**
   * Pendaftaran TOTP hanya bila BELUM terdaftar. Berbeda dengan aplikasi klinik: password saja tidak cukup
   * untuk mengganti TOTP pengguna platform (pemulihan lewat admin platform lain — runbook Stage 15).
   */
  async enrollMfa(): Promise<{ otpauthUrl: string; recoveryCodes: string[] }> {
    const c = ctx();
    const secret = authenticator.generateSecret();
    const recovery = Array.from({ length: 8 }, () => randomToken(6));
    const email = await this.db.tx(async (tx) => {
      const [u] = await rows(tx, sql`select email from platform_user where id = ${c.platformUserId}`);
      const inserted = await rows(tx, sql`insert into platform_mfa(user_id, totp_secret_encrypted, recovery_codes_hash)
                           values (${c.platformUserId}, ${encrypt(this.cfg.encryptionKeyHex, secret)},
                                   array(select jsonb_array_elements_text(${JSON.stringify(recovery.map(sha256Hex))}::jsonb)))
                           on conflict (user_id) do nothing returning user_id`);
      if (!inserted.length) return null;
      await platformAudit(tx, 'PLATFORM_MFA_ENROLLED', { resourceType: 'platform_user', resourceId: c.platformUserId });
      return u.email as string;
    }, c.platformUserId);
    if (!email) throw problem(409, 'AUTH-409-MFA-ENROLLED', 'TOTP sudah terdaftar');
    return { otpauthUrl: authenticator.keyuri(email, 'ClinicRME Platform', secret), recoveryCodes: recovery };
  }

  async verifyMfa(code: string, res: Response) {
    const c = ctx();
    const ok = await this.db.tx(async (tx) => {
      const [m] = await rows(tx, sql`select totp_secret_encrypted, recovery_codes_hash, last_totp_step from platform_mfa
                                     where user_id = ${c.platformUserId} for update`);
      if (!m) throw problem(409, 'AUTH-409-MFA-NOT-ENROLLED', 'MFA belum didaftarkan');
      const secret = decrypt(this.cfg.encryptionKeyHex, m.totp_secret_encrypted);
      const step = /^\d{6}$/.test(code) ? acceptTotpStep(authenticator.checkDelta(code, secret), m.last_totp_step) : null;
      let valid = step !== null;
      if (valid) await tx.execute(sql`update platform_mfa set last_totp_step = ${step} where user_id = ${c.platformUserId}`);
      let method = 'totp';
      if (!valid && m.recovery_codes_hash.includes(sha256Hex(code))) {
        await tx.execute(sql`update platform_mfa set recovery_codes_hash = array_remove(recovery_codes_hash, ${sha256Hex(code)})
                             where user_id = ${c.platformUserId}`);
        valid = true; method = 'recovery_code';
      }
      if (!valid) return false;
      await tx.execute(sql`update platform_session set revoked_at = now(), revoke_reason = 'ROTATED_MFA' where id = ${c.platformSessionId}`);
      await this.sessions.create(tx, res, c.platformUserId!, true, c.ip, c.userAgent);
      await platformAudit(tx, 'PLATFORM_MFA_VERIFIED', { resourceType: 'platform_user', resourceId: c.platformUserId, summary: { method } });
      return true;
    }, c.platformUserId);
    if (ok) return;
    const revoked = await this.db.tx(async (tx) => {
      const [s] = await rows(tx, sql`update platform_session set mfa_failed_attempts = mfa_failed_attempts + 1
                                     where id = ${c.platformSessionId} returning mfa_failed_attempts`);
      const limit = s.mfa_failed_attempts >= this.cfg.mfaMaxAttempts;
      if (limit) await tx.execute(sql`update platform_session set revoked_at = now(), revoke_reason = 'MFA_ATTEMPTS' where id = ${c.platformSessionId}`);
      await platformAudit(tx, 'PLATFORM_MFA_FAILED', { resourceType: 'platform_user', resourceId: c.platformUserId,
                                                       summary: { attempts: s.mfa_failed_attempts, session_revoked: limit } });
      return limit;
    }, c.platformUserId);
    if (revoked) this.sessions.clearCookies(res);
    throw problem(401, 'AUTH-401-MFA-INVALID', 'Kode MFA salah');
  }

  async logout(res: Response) {
    const c = ctx();
    await this.db.tx(async (tx) => {
      await tx.execute(sql`update platform_session set revoked_at = now(), revoke_reason = 'LOGOUT' where id = ${c.platformSessionId}`);
      await platformAudit(tx, 'PLATFORM_LOGOUT', { resourceType: 'platform_user', resourceId: c.platformUserId });
    }, c.platformUserId);
    this.sessions.clearCookies(res);
  }
}
