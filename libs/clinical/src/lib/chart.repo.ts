import { sql } from 'drizzle-orm';
import { type Tx, rows } from '@clinicrme/db';
import { problem } from '@clinicrme/shared';
import { TEMPLATE_CODES, type TemplateCode } from './templates';

export const ENC_NOT_FOUND = ['ENC-404', 'Kunjungan tidak ditemukan'] as const;
const CLOSED = ['CANCELLED', 'FINISHED'];

export interface EncCore {
  id: string; status: string; patient_id: string; branch_id: string; unit_id: string; practitioner_id: string;
  default_template: string | null; note_id: string | null; note_status: string | null; note_version: number | null;
}

/**
 * Kunjungan untuk ditulisi rekam medis, dikunci baris (FOR UPDATE) agar penulisan bersamaan berurutan. Ditolak bila
 * kunjungan batal/selesai atau catatan sudah disahkan (koreksi lewat addendum — batch 2). Database juga menolak
 * perubahan setelah SIGNED (trigger guard_clinical_note / guard_encounter_clinical_child).
 */
export async function lockEditable(tx: Tx, id: string): Promise<EncCore> {
  const [e] = await rows<EncCore>(tx, sql`
    select e.id, e.status, e.patient_id, e.branch_id, e.unit_id, e.practitioner_id, u.default_template,
           n.id as note_id, n.status as note_status, n.version as note_version
      from encounter e join service_unit u on u.id = e.unit_id left join clinical_note n on n.encounter_id = e.id
     where e.id = ${id} for update of e`);
  if (!e) throw problem(404, ...ENC_NOT_FOUND);
  if (CLOSED.includes(e.status)) throw problem(409, 'CLN-409-ENCOUNTER-CLOSED', 'Kunjungan sudah selesai atau dibatalkan');
  if (e.note_status === 'SIGNED') throw problem(409, 'CLN-409-SIGNED', 'Rekam medis sudah disahkan. Koreksi melalui addendum.');
  return e;
}

export const templateOf = (e: { default_template: string | null }): TemplateCode =>
  (TEMPLATE_CODES as readonly string[]).includes(e.default_template ?? '') ? (e.default_template as TemplateCode) : 'UMUM';

/** Umur sebagai teks (tahun; bayi: bulan/hari) pada tanggal kunjungan. */
export function ageText(birthDate: string, at: Date = new Date()): string {
  const b = new Date(`${birthDate}T00:00:00Z`);
  let months = (at.getUTCFullYear() - b.getUTCFullYear()) * 12 + (at.getUTCMonth() - b.getUTCMonth());
  if (at.getUTCDate() < b.getUTCDate()) months--;
  if (months >= 24) return `${Math.floor(months / 12)} tahun`;
  if (months >= 1) return `${months} bulan`;
  return `${Math.max(0, Math.floor((at.getTime() - b.getTime()) / 86_400_000))} hari`;
}

export interface AllergyRow { id: string; substance: string; category: string; reaction: string | null; severity: string | null; status: string;
  status_reason: string | null; recorded_at: string; recorded_by_name: string | null }
export const allergyDto = (r: AllergyRow) => ({ id: r.id, substance: r.substance, category: r.category, reaction: r.reaction, severity: r.severity,
  status: r.status, statusReason: r.status_reason, recordedAt: r.recorded_at, recordedByName: r.recorded_by_name });
export async function allergiesOf(tx: Tx, patientId: string, activeOnly: boolean) {
  return (await rows<AllergyRow>(tx, sql`
    select a.id, a.substance, a.category, a.reaction, a.severity, a.status, a.status_reason, a.recorded_at, u.full_name as recorded_by_name
      from allergy_intolerance a left join app_user u on u.id = a.recorded_by
     where a.patient_id = ${patientId} and (not ${activeOnly}::boolean or a.status = 'ACTIVE')
     order by (a.status = 'ACTIVE') desc, case a.severity when 'BERAT' then 0 when 'SEDANG' then 1 else 2 end, a.recorded_at desc`)).map(allergyDto);
}

export interface HistoryRow { id: string; history_type: string; description: string; status: string; status_reason: string | null;
  recorded_at: string; recorded_by_name: string | null }
export const historyDto = (r: HistoryRow) => ({ id: r.id, historyType: r.history_type, description: r.description, status: r.status,
  statusReason: r.status_reason, recordedAt: r.recorded_at, recordedByName: r.recorded_by_name });
export async function historyOf(tx: Tx, patientId: string, activeOnly: boolean) {
  return (await rows<HistoryRow>(tx, sql`
    select h.id, h.history_type, h.description, h.status, h.status_reason, h.recorded_at, u.full_name as recorded_by_name
      from patient_history h left join app_user u on u.id = h.recorded_by
     where h.patient_id = ${patientId} and (not ${activeOnly}::boolean or h.status = 'ACTIVE')
     order by (h.status = 'ACTIVE') desc, h.history_type, h.recorded_at desc`)).map(historyDto);
}

export interface NoteRow { id: string; template_code: string; subjective: string | null; objective: string | null; assessment: string | null;
  plan: string | null; structured: Record<string, unknown>; status: string; signed_at: string | null; signed_by_name: string | null;
  signer_sip: string | null; sign_method: string | null; substitute_reason: string | null; content_hash: string | null;
  updated_at: string; updated_by_name: string | null; version: number }
export const noteDto = (r: NoteRow) => ({ id: r.id, templateCode: r.template_code, subjective: r.subjective, objective: r.objective,
  assessment: r.assessment, plan: r.plan, structured: r.structured, status: r.status, signedAt: r.signed_at, signedByName: r.signed_by_name,
  signerSip: r.signer_sip, signMethod: r.sign_method, substituteReason: r.substitute_reason, contentHash: r.content_hash,
  updatedAt: r.updated_at, updatedByName: r.updated_by_name, version: r.version });
export async function noteOf(tx: Tx, encounterId: string) {
  const [n] = await rows<NoteRow>(tx, sql`
    select n.id, n.template_code, n.subjective, n.objective, n.assessment, n.plan, n.structured, n.status, n.signed_at,
           p.full_name as signed_by_name, n.signer_sip, n.sign_method, n.substitute_reason, n.content_hash,
           n.updated_at, u.full_name as updated_by_name, n.version
      from clinical_note n left join practitioner p on p.id = n.signed_by left join app_user u on u.id = n.updated_by
     where n.encounter_id = ${encounterId}`);
  return n ? { ...noteDto(n), addenda: await addendaOf(tx, n.id) } : null;
}

export async function addendaOf(tx: Tx, noteId: string) {
  return (await rows<{ id: string; reason: string; content: string; author_id: string; author_name: string; author_sip: string | null;
                       sign_method: string | null; signed_at: string; content_hash: string }>(tx, sql`
    select a.id, a.reason, a.content, a.author_id, p.full_name as author_name, a.author_sip, a.sign_method, a.signed_at, a.content_hash
      from clinical_addendum a join practitioner p on p.id = a.author_id where a.note_id = ${noteId} order by a.signed_at, a.id`))
    .map((a) => ({ id: a.id, reason: a.reason, content: a.content, authorId: a.author_id, authorName: a.author_name, authorSip: a.author_sip,
      signMethod: a.sign_method, signedAt: a.signed_at, contentHash: a.content_hash }));
}

export async function vitalsOf(tx: Tx, encounterId: string) {
  const r = await rows<{ recorded_at: string; recorded_by_name: string | null; values: Record<string, number> }>(tx, sql`
    select o.recorded_at, u.full_name as recorded_by_name, jsonb_object_agg(o.code, o.value_num) as values
      from observation o left join app_user u on u.id = o.recorded_by
     where o.encounter_id = ${encounterId}
     group by o.recorded_at, u.full_name order by o.recorded_at desc`);
  return r.map((x) => ({ recordedAt: x.recorded_at, recordedByName: x.recorded_by_name,
    values: Object.fromEntries(Object.entries(x.values).map(([k, v]) => [k, Number(v)])) }));
}

export async function diagnosesOf(tx: Tx, encounterId: string) {
  return (await rows<{ id: string; concept_id: string; code: string; display: string; rank: string; case_status: string; note: string | null }>(tx, sql`
    select d.id, d.concept_id, c.code, c.display_id as display, d.rank, d.case_status, d.note
      from condition_dx d join concept c on c.id = d.concept_id
     where d.encounter_id = ${encounterId} order by (d.rank = 'PRIMER') desc, d.created_at, c.code`))
    .map((d) => ({ id: d.id, conceptId: d.concept_id, code: d.code, display: d.display, rank: d.rank, caseStatus: d.case_status, note: d.note }));
}

export async function proceduresOf(tx: Tx, encounterId: string) {
  return (await rows<{ id: string; service_item_id: string; service_name: string; concept_id: string | null; code: string | null; display: string | null;
                       performed_by: string; performed_by_name: string; qty: string; performed_at: string }>(tx, sql`
    select a.id, a.service_item_id, s.name as service_name, a.concept_id, c.code, c.display_id as display,
           a.performed_by, p.full_name as performed_by_name, trim_scale(a.qty)::text as qty, a.performed_at
      from procedure_act a join service_item s on s.id = a.service_item_id join practitioner p on p.id = a.performed_by
      left join concept c on c.id = a.concept_id
     where a.encounter_id = ${encounterId} order by a.performed_at, a.id`))
    .map((a) => ({ id: a.id, serviceItemId: a.service_item_id, serviceName: a.service_name, conceptId: a.concept_id, code: a.code,
      display: a.display, performedBy: a.performed_by, performedByName: a.performed_by_name, qty: Number(a.qty), performedAt: a.performed_at }));
}
