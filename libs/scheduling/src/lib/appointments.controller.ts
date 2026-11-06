import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, RequirePermission, assertId, ctx, problem } from '@clinicrme/shared';
import { Db, audit, idempotent, rows } from '@clinicrme/db';
import { AppointmentCreate, AppointmentQuery, CancelBody, RescheduleBody } from './scheduling.schemas';
import { APPOINTMENT_SELECT, type AppointmentRow, appointmentDto, book, getAppointment } from './appointment.repo';

const NOT_FOUND = ['SCH-404-APPOINTMENT', 'Janji temu tidak ditemukan'] as const;

/**
 * Janji temu (SCH-FR-003, 010, 011). Pembatalan & jadwal ulang wajib alasan; riwayat tidak dihapus (DELETE dicabut di
 * database). Jadwal ulang = janji lama berstatus RESCHEDULED yang menunjuk janji baru. Check-in ada di batch 3.
 */
@Controller('api/v1/appointments')
export class AppointmentsController {
  constructor(private readonly db: Db) {}

  @RequirePermission('appointment.read') @Get()
  async list(@Query() q: Record<string, string | undefined>) {
    const P = AppointmentQuery.safeParse(q);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const f = P.data;
    const from = f.date ?? f.from ?? null, to = f.date ?? f.to ?? null;
    const offset = Number(f.cursor ?? 0);
    const r = await this.db.withTenantTx((tx) => rows<AppointmentRow>(tx, sql`${APPOINTMENT_SELECT}
      where (${from}::date is null or (a.slot_start at time zone b.timezone)::date >= ${from}::date)
        and (${to}::date is null or (a.slot_start at time zone b.timezone)::date <= ${to}::date)
        and (${f.practitionerId ?? null}::uuid is null or a.practitioner_id = ${f.practitionerId ?? null}::uuid)
        and (${f.branchId ?? null}::uuid is null or a.branch_id = ${f.branchId ?? null}::uuid)
        and (${f.unitId ?? null}::uuid is null or a.unit_id = ${f.unitId ?? null}::uuid)
        and (${f.patientId ?? null}::uuid is null or a.patient_id = ${f.patientId ?? null}::uuid)
        and (${f.status ?? null}::text is null or a.status = ${f.status ?? null})
      order by a.slot_start ${f.patientId ? sql`desc` : sql`asc`}, pr.full_name, a.id
      limit ${f.limit + 1} offset ${offset}`));
    return { data: r.slice(0, f.limit).map(appointmentDto),
      page: { hasMore: r.length > f.limit, nextCursor: r.length > f.limit ? String(offset + f.limit) : null } };
  }

  @RequirePermission('appointment.read') @Get(':id')
  async get(@Param('id') id: string) {
    assertId(id, ...NOT_FOUND);
    return this.db.withTenantTx((tx) => getAppointment(tx, id));
  }

  /** Idempotency-Key wajib: klik ganda tidak membuat dua janji temu. */
  @RequirePermission('appointment.manage') @BodySchema(AppointmentCreate) @Post() @HttpCode(201)
  async create(@Body() b: z.infer<typeof AppointmentCreate>, @Headers('idempotency-key') key: string | undefined) {
    return this.db.withTenantTx((tx) => idempotent(tx, 'appointment.create', key, b, () => book(tx, b)));
  }

  @RequirePermission('appointment.manage') @BodySchema(CancelBody) @Post(':id/cancel') @HttpCode(200)
  async cancel(@Param('id') id: string, @Body() b: z.infer<typeof CancelBody>) {
    assertId(id, ...NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const [a] = await rows<{ status: string; patient_id: string }>(tx, sql`select status, patient_id from appointment where id = ${id} for update`);
      if (!a) throw problem(404, ...NOT_FOUND);
      if (a.status !== 'BOOKED') throw problem(409, 'SCH-409-STATUS', 'Hanya janji temu berstatus terjadwal yang dapat dibatalkan');
      await tx.execute(sql`update appointment set status = 'CANCELLED', status_reason = ${b.reason}, updated_by = ${ctx().userId} where id = ${id}`);
      await audit(tx, 'APPOINTMENT_CANCELLED', 'appointment', id, a.patient_id, { reason: b.reason });
      return getAppointment(tx, id);
    });
  }

  /** Janji baru dibuat dengan aturan yang sama seperti pemesanan; bila gagal, janji lama tidak berubah. */
  @RequirePermission('appointment.manage') @BodySchema(RescheduleBody) @Post(':id/reschedule') @HttpCode(200)
  async reschedule(@Param('id') id: string, @Body() b: z.infer<typeof RescheduleBody>) {
    assertId(id, ...NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const [a] = await rows<{ status: string; patient_id: string; practitioner_id: string; unit_id: string; notes: string | null; channel: string }>(tx, sql`
        select status, patient_id, practitioner_id, unit_id, notes, channel from appointment where id = ${id} for update`);
      if (!a) throw problem(404, ...NOT_FOUND);
      if (a.status !== 'BOOKED') throw problem(409, 'SCH-409-STATUS', 'Hanya janji temu berstatus terjadwal yang dapat dijadwalkan ulang');
      const newId = randomUUID();
      // Janji lama dilepas lebih dulu agar slot/hari yang sama dengan dokter lain tidak dianggap bentrok dengan dirinya sendiri
      await tx.execute(sql`update appointment set status = 'RESCHEDULED', status_reason = ${b.reason}, rescheduled_to_id = ${newId},
                             updated_by = ${ctx().userId} where id = ${id}`);
      const practitionerId = b.practitionerId ?? a.practitioner_id;
      const next = await book(tx, { id: newId, patientId: a.patient_id, practitionerId, slotStart: b.slotStart,
        unitId: practitionerId === a.practitioner_id ? a.unit_id : undefined, notes: a.notes, channel: a.channel as 'STAFF' });
      await audit(tx, 'APPOINTMENT_RESCHEDULED', 'appointment', id, a.patient_id, { reason: b.reason, newAppointmentId: newId, slotStart: next.slotStart });
      return next;
    });
  }
}
