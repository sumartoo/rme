import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, IsoDate, RequirePermission, Uuid, assertId, ctx, optText, problem } from '@clinicrme/shared';
import { Db, audit, idempotent, rows } from '@clinicrme/db';
import { ENCOUNTER_SELECT, type EncounterRow, encounterDto, getEncounter, notifyQueue, registerEncounter } from './encounter.repo';

const NOT_FOUND = ['ENC-404', 'Kunjungan tidak ditemukan'] as const;
const Eligibility = z.object({ coverageId: Uuid.nullable().optional(), eligibilityNote: optText(500) });
export const WalkInBody = Eligibility.extend({ patientId: Uuid, unitId: Uuid, practitionerId: Uuid }).strict();
export const CheckInBody = Eligibility.strict();
const ENCOUNTER_STATUSES = ['REGISTERED', 'ARRIVED', 'TRIAGED', 'IN_CONSULTATION', 'CONSULT_DONE', 'PHARMACY', 'BILLING', 'FINISHED', 'CANCELLED'] as const;
const BoardQuery = z.object({
  date: IsoDate.optional(),
  branchId: Uuid.optional(),
  unitId: Uuid.optional(),
  practitionerId: Uuid.optional(),
  patientId: Uuid.optional(),
  status: z.enum(ENCOUNTER_STATUSES).optional(),
  active: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().regex(/^\d{1,6}$/).optional(),
});
/** Status yang masih boleh dibatalkan di meja pendaftaran: rekam medis belum dimulai (Stage 9 menambah aturan RM disahkan). */
const CANCELLABLE = ['REGISTERED', 'ARRIVED', 'TRIAGED'];

/**
 * Kunjungan rawat jalan (SCH-FR-005, 006, 013): walk-in, check-in janji temu, papan status, batal. Setiap kunjungan
 * langsung mendapat nomor antrean poli. Idempotency-Key wajib untuk walk-in & check-in (klik ganda tidak membuat
 * kunjungan/antrean ganda).
 */
@Controller('api/v1')
export class EncountersController {
  constructor(private readonly db: Db) {}

  @RequirePermission('encounter.create') @BodySchema(WalkInBody) @Post('encounters/walk-in') @HttpCode(201)
  async walkIn(@Body() b: z.infer<typeof WalkInBody>, @Headers('idempotency-key') key: string | undefined) {
    return this.db.withTenantTx((tx) => idempotent(tx, 'encounter.walk_in', key, b, () => registerEncounter(tx, b)));
  }

  /**
   * SCH-FR-006: hanya janji temu hari ini (hari lokal cabang) berstatus terjadwal. OD-087: datang dalam toleransi
   * (bawaan 15 menit, pengaturan `lateToleranceMinutes`) → urutan antrean mengikuti jam slot; lewat toleransi →
   * di belakang seperti walk-in. Dokter & poli mengikuti janji temu.
   */
  @RequirePermission('encounter.create') @BodySchema(CheckInBody) @Post('appointments/:id/check-in') @HttpCode(200)
  async checkIn(@Param('id') id: string, @Body() b: z.infer<typeof CheckInBody>, @Headers('idempotency-key') key: string | undefined) {
    assertId(id, 'SCH-404-APPOINTMENT', 'Janji temu tidak ditemukan');
    return this.db.withTenantTx((tx) => idempotent(tx, 'appointment.check_in', key, { id, ...b }, async () => {
      const [a] = await rows<{ status: string; patient_id: string; practitioner_id: string; unit_id: string; slot_start: string;
                               is_today: boolean; late: boolean }>(tx, sql`
        select a.status, a.patient_id, a.practitioner_id, a.unit_id, a.slot_start,
               (a.slot_start at time zone b.timezone)::date = (now() at time zone b.timezone)::date as is_today,
               now() > a.slot_start + make_interval(mins => coalesce((t.settings->>'lateToleranceMinutes')::int, 15)) as late
          from appointment a join branch b on b.id = a.branch_id join tenant t on t.id = a.tenant_id
         where a.id = ${id} for update of a`);
      if (!a) throw problem(404, 'SCH-404-APPOINTMENT', 'Janji temu tidak ditemukan');
      if (a.status !== 'BOOKED') throw problem(409, 'SCH-409-STATUS', 'Hanya janji temu berstatus terjadwal yang dapat check-in');
      if (!a.is_today) throw problem(409, 'ENC-409-NOT-TODAY', 'Check-in hanya untuk janji temu hari ini');
      const slot = new Date(a.slot_start).toISOString();
      const e = await registerEncounter(tx, { ...b, patientId: a.patient_id, unitId: a.unit_id, practitionerId: a.practitioner_id,
        appointment: { id, sortKey: a.late ? new Date().toISOString() : slot, late: a.late } });
      await tx.execute(sql`update appointment set status = 'CHECKED_IN', updated_by = ${ctx().userId} where id = ${id}`);
      await audit(tx, 'APPOINTMENT_CHECKED_IN', 'appointment', id, a.patient_id, { encounterId: e.id, late: a.late, queue: e.queue?.displayCode });
      return e;
    }));
  }

  /** SCH-FR-013 papan kerja: bawaan hari ini (hari lokal cabang); dengan patientId → riwayat kunjungan pasien. */
  @RequirePermission('encounter.read') @Get('encounters')
  async board(@Query() q: Record<string, string | undefined>) {
    const P = BoardQuery.safeParse(q);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const f = P.data;
    const offset = Number(f.cursor ?? 0);
    const allDates = !!f.patientId && !f.date;
    const r = await this.db.withTenantTx((tx) => rows<EncounterRow>(tx, sql`${ENCOUNTER_SELECT}
      where (${allDates}::boolean or (e.arrived_at at time zone b.timezone)::date
                                     = coalesce(${f.date ?? null}::date, (now() at time zone b.timezone)::date))
        and (${f.branchId ?? null}::uuid is null or e.branch_id = ${f.branchId ?? null}::uuid)
        and (${f.unitId ?? null}::uuid is null or e.unit_id = ${f.unitId ?? null}::uuid)
        and (${f.practitionerId ?? null}::uuid is null or e.practitioner_id = ${f.practitionerId ?? null}::uuid)
        and (${f.patientId ?? null}::uuid is null or e.patient_id = ${f.patientId ?? null}::uuid)
        and (${f.status ?? null}::text is null or e.status = ${f.status ?? null})
        and (${f.active !== 'true'}::boolean or e.status not in ('FINISHED', 'CANCELLED'))
      order by ${allDates ? sql`e.arrived_at desc` : sql`q.sort_key nulls last, e.arrived_at`}, e.id
      limit ${f.limit + 1} offset ${offset}`));
    return { data: r.slice(0, f.limit).map(encounterDto),
      page: { hasMore: r.length > f.limit, nextCursor: r.length > f.limit ? String(offset + f.limit) : null } };
  }

  @RequirePermission('encounter.read') @Get('encounters/:id')
  async get(@Param('id') id: string) {
    assertId(id, ...NOT_FOUND);
    return this.db.withTenantTx((tx) => getEncounter(tx, id));
  }

  /** Batal wajib alasan; tiket antrean ikut batal, janji temu terkait ditandai batal. Kunjungan tidak dihapus. */
  @RequirePermission('encounter.cancel') @BodySchema(z.object({ reason: z.string().trim().min(3).max(500) }).strict())
  @Post('encounters/:id/cancel') @HttpCode(200)
  async cancel(@Param('id') id: string, @Body() b: { reason: string }) {
    assertId(id, ...NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const [e] = await rows<{ status: string; patient_id: string; appointment_id: string | null; branch_id: string }>(tx, sql`
        select status, patient_id, appointment_id, branch_id from encounter where id = ${id} for update`);
      if (!e) throw problem(404, ...NOT_FOUND);
      if (!CANCELLABLE.includes(e.status)) throw problem(409, 'ENC-409-STATUS', 'Kunjungan yang sudah dilayani tidak dapat dibatalkan di pendaftaran');
      await tx.execute(sql`update encounter set status = 'CANCELLED', cancel_reason = ${b.reason}, cancelled_at = now(),
                             updated_by = ${ctx().userId} where id = ${id}`);
      await tx.execute(sql`update queue_ticket set status = 'CANCELLED', updated_by = ${ctx().userId}
                            where encounter_id = ${id} and status <> 'SERVED'`);
      if (e.appointment_id) {
        await tx.execute(sql`update appointment set status = 'CANCELLED', status_reason = ${`Kunjungan dibatalkan: ${b.reason}`},
                               updated_by = ${ctx().userId} where id = ${e.appointment_id}`);
      }
      await audit(tx, 'ENCOUNTER_CANCELLED', 'encounter', id, e.patient_id, { reason: b.reason });
      await notifyQueue(tx, e.branch_id);
      return getEncounter(tx, id);
    });
  }
}
