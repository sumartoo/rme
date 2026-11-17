/* eslint-disable @typescript-eslint/no-explicit-any -- isi Bundle FHIR diperiksa sebagai struktur bebas */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { blindIndex } from '@clinicrme/shared';
import { encrypt } from '@clinicrme/shared/crypto';
import { type Mail, dispatchNotifications } from '@clinicrme/db/notifications';
import { SatuSehatError, SimulatorSatuSehatClient, simulatorReset, type SatuSehatConnection } from '@clinicrme/db/satusehat';
import { sendPendingEncounters } from '@clinicrme/db/satusehat-encounter';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, ownerUrl, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 12 batch 3 — obat (MedicationRequest/Dispense, KFA), retry & dead-letter + notifikasi, kirim ulang manual, koreksi diagnosis
 * lewat addendum (INT-FR-005, 009, 012; OD-118, OD-119, OD-120 / DEC-044). Semua terhadap **simulator**. Data sintetis.
 */
const HOST = 'klinik-a.clinicrme.test';
const KEY = 'a'.repeat(64);
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const FACILITY = A(1), BRANCH = A(10), UNIT = A(11), DR = A(20), TAB = A(40), PCT = A(41), AMX = A(42), LOC = A(50), BATCH = A(51);
const ICD10_R50 = 'c1000000-0000-0000-0000-000000000001', ICD10_J06 = 'c1000000-0000-0000-0000-000000000002';
const SECRET = 'rahasia-simulator-uji';   // pragma: allowlist secret — nilai sintetis untuk simulator
let app: INestApplication;
let http: ReturnType<typeof request>;
let pool: Pool;

type Jar = { cookie: string; csrf: string };
async function login(email: string): Promise<Jar> {
  const r = await http.post('/api/v1/auth/login').set('Host', HOST).send({ email, password: PASSWORD });
  expect([email, r.status]).toEqual([email, 200]);
  const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const csrf = get('crme_csrf');
  return { cookie: [get('crme_session'), csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '' };
}
const get = (path: string, j: Jar) => http.get(path).set('Host', HOST).set('Cookie', j.cookie);
const post = (path: string, j: Jar) => http.post(path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
let admin: Jar, dokter: Jar, kasir: Jar;

// Klien simulator yang dapat diatur: 'ok' | 'transient' (503) | 'lost' (tersimpan, respons hilang). Bundle yang dikirim direkam.
let mode: 'ok' | 'transient' | 'lost' = 'ok';
const sent: { entry: { request: { method: string; url: string }; resource: Record<string, unknown> }[] }[] = [];
const factory = (conn: SatuSehatConnection) => {
  const sim = new SimulatorSatuSehatClient(conn);
  return {
    environment: sim.environment,
    async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
      if (method === 'POST' && path === '') {
        const b = body as (typeof sent)[number];
        const encounterBundle = b.entry.some((e) => e.resource['resourceType'] === 'Encounter' && e.request.method === 'POST');
        if (!encounterBundle) {
          sent.push(b);
          if (mode === 'transient') throw new SatuSehatError('TRANSIENT', 'SATUSEHAT sementara gagal (HTTP 503)', 503);
          if (mode === 'lost') { await sim.request(method, path, body); throw new SatuSehatError('TRANSIENT', 'SATUSEHAT tidak merespons (timeout)'); }
        }
      }
      return sim.request(method, path, body);
    },
  };
};
const run = (now?: Date) => sendPendingEncounters(pool, { keyHex: KEY, now, clientFactory: factory });
const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const recs = (type: string, localIds: string[]) => su(`select local_id, status, attempts, satusehat_id, problems, local_code, parent_id, last_error from app.fhir_sync_record
  where resource_type = $1 and local_id = any($2::uuid[]) order by local_id`, [type, localIds]);
const status = async (encId: string) => (await get(`/api/v1/encounters/${encId}/satusehat`, dokter)).body;

let seq = 0;
/** Kunjungan disahkan (langsung di DB) dengan diagnosis R50.9 primer. */
async function encounter(o: { restricted?: boolean; ihs?: boolean; patientId?: string } = {}) {
  const n = ++seq;
  const nik = `317101010191${String(1000 + n).slice(-4)}`;
  const [{ id: pid }] = o.patientId ? [{ id: o.patientId }] : await su(`insert into app.patient(tenant_id, mrn, full_name, birth_date, sex, identity_type, nik_encrypted, nik_hash, ihs_status, ihs_number)
    values ($1, $2, 'Pasien Sintetis V', '1990-01-01', 'P', 'NIK', $3, $4, $5, $6) returning id`,
  [ids.tenantA, `RM-V-${n}`, encrypt(KEY, nik), blindIndex(KEY, 'patient-nik', nik), o.ihs === false ? 'PENDING' : 'FOUND', o.ihs === false ? null : `P${3000000000 + n}`]);
  const [{ id }] = await su(`insert into app.encounter(tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, arrival_type, status,
      arrived_at, consult_started_at, consult_ended_at, finished_at)
    values ($1, $2, $3, $4, $5, $6, 'WALK_IN', 'FINISHED', now() - interval '60 minutes', now() - interval '50 minutes', now() - interval '30 minutes', now()) returning id`,
  [ids.tenantA, `KJ-V-${n}`, pid, BRANCH, UNIT, DR]);
  await su(`insert into app.condition_dx(tenant_id, encounter_id, concept_id, rank) values ($1, $2, $3, 'PRIMER')`, [ids.tenantA, id, ICD10_R50]);
  const [{ id: noteId }] = await su(`insert into app.clinical_note(tenant_id, encounter_id, subjective, assessment) values ($1, $2, 'Keluhan', 'Penilaian') returning id`, [ids.tenantA, id]);
  await su(`update app.clinical_note set status = 'SIGNED', signed_by = $2, signed_at = now() - interval '20 minutes', content_hash = 'hash-uji', signer_user_id = $3,
    sign_method = 'PASSWORD' where id = $1`, [noteId, DR, ids.dokterA]);
  if (o.restricted) await su(`update app.patient set processing_restricted = true, restriction_reason = 'Permintaan pasien (uji)', restricted_at = now() where id = $1`, [pid]);
  return { id: id as string, noteId: noteId as string, patientId: pid as string };
}
type Item = { drug: string } | { compound: string; comps: string[] };
/** Resep terbit: dibuat DRAFT lalu diterbitkan (isi resep terkunci setelah terbit). */
async function prescription(encId: string, no: string, items: Item[]) {
  const [{ id }] = await su(`insert into app.prescription(tenant_id, prescription_no, encounter_id, prescriber_id) values ($1, $2, $3, $4) returning id`,
    [ids.tenantA, no, encId, DR]);
  const itemIds: string[] = [];
  for (const [i, it] of items.entries()) {
    const compound = 'compound' in it;
    const [{ id: iid }] = await su(`insert into app.prescription_item(tenant_id, prescription_id, line_no, is_compound, drug_item_id, compound_name, compound_form, dose, frequency,
        route, duration_days, qty, uom_id, instructions, dose_qty, times_per_day)
      values ($1, $2, $3, $4, $5, $6, $7, '1 tablet', '3x sehari', 'ORAL', 3, 9, $8, 'Sesudah makan', 1, 3) returning id`,
    [ids.tenantA, id, i + 1, compound, compound ? null : it.drug, compound ? it.compound : null, compound ? 'Puyer' : null, TAB]);
    if (compound) for (const d of it.comps) await su(`insert into app.prescription_compound_component(tenant_id, prescription_item_id, drug_item_id, qty, uom_id) values ($1, $2, $3, 0.5, $4)`,
      [ids.tenantA, iid, d, TAB]);
    itemIds.push(iid);
  }
  await su(`update app.prescription set status = 'ISSUED', issued_at = now() - interval '25 minutes' where id = $1`, [id]);
  return { id: id as string, items: itemIds };
}
async function dispense(rxId: string, lines: { item: string; drug: string; qty: number }[], o: { pharmacist?: string } = {}) {
  const [{ id }] = await su(`insert into app.dispense(tenant_id, prescription_id, location_id, dispensed_by, pharmacist_id, dispensed_at) values ($1, $2, $3, $4, $5, now()) returning id`,
    [ids.tenantA, rxId, LOC, ids.dokterA, o.pharmacist ?? null]);
  const lineIds: string[] = [];
  for (const l of lines) {
    const [{ id: lid }] = await su(`insert into app.dispense_line(tenant_id, dispense_id, prescription_item_id, batch_id, qty_base, drug_item_id, unit_price, item_qty)
      values ($1, $2, $3, $4, $5, $6, 1000, $5) returning id`, [ids.tenantA, id, l.item, BATCH, l.qty, l.drug]);
    lineIds.push(lid);
  }
  return { id: id as string, lines: lineIds };
}

beforeAll(async () => {
  await resetDatabase();
  simulatorReset();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  pool = new Pool({ connectionString: ownerUrl(), max: 2 });
  await su(`update app.role set requires_mfa = false where code in ('TENANT_ADMIN', 'KASIR')`);
  admin = await login('admin@a.test');
  dokter = await login('dokter@a.test');
  kasir = await login('kasir@a.test');
  expect((await http.put('/api/v1/integrations/satusehat').set('Host', HOST).set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf)
    .send({ facilityId: FACILITY, environment: 'SIMULATOR', clientId: 'client-simulasi-001', clientSecret: SECRET, organizationId: '10000004' })).status).toBe(200);
  await su(`update app.practitioner set nik_encrypted = $2, nik_hash = $3, sip_number = 'SIP/UJI/001', sip_valid_until = current_date + 365 where id = $1`,
    [DR, encrypt(KEY, '3171010101900001'), blindIndex(KEY, 'practitioner-nik', '3171010101900001')]);
  expect((await post('/api/v1/integrations/satusehat/sync-master', admin).send({ facilityId: FACILITY })).body.practitioners.found).toBe(1);
  await su(`update app.drug_item set kfa_code = '93000001' where id = $1`, [PCT]);   // AMX belum punya kode KFA
}, 60_000);
afterAll(async () => { await pool?.end(); await app?.close(); });
beforeEach(() => { mode = 'ok'; sent.length = 0; });

describe('Obat: MedicationRequest & MedicationDispense (INT-FR-005, OD-118)', () => {
  test('V01 resep terbit dikirim setelah Encounter terkirim; obat/racikan tanpa KFA → BLOCKED "butuh kode KFA"; setelah dilengkapi → terkirim', async () => {
    const waiting = await encounter({ ihs: false });           // Encounter BLOCKED → resep belum dikirim
    const rxW = await prescription(waiting.id, 'RX-V-0001', [{ drug: PCT }]);
    const e = await encounter();
    const rx = await prescription(e.id, 'RX-V-0002', [{ drug: PCT }, { drug: AMX }, { compound: 'Puyer batuk', comps: [PCT, AMX] }]);
    const r = await run();
    expect(r).toMatchObject({ SENT: 1, BLOCKED: 1 });
    expect(r.followUp.SENT).toBe(1);
    expect(await recs('MedicationRequest', rxW.items)).toEqual([]);
    const [mr1, mr2, mr3] = rx.items;
    const byId = Object.fromEntries((await recs('MedicationRequest', rx.items)).map((x) => [x.local_id, x]));
    const [{ id: encRec }] = await su(`select id from app.fhir_sync_record where resource_type = 'Encounter' and local_id = $1`, [e.id]);
    expect(byId[mr1]).toMatchObject({ status: 'SENT', attempts: 1, local_code: '93000001', parent_id: encRec, satusehat_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(byId[mr2]).toMatchObject({ status: 'BLOCKED', problems: { blocking: ['Obat Amoksisilin 500 mg butuh kode KFA — isi di Master obat'] } });
    expect(byId[mr3]).toMatchObject({ status: 'BLOCKED', problems: { blocking: ['Racikan Puyer batuk: Amoksisilin 500 mg butuh kode KFA — isi di Master obat'] } });
    // Isi Bundle: identifier resep & item resep, Medication contained berkode KFA, rujukan Encounter/Practitioner
    const mr = sent[0].entry[0].resource as Record<string, any>;
    expect(sent[0].entry).toHaveLength(1);
    expect(mr).toMatchObject({
      resourceType: 'MedicationRequest', status: 'active', intent: 'order',
      identifier: [{ system: 'http://sys-ids.kemkes.go.id/prescription/10000004', value: 'RX-V-0002' },
        { system: 'http://sys-ids.kemkes.go.id/prescription-item/10000004', value: 'RX-V-0002-1' }],
      medicationReference: { reference: '#med-1' }, contained: [{ resourceType: 'Medication', id: 'med-1', code: { coding: [{ system: 'http://sys-ids.kemkes.go.id/kfa', code: '93000001' }] } }],
      subject: { reference: expect.stringMatching(/^Patient\/P\d{10}$/) }, requester: { reference: expect.stringMatching(/^Practitioner\/1\d{10}$/) },
      encounter: { reference: expect.stringMatching(/^Encounter\/[0-9a-f-]{36}$/) },
      dosageInstruction: [{ timing: { repeat: { frequency: 3, period: 1, periodUnit: 'd' } }, route: { text: 'Oral' }, patientInstruction: 'Sesudah makan' }],
      dispenseRequest: { quantity: { value: 9, unit: 'Tablet' }, expectedSupplyDuration: { value: 3, code: 'd' } },
    });
    const s = await status(e.id);
    expect(s.resources.filter((x: { resourceType: string }) => x.resourceType === 'MedicationRequest').map((x: { status: string }) => x.status).sort())
      .toEqual(['BLOCKED', 'BLOCKED', 'SENT']);
    expect((await run()).followUp.BLOCKED).toBe(1);               // tetap tertahan, dicek ulang
    // Dilengkapi di Master obat → racikan dikirim dengan bahan berkode KFA
    await su(`update app.drug_item set kfa_code = '93000002' where id = $1`, [AMX]);
    sent.length = 0;
    expect((await run()).followUp.SENT).toBe(1);
    expect((await recs('MedicationRequest', [mr2, mr3])).map((x) => x.status)).toEqual(['SENT', 'SENT']);
    const compound = sent[0].entry.map((x) => x.resource as Record<string, any>).find((x) => x['contained'][0].ingredient);
    expect(compound?.['contained'][0]).toMatchObject({ code: { text: 'Puyer batuk' } });
    expect(compound?.['contained'][0].ingredient.map((g: any) => g.itemCodeableConcept.coding[0]).sort((x: any, y: any) => x.code.localeCompare(y.code)))
      .toEqual([{ system: 'http://sys-ids.kemkes.go.id/kfa', code: '93000001', display: 'Parasetamol 500 mg' },
        { system: 'http://sys-ids.kemkes.go.id/kfa', code: '93000002', display: 'Amoksisilin 500 mg' }]);
    const [a] = await su(`select actor_kind, change_summary::text as s from app.audit_log where action = 'SATUSEHAT_MEDICATION_REQUEST_SENT' and resource_id = $1 order by seq limit 1`, [rx.id]);
    expect(a.actor_kind).toBe('SYSTEM');
    expect(a.s).not.toMatch(/Pasien Sintetis|Parasetamol|93000001/);
    expect((await run()).followUp.SENT).toBe(0);                  // tidak dikirim dua kali
  });

  test('V02 penyerahan obat → MedicationDispense merujuk MedicationRequest; menunggu resep yang tertahan; penyerahan sebagian berikutnya ber-identifier unik', async () => {
    await su(`update app.drug_item set kfa_code = null where id = $1`, [AMX]);
    const e = await encounter();
    const rx = await prescription(e.id, 'RX-V-0003', [{ drug: PCT }, { drug: AMX }]);
    await run();
    const d1 = await dispense(rx.id, [{ item: rx.items[0], drug: PCT, qty: 5 }, { item: rx.items[1], drug: AMX, qty: 9 }]);
    sent.length = 0;
    await run();
    const [l1, l2] = d1.lines;
    const byId = Object.fromEntries((await recs('MedicationDispense', d1.lines)).map((x) => [x.local_id, x]));
    expect(byId[l1]).toMatchObject({ status: 'SENT', local_code: '93000001', problems: { warnings: ['Apoteker penyerah tanpa IHS SATUSEHAT — performer tidak dikirim'] } });
    expect(byId[l2]).toMatchObject({ status: 'BLOCKED', problems: { blocking: [
      'Resep obat Amoksisilin 500 mg belum terkirim ke SATUSEHAT — selesaikan masalah resep lebih dulu', 'Obat Amoksisilin 500 mg butuh kode KFA — isi di Master obat'] } });
    const [{ satusehat_id: mrId }] = await recs('MedicationRequest', [rx.items[0]]);
    const md = sent.flatMap((b) => b.entry).map((x) => x.resource as Record<string, any>).find((x) => x['resourceType'] === 'MedicationDispense');
    expect(md).toMatchObject({ status: 'completed', authorizingPrescription: [{ reference: `MedicationRequest/${mrId}` }], quantity: { value: 5, unit: 'Tablet' },
      identifier: [{ value: 'RX-V-0003' }, { value: 'RX-V-0003-1' }], context: { reference: expect.stringMatching(/^Encounter\//) } });
    expect(md?.['performer']).toBeUndefined();
    // Penyerahan sisa item yang sama → identifier item -2 (tidak bentrok dengan yang pertama)
    const d2 = await dispense(rx.id, [{ item: rx.items[0], drug: PCT, qty: 4 }], { pharmacist: DR });
    sent.length = 0;
    await run();
    expect((await recs('MedicationDispense', d2.lines))[0]).toMatchObject({ status: 'SENT', problems: { warnings: [] } });
    const md2 = sent.flatMap((b) => b.entry).map((x) => x.resource as Record<string, any>).find((x) => x['resourceType'] === 'MedicationDispense');
    expect(md2).toMatchObject({ identifier: [{ value: 'RX-V-0003' }, { value: 'RX-V-0003-1-2' }], performer: [{ actor: { reference: expect.stringMatching(/^Practitioner\//) } }] });
  });
});

describe('Retry, dead-letter & kirim ulang manual (INT-FR-009, OD-119)', () => {
  test('V03 respons hilang → percobaan ulang menemukan MedicationRequest per identifier (tanpa duplikat); gangguan berulang → DEAD + satu notifikasi email admin', async () => {
    const e = await encounter();
    const rx = await prescription(e.id, 'RX-V-0004', [{ drug: PCT }]);
    await run();                                                    // Encounter terkirim; MR menunggu? (MR dikirim di putaran yang sama)
    expect((await recs('MedicationRequest', rx.items))[0].status).toBe('SENT');

    const e2 = await encounter();
    await run();
    const lost = await prescription(e2.id, 'RX-V-0005', [{ drug: PCT }]);
    mode = 'lost';
    expect((await run()).followUp.RETRY).toBe(1);
    expect((await recs('MedicationRequest', lost.items))[0]).toMatchObject({ status: 'PENDING', attempts: 1, satusehat_id: null });
    mode = 'ok';
    sent.length = 0;
    expect((await run()).followUp.SENT).toBe(0);                  // belum waktunya (backoff)
    expect((await run(minutes(2))).followUp.SENT).toBe(1);
    expect(sent).toHaveLength(0);                                   // ditemukan per identifier, tidak dikirim ulang
    expect((await recs('MedicationRequest', lost.items))[0]).toMatchObject({ status: 'SENT', attempts: 2, satusehat_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });

    const e3 = await encounter();
    await run();
    const flaky = await prescription(e3.id, 'RX-V-0006', [{ drug: PCT }]);
    mode = 'transient';
    const out: number[] = [];
    for (const m of [0, 2, 8, 40, 170]) out.push((await run(minutes(m))).deadLetterNotices);
    expect((await recs('MedicationRequest', flaky.items))[0]).toMatchObject({ status: 'DEAD', attempts: 5, last_error: 'SATUSEHAT sementara gagal (HTTP 503)' });
    expect(out).toEqual([0, 0, 0, 0, 1]);
    const ev = await su(`select aggregate_type, payload from app.outbox_event where event_type = 'SATUSEHAT_DEAD_LETTER'`);
    expect(ev).toEqual([{ aggregate_type: 'integration_connection', payload: {} }]);
    // DEAD kedua selama notifikasi belum terkirim → tidak menumpuk
    const e4 = await encounter();
    mode = 'ok';
    await run();
    const flaky2 = await prescription(e4.id, 'RX-V-0007', [{ drug: PCT }]);
    mode = 'transient';
    for (const m of [0, 2, 8, 40, 170]) await run(minutes(m));
    expect((await recs('MedicationRequest', flaky2.items))[0].status).toBe('DEAD');
    expect(await su(`select count(*)::int as n from app.outbox_event where event_type = 'SATUSEHAT_DEAD_LETTER'`)).toEqual([{ n: 1 }]);
    // Email ke admin klinik: jumlah saja, tanpa data pasien
    const mails: Mail[] = [];
    const r = await dispatchNotifications(pool, async (m) => { mails.push(m); }, { clinicUrlTemplate: 'https://{code}.clinicrme.test' });
    expect(r.done).toBe(1);
    expect(mails.map((m) => m.to)).toEqual(['admin@a.test']);
    expect(mails[0].subject).toMatch(/^\[ClinicRME\] 2 kiriman SATUSEHAT gagal — /);
    expect(mails[0].text).toContain('https://klinik-a.clinicrme.test/integrations/satusehat');
    expect(mails[0].text).not.toMatch(/Pasien Sintetis|RX-V|KJ-V|Parasetamol/);
  });

  test('V04 daftar "Perlu tindakan" & kirim ulang manual: hanya ERROR/DEAD, butuh integration.manage, teraudit, idempoten; berhasil di putaran berikutnya', async () => {
    const list = await get(`/api/v1/integrations/satusehat/records?facilityId=${FACILITY}`, admin);
    expect(list.status).toBe(200);
    expect(list.body.counts).toMatchObject({ DEAD: 2 });
    const dead = list.body.data.filter((x: { status: string }) => x.status === 'DEAD');
    expect(dead[0]).toMatchObject({ resourceType: 'MedicationRequest', localType: 'prescription_item', attempts: 5, resendable: true,
      encounterNo: expect.stringMatching(/^KJ-V-/), encounterId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const blocked = list.body.data.find((x: { status: string }) => x.status === 'BLOCKED');
    expect(blocked).toMatchObject({ resendable: false, blocking: [expect.stringMatching(/butuh kode KFA|belum/)] });
    expect(JSON.stringify(list.body)).not.toMatch(/Pasien Sintetis/);
    expect((await get(`/api/v1/integrations/satusehat/records?facilityId=${FACILITY}`, kasir)).status).toBe(403);

    const id = dead[0].id as string;
    expect((await post(`/api/v1/integrations/satusehat/records/${id}/retry`, kasir).send()).status).toBe(403);
    expect((await post(`/api/v1/integrations/satusehat/records/${blocked.id}/retry`, admin).send()).body.code).toBe('INT-409-NOT-RESENDABLE');
    const r1 = await post(`/api/v1/integrations/satusehat/records/${id}/retry`, admin).send();
    expect(r1.body).toEqual({ id, status: 'PENDING', alreadyQueued: false });
    expect((await post(`/api/v1/integrations/satusehat/records/${id}/retry`, admin).send()).body).toEqual({ id, status: 'PENDING', alreadyQueued: true });
    const [a] = await su(`select change_summary from app.audit_log where action = 'SATUSEHAT_RESEND_REQUESTED' and resource_id = $1`, [id]);
    expect(a.change_summary).toEqual({ resourceType: 'MedicationRequest', localType: 'prescription_item', previousStatus: 'DEAD' });
    mode = 'ok';
    expect((await run()).followUp.SENT).toBe(1);
    const [rec] = await su(`select status, attempts, resend_requested_by from app.fhir_sync_record where id = $1`, [id]);
    expect(rec).toEqual({ status: 'SENT', attempts: 6, resend_requested_by: ids.adminA });
    expect((await post(`/api/v1/integrations/satusehat/records/${id}/retry`, admin).send()).body.code).toBe('INT-409-NOT-RESENDABLE');
  });
});

describe('Koreksi diagnosis lewat addendum (INT-FR-012, OD-120)', () => {
  const addendum = (noteId: string, diagnoses: { conceptId: string; rank: 'PRIMER' | 'SEKUNDER' }[]) =>
    post(`/api/v1/clinical-notes/${noteId}/addenda`, dokter).send({ reason: 'Koreksi diagnosis', content: 'Koreksi setelah anamnesis ulang', password: PASSWORD, diagnoses });

  test('V05 diagnosis ditambah → Condition baru + update Encounter.diagnosis; diagnosis dihapus → Condition entered-in-error (riwayat versi)', async () => {
    const e = await encounter();
    await run();
    const [er] = await su(`select id, satusehat_id, resource_version from app.fhir_sync_record where resource_type = 'Encounter' and local_id = $1`, [e.id]);
    const [orig] = await su(`select id, satusehat_id from app.fhir_sync_record where resource_type = 'Condition' and parent_id = $1`, [er.id]);
    const a1 = await addendum(e.noteId, [{ conceptId: ICD10_J06, rank: 'PRIMER' }, { conceptId: ICD10_R50, rank: 'SEKUNDER' }]);
    expect(a1.status).toBe(201);
    sent.length = 0;
    expect((await run()).followUp.SENT).toBe(1);
    expect(sent[0].entry.map((x) => `${x.request.method} ${x.request.url}`)).toEqual(['POST Condition', `PUT Encounter/${er.satusehat_id}`]);
    const enc = sent[0].entry[1].resource as Record<string, any>;
    expect(enc['diagnosis'].map((d: any) => [d.condition.reference, d.rank])).toEqual([[expect.stringMatching(/^urn:uuid:/), 1], [`Condition/${orig.satusehat_id}`, 2]]);
    const conds = await su(`select local_type, local_code, status, entered_in_error_at is not null as eie, resource_version from app.fhir_sync_record
      where resource_type = 'Condition' and parent_id = $1 order by created_at`, [er.id]);
    expect(conds).toEqual([
      { local_type: 'condition_dx', local_code: 'R50.9', status: 'SENT', eie: false, resource_version: 1 },
      { local_type: 'addendum_dx', local_code: 'J06.9', status: 'SENT', eie: false, resource_version: 1 },
      { local_type: 'clinical_addendum', local_code: null, status: 'SENT', eie: false, resource_version: 1 },
    ]);
    // Addendum kedua: hanya J06 → R50 dikirim entered-in-error (tanpa clinicalStatus)
    await addendum(e.noteId, [{ conceptId: ICD10_J06, rank: 'PRIMER' }]);
    sent.length = 0;
    expect((await run()).followUp.SENT).toBe(1);
    expect(sent[0].entry.map((x) => `${x.request.method} ${x.request.url}`)).toEqual([`PUT Condition/${orig.satusehat_id}`, `PUT Encounter/${er.satusehat_id}`]);
    expect(sent[0].entry[0].resource).toMatchObject({ id: orig.satusehat_id, verificationStatus: { coding: [{ code: 'entered-in-error' }] } });
    expect(sent[0].entry[0].resource['clinicalStatus']).toBeUndefined();
    expect(await su(`select entered_in_error_at is not null as eie, resource_version from app.fhir_sync_record where id = $1`, [orig.id])).toEqual([{ eie: true, resource_version: 2 }]);
    expect(await su(`select resource_version from app.fhir_sync_record where id = $1`, [er.id])).toEqual([{ resource_version: er.resource_version + 2 }]);
    const s = await status(e.id);
    expect(s.version).toBe(3);
    expect(s.resources.find((x: { localType: string; enteredInError: boolean }) => x.localType === 'condition_dx')).toMatchObject({ enteredInError: true, version: 2 });
    const [au] = await su(`select change_summary from app.audit_log where action = 'SATUSEHAT_DIAGNOSIS_UPDATED' order by seq desc limit 1`);
    expect(au.change_summary).toMatchObject({ added: 0, enteredInError: 1 });
    expect((await run()).followUp.SENT).toBe(0);
  });

  test('V06 addendum sebelum Encounter terkirim menunggu; hanya addendum terbaru yang dikirim (yang lama digantikan); pasien membatasi pemrosesan → SKIPPED', async () => {
    const e = await encounter({ ihs: false });
    await run();                                                    // Encounter BLOCKED
    const a1 = await addendum(e.noteId, [{ conceptId: ICD10_J06, rank: 'PRIMER' }, { conceptId: ICD10_R50, rank: 'SEKUNDER' }]);
    const a2 = await addendum(e.noteId, [{ conceptId: ICD10_J06, rank: 'PRIMER' }]);
    await run();
    expect(await recs('Condition', [a1.body.id, a2.body.id])).toEqual([]);
    await su(`update app.patient set ihs_status = 'FOUND', ihs_number = 'P3999999999' where id = $1`, [e.patientId]);
    sent.length = 0;
    const r = await run();
    expect(r.SENT).toBe(1);
    expect(r.followUp.SENT).toBe(1);
    const byId = Object.fromEntries((await recs('Condition', [a1.body.id, a2.body.id])).map((x) => [x.local_id, x]));
    expect(byId[a2.body.id].status).toBe('SENT');
    expect(byId[a1.body.id]).toMatchObject({ status: 'SKIPPED', problems: { blocking: ['Digantikan addendum diagnosis yang lebih baru'] } });

    const rs = await encounter();
    const rs2 = await encounter({ patientId: rs.patientId });
    const rx = await prescription(rs.id, 'RX-V-0008', [{ drug: PCT }]);
    await run();
    await su(`update app.patient set processing_restricted = true, restriction_reason = 'Permintaan pasien (uji)', restricted_at = now() where id = $1`, [rs.patientId]);
    const rx2 = await prescription(rs2.id, 'RX-V-0009', [{ drug: PCT }]);
    await run();
    expect((await recs('MedicationRequest', rx.items))[0].status).toBe('SENT');
    expect((await recs('MedicationRequest', rx2.items))[0]).toMatchObject({ status: 'SKIPPED', satusehat_id: null });
  });
});
