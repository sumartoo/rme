import { SatuSehatError, SimulatorSatuSehatClient, simulatorReset } from './satusehat';
import { conditionResource } from './satusehat-encounter';

const sim = new SimulatorSatuSehatClient({ id: 'c', facilityId: 'f', environment: 'SIMULATOR', clientId: 'x', clientSecret: 'y', organizationId: '10000004' });
const mr = (kfa: string | null, item = 'RX-1-1') => ({
  resourceType: 'MedicationRequest',
  identifier: [{ system: 'http://sys-ids.kemkes.go.id/prescription/10000004', value: 'RX-1' }, { system: 'http://sys-ids.kemkes.go.id/prescription-item/10000004', value: item }],
  contained: [{ resourceType: 'Medication', id: 'm', code: { coding: kfa ? [{ system: 'http://sys-ids.kemkes.go.id/kfa', code: kfa }] : [] } }],
  medicationReference: { reference: '#m' }, subject: { reference: 'Patient/P1234567890' }, encounter: { reference: 'Encounter/e1' }, requester: { reference: 'Practitioner/1' },
});
const tx = (...entry: object[]) => ({ resourceType: 'Bundle', type: 'transaction', entry });
const issues = async (b: object) => {
  try { await sim.request('POST', '', b); return []; } catch (e) { return (e as SatuSehatError).issues; }
};

beforeEach(() => simulatorReset());

describe('Simulator: obat & update (OD-121)', () => {
  test('MedicationRequest wajib Medication berkode KFA; identifier item resep unik; dapat dicari per identifier', async () => {
    expect(await issues(tx({ request: { method: 'POST', url: 'MedicationRequest' }, resource: mr(null) }))).toContain('MedicationRequest: Medication harus berkode KFA');
    const r = await sim.request('POST', '', tx({ request: { method: 'POST', url: 'MedicationRequest' }, resource: mr('93000001') }));
    const id = (r.body as { entry: { response: { resourceID: string } }[] }).entry[0].response.resourceID;
    expect(await issues(tx({ request: { method: 'POST', url: 'MedicationRequest' }, resource: mr('93000001') }))).toEqual(['Duplikat MedicationRequest.identifier RX-1-1']);
    const s = await sim.request('GET', `/MedicationRequest?identifier=${encodeURIComponent('http://sys-ids.kemkes.go.id/prescription-item/10000004|RX-1-1')}`);
    expect((s.body as { entry: { resource: { id: string } }[] }).entry[0].resource.id).toBe(id);
  });
  test('PUT ke URL resource yang sama; Condition entered-in-error tanpa clinicalStatus', async () => {
    const p = { reference: 'Patient/P1234567890' };
    const eie = conditionResource('R50.9', 'Fever', p, 'Encounter/e1', { id: 'c1', enteredInError: true });
    expect(eie).not.toHaveProperty('clinicalStatus');
    expect(await issues(tx({ request: { method: 'PUT', url: 'Condition/c1' }, resource: eie }))).toEqual([]);
    expect(await issues(tx({ request: { method: 'PUT', url: 'Condition/c2' }, resource: eie }))).toEqual(['PUT harus ke URL resource yang sama']);
    expect(await issues(tx({ request: { method: 'PUT', url: 'Condition/c1' }, resource: { ...eie, clinicalStatus: { coding: [{ code: 'active' }] } } })))
      .toEqual(['Condition entered-in-error tidak boleh memiliki clinicalStatus']);
  });
});
