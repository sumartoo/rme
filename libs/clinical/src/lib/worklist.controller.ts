import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { NoBody, RequirePermission, Uuid, assertId, ctx, problem } from '@clinicrme/shared';
import { Db, audit, rows } from '@clinicrme/db';
import { ENC_NOT_FOUND, ageText } from './chart.repo';
import { TEMPLATES } from './templates';

const WorklistQuery = z.object({
  view: z.enum(['NURSE', 'DOCTOR']).default('DOCTOR'),
  branchId: Uuid.optional(),
  unitId: Uuid.optional(),
  mine: z.enum(['true', 'false']).optional(),
  includeDone: z.enum(['true', 'false']).optional(),
});
interface Row {
  id: string; encounter_no: string; status: string; arrived_at: string; local_time: string; triaged_at: string | null;
  consult_started_at: string | null; unit_id: string; unit_name: string; practitioner_id: string; practitioner_name: string; payer_type: string;
  patient_id: string; mrn: string; full_name: string; birth_date: string; sex: string; display_code: string | null; ticket_status: string | null;
  note_status: string | null; allergy_count: number;
}

/**
 * Worklist klinis (CLN-FR-001): pasien hari ini (hari lokal cabang) yang sudah hadir dan belum selesai konsultasi, urut
 * sesuai urutan layanan antrean. Tampilan perawat menonjolkan yang belum ditriase; tampilan dokter dapat dibatasi ke
 * pasien dokter yang login (`mine=true`, akun tertaut tenaga kesehatan).
 */
@Controller('api/v1')
export class WorklistController {
  constructor(private readonly db: Db) {}

  @RequirePermission('clinical.record.read') @Get('clinical/worklist')
  async worklist(@Query() q: Record<string, string | undefined>) {
    const P = WorklistQuery.safeParse(q);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const f = P.data;
    return this.db.withTenantTx(async (tx) => {
      let practitionerId: string | null = null;
      if (f.mine === 'true') {
        const [u] = await rows<{ practitioner_id: string | null }>(tx, sql`select practitioner_id from app_user where id = ${ctx().userId}`);
        if (!u?.practitioner_id) throw problem(409, 'CLN-409-NO-PRACTITIONER', 'Akun Anda belum tertaut ke data tenaga kesehatan');
        practitionerId = u.practitioner_id;
      }
      const statuses = f.includeDone === 'true'
        ? ['ARRIVED', 'TRIAGED', 'IN_CONSULTATION', 'CONSULT_DONE', 'PHARMACY', 'BILLING', 'FINISHED']
        : f.view === 'NURSE' ? ['ARRIVED', 'TRIAGED'] : ['ARRIVED', 'TRIAGED', 'IN_CONSULTATION'];
      const r = await rows<Row>(tx, sql`
        select e.id, e.encounter_no, e.status, e.arrived_at, to_char(e.arrived_at at time zone b.timezone, 'HH24:MI') as local_time,
               e.triaged_at, e.consult_started_at, e.unit_id, u.name as unit_name, e.practitioner_id, pr.full_name as practitioner_name,
               e.payer_type, p.id as patient_id, p.mrn, p.full_name, to_char(p.birth_date, 'YYYY-MM-DD') as birth_date, p.sex,
               q.display_code, q.status as ticket_status, n.status as note_status,
               (select count(*)::int from allergy_intolerance a where a.patient_id = p.id and a.status = 'ACTIVE') as allergy_count
          from encounter e join branch b on b.id = e.branch_id join service_unit u on u.id = e.unit_id
          join practitioner pr on pr.id = e.practitioner_id join patient p on p.id = e.patient_id
          left join queue_ticket q on q.encounter_id = e.id left join clinical_note n on n.encounter_id = e.id
         where (e.arrived_at at time zone b.timezone)::date = (now() at time zone b.timezone)::date
           and e.status = any(${`{${statuses.join(',')}}`}::text[])
           and (${f.branchId ?? null}::uuid is null or e.branch_id = ${f.branchId ?? null}::uuid)
           and (${f.unitId ?? null}::uuid is null or e.unit_id = ${f.unitId ?? null}::uuid)
           and (${practitionerId}::uuid is null or e.practitioner_id = ${practitionerId}::uuid)
         order by (e.status = 'IN_CONSULTATION') desc, q.sort_key nulls last, e.arrived_at, e.id
         limit 300`);
      return r.map((x) => ({
        id: x.id, encounterNo: x.encounter_no, status: x.status, arrivedAt: x.arrived_at, localTime: x.local_time, triagedAt: x.triaged_at,
        consultStartedAt: x.consult_started_at, unitId: x.unit_id, unitName: x.unit_name, practitionerId: x.practitioner_id,
        practitionerName: x.practitioner_name, payerType: x.payer_type,
        patient: { id: x.patient_id, mrn: x.mrn, fullName: x.full_name, birthDate: x.birth_date, sex: x.sex, age: ageText(x.birth_date) },
        queue: x.display_code ? { displayCode: x.display_code, status: x.ticket_status } : null,
        noteStatus: x.note_status, allergyCount: x.allergy_count,
      }));
    });
  }

  /** Dokter mulai memeriksa: status → Diperiksa; tiket antrean selesai dilayani (layar TV diperbarui). */
  @RequirePermission('clinical.note.write') @NoBody() @Post('encounters/:id/start-consultation') @HttpCode(200)
  async start(@Param('id') id: string) {
    assertId(id, ...ENC_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const [e] = await rows<{ status: string; patient_id: string; branch_id: string }>(tx, sql`
        select status, patient_id, branch_id from encounter where id = ${id} for update`);
      if (!e) throw problem(404, ...ENC_NOT_FOUND);
      if (e.status !== 'IN_CONSULTATION') {
        if (!['ARRIVED', 'TRIAGED'].includes(e.status)) throw problem(409, 'ENC-409-STATUS', 'Kunjungan tidak dalam status menunggu pemeriksaan');
        await tx.execute(sql`update encounter set status = 'IN_CONSULTATION', consult_started_at = now(), updated_by = ${ctx().userId} where id = ${id}`);
        await tx.execute(sql`update queue_ticket set status = 'SERVED', updated_by = ${ctx().userId}
                              where encounter_id = ${id} and status in ('WAITING', 'CALLED', 'SKIPPED')`);
        await tx.execute(sql`select pg_notify('clinicrme_queue', app.current_tenant_id()::text || ':' || ${e.branch_id}::text)`);
        await audit(tx, 'CONSULTATION_STARTED', 'encounter', id, e.patient_id);
      }
      const [r] = await rows<{ status: string; consult_started_at: string }>(tx, sql`select status, consult_started_at from encounter where id = ${id}`);
      return { id, status: r.status, consultStartedAt: r.consult_started_at };
    });
  }

  /** Template klinis (OD-035) beserta isian terstruktur — dipakai layar SOAP. */
  @RequirePermission('clinical.record.read') @Get('clinical/templates')
  templates() {
    return TEMPLATES;
  }
}
