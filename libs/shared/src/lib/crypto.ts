import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Token acak 256-bit, base64url (SC-AUTH-06). */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** AES-256-GCM: iv(12) | tag(16) | ciphertext. Produksi: kunci data dibungkus Cloud KMS (SC-CRY-03). */
export function encrypt(keyHex: string, plain: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv, { authTagLength: 16 });
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decrypt(keyHex: string, blob: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), blob.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8');
}

/**
 * Indeks buta (blind index) untuk pencarian & keunikan nilai terenkripsi (NIK): HMAC-SHA256 dengan subkunci
 * per tujuan, diturunkan dari kunci data — nilai yang sama di tujuan berbeda tidak dapat dikorelasikan.
 */
export function blindIndex(keyHex: string, purpose: string, value: string): string {
  const sub = createHmac('sha256', Buffer.from(keyHex, 'hex')).update(`blind-index:${purpose}`).digest();
  return createHmac('sha256', sub).update(value).digest('hex');
}

/** Nilai bertanda tangan HMAC untuk cookie state OIDC. */
export function sign(keyHex: string, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', Buffer.from(keyHex, 'hex')).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifySigned<T>(keyHex: string, value: string | undefined): T | null {
  if (!value || !value.includes('.')) return null;
  const [body, mac] = value.split('.');
  const expected = createHmac('sha256', Buffer.from(keyHex, 'hex')).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
}

export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
