import { z } from 'zod';
import { problem } from '@clinicrme/shared';
import { type Tx, audit } from '@clinicrme/db';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const Uuid = z.string().regex(UUID_RE);
/** Kode master: huruf besar/angka/strip/garis bawah, diawali huruf atau angka. */
export const Code = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,19}$/, 'Kode: 2–20 huruf/angka, boleh - atau _');
export const Name = z.string().trim().min(2).max(200);
/** Teks opsional; string kosong disimpan sebagai null. */
export const optText = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform((v) => (v === undefined ? undefined : v === '' ? null : v));
/** Tanggal kalender YYYY-MM-DD (tanpa zona waktu) yang benar-benar ada. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}, 'Tanggal tidak valid');
export const optDate = IsoDate.nullable().optional();

/** GEN-FR-007 optimistic locking: If-Match wajib berisi versi baris. */
export function ifMatchVersion(header: string | undefined, what: string): number {
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(header ?? '');
  if (!m) throw problem(428, 'GEN-428-IF-MATCH', `Header If-Match (versi ${what}) wajib`);
  return Number(m[1]);
}

export function assertId(id: string, code: string, title: string) {
  if (!UUID_RE.test(id)) throw problem(404, code, title);
}

export function assertVersion(current: number, expected: number, what: string) {
  if (current !== expected) throw problem(412, 'GEN-412-VERSION', `${what} sudah diubah orang lain. Muat ulang lalu coba lagi.`);
}

/** Nilai body yang dikirim menggantikan nilai lama; yang tidak dikirim (undefined) tetap. */
export function merge<T extends Record<string, unknown>>(cur: T, patch: Partial<T>): T {
  const out = { ...cur };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/**
 * MST-FR-009: audit perubahan dengan nilai sebelum/sesudah, hanya kolom yang berubah. Kolom rahasia (NIK) dicatat
 * sebagai "[rahasia]" tanpa nilai. Tidak menulis audit bila tidak ada yang berubah.
 */
const IGNORED = new Set(['id', 'version']);   // identitas & versi baris sudah tercatat di resource_id / ETag
export async function auditChange(
  tx: Tx, action: string, resource: string, id: string,
  before: Record<string, unknown> | null, after: Record<string, unknown>, secret: readonly string[] = [],
) {
  const keys = Object.keys(after).filter((k) => !IGNORED.has(k) && (!before || JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)));
  if (before && keys.length === 0) return;
  const val = (o: Record<string, unknown> | null, k: string) => {
    const v = o?.[k] ?? null;
    return secret.includes(k) && v !== null ? '[rahasia]' : v;
  };
  const pick = (o: Record<string, unknown> | null) => Object.fromEntries(keys.map((k) => [k, val(o, k)]));
  await audit(tx, action, resource, id, null, before ? { changed: keys, before: pick(before), after: pick(after) } : { after: pick(after) });
}
