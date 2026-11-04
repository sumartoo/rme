import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { BodySchema, PlatformPermission, problem } from '@clinicrme/shared';
import { TENANT_STATUSES } from './tenant-status';
import { TenantsService } from './tenants.service';

const TenantCreate = z.object({
  code: z.string().regex(/^[a-z0-9-]{3,40}$/),
  legalName: z.string().trim().min(3).max(200),
  displayName: z.string().trim().max(200).optional(),
  tenantType: z.enum(['KLINIK_UTAMA', 'KLINIK_PRATAMA', 'PRAKTIK_MANDIRI']),
  planId: z.string().uuid(),
  adminEmail: z.string().email().max(254),
  trialDays: z.number().int().min(0).max(90).optional(),
}).strict();
const StatusChange = z.object({
  status: z.enum(TENANT_STATUSES.filter((s) => s !== 'PROVISIONING') as [string, ...string[]]),
  reason: z.string().trim().min(3).max(500),
}).strict();
const FlagBody = z.object({ enabled: z.boolean() }).strict();
const ListQuery = z.object({
  cursor: z.string().max(200).regex(/^[A-Za-z0-9_-]*$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEATURE = /^[a-z][a-z0-9_.-]{1,63}$/;
const tenantId = (id: string) => { if (!UUID.test(id)) throw problem(404, 'PLT-404-TENANT', 'Tenant tidak ditemukan'); return id; };

@Controller('api/platform/v1')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @PlatformPermission('platform.tenant.read') @Get('plans')
  plans() { return this.tenants.plans(); }

  @PlatformPermission('platform.tenant.read') @Get('tenants')
  list(@Query() q: Record<string, unknown>) {
    const p = ListQuery.safeParse(q);
    if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    return this.tenants.list(p.data.cursor || undefined, p.data.limit);
  }

  @PlatformPermission('platform.tenant.read') @Get('tenants/:tenantId')
  get(@Param('tenantId') id: string) { return this.tenants.get(tenantId(id)); }

  @PlatformPermission('platform.tenant.manage') @BodySchema(TenantCreate) @Post('tenants')
  create(@Body() b: z.infer<typeof TenantCreate>) { return this.tenants.create(b); }

  @PlatformPermission('platform.tenant.manage') @BodySchema(StatusChange) @Post('tenants/:tenantId/status') @HttpCode(200)
  status(@Param('tenantId') id: string, @Body() b: z.infer<typeof StatusChange>) {
    return this.tenants.changeStatus(tenantId(id), b.status as never, b.reason);
  }

  @PlatformPermission('platform.tenant.manage') @BodySchema(FlagBody) @Put('tenants/:tenantId/feature-flags/:feature') @HttpCode(204)
  async flag(@Param('tenantId') id: string, @Param('feature') feature: string, @Body() b: z.infer<typeof FlagBody>) {
    if (!FEATURE.test(feature)) throw problem(400, 'PLT-400-FEATURE', 'Kode fitur tidak valid');
    await this.tenants.setFeatureFlag(tenantId(id), feature, b.enabled);
  }
}
