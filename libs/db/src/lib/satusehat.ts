import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { decrypt } from '@clinicrme/shared/crypto';

/**
 * Klien SATUSEHAT (Stage 12, INT-FR-001–003; DEC-044). Dipakai API (uji koneksi, sinkron master, lookup manual) dan worker
 * (lookup IHS tertunda). Dua implementasi: HTTP ke sandbox/produksi Kemenkes, dan **simulator** tanpa jaringan untuk
 * lokal/test/E2E (OD-121) — simulator ditolak di produksi oleh API. Payload & token tidak pernah ditulis ke log.
 */
export type SatuSehatEnvironment = 'SIMULATOR' | 'SANDBOX' | 'PRODUCTION';
export interface SatuSehatConnection { id: string; facilityId: string; environment: SatuSehatEnvironment; clientId: string; clientSecret: string; organizationId: string }
export interface SatuSehatUrls { sandbox: string; production: string }
export const DEFAULT_SATUSEHAT_URLS: SatuSehatUrls = {
  sandbox: 'https://api-satusehat-stg.dto.kemkes.go.id',
  production: 'https://api-satusehat.kemkes.go.id',
};
export const NIK_SYSTEM = 'https://fhir.kemkes.go.id/id/nik';
export const locationSystem = (orgId: string) => `http://sys-ids.kemkes.go.id/location/${orgId}`;

/** AUTH = kredensial salah; VALIDATION = data ditolak (4xx, tidak di-retry); TRANSIENT = jaringan/5xx/429 (di-retry). */
export type SatuSehatErrorKind = 'AUTH' | 'VALIDATION' | 'NOT_FOUND' | 'TRANSIENT';
export class SatuSehatError extends Error {
  constructor(readonly kind: SatuSehatErrorKind, message: string, readonly status?: number, readonly issues: string[] = []) { super(message); }
}

export interface FhirResponse { status: number; body: Record<string, unknown> }
export interface SatuSehatClient {
  readonly environment: SatuSehatEnvironment;
  request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<FhirResponse>;
}

/** Ringkas OperationOutcome menjadi pesan yang dapat ditindaklanjuti (tanpa data pasien). */
export function outcomeIssues(body: unknown): string[] {
  const issues = (body as { issue?: { severity?: string; code?: string; diagnostics?: string; details?: { text?: string }; expression?: string[] }[] })?.issue ?? [];
  return issues.map((i) => [i.details?.text ?? i.diagnostics ?? i.code ?? 'error', i.expression?.length ? `(${i.expression.join(', ')})` : ''].join(' ').trim())
    .filter(Boolean).slice(0, 10);
}

interface CachedToken { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>();

/** Klien HTTP: token OAuth2 client_credentials di-cache sampai 60 detik sebelum kedaluwarsa; 401 → token baru & coba sekali lagi. */
export class HttpSatuSehatClient implements SatuSehatClient {
  readonly environment: SatuSehatEnvironment;
  private readonly base: string;
  private readonly cacheKey: string;
  constructor(private readonly conn: SatuSehatConnection, urls: SatuSehatUrls = DEFAULT_SATUSEHAT_URLS,
              private readonly opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
    if (conn.environment === 'SIMULATOR') throw new Error('Gunakan SimulatorSatuSehatClient untuk SIMULATOR');
    this.environment = conn.environment;
    this.base = (conn.environment === 'PRODUCTION' ? urls.production : urls.sandbox).replace(/\/$/, '');
    this.cacheKey = `${conn.id}:${conn.clientId}:${createHash('sha256').update(conn.clientSecret).digest('hex').slice(0, 16)}`;
  }

  async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<FhirResponse> {
    let res = await this.call(method, path, body, await this.token());
    if (res.status === 401) {
      tokenCache.delete(this.cacheKey);
      res = await this.call(method, path, body, await this.token());
    }
    return classify(res);
  }

  private async token(): Promise<string> {
    const hit = tokenCache.get(this.cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.token;
    const res = await this.fetch(`${this.base}/oauth2/v1/accesstoken?grant_type=client_credentials`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.conn.clientId, client_secret: this.conn.clientSecret }).toString(),
    });
    if (res.status === 401 || res.status === 400 || res.status === 403) throw new SatuSehatError('AUTH', 'Client ID / client secret ditolak SATUSEHAT', res.status);
    if (res.status >= 300) throw new SatuSehatError('TRANSIENT', `Token SATUSEHAT gagal (HTTP ${res.status})`, res.status);
    const j = res.body as { access_token?: string; expires_in?: string | number };
    if (!j.access_token) throw new SatuSehatError('TRANSIENT', 'Respons token SATUSEHAT tidak berisi access_token');
    const ttl = Math.max(60, Number(j.expires_in ?? 3599)) * 1000;
    tokenCache.set(this.cacheKey, { token: j.access_token, expiresAt: Date.now() + ttl - 60_000 });
    return j.access_token;
  }

  private call(method: string, path: string, body: unknown, token: string) {
    return this.fetch(`${this.base}/fhir-r4/v1${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json', ...(body ? { 'Content-Type': 'application/fhir+json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  private async fetch(url: string, init: RequestInit): Promise<FhirResponse> {
    const f = this.opts.fetchImpl ?? fetch;
    try {
      const r = await f(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000) });
      const text = await r.text();
      let body: Record<string, unknown> = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
      return { status: r.status, body };
    } catch (e) {
      const name = (e as Error).name;
      throw new SatuSehatError('TRANSIENT', name === 'TimeoutError' || name === 'AbortError' ? 'SATUSEHAT tidak merespons (timeout)' : 'Tidak dapat terhubung ke SATUSEHAT');
    }
  }
}

function classify(res: FhirResponse): FhirResponse {
  if (res.status < 300) return res;
  const issues = outcomeIssues(res.body);
  if (res.status === 401 || res.status === 403) throw new SatuSehatError('AUTH', 'Akses ditolak SATUSEHAT', res.status, issues);
  if (res.status === 404) throw new SatuSehatError('NOT_FOUND', 'Data tidak ditemukan di SATUSEHAT', res.status, issues);
  if (res.status === 429 || res.status >= 500) throw new SatuSehatError('TRANSIENT', `SATUSEHAT sementara gagal (HTTP ${res.status})`, res.status, issues);
  throw new SatuSehatError('VALIDATION', issues[0] ?? `Data ditolak SATUSEHAT (HTTP ${res.status})`, res.status, issues);
}

/**
 * Simulator SATUSEHAT (OD-121) — bukan layanan resmi, tanpa jaringan, deterministik:
 * - client secret `ditolak` → AUTH; organization id berawalan `X` → tidak ditemukan;
 * - NIK berawalan `0000` → tidak ditemukan; `5000` → gangguan sementara; selain itu IHS = turunan hash NIK;
 * - Location dicari per identifier lalu dibuat bila belum ada (ID turunan hash identifier — idempoten).
 */
export class SimulatorSatuSehatClient implements SatuSehatClient {
  readonly environment = 'SIMULATOR' as const;
  constructor(private readonly conn: SatuSehatConnection) {}

  async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<FhirResponse> {
    if (this.conn.clientSecret === 'ditolak') throw new SatuSehatError('AUTH', 'Client ID / client secret ditolak SATUSEHAT (simulator)', 401);
    const [p, q = ''] = path.split('?');
    const params = new URLSearchParams(q);
    const ident = params.get('identifier') ?? '';
    const value = ident.split('|')[1] ?? '';
    if (method === 'GET' && p.startsWith('/Organization/')) {
      const id = decodeURIComponent(p.slice('/Organization/'.length));
      if (id.startsWith('X')) return classify({ status: 404, body: issue('Organization tidak ditemukan') });
      return { status: 200, body: { resourceType: 'Organization', id, active: true, name: `Organisasi Simulasi ${id.slice(0, 8)}` } };
    }
    if (method === 'GET' && (p === '/Patient' || p === '/Practitioner')) {
      if (!/^\d{16}$/.test(value)) return classify({ status: 400, body: issue('identifier NIK tidak valid', 'Patient.identifier') });
      if (value.startsWith('5000')) return classify({ status: 503, body: issue('Layanan sementara tidak tersedia') });
      if (value.startsWith('0000')) return { status: 200, body: bundle([]) };
      const id = (p === '/Patient' ? 'P' : '1') + digits(`${p}:${value}`, 10);
      return { status: 200, body: bundle([{ resourceType: p.slice(1), id }]) };
    }
    if (method === 'GET' && p === '/Location') {
      return { status: 200, body: bundle(simLocations.has(ident) ? [{ resourceType: 'Location', id: simLocations.get(ident) }] : []) };
    }
    if (method === 'POST' && p === '/Location') {
      const b = body as { identifier?: { system?: string; value?: string }[]; name?: string; managingOrganization?: { reference?: string } };
      const id0 = b.identifier?.[0];
      if (!id0?.system || !id0.value || !b.name) return classify({ status: 400, body: issue('Location.identifier dan Location.name wajib', 'Location') });
      if (b.managingOrganization?.reference !== `Organization/${this.conn.organizationId}`) {
        return classify({ status: 400, body: issue('managingOrganization harus Organization fasyankes', 'Location.managingOrganization') });
      }
      const key = `${id0.system}|${id0.value}`;
      const id = simLocations.get(key) ?? uuidFrom(key);
      simLocations.set(key, id);
      return { status: 201, body: { resourceType: 'Location', id } };
    }
    return classify({ status: 400, body: issue(`Operasi simulator tidak dikenal: ${method} ${p}`) });
  }
}
const simLocations = new Map<string, string>();
const issue = (text: string, expr?: string) => ({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', details: { text }, ...(expr ? { expression: [expr] } : {}) }] });
const bundle = (resources: object[]) => ({ resourceType: 'Bundle', type: 'searchset', total: resources.length, entry: resources.map((resource) => ({ resource })) });
const digits = (s: string, n: number) => BigInt(`0x${createHash('sha256').update(s).digest('hex').slice(0, 15)}`).toString().padStart(n, '0').slice(-n);
const uuidFrom = (s: string) => {
  const h = createHash('sha256').update(`sim-location:${s}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const simulatorReset = () => simLocations.clear();

export function createSatuSehatClient(conn: SatuSehatConnection, urls?: SatuSehatUrls, opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }): SatuSehatClient {
  return conn.environment === 'SIMULATOR' ? new SimulatorSatuSehatClient(conn) : new HttpSatuSehatClient(conn, urls, opts);
}

// ----- Operasi tingkat tinggi -----

const firstId = (b: Record<string, unknown>) => ((b as { entry?: { resource?: { id?: string } }[] }).entry ?? [])[0]?.resource?.id ?? null;

/** INT-FR-003: IHS pasien dari NIK; `null` bila tidak ditemukan. */
export async function findPatientIhs(client: SatuSehatClient, nik: string): Promise<string | null> {
  return firstId((await client.request('GET', `/Patient?identifier=${encodeURIComponent(`${NIK_SYSTEM}|${nik}`)}`)).body);
}

/** INT-FR-002: IHS tenaga kesehatan dari NIK. */
export async function findPractitionerIhs(client: SatuSehatClient, nik: string): Promise<string | null> {
  return firstId((await client.request('GET', `/Practitioner?identifier=${encodeURIComponent(`${NIK_SYSTEM}|${nik}`)}`)).body);
}

export async function getOrganization(client: SatuSehatClient, orgId: string): Promise<{ id: string; name: string | null }> {
  const b = (await client.request('GET', `/Organization/${encodeURIComponent(orgId)}`)).body as { id?: string; name?: string };
  return { id: b.id ?? orgId, name: b.name ?? null };
}

/** OD-117: Location per poli — dicari dulu per identifier (idempoten), dibuat bila belum ada. */
export async function ensureLocation(client: SatuSehatClient, orgId: string, unit: { code: string; name: string; branchName: string }): Promise<{ id: string; created: boolean }> {
  const system = locationSystem(orgId);
  const found = firstId((await client.request('GET', `/Location?identifier=${encodeURIComponent(`${system}|${unit.code}`)}`)).body);
  if (found) return { id: found, created: false };
  const res = await client.request('POST', '/Location', {
    resourceType: 'Location', identifier: [{ system, value: unit.code }], status: 'active', name: unit.name,
    description: `${unit.name} — ${unit.branchName}`, mode: 'instance',
    physicalType: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/location-physical-type', code: 'ro', display: 'Room' }] },
    managingOrganization: { reference: `Organization/${orgId}` },
  });
  const id = (res.body as { id?: string }).id;
  if (!id) throw new SatuSehatError('TRANSIENT', 'Respons pembuatan Location tidak berisi id');
  return { id, created: true };
}

// ----- Worker: lookup IHS tertunda (OD-116) -----

export interface IhsLookupOptions { keyHex: string; urls?: SatuSehatUrls; batch?: number; now?: Date; allowSimulator?: boolean;
  clientFactory?: (c: SatuSehatConnection) => SatuSehatClient }

/**
 * Per tenant yang punya koneksi SATUSEHAT aktif: pasien ber-NIK berstatus PENDING (segera), NOT_FOUND/ERROR (ulang sekali
 * sehari) yang didaftarkan ≤ 7 hari lalu. Pasien yang pemrosesannya dibatasi (UU PDP) dilewati. Diaudit sebagai SYSTEM.
 */
export async function lookupPendingIhs(pool: Pool, o: IhsLookupOptions): Promise<{ tenants: number; checked: number; found: number; failedTenants: number }> {
  const c = await pool.connect();
  let tenants = 0, checked = 0, found = 0, failedTenants = 0;
  try {
    const { rows: ts } = await c.query<{ id: string }>(`select id from app.tenant where status in ('TRIAL','ACTIVE','GRACE') order by id`);
    for (const t of ts) {
      try {
        const r = await asTenant(c, t.id, async () => {
          const conn = await activeConnection(c, o.keyHex);
          if (!conn || (conn.environment === 'SIMULATOR' && o.allowSimulator === false)) return null;
          const client = (o.clientFactory ?? ((x) => createSatuSehatClient(x, o.urls)))(conn);
          return lookupTenant(c, client, o);
        });
        if (r) { tenants++; checked += r.checked; found += r.found; }
      } catch (e) {
        // Kredensial ditolak / gangguan pada satu klinik tidak menghentikan klinik lain; status koneksi terlihat dari uji koneksi
        if (!(e instanceof SatuSehatError)) throw e;
        failedTenants++;
      }
    }
    return { tenants, checked, found, failedTenants };
  } finally {
    c.release();
  }
}

async function lookupTenant(c: PoolClient, client: SatuSehatClient, o: IhsLookupOptions) {
  const now = (o.now ?? new Date()).toISOString();
  const { rows } = await c.query<{ id: string; nik_encrypted: Buffer }>(`
    select id, nik_encrypted from app.patient
     where identity_type = 'NIK' and status = 'ACTIVE' and not processing_restricted
       and created_at > $1::timestamptz - interval '7 days'
       and (ihs_status = 'PENDING' or (ihs_status in ('NOT_FOUND', 'ERROR') and (ihs_checked_at is null or ihs_checked_at < $1::timestamptz - interval '1 day')))
     order by ihs_checked_at nulls first, created_at limit $2 for update skip locked`, [now, o.batch ?? 50]);
  let found = 0;
  for (const p of rows) {
    let nik: string | null = null;
    try { nik = decrypt(o.keyHex, p.nik_encrypted); } catch { nik = null; }
    const r = nik ? await lookupOne(client, nik) : { status: 'ERROR' as const, ihs: null, error: 'NIK tersimpan tidak dapat dibaca' };
    if (r.status === 'FOUND') found++;
    await c.query(`update app.patient set ihs_number = coalesce($2, ihs_number), ihs_status = $3, ihs_checked_at = $4::timestamptz, ihs_last_error = $5 where id = $1`,
      [p.id, r.ihs, r.status, now, r.error]);
    await c.query(`select app.write_audit('PATIENT_IHS_LOOKUP', 'patient', $1::uuid, $1::uuid, $2::jsonb, 'SYSTEM', null, null)`,
      [p.id, JSON.stringify({ status: r.status, environment: client.environment, error: r.error })]);
  }
  return { checked: rows.length, found };
}

/** Satu lookup: FOUND / NOT_FOUND / ERROR (dengan pesan aman untuk ditampilkan). AUTH dilempar agar tidak menandai semua pasien. */
export async function lookupOne(client: SatuSehatClient, nik: string): Promise<{ status: 'FOUND' | 'NOT_FOUND' | 'ERROR'; ihs: string | null; error: string | null }> {
  try {
    const ihs = await findPatientIhs(client, nik);
    return ihs ? { status: 'FOUND', ihs, error: null } : { status: 'NOT_FOUND', ihs: null, error: 'NIK tidak ditemukan di SATUSEHAT' };
  } catch (e) {
    if (e instanceof SatuSehatError && e.kind === 'AUTH') throw e;
    return { status: 'ERROR', ihs: null, error: e instanceof SatuSehatError ? e.message : 'Kesalahan tidak terduga' };
  }
}

async function activeConnection(c: PoolClient, keyHex: string): Promise<SatuSehatConnection | null> {
  const { rows: [r] } = await c.query<{ id: string; facility_id: string; environment: SatuSehatEnvironment; client_id: string; secret_encrypted: Buffer; organization_id: string }>(`
    select id, facility_id, environment, client_id, secret_encrypted, organization_id from app.integration_connection
     where kind = 'SATUSEHAT' and is_active order by (environment = 'PRODUCTION') desc, updated_at desc limit 1`);
  return r ? { id: r.id, facilityId: r.facility_id, environment: r.environment, clientId: r.client_id, clientSecret: decrypt(keyHex, r.secret_encrypted),
    organizationId: r.organization_id } : null;
}

async function asTenant<T>(c: PoolClient, tenantId: string, fn: () => Promise<T>): Promise<T> {
  await c.query('begin');
  try {
    await c.query('set local role clinicrme_app');
    await c.query(`select set_config('app.tenant_id', $1, true), set_config('app.user_id', '', true)`, [tenantId]);
    const r = await fn();
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  }
}
