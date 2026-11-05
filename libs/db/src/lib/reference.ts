import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Client } from 'pg';

/**
 * Pemuat data referensi global (Stage 7 batch 3, DEC-032): wilayah administratif (MST-FR-011, OD-062) dan code system
 * ICD-10 / ICD-9-CM (TRM-FR-001/002, OD-030). Dijalankan dengan role PEMILIK skema (tabel global hanya-baca bagi
 * aplikasi). Idempoten: dataset dengan id + versi + sha256 sama dilewati; berkas yang isinya tidak cocok dengan
 * sha256 di MANIFEST.json ditolak. Kode asli tidak pernah diubah; versi code system baru menjadi `is_current`,
 * versi lama tetap tersimpan untuk data historis.
 */
interface Dataset {
  id: string; kind: 'region' | 'code_system'; file: string; sha256: string; version: string; source: string; license: string;
  system?: 'ICD10' | 'ICD9CM' | 'KFA' | 'LOINC' | 'SNOMED'; effectiveDate?: string;
}
export interface ReferenceResult { id: string; status: 'loaded' | 'skipped'; rows: number }

const CHUNK = 5000;

/** CSV RFC 4180 sederhana (pemisah koma/titik koma, kutip ganda, "" untuk kutip di dalam nilai). Baris pertama = header. */
export function parseCsv(text: string, delimiter = ','): Record<string, string>[] {
  return toRecords(parseCsvRows(text, delimiter));
}
export function toRecords(rows: string[][]): Record<string, string>[] {
  const [header = [], ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}
export function parseCsvRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function readDataset(dir: string, d: Dataset): Record<string, string>[] {
  const raw = readFileSync(join(dir, d.file));
  const sum = createHash('sha256').update(raw).digest('hex');
  if (sum !== d.sha256) throw new Error(`Dataset ${d.id}: sha256 berkas ${d.file} tidak cocok dengan MANIFEST.json`);
  return parseCsv((d.file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
}

const regionLevel = (code: string) => code.split('.').length;
const regionParent = (code: string) => (code.includes('.') ? code.slice(0, code.lastIndexOf('.')) : null);

async function loadRegions(c: Client, rows: Record<string, string>[]) {
  for (const r of rows) {
    if (!/^\d{2}(\.\d{2}(\.\d{2}(\.\d{4})?)?)?$/.test(r.code) || !r.name.trim()) throw new Error(`Wilayah tidak valid: ${r.code}`);
  }
  // Induk lebih dulu (urut tingkat) agar FK parent_code terpenuhi
  const sorted = [...rows].sort((a, b) => regionLevel(a.code) - regionLevel(b.code) || a.code.localeCompare(b.code));
  for (let i = 0; i < sorted.length; i += CHUNK) {
    const part = sorted.slice(i, i + CHUNK);
    await c.query(`INSERT INTO app.region(code, parent_code, level, name)
                   SELECT * FROM unnest($1::text[], $2::text[], $3::smallint[], $4::text[])
                   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, parent_code = EXCLUDED.parent_code, level = EXCLUDED.level`,
      [part.map((r) => r.code), part.map((r) => regionParent(r.code)), part.map((r) => regionLevel(r.code)), part.map((r) => r.name.trim())]);
  }
}

async function loadCodeSystem(c: Client, d: Dataset, rows: Record<string, string>[]) {
  if (!d.system) throw new Error(`Dataset ${d.id}: field system wajib`);
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.code || !r.display_id) throw new Error(`Dataset ${d.id}: kode/display kosong`);
    if (seen.has(r.code)) throw new Error(`Dataset ${d.id}: kode ganda ${r.code}`);
    seen.add(r.code);
  }
  const { rows: [sys] } = await c.query<{ id: string }>(
    `INSERT INTO app.code_system(code, version, source, effective_date, is_current) VALUES ($1, $2, $3, $4, false)
     ON CONFLICT (code, version) DO UPDATE SET source = EXCLUDED.source, effective_date = EXCLUDED.effective_date RETURNING id`,
    [d.system, d.version, d.source, d.effectiveDate ?? null]);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    await c.query(`INSERT INTO app.concept(system_id, code, display_id, display_en, parent_code, synonyms)
                   SELECT $1, t.code, t.display_id, nullif(t.display_en, ''), nullif(t.parent_code, ''),
                          coalesce(array(select s from unnest(string_to_array(t.synonyms, '|')) s where s <> ''), '{}')
                     FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) t(code, display_id, display_en, parent_code, synonyms)
                   ON CONFLICT (system_id, code) DO UPDATE SET display_id = EXCLUDED.display_id, display_en = EXCLUDED.display_en,
                          parent_code = EXCLUDED.parent_code, synonyms = EXCLUDED.synonyms, is_active = true`,
      [sys.id, part.map((r) => r.code), part.map((r) => r.display_id), part.map((r) => r.display_en ?? ''),
       part.map((r) => r.parent_code ?? ''), part.map((r) => r.synonyms ?? '')]);
  }
  // Kode yang tidak lagi ada di versi ini dinonaktifkan (bukan dihapus: bisa dirujuk data lama)
  await c.query(`UPDATE app.concept SET is_active = false WHERE system_id = $1 AND NOT (code = ANY($2::text[]))`, [sys.id, [...seen]]);
  await c.query(`UPDATE app.code_system SET is_current = false WHERE code = $1 AND id <> $2 AND is_current`, [d.system, sys.id]);
  await c.query(`UPDATE app.code_system SET is_current = true WHERE id = $1`, [sys.id]);
}

export async function loadReference(ownerUrl: string, dir: string, log: (m: string) => void = () => undefined): Promise<ReferenceResult[]> {
  const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as { datasets: Dataset[] };
  const c = new Client({ connectionString: ownerUrl });
  await c.connect();
  const out: ReferenceResult[] = [];
  try {
    for (const d of manifest.datasets) {
      const { rows: [cur] } = await c.query<{ version: string; sha256: string }>(`SELECT version, sha256 FROM app.reference_dataset WHERE id = $1`, [d.id]);
      if (cur && cur.version === d.version && cur.sha256 === d.sha256) { out.push({ id: d.id, status: 'skipped', rows: 0 }); continue; }
      const rows = readDataset(dir, d);
      await c.query('BEGIN');
      try {
        if (d.kind === 'region') await loadRegions(c, rows);
        else await loadCodeSystem(c, d, rows);
        await c.query(`INSERT INTO app.reference_dataset(id, version, sha256, source, license, row_count) VALUES ($1, $2, $3, $4, $5, $6)
                       ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, sha256 = EXCLUDED.sha256, source = EXCLUDED.source,
                              license = EXCLUDED.license, row_count = EXCLUDED.row_count, loaded_at = now()`,
          [d.id, d.version, d.sha256, d.source, d.license, rows.length]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; }
      log(`Referensi ${d.id} ${d.version}: ${rows.length} baris dimuat`);
      out.push({ id: d.id, status: 'loaded', rows: rows.length });
    }
  } finally { await c.end(); }
  return out;
}
