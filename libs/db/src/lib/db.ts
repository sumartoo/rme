import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql, SQL } from 'drizzle-orm';
import { ctx } from '@clinicrme/shared';

export type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

/**
 * Satu-satunya pintu ke database (APP_DESIGN §4, SC-TEN-02).
 * - withTenantTx: tenant dari konteks sesi; gagal bila tidak ada (fail-closed).
 * - withTenant: hanya untuk alur pra-autentikasi (login) dengan tenant dari subdomain.
 * - preAuth: memanggil fungsi SECURITY DEFINER sempit (resolve_tenant / resolve_session).
 * Pool mentah tidak diekspor sehingga modul lain tidak bisa melewati tenant context.
 */
export class Db {
  private readonly pool: Pool;
  private readonly db: NodePgDatabase;
  private closed = false;

  constructor(cfg: { url: string; poolMax: number }) {
    // search_path ditetapkan saat koneksi dibuka (parameter startup), bukan lewat query terpisah
    this.pool = new Pool({ connectionString: cfg.url, max: cfg.poolMax, options: '-c search_path=app,public' });
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

  /** Untuk readiness probe: koneksi hidup, tanpa menyentuh data tenant. */
  async ping(): Promise<boolean> {
    try { await this.pool.query('select 1'); return true; } catch { return false; }
  }

  async close() {
    if (!this.closed) { this.closed = true; await this.pool.end(); }
  }

  onModuleDestroy() { return this.close(); }
}

export async function rows<T = Record<string, any>>(tx: Tx, q: SQL): Promise<T[]> {
  const r = await tx.execute(q);
  return r.rows as T[];
}

/**
 * Tulis audit lewat app.write_audit (hash chain, ADR-0007).
 * PENTING: audit kegagalan/penolakan harus di transaksi tersendiri yang di-commit sebelum error dilempar —
 * bila ditulis di transaksi yang kemudian di-rollback, catatannya hilang (temuan Stage 3, E04).
 */
export async function audit(tx: Tx, action: string, resourceType: string, resourceId: string | null,
                            patientId: string | null = null, summary: object | null = null) {
  const c = ctx();
  await tx.execute(sql`select app.write_audit(${action}, ${resourceType}, ${resourceId}::uuid, ${patientId}::uuid,
                                              ${summary ? JSON.stringify(summary) : null}::jsonb, 'USER', ${cleanIp(c.ip)}::inet, ${c.requestId})`);
}

function cleanIp(ip?: string): string | null {
  return ip && /^[0-9a-f:.]+$/i.test(ip) ? ip.replace(/^::ffff:/, '') : null;
}
