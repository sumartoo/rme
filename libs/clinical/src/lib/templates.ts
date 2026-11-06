import { z } from 'zod';

/**
 * Template klinis MVP (OD-035 / DEC-038) — **[REVIEW-MEDIS]**: daftar isian di bawah adalah usulan awal dan wajib ditinjau
 * tenaga medis klinik pilot sebelum dipakai (DEC-005, OD-095). Semua template memakai SOAP teks bebas; isian terstruktur
 * melengkapi, bukan menggantikan. Semua isian opsional di draft.
 */
export const TEMPLATE_CODES = ['UMUM', 'GIGI', 'ANAK', 'KEBIDANAN'] as const;
export type TemplateCode = (typeof TEMPLATE_CODES)[number];

export interface TemplateField {
  key: string; label: string; type: 'text' | 'number' | 'date' | 'select';
  section: 'S' | 'O' | 'A' | 'P'; unit?: string; options?: string[]; min?: number; max?: number; maxLength?: number; hint?: string;
}
export interface ClinicalTemplate { code: TemplateCode; name: string; fields: TemplateField[] }

const KESADARAN = ['Compos mentis', 'Apatis', 'Somnolen', 'Sopor', 'Koma'];
const KEADAAN = ['Baik', 'Tampak sakit ringan', 'Tampak sakit sedang', 'Tampak sakit berat'];
const umum: TemplateField[] = [
  { key: 'keadaanUmum', label: 'Keadaan umum', type: 'select', section: 'O', options: KEADAAN },
  { key: 'kesadaran', label: 'Kesadaran', type: 'select', section: 'O', options: KESADARAN },
];

export const TEMPLATES: ClinicalTemplate[] = [
  { code: 'UMUM', name: 'Umum', fields: umum },
  { code: 'GIGI', name: 'Gigi', fields: [
    ...umum,
    { key: 'elemenGigi', label: 'Elemen gigi (notasi FDI)', type: 'text', section: 'O', maxLength: 100, hint: 'mis. 36, 46' },
    { key: 'pemeriksaanIntraoral', label: 'Pemeriksaan intraoral', type: 'text', section: 'O', maxLength: 1000 },
    { key: 'pemeriksaanEkstraoral', label: 'Pemeriksaan ekstraoral', type: 'text', section: 'O', maxLength: 1000 },
  ] },
  { code: 'ANAK', name: 'Anak', fields: [
    ...umum,
    { key: 'lingkarKepala', label: 'Lingkar kepala', type: 'number', section: 'O', unit: 'cm', min: 20, max: 70 },
    { key: 'statusImunisasi', label: 'Status imunisasi', type: 'select', section: 'S', options: ['Lengkap sesuai usia', 'Belum lengkap', 'Tidak diketahui'] },
    { key: 'riwayatImunisasi', label: 'Catatan imunisasi', type: 'text', section: 'S', maxLength: 500 },
    { key: 'perkembangan', label: 'Tumbuh kembang', type: 'text', section: 'O', maxLength: 500 },
  ] },
  { code: 'KEBIDANAN', name: 'Kebidanan', fields: [
    ...umum,
    { key: 'hpht', label: 'HPHT', type: 'date', section: 'S', hint: 'Hari pertama haid terakhir' },
    { key: 'gravida', label: 'Gravida', type: 'number', section: 'S', min: 0, max: 20 },
    { key: 'para', label: 'Para', type: 'number', section: 'S', min: 0, max: 20 },
    { key: 'abortus', label: 'Abortus', type: 'number', section: 'S', min: 0, max: 20 },
    { key: 'usiaKehamilanMinggu', label: 'Usia kehamilan', type: 'number', section: 'O', unit: 'minggu', min: 0, max: 45 },
    { key: 'tfu', label: 'Tinggi fundus uteri', type: 'number', section: 'O', unit: 'cm', min: 0, max: 50 },
    { key: 'djj', label: 'Denyut jantung janin', type: 'number', section: 'O', unit: 'x/menit', min: 50, max: 250 },
  ] },
];

/** Validasi isian terstruktur sesuai template: hanya kunci yang dikenal, tipe & batasnya. */
export function structuredSchema(code: TemplateCode) {
  const t = TEMPLATES.find((x) => x.code === code);
  if (!t) throw new Error(`template ${code}`);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of t.fields) {
    let s: z.ZodTypeAny;
    if (f.type === 'number') s = z.number().min(f.min ?? -1e9).max(f.max ?? 1e9);
    else if (f.type === 'date') s = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    else if (f.type === 'select') s = z.enum(f.options as [string, ...string[]]);
    else s = z.string().trim().max(f.maxLength ?? 500);
    shape[f.key] = s.nullable().optional();
  }
  return z.object(shape).strict();
}
