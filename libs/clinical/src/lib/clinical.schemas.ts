import { z } from 'zod';
import { Uuid, optText } from '@clinicrme/shared';
import { TEMPLATE_CODES } from './templates';

/**
 * Batas input tanda vital (CLN-FR-002): menolak salah ketik yang mustahil secara fisiologis, BUKAN peringatan klinis
 * (CLN-FR-003 LJT). `[REVIEW-MEDIS]`.
 */
export const VITAL_LIMITS = {
  systolic: { code: 'SYSTOLIC', unit: 'mmHg', min: 40, max: 300 },
  diastolic: { code: 'DIASTOLIC', unit: 'mmHg', min: 20, max: 200 },
  heartRate: { code: 'HEART_RATE', unit: 'x/menit', min: 20, max: 300 },
  respRate: { code: 'RESP_RATE', unit: 'x/menit', min: 4, max: 80 },
  temperature: { code: 'TEMPERATURE', unit: '°C', min: 30, max: 45 },
  spo2: { code: 'SPO2', unit: '%', min: 50, max: 100 },
  weight: { code: 'WEIGHT', unit: 'kg', min: 0.3, max: 400 },
  height: { code: 'HEIGHT', unit: 'cm', min: 20, max: 250 },
  painScale: { code: 'PAIN_SCALE', unit: '0-10', min: 0, max: 10 },
} as const;
export type VitalKey = keyof typeof VITAL_LIMITS;
const num = (k: VitalKey) => z.number().min(VITAL_LIMITS[k].min).max(VITAL_LIMITS[k].max).optional();
export const VitalsBody = z.object(Object.fromEntries(Object.keys(VITAL_LIMITS).map((k) => [k, num(k as VitalKey)])) as Record<VitalKey, ReturnType<typeof num>>)
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Isi minimal satu tanda vital')
  .refine((v) => (v.systolic === undefined) === (v.diastolic === undefined), 'Tekanan darah sistolik & diastolik diisi bersama')
  .refine((v) => v.systolic === undefined || v.diastolic === undefined || v.systolic > v.diastolic, 'Sistolik harus lebih besar dari diastolik');

const soap = { subjective: optText(10_000), objective: optText(10_000), assessment: optText(10_000), plan: optText(10_000) };
export const NoteBody = z.object({ templateCode: z.enum(TEMPLATE_CODES).optional(), ...soap, structured: z.record(z.string(), z.unknown()).optional() }).strict();
export const AnamnesisBody = z.object({ subjective: z.string().trim().max(10_000) }).strict();

export const DiagnosesBody = z.array(z.object({
  conceptId: Uuid, rank: z.enum(['PRIMER', 'SEKUNDER']), caseStatus: z.enum(['BARU', 'LAMA']).default('BARU'), note: optText(500),
}).strict()).max(20)
  .refine((d) => d.filter((x) => x.rank === 'PRIMER').length <= 1, 'Hanya satu diagnosis primer')
  .refine((d) => new Set(d.map((x) => x.conceptId)).size === d.length, 'Diagnosis yang sama tercantum dua kali');

export const ProcedureBody = z.object({
  serviceItemId: Uuid, conceptId: Uuid.nullable().optional(), performedBy: Uuid.optional(),
  qty: z.number().positive().max(100).default(1),
}).strict();

export const AllergyBody = z.object({
  substance: z.string().trim().min(2).max(200), category: z.enum(['OBAT', 'MAKANAN', 'LINGKUNGAN', 'LAINNYA']),
  reaction: optText(500), severity: z.enum(['RINGAN', 'SEDANG', 'BERAT']).nullable().optional(),
}).strict();
export const HistoryBody = z.object({
  historyType: z.enum(['PENYAKIT', 'OBAT_RUTIN', 'KELUARGA', 'SOSIAL', 'OPERASI']), description: z.string().trim().min(2).max(1000),
}).strict();
export const StatusBody = z.object({ status: z.enum(['INACTIVE', 'ENTERED_IN_ERROR']), reason: z.string().trim().min(3).max(500) }).strict();
