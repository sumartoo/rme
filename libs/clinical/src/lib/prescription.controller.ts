import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, NoBody, RequirePermission, Uuid, assertId, ctx, optText, problem, problemWith } from '@clinicrme/shared';
import { Db, type Tx, audit, rows } from '@clinicrme/db';
import { ENC_NOT_FOUND } from './chart.repo';
import { type ResolvedLine, type RxAlert, computeAlerts, prescriptionOf } from './prescription.repo';
import { signerOf } from './sign.controller';

export const ROUTES = ['ORAL', 'SUBLINGUAL', 'TOPIKAL', 'TETES_MATA', 'TETES_TELINGA', 'INHALASI', 'REKTAL', 'INJEKSI', 'LAINNYA'] as const;
const Qty = z.number().positive().max(100_000);
const Common = {
  doseQty: Qty, timesPerDay: z.number().int().min(1).max(24), route: z.enum(ROUTES),
  durationDays: z.number().int().min(1).max(365).nullable().optional(), qty: Qty, instructions: optText(500),
};
const DrugLine = z.object({ kind: z.literal('DRUG'), drugItemId: Uuid, ...Common }).strict();
const CompoundLine = z.object({
  kind: z.literal('COMPOUND'), compoundName: z.string().trim().min(2).max(200), compoundForm: z.string().trim().min(2).max(50), uomId: Uuid,
  components: z.array(z.object({ drugItemId: Uuid, qty: Qty }).strict()).min(1).max(10), ...Common,
}).strict();
export const PrescriptionBody = z.object({
  items: z.array(z.discriminatedUnion('kind', [DrugLine, CompoundLine])).max(30),
  overrides: z.array(z.object({ key: z.string().max(200), reason: z.string().trim().min(5).max(500) }).strict()).max(100).default([]),
  notes: optText(1000),
}).strict();

interface DrugInfo { id: string; generic_name: string; strength: string | null; base_uom_id: string; uom_name: string; ingredients: string[];
  max_dose_qty: string | null; max_daily_qty: string | null; is_active: boolean }

/**
 * Resep elektronik (CLN-FR-010–012; OD-033, OD-094 / DEC-038). Draft disimpan bebas selama pasien diperiksa; peringatan
 * (alergi, duplikasi zat aktif, batas dosis) dihitung ulang setiap simpan. Saat dokter menekan "Selesai konsultasi",
 * catatan harus sudah disahkan dan setiap peringatan wajib diberi alasan; resep diterbitkan (terkunci trigger DB) dan
 * kunjungan diteruskan ke farmasi atau kasir sesuai pengaturan klinik.
 */
@Controller('api/v1')
export class PrescriptionController {
  constructor(private readonly db: Db) {}

  @RequirePermission('clinical.record.read') @Get('encounters/:id/prescription')
  async get(@Param('id') id: string) {
    assertId(id, ...ENC_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const [e] = await rows(tx, sql`select 1 from encounter where id = ${id}`);
      if (!e) throw problem(404, ...ENC_NOT_FOUND);
      return { prescription: await prescriptionOf(tx, id) };
    });
  }

  @RequirePermission('clinical.prescription.write') @BodySchema(PrescriptionBody) @Put('encounters/:id/prescription')
  async save(@Param('id') id: string, @Body() b: z.infer<typeof PrescriptionBody>) {
    assertId(id, ...ENC_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const e = await this.lockConsultation(tx, id);
      const prescriber = await signerOf(tx, e.timezone);
      const lines = await this.resolve(tx, b.items);
      let [rx] = await rows<{ id: string; status: string }>(tx, sql`
        select id, status from prescription where encounter_id = ${id} and status <> 'CANCELLED' for update`);
      if (rx && rx.status !== 'DRAFT') throw problem(409, 'CLN-409-RX-ISSUED', 'Resep sudah diterbitkan');
      if (!rx) {
        const [{ no }] = await rows<{ no: string }>(tx, sql`select app.next_document_number('PRESCRIPTION', 'TENANT', 'RX{YYYY}{MM}{SEQ:6}') as no`);
        [rx] = await rows<{ id: string; status: string }>(tx, sql`
          insert into prescription(tenant_id, prescription_no, encounter_id, prescriber_id, updated_by)
          values (app.current_tenant_id(), ${no}, ${id}, ${prescriber.practitioner_id}, ${ctx().userId}) returning id, status`);
      }
      await tx.execute(sql`delete from prescription_compound_component c using prescription_item i
                            where c.prescription_item_id = i.id and i.prescription_id = ${rx.id}`);
      await tx.execute(sql`delete from prescription_item where prescription_id = ${rx.id}`);
      for (const [n, it] of b.items.entries()) {
        const line = lines[n];
        const uomId = it.kind === 'DRUG' ? line.drugs[0].base_uom_id : it.uomId;
        const [{ id: itemId }] = await rows<{ id: string }>(tx, sql`
          insert into prescription_item(tenant_id, prescription_id, line_no, is_compound, drug_item_id, compound_name, compound_form, dose, dose_qty,
                                        times_per_day, frequency, route, duration_days, qty, uom_id, instructions)
          values (app.current_tenant_id(), ${rx.id}, ${n + 1}, ${it.kind === 'COMPOUND'}, ${it.kind === 'DRUG' ? it.drugItemId : null},
                  ${it.kind === 'COMPOUND' ? it.compoundName : null}, ${it.kind === 'COMPOUND' ? it.compoundForm : null},
                  ${`${it.doseQty} ${line.resolved.uomName}`}, ${it.doseQty}, ${it.timesPerDay}, ${`${it.timesPerDay}x sehari`}, ${it.route},
                  ${it.durationDays ?? null}, ${it.qty}, ${uomId}, ${it.instructions ?? null}) returning id`);
        if (it.kind === 'COMPOUND') {
          for (const [k, c] of it.components.entries()) {
            await tx.execute(sql`insert into prescription_compound_component(tenant_id, prescription_item_id, drug_item_id, qty, uom_id)
                                 values (app.current_tenant_id(), ${itemId}, ${c.drugItemId}, ${c.qty}, ${line.drugs[k].base_uom_id})`);
          }
        }
      }
      const alerts = this.withReasons(await computeAlerts(tx, e.patient_id, lines.map((l) => l.resolved)), b.overrides);
      await tx.execute(sql`update prescription set alerts = ${JSON.stringify(alerts)}::jsonb, notes = ${b.notes ?? null},
                             prescriber_id = ${prescriber.practitioner_id}, updated_by = ${ctx().userId} where id = ${rx.id}`);
      await audit(tx, 'PRESCRIPTION_SAVED', 'prescription', rx.id, e.patient_id,
        { encounterId: id, lines: b.items.length, alerts: alerts.length, unacknowledged: alerts.filter((a) => !a.reason).length });
      return { prescription: await prescriptionOf(tx, id) };
    });
  }

  /** OD-094: catatan disahkan → resep diterbitkan (peringatan wajib beralasan) → Farmasi atau Kasir sesuai pengaturan klinik. */
  @RequirePermission('clinical.note.write') @NoBody() @Post('encounters/:id/finish-consultation') @HttpCode(200)
  async finish(@Param('id') id: string) {
    assertId(id, ...ENC_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const e = await this.lockConsultation(tx, id);
      const [n] = await rows<{ status: string }>(tx, sql`select status from clinical_note where encounter_id = ${id}`);
      if (n?.status !== 'SIGNED') throw problem(409, 'CLN-409-NOT-SIGNED', 'Sahkan rekam medis sebelum menyelesaikan konsultasi');
      const [rx] = await rows<{ id: string; prescription_no: string; alerts: RxAlert[]; items: number }>(tx, sql`
        select p.id, p.prescription_no, p.alerts, (select count(*)::int from prescription_item i where i.prescription_id = p.id) as items
          from prescription p where p.encounter_id = ${id} and p.status = 'DRAFT' for update of p`);
      let issued: string | null = null;
      if (rx && rx.items > 0) {
        // Hitung ulang: alergi/master obat bisa berubah sejak draft disimpan
        const lines = await this.resolveStored(tx, rx.id);
        const alerts = this.withReasons(await computeAlerts(tx, e.patient_id, lines), rx.alerts.filter((a) => a.reason).map((a) => ({ key: a.key, reason: a.reason! })));
        const open = alerts.filter((a) => !a.reason);
        if (open.length) throw problemWith(422, 'CLN-422-RX-ALERTS', 'Peringatan resep belum diberi alasan', { alerts: open });
        await tx.execute(sql`update prescription set status = 'ISSUED', issued_at = now(), alerts = ${JSON.stringify(alerts)}::jsonb,
                               updated_by = ${ctx().userId} where id = ${rx.id}`);
        issued = rx.prescription_no;
        await audit(tx, 'PRESCRIPTION_ISSUED', 'prescription', rx.id, e.patient_id, { encounterId: id, lines: rx.items, overridden: alerts.length });
      } else if (rx) {
        await tx.execute(sql`update prescription set status = 'CANCELLED', updated_by = ${ctx().userId} where id = ${rx.id}`);
      }
      const next = issued && e.pharmacy_first ? 'PHARMACY' : 'BILLING';
      await tx.execute(sql`update encounter set status = ${next}, consult_ended_at = now(), updated_by = ${ctx().userId} where id = ${id}`);
      await audit(tx, 'CONSULTATION_FINISHED', 'encounter', id, e.patient_id, { next, prescriptionNo: issued });
      return { id, status: next, prescriptionNo: issued };
    });
  }

  private async lockConsultation(tx: Tx, id: string) {
    const [e] = await rows<{ status: string; patient_id: string; timezone: string; pharmacy_first: boolean }>(tx, sql`
      select e.status, e.patient_id, b.timezone, coalesce((t.settings->>'pharmacyBeforeCashier')::boolean, false) as pharmacy_first
        from encounter e join branch b on b.id = e.branch_id join tenant t on t.id = e.tenant_id where e.id = ${id} for update of e`);
    if (!e) throw problem(404, ...ENC_NOT_FOUND);
    if (e.status !== 'IN_CONSULTATION') throw problem(409, 'CLN-409-NOT-IN-CONSULTATION', 'Resep & penyelesaian konsultasi hanya saat pasien sedang diperiksa');
    return e;
  }

  private withReasons(alerts: RxAlert[], overrides: { key: string; reason: string }[]): RxAlert[] {
    const m = new Map(overrides.map((o) => [o.key, o.reason]));
    return alerts.map((a) => ({ ...a, reason: m.get(a.key) ?? null }));
  }

  private async drugs(tx: Tx, ids: string[]): Promise<Map<string, DrugInfo>> {
    if (!ids.length) return new Map();
    const r = await rows<DrugInfo>(tx, sql`
      select d.id, d.generic_name, d.strength, d.base_uom_id, u.name as uom_name, d.ingredients, d.max_dose_qty::text as max_dose_qty,
             d.max_daily_qty::text as max_daily_qty, d.is_active
        from drug_item d join uom u on u.id = d.base_uom_id where d.id = any(${`{${[...new Set(ids)].join(',')}}`}::uuid[])`);
    return new Map(r.map((d) => [d.id, d]));
  }

  private async resolve(tx: Tx, items: z.infer<typeof PrescriptionBody>['items']) {
    const ids = items.flatMap((i) => (i.kind === 'DRUG' ? [i.drugItemId] : i.components.map((c) => c.drugItemId)));
    const m = await this.drugs(tx, ids);
    const errors: { field: string; message: string }[] = [];
    const uomIds = items.filter((i) => i.kind === 'COMPOUND').map((i) => (i as { uomId: string }).uomId);
    const uoms = uomIds.length ? new Map((await rows<{ id: string; name: string; is_active: boolean }>(tx, sql`
      select id, name, is_active from uom where id = any(${`{${[...new Set(uomIds)].join(',')}}`}::uuid[])`)).map((u) => [u.id, u])) : new Map();
    const out = items.map((it, n) => {
      const ds = (it.kind === 'DRUG' ? [it.drugItemId] : it.components.map((c) => c.drugItemId)).map((d, k) => {
        const x = m.get(d);
        if (!x?.is_active) errors.push({ field: it.kind === 'DRUG' ? `items.${n}.drugItemId` : `items.${n}.components.${k}.drugItemId`, message: 'Obat tidak ditemukan atau tidak aktif' });
        return x!;
      });
      let uomName = ds[0]?.uom_name ?? '';
      if (it.kind === 'COMPOUND') {
        const u = uoms.get(it.uomId);
        if (!u?.is_active) errors.push({ field: `items.${n}.uomId`, message: 'Satuan tidak ditemukan atau tidak aktif' });
        uomName = u?.name ?? '';
      }
      const ok = ds.every(Boolean);
      const resolved: ResolvedLine = {
        lineNo: n + 1, isCompound: it.kind === 'COMPOUND', label: it.kind === 'DRUG' ? (ds[0]?.generic_name ?? '') : it.compoundName,
        ingredients: ok ? ds.flatMap((d) => d.ingredients) : [], doseQty: it.doseQty, timesPerDay: it.timesPerDay, uomName,
        maxDose: it.kind === 'DRUG' && ds[0]?.max_dose_qty ? Number(ds[0].max_dose_qty) : null,
        maxDaily: it.kind === 'DRUG' && ds[0]?.max_daily_qty ? Number(ds[0].max_daily_qty) : null,
      };
      return { drugs: ds, resolved };
    });
    if (errors.length) throw problemWith(400, 'CLN-400-RX', 'Resep tidak valid', { errors });
    return out;
  }

  private async resolveStored(tx: Tx, rxId: string): Promise<ResolvedLine[]> {
    const items = await rows<{ id: string; line_no: number; is_compound: boolean; drug_item_id: string | null; compound_name: string | null;
                               dose_qty: string; times_per_day: number; uom_name: string }>(tx, sql`
      select i.id, i.line_no, i.is_compound, i.drug_item_id, i.compound_name, i.dose_qty::text as dose_qty, i.times_per_day, u.name as uom_name
        from prescription_item i join uom u on u.id = i.uom_id where i.prescription_id = ${rxId} order by i.line_no`);
    const comps = await rows<{ prescription_item_id: string; drug_item_id: string }>(tx, sql`
      select c.prescription_item_id, c.drug_item_id from prescription_compound_component c join prescription_item i on i.id = c.prescription_item_id
       where i.prescription_id = ${rxId} order by c.id`);
    const m = await this.drugs(tx, [...items.flatMap((i) => (i.drug_item_id ? [i.drug_item_id] : [])), ...comps.map((c) => c.drug_item_id)]);
    return items.map((i) => {
      const ds = i.is_compound ? comps.filter((c) => c.prescription_item_id === i.id).map((c) => m.get(c.drug_item_id)!) : [m.get(i.drug_item_id!)!];
      return { lineNo: i.line_no, isCompound: i.is_compound, label: i.is_compound ? i.compound_name! : ds[0].generic_name,
        ingredients: ds.flatMap((d) => d.ingredients), doseQty: Number(i.dose_qty), timesPerDay: i.times_per_day, uomName: i.uom_name,
        maxDose: !i.is_compound && ds[0].max_dose_qty ? Number(ds[0].max_dose_qty) : null,
        maxDaily: !i.is_compound && ds[0].max_daily_qty ? Number(ds[0].max_daily_qty) : null };
    });
  }
}
