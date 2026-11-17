import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { Uuid, ctx, problem } from '@clinicrme/shared';
import { type Tx, rows } from '@clinicrme/db';

/**
 * Bagian bersama laporan standar (Stage 14; OD-124, OD-129, OD-130 / DEC-047):
 * - filter seragam (rentang tanggal ≤ 366 hari, cabang, poli, dokter, jenis penjamin), tanggal menurut zona waktu cabang;
 * - cakupan cabang dari penugasan role user yang memberi izin laporan (IAM-FR-009);
 * - batas waktu query 30 detik; CSV UTF-8 BOM.
 */
export const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const MAX_DAYS = 366;
export const PAYER_TYPES = ['UMUM', 'ASURANSI', 'PERUSAHAAN', 'BPJS'] as const;
export const PAYER_LABEL: Record<string, string> = { UMUM: 'Umum', ASURANSI: 'Asuransi', PERUSAHAAN: 'Perusahaan', BPJS: 'BPJS' };

export const BaseFilter = z.object({
  from: DATE, to: DATE, branchId: Uuid.optional(), unitId: Uuid.optional(), practitionerId: Uuid.optional(),
  payerType: z.enum(PAYER_TYPES).optional(), format: z.enum(['json', 'csv']).default('json'),
});
export type Base = z.infer<typeof BaseFilter>;

export function parseQuery<T extends z.ZodType>(schema: T, query: Record<string, string | undefined>): z.infer<T> {
  const P = schema.safeParse(query);
  if (!P.success) throw problem(400, 'GEN-400-QUERY', `Parameter tidak valid: ${P.error.issues[0]?.path.join('.') || 'query'} — ${P.error.issues[0]?.message}`);
  const f = P.data as Base;
  if (f.from > f.to) throw problem(400, 'GEN-400-QUERY', 'Tanggal awal setelah tanggal akhir');
  if ((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000 > MAX_DAYS - 1) throw problem(400, 'GEN-400-QUERY', `Rentang maksimal ${MAX_DAYS} hari`);
  return P.data;
}

/** OD-130: query laporan interaktif dihentikan setelah 30 detik (berlaku di transaksi ini saja). */
export async function reportTimeout(tx: Tx) {
  await tx.execute(sql`set local statement_timeout = '30s'`);
}

/**
 * OD-129: cabang yang boleh dilihat user untuk izin laporan ini. `null` = semua cabang (ada penugasan role tanpa cabang).
 * Filter cabang di luar cakupan → 403.
 */
export async function branchScope(tx: Tx, permission: string, branchId?: string): Promise<string[] | null> {
  const [s] = await rows<{ all_branches: boolean | null; ids: string[] | null }>(tx, sql`
    select bool_or(a.branch_id is null) as all_branches, array_agg(distinct a.branch_id) filter (where a.branch_id is not null) as ids
      from user_role_assignment a join role_permission rp on rp.role_id = a.role_id and rp.permission_code = ${permission}
     where a.user_id = ${ctx().userId} and (a.valid_to is null or a.valid_to > now())`);
  const allowed = s?.all_branches ? null : (s?.ids ?? []);
  if (branchId) {
    const [b] = await rows<{ id: string }>(tx, sql`select id from branch where id = ${branchId}`);
    if (!b) throw problem(404, 'MST-404-BRANCH', 'Cabang tidak ditemukan');
    if (allowed && !allowed.includes(branchId)) throw problem(403, 'RPT-403-BRANCH', 'Laporan cabang ini di luar cakupan Anda');
    return [branchId];
  }
  return allowed;
}

/** Kondisi SQL cakupan cabang untuk kolom `col` (mis. sql`b.id`). */
export const inBranches = (col: SQL, scope: string[] | null): SQL =>
  scope === null ? sql`true` : sql`${col} = any(${`{${scope.join(',')}}`}::uuid[])`;

export interface Column { key: string; label: string; type: 'string' | 'number' | 'money' | 'percent' | 'date' }
export const csvOf = (cols: Column[], data: Record<string, unknown>[]) => {
  const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return `\uFEFF${[cols.map((c) => c.label).join(','), ...data.map((r) => cols.map((c) => esc(r[c.key])).join(','))].join('\r\n')}\r\n`;
};
/** Ringkasan filter untuk audit (tanpa isi laporan). */
export const filterSummary = (f: Base & Record<string, unknown>) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
