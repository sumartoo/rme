import { Body, Controller, Get, HttpCode, Injectable, Param, Post, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, NoBody, PlatformAuthenticated, PlatformPermission, ctx, problem } from '@clinicrme/shared';
import { PlatformDb, Tx, platformAudit, rows, tenantAuditAsPlatform } from '@clinicrme/db';

/**
 * Break-glass akses dukungan (PLT-FR-009, OD-076, OD-077).
 * - Hanya PLATFORM_SUPPORT (permission platform.support.access), alasan ≥ 10 karakter, ≤ 8 jam (juga CHECK di DB).
 * - Selama berlaku: hanya MEMBACA user/role & log audit tenant lewat fungsi SECURITY DEFINER yang memeriksa grant
 *   di database pada setiap panggilan; data pasien tidak pernah tersedia. Setiap pembacaan diaudit di rantai tenant.
 * - Dibuka/dicabut → email ke semua tenant admin (outbox) + audit tenant & platform.
 */
const SupportAccessInput = z.object({
  tenantId: z.guid(),   // z.uuid() Zod 4 menolak UUID non-RFC (mis. data sintetis)
  reason: z.string().trim().min(10).max(500),
  durationMinutes: z.number().int().min(15).max(480),
}).strict();
const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),   // seq terakhir halaman sebelumnya
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const grantId = (id: string) => { if (!UUID.test(id)) throw problem(404, 'PLT-404-GRANT', 'Akses dukungan tidak ditemukan'); return id; };

interface GrantRow { id: string; tenant_id: string; tenant_code: string; platform_user: string; support_name: string; reason: string;
  starts_at: Date; expires_at: Date; revoked_at: Date | null }
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const dto = (g: GrantRow) => ({
  id: g.id, tenantId: g.tenant_id, tenantCode: g.tenant_code, platformUserId: g.platform_user, supportName: g.support_name, reason: g.reason,
  startsAt: iso(g.starts_at), expiresAt: iso(g.expires_at), revokedAt: iso(g.revoked_at),
  active: !g.revoked_at && new Date(g.expires_at) > new Date(),
});
const SELECT = sql`select g.id, g.tenant_id, t.code as tenant_code, g.platform_user, u.full_name as support_name, g.reason,
                          g.starts_at, g.expires_at, g.revoked_at
                     from support_access_grant g join tenant t on t.id = g.tenant_id join platform_user u on u.id = g.platform_user`;

@Injectable()
export class SupportAccessService {
  constructor(private readonly db: PlatformDb) {}

  async grant(b: z.infer<typeof SupportAccessInput>) {
    const actor = ctx().platformUserId!;
    const id = await this.db.forTenant(b.tenantId, async (tx: Tx) => {
      const [t] = await rows<{ status: string }>(tx, sql`select status from tenant where id = ${b.tenantId}`);
      if (!t) throw problem(404, 'PLT-404-TENANT', 'Tenant tidak ditemukan');
      if (t.status === 'TERMINATED' || t.status === 'PROVISIONING') throw problem(409, 'PLT-409-STATUS', 'Tenant tidak dalam status yang dapat didukung');
      const [active] = await rows(tx, sql`select 1 from support_access_grant where tenant_id = ${b.tenantId} and platform_user = ${actor}
                                          and revoked_at is null and expires_at > now()`);
      if (active) throw problem(409, 'PLT-409-GRANT-ACTIVE', 'Anda masih punya akses dukungan aktif untuk tenant ini');
      const [g] = await rows<{ id: string; expires_at: Date }>(tx, sql`
        insert into support_access_grant(tenant_id, platform_user, reason, expires_at)
        values (${b.tenantId}, ${actor}, ${b.reason}, now() + make_interval(mins => ${b.durationMinutes})) returning id, expires_at`);
      const summary = { reason: b.reason, durationMinutes: b.durationMinutes, expiresAt: iso(g.expires_at) };
      await tenantAuditAsPlatform(tx, 'SUPPORT_ACCESS_GRANTED', 'support_access_grant', g.id, summary, 'PLATFORM_SUPPORT');
      await platformAudit(tx, 'SUPPORT_ACCESS_GRANTED', { tenantId: b.tenantId, resourceType: 'support_access_grant', resourceId: g.id, summary });
      await tx.execute(sql`select app.enqueue_support_notification(${g.id}::uuid, 'SUPPORT_ACCESS_GRANTED')`);
      return g.id;
    }, actor);
    return this.get(id);
  }

  async get(id: string) {
    const [g] = await this.db.tx((tx) => rows<GrantRow>(tx, sql`${SELECT} where g.id = ${grantId(id)}`), ctx().platformUserId);
    if (!g) throw problem(404, 'PLT-404-GRANT', 'Akses dukungan tidak ditemukan');
    return dto(g);
  }

  /** Support melihat grant miliknya; admin platform melihat semua (pengawasan). Filter tenant opsional. */
  async list(tenantId?: string) {
    const c = ctx();
    const mine = !c.permissions?.has('platform.tenant.manage');
    const r = await this.db.tx((tx) => rows<GrantRow>(tx, sql`${SELECT}
      where (${!mine} or g.platform_user = ${c.platformUserId}) and (${tenantId ?? null}::uuid is null or g.tenant_id = ${tenantId ?? null}::uuid)
      order by g.created_at desc limit 50`), c.platformUserId);
    return r.map(dto);
  }

  /** Dicabut oleh pemiliknya, atau oleh admin platform. */
  async revoke(id: string) {
    const c = ctx();
    const g = await this.get(id);
    const own = g.platformUserId === c.platformUserId && c.permissions?.has('platform.support.access');
    if (!own && !c.permissions?.has('platform.tenant.manage')) throw problem(403, 'IAM-403-FORBIDDEN', 'Tidak memiliki izin');
    if (!g.active) throw problem(409, 'PLT-409-GRANT-INACTIVE', 'Akses dukungan sudah tidak aktif');
    await this.db.forTenant(g.tenantId, async (tx: Tx) => {
      await tx.execute(sql`update support_access_grant set revoked_at = now(), revoked_by = ${c.platformUserId} where id = ${id}`);
      await tenantAuditAsPlatform(tx, 'SUPPORT_ACCESS_REVOKED', 'support_access_grant', id, null, own ? 'PLATFORM_SUPPORT' : 'PLATFORM');
      await platformAudit(tx, 'SUPPORT_ACCESS_REVOKED', { tenantId: g.tenantId, resourceType: 'support_access_grant', resourceId: id });
      await tx.execute(sql`select app.enqueue_support_notification(${id}::uuid, 'SUPPORT_ACCESS_REVOKED')`);
    }, c.platformUserId);
    return this.get(id);
  }

  async users(id: string) {
    const r = await this.db.tx((tx) => rows<{ user_id: string; email: string; full_name: string; status: string; last_login_at: Date | null; roles: string[] }>(
      tx, sql`select * from app.support_read_users(${grantId(id)}::uuid, ${ctx().platformUserId}::uuid)`), ctx().platformUserId);
    return r.map((u) => ({ id: u.user_id, email: u.email, fullName: u.full_name, status: u.status, lastLoginAt: iso(u.last_login_at), roles: u.roles }));
  }

  async audit(id: string, limit: number, before?: number) {
    const r = await this.db.tx((tx) => rows<{ seq: string; occurred_at: Date; actor_kind: string; actor_user_id: string | null; action: string;
      resource_type: string; resource_id: string | null }>(tx, sql`
      select * from app.support_read_audit(${grantId(id)}::uuid, ${ctx().platformUserId}::uuid, ${limit}, ${before ?? null}::bigint)`), ctx().platformUserId);
    const data = r.map((a) => ({ seq: Number(a.seq), occurredAt: iso(a.occurred_at), actorKind: a.actor_kind, actorUserId: a.actor_user_id,
                                 action: a.action, resourceType: a.resource_type, resourceId: a.resource_id }));
    return { data, page: { hasMore: data.length === limit, nextCursor: data.length === limit ? String(data[data.length - 1].seq) : null } };
  }
}

@Controller('api/platform/v1/support-access')
export class SupportAccessController {
  constructor(private readonly svc: SupportAccessService) {}

  @PlatformPermission('platform.support.access') @BodySchema(SupportAccessInput) @Post()
  grant(@Body() b: z.infer<typeof SupportAccessInput>) { return this.svc.grant(b); }

  @PlatformAuthenticated() @Get()
  list(@Query('tenantId') tenantId?: string) {
    if (tenantId !== undefined && !UUID.test(tenantId)) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    return this.svc.list(tenantId);
  }

  @PlatformAuthenticated() @NoBody() @Post(':grantId/revoke') @HttpCode(200)
  revoke(@Param('grantId') id: string) { return this.svc.revoke(id); }

  @PlatformPermission('platform.support.access') @Get(':grantId/users')
  users(@Param('grantId') id: string) { return this.svc.users(id); }

  @PlatformPermission('platform.support.access') @Get(':grantId/audit-log')
  audit(@Param('grantId') id: string, @Query() q: Record<string, unknown>) {
    const p = AuditQuery.safeParse(q);
    if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    return this.svc.audit(id, p.data.limit, p.data.cursor);
  }
}
