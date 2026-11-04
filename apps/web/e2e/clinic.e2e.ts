import { expect, test, type Page } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticator } from 'otplib';
import { seedClinic } from '../../../tools/e2e/seed-clinic';
import { CLINIC_URL, E2E_ENCRYPTION_KEY, STORAGE_DIR, USER_PASSWORD, dbUrl } from '../../../tools/e2e/config';

/**
 * E2E aplikasi klinik (Stage 5 batch 4): login klinik + TOTP admin, profil & kop klinik (If-Match),
 * ekspor data terenkripsi end-to-end (worker sungguhan → unduh → buka dengan kunci), batas peran, header keamanan.
 * Klinik uji `klinik-web` disiapkan tools/e2e/prepare-db.ts. Penomoran W## dipakai di laporan.
 */
// Batas 2 menit: tiap login admin menunggu kode TOTP periode baru (maks. ±30 detik)
test.describe.configure({ mode: 'serial', timeout: 120_000 });
test.use({ baseURL: CLINIC_URL });
test.beforeAll(seedClinic);

const ROOT = join(__dirname, '..', '..', '..');
let secret = '';
let lastStep = -1;
/** Kode TOTP dari periode yang belum dipakai: server menolak kode yang sama dua kali (anti-replay, RSK-024). */
async function freshCode(): Promise<string> {
  // Hindari kode di ujung periode 30 detik (bisa sudah kedaluwarsa saat diperiksa server)
  while (authenticator.timeRemaining() < 4) await new Promise((r) => setTimeout(r, 1000));
  const step = () => Math.floor(Date.now() / 30_000);
  while (step() <= lastStep) await new Promise((r) => setTimeout(r, 500));
  lastStep = step();
  return authenticator.generate(secret);
}
const alertBox = (page: Page) => page.locator('[role=alert]:not(#__next-route-announcer__)');
const cspViolations: string[] = [];
function watchCsp(page: Page) {
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to (apply|execute|load)/i.test(m.text())) cspViolations.push(m.text());
  });
}

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(USER_PASSWORD);
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
}

/** Admin klinik: login → (daftar TOTP sekali) → verifikasi → profil klinik. */
async function signInAdmin(page: Page) {
  await login(page, 'admin@klinik-web.test');
  await expect(page).toHaveURL(/\/mfa$/);
  if (!secret) {
    await page.getByRole('button', { name: 'Daftarkan authenticator' }).click();
    secret = (await page.getByTestId('totp-secret').textContent())!.trim();
    await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(8);
    await page.getByLabel('Recovery code sudah saya simpan').check();
  }
  await page.getByLabel('Kode verifikasi').fill(await freshCode());
  await page.getByRole('button', { name: 'Verifikasi' }).click();
  await expect(page).toHaveURL(/\/admin\/profile$/);
}

test('W01 tanpa sesi diarahkan ke login klinik (kode klinik dari subdomain); password salah → pesan generik', async ({ page }) => {
  watchCsp(page);
  await page.goto('/admin/exports');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('clinic-code')).toHaveText('klinik-web');
  await expect(page.getByRole('link', { name: 'Masuk dengan Google' })).toHaveAttribute('href', '/api/v1/auth/google');
  await page.getByLabel('Email').fill('admin@klinik-web.test');
  await page.getByLabel('Password').fill('salah');
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(alertBox(page)).toHaveText('Email atau password salah');
});

test('W02 admin klinik: TOTP wajib → profil & kop klinik disimpan dan tetap setelah muat ulang', async ({ page }) => {
  watchCsp(page);
  await signInAdmin(page);
  await expect(page.getByTestId('me-email')).toHaveText('admin@klinik-web.test');
  await expect(page.getByLabel('Nama tampilan')).toHaveValue('Klinik Web E2E');
  await page.getByLabel('Nama tampilan').fill('Klinik Sehat E2E');
  await page.getByLabel('Nama di kop').fill('Klinik Pratama Sehat E2E');
  await page.getByLabel('Alamat').fill('Jl. Sintetis No. 1, Bandung');
  await page.getByLabel('Batas diskon kasir (%)').fill('150');
  await expect(page.getByText('Harus 0–100')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Simpan profil' })).toBeDisabled();
  await page.getByLabel('Batas diskon kasir (%)').fill('10');
  await page.getByRole('button', { name: 'Simpan profil' }).click();
  await expect(page.getByText('Profil klinik disimpan.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Nama di kop')).toHaveValue('Klinik Pratama Sehat E2E');
  await expect(page.getByLabel('Batas diskon kasir (%)')).toHaveValue('10');
  await expect(page.getByRole('link', { name: /Klinik Sehat E2E/ })).toBeVisible();
});

test('W03 dua admin mengubah profil bersamaan: yang kedua ditolak (If-Match) dan diminta memuat versi terbaru', async ({ page, browser }) => {
  watchCsp(page);
  await signInAdmin(page);
  const ctx = await browser.newContext({ baseURL: CLINIC_URL });
  const other = await ctx.newPage();
  await signInAdmin(other);
  await page.getByLabel('Telepon').fill('022-111');
  await page.getByRole('button', { name: 'Simpan profil' }).click();
  await expect(page.getByText('Profil klinik disimpan.')).toBeVisible();

  await other.getByLabel('Telepon').fill('022-999');
  await other.getByRole('button', { name: 'Simpan profil' }).click();
  await expect(other.getByText('Profil sudah diubah orang lain')).toBeVisible();
  await other.getByRole('button', { name: 'Muat versi terbaru' }).click();
  await expect(other.getByLabel('Telepon')).toHaveValue('022-111');
  await ctx.close();
});

test('W04 ekspor data: diproses worker → unduh arsip & kunci → arsip terbuka dengan alat decrypt-export', async ({ page }) => {
  test.setTimeout(120_000);
  watchCsp(page);
  await signInAdmin(page);
  await page.getByRole('link', { name: 'Ekspor data' }).click();
  await expect(page.getByText('Belum ada ekspor.')).toBeVisible();
  await page.getByRole('button', { name: 'Minta ekspor baru' }).click();
  await expect(page.getByTestId('export-status').first()).toHaveText('Menunggu');
  await expect(page.getByRole('button', { name: 'Minta ekspor baru' })).toBeDisabled();

  // Worker sungguhan (bundle produksi): job tenant.export.run berjalan saat start
  const env: Record<string, string | undefined> = { ...process.env, APP_ENV: 'test', LOG_LEVEL: 'warn', WORKER_DATABASE_URL: dbUrl(),
    ENCRYPTION_KEY_HEX: E2E_ENCRYPTION_KEY, STORAGE_DRIVER: 'fs', STORAGE_FS_DIR: STORAGE_DIR };
  delete env.SMTP_URL;                                                // email tidak dikirim dari uji
  const worker = spawn(process.execPath, [join(ROOT, 'apps/worker/dist/main.js')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let workerErr = '';
  worker.stderr?.on('data', (d: Buffer) => { workerErr += d.toString(); });
  try {
    await expect(page.getByTestId('export-status').first(), workerErr).toHaveText('Siap diunduh', { timeout: 60_000 });
  } finally { worker.kill('SIGTERM'); }
  const row = page.getByTestId('export-row').first();
  await expect(row).toContainText(/\d+ tabel · \d+ baris/);

  const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('link', { name: 'Unduh arsip' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^clinicrme-export-klinik-web-\d{4}-\d{2}-\d{2}\.crmex$/);
  const dir = mkdtempSync(join(tmpdir(), 'crme-w04-'));
  const archive = join(dir, 'arsip.crmex');
  await download.saveAs(archive);

  await row.getByRole('button', { name: 'Tampilkan kunci' }).click();
  const key = (await page.getByTestId('export-key').textContent())!.trim();
  expect(Buffer.from(key, 'base64')).toHaveLength(32);

  const out = join(dir, 'isi');
  execFileSync(process.execPath, [join(ROOT, 'tools/export/decrypt-export.mjs'), archive, key, out]);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  expect(manifest.tenant.code).toBe('klinik-web');
  expect(manifest.tables.find((t: { name: string }) => t.name === 'app_user').rows).toBe(2);
  expect(manifest.tables.map((t: { name: string }) => t.name)).not.toContain('user_credential');   // kredensial tidak diekspor
  const users = readFileSync(join(out, 'tables', 'app_user.ndjson'), 'utf8');
  expect(users).toContain('admin@klinik-web.test');
  expect(users).not.toContain('admin@platform.test');
});

test('W05 user non-admin (kasir): tanpa menu pengaturan; halaman admin ditolak API', async ({ page }) => {
  watchCsp(page);
  await login(page, 'kasir@klinik-web.test');
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByText('Halaman pengaturan klinik hanya untuk admin klinik.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Profil klinik' })).toHaveCount(0);
  await page.goto('/admin/exports');
  await expect(alertBox(page)).toHaveText('Tidak memiliki izin');
});

test('W06 keamanan: CSP bernonce, no-store; proxy hanya untuk klinik dari subdomain; tidak ada pelanggaran CSP', async ({ page }) => {
  const res = await page.goto('/login');
  const h = res!.headers();
  expect(h['content-security-policy']).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(h['content-security-policy']).not.toContain('unsafe-inline');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['cache-control']).toContain('no-store');
  // Node tidak me-resolve *.localhost seperti browser: kirim langsung ke 127.0.0.1 dengan header Host
  const port = Number(new URL(CLINIC_URL).port);
  const status = (host: string, path: string) => new Promise<number>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { host: `${host}:${port}` } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).on('error', reject);
  });
  // Rute konsol platform tidak dapat dijangkau dari aplikasi klinik
  expect(await status('klinik-web.localhost', '/api/v1/../platform/v1/tenants')).toBe(404);
  expect(await status('klinik-web.localhost', '/api/v1/auth/session')).toBe(401);          // kontrol: klinik sah sampai ke API
  // Host tanpa kode klinik / host konsol / klinik tak dikenal → ditolak
  expect(await status('localhost', '/api/v1/auth/session')).toBe(404);
  expect(await status('admin.localhost', '/api/v1/auth/session')).toBe(404);
  expect(await status('tidak-ada.localhost', '/api/v1/auth/session')).toBe(404);
  // Dibuka tanpa subdomain klinik → petunjuk alamat klinik, bukan form login
  const bare = await page.context().newPage();
  await bare.goto(`http://localhost:${port}/login`);
  await expect(bare.getByTestId('no-clinic')).toContainText('demo.localhost');
  await expect(bare.getByLabel('Password')).toHaveCount(0);
  await bare.close();
  expect(cspViolations).toEqual([]);
});
