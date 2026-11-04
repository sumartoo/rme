import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { AppConfig, CONFIG } from './config';
import { Db, Tx, rows } from './db';
import { randomToken, sha256Hex } from './crypto';

export const SESSION_COOKIE = 'crme_session';
export const CSRF_COOKIE = 'crme_csrf';

export interface ResolvedSession {
  session_id: string; tenant_id: string; user_id: string; branch_id: string | null;
  mfa_verified: boolean; last_seen_at: Date; expires_at: Date; revoked_at: Date | null; user_status: string;
}

@Injectable()
export class SessionService {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig, private readonly db: Db) {}

  /** Buat sesi dalam transaksi tenant yang sedang berjalan; set cookie sesi + CSRF (SC-AUTH-06, SC-WEB-02). */
  async create(tx: Tx, res: Response, tenantId: string, userId: string, mfaVerified: boolean, ip?: string, ua?: string) {
    const token = randomToken();
    const expires = new Date(Date.now() + this.cfg.sessionAbsoluteHours * 3600_000);
    await tx.execute(sql`insert into user_session(tenant_id, user_id, mfa_verified, ip, user_agent, expires_at, token_hash)
                         values (${tenantId}, ${userId}, ${mfaVerified}, ${ip ?? null}::inet, ${ua ?? null}, ${expires.toISOString()}, ${sha256Hex(token)})`);
    await tx.execute(sql`update app_user set last_login_at = now() where id = ${userId}`);
    const base = { secure: this.cfg.cookieSecure, sameSite: 'lax' as const, path: '/', expires };
    res.cookie(SESSION_COOKIE, token, { ...base, httpOnly: true });
    res.cookie(CSRF_COOKIE, randomToken(16), { ...base, httpOnly: false });
  }

  async resolve(token: string | undefined): Promise<ResolvedSession | null> {
    if (!token || token.length < 40) return null;
    const r = await this.db.preAuth<ResolvedSession>(sql`select * from app.resolve_session(${sha256Hex(token)})`);
    return r[0] ?? null;
  }

  isUsable(s: ResolvedSession, hostTenantId: string | undefined): { ok: true } | { ok: false; reason: string } {
    if (!hostTenantId || s.tenant_id !== hostTenantId) return { ok: false, reason: 'TENANT_MISMATCH' };
    if (s.revoked_at) return { ok: false, reason: 'REVOKED' };
    if (new Date(s.expires_at) <= new Date()) return { ok: false, reason: 'EXPIRED' };
    if (Date.now() - new Date(s.last_seen_at).getTime() > this.cfg.sessionIdleMinutes * 60_000) return { ok: false, reason: 'IDLE_TIMEOUT' };
    if (s.user_status !== 'ACTIVE') return { ok: false, reason: 'USER_DISABLED' };
    return { ok: true };
  }

  async touch(tx: Tx, sessionId: string) {
    await tx.execute(sql`update user_session set last_seen_at = now() where id = ${sessionId}`);
  }

  async revokeAllForUser(tx: Tx, userId: string, reason: string) {
    const r = await rows(tx, sql`update user_session set revoked_at = now(), revoke_reason = ${reason}
                                 where user_id = ${userId} and revoked_at is null returning id`);
    return r.length;
  }

  clearCookies(res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
  }
}
