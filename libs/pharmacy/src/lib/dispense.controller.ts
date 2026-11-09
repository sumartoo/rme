import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { BodySchema, RequirePermission, Uuid, assertId, assertVersion, ctx, ifMatchVersion, optText, problem, problemWith } from '@clinicrme/shared';
import { renderPdf } from '@clinicrme/shared/pdf';
import { Db, type Tx, audit, idempotent, rows } from '@clinicrme/db';
import {
  CHECKLIST, ROUTE_LABEL, RX_NOT_FOUND, allocate, batchesFor, dispenseLocation, lockStock, needsOf, remainingOf, round4, rxHead, rxItems, settle,
  type ItemRow, type RxHead,
} from './dispense.repo';
import { RESTRICTED, assertRestrictedAllowed, currentPrice } from './stock.repo';

const CheckItem = z.object({ ok: z.boolean(), note: z.string().trim().max(500).nullable().optional() }).strict();
const ReviewBody = z.object({
  items: z.object(Object.fromEntries(CHECKLIST.map((c) => [c.key, CheckItem])) as Record<(typeof CHECKLIST)[number]['key'], typeof CheckItem>).strict(),
}).strict();
const Qty = z.number().positive().max(100_000);
const DispenseBody = z.object({
  locationId: Uuid.nullable().optional(),
  handedTo: optText(200),
  notes: optText(500),
  lines: z.array(z.object({
    prescriptionItemId: Uuid,
    qty: Qty,
    /** Pilihan batch manual (OD-037) — hanya obat non-racikan, wajib beralasan. */
    batches: z.array(z.object({ batchId: Uuid, qty: Qty }).strict()).min(1).max(20).optional(),
    batchReason: z.string().trim().min(5).max(300).optional(),
  }).strict()).min(1).max(30),
}).strict();
const CloseBody = z.object({
  reason: z.string().trim().min(5).max(300),
  itemIds: z.array(Uuid).min(1).max(30).optional(),
}).strict();
const WorklistQuery = z.object({
  branchId: Uuid.optional(), status: z.enum(['PENDING', 'PARTIAL', 'DONE']).default('PENDING'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), q: z.string().trim().max(100).optional(),
});

/**
 * Worklist, telaah & penyerahan obat (PHM-FR-005–009, 011, 013; OD-037, OD-096, OD-098, OD-102–104 / DEC-039).
 * Resep ISSUED → telaah checklist (semua sesuai → VERIFIED) → penyerahan per batch FEFO/FIFO dari lokasi cabang;
 * stok kurang → serahkan sebagian, sisa dapat diambil s.d. `partialPickupDays` (bawaan 7) hari. Harga jual terkunci di
 * baris penyerahan (belum ditagih, Stage 11). Racikan diserahkan utuh dan mengurangi stok setiap komponen.
 */
@Controller('api/v1/pharmacy')
export class DispenseController {
  constructor(private readonly db: Db) {}

  @RequirePermission('pharmacy.dispense') @Get('worklist')
  async worklist(@Query() query: Record<string, string | undefined>) {
    const P = WorklistQuery.safeParse(query);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const f = P.data;
    const like = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    return this.db.withTenantTx(async (tx) => {
      const r = await rows<{ id: string; prescription_no: string; status: string; issued_at: string; first_dispensed_at: string | null; reviewed: boolean;
                             review_problem: boolean; alerts: number; encounter_no: string; encounter_status: string; payer_type: string; patient_id: string;
                             patient_name: string; mrn: string; prescriber_name: string; branch_name: string; items: number; pickup_deadline: string | null }>(tx, sql`
        select p.id, p.prescription_no, p.status, p.issued_at, p.first_dispensed_at, p.review_checklist is not null as reviewed,
               coalesce(p.review_checklist->>'result' = 'PROBLEM', false) as review_problem, jsonb_array_length(p.alerts) as alerts,
               e.encounter_no, e.status as encounter_status, e.payer_type, pt.id as patient_id, pt.full_name as patient_name, pt.mrn,
               pr.full_name as prescriber_name, br.name as branch_name,
               (select count(*)::int from prescription_item i where i.prescription_id = p.id) as items,
               case when p.status = 'PARTIALLY_DISPENSED' then
                 p.first_dispensed_at + make_interval(days => coalesce((t.settings->>'partialPickupDays')::int, 7)) end as pickup_deadline
          from prescription p join encounter e on e.id = p.encounter_id join patient pt on pt.id = e.patient_id
          join practitioner pr on pr.id = p.prescriber_id join branch br on br.id = e.branch_id join tenant t on t.id = p.tenant_id
         where (${f.branchId ?? null}::uuid is null or e.branch_id = ${f.branchId ?? null}::uuid)
           and (${like}::text is null or pt.full_name ilike ${like} or pt.mrn ilike ${like} or p.prescription_no ilike ${like})
           and case ${f.status}::text
                 when 'PENDING' then p.status in ('ISSUED', 'VERIFIED')
                 when 'PARTIAL' then p.status = 'PARTIALLY_DISPENSED'
                 else p.status in ('DISPENSED', 'CLOSED')
                      and (p.issued_at at time zone br.timezone)::date = coalesce(${f.date ?? null}::date, (now() at time zone br.timezone)::date)
               end
         order by ${f.status === 'DONE' ? sql`p.issued_at desc` : sql`p.issued_at`}, p.id limit 200`);
      return r.map((x) => ({
        id: x.id, prescriptionNo: x.prescription_no, status: x.status, issuedAt: x.issued_at, firstDispensedAt: x.first_dispensed_at,
        reviewed: x.reviewed, reviewProblem: x.review_problem, alertCount: x.alerts, encounterNo: x.encounter_no, encounterStatus: x.encounter_status,
        payerType: x.payer_type, patient: { id: x.patient_id, name: x.patient_name, mrn: x.mrn }, prescriberName: x.prescriber_name,
        branchName: x.branch_name, itemCount: x.items, pickupDeadline: x.pickup_deadline,
      }));
    });
  }

  @RequirePermission('pharmacy.dispense') @Get('prescriptions/:id')
  async detail(@Param('id') id: string, @Query('locationId') locationId?: string) {
    assertId(id, ...RX_NOT_FOUND);
    if (locationId) assertId(locationId, 'PHM-400-LOCATION', 'Lokasi tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      const h = await rxHead(tx, id);
      const out = await this.view(tx, h, locationId);
      await audit(tx, 'PRESCRIPTION_VIEWED_PHARMACY', 'prescription', id, h.patient_id, { prescriptionNo: h.prescription_no });
      return out;
    });
  }

  /** OD-098: setiap butir dicentang sesuai atau diberi catatan masalah. Semua sesuai → VERIFIED; ada masalah → tetap ISSUED. */
  @RequirePermission('pharmacy.dispense') @BodySchema(ReviewBody) @Post('prescriptions/:id/review') @HttpCode(200)
  async review(@Param('id') id: string, @Body() b: z.infer<typeof ReviewBody>, @Headers('if-match') ifMatch: string | undefined) {
    assertId(id, ...RX_NOT_FOUND);
    const v = ifMatchVersion(ifMatch, 'resep');
    const errors = Object.entries(b.items).filter(([, x]) => !x.ok && (x.note ?? '').length < 3)
      .map(([k]) => ({ field: `items.${k}.note`, message: 'Tuliskan masalah yang ditemukan' }));
    if (errors.length) throw problemWith(400, 'PHM-400-REVIEW', 'Butir yang tidak sesuai wajib diberi catatan', { errors });
    return this.db.withTenantTx(async (tx) => {
      const h = await rxHead(tx, id, true);
      assertVersion(h.version, v, 'Resep');
      if (!['ISSUED', 'VERIFIED'].includes(h.status)) throw problem(409, 'PHM-409-RX-STATE', 'Telaah hanya sebelum obat diserahkan');
      const result = Object.values(b.items).every((x) => x.ok) ? 'OK' : 'PROBLEM';
      const checklist = { items: Object.fromEntries(Object.entries(b.items).map(([k, x]) => [k, { ok: x.ok, note: x.note || null }])), result };
      await tx.execute(sql`update prescription set review_checklist = ${JSON.stringify(checklist)}::jsonb, reviewed_by = ${ctx().userId},
                             reviewed_at = now(), status = ${result === 'OK' ? 'VERIFIED' : 'ISSUED'}, version = version + 1, updated_by = ${ctx().userId}
                            where id = ${id}`);
      await audit(tx, 'PRESCRIPTION_REVIEWED', 'prescription', id, h.patient_id, {
        prescriptionNo: h.prescription_no, result, problems: Object.entries(b.items).filter(([, x]) => !x.ok).map(([k]) => k) });
      return this.view(tx, await rxHead(tx, id));
    });
  }

  @RequirePermission('pharmacy.dispense') @BodySchema(DispenseBody) @Post('prescriptions/:id/dispense') @HttpCode(201)
  async dispense(@Param('id') id: string, @Body() b: z.infer<typeof DispenseBody>, @Headers('if-match') ifMatch: string | undefined,
                 @Headers('idempotency-key') key: string | undefined) {
    assertId(id, ...RX_NOT_FOUND);
    const v = ifMatchVersion(ifMatch, 'resep');
    return this.db.withTenantTx((tx) => idempotent(tx, 'pharmacy.dispense', key, { id, b }, async () => {
      const h = await rxHead(tx, id, true);
      assertVersion(h.version, v, 'Resep');
      if (h.status === 'ISSUED') throw problem(409, 'PHM-409-NOT-REVIEWED', 'Telaah resep belum selesai atau masih ada masalah');
      if (!['VERIFIED', 'PARTIALLY_DISPENSED'].includes(h.status)) throw problem(409, 'PHM-409-RX-STATE', 'Resep sudah selesai diserahkan atau ditutup');
      if (h.encounter_status === 'CANCELLED') throw problem(409, 'PHM-409-ENCOUNTER', 'Kunjungan dibatalkan');
      if (h.first_dispensed_at && Date.parse(h.first_dispensed_at) + h.pickup_days * 86_400_000 < Date.now()) {
        throw problem(409, 'PHM-409-PICKUP-EXPIRED', `Batas pengambilan sisa resep (${h.pickup_days} hari) sudah lewat; tutup sisa resep`);
      }
      const loc = await dispenseLocation(tx, h.branch_id, b.locationId);
      const { items, comps } = await rxItems(tx, id, true);
      const byId = new Map(items.map((i) => [i.id, i]));
      const held = new Set((await rows<{ id: string }>(tx, sql`
        select s.prescription_item_id as id from prescription_substitution s join prescription_item i on i.id = s.prescription_item_id
         where i.prescription_id = ${id} and s.status = 'REQUESTED'`)).map((x) => x.id));
      const errors: { field: string; message: string }[] = [];
      const seen = new Set<string>();
      type Alloc = { item: ItemRow; itemQty: number; drugItemId: string; batchId: string; qty: number; price: { id: string; sellPrice: string }; reason: string | null };
      const allocs: Alloc[] = [];
      await lockStock(tx, loc.id, b.lines.flatMap((l) => {
        const it = byId.get(l.prescriptionItemId);
        return it ? needsOf(it, comps, Number(it.qty)).map((x) => x.drugItemId) : [];
      }));
      for (const [n, l] of b.lines.entries()) {
        const it = byId.get(l.prescriptionItemId);
        if (!it) { errors.push({ field: `lines.${n}.prescriptionItemId`, message: 'Baris resep tidak ditemukan' }); continue; }
        if (seen.has(it.id)) { errors.push({ field: `lines.${n}.prescriptionItemId`, message: 'Baris resep ganda' }); continue; }
        seen.add(it.id);
        if (held.has(it.id)) { errors.push({ field: `lines.${n}.prescriptionItemId`, message: 'Baris ini menunggu persetujuan substitusi dokter' }); continue; }
        const rem = remainingOf(it);
        if (rem <= 0) { errors.push({ field: `lines.${n}.qty`, message: 'Baris ini sudah selesai' }); continue; }
        if (round4(l.qty) > rem) { errors.push({ field: `lines.${n}.qty`, message: `Melebihi sisa resep (${rem} ${it.uom_name})` }); continue; }
        if (it.is_compound && round4(l.qty) !== rem) { errors.push({ field: `lines.${n}.qty`, message: 'Racikan diserahkan utuh sesuai sisa resep' }); continue; }
        if (it.is_compound && l.batches) { errors.push({ field: `lines.${n}.batches`, message: 'Batch racikan dipilih otomatis' }); continue; }
        for (const need of needsOf(it, comps, l.qty)) {
          if (RESTRICTED.includes(need.drugClass)) assertRestrictedAllowed(need.drugClass, need.name);
          const price = await currentPrice(tx, need.drugItemId, h.branch_id, h.payer_type, h.today);
          if (!price) { errors.push({ field: `lines.${n}.prescriptionItemId`, message: `${need.name} belum memiliki harga jual berlaku` }); continue; }
          const avail = await batchesFor(tx, need.drugItemId, loc.id, h.today, h.method);
          let pick: { batchId: string; qty: number }[] | null;
          if (l.batches) {
            if (!l.batchReason) { errors.push({ field: `lines.${n}.batchReason`, message: 'Alasan memilih batch di luar urutan wajib diisi' }); continue; }
            const total = round4(l.batches.reduce((t, x) => t + x.qty, 0));
            if (total !== round4(l.qty)) { errors.push({ field: `lines.${n}.batches`, message: 'Jumlah per batch harus sama dengan jumlah diserahkan' }); continue; }
            const bad = l.batches.find((x) => Number(avail.find((a) => a.batch_id === x.batchId)?.qty_on_hand ?? 0) < x.qty);
            if (bad) { errors.push({ field: `lines.${n}.batches`, message: 'Batch tidak tersedia, kedaluwarsa, atau stoknya kurang' }); continue; }
            pick = l.batches.map((x) => ({ batchId: x.batchId, qty: round4(x.qty) }));
          } else {
            pick = allocate(avail, need.qtyBase);
            if (!pick) {
              const have = round4(avail.reduce((t, a) => t + Number(a.qty_on_hand), 0));
              errors.push({ field: `lines.${n}.qty`, message: `Stok ${need.name} di ${loc.name} tidak cukup (tersedia ${have}); serahkan sebagian` });
              continue;
            }
          }
          for (const p of pick) allocs.push({ item: it, itemQty: round4(l.qty), drugItemId: need.drugItemId, batchId: p.batchId, qty: p.qty, price, reason: l.batches ? l.batchReason! : null });
        }
      }
      if (errors.length) throw problemWith(422, 'PHM-422-DISPENSE', 'Penyerahan tidak dapat diproses', { errors });
      const [pharm] = await rows<{ practitioner_id: string | null }>(tx, sql`select practitioner_id from app_user where id = ${ctx().userId}`);
      const [{ id: dispenseId }] = await rows<{ id: string }>(tx, sql`
        insert into dispense(tenant_id, prescription_id, location_id, dispensed_by, handed_to, notes, pharmacist_id)
        values (app.current_tenant_id(), ${id}, ${loc.id}, ${ctx().userId}, ${b.handedTo ?? null}, ${b.notes ?? null}, ${pharm?.practitioner_id ?? null})
        returning id`);
      for (const a of allocs) {
        await tx.execute(sql`
          insert into dispense_line(tenant_id, dispense_id, prescription_item_id, batch_id, qty_base, drug_item_id, unit_price, drug_price_id,
                                    batch_override_reason, item_qty)
          values (app.current_tenant_id(), ${dispenseId}, ${a.item.id}, ${a.batchId}, ${a.qty}, ${a.drugItemId}, ${a.price.sellPrice}::numeric,
                  ${a.price.id}, ${a.reason}, ${a.itemQty})`);
        await tx.execute(sql`
          insert into stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id, actor_id)
          values (app.current_tenant_id(), ${a.batchId}, ${loc.id}, 'DISPENSE', ${-a.qty}, 'dispense', ${dispenseId}, ${ctx().userId})`);
      }
      for (const l of b.lines) {
        await tx.execute(sql`update prescription_item set qty_dispensed = qty_dispensed + ${round4(l.qty)} where id = ${l.prescriptionItemId}`);
      }
      const s = await settle(tx, h);
      await audit(tx, 'MEDICATION_DISPENSED', 'dispense', dispenseId, h.patient_id, {
        prescriptionNo: h.prescription_no, lines: b.lines.length, batches: allocs.length, status: s.status, encounterStatus: s.encounterStatus,
        manualBatch: allocs.some((a) => a.reason) });
      return { dispenseId, prescriptionStatus: s.status, encounterStatus: s.encounterStatus, ...(await this.dispenseOf(tx, dispenseId)) };
    }));
  }

  /** Tutup sisa resep (tidak ditebus / tidak diambil, OD-104). Sisa yang ditutup tidak ditagih. */
  @RequirePermission('pharmacy.dispense') @BodySchema(CloseBody) @Post('prescriptions/:id/close') @HttpCode(200)
  async close(@Param('id') id: string, @Body() b: z.infer<typeof CloseBody>, @Headers('if-match') ifMatch: string | undefined) {
    assertId(id, ...RX_NOT_FOUND);
    const v = ifMatchVersion(ifMatch, 'resep');
    return this.db.withTenantTx(async (tx) => {
      const h = await rxHead(tx, id, true);
      assertVersion(h.version, v, 'Resep');
      if (!['ISSUED', 'VERIFIED', 'PARTIALLY_DISPENSED'].includes(h.status)) throw problem(409, 'PHM-409-RX-STATE', 'Resep sudah selesai atau ditutup');
      const { items } = await rxItems(tx, id, true);
      const target = items.filter((i) => remainingOf(i) > 0 && (!b.itemIds || b.itemIds.includes(i.id)));
      if (b.itemIds && b.itemIds.some((x) => !items.find((i) => i.id === x))) throw problem(400, 'PHM-400-ITEM', 'Baris resep tidak ditemukan');
      if (!target.length) throw problem(409, 'PHM-409-NOTHING-OPEN', 'Tidak ada sisa resep yang terbuka');
      for (const i of target) {
        await tx.execute(sql`update prescription_item set qty_closed = qty_closed + ${remainingOf(i)}, close_reason = ${b.reason} where id = ${i.id}`);
      }
      const s = await settle(tx, h, b.reason);
      await audit(tx, 'PRESCRIPTION_REMAINDER_CLOSED', 'prescription', id, h.patient_id,
        { prescriptionNo: h.prescription_no, lines: target.map((i) => i.line_no), reason: b.reason, status: s.status });
      return this.view(tx, await rxHead(tx, id));
    });
  }

  /** Etiket obat OD-102: PDF 80 × 50 mm, satu label per baris resep pada penyerahan ini. */
  @RequirePermission('pharmacy.dispense') @Get('dispenses/:id/labels')
  async labels(@Param('id') id: string, @Res() res: Response) {
    assertId(id, 'PHM-404-DISPENSE', 'Penyerahan tidak ditemukan');
    const pdf = await this.db.withTenantTx(async (tx) => {
      const [d] = await rows<{ prescription_id: string; dispensed_at: string }>(tx, sql`select prescription_id, dispensed_at from dispense where id = ${id}`);
      if (!d) throw problem(404, 'PHM-404-DISPENSE', 'Penyerahan tidak ditemukan');
      const h = await rxHead(tx, d.prescription_id);
      const [t] = await rows<{ name: string }>(tx, sql`select coalesce(nullif(letterhead->>'name', ''), display_name) as name from tenant where id = app.current_tenant_id()`);
      const lines = await rows<{ prescription_item_id: string; item_qty: string; sum_base: string }>(tx, sql`
        select prescription_item_id, max(item_qty)::text as item_qty, sum(qty_base)::text as sum_base from dispense_line where dispense_id = ${id}
         group by prescription_item_id`);
      const { items } = await rxItems(tx, d.prescription_id);
      const date = new Intl.DateTimeFormat('id-ID', { timeZone: h.timezone, day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(d.dispensed_at));
      const labels = items.filter((i) => lines.some((l) => l.prescription_item_id === i.id)).map((i, n, arr) => {
        const l = lines.find((x) => x.prescription_item_id === i.id)!;
        const qty = i.is_compound ? Number(l.item_qty) : Number(l.sum_base);
        const name = i.is_compound ? `${i.compound_name} (${i.compound_form})` : `${i.drug_name}${i.strength ? ` ${i.strength}` : ''}`;
        const how = [i.frequency, i.dose ? `@ ${i.dose}` : null, ROUTE_LABEL[i.route] || null].filter(Boolean).join(' · ');
        return [
          { text: t.name, bold: true, fontSize: 8 },
          { text: `${h.patient_name}  ·  RM ${h.mrn}`, fontSize: 8, margin: [0, 1, 0, 0] },
          { text: `${date}  ·  ${h.prescription_no}`, fontSize: 6.5, color: '#444444' },
          { canvas: [{ type: 'line', x1: 0, y1: 2, x2: 207, y2: 2, lineWidth: 0.5 }] },
          { text: name, bold: true, fontSize: 9, margin: [0, 3, 0, 0] },
          { text: how, fontSize: 9, margin: [0, 1, 0, 0] },
          i.instructions ? { text: i.instructions, fontSize: 7.5, italics: true } : '',
          { text: `Jumlah: ${qty} ${i.uom_name}`, fontSize: 7.5, margin: [0, 2, 0, 0], ...(n < arr.length - 1 ? { pageBreak: 'after' } : {}) },
        ];
      });
      if (!labels.length) throw problem(404, 'PHM-404-DISPENSE', 'Penyerahan tidak ditemukan');
      await audit(tx, 'MEDICATION_LABEL_PRINTED', 'dispense', id, h.patient_id, { prescriptionNo: h.prescription_no, labels: labels.length });
      return renderPdf(labels.flat(), { title: `Etiket ${h.prescription_no}`, issuedAt: new Date(d.dispensed_at),
        pageSize: { width: 226.77, height: 141.73 }, pageMargins: [8, 6, 8, 6] });
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="etiket-${id.slice(0, 8)}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(pdf);
  }

  private async dispenseOf(tx: Tx, dispenseId: string) {
    const lines = await rows<{ id: string; prescription_item_id: string; drug_item_id: string; drug_name: string; batch_no: string; expiry_date: string;
                               qty_base: string; unit_price: string; uom_name: string; reason: string | null; billing_status: string }>(tx, sql`
      select l.id, l.prescription_item_id, l.drug_item_id, d.generic_name as drug_name, sb.batch_no, to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date,
             trim_scale(l.qty_base)::text as qty_base, l.unit_price::text, u.name as uom_name, l.batch_override_reason as reason, l.billing_status
        from dispense_line l join drug_item d on d.id = l.drug_item_id join uom u on u.id = d.base_uom_id join stock_batch sb on sb.id = l.batch_id
        join prescription_item pi on pi.id = l.prescription_item_id
       where l.dispense_id = ${dispenseId} order by pi.line_no, lower(d.generic_name), sb.expiry_date, l.id`);
    return {
      lines: lines.map((l) => ({ id: l.id, prescriptionItemId: l.prescription_item_id, drugItemId: l.drug_item_id, drugName: l.drug_name, batchNo: l.batch_no,
        expiryDate: l.expiry_date, qtyBase: Number(l.qty_base), uomName: l.uom_name, unitPrice: l.unit_price,
        amount: (Math.round(Number(l.qty_base) * Number(l.unit_price) * 100) / 100).toFixed(2), batchReason: l.reason, billingStatus: l.billing_status })),
    };
  }

  private async view(tx: Tx, h: RxHead, locationId?: string) {
    const { items, comps } = await rxItems(tx, h.id);
    const open = ['VERIFIED', 'ISSUED', 'PARTIALLY_DISPENSED'].includes(h.status);
    const loc = open ? await dispenseLocation(tx, h.branch_id, locationId).catch(() => null) : null;
    const plan = async (drugItemId: string, need: number) => {
      const [price, avail] = await Promise.all([
        currentPrice(tx, drugItemId, h.branch_id, h.payer_type, h.today),
        loc ? batchesFor(tx, drugItemId, loc.id, h.today, h.method) : Promise.resolve([]),
      ]);
      const available = round4(avail.reduce((t, a) => t + Number(a.qty_on_hand), 0));
      return { unitPrice: price?.sellPrice ?? null, available, allocation: allocate(avail, Math.min(need, available)) ?? [],
        batches: avail.map((a) => ({ batchId: a.batch_id, batchNo: a.batch_no, expiryDate: a.expiry_date, qtyOnHand: Number(a.qty_on_hand) })) };
    };
    const subs = await rows<{ prescription_item_id: string; id: string; status: string; to_name: string; reason: string; decision_note: string | null;
                              requested_at: string; decider: string | null }>(tx, sql`
      select distinct on (s.prescription_item_id) s.prescription_item_id, s.id, s.status, d.generic_name as to_name, s.reason, s.decision_note,
             s.requested_at, pr.full_name as decider
        from prescription_substitution s join prescription_item i on i.id = s.prescription_item_id join drug_item d on d.id = s.to_drug_id
        left join practitioner pr on pr.id = s.decided_by_practitioner
       where i.prescription_id = ${h.id} order by s.prescription_item_id, s.requested_at desc`);
    const original = new Map((await rows<{ id: string; name: string }>(tx, sql`
      select i.id, d.generic_name as name from prescription_item i join drug_item d on d.id = i.substituted_from_drug_id
       where i.prescription_id = ${h.id}`)).map((x) => [x.id, x.name]));
    const outItems = [];
    for (const i of items) {
      const remaining = remainingOf(i);
      const needs = needsOf(i, comps, remaining || Number(i.qty));
      const stock = [];
      for (const n of needs) stock.push({ drugItemId: n.drugItemId, drugName: n.name, drugClass: n.drugClass, restricted: RESTRICTED.includes(n.drugClass),
        need: remaining ? n.qtyBase : 0, ...(open && remaining ? await plan(n.drugItemId, n.qtyBase) : { unitPrice: null, available: null, allocation: [], batches: [] }) });
      outItems.push({
        id: i.id, lineNo: i.line_no, kind: i.is_compound ? 'COMPOUND' : 'DRUG', drugItemId: i.drug_item_id, drugName: i.drug_name, strength: i.strength,
        dosageForm: i.dosage_form, compoundName: i.compound_name, compoundForm: i.compound_form, dose: i.dose, frequency: i.frequency, route: i.route,
        durationDays: i.duration_days, qty: Number(i.qty), uomName: i.uom_name, instructions: i.instructions, qtyDispensed: Number(i.qty_dispensed),
        qtyClosed: Number(i.qty_closed), closeReason: i.close_reason, remaining, substitutedFromName: original.get(i.id) ?? null,
        substitution: ((x) => (x ? { id: x.id, status: x.status, toDrugName: x.to_name, reason: x.reason, decisionNote: x.decision_note,
          requestedAt: x.requested_at, decidedByName: x.decider } : null))(subs.find((x) => x.prescription_item_id === i.id)),
        components: comps.filter((c) => c.prescription_item_id === i.id).map((c) => ({ drugItemId: c.drug_item_id, drugName: c.drug_name, qty: Number(c.qty), uomName: c.uom_name })),
        stock,
      });
    }
    const allergies = await rows<{ substance: string; reaction: string | null; severity: string | null }>(tx, sql`
      select substance, reaction, severity from allergy_intolerance where patient_id = ${h.patient_id} and status = 'ACTIVE' order by substance`);
    const dispenses = await rows<{ id: string; dispensed_at: string; by_name: string; location_name: string; handed_to: string | null }>(tx, sql`
      select d.id, d.dispensed_at, u.full_name as by_name, l.name as location_name, d.handed_to
        from dispense d join app_user u on u.id = d.dispensed_by join stock_location l on l.id = d.location_id
       where d.prescription_id = ${h.id} order by d.dispensed_at, d.id`);
    const history = await rows<{ dispensed_at: string; prescription_no: string; drug_name: string; qty: string; uom_name: string }>(tx, sql`
      select max(d.dispensed_at) as dispensed_at, p.prescription_no, dg.generic_name as drug_name, trim_scale(sum(l.qty_base))::text as qty, u.name as uom_name
        from dispense_line l join dispense d on d.id = l.dispense_id join prescription p on p.id = d.prescription_id join encounter e on e.id = p.encounter_id
        join drug_item dg on dg.id = l.drug_item_id join uom u on u.id = dg.base_uom_id
       where e.patient_id = ${h.patient_id} and p.id <> ${h.id} and d.dispensed_at > now() - interval '90 days'
       group by p.prescription_no, dg.generic_name, u.name order by 1 desc limit 30`);
    const deadline = h.status === 'PARTIALLY_DISPENSED' && h.first_dispensed_at
      ? new Date(Date.parse(h.first_dispensed_at) + h.pickup_days * 86_400_000).toISOString() : null;
    return {
      id: h.id, prescriptionNo: h.prescription_no, status: h.status, version: h.version, issuedAt: h.issued_at, firstDispensedAt: h.first_dispensed_at,
      pickupDeadline: deadline, closedReason: h.closed_reason, notes: h.notes, alerts: h.alerts, dispenseMethod: h.method,
      encounter: { id: h.encounter_id, encounterNo: h.encounter_no, status: h.encounter_status, payerType: h.payer_type, branchId: h.branch_id, branchName: h.branch_name },
      patient: { id: h.patient_id, name: h.patient_name, mrn: h.mrn, birthDate: h.birth_date, sex: h.sex,
        allergies: allergies.map((a) => ({ substance: a.substance, reaction: a.reaction, severity: a.severity })) },
      prescriber: { name: h.prescriber_name, sipNumber: h.sip_number },
      review: h.review_checklist ? { ...h.review_checklist, reviewedAt: h.reviewed_at, reviewerName: h.reviewer_name } : null,
      checklist: CHECKLIST,
      location: loc,
      items: outItems,
      dispenses: await Promise.all(dispenses.map(async (d) => ({ id: d.id, dispensedAt: d.dispensed_at, dispensedByName: d.by_name, locationName: d.location_name,
        handedTo: d.handed_to, ...(await this.dispenseOf(tx, d.id)) }))),
      medicationHistory: history.map((x) => ({ dispensedAt: x.dispensed_at, prescriptionNo: x.prescription_no, drugName: x.drug_name, qty: Number(x.qty), uomName: x.uom_name })),
    };
  }
}
