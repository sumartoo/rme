import { sql } from 'drizzle-orm';
import { type Tx, rows } from '@clinicrme/db';
import { ctx, problem, problemWith } from '@clinicrme/shared';

export const INV_NOT_FOUND = ['BIL-404-INVOICE', 'Tagihan tidak ditemukan'] as const;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Tarif berlaku (OD-106 / DEC-042) pada tanggal kunjungan: penjamin spesifik + cabang → penjamin spesifik → jenis
 * penjamin + cabang → jenis penjamin → cabang → umum.
 */
export async function resolveTariff(tx: Tx, serviceItemId: string, branchId: string, payerId: string | null, payerType: string, onDate: string) {
  const [t] = await rows<{ id: string; price: string }>(tx, sql`
    select id, price::text from tariff
     where service_item_id = ${serviceItemId} and valid_from <= ${onDate}::date and (valid_to is null or valid_to >= ${onDate}::date)
       and (branch_id is null or branch_id = ${branchId})
       and (payer_id is null or payer_id = ${payerId}::uuid)
       and (payer_type is null or payer_type = ${payerType})
     order by (payer_id is not null) desc, (payer_type is not null) desc, (branch_id is not null) desc, created_at desc limit 1`);
  return t ? { id: t.id, price: t.price } : null;
}

export interface LineIn {
  sourceType: 'KONSULTASI' | 'TINDAKAN' | 'OBAT' | 'LAB' | 'ADMINISTRASI' | 'LAINNYA'; sourceId: string | null; description: string; qty: number;
  unitPrice: string; serviceItemId: string | null; tariffId: string | null; drugItemId: string | null; isManual: boolean;
  discountAmount: number; discountReason: string | null; discountRequestedBy: string | null; discountApprovedBy: string | null;
  discountStatus: 'NONE' | 'WITHIN_LIMIT' | 'PENDING' | 'APPROVED'; payerOverride: number | null; splitReason: string | null;
  dispenseLineIds?: string[];
  /** Baris tersimpan (id tetap stabil saat draf ditulis ulang). */
  id?: string;
}
interface Ctx { invoiceId: string; branchId: string; payerId: string | null; payerType: string; onDate: string;
  contract: { copayPercent?: number; plafon?: string | number; validUntil?: string } | null }

/** Kunci pencocokan baris otomatis saat draf dibangun ulang (diskon & pembagian manual dipertahankan). */
const keyOf = (l: { sourceType: string; sourceId: string | null; serviceItemId: string | null; drugItemId: string | null; unitPrice: string }) =>
  `${l.sourceType}|${l.sourceId ?? ''}|${l.serviceItemId ?? ''}|${l.drugItemId ?? ''}|${Number(l.unitPrice).toFixed(2)}`;

export interface InvoiceHead {
  id: string; kind: 'ENCOUNTER' | 'DRUG' | 'OTC'; status: string; invoice_no: string | null; branch_id: string; patient_id: string | null;
  encounter_id: string | null; otc_sale_id: string | null; payer_id: string | null; payer_type: string; version: number;
}
export async function invoiceHead(tx: Tx, id: string, lock = false): Promise<InvoiceHead> {
  const [h] = await rows<InvoiceHead>(tx, sql`
    select id, kind, status, invoice_no, branch_id, patient_id, encounter_id, otc_sale_id, payer_id, payer_type, version
      from invoice where id = ${id} ${lock ? sql`for update` : sql``}`);
  if (!h) throw problem(404, ...INV_NOT_FOUND);
  return h;
}

/** Konteks harga & pembagian: tanggal layanan (zona waktu cabang), penjamin & kontraknya. */
export async function pricingContext(tx: Tx, h: InvoiceHead): Promise<Ctx> {
  const [c] = await rows<{ on_date: string; contract: Ctx['contract'] }>(tx, sql`
    select to_char(coalesce(e.arrived_at, e.created_at, o.sold_at, now()) at time zone br.timezone, 'YYYY-MM-DD') as on_date, p.contract
      from invoice i join branch br on br.id = i.branch_id left join encounter e on e.id = i.encounter_id left join otc_sale o on o.id = i.otc_sale_id
      left join payer p on p.id = i.payer_id where i.id = ${h.id}`);
  return { invoiceId: h.id, branchId: h.branch_id, payerId: h.payer_id, payerType: h.payer_type, onDate: c.on_date, contract: h.payer_type === 'UMUM' ? null : c.contract };
}

/**
 * OD-108: Umum → pasien 100%. Penjamin: porsi pasien = co-pay % per baris; porsi penjamin dibatasi plafon per kunjungan
 * (kelebihan → pasien). Baris dengan pembagian manual (beralasan) dipakai apa adanya dan ikut mengurangi plafon.
 */
export function split(lines: LineIn[], c: Ctx) {
  const out: { payer: number; patient: number }[] = [];
  const total = (l: LineIn) => r2(r2(l.qty * Number(l.unitPrice)) - l.discountAmount);
  if (c.payerType === 'UMUM') return lines.map((l) => ({ payer: 0, patient: total(l) }));
  const copay = Number(c.contract?.copayPercent ?? 0);
  let cap = c.contract?.plafon !== undefined && c.contract?.plafon !== null ? Number(c.contract.plafon) : Infinity;
  for (const l of lines) if (l.payerOverride !== null) cap -= Math.min(l.payerOverride, total(l));
  for (const l of lines) {
    const t = total(l);
    if (l.payerOverride !== null) { const p = Math.min(l.payerOverride, t); out.push({ payer: r2(p), patient: r2(t - p) }); continue; }
    let payer = r2(t - r2(t * copay / 100));
    payer = r2(Math.max(0, Math.min(payer, cap)));
    cap -= payer;
    out.push({ payer, patient: r2(t - payer) });
  }
  return out;
}

/**
 * Tulis ulang baris draf + total header. Baris yang sudah ada diperbarui di tempat (id stabil untuk UI), baris baru
 * disisipkan, sisanya dihapus. Baris penyerahan obat ditautkan ke baris tagihan (status tetap UNBILLED sampai terbit).
 */
export async function writeLines(tx: Tx, c: Ctx, lines: LineIn[]) {
  await tx.execute(sql`update dispense_line set invoice_line_id = null
                        where invoice_line_id in (select id from invoice_line where invoice_id = ${c.invoiceId})`);
  const keep = lines.filter((l) => l.id).map((l) => l.id as string);
  await tx.execute(sql`delete from invoice_line where invoice_id = ${c.invoiceId}
                        and not (id = any(${`{${keep.join(',')}}`}::uuid[]))`);
  await tx.execute(sql`update invoice_line set line_no = -line_no where invoice_id = ${c.invoiceId}`);
  const parts = split(lines, c);
  let gross = 0, disc = 0, payer = 0, patient = 0;
  for (const [n, l] of lines.entries()) {
    const base = r2(l.qty * Number(l.unitPrice));
    const lineTotal = r2(base - l.discountAmount);
    gross += base; disc += l.discountAmount; payer += parts[n].payer; patient += parts[n].patient;
    const [{ id }] = l.id ? await rows<{ id: string }>(tx, sql`
      update invoice_line set line_no = ${n + 1}, source_type = ${l.sourceType}, source_id = ${l.sourceId}, description = ${l.description}, qty = ${l.qty},
             unit_price = ${l.unitPrice}::numeric, discount_amount = ${l.discountAmount.toFixed(2)}::numeric, line_total = ${lineTotal.toFixed(2)}::numeric,
             payer_portion = ${parts[n].payer.toFixed(2)}::numeric, patient_portion = ${parts[n].patient.toFixed(2)}::numeric,
             discount_approved_by = ${l.discountApprovedBy}, service_item_id = ${l.serviceItemId}, tariff_id = ${l.tariffId}, drug_item_id = ${l.drugItemId},
             is_manual = ${l.isManual}, discount_reason = ${l.discountReason}, discount_requested_by = ${l.discountRequestedBy},
             discount_status = ${l.discountStatus}, split_reason = ${l.splitReason}
       where id = ${l.id} and invoice_id = ${c.invoiceId} returning id`) : await rows<{ id: string }>(tx, sql`
      insert into invoice_line(tenant_id, invoice_id, line_no, source_type, source_id, description, qty, unit_price, discount_amount, line_total,
                               payer_portion, patient_portion, discount_approved_by, service_item_id, tariff_id, drug_item_id, is_manual,
                               discount_reason, discount_requested_by, discount_status, split_reason)
      values (app.current_tenant_id(), ${c.invoiceId}, ${n + 1}, ${l.sourceType}, ${l.sourceId}, ${l.description}, ${l.qty}, ${l.unitPrice}::numeric,
              ${l.discountAmount.toFixed(2)}::numeric, ${lineTotal.toFixed(2)}::numeric, ${parts[n].payer.toFixed(2)}::numeric, ${parts[n].patient.toFixed(2)}::numeric,
              ${l.discountApprovedBy}, ${l.serviceItemId}, ${l.tariffId}, ${l.drugItemId}, ${l.isManual}, ${l.discountReason}, ${l.discountRequestedBy},
              ${l.discountStatus}, ${l.splitReason}) returning id`);
    if (l.dispenseLineIds?.length) {
      await tx.execute(sql`update dispense_line set invoice_line_id = ${id} where id = any(${`{${l.dispenseLineIds.join(',')}}`}::uuid[])`);
    }
  }
  await tx.execute(sql`update invoice set gross_amount = ${r2(gross).toFixed(2)}::numeric, discount_amount = ${r2(disc).toFixed(2)}::numeric,
                         net_amount = ${r2(gross - disc).toFixed(2)}::numeric, payer_portion = ${r2(payer).toFixed(2)}::numeric,
                         patient_portion = ${r2(patient).toFixed(2)}::numeric, version = version + 1, updated_by = ${ctx().userId}
                        where id = ${c.invoiceId}`);
}

/** Baris tersimpan → bentuk masukan (untuk diubah lalu ditulis ulang). */
export async function currentLines(tx: Tx, invoiceId: string): Promise<(LineIn & { id: string; lineNo: number })[]> {
  const r = await rows<{ id: string; line_no: number; source_type: LineIn['sourceType']; source_id: string | null; description: string; qty: string;
                         unit_price: string; service_item_id: string | null; tariff_id: string | null; drug_item_id: string | null; is_manual: boolean;
                         discount_amount: string; discount_reason: string | null; discount_requested_by: string | null; discount_approved_by: string | null;
                         discount_status: LineIn['discountStatus']; payer_portion: string; split_reason: string | null; dl: string[] }>(tx, sql`
    select l.id, l.line_no, l.source_type, l.source_id, l.description, trim_scale(l.qty)::text as qty, l.unit_price::text, l.service_item_id, l.tariff_id,
           l.drug_item_id, l.is_manual, l.discount_amount::text, l.discount_reason, l.discount_requested_by, l.discount_approved_by, l.discount_status,
           l.payer_portion::text, l.split_reason,
           array(select d.id from dispense_line d where d.invoice_line_id = l.id) as dl
      from invoice_line l where l.invoice_id = ${invoiceId} order by l.line_no`);
  return r.map((x) => ({
    id: x.id, lineNo: x.line_no, sourceType: x.source_type, sourceId: x.source_id, description: x.description, qty: Number(x.qty), unitPrice: x.unit_price,
    serviceItemId: x.service_item_id, tariffId: x.tariff_id, drugItemId: x.drug_item_id, isManual: x.is_manual, discountAmount: Number(x.discount_amount),
    discountReason: x.discount_reason, discountRequestedBy: x.discount_requested_by, discountApprovedBy: x.discount_approved_by, discountStatus: x.discount_status,
    payerOverride: x.split_reason ? Number(x.payer_portion) : null, splitReason: x.split_reason, dispenseLineIds: x.dl,
  }));
}

/**
 * Bangun ulang draf dari sumber (OD-105/106, OD-096): konsultasi poli, administrasi cabang, tindakan, lab, dan obat yang
 * sudah diserahkan & belum ditagih. Baris manual, diskon, dan pembagian manual pada baris yang sama dipertahankan.
 * Layanan tanpa tarif berlaku → 422 dengan daftar layanannya.
 */
export async function rebuildDraft(tx: Tx, h: InvoiceHead) {
  const c = await pricingContext(tx, h);
  const auto: LineIn[] = [];
  const missing: { field: string; message: string }[] = [];
  const blank = { isManual: false, discountAmount: 0, discountReason: null, discountRequestedBy: null, discountApprovedBy: null,
    discountStatus: 'NONE' as const, payerOverride: null, splitReason: null, drugItemId: null };
  const service = async (sourceType: LineIn['sourceType'], sourceId: string | null, serviceItemId: string, name: string, qty: number) => {
    const t = await resolveTariff(tx, serviceItemId, c.branchId, c.payerId, c.payerType, c.onDate);
    if (!t) { missing.push({ field: serviceItemId, message: `Layanan "${name}" belum punya tarif berlaku untuk penjamin ini` }); return; }
    auto.push({ ...blank, sourceType, sourceId, description: name, qty, unitPrice: t.price, serviceItemId, tariffId: t.id });
  };
  if (h.kind === 'ENCOUNTER') {
    const [e] = await rows<{ consult_id: string | null; consult_name: string | null; admin_id: string | null; admin_name: string | null }>(tx, sql`
      select su.consult_service_id as consult_id, cs.name as consult_name, br.admin_service_id as admin_id, adm.name as admin_name
        from encounter e join service_unit su on su.id = e.unit_id join branch br on br.id = e.branch_id
        left join service_item cs on cs.id = su.consult_service_id left join service_item adm on adm.id = br.admin_service_id where e.id = ${h.encounter_id}`);
    if (e.consult_id) await service('KONSULTASI', h.encounter_id, e.consult_id, e.consult_name!, 1);
    if (e.admin_id) await service('ADMINISTRASI', h.encounter_id, e.admin_id, e.admin_name!, 1);
    for (const p of await rows<{ id: string; service_item_id: string; name: string; qty: string }>(tx, sql`
      select pa.id, pa.service_item_id, si.name, pa.qty::text from procedure_act pa join service_item si on si.id = pa.service_item_id
       where pa.encounter_id = ${h.encounter_id} order by pa.performed_at, pa.id`)) {
      await service('TINDAKAN', p.id, p.service_item_id, p.name, Number(p.qty));
    }
    for (const l of await rows<{ id: string; service_item_id: string; name: string }>(tx, sql`
      select li.id, li.service_item_id, si.name from lab_order_item li join lab_order lo on lo.id = li.lab_order_id join service_item si on si.id = li.service_item_id
       where lo.encounter_id = ${h.encounter_id} and lo.status <> 'CANCELLED' order by lo.ordered_at, li.id`)) {
      await service('LAB', l.id, l.service_item_id, `Lab: ${l.name}`, 1);
    }
  }
  if (h.kind === 'ENCOUNTER' || h.kind === 'DRUG') {
    // OD-063/OD-096: obat ditagih sesuai yang diserahkan, dengan harga yang dikunci saat diserahkan
    for (const g of await rows<{ prescription_item_id: string; drug_item_id: string; unit_price: string; qty: string; name: string; uom: string;
                                  compound: string | null; ids: string[] }>(tx, sql`
      select dl.prescription_item_id, dl.drug_item_id, dl.unit_price::text, trim_scale(sum(dl.qty_base))::text as qty, d.generic_name as name, u.name as uom,
             pi.compound_name as compound, array_agg(dl.id order by dl.id) as ids
        from dispense_line dl join dispense ds on ds.id = dl.dispense_id join prescription p on p.id = ds.prescription_id
        join prescription_item pi on pi.id = dl.prescription_item_id join drug_item d on d.id = dl.drug_item_id join uom u on u.id = d.base_uom_id
        left join invoice_line il on il.id = dl.invoice_line_id
       where p.encounter_id = ${h.encounter_id} and dl.billing_status = 'UNBILLED' and (dl.invoice_line_id is null or il.invoice_id = ${h.id})
       group by dl.prescription_item_id, pi.line_no, dl.drug_item_id, dl.unit_price, d.generic_name, u.name, pi.compound_name
       order by pi.line_no, d.generic_name`)) {
      auto.push({ ...blank, sourceType: 'OBAT', sourceId: g.prescription_item_id, drugItemId: g.drug_item_id, serviceItemId: null, tariffId: null,
        description: `${g.name}${g.compound ? ` (racikan ${g.compound})` : ''} — ${g.uom}`, qty: Number(g.qty), unitPrice: g.unit_price, dispenseLineIds: g.ids });
    }
  }
  if (h.kind === 'OTC') {
    for (const g of await rows<{ drug_item_id: string; unit_price: string; qty: string; name: string; uom: string }>(tx, sql`
      select x.drug_item_id, x.unit_price::text, trim_scale(sum(x.qty_base))::text as qty, d.generic_name as name, u.name as uom
        from otc_sale_line x join drug_item d on d.id = x.drug_item_id join uom u on u.id = d.base_uom_id
       where x.otc_sale_id = ${h.otc_sale_id} group by x.drug_item_id, x.unit_price, d.generic_name, u.name order by d.generic_name`)) {
      auto.push({ ...blank, sourceType: 'OBAT', sourceId: h.otc_sale_id, drugItemId: g.drug_item_id, serviceItemId: null, tariffId: null,
        description: `${g.name} — ${g.uom}`, qty: Number(g.qty), unitPrice: g.unit_price });
    }
  }
  if (missing.length) throw problemWith(422, 'BIL-422-TARIFF', 'Ada layanan tanpa tarif berlaku; lengkapi tarif di Master data → Layanan & tarif', { errors: missing });
  const prev = await currentLines(tx, h.id);
  const kept = new Map(prev.filter((p) => !p.isManual).map((p) => [keyOf(p), p]));
  const merged = auto.map((a) => {
    const p = kept.get(keyOf(a));
    // Konsultasi yang diganti kasir tetap memakai layanan pilihan kasir
    if (!p && a.sourceType === 'KONSULTASI') {
      const replaced = prev.find((x) => !x.isManual && x.sourceType === 'KONSULTASI');
      if (replaced) return { ...replaced, dispenseLineIds: [] };
    }
    return p ? { ...a, id: p.id, discountAmount: p.discountAmount, discountReason: p.discountReason, discountRequestedBy: p.discountRequestedBy,
      discountApprovedBy: p.discountApprovedBy, discountStatus: p.discountStatus, payerOverride: p.payerOverride, splitReason: p.splitReason } : a;
  });
  await writeLines(tx, c, [...merged, ...prev.filter((p) => p.isManual)]);
  return { lines: merged.length };
}
