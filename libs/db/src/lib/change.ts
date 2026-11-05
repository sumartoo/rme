import { type Tx, audit } from './db';

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
