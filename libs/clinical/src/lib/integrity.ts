import { sql } from 'drizzle-orm';
import { type Tx, rows } from '@clinicrme/db';
import { sha256Hex } from '@clinicrme/shared';

/** JSON dengan kunci terurut → representasi kanonik yang stabil untuk hashing. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}
const ISO = (col: ReturnType<typeof sql>) => sql`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Isi rekam medis kunjungan yang dilindungi hash pengesahan (ADR-0006, CLN-FR-017): catatan SOAP + isian template,
 * tanda vital, diagnosis, tindakan, identitas kunjungan, dan penandatangan. Semua bagian ini terkunci trigger DB
 * setelah SIGNED, sehingga hash dapat dihitung ulang kapan saja untuk mendeteksi perubahan.
 */
export async function noteContentHash(tx: Tx, noteId: string, signer: { practitionerId: string; userId: string; sip: string | null; signedAt: string }) {
  const [n] = await rows<Record<string, unknown> & { encounter_id: string }>(tx, sql`
    select n.encounter_id, e.encounter_no, e.patient_id, e.practitioner_id, n.template_code, n.subjective, n.objective, n.assessment, n.plan, n.structured
      from clinical_note n join encounter e on e.id = n.encounter_id where n.id = ${noteId}`);
  const vitals = await rows(tx, sql`
    select code, value_num::text as value, unit, ${ISO(sql`recorded_at`)} as recorded_at, recorded_by
      from observation where encounter_id = ${n.encounter_id} order by recorded_at, code, id`);
  const diagnoses = await rows(tx, sql`
    select s.code as system, c.code, d.rank, d.case_status, d.note
      from condition_dx d join concept c on c.id = d.concept_id join code_system s on s.id = c.system_id
     where d.encounter_id = ${n.encounter_id} order by d.rank, c.code`);
  const procedures = await rows(tx, sql`
    select a.service_item_id, c.code as concept_code, a.performed_by, a.qty::text as qty, ${ISO(sql`a.performed_at`)} as performed_at
      from procedure_act a left join concept c on c.id = a.concept_id where a.encounter_id = ${n.encounter_id} order by a.performed_at, a.id`);
  return sha256Hex(stableStringify({ v: 1, noteId, note: n, vitals, diagnoses, procedures, signer }));
}

export const addendumHash = (a: { noteHash: string; noteId: string; reason: string; content: string; authorId: string; authorUserId: string; signedAt: string }) =>
  sha256Hex(stableStringify({ v: 1, ...a }));

/** Waktu server dalam format yang sama dengan penyimpanan (mikrodetik, UTC) — dipakai di hash & kolom signed_at. */
export async function serverNow(tx: Tx): Promise<string> {
  const [r] = await rows<{ t: string }>(tx, sql`select ${ISO(sql`now()`)} as t`);
  return r.t;
}
export { ISO };
