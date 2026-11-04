import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { hash, verify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Response } from 'express';
import type { AppConfig } from '@clinicrme/shared';
import { CONFIG, acceptTotpStep, ctx, decrypt, encrypt, pkceChallenge, problem, randomToken, sha256Hex, sign, verifySigned } from '@clinicrme/shared';
import { Db, Tx, audit, rows } from '@clinicrme/db';
import { SessionService } from './session.service';
import { assignInvitationRoles } from './assign-roles';

export const OIDC_COOKIE = 'crme_oidc';

/** Parameter Argon2id (SC-AUTH-03; OWASP: m ≥ 19 MiB, t ≥ 2). */
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const suspended = () => problem(403, 'TEN-403-SUSPENDED', 'Layanan klinik sedang ditangguhkan. Hanya admin klinik yang dapat masuk.');
/** Hash dummy untuk menyamakan waktu respons saat email tidak terdaftar (SC-AUTH-04). */
let DUMMY_HASH: Promise<string> | undefined;

@Injectable()
export class AuthService {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private discovery?: { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string };

  constructor(@Inject(CONFIG) private readonly cfg: AppConfig, private readonly db: Db, private readonly sessions: SessionService) {}

  static hashPassword(p: string) { return hash(p, ARGON2); }

  // ------------------------------------------------------------------ Password (IAM-FR-003)
  async passwordLogin(tenantId: string, email: string, password: string, res: Response, ua?: string) {
    const failed = () => problem(401, 'AUTH-401-INVALID', 'Email atau password salah');
    // Catatan kegagalan (penghitung lockout + audit) WAJIB di-commit di transaksi tersendiri.
    // Bila ditulis di transaksi yang sama lalu error dilempar, rollback menghapusnya → lockout tidak pernah terjadi
    // dan percobaan tidak teraudit (temuan uji E04).
    const recordFailure = (userId: string | null, summary: object, counters?: { attempts: number; lock: boolean }) =>
      this.db.withTenant(tenantId, async (tx) => {
        if (userId && counters) {
          await tx.execute(sql`update user_credential set failed_attempts = ${counters.lock ? 0 : counters.attempts},
                               locked_until = ${counters.lock ? new Date(Date.now() + this.cfg.lockoutMinutes * 60_000).toISOString() : null}
                               where user_id = ${userId}`);
        }
        await audit(tx, 'LOGIN_FAILED', 'app_user', userId, null, summary);
      });

    const [u] = await this.db.withTenant(tenantId, (tx) => rows(tx, sql`
        select u.id, u.status, c.password_hash, c.failed_attempts, c.locked_until
          from app_user u left join user_credential c on c.user_id = u.id
         where lower(u.email) = lower(${email})`));
    if (!u || !u.password_hash) {
      await verify(await (DUMMY_HASH ??= hash('dummy-password', ARGON2)), password).catch(() => false);
      await recordFailure(null, { reason: 'unknown_or_no_password' });
      throw failed();
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      await recordFailure(u.id, { reason: 'locked' });
      throw failed();  // respons sama — tidak membocorkan status lockout
    }
    const ok = await verify(u.password_hash, password);
    if (!ok || u.status !== 'ACTIVE') {
      const attempts = (u.failed_attempts ?? 0) + 1;
      const lock = !ok && attempts >= this.cfg.lockoutThreshold;
      await recordFailure(u.id, { reason: ok ? 'disabled' : 'bad_password', attempts, locked: lock }, ok ? undefined : { attempts, lock });
      throw failed();
    }
    if (!(await this.db.withTenant(tenantId, (tx) => this.allowedWhileSuspended(tx, u.id)))) {
      await recordFailure(u.id, { reason: 'tenant_suspended' });
      throw suspended();
    }
    await this.db.withTenant(tenantId, async (tx) => {
      await tx.execute(sql`update user_credential set failed_attempts = 0, locked_until = null where user_id = ${u.id}`);
      await this.startSession(tx, res, tenantId, u.id, 'password', ua);
    });
  }

  /** PLT-FR-006: saat tenant SUSPENDED hanya pemegang role TENANT_ADMIN yang boleh masuk. */
  private async allowedWhileSuspended(tx: Tx, userId: string): Promise<boolean> {
    if (ctx().hostTenantStatus !== 'SUSPENDED') return true;
    const [r] = await rows(tx, sql`select exists(select 1 from user_role_assignment a join role r on r.id = a.role_id
                                                  where a.user_id = ${userId} and r.code = 'TENANT_ADMIN'
                                                    and (a.valid_to is null or a.valid_to > now())) as ok`);
    return r.ok === true;
  }

  private async startSession(tx: Tx, res: Response, tenantId: string, userId: string, method: string, ua?: string) {
    const [m] = await rows(tx, sql`select exists(select 1 from user_role_assignment a join role r on r.id = a.role_id
                                                  where a.user_id = ${userId} and r.requires_mfa
                                                    and (a.valid_to is null or a.valid_to > now())) as required`);
    await this.sessions.create(tx, res, tenantId, userId, !m.required, ctx().ip, ua);
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    await audit(tx, 'LOGIN', 'app_user', userId, null, { method, mfaPending: m.required });
  }

  // ------------------------------------------------------------------ TOTP (IAM-FR-005)
  async enrollMfa(): Promise<{ otpauthUrl: string; recoveryCodes: string[] }> {
    const c = ctx();
    const secret = authenticator.generateSecret();
    const recovery = Array.from({ length: 8 }, () => randomToken(6));
    const email = await this.db.withTenantTx(async (tx) => {
      const [u] = await rows(tx, sql`select email from app_user where id = ${c.userId}`);
      // Mengganti authenticator hanya dari sesi yang SUDAH lolos MFA — sesi password saja tidak boleh
      // menimpa secret lama (itu sama dengan melewati MFA).
      const [existing] = await rows(tx, sql`select 1 from user_mfa where user_id = ${c.userId}`);
      if (existing && !c.mfaVerified) throw problem(409, 'AUTH-409-MFA-ENROLLED', 'MFA sudah terdaftar. Verifikasi dengan kode dari authenticator Anda.');
      await tx.execute(sql`insert into user_mfa(tenant_id, user_id, totp_secret_encrypted, recovery_codes_hash)
                           values (${c.tenantId}, ${c.userId}, ${encrypt(this.cfg.encryptionKeyHex, secret)},
                                   array(select jsonb_array_elements_text(${JSON.stringify(recovery.map(sha256Hex))}::jsonb)))
                           on conflict (tenant_id, user_id) do update set totp_secret_encrypted = excluded.totp_secret_encrypted,
                             recovery_codes_hash = excluded.recovery_codes_hash, enabled_at = now(), last_totp_step = null`);
      await audit(tx, 'MFA_ENROLLED', 'app_user', c.userId!);
      return u.email as string;
    });
    return { otpauthUrl: authenticator.keyuri(email, 'ClinicRME', secret), recoveryCodes: recovery };
  }

  /**
   * Verifikasi TOTP / recovery code (SC-AUTH-05). Berhasil → sesi dirotasi (ID baru, sesi lama dicabut; SC-AUTH-06).
   * Gagal → dicatat di transaksi terpisah agar tidak ikut di-rollback; batas percobaan per sesi → sesi dicabut.
   */
  async verifyMfa(code: string, res: Response) {
    const c = ctx();
    const ok = await this.db.withTenantTx(async (tx) => {
      const [m] = await rows(tx, sql`select totp_secret_encrypted, recovery_codes_hash, last_totp_step from user_mfa where user_id = ${c.userId} for update`);
      if (!m) throw problem(409, 'AUTH-409-MFA-NOT-ENROLLED', 'MFA belum didaftarkan');
      const secret = decrypt(this.cfg.encryptionKeyHex, m.totp_secret_encrypted);
      const step = /^\d{6}$/.test(code) ? acceptTotpStep(authenticator.checkDelta(code, secret), m.last_totp_step) : null;
      let valid = step !== null;
      if (valid) await tx.execute(sql`update user_mfa set last_totp_step = ${step} where user_id = ${c.userId}`);
      let method = 'totp';
      if (!valid && m.recovery_codes_hash.includes(sha256Hex(code))) {   // recovery code sekali pakai
        await tx.execute(sql`update user_mfa set recovery_codes_hash = array_remove(recovery_codes_hash, ${sha256Hex(code)}) where user_id = ${c.userId}`);
        valid = true; method = 'recovery_code';
      }
      if (!valid) return false;
      await tx.execute(sql`update user_session set revoked_at = now(), revoke_reason = 'ROTATED_MFA' where id = ${c.sessionId}`);
      await this.sessions.create(tx, res, c.tenantId!, c.userId!, true, c.ip, c.userAgent);
      await audit(tx, 'MFA_VERIFIED', 'app_user', c.userId!, null, { method });
      return true;
    });
    if (ok) return;
    const revoked = await this.db.withTenantTx(async (tx) => {
      const [s] = await rows(tx, sql`update user_session set mfa_failed_attempts = mfa_failed_attempts + 1
                                     where id = ${c.sessionId} returning mfa_failed_attempts`);
      const limit = s.mfa_failed_attempts >= this.cfg.mfaMaxAttempts;
      if (limit) await tx.execute(sql`update user_session set revoked_at = now(), revoke_reason = 'MFA_ATTEMPTS' where id = ${c.sessionId}`);
      await audit(tx, 'MFA_FAILED', 'app_user', c.userId!, null, { attempts: s.mfa_failed_attempts, session_revoked: limit });
      return limit;
    });
    if (revoked) this.sessions.clearCookies(res);
    throw problem(401, 'AUTH-401-MFA-INVALID', 'Kode MFA salah');
  }

  // ------------------------------------------------------------------ Google OIDC (IAM-FR-002, ADR-0003)
  private async oidc() {
    if (!this.discovery) {
      const r = await fetch(`${this.cfg.google.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
      this.discovery = (await r.json()) as AuthService["discovery"];
      this.jwks = createRemoteJWKSet(new URL(this.discovery!.jwks_uri));
    }
    return this.discovery!;
  }

  async googleStart(tenantId: string, res: Response): Promise<string> {
    const d = await this.oidc();
    const state = randomToken(16), nonce = randomToken(16), verifier = randomToken(32);
    res.cookie(OIDC_COOKIE, sign(this.cfg.encryptionKeyHex, { state, nonce, verifier, tenantId, exp: Date.now() + 10 * 60_000 }),
               { httpOnly: true, secure: this.cfg.cookieSecure, sameSite: 'lax', path: '/api/v1/auth/google', maxAge: 10 * 60_000 });
    const u = new URL(d.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code', client_id: this.cfg.google.clientId, redirect_uri: this.cfg.google.redirectUri,
      scope: 'openid email profile', state, nonce, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return u.toString();
  }

  async googleCallback(tenantId: string, query: { code?: string; state?: string }, cookie: string | undefined, res: Response, ua?: string) {
    const deny = (code: string, title: string, status = 401) => problem(status, code, title);
    const st = verifySigned<{ state: string; nonce: string; verifier: string; tenantId: string; exp: number }>(this.cfg.encryptionKeyHex, cookie);
    res.clearCookie(OIDC_COOKIE, { path: '/api/v1/auth/google' });
    if (!st || st.exp < Date.now() || !query.state || st.state !== query.state) throw deny('AUTH-401-STATE', 'State OAuth tidak valid');
    if (st.tenantId !== tenantId) throw deny('AUTH-401-STATE', 'State OAuth tidak valid');
    if (!query.code) throw deny('AUTH-401-CODE', 'Kode otorisasi tidak ada');

    const d = await this.oidc();
    const tr = await fetch(d.token_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: this.cfg.google.redirectUri,
                                  client_id: this.cfg.google.clientId, client_secret: this.cfg.google.clientSecret, code_verifier: st.verifier }),
    });
    if (!tr.ok) throw deny('AUTH-401-TOKEN', 'Pertukaran token gagal');
    const { id_token } = await tr.json() as { id_token?: string };
    if (!id_token) throw deny('AUTH-401-TOKEN', 'id_token tidak ada');

    let claims: Record<string, any>;
    try {
      ({ payload: claims } = await jwtVerify(id_token, this.jwks!, { issuer: d.issuer, audience: this.cfg.google.clientId }));
    } catch {
      throw deny('AUTH-401-ID-TOKEN', 'id_token tidak valid');
    }
    if (claims.nonce !== st.nonce) throw deny('AUTH-401-NONCE', 'Nonce tidak cocok');
    if (claims.email_verified !== true || !claims.sub || !claims.email) throw deny('AUTH-401-EMAIL', 'Email Google belum terverifikasi');

    const outcome = await this.db.withTenant(tenantId, async (tx) => {
      let [ident] = await rows(tx, sql`select user_id from user_identity where provider = 'google' and subject = ${claims.sub}`);
      if (!ident) {
        // Penautan pertama hanya bila ada undangan aktif untuk email ini (SC-AUTH-01)
        const [inv] = await rows(tx, sql`select id, role_ids, branch_ids from user_invitation
                                          where lower(email) = lower(${claims.email}) and accepted_at is null and expires_at > now()
                                          order by created_at desc limit 1`);
        const [existing] = await rows(tx, sql`select id from app_user where lower(email) = lower(${claims.email})`);
        if (!inv && !existing) return { denied: 'NOT_INVITED' as const, userId: null };
        // Akun ada tetapi belum tertaut ke Google → harus lewat undangan penautan, bukan cocok email otomatis
        if (!inv && existing) return { denied: 'LINK_REQUIRED' as const, userId: existing.id as string };
        const userId = existing?.id ?? (await rows(tx, sql`insert into app_user(tenant_id, email, full_name)
                                         values (${tenantId}, ${claims.email}, ${claims.name ?? claims.email}) returning id`))[0].id;
        await tx.execute(sql`insert into user_identity(tenant_id, user_id, provider, subject, email_at_link)
                             values (${tenantId}, ${userId}, 'google', ${claims.sub}, ${claims.email})`);
        await assignInvitationRoles(tx, userId, inv.role_ids as string[], (inv.branch_ids ?? []) as string[]);
        await tx.execute(sql`update user_invitation set accepted_at = now(), accepted_user_id = ${userId} where id = ${inv.id}`);
        await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
        await audit(tx, 'IDENTITY_LINKED', 'app_user', userId, null, { provider: 'google' });
        ident = { user_id: userId };
      }
      const [u] = await rows(tx, sql`select status from app_user where id = ${ident.user_id}`);
      if (u.status !== 'ACTIVE') return { denied: 'DISABLED' as const, userId: ident.user_id as string };
      if (!(await this.allowedWhileSuspended(tx, ident.user_id))) return { denied: 'SUSPENDED' as const, userId: ident.user_id as string };
      await this.startSession(tx, res, tenantId, ident.user_id, 'google', ua);
      return { denied: null, userId: ident.user_id as string };
    });
    if (outcome.denied) {
      // Audit penolakan di transaksi tersendiri agar tidak ikut rollback (lihat passwordLogin)
      await this.db.withTenant(tenantId, (tx) => audit(tx, 'LOGIN_FAILED', 'app_user', outcome.userId, null,
                                                         { reason: `google_${outcome.denied!.toLowerCase()}` }));
      if (outcome.denied === 'NOT_INVITED') throw deny('AUTH-403-NOT-INVITED', 'Akun belum terdaftar di klinik. Hubungi admin klinik.', 403);
      if (outcome.denied === 'SUSPENDED') throw suspended();
      if (outcome.denied === 'LINK_REQUIRED') throw deny('AUTH-403-LINK-REQUIRED', 'Akun belum ditautkan ke Google. Minta undangan penautan dari admin klinik.', 403);
      throw deny('AUTH-401-INVALID', 'Akun tidak aktif');
    }
  }
}
