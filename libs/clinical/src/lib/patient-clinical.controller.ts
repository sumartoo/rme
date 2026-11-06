import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, RequirePermission, assertId, ctx, problem } from '@clinicrme/shared';
import { Db, type Tx, audit, rows } from '@clinicrme/db';
import { allergiesOf, historyOf } from './chart.repo';
import { AllergyBody, HistoryBody, StatusBody } from './clinical.schemas';

const PATIENT_404 = ['PAT-404', 'Pasien tidak ditemukan'] as const;
async function assertPatient(tx: Tx, id: string) {
  const [p] = await rows<{ status: string }>(tx, sql`select status from patient where id = ${id}`);
  if (!p) throw problem(404, ...PATIENT_404);
  if (p.status === 'MERGED') throw problem(409, 'PAT-409-MERGED', 'Pasien sudah digabung ke data lain');
}

/**
 * Alergi (CLN-FR-006) & riwayat penyakit/obat rutin (CLN-FR-007) di tingkat pasien — berlaku lintas kunjungan & cabang.
 * Tidak dihapus: dinonaktifkan atau ditandai salah input dengan alasan. Alergi aktif tampil di header layar encounter
 * dan dipakai pengecekan resep (batch 3).
 */
@Controller('api/v1')
export class PatientClinicalController {
  constructor(private readonly db: Db) {}

  @RequirePermission('clinical.record.read') @Get('patients/:id/allergies')
  async allergies(@Param('id') id: string) {
    assertId(id, ...PATIENT_404);
    return this.db.withTenantTx(async (tx) => { await assertPatient(tx, id); return allergiesOf(tx, id, false); });
  }

  @RequirePermission('clinical.record.write') @BodySchema(AllergyBody) @Post('patients/:id/allergies') @HttpCode(201)
  async addAllergy(@Param('id') id: string, @Body() b: z.infer<typeof AllergyBody>) {
    assertId(id, ...PATIENT_404);
    return this.db.withTenantTx(async (tx) => {
      await assertPatient(tx, id);
      const [dup] = await rows<{ id: string }>(tx, sql`select id from allergy_intolerance
        where patient_id = ${id} and status = 'ACTIVE' and lower(substance) = lower(${b.substance})`);
      if (dup) throw problem(409, 'CLN-409-ALLERGY-EXISTS', 'Alergi ini sudah tercatat aktif');
      const [{ id: aid }] = await rows<{ id: string }>(tx, sql`
        insert into allergy_intolerance(tenant_id, patient_id, substance, category, reaction, severity, recorded_by)
        values (app.current_tenant_id(), ${id}, ${b.substance}, ${b.category}, ${b.reaction ?? null}, ${b.severity ?? null}, ${ctx().userId})
        returning id`);
      await audit(tx, 'ALLERGY_RECORDED', 'allergy_intolerance', aid, id, { category: b.category, severity: b.severity ?? null });
      return (await allergiesOf(tx, id, false)).find((a) => a.id === aid);
    });
  }

  @RequirePermission('clinical.record.write') @BodySchema(StatusBody) @Post('patients/:id/allergies/:allergyId/status') @HttpCode(200)
  async allergyStatus(@Param('id') id: string, @Param('allergyId') allergyId: string, @Body() b: z.infer<typeof StatusBody>) {
    assertId(id, ...PATIENT_404);
    assertId(allergyId, 'CLN-404-ALLERGY', 'Alergi tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      const [a] = await rows<{ status: string }>(tx, sql`select status from allergy_intolerance where id = ${allergyId} and patient_id = ${id} for update`);
      if (!a) throw problem(404, 'CLN-404-ALLERGY', 'Alergi tidak ditemukan');
      if (a.status !== 'ACTIVE') throw problem(409, 'CLN-409-STATUS', 'Alergi sudah tidak aktif');
      await tx.execute(sql`update allergy_intolerance set status = ${b.status}, status_reason = ${b.reason}, status_changed_by = ${ctx().userId},
                             status_changed_at = now() where id = ${allergyId}`);
      await audit(tx, 'ALLERGY_STATUS_CHANGED', 'allergy_intolerance', allergyId, id, { status: b.status, reason: b.reason });
      return (await allergiesOf(tx, id, false)).find((x) => x.id === allergyId);
    });
  }

  @RequirePermission('clinical.record.read') @Get('patients/:id/history')
  async history(@Param('id') id: string) {
    assertId(id, ...PATIENT_404);
    return this.db.withTenantTx(async (tx) => { await assertPatient(tx, id); return historyOf(tx, id, false); });
  }

  @RequirePermission('clinical.record.write') @BodySchema(HistoryBody) @Post('patients/:id/history') @HttpCode(201)
  async addHistory(@Param('id') id: string, @Body() b: z.infer<typeof HistoryBody>) {
    assertId(id, ...PATIENT_404);
    return this.db.withTenantTx(async (tx) => {
      await assertPatient(tx, id);
      const [{ id: hid }] = await rows<{ id: string }>(tx, sql`
        insert into patient_history(tenant_id, patient_id, history_type, description, recorded_by)
        values (app.current_tenant_id(), ${id}, ${b.historyType}, ${b.description}, ${ctx().userId}) returning id`);
      await audit(tx, 'HISTORY_RECORDED', 'patient_history', hid, id, { historyType: b.historyType });
      return (await historyOf(tx, id, false)).find((h) => h.id === hid);
    });
  }

  @RequirePermission('clinical.record.write') @BodySchema(StatusBody) @Post('patients/:id/history/:historyId/status') @HttpCode(200)
  async historyStatus(@Param('id') id: string, @Param('historyId') historyId: string, @Body() b: z.infer<typeof StatusBody>) {
    assertId(id, ...PATIENT_404);
    assertId(historyId, 'CLN-404-HISTORY', 'Riwayat tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      const [h] = await rows<{ status: string }>(tx, sql`select status from patient_history where id = ${historyId} and patient_id = ${id} for update`);
      if (!h) throw problem(404, 'CLN-404-HISTORY', 'Riwayat tidak ditemukan');
      if (h.status !== 'ACTIVE') throw problem(409, 'CLN-409-STATUS', 'Riwayat sudah tidak aktif');
      await tx.execute(sql`update patient_history set status = ${b.status}, status_reason = ${b.reason}, status_changed_by = ${ctx().userId},
                             status_changed_at = now() where id = ${historyId}`);
      await audit(tx, 'HISTORY_STATUS_CHANGED', 'patient_history', historyId, id, { status: b.status, reason: b.reason });
      return (await historyOf(tx, id, false)).find((x) => x.id === historyId);
    });
  }
}
