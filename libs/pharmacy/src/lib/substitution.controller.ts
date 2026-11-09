import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, NoBody, RequirePermission, Uuid, assertId, ctx, optText, problem } from '@clinicrme/shared';
import { Db, type Tx, audit, rows } from '@clinicrme/db';
import { RX_NOT_FOUND, remainingOf, rxHead, rxItems } from './dispense.repo';

const SUB_NOT_FOUND = ['PHM-404-SUBSTITUTION', 'Pengajuan substitusi tidak ditemukan'] as const;
const RequestBody = z.object({ prescriptionItemId: Uuid, newDrugItemId: Uuid, reason: z.string().trim().min(5).max(300) }).strict();
const DecisionBody = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: optText(300) }).strict()
  .refine((b) => b.decision === 'APPROVE' || (b.note ?? '').length >= 5, { message: 'Alasan penolakan wajib diisi (min. 5 karakter)', path: ['note'] });

interface SubRow {
  id: string; status: string; reason: string; requested_at: string; requester_name: string; decided_at: string | null; decider_name: string | null;
  decision_note: string | null; prescription_item_id: string; line_no: number; qty: string; uom_name: string; frequency: string; prescription_id: string;
  prescription_no: string; encounter_no: string; branch_id: string; branch_name: string; patient_id: string; patient_name: string; mrn: string;
  prescriber_id: string; prescriber_name: string; from_drug_id: string; from_name: string; to_drug_id: string; to_name: string; to_strength: string | null;
  to_class: string; allergy_hits: string[];
}
const SEL = sql`
  select s.id, s.status, s.reason, s.requested_at, ru.full_name as requester_name, s.decided_at, dp.full_name as decider_name, s.decision_note,
         i.id as prescription_item_id, i.line_no, trim_scale(i.qty)::text as qty, u.name as uom_name, i.frequency, p.id as prescription_id, p.prescription_no,
         e.encounter_no, e.branch_id, br.name as branch_name, pt.id as patient_id, pt.full_name as patient_name, pt.mrn, p.prescriber_id,
         pr.full_name as prescriber_name, s.from_drug_id, fd.generic_name as from_name, s.to_drug_id, td.generic_name as to_name, td.strength as to_strength,
         td.drug_class as to_class,
         array(select a.substance from allergy_intolerance a where a.patient_id = pt.id and a.status = 'ACTIVE' and a.category in ('OBAT', 'LAINNYA')
                  and exists (select 1 from unnest(td.ingredients) ing where lower(ing) like '%' || lower(trim(a.substance)) || '%'
                                                                          or lower(trim(a.substance)) like '%' || lower(ing) || '%')) as allergy_hits
    from prescription_substitution s join prescription_item i on i.id = s.prescription_item_id join prescription p on p.id = i.prescription_id
    join encounter e on e.id = p.encounter_id join branch br on br.id = e.branch_id join patient pt on pt.id = e.patient_id
    join practitioner pr on pr.id = p.prescriber_id join uom u on u.id = i.uom_id join drug_item fd on fd.id = s.from_drug_id
    join drug_item td on td.id = s.to_drug_id join app_user ru on ru.id = s.requested_by left join practitioner dp on dp.id = s.decided_by_practitioner`;
const dto = (r: SubRow) => ({
  id: r.id, status: r.status, reason: r.reason, requestedAt: r.requested_at, requestedByName: r.requester_name, decidedAt: r.decided_at,
  decidedByName: r.decider_name, decisionNote: r.decision_note,
  prescription: { id: r.prescription_id, prescriptionNo: r.prescription_no, encounterNo: r.encounter_no, branchName: r.branch_name, prescriberName: r.prescriber_name },
  patient: { id: r.patient_id, name: r.patient_name, mrn: r.mrn },
  item: { id: r.prescription_item_id, lineNo: r.line_no, qty: Number(r.qty), uomName: r.uom_name, frequency: r.frequency },
  fromDrug: { id: r.from_drug_id, name: r.from_name },
  toDrug: { id: r.to_drug_id, name: r.to_name, strength: r.to_strength, drugClass: r.to_class },
  allergyWarnings: r.allergy_hits,
});

/**
 * Substitusi obat (PHM-FR-010; OD-099 / DEC-039, DEC-013/OD-064). Apoteker memilih pengganti (satuan dasar sama) dengan
 * alasan → pengajuan tampil di "Persetujuan substitusi" → dokter penulis resep atau dokter yang bertugas di cabang yang
 * sama hari ini menyetujui/menolak. Selama menunggu, baris itu tertahan; baris lain tetap dapat diserahkan.
 */
@Controller('api/v1')
export class SubstitutionController {
  constructor(private readonly db: Db) {}

  @RequirePermission('pharmacy.dispense') @BodySchema(RequestBody) @Post('pharmacy/prescriptions/:id/substitutions') @HttpCode(201)
  async request(@Param('id') id: string, @Body() b: z.infer<typeof RequestBody>) {
    assertId(id, ...RX_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const h = await rxHead(tx, id, true);
      if (!['ISSUED', 'VERIFIED', 'PARTIALLY_DISPENSED'].includes(h.status)) throw problem(409, 'PHM-409-RX-STATE', 'Resep sudah selesai atau ditutup');
      const { items } = await rxItems(tx, id, true);
      const it = items.find((i) => i.id === b.prescriptionItemId);
      if (!it) throw problem(400, 'PHM-400-ITEM', 'Baris resep tidak ditemukan');
      if (it.is_compound) throw problem(409, 'PHM-409-SUB-COMPOUND', 'Substitusi racikan belum didukung; ubah lewat dokter');
      if (Number(it.qty_dispensed) > 0 || remainingOf(it) <= 0) throw problem(409, 'PHM-409-SUB-STARTED', 'Baris yang sudah (sebagian) diserahkan atau ditutup tidak dapat disubstitusi');
      const [pair] = await rows<{ same_uom: boolean; active: boolean }>(tx, sql`
        select n.base_uom_id = o.base_uom_id as same_uom, n.is_active as active from drug_item n, drug_item o
         where n.id = ${b.newDrugItemId} and o.id = ${it.drug_item_id}`);
      if (!pair?.active) throw problem(400, 'PHM-400-DRUG', 'Obat pengganti tidak ditemukan atau tidak aktif');
      if (b.newDrugItemId === it.drug_item_id) throw problem(400, 'PHM-400-DRUG', 'Obat pengganti sama dengan obat di resep');
      if (!pair.same_uom) throw problem(400, 'PHM-400-SUB-UOM', 'Satuan dasar obat pengganti harus sama dengan obat di resep');
      const [pending] = await rows(tx, sql`select 1 from prescription_substitution where prescription_item_id = ${it.id} and status = 'REQUESTED'`);
      if (pending) throw problem(409, 'PHM-409-SUB-PENDING', 'Masih ada pengajuan substitusi yang menunggu untuk baris ini');
      const [{ id: subId }] = await rows<{ id: string }>(tx, sql`
        insert into prescription_substitution(tenant_id, prescription_item_id, from_drug_id, to_drug_id, reason, requested_by)
        values (app.current_tenant_id(), ${it.id}, ${it.drug_item_id}, ${b.newDrugItemId}, ${b.reason}, ${ctx().userId}) returning id`);
      await audit(tx, 'SUBSTITUTION_REQUESTED', 'prescription', id, h.patient_id,
        { prescriptionNo: h.prescription_no, line: it.line_no, from: it.drug_item_id, to: b.newDrugItemId, reason: b.reason });
      return this.one(tx, subId);
    });
  }

  @RequirePermission('pharmacy.dispense') @NoBody() @Post('pharmacy/substitutions/:id/cancel') @HttpCode(200)
  async cancel(@Param('id') id: string) {
    assertId(id, ...SUB_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const s = await this.one(tx, id);
      if (s.status !== 'REQUESTED') throw problem(409, 'PHM-409-SUB-DECIDED', 'Pengajuan sudah diputuskan');
      await tx.execute(sql`update prescription_substitution set status = 'CANCELLED', decided_by_user = ${ctx().userId}, decided_at = now() where id = ${id}`);
      await audit(tx, 'SUBSTITUTION_CANCELLED', 'prescription', s.prescription.id, s.patient.id, { substitutionId: id });
      return this.one(tx, id);
    });
  }

  /** Daftar untuk dokter: yang menunggu dan dapat ia putuskan (penulis resep atau bertugas di cabang hari ini), atau riwayatnya. */
  @RequirePermission('clinical.prescription.approve_substitution') @Get('substitutions')
  async list(@Query('status') status = 'REQUESTED') {
    if (!['REQUESTED', 'DECIDED'].includes(status)) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    return this.db.withTenantTx(async (tx) => {
      const me = await this.practitioner(tx);
      if (!me) return [];
      const r = await rows<SubRow>(tx, sql`${SEL}
        where ${status === 'REQUESTED' ? sql`s.status = 'REQUESTED' and (p.prescriber_id = ${me} or ${this.onDuty(me)})`
                                       : sql`s.decided_by_practitioner = ${me} and s.decided_at > now() - interval '30 days'`}
        order by s.requested_at ${status === 'REQUESTED' ? sql`` : sql`desc`} limit 200`);
      return r.map(dto);
    });
  }

  @RequirePermission('clinical.prescription.approve_substitution') @BodySchema(DecisionBody) @Post('substitutions/:id/decision') @HttpCode(200)
  async decide(@Param('id') id: string, @Body() b: z.infer<typeof DecisionBody>) {
    assertId(id, ...SUB_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const me = await this.practitioner(tx);
      if (!me) throw problem(403, 'PHM-403-NOT-APPROVER', 'Akun Anda belum ditautkan ke data tenaga kesehatan');
      const [s] = await rows<SubRow & { eligible: boolean; item_dispensed: string; rx_status: string }>(tx, sql`
        select x.*, (x.prescriber_id = ${me} or ${this.onDuty(me, sql`x.branch_id`)}) as eligible,
               (select qty_dispensed::text from prescription_item where id = x.prescription_item_id) as item_dispensed,
               (select status from prescription where id = x.prescription_id) as rx_status
          from (${SEL} where s.id = ${id}) x`);
      if (!s) throw problem(404, ...SUB_NOT_FOUND);
      if (!s.eligible) throw problem(403, 'PHM-403-NOT-APPROVER', 'Hanya dokter penulis resep atau dokter yang bertugas di cabang ini hari ini yang dapat memutuskan');
      if (s.status !== 'REQUESTED') throw problem(409, 'PHM-409-SUB-DECIDED', 'Pengajuan sudah diputuskan');
      await tx.execute(sql`select 1 from prescription where id = ${s.prescription_id} for update`);
      if (b.decision === 'APPROVE') {
        if (Number(s.item_dispensed) > 0 || !['ISSUED', 'VERIFIED', 'PARTIALLY_DISPENSED'].includes(s.rx_status)) {
          throw problem(409, 'PHM-409-SUB-STARTED', 'Baris resep sudah diserahkan atau resep sudah ditutup');
        }
        // Baris resep diperbarui; obat asli tetap tercatat (substituted_from_drug_id = obat pertama yang diresepkan)
        await tx.execute(sql`update prescription_item set drug_item_id = ${s.to_drug_id},
                               substituted_from_drug_id = coalesce(substituted_from_drug_id, ${s.from_drug_id}),
                               substitution_reason = ${s.reason}, substitution_approved_by = ${me} where id = ${s.prescription_item_id}`);
        await tx.execute(sql`update prescription set version = version + 1, updated_by = ${ctx().userId} where id = ${s.prescription_id}`);
      }
      await tx.execute(sql`update prescription_substitution set status = ${b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED'}, decided_by_user = ${ctx().userId},
                             decided_by_practitioner = ${me}, decided_at = now(), decision_note = ${b.note ?? null} where id = ${id}`);
      await audit(tx, b.decision === 'APPROVE' ? 'SUBSTITUTION_APPROVED' : 'SUBSTITUTION_REJECTED', 'prescription', s.prescription_id, s.patient_id,
        { substitutionId: id, line: s.line_no, from: s.from_drug_id, to: s.to_drug_id, note: b.note ?? null, allergyWarnings: s.allergy_hits });
      return this.one(tx, id);
    });
  }

  private async practitioner(tx: Tx): Promise<string | null> {
    const [p] = await rows<{ id: string }>(tx, sql`
      select pr.id from app_user u join practitioner pr on pr.id = u.practitioner_id where u.id = ${ctx().userId} and pr.is_active`);
    return p?.id ?? null;
  }

  /** Dokter bertugas: punya jadwal praktik aktif di cabang tersebut pada hari ini (zona waktu cabang). */
  private onDuty(practitionerId: string, branchCol = sql`e.branch_id`) {
    return sql`exists (select 1 from practitioner_schedule ps join branch b2 on b2.id = ps.branch_id
                        where ps.practitioner_id = ${practitionerId} and ps.branch_id = ${branchCol} and ps.is_active
                          and ps.day_of_week = extract(isodow from (now() at time zone b2.timezone))::int
                          and ps.valid_from <= (now() at time zone b2.timezone)::date
                          and (ps.valid_to is null or ps.valid_to >= (now() at time zone b2.timezone)::date))`;
  }

  private async one(tx: Tx, id: string) {
    const [r] = await rows<SubRow>(tx, sql`${SEL} where s.id = ${id}`);
    if (!r) throw problem(404, ...SUB_NOT_FOUND);
    return dto(r);
  }
}
