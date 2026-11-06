import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, IsoDate, NoBody, RequirePermission, Uuid, assertId, ctx, problem } from '@clinicrme/shared';
import { Db, type Tx, audit, rows } from '@clinicrme/db';
import { notifyQueue } from './encounter.repo';

interface TicketRow {
  id: string; display_code: string; queue_number: number; status: string; called_at: string | null; call_count: number; skipped_at: string | null;
  sort_key: string; queue_date: string; branch_id: string; unit_id: string; unit_name: string; practitioner_id: string | null;
  practitioner_name: string | null; encounter_id: string; encounter_no: string; encounter_status: string; arrival_type: string; arrived_late: boolean;
  patient_id: string; mrn: string; full_name: string; version: number;
}
const TICKET_SELECT = sql`
  select q.id, q.display_code, q.queue_number, q.status, q.called_at, q.call_count, q.skipped_at, q.sort_key,
         to_char(q.queue_date, 'YYYY-MM-DD') as queue_date, q.branch_id, q.unit_id, u.name as unit_name, q.practitioner_id,
         pr.full_name as practitioner_name, q.encounter_id, e.encounter_no, e.status as encounter_status, e.arrival_type, e.arrived_late,
         e.patient_id, p.mrn, p.full_name, q.version
    from queue_ticket q
    join encounter e on e.id = q.encounter_id
    join patient p on p.id = e.patient_id
    join service_unit u on u.id = q.unit_id
    left join practitioner pr on pr.id = q.practitioner_id`;
const ticketDto = (r: TicketRow) => ({
  id: r.id, displayCode: r.display_code, queueNumber: r.queue_number, status: r.status, calledAt: r.called_at, callCount: r.call_count,
  skippedAt: r.skipped_at, queueDate: r.queue_date, unitId: r.unit_id, unitName: r.unit_name, practitionerId: r.practitioner_id,
  practitionerName: r.practitioner_name, encounterId: r.encounter_id, encounterNo: r.encounter_no, encounterStatus: r.encounter_status,
  arrivalType: r.arrival_type, arrivedLate: r.arrived_late,
  patient: { id: r.patient_id, mrn: r.mrn, fullName: r.full_name }, version: r.version,
});
/** Urutan tampilan petugas: sedang dipanggil, menunggu (urutan layanan), dilewati, selesai/batal. */
const ORDER = sql`case q.status when 'CALLED' then 0 when 'WAITING' then 1 when 'SKIPPED' then 2 else 3 end,
                  case when q.status = 'CALLED' then q.called_at end desc nulls last, q.sort_key, q.queue_number`;

/**
 * Antrean poli (SCH-FR-008): daftar per poli per hari, panggil berikutnya, panggil / panggil ulang, lewati. Perubahan
 * memberi sinyal pg_notify untuk layar TV (batch 4). Pemanggilan teraudit (siapa memanggil pasien siapa, kapan).
 */
@Controller('api/v1/queue')
export class QueueController {
  constructor(private readonly db: Db) {}

  @RequirePermission('queue.call') @Get()
  async list(@Query() q: Record<string, string | undefined>) {
    const P = z.object({ unitId: Uuid, date: IsoDate.optional(), practitionerId: Uuid.optional() }).safeParse(q);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid (unitId wajib)');
    const { unitId, date, practitionerId } = P.data;
    const r = await this.db.withTenantTx((tx) => rows<TicketRow>(tx, sql`${TICKET_SELECT} join branch b on b.id = q.branch_id
      where q.unit_id = ${unitId} and q.queue_date = coalesce(${date ?? null}::date, (now() at time zone b.timezone)::date)
        and (${practitionerId ?? null}::uuid is null or q.practitioner_id = ${practitionerId ?? null}::uuid)
      order by ${ORDER}`));
    return r.map(ticketDto);
  }

  /** Ambil antrean menunggu teratas (urutan layanan); dua petugas menekan bersamaan → tiket berbeda (SKIP LOCKED). */
  @RequirePermission('queue.call') @BodySchema(z.object({ unitId: Uuid, practitionerId: Uuid.optional() }).strict())
  @Post('call-next') @HttpCode(200)
  async callNext(@Body() b: { unitId: string; practitionerId?: string }) {
    return this.db.withTenantTx(async (tx) => {
      const [t] = await rows<{ id: string }>(tx, sql`
        select q.id from queue_ticket q join branch br on br.id = q.branch_id
         where q.unit_id = ${b.unitId} and q.status = 'WAITING' and q.queue_date = (now() at time zone br.timezone)::date
           and (${b.practitionerId ?? null}::uuid is null or q.practitioner_id = ${b.practitionerId ?? null}::uuid)
         order by q.sort_key, q.queue_number limit 1 for update of q skip locked`);
      if (!t) throw problem(409, 'QUE-409-EMPTY', 'Tidak ada antrean menunggu');
      return this.call(tx, t.id);
    });
  }

  @RequirePermission('queue.call') @NoBody() @Post(':id/call') @HttpCode(200)
  async callOne(@Param('id') id: string) {
    assertId(id, 'QUE-404', 'Tiket antrean tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      await this.lock(tx, id, ['WAITING', 'CALLED', 'SKIPPED'], 'Tiket ini tidak dapat dipanggil');
      return this.call(tx, id);
    });
  }

  @RequirePermission('queue.call') @NoBody() @Post(':id/skip') @HttpCode(200)
  async skip(@Param('id') id: string) {
    assertId(id, 'QUE-404', 'Tiket antrean tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      const t = await this.lock(tx, id, ['WAITING', 'CALLED'], 'Hanya antrean menunggu atau dipanggil yang dapat dilewati');
      await tx.execute(sql`update queue_ticket set status = 'SKIPPED', skipped_at = now(), updated_by = ${ctx().userId} where id = ${id}`);
      await audit(tx, 'QUEUE_SKIPPED', 'queue_ticket', id, t.patient_id, { displayCode: t.display_code });
      await notifyQueue(tx, t.branch_id);
      return this.get(tx, id);
    });
  }

  private async lock(tx: Tx, id: string, allowed: string[], msg: string) {
    const [t] = await rows<{ status: string; patient_id: string; display_code: string; branch_id: string; encounter_status: string }>(tx, sql`
      select q.status, e.patient_id, q.display_code, q.branch_id, e.status as encounter_status
        from queue_ticket q join encounter e on e.id = q.encounter_id where q.id = ${id} for update of q`);
    if (!t) throw problem(404, 'QUE-404', 'Tiket antrean tidak ditemukan');
    if (!allowed.includes(t.status) || t.encounter_status === 'CANCELLED') throw problem(409, 'QUE-409-STATUS', msg);
    return t;
  }

  private async call(tx: Tx, id: string) {
    const [t] = await rows<{ patient_id: string; display_code: string; branch_id: string; call_count: number }>(tx, sql`
      update queue_ticket q set status = 'CALLED', called_at = now(), call_count = call_count + 1, called_by = ${ctx().userId},
             updated_by = ${ctx().userId}
        from encounter e where q.id = ${id} and e.id = q.encounter_id
      returning e.patient_id, q.display_code, q.branch_id, q.call_count`);
    await audit(tx, 'QUEUE_CALLED', 'queue_ticket', id, t.patient_id, { displayCode: t.display_code, callCount: t.call_count });
    await notifyQueue(tx, t.branch_id);
    return this.get(tx, id);
  }

  private async get(tx: Tx, id: string) {
    const [r] = await rows<TicketRow>(tx, sql`${TICKET_SELECT} where q.id = ${id}`);
    return ticketDto(r);
  }
}
