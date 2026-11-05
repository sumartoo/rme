/** Validasi & optimistic locking bersama untuk modul fitur (dipindah dari masterdata, Stage 8). */
import { z } from 'zod';
import { problem } from './problem';

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

