import { sql } from 'drizzle-orm';
import { type Tx, rows } from '@clinicrme/db';
import { ctx, problem } from '@clinicrme/shared';

export const RESTRICTED = ['NARKOTIKA', 'PSIKOTROPIKA', 'PREKURSOR'];

/** OD-100: obat narkotika/psikotropika hanya untuk pemegang izin `pharmacy.restricted.dispense`. */
export function assertRestrictedAllowed(drugClass: string, name: string) {
  if (RESTRICTED.includes(drugClass) && !ctx().permissions?.has('pharmacy.restricted.dispense')) {
    throw problem(403, 'PHM-403-RESTRICTED', `${name} termasuk golongan ${drugClass.toLowerCase()}; butuh izin khusus obat terbatas`);
  }
}

/**
 * Faktor konversi satuan transaksi → satuan dasar obat (1 satuan = faktor × satuan dasar). Konversi khusus obat
 * didahulukan, lalu konversi umum; hanya pasangan langsung (tanpa rantai) agar faktor yang dipakai jelas di faktur.
 */
export async function baseFactor(tx: Tx, drugItemId: string, uomId: string, baseUomId: string): Promise<number | null> {
  if (uomId === baseUomId) return 1;
  const [c] = await rows<{ factor: string }>(tx, sql`
    select factor::text from uom_conversion
     where from_uom_id = ${uomId} and to_uom_id = ${baseUomId} and (drug_item_id = ${drugItemId} or drug_item_id is null)
     order by drug_item_id nulls last limit 1`);
  return c ? Number(c.factor) : null;
}

/**
 * Harga jual berlaku (PHM-FR-002, OD-096): prioritas cabang+penjamin → cabang → penjamin → umum, pada tanggal tertentu.
 * Dipakai penyerahan obat (batch 2) & penjualan bebas (batch 4).
 */
export async function currentPrice(tx: Tx, drugItemId: string, branchId: string | null, payerType: string | null, onDate: string) {
  const [p] = await rows<{ id: string; sell_price: string }>(tx, sql`
    select id, sell_price::text from drug_price
     where drug_item_id = ${drugItemId} and valid_from <= ${onDate}::date and (valid_to is null or valid_to >= ${onDate}::date)
       and (branch_id is null or branch_id = ${branchId}) and (payer_type is null or payer_type = ${payerType})
     order by (branch_id is not null) desc, (payer_type is not null) desc limit 1`);
  return p ? { id: p.id, sellPrice: p.sell_price } : null;
}
