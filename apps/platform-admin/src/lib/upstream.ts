/**
 * Aturan penerusan /api/platform/v1/* dari konsol ke API NestJS (server-side, src/app/api/...).
 * Browser hanya bicara ke origin konsol; API menerima Host admin.<BASE_DOMAIN> sehingga
 * PlatformSecurityGuard melayani request ini dan guard klinik menolaknya (CR-0001).
 */
export const PATH_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
export const MAX_BODY_BYTES = 1_048_576; // sama dengan BODY_LIMIT API
const FORWARD_REQUEST_HEADERS = ['accept', 'content-type', 'cookie', 'user-agent', 'x-csrf-token', 'x-request-id', 'x-forwarded-for'];
const FORWARD_RESPONSE_HEADERS = ['content-type', 'x-request-id'];

export function upstreamPath(segments: string[], search: string): string | null {
  if (!segments.length || !segments.every((s) => PATH_SEGMENT.test(s) && s !== '.' && s !== '..')) return null;
  return `/api/platform/v1/${segments.join('/')}${search}`;
}

export function upstreamHeaders(incoming: Headers, platformHost: string, bodyLength?: number): Record<string, string> {
  const out: Record<string, string> = { host: platformHost };
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
