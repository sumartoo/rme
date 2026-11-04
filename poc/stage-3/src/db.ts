import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql, SQL } from 'drizzle-orm';
import { ctx } from './context';
import { AppConfig } from './config';

export type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

/**
 * Satu-satunya pintu ke database (APP_DESIGN §4, SC-TEN-02).
 * - withTenantTx: memakai tenant dari konteks sesi; gagal bila tidak ada.
 * - withTenant: hanya untuk alur pra-autentikasi (login) dengan tenant dari subdomain.
 * - preAuth: memanggil fungsi SECURITY DEFINER sempit (resolve_tenant / resolve_session).
 * Pool mentah tidak diekspor sehingga modul lain tidak bisa melewati RLS context.
 */
export class Db {
  private readonly pool: Pool;
  private readonly db: NodePgDatabase;

  constructor(cfg: AppConfig['db']) {
    this.pool = new Pool({ ...cfg, max: 10 });
    this.pool.on('connect', (c) => c.query('SET search_path = app, public'));
    this.db = drizzle(this.pool);
  }

  async withTenantTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const c = ctx();
    if (!c.tenantId) throw new Error('Tenant context belum di-set (fail-closed)');
    return this.withTenant(c.tenantId, fn, c.userId);
  }

  async withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, userId?: string): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId ?? ''}, true)`);
      return fn(tx);
    });
  }

  async preAuth<T = Record<string, unknown>>(query: SQL): Promise<T[]> {
    const r = await this.db.execute(query);
    return r.rows as T[];
  }

  async close() {
    if (!this.closed) { this.closed = true; await this.pool.end(); }
  }
  private closed = false;
  /** Dipanggil Nest saat app.close() */
  onModuleDestroy() { return this.close(); }
}

export async function rows<T = Record<string, any>>(tx: Tx, q: SQL): Promise<T[]> {
  const r = await tx.execute(q);
  return r.rows as T[];
}

export async function audit(tx: Tx, action: string, resourceType: string, resourceId: string | null,
                            patientId: string | null = null, summary: object | null = null) {
  await tx.execute(sql`select app.write_audit(${action}, ${resourceType}, ${resourceId}::uuid, ${patientId}::uuid,
                                              ${summary ? JSON.stringify(summary) : null}::jsonb, 'USER', ${ctxIp()}::inet, ${ctx().requestId})`);
}
function ctxIp(): string | null {
  const ip = ctx().ip;
  return ip && /^[0-9a-f:.]+$/i.test(ip) ? ip.replace(/^::ffff:/, '') : null;
}
