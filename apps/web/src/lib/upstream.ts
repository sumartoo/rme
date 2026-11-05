/**
 * Penerusan /api/v1/* dari aplikasi klinik ke API NestJS (server-side, src/app/api/v1/...).
 * Klinik ditentukan dari subdomain request (`<kode>.<BASE_DOMAIN>`), sama seperti API (ADR-0002):
 * Host yang dikirim ke API selalu `<kode>.<BASE_DOMAIN>` hasil validasi, bukan header mentah dari browser.
 */
export const PATH_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
export const MAX_BODY_BYTES = 1_048_576; // sama dengan BODY_LIMIT API
export const MAX_IMPORT_BYTES = 5 * 1_048_576; // impor master data CSV/XLSX (OD-083), sama dengan body parser raw API
const TENANT_CODE = /^[a-z0-9-]{3,40}$/;   // sama dengan context.middleware API
const PLATFORM_SUBDOMAIN = 'admin';
const FORWARD_REQUEST_HEADERS = ['accept', 'content-type', 'cookie', 'if-match', 'user-agent', 'x-csrf-token', 'x-request-id', 'x-forwarded-for'];
const FORWARD_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-disposition', 'etag', 'location', 'x-request-id'];

export function upstreamPath(segments: string[], search: string): string | null {
  if (!segments.length || !segments.every((s) => PATH_SEGMENT.test(s) && s !== '.' && s !== '..')) return null;
  return `/api/v1/${segments.join('/')}${search}`;
}

/** `klinik-a.localhost:4200` → `klinik-a.localhost`; host di luar BASE_DOMAIN, konsol platform, atau kode tidak sah → null. */
export function tenantHost(host: string | null, baseDomain: string): string | null {
  const h = (host ?? '').split(':')[0].toLowerCase();
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!h.endsWith(suffix)) return null;
  const code = h.slice(0, -suffix.length);
  if (code === PLATFORM_SUBDOMAIN || !TENANT_CODE.test(code)) return null;
  return `${code}${suffix}`;
}

export function upstreamHeaders(incoming: Headers, host: string, bodyLength?: number): Record<string, string> {
  const out: Record<string, string> = { host };
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = incoming.get(h);
    if (v) out[h] = v;
  }
  if (bodyLength !== undefined) out['content-length'] = String(bodyLength);
  return out;
}

export function downstreamHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const h = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const v = raw[name];
    if (typeof v === 'string') h.set(name, v);
  }
  for (const c of ([] as string[]).concat(raw['set-cookie'] ?? [])) h.append('set-cookie', c);
  return h;
}
