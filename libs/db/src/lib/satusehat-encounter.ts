import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { decrypt } from '@clinicrme/shared/crypto';
import {
  SatuSehatError, asTenant, createSatuSehatClient, encounterSystem,
  type SatuSehatClient, type SatuSehatConnection, type SatuSehatEnvironment, type SatuSehatUrls,
} from './satusehat';

/**
 * Kunjungan rawat jalan → SATUSEHAT (Stage 12 batch 2; INT-FR-004, 008; OD-115, OD-118, OD-119 / DEC-044).
 * Satu Bundle transaction per kunjungan (Encounter + Condition ICD-10 + Observation tanda vital + Procedure ICD-9-CM)
 * setelah catatan klinis disahkan. Data divalidasi sebelum dikirim; yang belum lengkap ditandai BLOCKED dengan pesan
 * yang dapat ditindaklanjuti dan dicek ulang tiap putaran. Payload tidak disimpan — hanya hash, status, ID SATUSEHAT.
 */
export const ICD10_SYSTEM = 'http://hl7.org/fhir/sid/icd-10';
export const ICD9CM_SYSTEM = 'http://hl7.org/fhir/sid/icd-9-cm';
const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';

/** Tanda vital → LOINC + UCUM. PAIN_SCALE & OTHER belum dipetakan (peringatan, tidak memblokir). */
export const VITAL_LOINC: Record<string, { code: string; display: string; unit: string; ucum: string }> = {
  SYSTOLIC: { code: '8480-6', display: 'Systolic blood pressure', unit: 'mm[Hg]', ucum: 'mm[Hg]' },
  DIASTOLIC: { code: '8462-4', display: 'Diastolic blood pressure', unit: 'mm[Hg]', ucum: 'mm[Hg]' },
  HEART_RATE: { code: '8867-4', display: 'Heart rate', unit: 'beats/min', ucum: '/min' },
  RESP_RATE: { code: '9279-1', display: 'Respiratory rate', unit: 'breaths/min', ucum: '/min' },
  TEMPERATURE: { code: '8310-5', display: 'Body temperature', unit: 'Cel', ucum: 'Cel' },
  SPO2: { code: '59408-5', display: 'Oxygen saturation in Arterial blood by Pulse oximetry', unit: '%', ucum: '%' },
  WEIGHT: { code: '29463-7', display: 'Body weight', unit: 'kg', ucum: 'kg' },
  HEIGHT: { code: '8302-2', display: 'Body height', unit: 'cm', ucum: 'cm' },
  BMI: { code: '39156-5', display: 'Body mass index (BMI) [Ratio]', unit: 'kg/m2', ucum: 'kg/m2' },
};
/** Backoff error sementara (OD-119): ±1 m, 5 m, 30 m, 2 j, 6 j; sesudah percobaan ke-5 → DEAD. */
export const RETRY_BACKOFF_MIN = [1, 5, 30, 120, 360];

export interface EncounterData {
  id: string; encounterNo: string; status: string; arrivedAt: string | null; consultStartedAt: string | null; consultEndedAt: string | null;
  finishedAt: string | null; signedAt: string;
  patient: { ihs: string | null; ihsStatus: string; name: string; restricted: boolean };
  practitioner: { ihs: string | null; name: string };
  unit: { name: string; locationId: string | null };
  conditions: { id: string; system: string; code: string; display: string; rank: 'PRIMER' | 'SEKUNDER' }[];
  observations: { id: string; code: string; value: number | null; recordedAt: string }[];
  procedures: { id: string; icd9: string | null; name: string; performedAt: string }[];
}
export interface Problems { blocking: string[]; warnings: string[] }

const ICD10_RE = /^[A-Z]\d{2}(\.\d{1,2})?$/;

/** INT-FR-008: masalah yang memblokir pengiriman + peringatan (bagian yang dilewati). Pesan tanpa isi rekam medis. */
export function validateEncounter(d: EncounterData): Problems {
  const blocking: string[] = [];
  const warnings: string[] = [];
  if (d.patient.ihsStatus !== 'FOUND' || !d.patient.ihs) {
    blocking.push(d.patient.ihsStatus === 'NOT_APPLICABLE' ? 'Pasien tanpa NIK belum dapat dikirim ke SATUSEHAT'
      : d.patient.ihsStatus === 'NOT_FOUND' ? 'NIK pasien tidak ditemukan di SATUSEHAT — periksa NIK' : 'Pasien belum punya nomor IHS — tunggu pencarian otomatis atau klik "Cari di SATUSEHAT"');
  }
  if (!d.practitioner.ihs) blocking.push(`Dokter ${d.practitioner.name} belum punya IHS SATUSEHAT — lengkapi NIK lalu jalankan Sinkron master`);
  if (!d.unit.locationId) blocking.push(`${d.unit.name} belum terdaftar sebagai Location — jalankan Sinkron master`);
  if (!d.arrivedAt) blocking.push('Waktu kedatangan pasien kosong');
  if (!d.conditions.some((c) => c.rank === 'PRIMER')) blocking.push('Diagnosis primer belum diisi');
  for (const c of d.conditions) {
    if (c.system !== 'ICD10' || !ICD10_RE.test(c.code)) blocking.push(`Kode diagnosis ${c.code} bukan ICD-10 yang valid`);
  }
  for (const o of d.observations) {
    if (!VITAL_LOINC[o.code]) warnings.push(`Pengukuran ${o.code} belum dipetakan ke LOINC — tidak dikirim`);
    else if (o.value === null) warnings.push(`Pengukuran ${o.code} tanpa nilai angka — tidak dikirim`);
  }
  for (const p of d.procedures) if (!p.icd9) warnings.push(`Tindakan ${p.name} belum punya kode ICD-9-CM — tidak dikirim`);
  return { blocking, warnings };
}

export interface BuiltBundle { bundle: Record<string, unknown>; entries: { resourceType: string; localType: string; localId: string }[]; hash: string }

/**
 * Bundle transaction (OD-115). Bila Encounter sudah ada di SATUSEHAT (mis. pembaruan addendum, batch 3), `existingEncounterId`
 * dipakai sebagai rujukan dan Encounter tidak dibuat ulang (idempoten).
 */
export function buildEncounterBundle(d: EncounterData, orgId: string, existingEncounterId?: string | null): BuiltBundle {
  const encRef = existingEncounterId ? `Encounter/${existingEncounterId}` : `urn:uuid:${d.id}`;
  const patient = { reference: `Patient/${d.patient.ihs}`, display: d.patient.name };
  const practitioner = { reference: `Practitioner/${d.practitioner.ihs}`, display: d.practitioner.name };
  const start = d.arrivedAt as string;
  const inProg = d.consultStartedAt ?? start;
  const end = d.consultEndedAt ?? d.finishedAt ?? d.signedAt;
  const entries: BuiltBundle['entries'] = [];
  const entry: Record<string, unknown>[] = [];
  const conds = d.conditions.filter((c) => c.system === 'ICD10');
  const rankOrder = [...conds].sort((a, b) => (a.rank === b.rank ? 0 : a.rank === 'PRIMER' ? -1 : 1));
  if (!existingEncounterId) {
    entries.push({ resourceType: 'Encounter', localType: 'encounter', localId: d.id });
    entry.push({
      fullUrl: `urn:uuid:${d.id}`, request: { method: 'POST', url: 'Encounter' },
      resource: {
        resourceType: 'Encounter', status: 'finished',
        identifier: [{ system: encounterSystem(orgId), value: d.encounterNo }],
        class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
        subject: patient,
        participant: [{ type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'ATND', display: 'attender' }] }],
          individual: practitioner }],
        period: { start, end },
        location: [{ location: { reference: `Location/${d.unit.locationId}`, display: d.unit.name } }],
        diagnosis: rankOrder.map((c, i) => ({ condition: { reference: `urn:uuid:${c.id}`, display: c.display },
          use: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/diagnosis-role', code: 'DD', display: 'Discharge diagnosis' }] }, rank: i + 1 })),
        statusHistory: [
          { status: 'arrived', period: { start, end: inProg } },
          { status: 'in-progress', period: { start: inProg, end } },
          { status: 'finished', period: { start: end, end } },
        ],
        serviceProvider: { reference: `Organization/${orgId}` },
      },
    });
  }
  for (const c of conds) {
    entries.push({ resourceType: 'Condition', localType: 'condition_dx', localId: c.id });
    entry.push({ fullUrl: `urn:uuid:${c.id}`, request: { method: 'POST', url: 'Condition' }, resource: {
      resourceType: 'Condition',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active', display: 'Active' }] },
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis', display: 'Encounter Diagnosis' }] }],
      code: { coding: [{ system: ICD10_SYSTEM, code: c.code, display: c.display }] },
      subject: patient, encounter: { reference: encRef },
    } });
  }
  for (const o of d.observations) {
    const m = VITAL_LOINC[o.code];
    if (!m || o.value === null) continue;
    entries.push({ resourceType: 'Observation', localType: 'observation', localId: o.id });
    entry.push({ fullUrl: `urn:uuid:${o.id}`, request: { method: 'POST', url: 'Observation' }, resource: {
      resourceType: 'Observation', status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] }],
      code: { coding: [{ system: LOINC, code: m.code, display: m.display }] },
      subject: patient, performer: [practitioner], encounter: { reference: encRef },
      effectiveDateTime: o.recordedAt, issued: o.recordedAt,
      valueQuantity: { value: o.value, unit: m.unit, system: UCUM, code: m.ucum },
    } });
  }
  for (const p of d.procedures) {
    if (!p.icd9) continue;
    entries.push({ resourceType: 'Procedure', localType: 'procedure_act', localId: p.id });
    entry.push({ fullUrl: `urn:uuid:${p.id}`, request: { method: 'POST', url: 'Procedure' }, resource: {
      resourceType: 'Procedure', status: 'completed',
      code: { coding: [{ system: ICD9CM_SYSTEM, code: p.icd9, display: p.name }] },
      subject: patient, encounter: { reference: encRef },
      performedPeriod: { start: p.performedAt, end: p.performedAt },
      performer: [{ actor: practitioner }],
    } });
  }
  const bundle = { resourceType: 'Bundle', type: 'transaction', entry };
  return { bundle, entries, hash: createHash('sha256').update(JSON.stringify(bundle)).digest('hex') };
}

/** ID dari `response.location` ("Encounter/<id>/_history/1") per entry, berurutan sesuai permintaan (FHIR transaction). */
export function parseTransactionResponse(body: Record<string, unknown>, count: number): (string | null)[] {
  const e = ((body as { entry?: { response?: { location?: string; resourceID?: string } }[] }).entry ?? []);
  return Array.from({ length: count }, (_, i) => {
    const r = e[i]?.response;
    return r?.resourceID ?? r?.location?.match(/^[A-Za-z]+\/([^/]+)/)?.[1] ?? null;
  });
}

// ----- Pengiriman -----

export interface SendOptions { keyHex: string; urls?: SatuSehatUrls; batch?: number; now?: Date; allowSimulator?: boolean;
  clientFactory?: (c: SatuSehatConnection) => SatuSehatClient }
export type SendOutcome = 'SENT' | 'BLOCKED' | 'SKIPPED' | 'ERROR' | 'RETRY' | 'DEAD' | 'LOCKED';

/** Worker: per tenant & per koneksi aktif, kunjungan disahkan yang belum terkirim / tertahan / waktunya dicoba ulang. */
export async function sendPendingEncounters(pool: Pool, o: SendOptions): Promise<Record<SendOutcome, number> & { failedTenants: number }> {
  const total = { SENT: 0, BLOCKED: 0, SKIPPED: 0, ERROR: 0, RETRY: 0, DEAD: 0, LOCKED: 0, failedTenants: 0 };
  const c = await pool.connect();
  try {
    const { rows: ts } = await c.query<{ id: string }>(`select id from app.tenant where status in ('TRIAL','ACTIVE','GRACE') order by id`);
    for (const t of ts) {
      try {
        await asTenant(c, t.id, async () => {
          for (const conn of await activeConnections(c, o.keyHex)) {
            if (conn.environment === 'SIMULATOR' && o.allowSimulator === false) continue;
            const client = (o.clientFactory ?? ((x) => createSatuSehatClient(x, o.urls)))(conn);
            const now = (o.now ?? new Date()).toISOString();
            const { rows } = await c.query<{ id: string }>(`
              select e.id from app.encounter e join app.clinical_note n on n.encounter_id = e.id and n.status = 'SIGNED'
                join app.branch b on b.id = e.branch_id
                left join app.fhir_sync_record r on r.connection_id = $1 and r.resource_type = 'Encounter' and r.local_type = 'encounter' and r.local_id = e.id
               where b.facility_id = $2 and e.status <> 'CANCELLED'
                 and (r.id is null or r.status = 'BLOCKED' or (r.status = 'PENDING' and (r.next_attempt_at is null or r.next_attempt_at <= $3::timestamptz)))
               order by n.signed_at limit $4`, [conn.id, conn.facilityId, now, o.batch ?? 20]);
            for (const e of rows) total[await sendEncounter(c, client, conn, e.id, { now: o.now })]++;
          }
        });
      } catch (e) {
        if (!(e instanceof SatuSehatError)) throw e;
        total.failedTenants++;   // kredensial ditolak di satu klinik tidak menghentikan klinik lain
      }
    }
    return total;
  } finally {
    c.release();
  }
}

/**
 * Kirim satu kunjungan (dipanggil dalam transaksi tenant). AUTH dilempar ke pemanggil (seluruh koneksi bermasalah);
 * VALIDATION → ERROR (tidak di-retry); TRANSIENT → dicoba ulang dengan backoff, lalu DEAD.
 */
export async function sendEncounter(c: PoolClient, client: SatuSehatClient, conn: SatuSehatConnection, encounterId: string,
                                    o: { now?: Date; manual?: boolean } = {}): Promise<SendOutcome> {
  const { rows: [lk] } = await c.query<{ ok: boolean }>(`select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as ok`, [`satusehat-enc:${encounterId}`]);
  if (!lk.ok) return 'LOCKED';
  const now = o.now ?? new Date();
  const d = await loadEncounter(c, conn, encounterId);
  if (!d) return 'SKIPPED';
  const { rows: [prev] } = await c.query<{ id: string; status: string; attempts: number; satusehat_id: string | null }>(`
    select id, status, attempts, satusehat_id from app.fhir_sync_record
     where connection_id = $1 and resource_type = 'Encounter' and local_type = 'encounter' and local_id = $2`, [conn.id, encounterId]);
  if (prev?.status === 'SENT') return 'SENT';
  const upsert = async (status: string, f: { problems?: Problems; error?: string | null; attempts?: number; next?: Date | null; satusehatId?: string | null; hash?: string | null }) => {
    const { rows: [r] } = await c.query<{ id: string }>(`
      insert into app.fhir_sync_record(tenant_id, connection_id, resource_type, local_type, local_id, status, attempts, last_error, problems, next_attempt_at,
                                       satusehat_id, payload_hash, last_sent_at)
      values (app.current_tenant_id(), $1, 'Encounter', 'encounter', $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8, $9, case when $3 = 'SENT' then $10::timestamptz end)
      on conflict (tenant_id, connection_id, resource_type, local_type, local_id) do update
        set status = excluded.status, attempts = excluded.attempts, last_error = excluded.last_error, problems = excluded.problems,
            next_attempt_at = excluded.next_attempt_at, satusehat_id = coalesce(excluded.satusehat_id, fhir_sync_record.satusehat_id),
            payload_hash = coalesce(excluded.payload_hash, fhir_sync_record.payload_hash),
            last_sent_at = coalesce(excluded.last_sent_at, fhir_sync_record.last_sent_at), updated_at = now()
      returning id`, [conn.id, encounterId, status, f.attempts ?? prev?.attempts ?? 0, f.error ?? null, JSON.stringify(f.problems ?? { blocking: [], warnings: [] }),
        f.next ? f.next.toISOString() : null, f.satusehatId ?? null, f.hash ?? null, now.toISOString()]);
    return r.id;
  };
  const auditSys = (action: string, summary: object) => c.query(`select app.write_audit($1, 'encounter', $2::uuid, $3::uuid, $4::jsonb, 'SYSTEM', null, null)`,
    [action, encounterId, d.patientId, JSON.stringify({ encounterNo: d.data.encounterNo, environment: conn.environment, ...summary })]);

  if (d.data.patient.restricted) {
    await upsert('SKIPPED', { problems: { blocking: ['Pemrosesan data pasien dibatasi (permintaan pasien) — tidak dikirim'], warnings: [] } });
    return 'SKIPPED';
  }
  const problems = validateEncounter(d.data);
  if (problems.blocking.length) {
    await upsert('BLOCKED', { problems });
    return 'BLOCKED';
  }
  // Percobaan sebelumnya gagal sementara: respons bisa hilang padahal Encounter sudah tersimpan → cari dulu per identifier
  let existing: string | null = prev?.satusehat_id ?? null;
  const attempts = (prev?.attempts ?? 0) + 1;
  try {
    if (!existing && (prev?.attempts ?? 0) > 0) {
      const r = await client.request('GET', `/Encounter?identifier=${encodeURIComponent(`${encounterSystem(conn.organizationId)}|${d.data.encounterNo}`)}`);
      existing = ((r.body as { entry?: { resource?: { id?: string } }[] }).entry ?? [])[0]?.resource?.id ?? null;
    }
    // Bundle transaction bersifat atomik: bila Encounter ternyata sudah tersimpan, seluruh isinya juga tersimpan → jangan kirim ulang
    // (mencegah duplikat). ID sumber daya turunan diisi saat rekonsiliasi (batch 4).
    const built = buildEncounterBundle(d.data, conn.organizationId, null);
    const ids = existing ? built.entries.map(() => null)
      : parseTransactionResponse((await client.request('POST', '', built.bundle)).body, built.entries.length);
    const encId = existing ?? ids[built.entries.findIndex((x) => x.resourceType === 'Encounter')] ?? null;
    if (!encId) throw new SatuSehatError('TRANSIENT', 'Respons SATUSEHAT tidak berisi ID Encounter');
    const parent = await upsert('SENT', { problems, attempts, satusehatId: encId, hash: built.hash });
    for (const [i, x] of built.entries.entries()) {
      if (x.resourceType === 'Encounter') continue;
      await c.query(`
        insert into app.fhir_sync_record(tenant_id, connection_id, resource_type, local_type, local_id, status, attempts, satusehat_id, last_sent_at, parent_id)
        values (app.current_tenant_id(), $1, $2, $3, $4, 'SENT', 1, $5, $6::timestamptz, $7)
        on conflict (tenant_id, connection_id, resource_type, local_type, local_id) do update
          set status = 'SENT', satusehat_id = excluded.satusehat_id, last_sent_at = excluded.last_sent_at, parent_id = excluded.parent_id,
              attempts = fhir_sync_record.attempts + 1, last_error = null, updated_at = now()`,
        [conn.id, x.resourceType, x.localType, x.localId, ids[i], now.toISOString(), parent]);
    }
    await c.query(`update app.encounter set satusehat_id = $2 where id = $1 and satusehat_id is distinct from $2`, [encounterId, encId]);
    const count = (t: string) => built.entries.filter((x) => x.resourceType === t).length;
    await auditSys('SATUSEHAT_ENCOUNTER_SENT', { attempts, reusedEncounter: !!existing, conditions: count('Condition'), observations: count('Observation'),
      procedures: count('Procedure'), warnings: problems.warnings.length, manual: !!o.manual });
    return 'SENT';
  } catch (e) {
    if (!(e instanceof SatuSehatError)) throw e;
    if (e.kind === 'AUTH') throw e;
    if (e.kind === 'VALIDATION' || e.kind === 'NOT_FOUND') {
      await upsert('ERROR', { problems: { blocking: e.issues.length ? e.issues : [e.message], warnings: problems.warnings }, error: e.message, attempts, satusehatId: existing });
      await auditSys('SATUSEHAT_ENCOUNTER_REJECTED', { attempts, error: e.message });
      return 'ERROR';
    }
    const dead = attempts >= RETRY_BACKOFF_MIN.length;
    await upsert(dead ? 'DEAD' : 'PENDING', { problems, error: e.message, attempts, satusehatId: existing,
      next: dead ? null : new Date(now.getTime() + RETRY_BACKOFF_MIN[attempts - 1] * 60_000) });
    await auditSys(dead ? 'SATUSEHAT_ENCOUNTER_DEAD' : 'SATUSEHAT_ENCOUNTER_RETRY', { attempts, error: e.message });
    return dead ? 'DEAD' : 'RETRY';
  }
}

async function loadEncounter(c: PoolClient, conn: SatuSehatConnection, id: string): Promise<{ data: EncounterData; patientId: string } | null> {
  const { rows: [e] } = await c.query<{ id: string; encounter_no: string; status: string; arrived_at: Date | null; consult_started_at: Date | null; consult_ended_at: Date | null;
    finished_at: Date | null; signed_at: Date | null; patient_id: string; ihs_number: string | null; ihs_status: string; patient_name: string; restricted: boolean;
    pr_ihs: string | null; pr_name: string; unit_name: string; location_id: string | null }>(`
    select e.id, e.encounter_no, e.status, e.arrived_at, e.consult_started_at, e.consult_ended_at, e.finished_at, n.signed_at,
           e.patient_id, p.ihs_number, p.ihs_status, p.full_name as patient_name, p.processing_restricted as restricted,
           pr.satusehat_ihs_id as pr_ihs, pr.full_name as pr_name, u.name as unit_name, l.satusehat_id as location_id
      from app.encounter e join app.patient p on p.id = e.patient_id join app.practitioner pr on pr.id = e.practitioner_id
      join app.service_unit u on u.id = e.unit_id join app.clinical_note n on n.encounter_id = e.id and n.status = 'SIGNED'
      left join app.fhir_sync_record l on l.connection_id = $2 and l.resource_type = 'Location' and l.local_type = 'service_unit' and l.local_id = u.id and l.status = 'SENT'
     where e.id = $1`, [id, conn.id]);
  if (!e) return null;
  const iso = (x: Date | null) => (x ? x.toISOString() : null);
  const { rows: conds } = await c.query<{ id: string; system: string; code: string; display: string; rank: 'PRIMER' | 'SEKUNDER' }>(`
    select d.id, cs.code as system, c.code, coalesce(c.display_en, c.display_id) as display, d.rank
      from app.condition_dx d join app.concept c on c.id = d.concept_id join app.code_system cs on cs.id = c.system_id
     where d.encounter_id = $1 order by d.rank, d.created_at`, [id]);
  // Tanda vital: nilai terakhir per jenis
  const { rows: obs } = await c.query<{ id: string; code: string; value_num: string | null; recorded_at: Date }>(`
    select distinct on (code) id, code, value_num::text, recorded_at from app.observation where encounter_id = $1 order by code, recorded_at desc`, [id]);
  const { rows: procs } = await c.query<{ id: string; icd9: string | null; name: string; performed_at: Date }>(`
    select a.id, s.icd9cm_code as icd9, s.name, a.performed_at from app.procedure_act a join app.service_item s on s.id = a.service_item_id
     where a.encounter_id = $1 order by a.performed_at`, [id]);
  return {
    patientId: e.patient_id,
    data: {
      id: e.id, encounterNo: e.encounter_no, status: e.status, arrivedAt: iso(e.arrived_at), consultStartedAt: iso(e.consult_started_at),
      consultEndedAt: iso(e.consult_ended_at), finishedAt: iso(e.finished_at), signedAt: iso(e.signed_at) as string,
      patient: { ihs: e.ihs_number, ihsStatus: e.ihs_status, name: e.patient_name, restricted: e.restricted },
      practitioner: { ihs: e.pr_ihs, name: e.pr_name },
      unit: { name: e.unit_name, locationId: e.location_id },
      conditions: conds,
      observations: obs.map((x) => ({ id: x.id, code: x.code, value: x.value_num === null ? null : Number(x.value_num), recordedAt: x.recorded_at.toISOString() })),
      procedures: procs.map((x) => ({ id: x.id, icd9: x.icd9, name: x.name, performedAt: x.performed_at.toISOString() })),
    },
  };
}

async function activeConnections(c: PoolClient, keyHex: string): Promise<SatuSehatConnection[]> {
  const { rows } = await c.query<{ id: string; facility_id: string; environment: SatuSehatEnvironment; client_id: string; secret_encrypted: Buffer; organization_id: string }>(`
    select id, facility_id, environment, client_id, secret_encrypted, organization_id from app.integration_connection where kind = 'SATUSEHAT' and is_active order by facility_id`);
  return rows.map((r) => ({ id: r.id, facilityId: r.facility_id, environment: r.environment, clientId: r.client_id, clientSecret: decrypt(keyHex, r.secret_encrypted),
    organizationId: r.organization_id }));
}
