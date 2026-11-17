import { buildEncounterBundle, parseTransactionResponse, validateEncounter, type EncounterData } from './satusehat-encounter';

type Res = Record<string, unknown>;
const base = (): EncounterData => ({
  id: '11111111-1111-4111-8111-111111111111', encounterNo: 'KJ-0001', status: 'FINISHED',
  arrivedAt: '2026-11-17T01:00:00.000Z', consultStartedAt: '2026-11-17T01:20:00.000Z', consultEndedAt: '2026-11-17T01:40:00.000Z',
  finishedAt: null, signedAt: '2026-11-17T01:45:00.000Z',
  patient: { ihs: 'P1234567890', ihsStatus: 'FOUND', name: 'Pasien Sintetis', restricted: false },
  practitioner: { ihs: '10000000001', name: 'dr. Sintetis' },
  unit: { name: 'Poli Umum', locationId: 'loc-1' },
  conditions: [{ id: 'c-1', system: 'ICD10', code: 'R50.9', display: 'Fever', rank: 'PRIMER' }, { id: 'c-2', system: 'ICD10', code: 'J06.9', display: 'ARI', rank: 'SEKUNDER' }],
  observations: [{ id: 'o-1', code: 'SYSTOLIC', value: 120, recordedAt: '2026-11-17T01:10:00.000Z' }, { id: 'o-2', code: 'PAIN_SCALE', value: 3, recordedAt: '2026-11-17T01:10:00.000Z' }],
  procedures: [{ id: 'p-1', icd9: '93.57', name: 'Rawat luka', performedAt: '2026-11-17T01:30:00.000Z' }, { id: 'p-2', icd9: null, name: 'Nebulisasi', performedAt: '2026-11-17T01:30:00.000Z' }],
});

describe('validateEncounter (INT-FR-008)', () => {
  test('lengkap → tanpa blocking; yang tak terpetakan → peringatan', () => {
    const p = validateEncounter(base());
    expect(p.blocking).toEqual([]);
    expect(p.warnings).toEqual([expect.stringMatching(/PAIN_SCALE/), expect.stringMatching(/Nebulisasi/)]);
  });
  test('setiap kekurangan dilaporkan', () => {
    const d = base();
    d.patient = { ...d.patient, ihs: null, ihsStatus: 'NOT_FOUND' };
    d.practitioner.ihs = null;
    d.unit.locationId = null;
    d.arrivedAt = null;
    d.conditions = [{ id: 'c', system: 'ICD10', code: 'r50', display: 'x', rank: 'SEKUNDER' }];
    expect(validateEncounter(d).blocking).toEqual([
      expect.stringMatching(/NIK pasien tidak ditemukan/), expect.stringMatching(/Dokter dr\. Sintetis/), expect.stringMatching(/Poli Umum belum terdaftar/),
      'Waktu kedatangan pasien kosong', 'Diagnosis primer belum diisi', 'Kode diagnosis r50 bukan ICD-10 yang valid',
    ]);
    d.patient.ihsStatus = 'NOT_APPLICABLE';
    expect(validateEncounter(d).blocking[0]).toMatch(/tanpa NIK/);
  });
});

describe('buildEncounterBundle (OD-115)', () => {
  test('Bundle transaction: Encounter + Condition + Observation (LOINC/UCUM) + Procedure (ICD-9-CM); rujukan urn:uuid; diagnosis primer rank 1', () => {
    const { bundle, entries, hash } = buildEncounterBundle(base(), '10000004');
    const e = (bundle as { entry: { fullUrl: string; request: { method: string; url: string }; resource: Res }[] }).entry;
    expect(bundle).toMatchObject({ resourceType: 'Bundle', type: 'transaction' });
    expect(entries.map((x) => x.resourceType)).toEqual(['Encounter', 'Condition', 'Condition', 'Observation', 'Procedure']);
    expect(e.every((x) => x.request.method === 'POST' && x.fullUrl.startsWith('urn:uuid:'))).toBe(true);
    const enc = e[0].resource;
    expect(enc).toMatchObject({
      status: 'finished', class: { code: 'AMB' }, identifier: [{ system: 'http://sys-ids.kemkes.go.id/encounter/10000004', value: 'KJ-0001' }],
      subject: { reference: 'Patient/P1234567890' }, participant: [{ individual: { reference: 'Practitioner/10000000001' } }],
      period: { start: '2026-11-17T01:00:00.000Z', end: '2026-11-17T01:40:00.000Z' }, location: [{ location: { reference: 'Location/loc-1' } }],
      serviceProvider: { reference: 'Organization/10000004' },
    });
    expect((enc['diagnosis'] as Res[]).map((d: Res) => [(d['condition'] as Res)['reference'], d['rank']])).toEqual([['urn:uuid:c-1', 1], ['urn:uuid:c-2', 2]]);
    expect((enc['statusHistory'] as Res[]).map((s: Res) => s['status'])).toEqual(['arrived', 'in-progress', 'finished']);
    expect(e[1].resource).toMatchObject({ code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'R50.9' }] }, encounter: { reference: `urn:uuid:${base().id}` } });
    expect(e[3].resource).toMatchObject({ code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: 120, system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } });
    expect(e[4].resource).toMatchObject({ code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-9-cm', code: '93.57' }] } });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(buildEncounterBundle(base(), '10000004').hash).toBe(hash);   // deterministik
  });
  test('Encounter yang sudah ada dirujuk langsung dan tidak dibuat ulang', () => {
    const { entries, bundle } = buildEncounterBundle(base(), '10000004', 'enc-9');
    expect(entries[0].resourceType).toBe('Condition');
    expect(JSON.stringify(bundle)).toContain('"reference":"Encounter/enc-9"');
  });
});

test('parseTransactionResponse membaca resourceID atau location per urutan entry', () => {
  expect(parseTransactionResponse({ entry: [{ response: { resourceID: 'a' } }, { response: { location: 'Condition/b/_history/1' } }, {}] }, 4)).toEqual(['a', 'b', null, null]);
});
