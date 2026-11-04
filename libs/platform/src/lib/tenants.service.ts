import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ctx, pgError, problem, randomToken, sha256Hex } from '@clinicrme/shared';
import { PlatformDb, Tx, platformAudit, rows, tenantAuditAsPlatform } from '@clinicrme/db';
import { TenantStatus, allowedTransitions, canTransition } from './tenant-status';

/** Subdomain yang tidak boleh menjadi kode klinik — sama dengan constraint tenant_code_not_reserved (migrasi 0003). */
export const RESERVED_TENANT_CODES = ['admin', 'api', 'app', 'www', 'platform', 'static', 'status', 'mail', 'support', 'login', 'auth'];

export interface TenantCreateInput {
  code: string; legalName: string; displayName?: string; tenantType: 'KLINIK_UTAMA' | 'KLINIK_PRATAMA' | 'PRAKTIK_MANDIRI';
  planId: string; adminEmail: string; trialDays?: number;
}

interface TenantRow {
  id: string; code: string; legal_name: string; display_name: string; tenant_type: string; status: TenantStatus;
  created_at: Date; plan_id: string | null; plan_code: string | null; max_users: number | null; max_branches: number | null;
  trial_end_at: Date | null;
}

const NOT_FOUND = () => problem(404, 'PLT-404-TENANT', 'Tenant tidak ditemukan');

/**
 * Operasi konsol platform atas tenant (PLT-FR-001/003/005/011). Hanya menyentuh tabel platform & baris `tenant`;
 * role DB clinicrme_platform tidak memiliki akses ke tabel klinis (PLT-FR-009) — ditegakkan GRANT, diuji P17.
 */
@Injectable()
export class TenantsService {
  constructor(private readonly db: PlatformDb) {}

  private select(where: ReturnType<typeof sql>) {
    return sql`select t.id, t.code, t.legal_name, t.display_name, t.tenant_type, t.status, t.created_at,
                      p.id as plan_id, p.code as plan_code, p.max_users, p.max_branches, s.trial_end_at
                 from tenant t
                 left join tenant_subscription s on s.tenant_id = t.id and s.is_current
                 left join subscription_plan p on p.id = s.plan_id
                where ${where}`;
  }

  static toDto(t: TenantRow, flags?: Record<string, boolean>) {
    return {
      id: t.id, code: t.code, legalName: t.legal_name, displayName: t.display_name, tenantType: t.tenant_type, status: t.status,
      plan: t.plan_id ? { id: t.plan_id, code: t.plan_code, maxUsers: t.max_users, maxBranches: t.max_branches } : undefined,
      trialEndsAt: t.trial_end_at ? new Date(t.trial_end_at).toISOString() : null,
      createdAt: new Date(t.created_at).toISOString(),
      // Detail saja: flag + transisi yang sah dari status sekarang (UI tidak menyalin mesin status)
      ...(flags ? { featureFlags: flags, allowedTransitions: [...allowedTransitions(t.status)] } : {}),
    };
  }

  /** Keyset pagination berdasarkan kode (unik, stabil). Cursor = kode terakhir, base64url. */
  async list(cursor: string | undefined, limit: number) {
    const after = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
    const r = await this.db.tx((tx) => rows<TenantRow>(tx, sql`${this.select(sql`t.code > ${after}`)} order by t.code limit ${limit + 1}`),
                               ctx().platformUserId);
    const hasMore = r.length > limit;
    const data = r.slice(0, limit);
    return {
      data: data.map((t) => TenantsService.toDto(t)),
      page: { hasMore, nextCursor: hasMore ? Buffer.from(data[data.length - 1].code, 'utf8').toString('base64url') : null },
    };
  }

  async get(id: string) {
    return this.db.tx(async (tx) => {
      const [t] = await rows<TenantRow>(tx, this.select(sql`t.id = ${id}`));
      if (!t) throw NOT_FOUND();
      const flags = await rows<{ feature_code: string; enabled: boolean }>(tx, sql`
        select feature_code, enabled from tenant_feature_flag where tenant_id = ${id} order by feature_code`);
      return TenantsService.toDto(t, Object.fromEntries(flags.map((f) => [f.feature_code, f.enabled])));
    }, ctx().platformUserId);
  }

  async plans() {
    const r = await this.db.tx((tx) => rows(tx, sql`select id, code, name, max_users, max_branches, features
                                                    from subscription_plan where is_active order by code`));
    return r.map((p) => ({ id: p.id, code: p.code, name: p.name, maxUsers: p.max_users, maxBranches: p.max_branches, features: p.features }));
  }

  /**
   * PLT-FR-001/002/003: tenant + langganan + role template + undangan tenant admin + audit, satu transaksi (app.provision_tenant).
   * Token undangan TIDAK dikembalikan ke pengguna platform: memberinya akses login sebagai admin klinik
   * akan melanggar PLT-FR-009. Tenant admin masuk dengan Google memakai email undangan (atau tautan email — batch 2).
   */
  async create(b: TenantCreateInput) {
    if (RESERVED_TENANT_CODES.includes(b.code)) throw problem(400, 'PLT-400-CODE-RESERVED', 'Kode klinik tidak boleh dipakai');
    const actor = ctx().platformUserId!;
    try {
      const id = await this.db.tx(async (tx) => {
        const [r] = await rows<{ id: string }>(tx, sql`select app.provision_tenant(${b.code}, ${b.legalName}, ${b.displayName ?? ''},
                       ${b.tenantType}, ${b.planId}::uuid, ${b.trialDays ?? 0}, ${b.adminEmail}, ${sha256Hex(randomToken())}, ${actor}::uuid) as id`);
        await platformAudit(tx, 'TENANT_PROVISIONED', { tenantId: r.id, resourceType: 'tenant', resourceId: r.id,
                                                        summary: { code: b.code, planId: b.planId, trialDays: b.trialDays ?? 0 } });
        return r.id;
      }, actor);
      return this.get(id);
    } catch (e) {
      const pg = pgError(e);
      if (pg?.code === '23505' && pg.constraint === 'tenant_code_key') throw problem(409, 'PLT-409-CODE', 'Kode klinik sudah dipakai');
      if (pg?.code === '22P02') throw problem(400, 'PLT-400-PLAN', 'Paket tidak ditemukan atau tidak aktif');
      throw e;
    }
  }

  /** PLT-FR-005/006/013: transisi divalidasi (state machine + trigger DB), histori + alasan, audit tenant & platform. */
  async changeStatus(id: string, to: TenantStatus, reason: string) {
    const actor = ctx().platformUserId!;
    await this.db.forTenant(id, async (tx: Tx) => {
      const [t] = await rows<{ status: TenantStatus }>(tx, sql`select status from tenant where id = ${id} for update`);
      if (!t) throw NOT_FOUND();
      if (!canTransition(t.status, to)) {
        const allowed = allowedTransitions(t.status);
        throw problem(409, 'PLT-409-STATUS',
          `Transisi ${t.status} → ${to} tidak diizinkan${allowed.length ? ` (yang diizinkan: ${allowed.join(', ')})` : ' (status final)'}`);
      }
      await tx.execute(sql`update tenant set status = ${to} where id = ${id}`);
      await tx.execute(sql`insert into tenant_status_history(tenant_id, from_status, to_status, reason, actor_id)
                           values (${id}, ${t.status}, ${to}, ${reason}, ${actor})`);
      const summary = { from: t.status, to, reason };
      await tenantAuditAsPlatform(tx, 'TENANT_STATUS_CHANGED', 'tenant', id, summary);
      await platformAudit(tx, 'TENANT_STATUS_CHANGED', { tenantId: id, resourceType: 'tenant', resourceId: id, summary });
    }, actor);
    return this.get(id);
  }

  /** PLT-FR-011 */
  async setFeatureFlag(id: string, feature: string, enabled: boolean) {
    const actor = ctx().platformUserId!;
    await this.db.forTenant(id, async (tx) => {
      const [t] = await rows(tx, sql`select 1 from tenant where id = ${id}`);
      if (!t) throw NOT_FOUND();
      await tx.execute(sql`insert into tenant_feature_flag(tenant_id, feature_code, enabled) values (${id}, ${feature}, ${enabled})
                           on conflict (tenant_id, feature_code) do update set enabled = excluded.enabled, updated_at = now()`);
      const summary = { feature, enabled };
      await tenantAuditAsPlatform(tx, 'FEATURE_FLAG_CHANGED', 'tenant', id, summary);
      await platformAudit(tx, 'FEATURE_FLAG_CHANGED', { tenantId: id, resourceType: 'tenant_feature_flag', resourceId: feature, summary });
    }, actor);
  }
}
