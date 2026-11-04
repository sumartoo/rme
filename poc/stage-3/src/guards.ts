import { CanActivate, ExecutionContext, HttpException, Injectable, NestMiddleware } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { AppConfig, CONFIG } from './config';
import { als, ctx } from './context';
import { Db, rows } from './db';
import { ALLOW_WITHOUT_MFA_KEY, AUTHENTICATED_KEY, PERMISSION_KEY, PUBLIC_KEY } from './decorators';
import { CSRF_COOKIE, SESSION_COOKIE, SessionService } from './session.service';

const problem = (status: number, code: string, title: string) => new HttpException({ type: 'about:blank', title, status, code }, status);

/** Membuka AsyncLocalStorage per request dan menentukan tenant dari subdomain (SC-TEN-01). */
@Injectable()
export class ContextMiddleware implements NestMiddleware {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig, private readonly db: Db) {}
  async use(req: Request, res: Response, next: NextFunction) {
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    res.setHeader('x-request-id', requestId);
    const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
    const suffix = `.${this.cfg.baseDomain}`;
    let hostTenantId: string | undefined;
    if (host.endsWith(suffix)) {
      const code = host.slice(0, -suffix.length);
      if (/^[a-z0-9-]{3,40}$/.test(code)) {
        const [t] = await this.db.preAuth<{ tenant_id: string; status: string }>(sql`select * from app.resolve_tenant(${code})`);
        if (t && ['TRIAL', 'ACTIVE', 'GRACE', 'SUSPENDED'].includes(t.status)) hostTenantId = t.tenant_id;
      }
    }
    als.run({ requestId, hostTenantId, ip: req.ip, userAgent: req.get('user-agent') ?? undefined }, () => next());
  }
}

/**
 * Guard global: sesi → MFA → CSRF → permission. Deny by default:
 * handler tanpa @Public/@Authenticated/@RequirePermission ditolak (dan gagal saat bootstrap — startup-check.ts).
 */
@Injectable()
export class SecurityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly sessions: SessionService, private readonly db: Db) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const req = ec.switchToHttp().getRequest<Request>();
    const meta = <T>(k: string) => this.reflector.getAllAndOverride<T>(k, [ec.getHandler(), ec.getClass()]);
    const c = ctx();
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
      return rows<{ code: string; requires_mfa: boolean }>(tx, sql`
        select rp.permission_code as code, r.requires_mfa
          from user_role_assignment a
          join role r on r.id = a.role_id
          left join role_permission rp on rp.role_id = r.id
         where a.user_id = ${s.user_id}
           and (a.valid_to is null or a.valid_to > now())
           and (a.branch_id is null or a.branch_id is not distinct from ${s.branch_id}::uuid)`);
    });
    c.permissions = new Set(perms.map((p) => p.code).filter(Boolean));
    c.mfaRequired = perms.some((p) => p.requires_mfa);

    if (c.mfaRequired && !c.mfaVerified && !meta<boolean>(ALLOW_WITHOUT_MFA_KEY)) {
      throw problem(401, 'AUTH-401-MFA-REQUIRED', 'Verifikasi MFA diperlukan');
    }
    if (permission && !c.permissions.has(permission)) throw problem(403, 'IAM-403-FORBIDDEN', 'Tidak memiliki izin');
    return true;
  }
}
