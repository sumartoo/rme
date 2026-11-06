import { sql } from 'drizzle-orm';
import { type Tx, rows } from '@clinicrme/db';

export interface RxAlert { key: string; type: 'ALLERGY' | 'DUPLICATE' | 'DOSE_MAX' | 'DAILY_MAX'; lineNo: number | null; message: string; reason?: string | null }
export interface ResolvedLine {
  lineNo: number; isCompound: boolean; label: string; ingredients: string[];
  doseQty: number; timesPerDay: number; maxDose: number | null; maxDaily: number | null; uomName: string;
}

/**
 * Peringatan resep MVP (OD-033 / DEC-038) — **bukan** clinical decision support penuh:
 * 1) alergi: zat aktif obat (termasuk komponen racikan) cocok dengan alergi aktif pasien kategori obat/lainnya;
 * 2) duplikasi: zat aktif yang sama di lebih dari satu baris resep (atau dua kali dalam satu racikan);
 * 3) dosis: jumlah per pemberian / per hari melebihi batas yang diisi di master obat.
 * Tidak ada pengecekan interaksi obat atau dosis berdasarkan berat badan (CLN-FR-013 LJT). [REVIEW-MEDIS]
 */
export async function computeAlerts(tx: Tx, patientId: string, lines: ResolvedLine[]): Promise<RxAlert[]> {
  const allergies = (await rows<{ substance: string }>(tx, sql`
    select substance from allergy_intolerance where patient_id = ${patientId} and status = 'ACTIVE' and category in ('OBAT', 'LAINNYA')`))
    .map((a) => a.substance.toLowerCase().trim()).filter((a) => a.length >= 3);
  const out: RxAlert[] = [];
  for (const l of lines) {
    for (const ing of l.ingredients) {
      const hit = allergies.find((a) => ing.includes(a) || a.includes(ing));
      if (hit) {
        out.push({ key: `ALLERGY:${l.lineNo}:${ing}`, type: 'ALLERGY', lineNo: l.lineNo,
          message: `Baris ${l.lineNo} (${l.label}) mengandung ${ing} — pasien tercatat alergi ${hit}.` });
      }
    }
  }
  const seen = new Map<string, number[]>();
  for (const l of lines) for (const ing of l.ingredients) seen.set(ing, [...(seen.get(ing) ?? []), l.lineNo]);
  for (const [ing, ls] of seen) {
    if (ls.length > 1) {
      out.push({ key: `DUPLICATE:${ing}`, type: 'DUPLICATE', lineNo: null,
        message: `Zat aktif ${ing} tercantum lebih dari sekali (baris ${[...new Set(ls)].join(', ')}).` });
    }
  }
  for (const l of lines) {
    if (l.isCompound) continue;
    if (l.maxDose !== null && l.doseQty > l.maxDose) {
      out.push({ key: `DOSE_MAX:${l.lineNo}`, type: 'DOSE_MAX', lineNo: l.lineNo,
        message: `Baris ${l.lineNo} (${l.label}): ${l.doseQty} ${l.uomName} per pemberian melebihi batas ${l.maxDose} ${l.uomName}.` });
    }
    const daily = l.doseQty * l.timesPerDay;
    if (l.maxDaily !== null && daily > l.maxDaily) {
      out.push({ key: `DAILY_MAX:${l.lineNo}`, type: 'DAILY_MAX', lineNo: l.lineNo,
        message: `Baris ${l.lineNo} (${l.label}): ${daily} ${l.uomName} per hari melebihi batas ${l.maxDaily} ${l.uomName}.` });
    }
  }
  return out;
}

export async function prescriptionOf(tx: Tx, encounterId: string) {
  const [p] = await rows<{ id: string; prescription_no: string; status: string; issued_at: string | null; prescriber_name: string; alerts: RxAlert[];
                           notes: string | null; version: number }>(tx, sql`
    select p.id, p.prescription_no, p.status, p.issued_at, pr.full_name as prescriber_name, p.alerts, p.notes, p.version
      from prescription p join practitioner pr on pr.id = p.prescriber_id
     where p.encounter_id = ${encounterId} and p.status <> 'CANCELLED'`);
  if (!p) return null;
  const items = await rows<{ id: string; line_no: number; is_compound: boolean; drug_item_id: string | null; drug_name: string | null; strength: string | null;
                             compound_name: string | null; compound_form: string | null; dose_qty: string | null; times_per_day: number | null; frequency: string;
                             route: string; duration_days: number | null; qty: string; uom_id: string; uom_name: string; instructions: string | null }>(tx, sql`
    select i.id, i.line_no, i.is_compound, i.drug_item_id, d.generic_name as drug_name, d.strength, i.compound_name, i.compound_form,
           trim_scale(i.dose_qty)::text as dose_qty, i.times_per_day, i.frequency, i.route, i.duration_days, trim_scale(i.qty)::text as qty,
           i.uom_id, u.name as uom_name, i.instructions
      from prescription_item i join uom u on u.id = i.uom_id left join drug_item d on d.id = i.drug_item_id
     where i.prescription_id = ${p.id} order by i.line_no`);
  const comps = await rows<{ prescription_item_id: string; drug_item_id: string; drug_name: string; qty: string; uom_name: string }>(tx, sql`
    select c.prescription_item_id, c.drug_item_id, d.generic_name as drug_name, trim_scale(c.qty)::text as qty, u.name as uom_name
      from prescription_compound_component c join drug_item d on d.id = c.drug_item_id join uom u on u.id = c.uom_id
      join prescription_item i on i.id = c.prescription_item_id where i.prescription_id = ${p.id} order by c.id`);
  return {
    id: p.id, prescriptionNo: p.prescription_no, status: p.status, issuedAt: p.issued_at, prescriberName: p.prescriber_name, notes: p.notes,
    alerts: p.alerts, version: p.version,
    items: items.map((i) => ({
      id: i.id, lineNo: i.line_no, kind: i.is_compound ? 'COMPOUND' : 'DRUG', drugItemId: i.drug_item_id, drugName: i.drug_name, strength: i.strength,
      compoundName: i.compound_name, compoundForm: i.compound_form, doseQty: i.dose_qty ? Number(i.dose_qty) : null, timesPerDay: i.times_per_day,
      frequency: i.frequency, route: i.route, durationDays: i.duration_days, qty: Number(i.qty), uomId: i.uom_id, uomName: i.uom_name,
      instructions: i.instructions,
      components: comps.filter((c) => c.prescription_item_id === i.id)
        .map((c) => ({ drugItemId: c.drug_item_id, drugName: c.drug_name, qty: Number(c.qty), uomName: c.uom_name })),
    })),
  };
}
