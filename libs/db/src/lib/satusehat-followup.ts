import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { SatuSehatError, type SatuSehatClient, type SatuSehatConnection } from './satusehat';
import {
  RETRY_BACKOFF_MIN, conditionResource, encounterResource, loadEncounter, parseTransactionResponse, validateEncounter, type SendOutcome,
} from './satusehat-encounter';

/**
 * Stage 12 batch 3 — tindak lanjut setelah Encounter terkirim (INT-FR-005, 009, 012; OD-118, OD-119, OD-120 / DEC-044):
 * - MedicationRequest per item resep terbit (Medication contained berkode KFA); obat tanpa KFA → BLOCKED "butuh kode KFA".
 * - MedicationDispense per baris penyerahan, merujuk MedicationRequest yang sudah terkirim.
 * - Addendum yang mengganti diagnosis → Condition baru (POST), Condition dihapus → entered-in-error (PUT), Encounter.diagnosis (PUT).
 * Kegagalan sama dengan kunjungan: 4xx → ERROR, gangguan → backoff lalu DEAD (+ notifikasi), kredensial ditolak → dilempar.
 * Payload tidak disimpan; hanya status, ID SATUSEHAT, hash.
 */
export const KFA_SYSTEM = 'http://sys-ids.kemkes.go.id/kfa';
const MEDICATION_TYPE = 'https://fhir.kemkes.go.id/r4/StructureDefinition/MedicationType';
const MEDICATION_TYPE_CS = 'http://terminology.kemkes.go.id/CodeSystem/medication-type';
export const prescriptionSystem = (orgId: string) => `http://sys-ids.kemkes.go.id/prescription/${orgId}`;
export const prescriptionItemSystem = (orgId: string) => `http://sys-ids.kemkes.go.id/prescription-item/${orgId}`;
const ROUTE_LABEL: Record<string, string> = {
  ORAL: 'Oral', SUBLINGUAL: 'Sublingual', TOPIKAL: 'Topikal', TETES_MATA: 'Tetes mata', TETES_TELINGA: 'Tetes telinga', INHALASI: 'Inhalasi',
  REKTAL: 'Rektal', INJEKSI: 'Injeksi', LAINNYA: 'Lainnya',
};
const uuidFrom = (s: string) => {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const hashOf = (b: unknown) => createHash('sha256').update(JSON.stringify(b)).digest('hex');
const DUE = (alias: string, p: string) => `(${alias}.id is null or ${alias}.status = 'BLOCKED' or (${alias}.status = 'PENDING' and (${alias}.next_attempt_at is null or ${alias}.next_attempt_at <= ${p}::timestamptz)))`;

interface Key { resourceType: string; localType: string; localId: string; parentId?: string | null; code?: string | null }
interface Fields { problems?: { blocking: string[]; warnings: string[] }; error?: string | null; attempts?: number; next?: Date | null; satusehatId?: string | null;
  hash?: string | null }

async function upsert(c: PoolClient, conn: SatuSehatConnection, k: Key, status: string, f: Fields, now: Date) {
  await c.query(`
    insert into app.fhir_sync_record(tenant_id, connection_id, resource_type, local_type, local_id, status, attempts, last_error, problems, next_attempt_at,
                                     satusehat_id, payload_hash, last_sent_at, parent_id, local_code)
    values (app.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10, $11, case when $5 = 'SENT' then $12::timestamptz end, $13, $14)
    on conflict (tenant_id, connection_id, resource_type, local_type, local_id) do update
      set status = excluded.status, attempts = excluded.attempts, last_error = excluded.last_error, problems = excluded.problems,
          next_attempt_at = excluded.next_attempt_at, satusehat_id = coalesce(excluded.satusehat_id, fhir_sync_record.satusehat_id),
          payload_hash = coalesce(excluded.payload_hash, fhir_sync_record.payload_hash), last_sent_at = coalesce(excluded.last_sent_at, fhir_sync_record.last_sent_at),
          parent_id = coalesce(excluded.parent_id, fhir_sync_record.parent_id), local_code = coalesce(excluded.local_code, fhir_sync_record.local_code), updated_at = now()`,
  [conn.id, k.resourceType, k.localType, k.localId, status, f.attempts ?? 0, f.error ?? null, JSON.stringify(f.problems ?? { blocking: [], warnings: [] }),
    f.next ? f.next.toISOString() : null, f.satusehatId ?? null, f.hash ?? null, now.toISOString(), k.parentId ?? null, k.code ?? null]);
}

/** Klasifikasi kegagalan bersama (OD-119). AUTH dilempar ke pemanggil. */
async function failAll(c: PoolClient, conn: SatuSehatConnection, keys: (Key & { attempts: number })[], e: unknown, now: Date,
                       warnings: string[] = []): Promise<SendOutcome> {
  if (!(e instanceof SatuSehatError) || e.kind === 'AUTH') throw e;
  let out: SendOutcome = 'RETRY';
  for (const k of keys) {
    const attempts = k.attempts + 1;
    if (e.kind === 'VALIDATION' || e.kind === 'NOT_FOUND') {
      await upsert(c, conn, k, 'ERROR', { problems: { blocking: e.issues.length ? e.issues : [e.message], warnings }, error: e.message, attempts }, now);
      out = 'ERROR';
    } else {
      const dead = attempts >= RETRY_BACKOFF_MIN.length;
      await upsert(c, conn, k, dead ? 'DEAD' : 'PENDING', { problems: { blocking: [], warnings }, error: e.message, attempts,
        next: dead ? null : new Date(now.getTime() + RETRY_BACKOFF_MIN[attempts - 1] * 60_000) }, now);
      out = dead ? 'DEAD' : 'RETRY';
    }
  }
  return out;
}
const auditSys = (c: PoolClient, action: string, type: string, id: string, patientId: string, summary: object) =>
  c.query(`select app.write_audit($1, $2, $3::uuid, $4::uuid, $5::jsonb, 'SYSTEM', null, null)`, [action, type, id, patientId, JSON.stringify(summary)]);
const lock = async (c: PoolClient, key: string) =>
  (await c.query<{ ok: boolean }>(`select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as ok`, [key])).rows[0].ok;

export async function sendFollowUps(c: PoolClient, client: SatuSehatClient, conn: SatuSehatConnection,
                                    o: { now?: Date; batch?: number; into: Record<SendOutcome, number> }) {
  const now = o.now ?? new Date();
  const p = [conn.id, conn.facilityId, now.toISOString(), o.batch ?? 20];
  const encSent = `join app.fhir_sync_record er on er.connection_id = $1 and er.resource_type = 'Encounter' and er.local_type = 'encounter'
                     and er.local_id = e.id and er.status = 'SENT'`;
  const { rows: rx } = await c.query<{ id: string }>(`
    select p.id from app.prescription p join app.encounter e on e.id = p.encounter_id join app.branch b on b.id = e.branch_id ${encSent}
     where b.facility_id = $2 and p.status in ('ISSUED', 'VERIFIED', 'PARTIALLY_DISPENSED', 'DISPENSED', 'CLOSED')
       and exists (select 1 from app.prescription_item i
                     left join app.fhir_sync_record r on r.connection_id = $1 and r.resource_type = 'MedicationRequest' and r.local_type = 'prescription_item' and r.local_id = i.id
                    where i.prescription_id = p.id and ${DUE('r', '$3')})
     order by p.issued_at limit $4`, p);
  for (const r of rx) o.into[await sendPrescription(c, client, conn, r.id, now)]++;
  const { rows: ds } = await c.query<{ id: string }>(`
    select d.id from app.dispense d join app.prescription p on p.id = d.prescription_id join app.encounter e on e.id = p.encounter_id
      join app.branch b on b.id = e.branch_id ${encSent}
     where b.facility_id = $2
       and exists (select 1 from app.dispense_line l
                     left join app.fhir_sync_record r on r.connection_id = $1 and r.resource_type = 'MedicationDispense' and r.local_type = 'dispense_line' and r.local_id = l.id
                    where l.dispense_id = d.id and ${DUE('r', '$3')})
     order by d.dispensed_at limit $4`, p);
  for (const d of ds) o.into[await sendDispense(c, client, conn, d.id, now)]++;
  // Addendum diagnosis: hanya yang terbaru per catatan (daftar lengkap; yang lebih lama digantikan)
  const { rows: ad } = await c.query<{ id: string }>(`
    select x.id from (
      select distinct on (a.note_id) a.id, a.signed_at from app.clinical_addendum a join app.clinical_note n on n.id = a.note_id
        join app.encounter e on e.id = n.encounter_id join app.branch b on b.id = e.branch_id ${encSent}
       where b.facility_id = $2 and a.changes ? 'diagnoses' order by a.note_id, a.signed_at desc, a.id desc) x
      left join app.fhir_sync_record r on r.connection_id = $1 and r.resource_type = 'Condition' and r.local_type = 'clinical_addendum' and r.local_id = x.id
     where ${DUE('r', '$3')} order by x.signed_at limit $4`, p);
  for (const a of ad) o.into[await sendAddendum(c, client, conn, a.id, now)]++;
}

// ----- MedicationRequest -----

interface RxItem { id: string; line_no: number; is_compound: boolean; compound_name: string | null; compound_form: string | null; dose: string | null;
  dose_qty: string | null; times_per_day: number | null; frequency: string; route: string; duration_days: number | null; qty: string; uom: string;
  instructions: string | null; kfa_code: string | null; generic_name: string | null; rec_status: string | null; attempts: number | null;
  next_attempt_at: Date | null }
interface Component { item_id: string; kfa_code: string | null; generic_name: string; qty: string; uom: string }

function medication(id: string, it: { is_compound: boolean; compound_name: string | null; compound_form: string | null; kfa_code: string | null; generic_name: string | null },
                    comps: Component[]) {
  const type = (code: string, display: string) => [{ url: MEDICATION_TYPE, valueCodeableConcept: { coding: [{ system: MEDICATION_TYPE_CS, code, display }] } }];
  if (!it.is_compound) {
    return { resourceType: 'Medication', id, status: 'active', code: { coding: [{ system: KFA_SYSTEM, code: it.kfa_code, display: it.generic_name }] },
      extension: type('NC', 'Non-compound') };
  }
  return { resourceType: 'Medication', id, status: 'active', code: { text: it.compound_name }, ...(it.compound_form ? { form: { text: it.compound_form } } : {}),
    ingredient: comps.map((x) => ({ itemCodeableConcept: { coding: [{ system: KFA_SYSTEM, code: x.kfa_code, display: x.generic_name }] }, isActive: true,
      strength: { numerator: { value: Number(x.qty), unit: x.uom }, denominator: { value: 1, unit: it.compound_form ?? 'racikan' } } })),
    extension: type('SD', 'Gives of such doses') };
}
const kfaProblem = (it: { is_compound: boolean; compound_name: string | null; kfa_code: string | null; generic_name: string | null }, comps: Component[]) =>
  it.is_compound
    ? comps.filter((x) => !x.kfa_code).map((x) => `Racikan ${it.compound_name}: ${x.generic_name} butuh kode KFA — isi di Master obat`)
    : (!it.kfa_code ? [`Obat ${it.generic_name} butuh kode KFA — isi di Master obat`] : []);

export async function sendPrescription(c: PoolClient, client: SatuSehatClient, conn: SatuSehatConnection, rxId: string, now: Date): Promise<SendOutcome> {
  if (!(await lock(c, `satusehat-rx:${rxId}`))) return 'LOCKED';
  const { rows: [h] } = await c.query<{ prescription_no: string; issued_at: Date; status: string; pr_ihs: string | null; pr_name: string; enc_rec: string;
    enc_ss: string; patient_id: string; ihs_number: string; patient_name: string; restricted: boolean }>(`
    select p.prescription_no, p.issued_at, p.status, pr.satusehat_ihs_id as pr_ihs, pr.full_name as pr_name, er.id as enc_rec, er.satusehat_id as enc_ss,
           e.patient_id, pt.ihs_number, pt.full_name as patient_name, pt.processing_restricted as restricted
      from app.prescription p join app.practitioner pr on pr.id = p.prescriber_id join app.encounter e on e.id = p.encounter_id
      join app.patient pt on pt.id = e.patient_id
      join app.fhir_sync_record er on er.connection_id = $2 and er.resource_type = 'Encounter' and er.local_type = 'encounter' and er.local_id = e.id and er.status = 'SENT'
     where p.id = $1`, [rxId, conn.id]);
  if (!h) return 'SKIPPED';
  const { rows: items } = await c.query<RxItem>(`
    select i.id, i.line_no, i.is_compound, i.compound_name, i.compound_form, i.dose, i.dose_qty::text, i.times_per_day, i.frequency, i.route, i.duration_days,
           trim_scale(i.qty)::text as qty, u.name as uom, i.instructions, d.kfa_code, d.generic_name, r.status as rec_status, r.attempts, r.next_attempt_at
      from app.prescription_item i join app.uom u on u.id = i.uom_id left join app.drug_item d on d.id = i.drug_item_id
      left join app.fhir_sync_record r on r.connection_id = $2 and r.resource_type = 'MedicationRequest' and r.local_type = 'prescription_item' and r.local_id = i.id
     where i.prescription_id = $1 order by i.line_no`, [rxId, conn.id]);
  const { rows: comps } = await c.query<Component>(`
    select c.prescription_item_id as item_id, d.kfa_code, d.generic_name, trim_scale(c.qty)::text as qty, u.name as uom
      from app.prescription_compound_component c join app.drug_item d on d.id = c.drug_item_id join app.uom u on u.id = c.uom_id
      join app.prescription_item i on i.id = c.prescription_item_id where i.prescription_id = $1 order by c.id`, [rxId]);
  const due = items.filter((i) => i.rec_status === null || i.rec_status === 'BLOCKED'
    || (i.rec_status === 'PENDING' && (!i.next_attempt_at || i.next_attempt_at <= now)));
  if (!due.length) return 'SKIPPED';
  const key = (i: RxItem): Key & { attempts: number } => ({ resourceType: 'MedicationRequest', localType: 'prescription_item', localId: i.id, parentId: h.enc_rec,
    code: i.kfa_code, attempts: i.attempts ?? 0 });
  if (h.restricted) {
    for (const i of due) await upsert(c, conn, key(i), 'SKIPPED', { problems: { blocking: ['Pemrosesan data pasien dibatasi (permintaan pasien) — tidak dikirim'], warnings: [] } }, now);
    return 'SKIPPED';
  }
  const prescriberProblem = h.pr_ihs ? [] : [`Dokter penulis resep ${h.pr_name} belum punya IHS SATUSEHAT — lengkapi NIK lalu jalankan Sinkron master`];
  const ready: RxItem[] = [];
  for (const i of due) {
    const blocking = [...prescriberProblem, ...kfaProblem(i, comps.filter((x) => x.item_id === i.id))];
    if (blocking.length) await upsert(c, conn, key(i), 'BLOCKED', { problems: { blocking, warnings: [] }, attempts: i.attempts ?? 0 }, now);
    else ready.push(i);
  }
  if (!ready.length) return 'BLOCKED';
  const itemValue = (i: RxItem) => `${h.prescription_no}-${i.line_no}`;
  try {
    // Percobaan ulang setelah gangguan: item yang ternyata sudah tersimpan tidak dikirim lagi (identifier item resep)
    const toSend: RxItem[] = [];
    for (const i of ready) {
      if ((i.attempts ?? 0) > 0) {
        const r = await client.request('GET', `/MedicationRequest?identifier=${encodeURIComponent(`${prescriptionItemSystem(conn.organizationId)}|${itemValue(i)}`)}`);
        const found = ((r.body as { entry?: { resource?: { id?: string } }[] }).entry ?? [])[0]?.resource?.id;
        if (found) { await upsert(c, conn, key(i), 'SENT', { attempts: (i.attempts ?? 0) + 1, satusehatId: found }, now); continue; }
      }
      toSend.push(i);
    }
    if (toSend.length) {
      const patient = { reference: `Patient/${h.ihs_number}`, display: h.patient_name };
      const requester = { reference: `Practitioner/${h.pr_ihs}`, display: h.pr_name };
      const done = ['DISPENSED', 'CLOSED'].includes(h.status);
      const bundle = { resourceType: 'Bundle', type: 'transaction', entry: toSend.map((i) => ({
        fullUrl: `urn:uuid:${i.id}`, request: { method: 'POST', url: 'MedicationRequest' },
        resource: {
          resourceType: 'MedicationRequest',
          identifier: [{ system: prescriptionSystem(conn.organizationId), use: 'official', value: h.prescription_no },
            { system: prescriptionItemSystem(conn.organizationId), use: 'official', value: itemValue(i) }],
          status: done ? 'completed' : 'active', intent: 'order',
          category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'outpatient', display: 'Outpatient' }] }],
          contained: [medication(`med-${i.line_no}`, i, comps.filter((x) => x.item_id === i.id))],
          medicationReference: { reference: `#med-${i.line_no}`, display: i.is_compound ? i.compound_name : i.generic_name },
          subject: patient, encounter: { reference: `Encounter/${h.enc_ss}` }, authoredOn: h.issued_at.toISOString(), requester,
          dosageInstruction: [{
            sequence: 1, text: [i.dose, i.frequency].filter(Boolean).join(' '), ...(i.instructions ? { patientInstruction: i.instructions } : {}),
            ...(i.times_per_day ? { timing: { repeat: { frequency: i.times_per_day, period: 1, periodUnit: 'd' } } } : {}),
            route: { text: ROUTE_LABEL[i.route] ?? i.route },
            ...(i.dose_qty ? { doseAndRate: [{ doseQuantity: { value: Number(i.dose_qty), unit: i.uom } }] } : {}),
          }],
          dispenseRequest: { quantity: { value: Number(i.qty), unit: i.uom },
            ...(i.duration_days ? { expectedSupplyDuration: { value: i.duration_days, unit: 'days', system: 'http://unitsofmeasure.org', code: 'd' } } : {}) },
        },
      })) };
      const ids = parseTransactionResponse((await client.request('POST', '', bundle)).body, toSend.length);
      if (ids.some((x) => !x)) throw new SatuSehatError('TRANSIENT', 'Respons SATUSEHAT tidak berisi ID MedicationRequest');
      const hash = hashOf(bundle);
      for (const [n, i] of toSend.entries()) await upsert(c, conn, key(i), 'SENT', { attempts: (i.attempts ?? 0) + 1, satusehatId: ids[n], hash }, now);
    }
    await auditSys(c, 'SATUSEHAT_MEDICATION_REQUEST_SENT', 'prescription', rxId, h.patient_id,
      { environment: conn.environment, items: ready.length, reused: ready.length - toSend.length, blocked: due.length - ready.length });
    return 'SENT';
  } catch (e) {
    const out = await failAll(c, conn, ready.map(key), e, now);
    await auditSys(c, out === 'ERROR' ? 'SATUSEHAT_MEDICATION_REQUEST_REJECTED' : out === 'DEAD' ? 'SATUSEHAT_MEDICATION_REQUEST_DEAD' : 'SATUSEHAT_MEDICATION_REQUEST_RETRY',
      'prescription', rxId, h.patient_id, { environment: conn.environment, items: ready.length, error: (e as Error).message });
    return out;
  }
}

// ----- MedicationDispense -----

export async function sendDispense(c: PoolClient, client: SatuSehatClient, conn: SatuSehatConnection, dispenseId: string, now: Date): Promise<SendOutcome> {
  if (!(await lock(c, `satusehat-disp:${dispenseId}`))) return 'LOCKED';
  const { rows: [h] } = await c.query<{ prescription_no: string; dispensed_at: Date; ph_ihs: string | null; ph_name: string | null; enc_rec: string; enc_ss: string;
    patient_id: string; ihs_number: string; patient_name: string; restricted: boolean }>(`
    select p.prescription_no, d.dispensed_at, ph.satusehat_ihs_id as ph_ihs, ph.full_name as ph_name, er.id as enc_rec, er.satusehat_id as enc_ss,
           e.patient_id, pt.ihs_number, pt.full_name as patient_name, pt.processing_restricted as restricted
      from app.dispense d join app.prescription p on p.id = d.prescription_id join app.encounter e on e.id = p.encounter_id
      join app.patient pt on pt.id = e.patient_id left join app.practitioner ph on ph.id = d.pharmacist_id
      join app.fhir_sync_record er on er.connection_id = $2 and er.resource_type = 'Encounter' and er.local_type = 'encounter' and er.local_id = e.id and er.status = 'SENT'
     where d.id = $1`, [dispenseId, conn.id]);
  if (!h) return 'SKIPPED';
  const { rows: lines } = await c.query<{ id: string; item_id: string; line_no: number; ordinal: number; item_qty: string; uom: string; kfa_code: string | null;
    generic_name: string; mr_status: string | null; mr_ss: string | null; rec_status: string | null; attempts: number | null; next_attempt_at: Date | null }>(`
    select l.id, i.id as item_id, i.line_no,
           (select count(*)::int from app.dispense_line l2 join app.dispense d2 on d2.id = l2.dispense_id
             where l2.prescription_item_id = l.prescription_item_id and (d2.dispensed_at, l2.id) <= (d.dispensed_at, l.id)) as ordinal,
           trim_scale(l.item_qty)::text as item_qty, u.name as uom, dr.kfa_code, dr.generic_name,
           mr.status as mr_status, mr.satusehat_id as mr_ss, r.status as rec_status, r.attempts, r.next_attempt_at
      from app.dispense_line l join app.dispense d on d.id = l.dispense_id join app.prescription_item i on i.id = l.prescription_item_id
      join app.uom u on u.id = i.uom_id join app.drug_item dr on dr.id = l.drug_item_id
      left join app.fhir_sync_record mr on mr.connection_id = $2 and mr.resource_type = 'MedicationRequest' and mr.local_type = 'prescription_item' and mr.local_id = i.id
      left join app.fhir_sync_record r on r.connection_id = $2 and r.resource_type = 'MedicationDispense' and r.local_type = 'dispense_line' and r.local_id = l.id
     where l.dispense_id = $1 order by i.line_no, l.id`, [dispenseId, conn.id]);
  const due = lines.filter((l) => l.rec_status === null || l.rec_status === 'BLOCKED'
    || (l.rec_status === 'PENDING' && (!l.next_attempt_at || l.next_attempt_at <= now)));
  if (!due.length) return 'SKIPPED';
  type L = (typeof lines)[number];
  const key = (l: L): Key & { attempts: number } => ({ resourceType: 'MedicationDispense', localType: 'dispense_line', localId: l.id, parentId: h.enc_rec,
    code: l.kfa_code, attempts: l.attempts ?? 0 });
  if (h.restricted) {
    for (const l of due) await upsert(c, conn, key(l), 'SKIPPED', { problems: { blocking: ['Pemrosesan data pasien dibatasi (permintaan pasien) — tidak dikirim'], warnings: [] } }, now);
    return 'SKIPPED';
  }
  const warnings = h.ph_ihs ? [] : ['Apoteker penyerah tanpa IHS SATUSEHAT — performer tidak dikirim'];
  const ready: L[] = [];
  for (const l of due) {
    const blocking = [
      ...(l.mr_status !== 'SENT' ? [`Resep obat ${l.generic_name} belum terkirim ke SATUSEHAT — selesaikan masalah resep lebih dulu`] : []),
      ...(!l.kfa_code ? [`Obat ${l.generic_name} butuh kode KFA — isi di Master obat`] : []),
    ];
    if (blocking.length) await upsert(c, conn, key(l), 'BLOCKED', { problems: { blocking, warnings }, attempts: l.attempts ?? 0 }, now);
    else ready.push(l);
  }
  if (!ready.length) return 'BLOCKED';
  const itemValue = (l: L) => `${h.prescription_no}-${l.line_no}${l.ordinal > 1 ? `-${l.ordinal}` : ''}`;
  try {
    const toSend: L[] = [];
    for (const l of ready) {
      if ((l.attempts ?? 0) > 0) {
        const r = await client.request('GET', `/MedicationDispense?identifier=${encodeURIComponent(`${prescriptionItemSystem(conn.organizationId)}|${itemValue(l)}`)}`);
        const found = ((r.body as { entry?: { resource?: { id?: string } }[] }).entry ?? [])[0]?.resource?.id;
        if (found) { await upsert(c, conn, key(l), 'SENT', { attempts: (l.attempts ?? 0) + 1, satusehatId: found, problems: { blocking: [], warnings } }, now); continue; }
      }
      toSend.push(l);
    }
    if (toSend.length) {
      const at = h.dispensed_at.toISOString();
      const bundle = { resourceType: 'Bundle', type: 'transaction', entry: toSend.map((l, n) => ({
        fullUrl: `urn:uuid:${l.id}`, request: { method: 'POST', url: 'MedicationDispense' },
        resource: {
          resourceType: 'MedicationDispense',
          identifier: [{ system: prescriptionSystem(conn.organizationId), use: 'official', value: h.prescription_no },
            { system: prescriptionItemSystem(conn.organizationId), use: 'official', value: itemValue(l) }],
          status: 'completed',
          category: { coding: [{ system: 'http://terminology.hl7.org/fhir/CodeSystem/medicationdispense-category', code: 'outpatient', display: 'Outpatient' }] },
          contained: [medication(`med-${n + 1}`, { is_compound: false, compound_name: null, compound_form: null, kfa_code: l.kfa_code, generic_name: l.generic_name }, [])],
          medicationReference: { reference: `#med-${n + 1}`, display: l.generic_name },
          subject: { reference: `Patient/${h.ihs_number}`, display: h.patient_name }, context: { reference: `Encounter/${h.enc_ss}` },
          ...(h.ph_ihs ? { performer: [{ actor: { reference: `Practitioner/${h.ph_ihs}`, display: h.ph_name } }] } : {}),
          authorizingPrescription: [{ reference: `MedicationRequest/${l.mr_ss}` }],
          quantity: { value: Number(l.item_qty), unit: l.uom }, whenPrepared: at, whenHandedOver: at,
        },
      })) };
      const ids = parseTransactionResponse((await client.request('POST', '', bundle)).body, toSend.length);
      if (ids.some((x) => !x)) throw new SatuSehatError('TRANSIENT', 'Respons SATUSEHAT tidak berisi ID MedicationDispense');
      const hash = hashOf(bundle);
      for (const [n, l] of toSend.entries()) {
        await upsert(c, conn, key(l), 'SENT', { attempts: (l.attempts ?? 0) + 1, satusehatId: ids[n], hash, problems: { blocking: [], warnings } }, now);
      }
    }
    await auditSys(c, 'SATUSEHAT_MEDICATION_DISPENSE_SENT', 'dispense', dispenseId, h.patient_id,
      { environment: conn.environment, lines: ready.length, reused: ready.length - toSend.length, blocked: due.length - ready.length });
    return 'SENT';
  } catch (e) {
    const out = await failAll(c, conn, ready.map(key), e, now, warnings);
    await auditSys(c, out === 'ERROR' ? 'SATUSEHAT_MEDICATION_DISPENSE_REJECTED' : out === 'DEAD' ? 'SATUSEHAT_MEDICATION_DISPENSE_DEAD' : 'SATUSEHAT_MEDICATION_DISPENSE_RETRY',
      'dispense', dispenseId, h.patient_id, { environment: conn.environment, lines: ready.length, error: (e as Error).message });
    return out;
  }
}

// ----- Koreksi diagnosis lewat addendum (OD-120) -----

interface DxChange { conceptId: string; code: string; display: string; rank: 'PRIMER' | 'SEKUNDER' }

export async function sendAddendum(c: PoolClient, client: SatuSehatClient, conn: SatuSehatConnection, addendumId: string, now: Date): Promise<SendOutcome> {
  const { rows: [a] } = await c.query<{ note_id: string; encounter_id: string; changes: { diagnoses: DxChange[] }; rec_status: string | null; attempts: number | null }>(`
    select a.note_id, n.encounter_id, a.changes, r.status as rec_status, r.attempts from app.clinical_addendum a join app.clinical_note n on n.id = a.note_id
      left join app.fhir_sync_record r on r.connection_id = $2 and r.resource_type = 'Condition' and r.local_type = 'clinical_addendum' and r.local_id = a.id
     where a.id = $1`, [addendumId, conn.id]);
  if (!a || !(await lock(c, `satusehat-enc:${a.encounter_id}`))) return a ? 'LOCKED' : 'SKIPPED';
  const { rows: [er] } = await c.query<{ id: string; satusehat_id: string }>(`
    select id, satusehat_id from app.fhir_sync_record where connection_id = $1 and resource_type = 'Encounter' and local_type = 'encounter' and local_id = $2 and status = 'SENT'`,
  [conn.id, a.encounter_id]);
  const d = await loadEncounter(c, conn, a.encounter_id);
  if (!er || !d) return 'SKIPPED';
  const attempts = a.attempts ?? 0;
  const key: Key & { attempts: number } = { resourceType: 'Condition', localType: 'clinical_addendum', localId: addendumId, parentId: er.id, attempts };
  if (d.data.patient.restricted) {
    await upsert(c, conn, key, 'SKIPPED', { problems: { blocking: ['Pemrosesan data pasien dibatasi (permintaan pasien) — tidak dikirim'], warnings: [] } }, now);
    return 'SKIPPED';
  }
  const list = a.changes.diagnoses;
  const blocking = validateEncounter({ ...d.data, conditions: list.map((x) => ({ id: x.conceptId, system: 'ICD10', code: x.code, display: x.display, rank: x.rank })),
    observations: [], procedures: [] }).blocking;
  if (blocking.length) {
    await upsert(c, conn, key, 'BLOCKED', { problems: { blocking, warnings: [] }, attempts }, now);
    return 'BLOCKED';
  }
  const { rows: current } = await c.query<{ id: string; satusehat_id: string; code: string; resource_version: number }>(`
    select r.id, r.satusehat_id, r.resource_version,
           coalesce(r.local_code, (select cc.code from app.condition_dx x join app.concept cc on cc.id = x.concept_id where x.id = r.local_id)) as code
      from app.fhir_sync_record r
     where r.parent_id = $1 and r.resource_type = 'Condition' and r.local_type in ('condition_dx', 'addendum_dx') and r.status = 'SENT' and r.entered_in_error_at is null`,
  [er.id]);
  const newCodes = new Set(list.map((x) => x.code));
  const removed = current.filter((x) => !newCodes.has(x.code));
  const kept = current.filter((x) => newCodes.has(x.code));
  const added = list.filter((x) => !current.some((y) => y.code === x.code)).map((x) => ({ ...x, localId: uuidFrom(`${addendumId}:${x.conceptId}`) }));
  const patient = { reference: `Patient/${d.data.patient.ihs}`, display: d.data.patient.name };
  const encRef = `Encounter/${er.satusehat_id}`;
  const display = (code: string) => list.find((x) => x.code === code)?.display ?? code;
  const diagnosis = list.map((x) => {
    const k = kept.find((y) => y.code === x.code);
    return { reference: k ? `Condition/${k.satusehat_id}` : `urn:uuid:${added.find((y) => y.code === x.code)!.localId}`, display: x.display, primary: x.rank === 'PRIMER' };
  });
  const entry = [
    ...removed.map((x) => ({ fullUrl: `Condition/${x.satusehat_id}`, request: { method: 'PUT', url: `Condition/${x.satusehat_id}` },
      resource: conditionResource(x.code, display(x.code), patient, encRef, { id: x.satusehat_id, enteredInError: true }) })),
    ...added.map((x) => ({ fullUrl: `urn:uuid:${x.localId}`, request: { method: 'POST', url: 'Condition' }, resource: conditionResource(x.code, x.display, patient, encRef) })),
    { fullUrl: `Encounter/${er.satusehat_id}`, request: { method: 'PUT', url: `Encounter/${er.satusehat_id}` },
      resource: encounterResource(d.data, conn.organizationId, diagnosis, er.satusehat_id) },
  ];
  const bundle = { resourceType: 'Bundle', type: 'transaction', entry };
  try {
    const ids = parseTransactionResponse((await client.request('POST', '', bundle)).body, entry.length);
    const iso = now.toISOString();
    for (const x of removed) {
      await c.query(`update app.fhir_sync_record set entered_in_error_at = $2::timestamptz, resource_version = resource_version + 1, last_sent_at = $2::timestamptz,
                     updated_at = now() where id = $1`, [x.id, iso]);
    }
    for (const [n, x] of added.entries()) {
      const id = ids[removed.length + n];
      if (!id) throw new SatuSehatError('TRANSIENT', 'Respons SATUSEHAT tidak berisi ID Condition');
      await upsert(c, conn, { resourceType: 'Condition', localType: 'addendum_dx', localId: x.localId, parentId: er.id, code: x.code }, 'SENT', { attempts: 1, satusehatId: id }, now);
    }
    await c.query(`update app.fhir_sync_record set resource_version = resource_version + 1, last_sent_at = $2::timestamptz, updated_at = now() where id = $1`, [er.id, iso]);
    await upsert(c, conn, key, 'SENT', { attempts: attempts + 1, hash: hashOf(bundle) }, now);
    // Addendum diagnosis yang lebih lama dan belum terkirim digantikan addendum ini (daftar lengkap)
    await c.query(`
      insert into app.fhir_sync_record(tenant_id, connection_id, resource_type, local_type, local_id, status, problems, parent_id)
      select app.current_tenant_id(), $1, 'Condition', 'clinical_addendum', a.id, 'SKIPPED', '{"blocking": ["Digantikan addendum diagnosis yang lebih baru"], "warnings": []}'::jsonb, $3
        from app.clinical_addendum a where a.note_id = $2 and a.changes ? 'diagnoses' and a.id <> $4
      on conflict (tenant_id, connection_id, resource_type, local_type, local_id) do update set status = 'SKIPPED', problems = excluded.problems, next_attempt_at = null,
        updated_at = now() where fhir_sync_record.status <> 'SENT'`, [conn.id, a.note_id, er.id, addendumId]);
    await auditSys(c, 'SATUSEHAT_DIAGNOSIS_UPDATED', 'clinical_addendum', addendumId, d.patientId,
      { environment: conn.environment, added: added.length, enteredInError: removed.length, attempts: attempts + 1 });
    return 'SENT';
  } catch (e) {
    const out = await failAll(c, conn, [key], e, now);
    await auditSys(c, out === 'ERROR' ? 'SATUSEHAT_DIAGNOSIS_UPDATE_REJECTED' : out === 'DEAD' ? 'SATUSEHAT_DIAGNOSIS_UPDATE_DEAD' : 'SATUSEHAT_DIAGNOSIS_UPDATE_RETRY',
      'clinical_addendum', addendumId, d.patientId, { environment: conn.environment, error: (e as Error).message });
    return out;
  }
}

/** OD-119: satu event notifikasi per koneksi selama belum terkirim (dikirim worker notify.outbox.dispatch ke admin klinik). */
export async function notifyDeadLetter(c: PoolClient, connectionId: string): Promise<number> {
  const { rowCount } = await c.query(`
    insert into app.outbox_event(tenant_id, event_type, aggregate_type, aggregate_id)
    select app.current_tenant_id(), 'SATUSEHAT_DEAD_LETTER', 'integration_connection', $1::uuid
     where not exists (select 1 from app.outbox_event where event_type = 'SATUSEHAT_DEAD_LETTER' and aggregate_id = $1::uuid and status = 'PENDING')`, [connectionId]);
  return rowCount ?? 0;
}
