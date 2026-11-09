import { sql } from 'drizzle-orm';
import { type Tx, rows } from '@clinicrme/db';
import { ctx, problem } from '@clinicrme/shared';

export const RX_NOT_FOUND = ['PHM-404-RX', 'Resep tidak ditemukan'] as const;

/** OD-098 (DEC-039) — checklist telaah resep `[REVIEW-MEDIS]`: isi wajib ditinjau apoteker sebelum pilot. */
export const CHECKLIST = [
  { key: 'ADM_PATIENT', group: 'ADMINISTRATIF', label: 'Identitas pasien (nama, No. RM, tanggal lahir)' },
  { key: 'ADM_PRESCRIBER', group: 'ADMINISTRATIF', label: 'Nama & SIP dokter penulis resep' },
  { key: 'ADM_DATE', group: 'ADMINISTRATIF', label: 'Tanggal resep' },
  { key: 'PHA_FORM', group: 'FARMASETIK', label: 'Bentuk & kekuatan sediaan' },
  { key: 'PHA_QTY', group: 'FARMASETIK', label: 'Jumlah obat' },
  { key: 'PHA_DIRECTIONS', group: 'FARMASETIK', label: 'Aturan & cara pakai' },
  { key: 'PHA_COMPOUND', group: 'FARMASETIK', label: 'Kesesuaian komponen racikan (bila ada)' },
  { key: 'CLN_DOSE', group: 'KLINIS', label: 'Ketepatan dosis' },
  { key: 'CLN_ALLERGY', group: 'KLINIS', label: 'Riwayat alergi pasien' },
  { key: 'CLN_DUPLICATE', group: 'KLINIS', label: 'Duplikasi pengobatan (lihat peringatan dokter)' },
  { key: 'CLN_SPECIAL', group: 'KLINIS', label: 'Kondisi khusus (hamil, menyusui, anak, lansia, gangguan ginjal/hati)' },
] as const;

export const ROUTE_LABEL: Record<string, string> = {
  ORAL: 'diminum', SUBLINGUAL: 'di bawah lidah', TOPIKAL: 'dioleskan', TETES_MATA: 'tetes mata', TETES_TELINGA: 'tetes telinga',
  INHALASI: 'dihirup', REKTAL: 'melalui anus', INJEKSI: 'injeksi', LAINNYA: '',
};

export interface RxHead {
  id: string; prescription_no: string; status: string; version: number; issued_at: string; first_dispensed_at: string | null;
  encounter_id: string; encounter_no: string; encounter_status: string; payer_type: string; branch_id: string; branch_name: string; timezone: string;
  patient_id: string; patient_name: string; mrn: string; birth_date: string; sex: string; prescriber_name: string; sip_number: string | null;
  review_checklist: { items: Record<string, { ok: boolean; note?: string | null }>; result: 'OK' | 'PROBLEM' } | null;
  reviewed_at: string | null; reviewer_name: string | null; alerts: { key: string; type: string; message: string; reason?: string | null }[];
  notes: string | null; closed_reason: string | null; today: string; pickup_days: number; method: 'FEFO' | 'FIFO'; pharmacy_first: boolean;
}

export async function rxHead(tx: Tx, id: string, lock = false): Promise<RxHead> {
  const [r] = await rows<RxHead>(tx, sql`
    select p.id, p.prescription_no, p.status, p.version, p.issued_at, p.first_dispensed_at, e.id as encounter_id, e.encounter_no,
           e.status as encounter_status, e.payer_type, e.branch_id, br.name as branch_name, br.timezone, pt.id as patient_id, pt.full_name as patient_name,
           pt.mrn, to_char(pt.birth_date, 'YYYY-MM-DD') as birth_date, pt.sex, pr.full_name as prescriber_name, pr.sip_number, p.review_checklist,
           p.reviewed_at, ru.full_name as reviewer_name, p.alerts, p.notes, p.closed_reason,
           to_char(now() at time zone br.timezone, 'YYYY-MM-DD') as today,
           coalesce((t.settings->>'partialPickupDays')::int, 7) as pickup_days,
           coalesce(t.settings->>'dispenseMethod', 'FEFO') as method,
           coalesce((t.settings->>'pharmacyBeforeCashier')::boolean, true) as pharmacy_first
      from prescription p join encounter e on e.id = p.encounter_id join branch br on br.id = e.branch_id join patient pt on pt.id = e.patient_id
      join practitioner pr on pr.id = p.prescriber_id join tenant t on t.id = p.tenant_id left join app_user ru on ru.id = p.reviewed_by
     where p.id = ${id} and p.status not in ('DRAFT', 'CANCELLED') ${lock ? sql`for update of p, e` : sql``}`);
  if (!r) throw problem(404, ...RX_NOT_FOUND);
  return r;
}

export interface ItemRow {
  id: string; line_no: number; is_compound: boolean; drug_item_id: string | null; drug_name: string | null; strength: string | null; dosage_form: string | null;
  drug_class: string | null; compound_name: string | null; compound_form: string | null; dose: string | null; frequency: string; route: string;
  duration_days: number | null; qty: string; uom_name: string; instructions: string | null; qty_dispensed: string; qty_closed: string; close_reason: string | null;
}
export interface CompRow { prescription_item_id: string; drug_item_id: string; drug_name: string; drug_class: string; qty: string; uom_name: string }

export async function rxItems(tx: Tx, rxId: string, lock = false) {
  const items = await rows<ItemRow>(tx, sql`
    select i.id, i.line_no, i.is_compound, i.drug_item_id, d.generic_name as drug_name, d.strength, d.dosage_form, d.drug_class, i.compound_name,
           i.compound_form, i.dose, i.frequency, i.route, i.duration_days, trim_scale(i.qty)::text as qty, u.name as uom_name, i.instructions,
           trim_scale(i.qty_dispensed)::text as qty_dispensed, trim_scale(i.qty_closed)::text as qty_closed, i.close_reason
      from prescription_item i join uom u on u.id = i.uom_id left join drug_item d on d.id = i.drug_item_id
     where i.prescription_id = ${rxId} order by i.line_no ${lock ? sql`for update of i` : sql``}`);
  const comps = await rows<CompRow>(tx, sql`
    select c.prescription_item_id, c.drug_item_id, d.generic_name as drug_name, d.drug_class, trim_scale(c.qty)::text as qty, u.name as uom_name
      from prescription_compound_component c join prescription_item i on i.id = c.prescription_item_id join drug_item d on d.id = c.drug_item_id
      join uom u on u.id = c.uom_id where i.prescription_id = ${rxId} order by c.id`);
  return { items, comps };
}

export const remainingOf = (i: ItemRow) => round4(Number(i.qty) - Number(i.qty_dispensed) - Number(i.qty_closed));
export const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Kebutuhan satuan dasar per obat untuk `qty` satuan resep. Racikan: komponen (total resep) × qty / jumlah racikan. */
export function needsOf(i: ItemRow, comps: CompRow[], qty: number) {
  if (!i.is_compound) return [{ drugItemId: i.drug_item_id!, name: i.drug_name!, drugClass: i.drug_class!, qtyBase: round4(qty) }];
  return comps.filter((c) => c.prescription_item_id === i.id)
    .map((c) => ({ drugItemId: c.drug_item_id, name: c.drug_name, drugClass: c.drug_class, qtyBase: round4(Number(c.qty) * qty / Number(i.qty)) }));
}

export interface BatchAvail { batch_id: string; batch_no: string; expiry_date: string; qty_on_hand: string }

/**
 * Batch yang dapat dikeluarkan dari lokasi (belum kedaluwarsa per tanggal cabang), urut OD-037: FEFO (kedaluwarsa
 * terdekat, lalu yang diterima lebih dulu) atau FIFO (diterima lebih dulu). Penyerahan memanggil `lockStock` lebih dulu.
 */
export async function batchesFor(tx: Tx, drugItemId: string, locationId: string, today: string, method: 'FEFO' | 'FIFO') {
  return rows<BatchAvail>(tx, sql`
    select sb.id as batch_id, sb.batch_no, to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date, trim_scale(s.qty_on_hand)::text as qty_on_hand
      from stock_balance s join stock_batch sb on sb.id = s.batch_id
     where sb.drug_item_id = ${drugItemId} and s.location_id = ${locationId} and s.qty_on_hand > 0 and sb.expiry_date >= ${today}::date
     order by ${method === 'FIFO' ? sql`sb.created_at, sb.expiry_date` : sql`sb.expiry_date, sb.created_at`}, sb.id`);
}

/**
 * Kunci stok obat di lokasi sampai transaksi selesai (advisory lock; saldo hanya diubah trigger ledger). Diurutkan agar
 * dua penyerahan dengan obat yang sama tidak saling menunggu (deadlock). Penyerahan kedua membaca saldo setelah yang
 * pertama commit, sehingga tidak ada alokasi ganda; CHECK saldo ≥ 0 tetap menjadi pengaman terakhir.
 */
export async function lockStock(tx: Tx, locationId: string, drugItemIds: string[]) {
  for (const d of [...new Set(drugItemIds)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`stock:${locationId}:${d}`}, 0))`);
  }
}

/** Alokasi otomatis: ambil dari batch berurutan sampai kebutuhan terpenuhi; null bila stok layak pakai kurang. */
export function allocate(batches: BatchAvail[], need: number): { batchId: string; qty: number }[] | null {
  const out: { batchId: string; qty: number }[] = [];
  let left = round4(need);
  for (const b of batches) {
    if (left <= 0) break;
    const take = Math.min(left, Number(b.qty_on_hand));
    out.push({ batchId: b.batch_id, qty: round4(take) });
    left = round4(left - take);
  }
  return left > 0 ? null : out;
}

/** Lokasi penyerahan: lokasi yang dipilih (aktif, cabang kunjungan) atau lokasi bawaan cabang (OD-097). */
export async function dispenseLocation(tx: Tx, branchId: string, locationId?: string | null) {
  const [l] = await rows<{ id: string; name: string }>(tx, sql`
    select id, name from stock_location where branch_id = ${branchId} and is_active
       and (${locationId ?? null}::uuid is null and is_default or id = ${locationId ?? null}::uuid)`);
  if (!l) throw problem(400, 'PHM-400-LOCATION', 'Lokasi stok tidak ditemukan, tidak aktif, atau bukan milik cabang kunjungan');
  return l;
}

/**
 * Setelah penyerahan/penutupan: status resep dari sisa baris; kunjungan yang menunggu di farmasi diteruskan ke kasir
 * (farmasi dulu, DEC-013) atau selesai (kasir dulu — pembayaran sudah diterima sebelum ke farmasi).
 */
export async function settle(tx: Tx, h: RxHead, closedReason?: string) {
  const items = await rows<{ open: number; dispensed: number }>(tx, sql`
    select count(*) filter (where qty_dispensed + qty_closed < qty)::int as open, count(*) filter (where qty_dispensed > 0)::int as dispensed
      from prescription_item where prescription_id = ${h.id}`);
  const { open, dispensed } = items[0];
  const status = open > 0 ? (dispensed > 0 ? 'PARTIALLY_DISPENSED' : h.status) : dispensed > 0 ? 'DISPENSED' : 'CLOSED';
  await tx.execute(sql`update prescription set status = ${status}, version = version + 1, updated_by = ${ctx().userId},
                         first_dispensed_at = case when ${dispensed > 0} then coalesce(first_dispensed_at, now()) else first_dispensed_at end,
                         closed_reason = case when ${status} = 'CLOSED' then ${closedReason ?? null} else closed_reason end
                        where id = ${h.id}`);
  let encounterStatus = h.encounter_status;
  if (h.encounter_status === 'PHARMACY' && (dispensed > 0 || open === 0)) {
    encounterStatus = h.pharmacy_first ? 'BILLING' : 'FINISHED';
    await tx.execute(sql`update encounter set status = ${encounterStatus}, updated_by = ${ctx().userId},
                           finished_at = case when ${encounterStatus} = 'FINISHED' then now() else finished_at end where id = ${h.encounter_id}`);
  }
  return { status, encounterStatus };
}
