/**
 * Konfigurasi bersama uji E2E: apps/platform-admin/playwright.config.ts, uji konsol (U##) & aplikasi klinik (W##),
 * tools/e2e/prepare-db.ts. Database khusus `clinicrme_e2e`, role LOGIN sekali pakai, password sintetis — tidak pernah untuk data nyata.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const E2E_DB = 'clinicrme_e2e';
export const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'; // pragma: allowlist secret — default docker compose lokal
export const DB_PASSWORD = process.env.E2E_DB_PASSWORD ?? 'e2e-sintetis-db'; // pragma: allowlist secret — role uji sekali pakai
export const USER_PASSWORD = process.env.E2E_USER_PASSWORD ?? 'Rahasia-E2E-2026!'; // pragma: allowlist secret — akun uji sintetis
export const API_PORT = 3390;
export const WEB_PORT = 4390;
/** Aplikasi klinik (apps/web); klinik uji `klinik-web` (browser me-resolve *.localhost ke 127.0.0.1). */
export const CLINIC_PORT = 4391;
export const CLINIC_CODE = 'klinik-web';
export const CLINIC_URL = `http://${CLINIC_CODE}.localhost:${CLINIC_PORT}`;
/** Kunci & folder penyimpanan yang sama untuk API dan worker yang dijalankan uji ekspor. */
export const E2E_ENCRYPTION_KEY = 'e'.repeat(64);
export const STORAGE_DIR = join(tmpdir(), 'clinicrme-e2e-storage');

export function dbUrl(user?: string, database = E2E_DB) {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${database}`;
  if (user) { u.username = user; u.password = DB_PASSWORD; }
  return u.toString();
}
