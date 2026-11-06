import { z } from 'zod';
import { IsoDate, Uuid, optDate, optText } from '@clinicrme/shared';

/** Jam lokal cabang "HH:MM" (24 jam). */
export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format jam HH:MM');
export const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const Reason = z.string().trim().min(3, 'Alasan minimal 3 karakter').max(500);
/** Waktu slot dengan zona (mis. 2026-11-10T08:00:00+07:00) — sama persis dengan `start` dari daftar slot. */
const SlotStart = z.iso.datetime({ offset: true, message: 'Waktu slot harus ISO 8601 dengan zona waktu' });

const ScheduleBase = z.object({
  practitionerId: Uuid,
  branchId: Uuid,
  unitId: Uuid,
  dayOfWeek: z.number().int().min(1).max(7),
  startTime: HHMM,
  endTime: HHMM,
  slotMinutes: z.number().int().min(5).max(120).default(15),
  quota: z.number().int().min(1).optional(),
  validFrom: IsoDate.optional(),
  validTo: optDate,
});

/** Kuota (OD-090) = jumlah janji temu per sesi; bawaan = jumlah slot, tidak boleh lebih dari itu. */
export function scheduleShapeErrors(s: { startTime: string; endTime: string; slotMinutes: number; quota?: number;
                                         validFrom?: string | null; validTo?: string | null }) {
  const errors: { field: string; message: string }[] = [];
  const span = minutesOf(s.endTime) - minutesOf(s.startTime);
  if (span <= 0) errors.push({ field: 'endTime', message: 'Jam selesai harus setelah jam mulai' });
  else if (span < s.slotMinutes) errors.push({ field: 'slotMinutes', message: 'Durasi slot lebih panjang dari sesi' });
  else if (s.quota !== undefined && s.quota > Math.floor(span / s.slotMinutes)) {
    errors.push({ field: 'quota', message: `Kuota maksimal ${Math.floor(span / s.slotMinutes)} (jumlah slot sesi ini)` });
  }
  if (s.validFrom && s.validTo && s.validTo < s.validFrom) errors.push({ field: 'validTo', message: 'Tanggal akhir sebelum tanggal mulai' });
  return errors;
}

export const ScheduleCreate = ScheduleBase.strict().superRefine((b, c) => {
  for (const e of scheduleShapeErrors(b)) c.addIssue({ code: 'custom', path: [e.field], message: e.message });
});
/** Ubah jadwal: unit/cabang/dokter tetap (buat jadwal baru untuk itu). */
export const ScheduleUpdate = ScheduleBase.omit({ practitionerId: true, branchId: true, unitId: true })
  .extend({ slotMinutes: z.number().int().min(5).max(120), isActive: z.boolean() }).partial().strict();

export const ExceptionCreate = z.object({
  practitionerId: Uuid.optional(),
  branchId: Uuid.optional(),
  exceptionDate: IsoDate,
  reason: Reason,
}).strict().refine((b) => !!b.practitionerId !== !!b.branchId, {
  message: 'Isi salah satu: dokter (cuti) atau cabang (libur)', path: ['practitionerId'],
});

export const SlotQuery = z.object({
  date: IsoDate,
  practitionerId: Uuid.optional(),
  branchId: Uuid.optional(),
  unitId: Uuid.optional(),
});

export const AppointmentCreate = z.object({
  patientId: Uuid,
  practitionerId: Uuid,
  slotStart: SlotStart,
  unitId: Uuid.optional(),
  notes: optText(500),
}).strict();

export const CancelBody = z.object({ reason: Reason }).strict();
export const RescheduleBody = z.object({
  slotStart: SlotStart,
  practitionerId: Uuid.optional(),
  reason: Reason,
}).strict();

export const APPOINTMENT_STATUSES = ['BOOKED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED'] as const;
export const AppointmentQuery = z.object({
  date: IsoDate.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  practitionerId: Uuid.optional(),
  branchId: Uuid.optional(),
  unitId: Uuid.optional(),
  patientId: Uuid.optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^\d{1,6}$/).optional(),
});
