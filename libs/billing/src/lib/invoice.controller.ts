import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { BodySchema, NoBody, RequirePermission, Uuid, assertId, assertVersion, ctx, ifMatchVersion, optText, problem } from '@clinicrme/shared';
import { renderPdf } from '@clinicrme/shared/pdf';
import { Db, type Tx, audit, rows } from '@clinicrme/db';
import { type PaymentRow, createReceivable, paymentDto, settleInvoice } from './payment.repo';
import { INV_NOT_FOUND, type InvoiceHead, type LineIn, currentLines, invoiceHead, pricingContext, rebuildDraft, resolveTariff, writeLines } from './invoice.repo';

const Money = z.number().min(0).max(1_000_000_000).transform((n) => Math.round(n * 100) / 100);
const AddLine = z.object({ serviceItemId: Uuid, qty: z.number().positive().max(10_000).default(1) }).strict();
const UpdateLine = z.object({
  qty: z.number().positive().max(10_000).optional(),
  serviceItemId: Uuid.optional(),
  discountAmount: Money.optional(),
  discountReason: optText(300),
  payerPortion: Money.nullable().optional(),
  splitReason: optText(300),
}).strict();
const DiscountDecision = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: optText(300) }).strict();
const WorklistQuery = z.object({ branchId: Uuid.optional() });
const ListQuery = z.object({ branchId: Uuid.optional(), status: z.enum(['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID']).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), discountPending: z.enum(['true', 'false']).optional() });
const SOURCE_LABEL: Record<string, string> = { KONSULTASI: 'Konsultasi', TINDAKAN: 'Tindakan', OBAT: 'Obat', LAB: 'Laboratorium', ADMINISTRASI: 'Administrasi', LAINNYA: 'Lainnya' };
const rp = (v: string | number) => `Rp ${Number(v).toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/**
 * Tagihan kasir (BIL-FR-001–004; OD-041, OD-105–108, OD-110, OD-113 / DEC-042). Draf dibangun otomatis dari sumber dengan
 * harga snapshot; kasir dapat mengganti layanan konsultasi, menambah layanan, memberi diskon (di atas batas klinik perlu
 * persetujuan orang lain), dan mengubah pembagian penjamin/pasien dengan alasan. Setelah terbit, tagihan & barisnya
 * tidak dapat diubah (trigger DB) — koreksi lewat void (batch 3).
 */
@Controller('api/v1')
export class InvoiceController {
  constructor(private readonly db: Db) {}

  /** Worklist kasir: kunjungan di kasir, obat susulan yang belum ditagih (OD-107), penjualan bebas menunggu bayar (OD-113). */
  @RequirePermission('billing.invoice.read') @Get('billing/worklist')
  async worklist(@Query() query: Record<string, string | undefined>) {
    const P = WorklistQuery.safeParse(query);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const b = P.data.branchId ?? null;
    return this.db.withTenantTx(async (tx) => {
      const r = await rows<{ type: string; ref_id: string; ref_no: string; status: string; at: string; patient_name: string | null; mrn: string | null;
                             customer_name: string | null; payer_type: string; payer_name: string | null; unit_name: string | null; invoice_id: string | null;
                             invoice_status: string | null; invoice_no: string | null; net_amount: string | null; patient_portion: string | null }>(tx, sql`
        with enc as (
          select e.id, 'ENCOUNTER'::text as type, e.encounter_no as ref_no, e.status, coalesce(e.consult_ended_at, e.arrived_at) as at, e.patient_id,
                 e.payer_type, e.coverage_id, e.unit_id, e.branch_id
            from encounter e where e.status = 'BILLING' and (${b}::uuid is null or e.branch_id = ${b}::uuid)
          union all
          select e.id, 'DRUG', e.encounter_no, e.status,
                 coalesce((select max(ds.dispensed_at) from prescription p join dispense ds on ds.prescription_id = p.id where p.encounter_id = e.id), e.arrived_at),
                 e.patient_id, e.payer_type, e.coverage_id, e.unit_id, e.branch_id
            from encounter e
           where e.status not in ('BILLING', 'CANCELLED') and (${b}::uuid is null or e.branch_id = ${b}::uuid)
             and exists (select 1 from invoice i where i.encounter_id = e.id and i.kind = 'ENCOUNTER' and i.status <> 'VOID')
             -- obat diserahkan belum ditagih, atau tagihan obat susulan terbit yang belum lunas (batch 2)
             and (exists (select 1 from prescription p join dispense ds on ds.prescription_id = p.id join dispense_line dl on dl.dispense_id = ds.id
                           where p.encounter_id = e.id and dl.billing_status = 'UNBILLED')
                  or exists (select 1 from invoice i where i.encounter_id = e.id and i.kind = 'DRUG' and i.status in ('ISSUED', 'PARTIALLY_PAID'))))
        select x.type, x.id as ref_id, x.ref_no, x.status, x.at, pt.full_name as patient_name, pt.mrn, null::text as customer_name, x.payer_type,
               py.name as payer_name, su.name as unit_name, i.id as invoice_id, i.status as invoice_status, i.invoice_no, i.net_amount::text, i.patient_portion::text
          from enc x join patient pt on pt.id = x.patient_id join service_unit su on su.id = x.unit_id
          left join patient_coverage pc on pc.id = x.coverage_id left join payer py on py.id = pc.payer_id
          left join lateral (select * from invoice i where i.encounter_id = x.id and i.status <> 'VOID'
                               and i.kind = case x.type when 'DRUG' then 'DRUG' else 'ENCOUNTER' end
                               and (x.type <> 'DRUG' or i.status in ('DRAFT', 'ISSUED', 'PARTIALLY_PAID')) order by i.created_at desc limit 1) i on true
        union all
        select 'OTC', o.id, o.sale_no, o.status, o.sold_at, pt.full_name, pt.mrn, o.customer_name, 'UMUM', null, null, i.id, i.status, i.invoice_no,
               i.net_amount::text, i.patient_portion::text
          from otc_sale o left join patient pt on pt.id = o.patient_id
          left join invoice i on i.otc_sale_id = o.id and i.status <> 'VOID'
         where o.status = 'AWAITING_PAYMENT' and (${b}::uuid is null or o.branch_id = ${b}::uuid)
         order by 5 limit 300`);
      return r.map((x) => ({
        type: x.type, refId: x.ref_id, refNo: x.ref_no, refStatus: x.status, at: x.at,
        patient: x.patient_name ? { name: x.patient_name, mrn: x.mrn } : null, customerName: x.customer_name,
        payerType: x.payer_type, payerName: x.payer_name, unitName: x.unit_name,
        invoice: x.invoice_id ? { id: x.invoice_id, status: x.invoice_status, invoiceNo: x.invoice_no, netAmount: x.net_amount, patientPortion: x.patient_portion } : null,
      }));
    });
  }

  @RequirePermission('billing.invoice.read') @Get('invoices')
  async list(@Query() query: Record<string, string | undefined>) {
    const P = ListQuery.safeParse(query);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const f = P.data;
    return this.db.withTenantTx(async (tx) => {
      const r = await rows<{ id: string }>(tx, sql`
        select i.id from invoice i join branch br on br.id = i.branch_id
         where (${f.branchId ?? null}::uuid is null or i.branch_id = ${f.branchId ?? null}::uuid)
           and (${f.status ?? null}::text is null or i.status = ${f.status ?? null}::text)
           and (${f.discountPending === 'true'} = false or exists (select 1 from invoice_line l where l.invoice_id = i.id and l.discount_status = 'PENDING'))
           and (${f.date ?? null}::date is null or (i.created_at at time zone br.timezone)::date = ${f.date ?? null}::date)
         order by i.created_at desc limit 200`);
      const out = [];
      for (const x of r) out.push(await this.view(tx, x.id));
      return out;
    });
  }

  /** Buat / bangun ulang draf tagihan kunjungan: tagihan jasa bila belum ada, selain itu tagihan obat susulan (OD-107). */
  @RequirePermission('billing.invoice.issue') @NoBody() @Post('billing/encounters/:id/invoice') @HttpCode(200)
  async forEncounter(@Param('id') id: string) {
    assertId(id, 'SCH-404-ENCOUNTER', 'Kunjungan tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      const [e] = await rows<{ status: string; branch_id: string; patient_id: string; payer_type: string; coverage_id: string | null; payer_id: string | null;
                               has_main: boolean }>(tx, sql`
        select e.status, e.branch_id, e.patient_id, e.payer_type, e.coverage_id, pc.payer_id,
               exists (select 1 from invoice i where i.encounter_id = e.id and i.kind = 'ENCOUNTER' and i.status <> 'VOID') as has_main
          from encounter e left join patient_coverage pc on pc.id = e.coverage_id where e.id = ${id} for update of e`);
      if (!e) throw problem(404, 'SCH-404-ENCOUNTER', 'Kunjungan tidak ditemukan');
      if (e.status === 'CANCELLED') throw problem(409, 'BIL-409-ENCOUNTER', 'Kunjungan dibatalkan');
      let [draft] = await rows<{ id: string; kind: string }>(tx, sql`select id, kind from invoice where encounter_id = ${id} and status = 'DRAFT' for update`);
      const kind = draft?.kind ?? (e.has_main ? 'DRUG' : 'ENCOUNTER');
      if (kind === 'ENCOUNTER' && e.status !== 'BILLING') throw problem(409, 'BIL-409-NOT-AT-CASHIER', 'Kunjungan belum diteruskan ke kasir');
      if (kind === 'DRUG') {
        const [u] = await rows(tx, sql`select 1 from dispense_line dl join dispense ds on ds.id = dl.dispense_id join prescription p on p.id = ds.prescription_id
                                        where p.encounter_id = ${id} and dl.billing_status = 'UNBILLED' limit 1`);
        if (!u && !draft) throw problem(409, 'BIL-409-NOTHING', 'Tagihan kunjungan sudah ada dan tidak ada obat yang belum ditagih');
      }
      if (!draft) {
        [draft] = await rows<{ id: string; kind: string }>(tx, sql`
          insert into invoice(tenant_id, branch_id, patient_id, encounter_id, kind, payer_type, coverage_id, payer_id, updated_by)
          values (app.current_tenant_id(), ${e.branch_id}, ${e.patient_id}, ${id}, ${kind}, ${e.payer_type}, ${e.coverage_id}, ${e.payer_id}, ${ctx().userId})
          returning id, kind`);
      }
      await rebuildDraft(tx, await invoiceHead(tx, draft.id, true));
      await audit(tx, 'INVOICE_DRAFTED', 'invoice', draft.id, e.patient_id, { encounterId: id, kind });
      return this.view(tx, draft.id);
    });
  }

  @RequirePermission('billing.invoice.issue') @NoBody() @Post('billing/otc-sales/:id/invoice') @HttpCode(200)
  async forOtc(@Param('id') id: string) {
    assertId(id, 'PHM-404-OTC', 'Penjualan tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      const [o] = await rows<{ status: string; branch_id: string; patient_id: string | null; customer_name: string | null }>(tx, sql`
        select status, branch_id, patient_id, customer_name from otc_sale where id = ${id} for update`);
      if (!o) throw problem(404, 'PHM-404-OTC', 'Penjualan tidak ditemukan');
      if (o.status !== 'AWAITING_PAYMENT') throw problem(409, 'BIL-409-OTC-STATE', 'Penjualan tidak menunggu pembayaran');
      let [inv] = await rows<{ id: string; status: string }>(tx, sql`select id, status from invoice where otc_sale_id = ${id} and status <> 'VOID'`);
      if (inv && inv.status !== 'DRAFT') return this.view(tx, inv.id);
      if (!inv) {
        [inv] = await rows<{ id: string; status: string }>(tx, sql`
          insert into invoice(tenant_id, branch_id, patient_id, otc_sale_id, kind, payer_type, customer_name, updated_by)
          values (app.current_tenant_id(), ${o.branch_id}, ${o.patient_id}, ${id}, 'OTC', 'UMUM', ${o.customer_name}, ${ctx().userId}) returning id, status`);
      }
      await rebuildDraft(tx, await invoiceHead(tx, inv.id, true));
      await audit(tx, 'INVOICE_DRAFTED', 'invoice', inv.id, o.patient_id, { otcSaleId: id, kind: 'OTC' });
      return this.view(tx, inv.id);
    });
  }

  @RequirePermission('billing.invoice.read') @Get('invoices/:id')
  async get(@Param('id') id: string) {
    assertId(id, ...INV_NOT_FOUND);
    return this.db.withTenantTx((tx) => this.view(tx, id));
  }

  /** Tambah layanan ke draf (harga dari tarif berlaku, OD-106). */
  @RequirePermission('billing.invoice.issue') @BodySchema(AddLine) @Post('invoices/:id/lines') @HttpCode(201)
  async addLine(@Param('id') id: string, @Body() b: z.infer<typeof AddLine>, @Headers('if-match') ifMatch: string | undefined) {
    assertId(id, ...INV_NOT_FOUND);
    const v = ifMatchVersion(ifMatch, 'tagihan');
    return this.db.withTenantTx(async (tx) => {
      const h = await this.draft(tx, id, v);
      if (h.kind === 'OTC') throw problem(409, 'BIL-409-OTC-LINES', 'Tagihan penjualan bebas hanya berisi obat yang dijual');
      const c = await pricingContext(tx, h);
      const [s] = await rows<{ name: string; service_type: string; is_active: boolean }>(tx, sql`select name, service_type, is_active from service_item where id = ${b.serviceItemId}`);
      if (!s?.is_active) throw problem(400, 'BIL-400-SERVICE', 'Layanan tidak ditemukan atau tidak aktif');
      const t = await resolveTariff(tx, b.serviceItemId, c.branchId, c.payerId, c.payerType, c.onDate);
      if (!t) throw problem(422, 'BIL-422-TARIFF', `Layanan "${s.name}" belum punya tarif berlaku untuk penjamin ini`);
      const lines: LineIn[] = await currentLines(tx, id);
      const type = (['KONSULTASI', 'TINDAKAN', 'LAB', 'ADMINISTRASI'].includes(s.service_type) ? s.service_type : 'LAINNYA') as LineIn['sourceType'];
      lines.push({ sourceType: type, sourceId: null, description: s.name, qty: b.qty, unitPrice: t.price, serviceItemId: b.serviceItemId, tariffId: t.id, drugItemId: null,
        isManual: true, discountAmount: 0, discountReason: null, discountRequestedBy: null, discountApprovedBy: null, discountStatus: 'NONE', payerOverride: null, splitReason: null });
      await writeLines(tx, c, lines);
      await audit(tx, 'INVOICE_LINE_ADDED', 'invoice', id, h.patient_id, { service: s.name, qty: b.qty, price: t.price });
      return this.view(tx, id);
    });
  }

  /** Ubah baris draf: jumlah (baris manual), layanan (konsultasi/manual), diskon beralasan, pembagian penjamin beralasan. */
  @RequirePermission('billing.invoice.issue') @BodySchema(UpdateLine) @Put('invoices/:id/lines/:lineId')
  async updateLine(@Param('id') id: string, @Param('lineId') lineId: string, @Body() b: z.infer<typeof UpdateLine>, @Headers('if-match') ifMatch: string | undefined) {
    assertId(id, ...INV_NOT_FOUND);
    assertId(lineId, 'BIL-404-LINE', 'Baris tagihan tidak ditemukan');
    const v = ifMatchVersion(ifMatch, 'tagihan');
    return this.db.withTenantTx(async (tx) => {
      const h = await this.draft(tx, id, v);
      const c = await pricingContext(tx, h);
      const lines = await currentLines(tx, id);
      const l = lines.find((x) => x.id === lineId);
      if (!l) throw problem(404, 'BIL-404-LINE', 'Baris tagihan tidak ditemukan');
      const changes: Record<string, unknown> = {};
      if (b.qty !== undefined && b.qty !== l.qty) {
        if (!l.isManual) throw problem(409, 'BIL-409-AUTO-LINE', 'Jumlah baris otomatis mengikuti sumbernya (tindakan/obat/lab)');
        l.qty = b.qty; changes.qty = b.qty;
      }
      if (b.serviceItemId && b.serviceItemId !== l.serviceItemId) {
        if (!l.isManual && l.sourceType !== 'KONSULTASI') throw problem(409, 'BIL-409-AUTO-LINE', 'Hanya layanan konsultasi atau baris tambahan yang dapat diganti');
        const [s] = await rows<{ name: string; service_type: string; is_active: boolean }>(tx, sql`select name, service_type, is_active from service_item where id = ${b.serviceItemId}`);
        if (!s?.is_active || (l.sourceType === 'KONSULTASI' && s.service_type !== 'KONSULTASI')) throw problem(400, 'BIL-400-SERVICE', 'Layanan tidak ditemukan, tidak aktif, atau bukan layanan konsultasi');
        const t = await resolveTariff(tx, b.serviceItemId, c.branchId, c.payerId, c.payerType, c.onDate);
        if (!t) throw problem(422, 'BIL-422-TARIFF', `Layanan "${s.name}" belum punya tarif berlaku untuk penjamin ini`);
        Object.assign(l, { serviceItemId: b.serviceItemId, tariffId: t.id, unitPrice: t.price, description: s.name });
        changes.service = s.name;
      }
      const base = Math.round(l.qty * Number(l.unitPrice) * 100) / 100;
      if (b.discountAmount !== undefined) {
        if (!ctx().permissions?.has('billing.invoice.discount')) throw problem(403, 'IAM-403-PERMISSION', 'Tidak berwenang memberi diskon');
        if (b.discountAmount > base) throw problem(400, 'BIL-400-DISCOUNT', 'Diskon melebihi nilai baris');
        if (b.discountAmount > 0 && (b.discountReason ?? '').length < 3) throw problem(400, 'BIL-400-DISCOUNT', 'Alasan diskon wajib diisi');
        const [{ lim }] = await rows<{ lim: number }>(tx, sql`select coalesce((settings->>'discountLimitPercent')::numeric, 10)::float as lim from tenant where id = app.current_tenant_id()`);
        const pct = base > 0 ? (b.discountAmount / base) * 100 : 0;
        Object.assign(l, { discountAmount: b.discountAmount, discountReason: b.discountAmount > 0 ? b.discountReason : null,
          discountRequestedBy: b.discountAmount > 0 ? ctx().userId : null, discountApprovedBy: null,
          discountStatus: b.discountAmount === 0 ? 'NONE' : pct > lim + 1e-9 ? 'PENDING' : 'WITHIN_LIMIT' });
        changes.discount = { amount: b.discountAmount, percent: Math.round(pct * 100) / 100, status: l.discountStatus };
      }
      if (b.payerPortion !== undefined) {
        if (h.payer_type === 'UMUM') throw problem(409, 'BIL-409-SPLIT', 'Tagihan penjamin Umum ditanggung pasien seluruhnya');
        if (b.payerPortion === null) Object.assign(l, { payerOverride: null, splitReason: null });
        else {
          if ((b.splitReason ?? '').length < 3) throw problem(400, 'BIL-400-SPLIT', 'Alasan perubahan pembagian wajib diisi');
          if (b.payerPortion > base - l.discountAmount) throw problem(400, 'BIL-400-SPLIT', 'Porsi penjamin melebihi nilai baris');
          Object.assign(l, { payerOverride: b.payerPortion, splitReason: b.splitReason });
        }
        changes.payerPortion = b.payerPortion;
      }
      if (l.discountAmount > Math.round(l.qty * Number(l.unitPrice) * 100) / 100) throw problem(400, 'BIL-400-DISCOUNT', 'Diskon melebihi nilai baris');
      await writeLines(tx, c, lines);
      await audit(tx, 'INVOICE_LINE_UPDATED', 'invoice', id, h.patient_id, { line: l.lineNo, ...changes });
      return this.view(tx, id);
    });
  }

  @RequirePermission('billing.invoice.issue') @NoBody() @Delete('invoices/:id/lines/:lineId')
  async deleteLine(@Param('id') id: string, @Param('lineId') lineId: string, @Headers('if-match') ifMatch: string | undefined) {
    assertId(id, ...INV_NOT_FOUND);
    assertId(lineId, 'BIL-404-LINE', 'Baris tagihan tidak ditemukan');
    const v = ifMatchVersion(ifMatch, 'tagihan');
    return this.db.withTenantTx(async (tx) => {
      const h = await this.draft(tx, id, v);
      const lines = await currentLines(tx, id);
      const l = lines.find((x) => x.id === lineId);
      if (!l) throw problem(404, 'BIL-404-LINE', 'Baris tagihan tidak ditemukan');
      if (!l.isManual) throw problem(409, 'BIL-409-AUTO-LINE', 'Baris otomatis tidak dapat dihapus; ubah sumbernya (mis. tindakan di rekam medis)');
      await writeLines(tx, await pricingContext(tx, h), lines.filter((x) => x.id !== lineId));
      await audit(tx, 'INVOICE_LINE_REMOVED', 'invoice', id, h.patient_id, { line: l.lineNo, description: l.description });
      return this.view(tx, id);
    });
  }

  /** OD-041: diskon di atas batas klinik disetujui/ditolak pemegang izin persetujuan, bukan yang mengajukan. */
  @RequirePermission('billing.invoice.void.approve') @BodySchema(DiscountDecision) @Post('invoices/:id/lines/:lineId/discount-decision') @HttpCode(200)
  async decideDiscount(@Param('id') id: string, @Param('lineId') lineId: string, @Body() b: z.infer<typeof DiscountDecision>) {
    assertId(id, ...INV_NOT_FOUND);
    assertId(lineId, 'BIL-404-LINE', 'Baris tagihan tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      const h = await invoiceHead(tx, id, true);
      if (h.status !== 'DRAFT') throw problem(409, 'BIL-409-NOT-DRAFT', 'Tagihan sudah diterbitkan');
      const lines = await currentLines(tx, id);
      const l = lines.find((x) => x.id === lineId);
      if (!l) throw problem(404, 'BIL-404-LINE', 'Baris tagihan tidak ditemukan');
      if (l.discountStatus !== 'PENDING') throw problem(409, 'BIL-409-DISCOUNT-STATE', 'Tidak ada diskon yang menunggu persetujuan pada baris ini');
      if (l.discountRequestedBy === ctx().userId) throw problem(403, 'BIL-403-SELF-APPROVAL', 'Diskon harus disetujui orang lain');
      const before = l.discountAmount;
      if (b.decision === 'APPROVE') Object.assign(l, { discountStatus: 'APPROVED', discountApprovedBy: ctx().userId });
      else Object.assign(l, { discountAmount: 0, discountReason: null, discountRequestedBy: null, discountApprovedBy: null, discountStatus: 'NONE' });
      await writeLines(tx, await pricingContext(tx, h), lines);
      await audit(tx, b.decision === 'APPROVE' ? 'INVOICE_DISCOUNT_APPROVED' : 'INVOICE_DISCOUNT_REJECTED', 'invoice', id, h.patient_id,
        { line: l.lineNo, amount: before, note: b.note ?? null });
      return this.view(tx, id);
    });
  }

  @RequirePermission('billing.invoice.issue') @NoBody() @Delete('invoices/:id')
  async deleteDraft(@Param('id') id: string, @Headers('if-match') ifMatch: string | undefined) {
    assertId(id, ...INV_NOT_FOUND);
    const v = ifMatchVersion(ifMatch, 'tagihan');
    return this.db.withTenantTx(async (tx) => {
      const h = await this.draft(tx, id, v);
      await tx.execute(sql`update dispense_line set invoice_line_id = null where invoice_line_id in (select id from invoice_line where invoice_id = ${id})`);
      await tx.execute(sql`delete from invoice_line where invoice_id = ${id}`);
      await tx.execute(sql`delete from invoice where id = ${id}`);
      await audit(tx, 'INVOICE_DRAFT_DELETED', 'invoice', id, h.patient_id, {});
      return { id, deleted: true };
    });
  }

  /** Terbitkan: nomor INV (OD-110), harga terkunci; obat yang ditagih menjadi BILLED. */
  @RequirePermission('billing.invoice.issue') @NoBody() @Post('invoices/:id/issue') @HttpCode(200)
  async issue(@Param('id') id: string, @Headers('if-match') ifMatch: string | undefined) {
    assertId(id, ...INV_NOT_FOUND);
    const v = ifMatchVersion(ifMatch, 'tagihan');
    return this.db.withTenantTx(async (tx) => {
      const h = await this.draft(tx, id, v);
      const [s] = await rows<{ n: number; pending: number; stale: number }>(tx, sql`
        select count(*)::int as n, count(*) filter (where discount_status = 'PENDING')::int as pending,
               (select count(*)::int from dispense_line d join invoice_line l on l.id = d.invoice_line_id where l.invoice_id = ${id} and d.billing_status <> 'UNBILLED') as stale
          from invoice_line where invoice_id = ${id}`);
      if (!s.n) throw problem(409, 'BIL-409-EMPTY', 'Tagihan belum berisi baris');
      if (s.pending) throw problem(409, 'BIL-409-DISCOUNT-PENDING', 'Masih ada diskon yang menunggu persetujuan');
      if (s.stale) throw problem(409, 'BIL-409-STALE', 'Sebagian obat sudah ditagih di tagihan lain; bangun ulang draf');
      if (h.otc_sale_id) {
        const [o] = await rows<{ status: string }>(tx, sql`select status from otc_sale where id = ${h.otc_sale_id}`);
        if (o.status !== 'AWAITING_PAYMENT') throw problem(409, 'BIL-409-OTC-STATE', 'Penjualan tidak menunggu pembayaran');
      }
      const [{ no }] = await rows<{ no: string }>(tx, sql`select app.next_document_number('INVOICE', 'TENANT', 'INV{YYYY}{MM}{SEQ:6}') as no`);
      await tx.execute(sql`update dispense_line set billing_status = 'BILLED'
                            where invoice_line_id in (select id from invoice_line where invoice_id = ${id})`);
      await tx.execute(sql`update invoice set status = 'ISSUED', invoice_no = ${no}, issued_at = now(), issued_by = ${ctx().userId},
                             version = version + 1, updated_by = ${ctx().userId} where id = ${id}`);
      const receivable = await createReceivable(tx, id);
      await audit(tx, 'INVOICE_ISSUED', 'invoice', id, h.patient_id, { invoiceNo: no, kind: h.kind, receivable: receivable?.amount ?? null });
      // Porsi pasien Rp 0 (ditanggung penuh penjamin) → langsung lunas
      await settleInvoice(tx, id);
      return this.view(tx, id);
    });
  }

  /** Rincian tagihan PDF A4 (OD-109). Draf diberi tanda "DRAF". */
  @RequirePermission('billing.invoice.read') @Get('invoices/:id/pdf')
  async pdf(@Param('id') id: string, @Res() res: Response) {
    assertId(id, ...INV_NOT_FOUND);
    const { buf, name } = await this.db.withTenantTx(async (tx) => {
      const d = await this.view(tx, id);
      const [t] = await rows<{ name: string; address: string | null; phone: string | null; license: string | null }>(tx, sql`
        select coalesce(nullif(letterhead->>'name', ''), display_name) as name, letterhead->>'address' as address, letterhead->>'phone' as phone,
               letterhead->>'license' as license from tenant where id = app.current_tenant_id()`);
      const who = d.patient ? `${d.patient.name} · RM ${d.patient.mrn}` : d.customerName ?? 'Pembeli umum';
      const body = [
        { text: t.name, style: 'clinic' },
        { text: [t.address, t.phone ? `Telp. ${t.phone}` : null, t.license ? `Izin ${t.license}` : null].filter(Boolean).join(' · '), style: 'small' },
        { text: d.status === 'DRAFT' ? 'RINCIAN TAGIHAN — DRAF' : 'RINCIAN TAGIHAN', style: 'title' },
        { columns: [
          { text: [{ text: 'Nomor: ', bold: true }, d.invoiceNo ?? '—', '\n', { text: 'Pasien/pembeli: ', bold: true }, who] },
          { text: [{ text: 'Penjamin: ', bold: true }, d.payerName ? `${d.payerName} (${d.payerType})` : d.payerType, '\n', { text: 'Kunjungan: ', bold: true }, d.encounterNo ?? '—'], alignment: 'right' },
        ], margin: [0, 6, 0, 8] },
        { table: { headerRows: 1, widths: ['auto', '*', 'auto', 'auto', 'auto', 'auto'], body: [
          ['#', 'Uraian', 'Jumlah', 'Harga', 'Diskon', 'Subtotal'].map((x) => ({ text: x, bold: true })),
          ...d.lines.map((l) => [String(l.lineNo), `${SOURCE_LABEL[l.sourceType] ?? l.sourceType}: ${l.description}`, String(l.qty), rp(l.unitPrice),
            Number(l.discountAmount) ? rp(l.discountAmount) : '—', rp(l.lineTotal)]),
        ] }, layout: 'lightHorizontalLines' },
        { columns: [{ text: '' }, { width: 'auto', table: { body: [
          ['Total', rp(d.grossAmount)], ['Diskon', rp(d.discountAmount)], [{ text: 'Total bersih', bold: true }, { text: rp(d.netAmount), bold: true }],
          ['Ditanggung penjamin', rp(d.payerPortion)], [{ text: 'Dibayar pasien', bold: true }, { text: rp(d.patientPortion), bold: true }],
        ] }, layout: 'noBorders' }], margin: [0, 8, 0, 0] },
        { text: 'Harga sudah final.', style: 'small', margin: [0, 12, 0, 0] },
      ];
      const buf = await renderPdf(body, { title: `Tagihan ${d.invoiceNo ?? 'draf'}`, issuedAt: new Date(d.issuedAt ?? d.createdAt) });
      await audit(tx, 'INVOICE_PDF_VIEWED', 'invoice', id, d.patient?.id ?? null, { invoiceNo: d.invoiceNo });
      return { buf, name: d.invoiceNo ?? 'draf' };
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="tagihan-${name}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  }

  private async draft(tx: Tx, id: string, version: number): Promise<InvoiceHead> {
    const h = await invoiceHead(tx, id, true);
    assertVersion(h.version, version, 'Tagihan');
    if (h.status !== 'DRAFT') throw problem(409, 'BIL-409-NOT-DRAFT', 'Tagihan sudah diterbitkan dan tidak dapat diubah');
    return h;
  }

  async view(tx: Tx, id: string) {
    const [h] = await rows<{ id: string; kind: string; status: string; invoice_no: string | null; branch_name: string; payer_type: string; payer_name: string | null;
                             patient_id: string | null; patient_name: string | null; mrn: string | null; customer_name: string | null; encounter_id: string | null;
                             encounter_no: string | null; otc_sale_id: string | null; sale_no: string | null; gross_amount: string; discount_amount: string;
                             net_amount: string; payer_portion: string; patient_portion: string; paid_amount: string; issued_at: string | null;
                             issued_by_name: string | null; created_at: string; version: number; contract: Record<string, unknown> | null;
                             consult_missing: boolean }>(tx, sql`
      select i.id, i.kind, i.status, i.invoice_no, br.name as branch_name, i.payer_type, py.name as payer_name, i.patient_id, pt.full_name as patient_name,
             pt.mrn, coalesce(i.customer_name, o.customer_name) as customer_name, i.encounter_id, e.encounter_no, i.otc_sale_id, o.sale_no,
             i.gross_amount::text, i.discount_amount::text, i.net_amount::text, i.payer_portion::text, i.patient_portion::text, i.paid_amount::text,
             i.issued_at, iu.full_name as issued_by_name, i.created_at, i.version, py.contract,
             (i.kind = 'ENCOUNTER' and su.consult_service_id is null) as consult_missing
        from invoice i join branch br on br.id = i.branch_id left join payer py on py.id = i.payer_id left join patient pt on pt.id = i.patient_id
        left join encounter e on e.id = i.encounter_id left join service_unit su on su.id = e.unit_id left join otc_sale o on o.id = i.otc_sale_id
        left join app_user iu on iu.id = i.issued_by where i.id = ${id}`);
    if (!h) throw problem(404, ...INV_NOT_FOUND);
    const lines = await rows<{ id: string; line_no: number; source_type: string; description: string; qty: string; unit_price: string; discount_amount: string;
                               line_total: string; payer_portion: string; patient_portion: string; is_manual: boolean; service_item_id: string | null;
                               discount_reason: string | null; discount_status: string; discount_requested_by: string | null; requester_name: string | null;
                               approver_name: string | null; split_reason: string | null }>(tx, sql`
      select l.id, l.line_no, l.source_type, l.description, trim_scale(l.qty)::text as qty, l.unit_price::text, l.discount_amount::text, l.line_total::text,
             l.payer_portion::text, l.patient_portion::text, l.is_manual, l.service_item_id, l.discount_reason, l.discount_status, l.discount_requested_by,
             ru.full_name as requester_name, au.full_name as approver_name, l.split_reason
        from invoice_line l left join app_user ru on ru.id = l.discount_requested_by left join app_user au on au.id = l.discount_approved_by
       where l.invoice_id = ${id} order by l.line_no`);
    const payments = await rows<PaymentRow>(tx, sql`
      select p.id, p.receipt_no, p.method, p.amount::text, p.cash_tendered::text, p.reference, p.received_at, u.full_name as received_by_name
        from payment p join app_user u on u.id = p.received_by where p.invoice_id = ${id} order by p.received_at, p.receipt_no`);
    const [rc] = await rows<{ id: string; amount: string; paid_amount: string; due_date: string; status: string }>(tx, sql`
      select id, amount::text, paid_amount::text, to_char(due_date, 'YYYY-MM-DD') as due_date, status from receivable where invoice_id = ${id}`);
    const contract = h.contract as { validUntil?: string; copayPercent?: number; plafon?: number | string } | null;
    const warnings: string[] = [];
    if (h.consult_missing) warnings.push('Poli kunjungan ini belum punya layanan konsultasi bawaan (Master data → Fasilitas & cabang).');
    if (h.payer_type !== 'UMUM' && contract?.validUntil && h.created_at && contract.validUntil < new Date(h.created_at).toISOString().slice(0, 10)) {
      warnings.push(`Kontrak penjamin berakhir ${contract.validUntil}; periksa sebelum menerbitkan.`);
    }
    return {
      id: h.id, kind: h.kind, status: h.status, invoiceNo: h.invoice_no, branchName: h.branch_name, payerType: h.payer_type, payerName: h.payer_name,
      contract: h.payer_type === 'UMUM' ? null : { copayPercent: contract?.copayPercent ?? 0, plafon: contract?.plafon ?? null, validUntil: contract?.validUntil ?? null },
      patient: h.patient_name ? { id: h.patient_id!, name: h.patient_name, mrn: h.mrn } : null, customerName: h.customer_name,
      encounterId: h.encounter_id, encounterNo: h.encounter_no, otcSaleId: h.otc_sale_id, saleNo: h.sale_no,
      grossAmount: h.gross_amount, discountAmount: h.discount_amount, netAmount: h.net_amount, payerPortion: h.payer_portion, patientPortion: h.patient_portion,
      paidAmount: h.paid_amount, outstanding: Math.max(0, Math.round((Number(h.patient_portion) - Number(h.paid_amount)) * 100) / 100).toFixed(2),
      payments: payments.map(paymentDto),
      receivable: rc ? { id: rc.id, amount: rc.amount, paidAmount: rc.paid_amount, dueDate: rc.due_date, status: rc.status } : null,
      issuedAt: h.issued_at, issuedByName: h.issued_by_name, createdAt: h.created_at, version: h.version, warnings,
      lines: lines.map((l) => ({ id: l.id, lineNo: l.line_no, sourceType: l.source_type, description: l.description, qty: Number(l.qty), unitPrice: l.unit_price,
        discountAmount: l.discount_amount, lineTotal: l.line_total, payerPortion: l.payer_portion, patientPortion: l.patient_portion, isManual: l.is_manual,
        serviceItemId: l.service_item_id, discountReason: l.discount_reason, discountStatus: l.discount_status, discountRequestedByName: l.requester_name,
        discountMine: l.discount_requested_by === ctx().userId, discountApprovedByName: l.approver_name, splitReason: l.split_reason })),
    };
  }
}
