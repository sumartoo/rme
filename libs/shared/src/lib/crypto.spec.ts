import { decrypt, encrypt, pkceChallenge, randomToken, sign, verifySigned } from './crypto';

const KEY = 'c'.repeat(64);

describe('crypto', () => {
  it('token acak 256-bit (43 karakter base64url) dan tidak berulang', () => {
    const a = randomToken(), b = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('AES-256-GCM: round-trip, IV acak, dan ciphertext yang diubah ditolak', () => {
    const c1 = encrypt(KEY, 'JBSWY3DPEHPK3PXP'), c2 = encrypt(KEY, 'JBSWY3DPEHPK3PXP');
    expect(c1.equals(c2)).toBe(false);
    expect(decrypt(KEY, c1)).toBe('JBSWY3DPEHPK3PXP');
    const tampered = Buffer.from(c1); tampered[tampered.length - 1] ^= 1;
    expect(() => decrypt(KEY, tampered)).toThrow();
    expect(() => decrypt('d'.repeat(64), c1)).toThrow();
  });

  it('nilai bertanda tangan: diubah atau kunci lain → null', () => {
    const v = sign(KEY, { state: 's1' });
    expect(verifySigned(KEY, v)).toEqual({ state: 's1' });
    expect(verifySigned('d'.repeat(64), v)).toBeNull();
    const [body, mac] = v.split('.');
    const forged = Buffer.from(JSON.stringify({ state: 'evil' })).toString('base64url');
    expect(verifySigned(KEY, `${forged}.${mac}`)).toBeNull();
    expect(verifySigned(KEY, body)).toBeNull();
    expect(verifySigned(KEY, undefined)).toBeNull();
  });

  it('PKCE S256 sesuai vektor uji RFC 7636 Lampiran B', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'); // pragma: allowlist secret — vektor uji publik RFC 7636
  });
});
