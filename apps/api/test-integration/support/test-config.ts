import { loadConfig } from '@clinicrme/shared';
import { appUrl, platformUrl } from './db-setup';

/** Konfigurasi uji: koneksi role aplikasi (RLS berlaku), kunci sintetis, log dimatikan kecuali diminta. */
export const testConfig = (overrides: Record<string, string> = {}) => loadConfig({
  APP_ENV: 'test', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DATABASE_URL: appUrl(), DB_POOL_MAX: '4', PLATFORM_DATABASE_URL: platformUrl(), PLATFORM_DB_POOL_MAX: '2',
  ENCRYPTION_KEY_HEX: 'a'.repeat(64), COOKIE_SECURE: 'true',
  GOOGLE_ISSUER: 'https://idp.invalid', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_REDIRECT_URI: 'https://x.invalid/cb',
  ...overrides,
});
