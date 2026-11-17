import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

/**
 * Bagian bersama laporan standar (Stage 14; OD-124, OD-129, OD-130 / DEC-047). Dipakai API (`libs/reporting`) dan worker
 * (ekspor asinkron), jadi tidak bergantung pada Nest maupun konteks request:
 * - filter seragam (rentang tanggal ≤ 366 hari, cabang, poli, dokter, jenis penjamin), tanggal menurut zona waktu cabang;
 * - cakupan cabang dihitung pemanggil dan diteruskan sebagai `scope` (`null` = semua cabang);
 * - batas waktu query 30 detik; CSV UTF-8 BOM.
 */
export const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'UUID tidak valid');
export const MAX_DAYS = 366;
export const PAYER_TYPES = ['UMUM', 'ASURANSI', 'PERUSAHAAN', 'BPJS'] as const;
export const PAYER_LABEL: Record<string, string> = { UMUM: 'Umum', ASURANSI: 'Asuransi', PERUSAHAAN: 'Perusahaan', BPJS: 'BPJS' };
export const FORMAT = z.enum(['json', 'csv']).default('json');

export const BaseFilter = z.object({
  from: DATE, to: DATE, branchId: UUID.optional(), unitId: UUID.optional(), practitionerId: UUID.optional(),
  payerType: z.enum(PAYER_TYPES).optional(), format: FORMAT,
});
export type Base = z.infer<typeof BaseFilter>;

/** Galat laporan yang aman ditampilkan; API memetakan ke problem+json. */
export class ReportError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Minimal: transaksi drizzle maupun instance drizzle di worker. */
export interface Q { execute(q: SQL): Promise<{ rows: unknown[] }> }
export const rowsOf = async <T>(tx: Q, q: SQL): Promise<T[]> => (await tx.execute(q)).rows as T[];

export function parseQuery<T extends z.ZodType>(schema: T, query: Record<string, unknown>): z.infer<T> {
  const P = schema.safeParse(query);
  if (!P.success) throw new ReportError(400, 'GEN-400-QUERY', `Parameter tidak valid: ${P.error.issues[0]?.path.join('.') || 'query'} — ${P.error.issues[0]?.message}`);
  const f = P.data as Partial<Base>;
  if (f.from && f.to) {
    if (f.from > f.to) throw new ReportError(400, 'GEN-400-QUERY', 'Tanggal awal setelah tanggal akhir');
    if ((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000 > MAX_DAYS - 1) throw new ReportError(400, 'GEN-400-QUERY', `Rentang maksimal ${MAX_DAYS} hari`);
  }
  return P.data;
}

/** OD-130: query laporan dihentikan setelah 30 detik (berlaku di transaksi ini saja). */
export async function reportTimeout(tx: Q) {
  await tx.execute(sql`set local statement_timeout = '30s'`);
}

/**
 * OD-129: cabang yang boleh dilihat user untuk izin laporan ini. `null` = semua cabang (ada penugasan role tanpa cabang).
 * Filter cabang di luar cakupan → 403.
 */
export async function branchScope(tx: Q, userId: string, permission: string, branchId?: string): Promise<string[] | null> {
  const [s] = await rowsOf<{ all_branches: boolean | null; ids: string[] | null }>(tx, sql`
    select bool_or(a.branch_id is null) as all_branches, array_agg(distinct a.branch_id) filter (where a.branch_id is not null) as ids
      from user_role_assignment a join role_permission rp on rp.role_id = a.role_id and rp.permission_code = ${permission}
     where a.user_id = ${userId} and (a.valid_to is null or a.valid_to > now())`);
  const allowed = s?.all_branches ? null : (s?.ids ?? []);
  if (branchId) {
    const [b] = await rowsOf<{ id: string }>(tx, sql`select id from branch where id = ${branchId}`);
    if (!b) throw new ReportError(404, 'MST-404-BRANCH', 'Cabang tidak ditemukan');
    if (allowed && !allowed.includes(branchId)) throw new ReportError(403, 'RPT-403-BRANCH', 'Laporan cabang ini di luar cakupan Anda');
    return [branchId];
  }
  return allowed;
}

/** Kondisi SQL cakupan cabang untuk kolom `col` (mis. sql`b.id`). */
export const inBranches = (col: SQL, scope: string[] | null): SQL =>
  scope === null ? sql`true` : sql`${col} = any(${`{${scope.join(',')}}`}::uuid[])`;

export interface Column { key: string; label: string; type: 'string' | 'number' | 'money' | 'percent' | 'date' | 'datetime' }
export interface ReportResult { columns: Column[]; rows: Record<string, unknown>[]; totals?: Record<string, unknown>; extra?: Record<string, unknown> }

export const csvOf = (cols: Column[], data: Record<string, unknown>[]) => {
  const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return `\uFEFF${[cols.map((c) => c.label).join(','), ...data.map((r) => cols.map((c) => esc(r[c.key])).join(','))].join('\r\n')}\r\n`;
};
/** Ringkasan filter untuk audit (tanpa isi laporan). */
export const filterSummary = (f: Record<string, unknown>) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
export const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
