import { loadConfig } from './config';

const base = {
  DATABASE_URL: 'postgres://app@localhost:5432/clinicrme',
  PLATFORM_DATABASE_URL: 'postgres://plat@localhost:5432/clinicrme',
  ENCRYPTION_KEY_HEX: 'b'.repeat(64),
  GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'nilai-rahasia-google', GOOGLE_REDIRECT_URI: 'https://a.clinicrme.test/cb',
};

describe('loadConfig', () => {
  it('nilai default mengikuti keputusan Stage 1–3 (sesi 30 menit/12 jam, lockout 5/15, MFA 5)', () => {
    expect(loadConfig(base)).toMatchObject({
      sessionIdleMinutes: 30, sessionAbsoluteHours: 12, lockoutThreshold: 5, lockoutMinutes: 15, mfaMaxAttempts: 5,
      cookieSecure: true, bodyLimit: '1mb', baseDomain: 'clinicrme.test',
    });
  });

  it('menolak kunci enkripsi yang bukan 32 byte hex', () => {
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY_HEX: 'pendek' })).toThrow(/ENCRYPTION_KEY_HEX/);
  });

  it('pesan error menyebut nama variabel tetapi tidak pernah nilainya', () => {
    try {
      loadConfig({ ...base, DATABASE_URL: 'bukan-url' });
      throw new Error('seharusnya gagal');
    } catch (e) {
      expect(String(e)).toContain('DATABASE_URL');
      expect(String(e)).not.toContain('nilai-rahasia-google');
      expect(String(e)).not.toContain('b'.repeat(64));
    }
  });

  it('COOKIE_SECURE=false hanya diizinkan di local/test', () => {
    expect(loadConfig({ ...base, APP_ENV: 'local', COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
    expect(() => loadConfig({ ...base, APP_ENV: 'prod', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
  });
});
