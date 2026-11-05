import { z } from 'zod';
import { IsoDate, Name, Uuid, optDate, optText } from '@clinicrme/shared';

export const SEXES = ['L', 'P', 'TIDAK_DIKETAHUI'] as const;
export const IDENTITY_TYPES = ['NIK', 'PASPOR', 'KITAS', 'BAYI_IDENTITAS_IBU', 'TANPA_IDENTITAS'] as const;
export type IdentityType = (typeof IDENTITY_TYPES)[number];

/** NIK 16 digit; dua digit pertama kode provinsi (11–96). Validasi struktur saja, bukan keabsahan kependudukan. */
export const Nik = z.string().trim().regex(/^(1[1-9]|[2-9]\d)\d{14}$/, 'NIK harus 16 digit angka');

/** Telepon Indonesia dinormalkan ke awalan 0 (+62 / 62 → 0) agar pencarian & deteksi duplikat konsisten. */
export function normalizePhone(v: string): string {
  const d = v.replace(/[\s().-]/g, '');
  if (d.startsWith('+62')) return `0${d.slice(3)}`;
  if (d.startsWith('62') && d.length >= 11) return `0${d.slice(2)}`;
  return d;
}
export const Phone = z.string().trim().transform(normalizePhone)
  .pipe(z.string().regex(/^\+?\d{6,16}$/, 'Nomor telepon tidak valid'));

/** Nama dirapikan: spasi ganda dibuang. */
const PersonName = Name.transform((s) => s.replace(/\s+/g, ' '));

export const ContactBody = z.object({
  relation: z.string().trim().min(2).max(50),
  fullName: PersonName,
  phone: Phone,
  isGuardian: z.boolean().optional(),
}).strict();

export const CoverageBody = z.object({
  payerId: Uuid,
  memberNo: optText(50),
  planName: optText(100),
  employeeNo: optText(50),
  bpjsFaskesCode: optText(20),
  validFrom: optDate,
  validTo: optDate,
}).strict();
export const CoveragePatch = CoverageBody.omit({ payerId: true }).extend({ isActive: z.boolean().optional() }).partial().strict();

const Base = z.object({
  fullName: PersonName,
  birthDate: IsoDate,
  sex: z.enum(SEXES),
  identityType: z.enum(IDENTITY_TYPES),
  nik: Nik.nullable().optional(),
  identityValue: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,30}$/, 'Nomor identitas 3–30 huruf/angka').nullable().optional(),
  motherPatientId: Uuid.nullable().optional(),
  phone: Phone.nullable().optional(),
  email: z.string().trim().max(200).pipe(z.email('Email tidak valid')).nullable().optional(),
  address: z.string().trim().min(5, 'Alamat minimal 5 karakter').max(500),
  regionCode: z.string().regex(/^\d{2}(\.\d{2}(\.\d{2}(\.\d{4})?)?)?$/, 'Kode wilayah tidak valid').nullable().optional(),
  contacts: z.array(ContactBody).max(10).optional(),
});

export interface PatientFields {
  fullName: string; birthDate: string; sex: string; identityType: IdentityType; nik?: string | null; identityValue?: string | null;
  motherPatientId?: string | null; phone?: string | null; address: string; contactCount: number;
}

/**
 * OD-085 (DEC-035) data wajib registrasi: nama, tanggal lahir, jenis kelamin, jenis identitas + nomornya (kecuali tanpa
 * identitas), telepon ATAU kontak darurat, alamat. Bayi dengan identitas ibu wajib tertaut ke pasien ibu.
 * Dipakai untuk tambah (body) dan ubah (setelah digabung dengan nilai lama).
 */
export function registrationRules(p: PatientFields, today = new Date()): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  const t = new Date(today.getTime() + 9 * 3600_000).toISOString().slice(0, 10);   // tanggal di WIT (zona paling timur)
  const minDate = `${today.getUTCFullYear() - 150}${t.slice(4)}`;
  if (p.birthDate > t) errors.push({ field: 'birthDate', message: 'Tanggal lahir tidak boleh di masa depan' });
  if (p.birthDate < minDate) errors.push({ field: 'birthDate', message: 'Tanggal lahir tidak wajar' });
  const needNik = p.identityType === 'NIK', needValue = p.identityType === 'PASPOR' || p.identityType === 'KITAS';
  if (needNik && !p.nik) errors.push({ field: 'nik', message: 'NIK wajib untuk jenis identitas NIK' });
  if (!needNik && p.nik) errors.push({ field: 'nik', message: 'NIK hanya diisi bila jenis identitas NIK' });
  if (needValue && !p.identityValue) errors.push({ field: 'identityValue', message: 'Nomor paspor/KITAS wajib' });
  if (!needValue && p.identityValue) errors.push({ field: 'identityValue', message: 'Nomor identitas hanya untuk paspor/KITAS' });
  if (p.identityType === 'BAYI_IDENTITAS_IBU' && !p.motherPatientId) {
    errors.push({ field: 'motherPatientId', message: 'Bayi dengan identitas ibu wajib ditautkan ke data pasien ibu' });
  }
  if (!p.phone && p.contactCount === 0) errors.push({ field: 'phone', message: 'Isi telepon pasien atau minimal satu kontak darurat' });
  return errors;
}

export const PatientCreate = Base.extend({
  coverages: z.array(CoverageBody).max(5).optional(),
  duplicateOverrideReason: z.string().trim().min(10, 'Alasan minimal 10 karakter').max(500).optional(),
}).strict().superRefine((b, c) => {
  for (const e of registrationRules({ ...b, contactCount: b.contacts?.length ?? 0 })) c.addIssue({ code: 'custom', path: [e.field], message: e.message });
});
/** Ubah sebagian; penjamin diubah lewat endpoint penjamin. `contacts` bila dikirim menggantikan seluruh daftar. */
export const PatientUpdate = Base.partial().strict();

export const SearchQuery = z.object({
  q: z.string().trim().max(100).optional(),
  nik: Nik.optional(),
  mrn: z.string().trim().max(30).optional(),
  phone: z.string().trim().max(30).optional(),
  birthDate: IsoDate.optional(),
  includeMerged: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().regex(/^\d{1,6}$/).optional(),
});

export const RestrictionBody = z.object({
  restricted: z.boolean(),
  reason: z.string().trim().min(5, 'Alasan minimal 5 karakter').max(500),
}).strict();

export const MergeBody = z.object({
  sourcePatientId: Uuid,
  targetPatientId: Uuid,
  reason: z.string().trim().min(10, 'Alasan minimal 10 karakter').max(500),
}).strict().refine((b) => b.sourcePatientId !== b.targetPatientId, { message: 'Pasien sumber dan tujuan harus berbeda', path: ['targetPatientId'] });

export const ConsentBody = z.object({
  consentDocumentId: Uuid,
  granted: z.boolean(),
  signedByName: optText(200),
  signedByRelation: optText(50),
}).strict();

export const CONSENT_TYPES = ['UMUM', 'DATA_SHARING', 'PORTAL'] as const;
export const ConsentDocumentBody = z.object({
  consentType: z.enum(CONSENT_TYPES),
  version: z.string().trim().regex(/^[A-Za-z0-9._-]{1,20}$/, 'Versi 1–20 huruf/angka'),
  title: z.string().trim().min(3).max(200),
  content: z.string().trim().min(20, 'Isi minimal 20 karakter').max(20000),
}).strict();
