import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, NoBody, RequirePermission, assertId, assertVersion, ctx, ifMatchVersion, problem, problemWith } from '@clinicrme/shared';
import { Db, type Tx, audit, rows } from '@clinicrme/db';
import {
  ENC_NOT_FOUND, ageText, allergiesOf, diagnosesOf, historyOf, lockEditable, noteOf, proceduresOf, templateOf, vitalsOf,
} from './chart.repo';
import { AnamnesisBody, DiagnosesBody, NoteBody, ProcedureBody, VITAL_LIMITS, type VitalKey, VitalsBody } from './clinical.schemas';
import { TEMPLATES, type TemplateCode, structuredSchema } from './templates';

interface EncInfo {
  id: string; encounter_no: string; status: string; arrived_at: string; local_date: string; triaged_at: string | null;
  consult_started_at: string | null; branch_id: string; branch_name: string; unit_id: string; unit_name: string; default_template: string | null;
  practitioner_id: string; practitioner_name: string; payer_type: string; payer_name: string | null; version: number;
  patient_id: string; mrn: string; full_name: string; birth_date: string; sex: string; processing_restricted: boolean;
}

/**
 * Layar encounter (CLN-FR-001, 002, 004–009, 016): ringkasan pasien & alergi, tanda vital, SOAP + template, diagnosis
 * ICD-10, tindakan ICD-9-CM, riwayat kunjungan. Setiap pembukaan rekam medis tercatat di audit dengan patient_id
 * (AUD-FR-002). Penulisan ditolak setelah catatan disahkan (batch 2 menambah pengesahan & addendum).
 */
@Controller('api/v1')
export class ChartController {
  constructor(private readonly db: Db) {}

  @RequirePermission('clinical.record.read') @Get('encounters/:id/chart')
  async chart(@Param('id') id: string) {
    assertId(id, ...ENC_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const r = await this.chartOf(tx, id);
      await audit(tx, 'CLINICAL_RECORD_READ', 'encounter', id, r.patient.id);
      return r;
    });
  }

  /** CLN-FR-002: satu set tanda vital per simpan; IMT otomatis dari BB & TB (set ini atau set sebelumnya di kunjungan sama). */
  @RequirePermission('clinical.vitals.write') @BodySchema(VitalsBody) @Post('encounters/:id/vitals') @HttpCode(201)
  async vitals(@Param('id') id: string, @Body() b: z.infer<typeof VitalsBody>) {
    assertId(id, ...ENC_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const e = await lockEditable(tx, id);
      const items: { code: string; value: number; unit: string }[] = [];
      for (const [k, v] of Object.entries(b) as [VitalKey, number | undefined][]) {
        if (v !== undefined) items.push({ code: VITAL_LIMITS[k].code, value: v, unit: VITAL_LIMITS[k].unit });
      }
      const [last] = await rows<{ weight: string | null; height: string | null }>(tx, sql`
        select (select value_num from observation where encounter_id = ${id} and code = 'WEIGHT' order by recorded_at desc limit 1)::text as weight,
               (select value_num from observation where encounter_id = ${id} and code = 'HEIGHT' order by recorded_at desc limit 1)::text as height`);
      const w = b.weight ?? (last.weight ? Number(last.weight) : undefined);
      const h = b.height ?? (last.height ? Number(last.height) : undefined);
      if ((b.weight !== undefined || b.height !== undefined) && w && h) {
        items.push({ code: 'BMI', value: Math.round((w / (h / 100) ** 2) * 10) / 10, unit: 'kg/m²' });
      }
      for (const i of items) {
        await tx.execute(sql`insert into observation(tenant_id, encounter_id, code, value_num, unit, recorded_by)
                             values (app.current_tenant_id(), ${id}, ${i.code}, ${i.value}, ${i.unit}, ${ctx().userId})`);
      }
      if (e.status === 'ARRIVED') {
        await tx.execute(sql`update encounter set status = 'TRIAGED', triaged_at = now(), updated_by = ${ctx().userId} where id = ${id}`);
      }
      await audit(tx, 'VITALS_RECORDED', 'encounter', id, e.patient_id, { codes: items.map((i) => i.code) });
      return (await vitalsOf(tx, id))[0];
    });
  }

  /**
   * OD-092: perawat mengisi anamnesis awal (S) tanpa izin menulis SOAP lengkap. Membuat draft catatan bila belum ada.
   * If-Match = versi catatan (0 bila belum ada).
   */
  @RequirePermission('clinical.vitals.write') @BodySchema(AnamnesisBody) @Put('encounters/:id/anamnesis')
  async anamnesis(@Param('id') id: string, @Body() b: z.infer<typeof AnamnesisBody>, @Headers('if-match') ifMatch: string | undefined) {
    assertId(id, ...ENC_NOT_FOUND);
    const expected = ifMatchVersion(ifMatch, 'catatan klinis');
    return this.db.withTenantTx(async (tx) => {
      const e = await lockEditable(tx, id);
      await this.upsertNote(tx, e, expected, { subjective: b.subjective || null });
      return noteOf(tx, id);
    });
  }

  /** CLN-FR-004/005: simpan draft SOAP (autosave). If-Match = versi catatan (0 bila belum ada). */
  @RequirePermission('clinical.note.write') @BodySchema(NoteBody) @Put('encounters/:id/note')
  async note(@Param('id') id: string, @Body() b: z.infer<typeof NoteBody>, @Headers('if-match') ifMatch: string | undefined) {
    assertId(id, ...ENC_NOT_FOUND);
    const expected = ifMatchVersion(ifMatch, 'catatan klinis');
    return this.db.withTenantTx(async (tx) => {
      const e = await lockEditable(tx, id);
      const [cur] = e.note_id ? await rows<{ template_code: TemplateCode; structured: Record<string, unknown> }>(tx, sql`
        select template_code, structured from clinical_note where id = ${e.note_id}`) : [];
      const template = b.templateCode ?? cur?.template_code ?? templateOf(e);
      let structured: Record<string, unknown> | undefined;
      if (b.structured !== undefined || (cur && template !== cur.template_code)) {
        // Ganti template tanpa mengirim isian: isian lama yang tidak dikenal template baru dibuang
        const known = new Set((TEMPLATES.find((t) => t.code === template)?.fields ?? []).map((f) => f.key));
        const carried = Object.fromEntries(Object.entries(cur?.structured ?? {}).filter(([k]) => known.has(k)));
        const S = structuredSchema(template).safeParse(b.structured ?? carried);
        if (!S.success) {
          throw problemWith(400, 'CLN-400-STRUCTURED', 'Isian template tidak valid',
            { errors: S.error.issues.map((i) => ({ field: ['structured', ...i.path].join('.'), message: i.message })) });
        }
        structured = Object.fromEntries(Object.entries(S.data).filter(([, v]) => v !== null && v !== undefined && v !== ''));
      }
      const patch: Record<string, unknown> = { templateCode: template };
      for (const k of ['subjective', 'objective', 'assessment', 'plan'] as const) if (b[k] !== undefined) patch[k] = b[k];
      if (structured !== undefined) patch['structured'] = structured;
      await this.upsertNote(tx, e, expected, patch);
      return noteOf(tx, id);
    });
  }

  /** CLN-FR-008: daftar diagnosis menggantikan daftar lama. ICD-10 versi berlaku & aktif; maksimal satu primer. */
  @RequirePermission('clinical.note.write') @BodySchema(DiagnosesBody) @Put('encounters/:id/diagnoses')
  async diagnoses(@Param('id') id: string, @Body() b: z.infer<typeof DiagnosesBody>) {
    assertId(id, ...ENC_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const e = await lockEditable(tx, id);
      const ids = b.map((d) => d.conceptId);
      if (ids.length) {
        const ok = await rows<{ id: string }>(tx, sql`
          select c.id from concept c join code_system s on s.id = c.system_id
           where c.id = any(${`{${ids.join(',')}}`}::uuid[]) and c.is_active and s.is_current and s.code = 'ICD10'`);
        const bad = ids.filter((x) => !ok.some((o) => o.id === x));
        if (bad.length) throw problemWith(400, 'CLN-400-CONCEPT', 'Kode diagnosis bukan ICD-10 versi berlaku', { conceptIds: bad });
      }
      const before = await diagnosesOf(tx, id);
      await tx.execute(sql`delete from condition_dx where encounter_id = ${id}`);
      for (const d of b) {
        await tx.execute(sql`insert into condition_dx(tenant_id, encounter_id, concept_id, rank, case_status, note, created_by)
          values (app.current_tenant_id(), ${id}, ${d.conceptId}, ${d.rank}, ${d.caseStatus}, ${d.note ?? null}, ${ctx().userId})`);
      }
      const after = await diagnosesOf(tx, id);
      const sig = (x: typeof after) => JSON.stringify(x.map((d) => [d.rank, d.conceptId, d.caseStatus, d.note]));
      // Audit tanpa isi klinis (kode/diagnosis tetap di rekam medis): hanya jumlah sebelum/sesudah
      if (sig(before) !== sig(after)) await audit(tx, 'DIAGNOSES_SET', 'encounter', id, e.patient_id, { before: before.length, after: after.length });
      return after;
    });
  }

  /**
   * CLN-FR-009: tindakan = layanan klinik aktif (bertarif di Stage 11) + kode ICD-9-CM opsional; pelaksana tenaga
   * kesehatan aktif (bawaan: dokter kunjungan).
   */
  @RequirePermission('clinical.note.write') @BodySchema(ProcedureBody) @Post('encounters/:id/procedures') @HttpCode(201)
  async addProcedure(@Param('id') id: string, @Body() b: z.infer<typeof ProcedureBody>) {
    assertId(id, ...ENC_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const e = await lockEditable(tx, id);
      const [s] = await rows<{ ok: boolean }>(tx, sql`select is_active as ok from service_item where id = ${b.serviceItemId}`);
      if (!s?.ok) throw problemWith(400, 'CLN-400-SERVICE', 'Layanan tidak ditemukan atau tidak aktif', { field: 'serviceItemId' });
      if (b.conceptId) {
        const [c] = await rows<{ id: string }>(tx, sql`select c.id from concept c join code_system cs on cs.id = c.system_id
          where c.id = ${b.conceptId} and c.is_active and cs.is_current and cs.code = 'ICD9CM'`);
        if (!c) throw problemWith(400, 'CLN-400-CONCEPT', 'Kode tindakan bukan ICD-9-CM versi berlaku', { field: 'conceptId' });
      }
      const by = b.performedBy ?? e.practitioner_id;
      const [p] = await rows<{ ok: boolean }>(tx, sql`select is_active as ok from practitioner where id = ${by}`);
      if (!p?.ok) throw problemWith(400, 'CLN-400-PERFORMER', 'Pelaksana bukan tenaga kesehatan aktif', { field: 'performedBy' });
      const [{ id: pid }] = await rows<{ id: string }>(tx, sql`
        insert into procedure_act(tenant_id, encounter_id, concept_id, service_item_id, performed_by, qty)
        values (app.current_tenant_id(), ${id}, ${b.conceptId ?? null}, ${b.serviceItemId}, ${by}, ${b.qty}) returning id`);
      const r = (await proceduresOf(tx, id)).find((x) => x.id === pid)!;
      await audit(tx, 'PROCEDURE_ADDED', 'encounter', id, e.patient_id, { procedureId: pid, serviceItemId: b.serviceItemId });
      return r;
    });
  }

  @RequirePermission('clinical.note.write') @NoBody() @Delete('encounters/:id/procedures/:procedureId') @HttpCode(204)
  async removeProcedure(@Param('id') id: string, @Param('procedureId') procedureId: string) {
    assertId(id, ...ENC_NOT_FOUND);
    assertId(procedureId, 'CLN-404-PROCEDURE', 'Tindakan tidak ditemukan');
    await this.db.withTenantTx(async (tx) => {
      const e = await lockEditable(tx, id);
      const r = (await proceduresOf(tx, id)).find((x) => x.id === procedureId);
      if (!r) throw problem(404, 'CLN-404-PROCEDURE', 'Tindakan tidak ditemukan');
      await tx.execute(sql`delete from procedure_act where id = ${procedureId}`);
      await audit(tx, 'PROCEDURE_REMOVED', 'encounter', id, e.patient_id, { procedureId, serviceItemId: r.serviceItemId });
    });
  }

  private async upsertNote(tx: Tx, e: { id: string; patient_id: string; note_id: string | null; note_version: number | null; default_template: string | null },
                           expected: number, patch: Record<string, unknown>) {
    assertVersion(e.note_version ?? 0, expected, 'Catatan klinis');
    const col = { templateCode: sql`template_code`, subjective: sql`subjective`, objective: sql`objective`, assessment: sql`assessment`, plan: sql`plan` } as const;
    if (!e.note_id) {
      const v = { templateCode: templateOf(e), subjective: null, objective: null, assessment: null, plan: null, structured: {}, ...patch };
      const [{ id: nid }] = await rows<{ id: string }>(tx, sql`
        insert into clinical_note(tenant_id, encounter_id, template_code, subjective, objective, assessment, plan, structured, created_by, updated_by)
        values (app.current_tenant_id(), ${e.id}, ${v.templateCode}, ${v.subjective}, ${v.objective}, ${v.assessment}, ${v.plan},
                ${JSON.stringify(v.structured)}::jsonb, ${ctx().userId}, ${ctx().userId}) returning id`);
      // Isi klinis tidak disalin ke audit (sudah tersimpan di rekam medis); audit mencatat siapa mengubah bagian mana
      await audit(tx, 'CLINICAL_NOTE_CREATED', 'clinical_note', nid, e.patient_id, { fields: Object.keys(patch) });
      return;
    }
    const [cur] = await rows<Record<string, unknown>>(tx, sql`
      select template_code as "templateCode", subjective, objective, assessment, plan, structured from clinical_note where id = ${e.note_id}`);
    const sets = Object.entries(patch).map(([k, v]) => k === 'structured'
      ? sql`structured = ${JSON.stringify(v)}::jsonb` : sql`${col[k as keyof typeof col]} = ${v as string | null}`);
    await tx.execute(sql`update clinical_note set ${sql.join(sets, sql`, `)} where id = ${e.note_id}`);
    const changed = Object.keys(patch).filter((k) => JSON.stringify(cur[k] ?? null) !== JSON.stringify(patch[k] ?? null));
    if (changed.length) await audit(tx, 'CLINICAL_NOTE_UPDATED', 'clinical_note', e.note_id, e.patient_id, { fields: changed });
  }

  async chartOf(tx: Tx, id: string) {
    const [e] = await rows<EncInfo>(tx, sql`
      select e.id, e.encounter_no, e.status, e.arrived_at, to_char(e.arrived_at at time zone b.timezone, 'YYYY-MM-DD') as local_date,
             e.triaged_at, e.consult_started_at, e.branch_id, b.name as branch_name, e.unit_id, u.name as unit_name, u.default_template,
             e.practitioner_id, pr.full_name as practitioner_name, e.payer_type, y.name as payer_name, e.version,
             p.id as patient_id, p.mrn, p.full_name, to_char(p.birth_date, 'YYYY-MM-DD') as birth_date, p.sex, p.processing_restricted
        from encounter e join patient p on p.id = e.patient_id join branch b on b.id = e.branch_id
        join service_unit u on u.id = e.unit_id join practitioner pr on pr.id = e.practitioner_id
        left join patient_coverage c on c.id = e.coverage_id left join payer y on y.id = c.payer_id
       where e.id = ${id}`);
    if (!e) throw problem(404, ...ENC_NOT_FOUND);
    const note = await noteOf(tx, id);
    const previous = await rows<{ id: string; encounter_no: string; local_date: string; unit_name: string; practitioner_name: string; status: string;
                                  dx_code: string | null; dx_display: string | null; assessment: string | null; note_status: string | null }>(tx, sql`
      select e.id, e.encounter_no, to_char(e.arrived_at at time zone b.timezone, 'YYYY-MM-DD') as local_date, u.name as unit_name,
             pr.full_name as practitioner_name, e.status, c.code as dx_code, c.display_id as dx_display, n.assessment, n.status as note_status
        from encounter e join branch b on b.id = e.branch_id join service_unit u on u.id = e.unit_id join practitioner pr on pr.id = e.practitioner_id
        left join clinical_note n on n.encounter_id = e.id
        left join condition_dx d on d.encounter_id = e.id and d.rank = 'PRIMER' left join concept c on c.id = d.concept_id
       where e.patient_id = ${e.patient_id} and e.id <> ${id} and e.status <> 'CANCELLED'
       order by e.arrived_at desc nulls last limit 10`);
    return {
      encounter: { id: e.id, encounterNo: e.encounter_no, status: e.status, arrivedAt: e.arrived_at, localDate: e.local_date,
        triagedAt: e.triaged_at, consultStartedAt: e.consult_started_at, branchId: e.branch_id, branchName: e.branch_name,
        unitId: e.unit_id, unitName: e.unit_name, practitionerId: e.practitioner_id, practitionerName: e.practitioner_name,
        payerType: e.payer_type, payerName: e.payer_name, version: e.version },
      patient: { id: e.patient_id, mrn: e.mrn, fullName: e.full_name, birthDate: e.birth_date, sex: e.sex,
        age: ageText(e.birth_date, new Date(e.arrived_at ?? Date.now())), processingRestricted: e.processing_restricted,
        allergies: await allergiesOf(tx, e.patient_id, true), history: await historyOf(tx, e.patient_id, true) },
      templateCode: (note?.templateCode ?? templateOf(e)) as TemplateCode,
      note,
      vitals: await vitalsOf(tx, id),
      diagnoses: await diagnosesOf(tx, id),
      procedures: await proceduresOf(tx, id),
      previousVisits: previous.map((v) => ({ id: v.id, encounterNo: v.encounter_no, localDate: v.local_date, unitName: v.unit_name,
        practitionerName: v.practitioner_name, status: v.status, noteStatus: v.note_status,
        primaryDiagnosis: v.dx_code ? { code: v.dx_code, display: v.dx_display } : null, assessment: v.assessment })),
      editable: !['CANCELLED', 'FINISHED'].includes(e.status) && note?.status !== 'SIGNED',
    };
  }
}
