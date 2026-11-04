import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { ctx } from '@clinicrme/shared';
import type { Tx } from './db';

/**
 * Pintu database konsol platform (CR-0001). Koneksi role LOGIN anggota clinicrme_platform:
 * hanya tabel platform + baris `tenant`; tabel klinis/tenant lain ditolak oleh GRANT (PLT-FR-009).
 * - tx: transaksi tanpa tenant context; app.user_id = pengguna platform (untuk touch_row/audit).
 * - forTenant: transaksi dengan app.tenant_id = tenant target, khusus untuk menulis audit tenant (actor_kind PLATFORM)
 *   — role platform tetap tidak dapat membaca tabel klinis tenant itu.
 */
export class PlatformDb {
  private readonly pool: Pool;
  private readonly db: NodePgDatabase;
  private closed = false;

  constructor(cfg: { url: string; poolMax: number }) {
    this.pool = new Pool({ connectionString: cfg.url, max: cfg.poolMax, options: '-c search_path=app,public' });
    this.db = drizzle(this.pool);
  }

  tx<T>(fn: (tx: Tx) => Promise<T>, actorId?: string): Promise<T> {
    return this.forTenant('', fn, actorId);
  }

  forTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, actorId?: string): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${actorId ?? ''}, true)`);
      return fn(tx as unknown as Tx);
    });
  }

  async ping(): Promise<boolean> {
    try { await this.pool.query('select 1'); return true; } catch { return false; }
  }

  async close() {
    if (!this.closed) { this.closed = true; await this.pool.end(); }
  }

  onModuleDestroy() { return this.close(); }
}

/** Audit konsol platform (append-only, platform_audit_log). Kegagalan ditulis di transaksi tersendiri (lihat audit()). */
export async function platformAudit(tx: Tx, action: string, opts: {
  actor?: string | null; tenantId?: string | null; resourceType?: string; resourceId?: string | null; summary?: object | null;
} = {}) {
  const c = ctx();
  await tx.execute(sql`insert into platform_audit_log(actor_platform_user, action, target_tenant_id, resource_type, resource_id,
                                                      ip, request_id, change_summary)
                       values (${opts.actor ?? c.platformUserId ?? null}::uuid, ${action}, ${opts.tenantId ?? null}::uuid,
                               ${opts.resourceType ?? null}, ${opts.resourceId ?? null}, ${cleanIp(c.ip)}::inet, ${c.requestId},
                               ${opts.summary ? JSON.stringify(opts.summary) : null}::jsonb)`);
}

/** Audit di rantai hash tenant dengan actor_kind PLATFORM / PLATFORM_SUPPORT (dipanggil di dalam forTenant). */
export async function tenantAuditAsPlatform(tx: Tx, action: string, resourceType: string, resourceId: string | null, summary: object | null = null,
                                            kind: 'PLATFORM' | 'PLATFORM_SUPPORT' = 'PLATFORM') {
  const c = ctx();
  await tx.execute(sql`select app.write_audit(${action}, ${resourceType}, ${resourceId}::uuid, null::uuid,
                                              ${summary ? JSON.stringify(summary) : null}::jsonb, ${kind}, ${cleanIp(c.ip)}::inet, ${c.requestId})`);
}

function cleanIp(ip?: string): string | null {
  return ip && /^[0-9a-f:.]+$/i.test(ip) ? ip.replace(/^::ffff:/, '') : null;
}
