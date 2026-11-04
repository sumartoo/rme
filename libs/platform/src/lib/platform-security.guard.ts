import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ALLOW_WITHOUT_MFA_KEY, INFRA_KEY, PLATFORM_KEY, ctx, problem } from '@clinicrme/shared';
import { platformPermissions } from './permissions';
import { PLATFORM_CSRF_COOKIE, PLATFORM_SESSION_COOKIE, PlatformSessionService } from './platform-session.service';

/**
 * Guard global konsol platform (CR-0001). Hanya menangani route @Platform*; route klinik dijaga SecurityGuard (libs/iam).
 * Urutan: host admin → sesi platform → CSRF → MFA (wajib untuk SEMUA pengguna platform) → permission role platform.
 * Cookie klinik tidak pernah dibaca di sini, dan cookie platform tidak pernah dibaca guard klinik.
 */
@Injectable()
export class PlatformSecurityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly sessions: PlatformSessionService) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const meta = <T>(k: string) => this.reflector.getAllAndOverride<T>(k, [ec.getHandler(), ec.getClass()]);
    if (meta<boolean>(INFRA_KEY)) return true;
    const access = meta<string>(PLATFORM_KEY);
    if (access === undefined) return true;            // route klinik → SecurityGuard
    const c = ctx();
    if (!c.platformHost) throw problem(404, 'GEN-404', 'Tidak ditemukan');
    if (access === 'public') return true;

    const req = ec.switchToHttp().getRequest<Request>();
    const s = await this.sessions.resolve(req.cookies?.[PLATFORM_SESSION_COOKIE]);
    if (!s) throw problem(401, 'AUTH-401-SESSION', 'Sesi tidak berlaku');
    const usable = this.sessions.isUsable(s);
    if (!usable.ok) throw problem(401, 'AUTH-401-SESSION', `Sesi tidak berlaku (${usable.reason})`);

    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const header = String(req.headers['x-csrf-token'] ?? ''), cookie = String(req.cookies?.[PLATFORM_CSRF_COOKIE] ?? '');
      const ok = header.length > 0 && header.length === cookie.length && timingSafeEqual(Buffer.from(header), Buffer.from(cookie));
      if (!ok) throw problem(403, 'AUTH-403-CSRF', 'Token CSRF tidak valid');
    }

    Object.assign(c, { platformUserId: s.user_id, platformSessionId: s.session_id, platformRoles: s.roles, mfaVerified: s.mfa_verified });
    c.permissions = platformPermissions(s.roles);
    await this.sessions.touch(s.session_id, s.user_id);

    if (!s.mfa_verified && !meta<boolean>(ALLOW_WITHOUT_MFA_KEY)) {
      throw problem(401, 'AUTH-401-MFA-REQUIRED', 'Verifikasi MFA diperlukan');
    }
    if (access !== 'authenticated' && !c.permissions.has(access)) throw problem(403, 'IAM-403-FORBIDDEN', 'Tidak memiliki izin');
    return true;
  }
}
