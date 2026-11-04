import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@clinicrme/shared';
import { CONFIG, RequestContext, als } from '@clinicrme/shared';
import { Db } from '@clinicrme/db';

const TENANT_CODE = /^[a-z0-9-]{3,40}$/;
/** Status yang dilayani. PROVISIONING (belum selesai) & TERMINATED (data disimpan, tidak bisa login — PLT-FR-013) → 404. */
const SERVED_STATUSES = new Set(['TRIAL', 'ACTIVE', 'GRACE', 'SUSPENDED']);
/** Subdomain konsol platform (CR-0001). Kode ini tercadang di database (tenant_code_not_reserved). */
export const PLATFORM_SUBDOMAIN = 'admin';

/**
 * Membuka konteks per request dan menentukan tenant dari subdomain (SC-TEN-01),
 * atau menandai request ke konsol platform (admin.<BASE_DOMAIN>) — tidak pernah keduanya.
 */
@Injectable()
export class ContextMiddleware implements NestMiddleware {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig, private readonly db: Db) {}

  async use(req: Request & { id?: unknown; crme?: RequestContext }, res: Response, next: NextFunction) {
    const requestId = typeof req.id === 'string' && req.id ? req.id : randomUUID();
    res.setHeader('x-request-id', requestId);
    const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
    const suffix = `.${this.cfg.baseDomain}`;
    let hostTenantId: string | undefined;
    let hostTenantStatus: string | undefined;
    let platformHost = false;
    if (host.endsWith(suffix)) {
      const code = host.slice(0, -suffix.length);
      if (code === PLATFORM_SUBDOMAIN) {
        platformHost = true;
      } else if (TENANT_CODE.test(code)) {
        const [t] = await this.db.preAuth<{ tenant_id: string; status: string }>(sql`select * from app.resolve_tenant(${code})`);
        if (t && SERVED_STATUSES.has(t.status)) { hostTenantId = t.tenant_id; hostTenantStatus = t.status; }
      }
    }
    const context: RequestContext = {
      requestId, hostTenantId, hostTenantStatus, platformHost, ip: req.ip, userAgent: req.get('user-agent') ?? undefined,
    };
    req.crme = context;
    als.run(context, () => next());
  }
}
