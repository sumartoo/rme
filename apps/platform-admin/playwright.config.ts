import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { API_PORT, CLINIC_PORT, E2E_ENCRYPTION_KEY, STORAGE_DIR, WEB_PORT, dbUrl } from '../../tools/e2e/config';

/**
 * E2E konsol platform & aplikasi klinik: bundle produksi API (apps/api/dist) + build standalone Next.js konsol (apps/platform-admin)
 * dan aplikasi klinik (apps/web), database `clinicrme_e2e`. Uji ekspor menjalankan bundle worker (apps/worker/dist) sendiri.
 * (disiapkan tools/e2e/prepare-db.ts). Jalankan: TEST_PG_ADMIN_URL=... pnpm test:e2e
 * Chromium: bawaan Playwright (`npx playwright install chromium`) atau PLAYWRIGHT_CHROMIUM_EXECUTABLE.
 */
const root = join(__dirname, '..', '..');
const env = (extra: Record<string, string>) => ({ ...(process.env as Record<string, string>), ...extra });

export default defineConfig({
  testMatch: '*.e2e.ts',
  // Berurutan: konsol (U##) lalu klinik (W##) — satu database & satu API
  projects: [
    { name: 'console', testDir: './e2e' },
    { name: 'clinic', testDir: '../web/e2e', dependencies: ['console'] },
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
  webServer: [
    {
      command: 'node apps/api/dist/main.js',
      cwd: root,
      url: `http://127.0.0.1:${API_PORT}/readyz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: env({
        APP_ENV: 'test', NODE_ENV: 'production', PORT: String(API_PORT), LOG_LEVEL: 'warn',
        DATABASE_URL: dbUrl('crme_e2e_app'), PLATFORM_DATABASE_URL: dbUrl('crme_e2e_platform'),
        BASE_DOMAIN: 'localhost', COOKIE_SECURE: 'false', ENCRYPTION_KEY_HEX: E2E_ENCRYPTION_KEY,
        STORAGE_DRIVER: 'fs', STORAGE_FS_DIR: STORAGE_DIR,
        GOOGLE_CLIENT_ID: 'e2e', GOOGLE_CLIENT_SECRET: 'e2e', GOOGLE_REDIRECT_URI: 'http://demo.localhost/cb',
      }),
    },
    {
      // Build standalone seperti image produksi (docker/web.Dockerfile APP=platform-admin)
      command: 'node tools/e2e/serve-standalone.mjs platform-admin',
      cwd: root,
      url: `http://127.0.0.1:${WEB_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: env({ NODE_ENV: 'production', PORT: String(WEB_PORT), HOSTNAME: '127.0.0.1', API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`, BASE_DOMAIN: 'localhost' }),
    },
    {
      command: 'node tools/e2e/serve-standalone.mjs web',
      cwd: root,
      url: `http://127.0.0.1:${CLINIC_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: env({ NODE_ENV: 'production', PORT: String(CLINIC_PORT), HOSTNAME: '127.0.0.1', API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`, BASE_DOMAIN: 'localhost' }),
    },
  ],
});
