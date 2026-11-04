import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import type { AppConfig } from '@clinicrme/shared';
import { CONFIG, randomToken, sha256Hex } from '@clinicrme/shared';
import { PlatformDb, Tx, rows } from '@clinicrme/db';

/** Cookie konsol platform — nama berbeda dari cookie klinik (crme_session/crme_csrf) agar tidak pernah tertukar (CR-0001). */
export const PLATFORM_SESSION_COOKIE = 'crme_psession';
export const PLATFORM_CSRF_COOKIE = 'crme_pcsrf';

export interface PlatformSession {
  session_id: string; user_id: string; email: string; full_name: string; roles: string[]; user_status: string;
  mfa_verified: boolean; mfa_enrolled: boolean; last_seen_at: Date; expires_at: Date; revoked_at: Date | null;
}

@Injectable()
export class PlatformSessionService {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig, private readonly db: PlatformDb) {}

  /** Sesi baru selalu belum terverifikasi MFA kecuali hasil rotasi setelah TOTP benar (SC-AUTH-05/06). */
  async create(tx: Tx, res: Response, userId: string, mfaVerified: boolean, ip?: string, ua?: string) {
    const token = randomToken();
    // Konsol platform: batas absolut sama dengan aplikasi klinik; idle diperiksa di isUsable
    const expires = new Date(Date.now() + this.cfg.sessionAbsoluteHours * 3600_000);
    await tx.execute(sql`insert into platform_session(user_id, token_hash, mfa_verified, ip, user_agent, expires_at)
                         values (${userId}, ${sha256Hex(token)}, ${mfaVerified}, ${ip ?? null}::inet, ${ua ?? null}, ${expires.toISOString()})`);
    const base = { secure: this.cfg.cookieSecure, sameSite: 'strict' as const, path: '/', expires };
    res.cookie(PLATFORM_SESSION_COOKIE, token, { ...base, httpOnly: true });
    res.cookie(PLATFORM_CSRF_COOKIE, randomToken(16), { ...base, httpOnly: false });
  }

  async resolve(token: string | undefined): Promise<PlatformSession | null> {
    if (!token || token.length < 40) return null;
    const [s] = await this.db.tx((tx) => rows<PlatformSession>(tx, sql`
      select s.id as session_id, s.user_id, u.email, u.full_name, u.roles, u.status as user_status, s.mfa_verified,
             exists(select 1 from platform_mfa m where m.user_id = u.id) as mfa_enrolled,
             s.last_seen_at, s.expires_at, s.revoked_at
        from platform_session s join platform_user u on u.id = s.user_id
       where s.token_hash = ${sha256Hex(token)}`));
    return s ?? null;
  }

  isUsable(s: PlatformSession): { ok: true } | { ok: false; reason: string } {
    if (s.revoked_at) return { ok: false, reason: 'REVOKED' };
    if (new Date(s.expires_at) <= new Date()) return { ok: false, reason: 'EXPIRED' };
    if (Date.now() - new Date(s.last_seen_at).getTime() > this.cfg.sessionIdleMinutes * 60_000) return { ok: false, reason: 'IDLE_TIMEOUT' };
    if (s.user_status !== 'ACTIVE') return { ok: false, reason: 'USER_DISABLED' };
    return { ok: true };
  }

  async touch(sessionId: string, actorId: string): Promise<void> {
    await this.db.tx((tx) => tx.execute(sql`update platform_session set last_seen_at = now() where id = ${sessionId}`), actorId);
  }

  clearCookies(res: Response) {
    res.clearCookie(PLATFORM_SESSION_COOKIE, { path: '/' });
    res.clearCookie(PLATFORM_CSRF_COOKIE, { path: '/' });
  }
}
