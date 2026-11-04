import { expect, test, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { USER_PASSWORD } from '../../../tools/e2e/config';

/**
 * Uji E2E pertama (Stage 5): alur nyata konsol platform di browser — login, pendaftaran TOTP, buat tenant,
 * ubah status dengan konfirmasi, feature flag, keluar; plus peran support (baca saja) dan CSP tanpa pelanggaran.
 * Penomoran U## dipakai di laporan.
 */
// Batas 2 menit: login berulang akun yang sama menunggu periode TOTP baru (maks. ±30 detik)
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const secrets: Record<string, string> = {};
const lastStep: Record<string, number> = {};
/** Pesan aplikasi (role=alert), bukan pengumum rute bawaan Next.js yang juga ber-role alert. */
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
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page).toHaveURL(/\/mfa$/);
}

/** Login + daftar TOTP (sekali per akun) + verifikasi → halaman tenant. */
async function signIn(page: Page, email: string) {
  await login(page, email);
  if (!secrets[email]) {
    await page.getByRole('button', { name: 'Daftarkan authenticator' }).click();
    secrets[email] = (await page.getByTestId('totp-secret').textContent())!.trim();
    await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(8);
    await expect(page.getByLabel('Kode verifikasi')).toHaveCount(0);       // verifikasi baru muncul setelah konfirmasi simpan
    await page.getByLabel('Recovery code sudah saya simpan').check();
  }
  // Server menolak kode dari periode 30 detik yang sama dua kali (anti-replay, RSK-024) → tunggu periode baru bila perlu;
  // hindari juga ujung periode (kode bisa kedaluwarsa saat diperiksa)
  const step = () => Math.floor(Date.now() / 30_000);
  while (authenticator.timeRemaining() < 4 || step() <= (lastStep[email] ?? -1)) await page.waitForTimeout(500);
  lastStep[email] = step();
  await page.getByLabel('Kode verifikasi').fill(authenticator.generate(secrets[email]));
  await page.getByRole('button', { name: 'Verifikasi' }).click();
  await expect(page).toHaveURL(/\/tenants$/);
}

test('U01 halaman konsol tanpa sesi diarahkan ke login; password salah menampilkan pesan generik', async ({ page }) => {
  watchCsp(page);
  await page.goto('/tenants');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill('admin@platform.test');
  await page.getByLabel('Password').fill('salah');
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(alertBox(page)).toHaveText('Email atau password salah');
});

test('U02 login → daftar TOTP (QR + kunci + 8 recovery code) → verifikasi → daftar tenant', async ({ page }) => {
  watchCsp(page);
  await signIn(page, 'admin@platform.test');
  await expect(page.getByTestId('me-email')).toHaveText('admin@platform.test');
  await expect(page.getByRole('img', { name: 'Kode QR untuk aplikasi authenticator' })).toHaveCount(0);
  await expect(page.getByText('Belum ada tenant.')).toBeVisible();
  // Cookie sesi tidak terbaca JavaScript (HttpOnly) — hanya token CSRF yang terbaca
  const visible = await page.evaluate(() => document.cookie);
  expect(visible).toContain('crme_pcsrf=');
  expect(visible).not.toContain('crme_psession');
});

test('U03 buat tenant: validasi form, lalu tenant tampil di daftar dengan status Uji coba', async ({ page }) => {
  watchCsp(page);
  await signIn(page, 'admin@platform.test');
  await page.getByRole('link', { name: 'Tenant baru' }).click();
  await page.getByRole('button', { name: 'Buat tenant' }).click();
  await expect(page.getByText('3–40 karakter: huruf kecil, angka, tanda minus')).toBeVisible();
  await expect(page.getByText('Pilih paket', { exact: true })).toBeVisible();

  await page.getByLabel('Kode (subdomain)').fill('klinik-e2e');
  await page.getByLabel('Nama badan usaha').fill('PT Klinik E2E (sintetis)');
  await page.getByLabel('Nama tampilan').fill('Klinik E2E');
  await page.getByLabel('Paket').selectOption({ label: 'Pilot (tanpa biaya) — 25 user, 2 cabang' });
  await page.getByLabel('Email admin klinik').fill('admin@klinik-e2e.test');
  await page.getByRole('button', { name: 'Buat tenant' }).click();

  await expect(page.getByRole('heading', { name: 'Klinik E2E' })).toBeVisible();
  await expect(page.getByTestId('tenant-status')).toHaveText('Uji coba');
  await expect(page.getByText('admin@klinik-e2e.test')).toBeVisible();

  // Kode yang sama ditolak oleh API, pesannya tampil di form
  await page.goto('/tenants/new');
  await page.getByLabel('Kode (subdomain)').fill('klinik-e2e');
  await page.getByLabel('Nama badan usaha').fill('PT Duplikat');
  await page.getByLabel('Paket').selectOption({ index: 1 });
  await page.getByLabel('Email admin klinik').fill('x@x.test');
  await page.getByRole('button', { name: 'Buat tenant' }).click();
  await expect(alertBox(page)).toHaveText('Kode klinik sudah dipakai');

  await page.goto('/tenants');
  const row = page.getByRole('row', { name: /klinik-e2e/ });
  await expect(row).toContainText('Uji coba');
  await expect(row).toContainText('PILOT');
});

test('U04 ubah status: hanya transisi sah yang ditawarkan, konfirmasi menjelaskan dampak, histori ter-update', async ({ page }) => {
  watchCsp(page);
  await signIn(page, 'admin@platform.test');
  await page.getByRole('link', { name: 'klinik-e2e' }).click();
  const options = page.getByLabel('Ubah menjadi').locator('option:not([disabled])');
  await expect(options).toHaveText(['Aktif', 'Masa tenggang', 'Ditangguhkan']);           // TRIAL → tidak bisa langsung Dihentikan

  await page.getByLabel('Ubah menjadi').selectOption({ label: 'Ditangguhkan' });
  await page.getByLabel('Alasan').fill('Uji E2E: tagihan belum dibayar');
  await page.getByRole('button', { name: 'Ubah status' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ubah status ke Ditangguhkan?' });
  await expect(dialog).toContainText('Hanya admin klinik yang dapat masuk');
  await dialog.getByRole('button', { name: 'Batal' }).click();                            // batal → tidak berubah
  await expect(page.getByTestId('tenant-status')).toHaveText('Uji coba');

  await page.getByRole('button', { name: 'Ubah status' }).click();
  await dialog.getByRole('button', { name: 'Ya, ubah status' }).click();
  await expect(page.getByTestId('tenant-status')).toHaveText('Ditangguhkan');
  await expect(page.getByText('Status diubah menjadi Ditangguhkan.')).toBeVisible();
  await expect(options).toHaveText(['Aktif', 'Dihentikan']);
});

test('U05 feature flag: tambah, matikan; status tersimpan setelah muat ulang', async ({ page }) => {
  watchCsp(page);
  await signIn(page, 'admin@platform.test');
  await page.getByRole('link', { name: 'klinik-e2e' }).click();
  await page.getByLabel('Tambah fitur').fill('pharmacy.v2');
  await page.getByRole('button', { name: 'Aktifkan' }).click();
  const sw = page.getByRole('switch', { name: 'pharmacy.v2' });
  await expect(sw).toBeChecked();
  await sw.click();
  await expect(sw).not.toBeChecked();
  await page.reload();
  await expect(page.getByRole('switch', { name: 'pharmacy.v2' })).not.toBeChecked();
});

test('U06 keluar mengakhiri sesi: kembali ke halaman konsol diarahkan ke login', async ({ page }) => {
  watchCsp(page);
  await signIn(page, 'admin@platform.test');
  await page.getByRole('button', { name: 'Keluar' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/tenants');
  await expect(page).toHaveURL(/\/login$/);
});

test('U07 PLATFORM_SUPPORT: bisa melihat, tidak ada tombol buat tenant / ubah status / ubah flag', async ({ page }) => {
  watchCsp(page);
  await signIn(page, 'support@platform.test');
  await expect(page.getByRole('link', { name: 'klinik-e2e' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Tenant baru' })).toHaveCount(0);
  await page.getByRole('link', { name: 'klinik-e2e' }).click();
  await expect(page.getByText('Hanya admin platform yang dapat mengubah status.')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'pharmacy.v2' })).toBeDisabled();
  await expect(page.getByLabel('Tambah fitur')).toHaveCount(0);
  await page.goto('/tenants/new');
  await expect(alertBox(page)).toHaveText('Anda tidak memiliki izin membuat tenant.');
});

test('U09 break-glass oleh support: alasan wajib, konfirmasi menjelaskan cakupan, lalu baca user & log audit klinik', async ({ page }) => {
  watchCsp(page);
  await signIn(page, 'support@platform.test');
  await page.getByRole('link', { name: 'klinik-e2e' }).click();
  const request = page.getByRole('button', { name: 'Minta akses dukungan' });
  await page.getByLabel('Alasan', { exact: true }).fill('pendek');
  await expect(request).toBeDisabled();
  await page.getByLabel('Alasan', { exact: true }).fill('Tiket #E2E-1: cek konfigurasi role');
  await page.getByLabel('Durasi').selectOption({ label: '30 menit' });
  await request.click();
  const dialog = page.getByRole('dialog', { name: 'Buka akses dukungan?' });
  await expect(dialog).toContainText('data pasien & rekam medis tidak dapat dibuka');
  await expect(dialog).toContainText('30 menit');
  await dialog.getByRole('button', { name: 'Ya, buka akses' }).click();

  await expect(page).toHaveURL(/\/support\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('grant-status')).toHaveText('Aktif');
  await expect(page.getByRole('heading', { name: 'User & role klinik' })).toBeVisible();
  const audit = page.getByTestId('support-audit-row');
  await expect(audit.filter({ hasText: 'SUPPORT_ACCESS_GRANTED' })).toHaveCount(1);
  await expect(audit.filter({ hasText: 'SUPPORT_VIEWED' })).toHaveCount(0);            // pembacaan support tidak membanjiri log

  // Detail tenant kini menautkan ke akses aktif; tidak bisa meminta akses kedua
  await page.getByRole('link', { name: 'klinik-e2e' }).click();
  await expect(page.getByText('Akses Anda aktif sampai')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Minta akses dukungan' })).toHaveCount(0);
});

test('U10 admin platform melihat semua akses, tidak dapat membaca data tenant, dapat mencabut; support kehilangan akses', async ({ page, browser }) => {
  watchCsp(page);
  await signIn(page, 'admin@platform.test');
  await page.getByRole('link', { name: 'Akses dukungan' }).click();
  const row = page.getByTestId('grant-row').filter({ hasText: 'klinik-e2e' });
  await expect(row).toContainText('Aktif');
  await row.getByRole('link', { name: 'klinik-e2e' }).click();
  await expect(page.getByText('Hanya support pemilik akses ini yang dapat membaca data tenant.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'User & role klinik' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cabut akses' }).click();
  await page.getByRole('dialog', { name: 'Cabut akses dukungan?' }).getByRole('button', { name: 'Ya, cabut' }).click();
  await expect(page.getByTestId('grant-status')).toHaveText('Dicabut');
  const url = page.url();

  const ctx = await browser.newContext();
  const sp = await ctx.newPage();
  watchCsp(sp);
  await signIn(sp, 'support@platform.test');
  await sp.goto(url);
  await expect(sp.getByTestId('grant-status')).toHaveText('Dicabut');
  await expect(sp.getByText('Akses sudah berakhir — data tenant tidak dapat dibaca lagi.')).toBeVisible();
  await expect(sp.getByRole('button', { name: 'Cabut akses' })).toHaveCount(0);
  await ctx.close();
});

test('U08 header keamanan: CSP bernonce tanpa unsafe-inline, tidak bisa di-frame, tidak di-cache; tidak ada pelanggaran CSP', async ({ page }) => {
  const res = await page.goto('/login');
  const h = res!.headers();
  expect(h['content-security-policy']).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(h['content-security-policy']).not.toContain('unsafe-inline');
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['cache-control']).toContain('no-store');
  // Endpoint klinik tidak dapat dijangkau lewat proxy konsol
  expect((await page.request.get('/api/platform/v1/../../v1/patients')).status()).toBe(404);
  expect(cspViolations).toEqual([]);
});
