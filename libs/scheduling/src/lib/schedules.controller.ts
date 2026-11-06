import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import {
  BodySchema, NoBody, RequirePermission, assertId, assertVersion, ctx, ifMatchVersion, merge, pgError, problem, problemWith,
} from '@clinicrme/shared';
import { Db, type Tx, audit, auditChange, rows } from '@clinicrme/db';
import { ExceptionCreate, ScheduleCreate, ScheduleUpdate, SlotQuery, minutesOf, scheduleShapeErrors } from './scheduling.schemas';
import { APPOINTMENT_SELECT, type AppointmentRow, appointmentDto } from './appointment.repo';

const NOT_FOUND = ['SCH-404', 'Jadwal tidak ditemukan'] as const;

interface ScheduleRow {
  id: string; practitioner_id: string; practitioner_name: string; branch_id: string; branch_name: string; timezone: string;
  unit_id: string; unit_name: string; day_of_week: number; start_time: string; end_time: string; slot_minutes: number; quota: number;
  valid_from: string; valid_to: string | null; is_active: boolean; version: number;
}
const SCHEDULE_SELECT = sql`
  select s.id, s.practitioner_id, p.full_name as practitioner_name, s.branch_id, b.name as branch_name, b.timezone,
         s.unit_id, u.name as unit_name, s.day_of_week, to_char(s.start_time, 'HH24:MI') as start_time,
         to_char(s.end_time, 'HH24:MI') as end_time, s.slot_minutes, s.quota, to_char(s.valid_from, 'YYYY-MM-DD') as valid_from,
         to_char(s.valid_to, 'YYYY-MM-DD') as valid_to, s.is_active, s.version
    from practitioner_schedule s
    join practitioner p on p.id = s.practitioner_id
    join branch b on b.id = s.branch_id
    join service_unit u on u.id = s.unit_id`;
const scheduleDto = (r: ScheduleRow) => ({
  id: r.id, practitionerId: r.practitioner_id, practitionerName: r.practitioner_name, branchId: r.branch_id, branchName: r.branch_name,
  timezone: r.timezone, unitId: r.unit_id, unitName: r.unit_name, dayOfWeek: r.day_of_week, startTime: r.start_time, endTime: r.end_time,
  slotMinutes: r.slot_minutes, quota: r.quota, slotCount: Math.floor((minutesOf(r.end_time) - minutesOf(r.start_time)) / r.slot_minutes),
  validFrom: r.valid_from, validTo: r.valid_to, isActive: r.is_active, version: r.version,
});
/** Nilai yang dibandingkan untuk audit perubahan (tanpa nama tampilan). */
const auditView = (d: ReturnType<typeof scheduleDto>) => ({
  dayOfWeek: d.dayOfWeek, startTime: d.startTime, endTime: d.endTime, slotMinutes: d.slotMinutes, quota: d.quota,
  validFrom: d.validFrom, validTo: d.validTo, isActive: d.isActive,
});

interface ExceptionRow { id: string; practitioner_id: string | null; practitioner_name: string | null; branch_id: string | null;
  branch_name: string | null; exception_date: string; reason: string; created_at: string }
const exceptionDto = (r: ExceptionRow) => ({
  id: r.id, practitionerId: r.practitioner_id, practitionerName: r.practitioner_name, branchId: r.branch_id, branchName: r.branch_name,
  exceptionDate: r.exception_date, reason: r.reason, createdAt: r.created_at,
});

/** Hari ini menurut WIB — batas bawah tanggal pengecualian (cabang WITA/WIT sudah lebih dulu berganti hari). */
const todayWib = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

/**
 * Jadwal praktik dokter (SCH-FR-001), cuti/libur (SCH-FR-002), dan slot tersedia (SCH-FR-003). Jam jadwal adalah jam
 * lokal cabang (zona waktu cabang, Stage 7); slot dikembalikan sebagai waktu ber-zona. Satu dokter tidak dapat punya
 * dua sesi yang tumpang tindih (exclusion constraint database), dan perubahan jadwal ditolak bila membuat janji temu
 * yang sudah ada tidak lagi masuk jadwal.
 */
@Controller('api/v1')
export class SchedulesController {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- jadwal
  @RequirePermission('schedule.read') @Get('schedules')
  async list(@Query() q: Record<string, string | undefined>) {
    const P = z.object({ practitionerId: z.uuid().optional(), branchId: z.uuid().optional(), includeInactive: z.enum(['true', 'false']).optional() }).safeParse(q);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const { practitionerId, branchId, includeInactive } = P.data;
    const r = await this.db.withTenantTx((tx) => rows<ScheduleRow>(tx, sql`${SCHEDULE_SELECT}
      where (${practitionerId ?? null}::uuid is null or s.practitioner_id = ${practitionerId ?? null}::uuid)
        and (${branchId ?? null}::uuid is null or s.branch_id = ${branchId ?? null}::uuid)
        and (${includeInactive === 'true'}::boolean or (s.is_active and (s.valid_to is null or s.valid_to >= current_date)))
      order by p.full_name, s.day_of_week, s.start_time`));
    return r.map(scheduleDto);
  }

  @RequirePermission('schedule.manage') @BodySchema(ScheduleCreate) @Post('schedules') @HttpCode(201)
  async create(@Body() b: z.infer<typeof ScheduleCreate>) {
    return this.mapErrors(() => this.db.withTenantTx(async (tx) => {
      await this.assertRefs(tx, b.practitionerId, b.branchId, b.unitId);
      const quota = b.quota ?? Math.floor((minutesOf(b.endTime) - minutesOf(b.startTime)) / b.slotMinutes);
      const [{ id }] = await rows<{ id: string }>(tx, sql`
        insert into practitioner_schedule(tenant_id, practitioner_id, branch_id, unit_id, day_of_week, start_time, end_time,
                                          slot_minutes, quota, valid_from, valid_to, created_by, updated_by)
        values (app.current_tenant_id(), ${b.practitionerId}, ${b.branchId}, ${b.unitId}, ${b.dayOfWeek}, ${b.startTime}::time,
                ${b.endTime}::time, ${b.slotMinutes}, ${quota}, coalesce(${b.validFrom ?? null}::date, current_date),
                ${b.validTo ?? null}::date, ${ctx().userId}, ${ctx().userId})
        returning id`);
      const d = await this.get(tx, id);
      await audit(tx, 'SCHEDULE_CREATED', 'practitioner_schedule', id, null, { after: { practitionerId: d.practitionerId, unitId: d.unitId, ...auditView(d) } });
      return d;
    }));
  }

  @RequirePermission('schedule.manage') @BodySchema(ScheduleUpdate) @Put('schedules/:id')
  async update(@Param('id') id: string, @Body() b: z.infer<typeof ScheduleUpdate>,
               @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    assertId(id, ...NOT_FOUND);
    const v = ifMatchVersion(ifMatch, 'jadwal');
    const out = await this.mapErrors(() => this.db.withTenantTx(async (tx) => {
      await tx.execute(sql`select 1 from practitioner_schedule where id = ${id} for update`);
      const before = await this.get(tx, id);
      assertVersion(before.version, v, 'Jadwal');
      const n = merge(auditView(before), b);
      const errors = scheduleShapeErrors({ ...n, quota: b.quota });
      if (errors.length) throw problemWith(400, 'GEN-400-VALIDATION', 'Input tidak valid', { errors });
      // Bentuk sesi berubah tanpa kuota baru → kuota disesuaikan ke jumlah slot bila melebihi
      const slots = Math.floor((minutesOf(n.endTime) - minutesOf(n.startTime)) / n.slotMinutes);
      const quota = b.quota ?? Math.min(n.quota, slots);
      await tx.execute(sql`
        update practitioner_schedule set day_of_week = ${n.dayOfWeek}, start_time = ${n.startTime}::time, end_time = ${n.endTime}::time,
               slot_minutes = ${n.slotMinutes}, quota = ${quota}, valid_from = ${n.validFrom}::date, valid_to = ${n.validTo}::date,
               is_active = ${n.isActive}, updated_by = ${ctx().userId}
         where id = ${id}`);
      await this.assertBookingsStillFit(tx, id);
      const after = await this.get(tx, id);
      await auditChange(tx, 'SCHEDULE_UPDATED', 'practitioner_schedule', id, auditView(before), auditView(after));
      return after;
    }));
    res.setHeader('ETag', `"${out.version}"`);
    return out;
  }

  /**
   * Janji temu BOOKED mendatang pada jadwal ini harus tetap valid setelah perubahan: jadwal aktif, tanggal dalam masa
   * berlaku, hari & jam masuk sesi dan selaras slot, serta jumlah per hari tidak melebihi kuota. Bila tidak → 409.
   */
  private async assertBookingsStillFit(tx: Tx, id: string) {
    const [r] = await rows<{ misfit: number; over_quota: number }>(tx, sql`
      with s as (select s.*, b.timezone from practitioner_schedule s join branch b on b.id = s.branch_id where s.id = ${id}),
      a as (
        select a.id, (a.slot_start at time zone s.timezone) as local_ts, s.*
          from appointment a cross join s
         where a.schedule_id = ${id} and a.status = 'BOOKED' and a.slot_start > now())
      select count(*) filter (where not (
               is_active and local_ts::date >= valid_from and (valid_to is null or local_ts::date <= valid_to)
               and extract(isodow from local_ts) = day_of_week
               and local_ts::time >= start_time and local_ts::time < end_time
               and (extract(epoch from (local_ts::time - start_time)) / 60)::int % slot_minutes = 0))::int as misfit,
             (select count(*)::int from (select local_ts::date, count(*) as n, max(quota) as q from a group by 1) d where n > q) as over_quota
        from a`);
    if (r && (r.misfit > 0 || r.over_quota > 0)) {
      throw problem(409, 'SCH-409-HAS-APPOINTMENTS', `Perubahan ini membuat ${r.misfit || 'sebagian'} janji temu mendatang tidak lagi masuk jadwal/kuota. `
        + 'Batalkan atau jadwalkan ulang janji temu tersebut lebih dulu.');
    }
  }

  private async get(tx: Tx, id: string) {
    const [r] = await rows<ScheduleRow>(tx, sql`${SCHEDULE_SELECT} where s.id = ${id}`);
    if (!r) throw problem(404, ...NOT_FOUND);
    return scheduleDto(r);
  }

  private async assertRefs(tx: Tx, practitionerId: string, branchId: string, unitId: string) {
    const [p] = await rows<{ is_active: boolean }>(tx, sql`select is_active from practitioner where id = ${practitionerId}`);
    if (!p?.is_active) throw problem(400, 'SCH-400-PRACTITIONER', 'Tenaga kesehatan tidak ditemukan atau tidak aktif');
    const [b] = await rows<{ is_active: boolean }>(tx, sql`select is_active from branch where id = ${branchId}`);
    if (!b?.is_active) throw problem(400, 'SCH-400-BRANCH', 'Cabang tidak ditemukan atau tidak aktif');
    const [u] = await rows<{ is_active: boolean; branch_id: string; unit_type: string }>(tx, sql`
      select is_active, branch_id, unit_type from service_unit where id = ${unitId}`);
    if (!u?.is_active || u.branch_id !== branchId) throw problem(400, 'SCH-400-UNIT', 'Poli/unit tidak ditemukan, tidak aktif, atau bukan milik cabang ini');
    if (u.unit_type === 'FARMASI' || u.unit_type === 'KASIR') throw problem(400, 'SCH-400-UNIT', 'Jadwal praktik hanya untuk poli/ruang pelayanan');
  }

  /** Bentrok jadwal (exclusion constraint) → 409; kuota > jumlah slot (check constraint) → 400. */
  private async mapErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const pg = pgError(e);
      if (pg?.code === '23P01') throw problem(409, 'SCH-409-OVERLAP', 'Jadwal bentrok dengan sesi lain dokter ini pada hari & jam yang sama (cabang mana pun)');
      if (pg?.code === '23514' && pg.constraint === 'schedule_quota_fits') throw problem(400, 'SCH-400-QUOTA', 'Kuota melebihi jumlah slot sesi');
      throw e;
    }
  }

  // ---------------------------------------------------------------- cuti / libur
  @RequirePermission('schedule.read') @Get('schedule-exceptions')
  async listExceptions(@Query() q: Record<string, string | undefined>) {
    const P = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional(), practitionerId: z.uuid().optional(), branchId: z.uuid().optional() }).safeParse(q);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const from = P.data.from ?? todayWib();
    const r = await this.db.withTenantTx((tx) => rows<ExceptionRow>(tx, sql`
      select e.id, e.practitioner_id, p.full_name as practitioner_name, e.branch_id, b.name as branch_name,
             to_char(e.exception_date, 'YYYY-MM-DD') as exception_date, e.reason, e.created_at
        from schedule_exception e left join practitioner p on p.id = e.practitioner_id left join branch b on b.id = e.branch_id
       where e.exception_date >= ${from}::date and (${P.data.to ?? null}::date is null or e.exception_date <= ${P.data.to ?? null}::date)
         and (${P.data.practitionerId ?? null}::uuid is null or e.practitioner_id = ${P.data.practitionerId ?? null}::uuid)
         and (${P.data.branchId ?? null}::uuid is null or e.branch_id = ${P.data.branchId ?? null}::uuid)
       order by e.exception_date, coalesce(p.full_name, b.name) limit 500`));
    return r.map(exceptionDto);
  }

  /** Mengembalikan janji temu yang terdampak (status tetap BOOKED) agar petugas menghubungi & menjadwalkan ulang pasien. */
  @RequirePermission('schedule.manage') @BodySchema(ExceptionCreate) @Post('schedule-exceptions') @HttpCode(201)
  async createException(@Body() b: z.infer<typeof ExceptionCreate>) {
    if (b.exceptionDate < todayWib()) throw problem(400, 'SCH-400-PAST', 'Tanggal cuti/libur tidak boleh di masa lalu');
    try {
      return await this.db.withTenantTx(async (tx) => {
        if (b.practitionerId) {
          const [p] = await rows(tx, sql`select 1 from practitioner where id = ${b.practitionerId}`);
          if (!p) throw problem(400, 'SCH-400-PRACTITIONER', 'Tenaga kesehatan tidak ditemukan');
        } else {
          const [br] = await rows(tx, sql`select 1 from branch where id = ${b.branchId}`);
          if (!br) throw problem(400, 'SCH-400-BRANCH', 'Cabang tidak ditemukan');
        }
        const [r] = await rows<ExceptionRow>(tx, sql`
          with ins as (
            insert into schedule_exception(tenant_id, practitioner_id, branch_id, exception_date, reason, created_by)
            values (app.current_tenant_id(), ${b.practitionerId ?? null}::uuid, ${b.branchId ?? null}::uuid, ${b.exceptionDate}::date,
                    ${b.reason}, ${ctx().userId})
            returning *)
          select ins.id, ins.practitioner_id, p.full_name as practitioner_name, ins.branch_id, br.name as branch_name,
                 to_char(ins.exception_date, 'YYYY-MM-DD') as exception_date, ins.reason, ins.created_at
            from ins left join practitioner p on p.id = ins.practitioner_id left join branch br on br.id = ins.branch_id`);
        const affected = await rows<AppointmentRow>(tx, sql`${APPOINTMENT_SELECT}
          where a.status = 'BOOKED' and (a.slot_start at time zone b.timezone)::date = ${b.exceptionDate}::date
            and (${b.practitionerId ?? null}::uuid is null or a.practitioner_id = ${b.practitionerId ?? null}::uuid)
            and (${b.branchId ?? null}::uuid is null or a.branch_id = ${b.branchId ?? null}::uuid)
          order by a.slot_start`);
        await audit(tx, 'SCHEDULE_EXCEPTION_CREATED', 'schedule_exception', r.id, null,
          { practitionerId: b.practitionerId ?? null, branchId: b.branchId ?? null, exceptionDate: b.exceptionDate, reason: b.reason, affected: affected.length });
        return { ...exceptionDto(r), affectedAppointments: affected.map(appointmentDto) };
      });
    } catch (e) {
      if (pgError(e)?.code === '23505') throw problem(409, 'SCH-409-EXCEPTION-EXISTS', 'Sudah ada cuti/libur pada tanggal tersebut');
      throw e;
    }
  }

  @RequirePermission('schedule.manage') @NoBody() @Delete('schedule-exceptions/:id') @HttpCode(204)
  async deleteException(@Param('id') id: string) {
    assertId(id, 'SCH-404-EXCEPTION', 'Cuti/libur tidak ditemukan');
    await this.db.withTenantTx(async (tx) => {
      const [r] = await rows<{ practitioner_id: string | null; branch_id: string | null; exception_date: string; reason: string }>(tx, sql`
        delete from schedule_exception where id = ${id}
        returning practitioner_id, branch_id, to_char(exception_date, 'YYYY-MM-DD') as exception_date, reason`);
      if (!r) throw problem(404, 'SCH-404-EXCEPTION', 'Cuti/libur tidak ditemukan');
      await audit(tx, 'SCHEDULE_EXCEPTION_DELETED', 'schedule_exception', id, null,
        { practitionerId: r.practitioner_id, branchId: r.branch_id, exceptionDate: r.exception_date, reason: r.reason });
    });
  }

  // ---------------------------------------------------------------- slot
  /**
   * SCH-FR-003: slot per sesi praktik pada satu tanggal (hari lokal cabang). Slot tersedia bila belum terisi, kuota sesi
   * belum penuh, waktunya belum lewat, dan tidak ada cuti dokter / libur cabang.
   */
  @RequirePermission('appointment.read') @Get('slots')
  async slots(@Query() q: Record<string, string | undefined>) {
    const P = SlotQuery.safeParse(q);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid (date wajib, format YYYY-MM-DD)');
    const { date, practitionerId, branchId, unitId } = P.data;
    return this.db.withTenantTx(async (tx) => {
      const sessions = await rows<ScheduleRow>(tx, sql`${SCHEDULE_SELECT}
        where s.is_active and p.is_active and s.day_of_week = extract(isodow from ${date}::date)
          and s.valid_from <= ${date}::date and (s.valid_to is null or s.valid_to >= ${date}::date)
          and (${practitionerId ?? null}::uuid is null or s.practitioner_id = ${practitionerId ?? null}::uuid)
          and (${branchId ?? null}::uuid is null or s.branch_id = ${branchId ?? null}::uuid)
          and (${unitId ?? null}::uuid is null or s.unit_id = ${unitId ?? null}::uuid)
        order by s.start_time, p.full_name`);
      if (sessions.length === 0) return { date, sessions: [] };
      const ids = `{${sessions.map((s) => s.id).join(',')}}`;   // literal array PostgreSQL (drizzle memecah array JS jadi daftar)
      const exceptions = await rows<{ practitioner_id: string | null; branch_id: string | null; reason: string }>(tx, sql`
        select practitioner_id, branch_id, reason from schedule_exception where exception_date = ${date}::date`);
      const slots = await rows<{ schedule_id: string; slot_start: string; slot_end: string; past: boolean; appointment_id: string | null }>(tx, sql`
        select s.id as schedule_id, to_char(gs.ts at time zone b.timezone, 'YYYY-MM-DD"T"HH24:MI:SS') || tzo.o as slot_start,
               to_char((gs.ts + make_interval(mins => s.slot_minutes)) at time zone b.timezone, 'YYYY-MM-DD"T"HH24:MI:SS') || tzo.o as slot_end,
               gs.ts <= now() as past, a.id as appointment_id
          from practitioner_schedule s
          join branch b on b.id = s.branch_id
          cross join lateral (select case b.timezone when 'Asia/Jakarta' then '+07:00' when 'Asia/Makassar' then '+08:00' else '+09:00' end as o) tzo
          cross join lateral (
            select ((${date}::date + s.start_time) at time zone b.timezone) + make_interval(mins => i * s.slot_minutes) as ts
              from generate_series(0, floor(extract(epoch from (s.end_time - s.start_time)) / 60 / s.slot_minutes)::int - 1) i) gs
          left join appointment a on a.practitioner_id = s.practitioner_id and a.slot_start = gs.ts and a.status in ('BOOKED', 'CHECKED_IN')
         where s.id = any(${ids}::uuid[])
         order by gs.ts`);
      const booked = await rows<{ schedule_id: string; n: number }>(tx, sql`
        select a.schedule_id, count(*)::int as n from appointment a join branch b on b.id = a.branch_id
         where a.schedule_id = any(${ids}::uuid[]) and a.status in ('BOOKED', 'CHECKED_IN')
           and (a.slot_start at time zone b.timezone)::date = ${date}::date
         group by a.schedule_id`);
      return {
        date,
        sessions: sessions.map((s) => {
          const ex = exceptions.find((e) => e.practitioner_id === s.practitioner_id || e.branch_id === s.branch_id);
          const n = booked.find((x) => x.schedule_id === s.id)?.n ?? 0;
          const full = n >= s.quota;
          return {
            ...scheduleDto(s), booked: n, closed: ex ? { reason: ex.reason, type: ex.practitioner_id ? 'CUTI_DOKTER' : 'LIBUR_CABANG' } : null,
            slots: slots.filter((x) => x.schedule_id === s.id).map((x) => ({
              start: x.slot_start, end: x.slot_end, taken: !!x.appointment_id,
              available: !ex && !full && !x.past && !x.appointment_id,
            })),
          };
        }),
      };
    });
  }
}
