import { Controller, Get, HttpCode, Inject, Query, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { CONFIG, Infra, type AppConfig } from '@clinicrme/shared';
import { Db } from '@clinicrme/db';

const TENANT_CODE = /^[a-z0-9-]{3,40}$/;   // sama dengan context.middleware
const SERVED = new Set(['TRIAL', 'ACTIVE', 'GRACE', 'SUSPENDED']);

/** Probe Cloud Run / Compose. Tidak membaca data tenant. */
@Controller()
export class HealthController {
  constructor(private readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  @Infra() @Get('healthz') @HttpCode(200)
  live() { return { status: 'ok' }; }

  @Infra() @Get('readyz')
  async ready(@Res({ passthrough: true }) res: Response) {
    const db = await this.db.ping();
    res.status(db ? 200 : 503);
    return { status: db ? 'ok' : 'unavailable', checks: { database: db ? 'ok' : 'down' } };
  }

  /**
   * Deploy VPS (CR-0003): Caddy "on-demand TLS" menanyakan ke sini sebelum menerbitkan sertifikat untuk sebuah
   * subdomain — hanya `admin.<BASE_DOMAIN>` dan klinik yang dilayani. Mencegah penerbitan sertifikat untuk
   * subdomain sembarang (batas kuota Let's Encrypt). Hanya dapat dijangkau dari jaringan internal: proxy web
   * meneruskan /api/v1 & /api/platform/v1 saja. Jawaban hanya 200/404, tanpa data.
   */
  @Infra() @Get('internal/tls-allowed')
  async tlsAllowed(@Query('domain') domain: string | undefined, @Res({ passthrough: true }) res: Response) {
    const d = (domain ?? '').toLowerCase();
    const suffix = `.${this.cfg.baseDomain}`;
    let ok = false;
    if (d.endsWith(suffix)) {
      const code = d.slice(0, -suffix.length);
      if (code === 'admin') ok = true;
      else if (TENANT_CODE.test(code)) {
        const [t] = await this.db.preAuth<{ status: string }>(sql`select * from app.resolve_tenant(${code})`);
        ok = !!t && SERVED.has(t.status);
      }
    }
    res.status(ok ? 200 : 404);
    return { allowed: ok };
  }
}
