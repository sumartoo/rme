import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import {
  ALLOW_WITHOUT_MFA_KEY, AUTHENTICATED_KEY, INFRA_KEY, PERMISSION_KEY, PLATFORM_KEY, PUBLIC_KEY, ctx, problem,
} from '@clinicrme/shared';
import { Db, rows } from '@clinicrme/db';
import { CSRF_COOKIE, SESSION_COOKIE, SessionService } from './session.service';

export const TENANT_ADMIN_ROLE = 'TENANT_ADMIN';

/**
 * Guard global aplikasi klinik: sesi → CSRF → status tenant → MFA → permission. Deny by default:
 * handler tanpa @Public/@Authenticated/@RequirePermission ditolak (dan gagal saat bootstrap — assertRouteDeclarations).
 * Route konsol platform (@Platform*) diserahkan ke PlatformSecurityGuard; route klinik di host admin → 404.
 */
@Injectable()
export class SecurityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly sessions: SessionService, private readonly db: Db) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const req = ec.switchToHttp().getRequest<Request>();
    const meta = <T>(k: string) => this.reflector.getAllAndOverride<T>(k, [ec.getHandler(), ec.getClass()]);
    if (meta<boolean>(INFRA_KEY)) return true;   // health/readiness: tanpa tenant & sesi
    const c = ctx();
    if (meta<string>(PLATFORM_KEY) !== undefined) {
      // Dijaga PlatformSecurityGuard; di host klinik route platform tidak ada (404)
      if (!c.platformHost) throw problem(404, 'GEN-404', 'Tidak ditemukan');
      return true;
    }
    if (!c.hostTenantId) throw problem(404, 'TEN-404-UNKNOWN', 'Klinik tidak ditemukan');
    if (meta<boolean>(PUBLIC_KEY)) return true;

    const permission = meta<string>(PERMISSION_KEY);
    const authenticated = meta<boolean>(AUTHENTICATED_KEY);
    if (!permission && !authenticated) throw problem(403, 'IAM-403-UNDECLARED', 'Endpoint tanpa deklarasi akses');

    const s = await this.sessions.resolve(req.cookies?.[SESSION_COOKIE]);
    if (!s) throw problem(401, 'AUTH-401-SESSION', 'Sesi tidak berlaku');
    const usable = this.sessions.isUsable(s, c.hostTenantId);
    if (!usable.ok) throw problem(401, 'AUTH-401-SESSION', `Sesi tidak berlaku (${usable.reason})`);

    // CSRF double-submit untuk metode yang mengubah state (SC-WEB-02)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const header = String(req.headers['x-csrf-token'] ?? ''), cookie = String(req.cookies?.[CSRF_COOKIE] ?? '');
      const ok = header.length > 0 && header.length === cookie.length && timingSafeEqual(Buffer.from(header), Buffer.from(cookie));
      if (!ok) throw problem(403, 'AUTH-403-CSRF', 'Token CSRF tidak valid');
    }

    Object.assign(c, { tenantId: s.tenant_id, userId: s.user_id, sessionId: s.session_id, branchId: s.branch_id, mfaVerified: s.mfa_verified });

    const perms = await this.db.withTenantTx(async (tx) => {
      await this.sessions.touch(tx, s.session_id);
      return rows<{ code: string; requires_mfa: boolean; role_code: string }>(tx, sql`
        select rp.permission_code as code, r.requires_mfa, r.code as role_code
          from user_role_assignment a
          join role r on r.id = a.role_id
          left join role_permission rp on rp.role_id = r.id
         where a.user_id = ${s.user_id}
           and (a.valid_to is null or a.valid_to > now())
           and (a.branch_id is null or a.branch_id is not distinct from ${s.branch_id}::uuid)`);
    });
    c.permissions = new Set(perms.map((p) => p.code).filter(Boolean));
    c.mfaRequired = perms.some((p) => p.requires_mfa);

    // PLT-FR-006: tenant SUSPENDED → hanya tenant admin (untuk pembayaran/ekspor); sesi user lain ditolak
    if (c.hostTenantStatus === 'SUSPENDED' && !perms.some((p) => p.role_code === TENANT_ADMIN_ROLE)) {
      throw problem(403, 'TEN-403-SUSPENDED', 'Layanan klinik sedang ditangguhkan. Hubungi admin klinik.');
    }

    if (c.mfaRequired && !c.mfaVerified && !meta<boolean>(ALLOW_WITHOUT_MFA_KEY)) {
      throw problem(401, 'AUTH-401-MFA-REQUIRED', 'Verifikasi MFA diperlukan');
    }
    if (permission && !c.permissions.has(permission)) throw problem(403, 'IAM-403-FORBIDDEN', 'Tidak memiliki izin');
    return true;
  }
}
