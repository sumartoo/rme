import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  HttpSatuSehatClient, SatuSehatError, SimulatorSatuSehatClient, ensureLocation, findPatientIhs, findPractitionerIhs, getOrganization, lookupOne,
  outcomeIssues, simulatorReset, type SatuSehatConnection,
} from './satusehat';

/** Klien HTTP SATUSEHAT terhadap server lokal (bukan Kemenkes) + perilaku simulator (Stage 12, OD-119/OD-121). Data sintetis. */
type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let server: Server;
let handler: Handler;
let base: string;
const calls: { method: string; url: string; auth?: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { calls.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization }); handler(req, body, res); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { calls.length = 0; });

const conn = (o: Partial<SatuSehatConnection> = {}): SatuSehatConnection => ({
  id: `c-${Math.random()}`, facilityId: 'f1', environment: 'SANDBOX', clientId: 'cid', clientSecret: 'rahasia-uji', organizationId: 'ORG1', ...o,   // pragma: allowlist secret
});
const json = (res: ServerResponse, status: number, body: object) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
let tokenNo = 0;
const okToken = (res: ServerResponse) => json(res, 200, { access_token: `tok-${++tokenNo}`, expires_in: '3599' });

describe('HttpSatuSehatClient', () => {
  test('token OAuth2 client_credentials di-cache; 401 → token baru & coba sekali lagi', async () => {
    let first = true;
    handler = (req, body, res) => {
      if (req.url?.startsWith('/oauth2/v1/accesstoken?grant_type=client_credentials')) {
        expect(body).toBe('client_id=cid&client_secret=rahasia-uji');
        return okToken(res);
      }
      if (req.url === '/fhir-r4/v1/Organization/ORG1') {
        if (first && req.headers.authorization === `Bearer tok-${tokenNo}` && tokenNo === 1) { first = false; return json(res, 401, {}); }
        return json(res, 200, { resourceType: 'Organization', id: 'ORG1', name: 'Klinik Uji' });
      }
      json(res, 404, {});
    };
    tokenNo = 0;
    const c = new HttpSatuSehatClient(conn(), { sandbox: base, production: 'http://invalid.local' });
    expect(await getOrganization(c, 'ORG1')).toEqual({ id: 'ORG1', name: 'Klinik Uji' });
    expect(calls.map((x) => x.url.split('?')[0])).toEqual(['/oauth2/v1/accesstoken', '/fhir-r4/v1/Organization/ORG1', '/oauth2/v1/accesstoken', '/fhir-r4/v1/Organization/ORG1']);
    calls.length = 0;
    await getOrganization(c, 'ORG1');
    expect(calls.map((x) => x.url)).toEqual(['/fhir-r4/v1/Organization/ORG1']);   // token dari cache
    expect(calls[0].auth).toBe('Bearer tok-2');
  });

  test('klasifikasi error: kredensial ditolak AUTH; 4xx VALIDATION dengan pesan OperationOutcome; 5xx/429 & timeout TRANSIENT; 404 NOT_FOUND', async () => {
    handler = (_req, _b, res) => json(res, 401, { error: 'invalid_client' });
    await expect(getOrganization(new HttpSatuSehatClient(conn(), { sandbox: base, production: base }), 'ORG1')).rejects.toMatchObject({ kind: 'AUTH' });
    const routes: Record<string, [number, object]> = {
      '/fhir-r4/v1/Patient': [400, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', details: { text: 'NIK tidak valid' }, expression: ['Patient.identifier'] }] }],
      '/fhir-r4/v1/Practitioner': [503, {}],
      '/fhir-r4/v1/Organization/ORG1': [404, {}],
      '/fhir-r4/v1/Location': [429, {}],
    };
    handler = (req, _b, res) => {
      if (req.url?.startsWith('/oauth2')) return okToken(res);
      if (req.url?.startsWith('/fhir-r4/v1/Encounter')) return;   // tidak pernah dijawab → timeout
      const r = routes[(req.url ?? '').split('?')[0]];
      json(res, r[0], r[1]);
    };
    const c = new HttpSatuSehatClient(conn(), { sandbox: base, production: base }, { timeoutMs: 300 });
    await expect(findPatientIhs(c, '3171000000000001')).rejects.toMatchObject({ kind: 'VALIDATION', status: 400, message: 'NIK tidak valid (Patient.identifier)' });
    await expect(findPractitionerIhs(c, '3171000000000001')).rejects.toMatchObject({ kind: 'TRANSIENT', status: 503 });
    await expect(getOrganization(c, 'ORG1')).rejects.toMatchObject({ kind: 'NOT_FOUND' });
    await expect(c.request('GET', '/Location?identifier=x')).rejects.toMatchObject({ kind: 'TRANSIENT', status: 429 });
    await expect(c.request('GET', '/Encounter/1')).rejects.toMatchObject({ kind: 'TRANSIENT', message: 'SATUSEHAT tidak merespons (timeout)' });
  });

  test('produksi memakai base URL produksi; SIMULATOR tidak boleh lewat klien HTTP', async () => {
    handler = (req, _b, res) => (req.url?.startsWith('/oauth2') ? okToken(res) : json(res, 200, { resourceType: 'Organization', id: 'P1' }));
    const c = new HttpSatuSehatClient(conn({ environment: 'PRODUCTION' }), { sandbox: 'http://invalid.local', production: base });
    expect((await getOrganization(c, 'P1')).id).toBe('P1');
    expect(() => new HttpSatuSehatClient(conn({ environment: 'SIMULATOR' }))).toThrow(/Simulator/);
  });

  test('outcomeIssues meringkas OperationOutcome (maks. 10 butir)', () => {
    expect(outcomeIssues({ issue: [{ diagnostics: 'a' }, { code: 'b', expression: ['X.y'] }] })).toEqual(['a', 'b (X.y)']);
    expect(outcomeIssues({ issue: Array.from({ length: 12 }, () => ({ code: 'x' })) })).toHaveLength(10);
    expect(outcomeIssues(null)).toEqual([]);
  });
});

describe('SimulatorSatuSehatClient (OD-121)', () => {
  const sim = (o: Partial<SatuSehatConnection> = {}) => new SimulatorSatuSehatClient(conn({ environment: 'SIMULATOR', ...o }));

  test('IHS deterministik dari NIK; 0000… tidak ditemukan; 5000… gangguan; NIK tidak valid ditolak', async () => {
    const a = await findPatientIhs(sim(), '3171000000000001');
    expect(a).toMatch(/^P\d{10}$/);
    expect(await findPatientIhs(sim(), '3171000000000001')).toBe(a);
    expect(await findPractitionerIhs(sim(), '3171000000000001')).toMatch(/^1\d{10}$/);
    expect(await findPatientIhs(sim(), '0000000000000001')).toBeNull();
    await expect(findPatientIhs(sim(), '5000000000000001')).rejects.toMatchObject({ kind: 'TRANSIENT' });
    await expect(findPatientIhs(sim(), '123')).rejects.toMatchObject({ kind: 'VALIDATION' });
    expect(await lookupOne(sim(), '0000000000000002')).toEqual({ status: 'NOT_FOUND', ihs: null, error: 'NIK tidak ditemukan di SATUSEHAT' });
    expect(await lookupOne(sim(), '5000000000000002')).toMatchObject({ status: 'ERROR', ihs: null });
    await expect(lookupOne(sim({ clientSecret: 'ditolak' }), '3171000000000001')).rejects.toBeInstanceOf(SatuSehatError);   // pragma: allowlist secret
  });

  test('Location dibuat sekali per identifier (idempoten) dan wajib milik Organization fasyankes', async () => {
    simulatorReset();
    const c = sim({ organizationId: 'ORG9' });
    const unit = { code: 'u-1', name: 'Poli Umum', branchName: 'Cabang 1' };
    const a = await ensureLocation(c, 'ORG9', unit);
    expect(a.created).toBe(true);
    expect(await ensureLocation(c, 'ORG9', unit)).toEqual({ id: a.id, created: false });
    await expect(ensureLocation(c, 'ORG-LAIN', { ...unit, code: 'u-2' })).rejects.toMatchObject({ kind: 'VALIDATION' });
    await expect(getOrganization(c, 'X-tidak-ada')).rejects.toMatchObject({ kind: 'NOT_FOUND' });
  });
});
