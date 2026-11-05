import { expect, test, type Page } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticator } from 'otplib';
import { seedClinic, setLinkToken } from '../../../tools/e2e/seed-clinic';
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
  await expect(page.getByTestId('clinic-name')).toHaveText('Klinik Sehat E2E');
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

test('W07 shell: menu samping sesuai izin admin; pilih cabang aktif tersimpan di sesi', async ({ page }) => {
  watchCsp(page);
  await signInAdmin(page);
  const menu = page.getByTestId('side-menu');
  for (const label of ['Profil klinik', 'Pengguna', 'Role & izin', 'Ekspor data', 'Sesi & perangkat']) {
    await expect(menu.getByRole('link', { name: label })).toBeVisible();
  }
  const branch = page.getByLabel('Cabang aktif');
  await branch.selectOption({ label: 'Cabang Timur' });
  await page.reload();
  await expect(page.getByLabel('Cabang aktif').locator('option:checked')).toHaveText('Cabang Timur');
});

test('W08 undang pengguna dari halaman Pengguna; undangan muncul di daftar undangan aktif', async ({ page }) => {
  watchCsp(page);
  await signInAdmin(page);
  await page.getByTestId('side-menu').getByRole('link', { name: 'Pengguna' }).click();
  await expect(page.getByTestId('user-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Undang pengguna' }).click();
  const dialog = page.getByRole('dialog', { name: 'Undang pengguna' });
  await dialog.getByLabel('Email').fill('perawat@klinik-web.test');
  await expect(dialog.getByRole('button', { name: 'Kirim undangan' })).toBeDisabled();   // role wajib dipilih
  await dialog.getByLabel('Perawat / Bidan').check();
  await dialog.getByRole('button', { name: 'Kirim undangan' }).click();
  await expect(page.getByText('Undangan dikirim ke perawat@klinik-web.test.')).toBeVisible();
  await expect(page.getByTestId('invite-row').filter({ hasText: 'perawat@klinik-web.test' })).toContainText('Perawat / Bidan');
});

test('W09 terima undangan dengan password: kebijakan password tampil, lalu masuk sebagai perawat (tanpa menu pengaturan)', async ({ page }) => {
  watchCsp(page);
  await setLinkToken('invitation', 'perawat@klinik-web.test', 'tokenUndanganE2E-1234567890abcdef');
  await page.goto('/invitation/tokenUndanganE2E-1234567890abcdef');
  await expect(page.getByTestId('invite-email')).toHaveText('perawat@klinik-web.test');
  await page.getByLabel('Nama lengkap').fill('Perawat E2E');
  await page.getByLabel('Password', { exact: true }).fill('basketball');
  await page.getByLabel('Ulangi password').fill('basketball');
  await page.getByRole('button', { name: 'Buat akun' }).click();
  await expect(alertBox(page)).toContainText('terlalu umum');
  await page.getByLabel('Password', { exact: true }).fill('jahe-hangat-malam-21');
  await page.getByLabel('Ulangi password').fill('jahe-hangat-malam-21');
  await page.getByRole('button', { name: 'Buat akun' }).click();
  await expect(page).toHaveURL(/\/login\?accepted=1$/);
  await expect(page.getByText('Akun dibuat.')).toBeVisible();
  await page.getByLabel('Email').fill('perawat@klinik-web.test');
  await page.getByLabel('Password').fill('jahe-hangat-malam-21');   // pragma: allowlist secret gitleaks:allow — password uji sintetis
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId('side-menu').getByRole('link', { name: 'Pengguna' })).toHaveCount(0);
  await expect(page.getByTestId('side-menu').getByRole('link', { name: 'Sesi & perangkat' })).toBeVisible();
  // Tautan sudah dipakai
  await page.goto('/invitation/tokenUndanganE2E-1234567890abcdef');
  await expect(page.getByText('Undangan tidak berlaku')).toBeVisible();
});

test('W10 role: buat role custom dengan izin terpilih; MFA dokter dapat diatur, Admin Klinik terkunci', async ({ page }) => {
  watchCsp(page);
  await signInAdmin(page);
  await page.getByTestId('side-menu').getByRole('link', { name: 'Role & izin' }).click();
  await expect(page.locator('#mfa-TENANT_ADMIN')).toBeDisabled();
  await page.getByRole('button', { name: 'Role baru' }).click();
  const dialog = page.getByRole('dialog', { name: 'Role baru' });
  await dialog.getByLabel('Kode').fill('perawat_igd');
  await dialog.getByLabel('Nama').fill('Perawat IGD');
  await dialog.getByLabel('clinical.vitals.write').check();
  await dialog.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByText('Role Perawat IGD dibuat.')).toBeVisible();
  await expect(page.getByTestId('role-card').filter({ hasText: 'PERAWAT_IGD' })).toContainText('1 izin');
  const dokterMfa = page.locator('#mfa-DOKTER');
  await expect(dokterMfa).toBeChecked();                                           // default wajib (DEC-019)
  await dokterMfa.click();
  await expect(page.getByText('MFA untuk Dokter tidak diwajibkan lagi.')).toBeVisible();
  await expect(page.locator('#mfa-DOKTER')).not.toBeChecked();
});

test('W11 lupa password: pesan sama untuk semua email; tautan reset → password baru → masuk', async ({ page }) => {
  watchCsp(page);
  await page.goto('/login');
  await page.getByRole('link', { name: 'Lupa password?' }).click();
  // Navigasi klien: tunggu halaman baru, jangan sampai email terisi di form login yang sedang ditinggalkan
  await expect(page.getByRole('heading', { name: 'Lupa password' })).toBeVisible();
  await page.getByLabel('Email').fill('kasir@klinik-web.test');
  await page.getByRole('button', { name: 'Kirim tautan' }).click();
  await expect(page.getByText('Bila email itu terdaftar di klinik ini')).toBeVisible();
  await setLinkToken('reset', 'kasir@klinik-web.test', 'tokenResetE2E-abcdef1234567890xyz');   // pragma: allowlist secret gitleaks:allow — password uji sintetis
  await page.goto('/reset-password/tokenResetE2E-abcdef1234567890xyz');   // pragma: allowlist secret gitleaks:allow — password uji sintetis
  await page.getByLabel('Password baru').fill('sepeda-hijau-pagi-45');
  await page.getByLabel('Ulangi password').fill('sepeda-hijau-pagi-45');
  await page.getByRole('button', { name: 'Simpan password' }).click();
  await expect(page).toHaveURL(/\/login\?reset=1$/);
  await page.getByLabel('Email').fill('kasir@klinik-web.test');
  await page.getByLabel('Password').fill('sepeda-hijau-pagi-45');   // pragma: allowlist secret gitleaks:allow — password uji sintetis
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
});

test('W12 sesi & perangkat: cabut sesi lain → perangkat itu keluar; nonaktifkan pengguna dari halaman Pengguna', async ({ page, browser }) => {
  watchCsp(page);
  const other = await browser.newContext({ baseURL: CLINIC_URL });
  const otherPage = await other.newPage();
  for (const p of [page, otherPage]) {
    await p.goto('/login');
    await p.getByLabel('Email').fill('kasir@klinik-web.test');
    await p.getByLabel('Password').fill('sepeda-hijau-pagi-45');   // pragma: allowlist secret gitleaks:allow — password uji sintetis
    await p.getByRole('button', { name: 'Masuk', exact: true }).click();
    await expect(p).toHaveURL(/\/admin$/);
  }
  await page.getByTestId('side-menu').getByRole('link', { name: 'Sesi & perangkat' }).click();
  const rows = page.getByTestId('session-row');
  await expect(rows.filter({ hasText: 'Sesi ini' })).toHaveCount(1);
  const before = await rows.count();
  await rows.filter({ hasNotText: 'Sesi ini' }).first().getByRole('button', { name: 'Cabut' }).click();
  await expect(rows).toHaveCount(before - 1);
  await otherPage.reload();
  await expect(otherPage).toHaveURL(/\/login$/);
  await other.close();

  // Admin menonaktifkan kasir → sesi kasir yang tersisa langsung tidak berlaku; lalu diaktifkan kembali
  const ctx = await browser.newContext({ baseURL: CLINIC_URL });
  const adminPage = await ctx.newPage();
  await signInAdmin(adminPage);
  await adminPage.getByTestId('side-menu').getByRole('link', { name: 'Pengguna' }).click();
  const kasirRow = adminPage.getByTestId('user-row').filter({ hasText: 'kasir@klinik-web.test' });
  await kasirRow.getByRole('button', { name: 'Nonaktifkan' }).click();
  await adminPage.getByLabel('Alasan').fill('Uji E2E: cuti');
  await adminPage.getByRole('button', { name: 'Ya, nonaktifkan' }).click();
  await expect(kasirRow).toContainText('Nonaktif');
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await kasirRow.getByRole('button', { name: 'Aktifkan' }).click();
  await expect(kasirRow.getByRole('button', { name: 'Nonaktifkan' })).toBeVisible();
  await ctx.close();
});

test('W13 master data: tambah poli di cabang, tenaga kesehatan dengan NIK tersamar & SIP, lalu tautkan saat mengundang (Stage 7)', async ({ page }) => {
  watchCsp(page);
  await signInAdmin(page);
  const menu = page.getByTestId('side-menu');
  await menu.getByRole('link', { name: 'Fasilitas & cabang' }).click();
  await expect(page.getByTestId('facility-row').filter({ hasText: 'Klinik Web E2E' })).toBeVisible();
  await page.getByRole('button', { name: 'Tambah unit' }).click();
  const ud = page.getByRole('dialog', { name: 'Tambah poli/unit' });
  await ud.getByLabel('Cabang *').selectOption({ label: 'Cabang Timur' });
  await ud.getByLabel('Kode *').fill('gigi');
  await ud.getByLabel('Nama *').fill('Poli Gigi');
  await ud.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByText('Poli/unit "Poli Gigi" ditambahkan.')).toBeVisible();
  await expect(page.getByTestId('unit-row').filter({ hasText: 'Poli Gigi' })).toContainText('GIGI');

  await menu.getByRole('link', { name: 'Tenaga kesehatan' }).click();
  await page.getByRole('button', { name: 'Tambah tenaga kesehatan' }).click();
  const pd = page.getByRole('dialog', { name: 'Tambah tenaga kesehatan' });
  await pd.getByLabel('Nama lengkap (dengan gelar) *').fill('drg. Web Sintetis');
  await pd.getByLabel('Jenis').selectOption({ label: 'Dokter gigi' });
  await pd.getByLabel('NIK').fill('123');
  await expect(pd.getByText('NIK harus 16 digit angka')).toBeVisible();
  await pd.getByLabel('NIK').fill('3201011201900077');
  await pd.getByLabel('Nomor SIP').fill('SIP-WEB-1');
  await pd.getByLabel('SIP berlaku sampai').fill('2030-01-31');
  await pd.getByRole('button', { name: 'Simpan' }).click();
  const row = page.getByTestId('practitioner-row').filter({ hasText: 'drg. Web Sintetis' });
  await expect(row).toContainText('3201********0077');
  await expect(row).not.toContainText('3201011201900077');
  await row.getByRole('button', { name: 'Ubah' }).click();
  const ed = page.getByRole('dialog', { name: 'Ubah tenaga kesehatan' });
  await ed.getByLabel('Nomor SIP').fill('SIP-WEB-2');
  await ed.getByRole('button', { name: 'Simpan' }).click();
  await expect(row).toContainText('SIP-WEB-2');
  await expect(row).toContainText('3201********0077');                 // NIK tetap walau tidak diisi ulang

  await menu.getByRole('link', { name: 'Pengguna' }).click();
  await page.getByRole('button', { name: 'Undang pengguna' }).click();
  const inv = page.getByRole('dialog', { name: 'Undang pengguna' });
  await inv.getByLabel('Email').fill('drg@klinik-web.test');
  await inv.getByLabel('Tenaga kesehatan (opsional)').selectOption({ label: 'drg. Web Sintetis · Dokter gigi' });
  await expect(inv.getByLabel('Nama (opsional)')).toHaveValue('drg. Web Sintetis');
  await inv.getByLabel(/^Dokter/).check();
  await inv.getByRole('button', { name: 'Kirim undangan' }).click();
  await expect(page.getByText('Undangan dikirim ke drg@klinik-web.test.')).toBeVisible();
});

test('W14 layanan & tarif berperiode, penjamin dengan kontrak, satuan & konversi, supplier (Stage 7 batch 2)', async ({ page }) => {
  watchCsp(page);
  await signInAdmin(page);
  const menu = page.getByTestId('side-menu');
  await menu.getByRole('link', { name: 'Penjamin' }).click();
  await page.getByRole('button', { name: 'Tambah penjamin' }).click();
  const pd = page.getByRole('dialog', { name: 'Tambah penjamin' });
  await pd.getByLabel('Kode *').fill('asr-web');
  await pd.getByLabel('Nama *').fill('Asuransi Web Sintetis');
  await pd.getByLabel('Plafon (Rp)').fill('5000000');
  await pd.getByLabel('Co-pay (%)').fill('10');
  await pd.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByTestId('payer-row').filter({ hasText: 'Asuransi Web Sintetis' })).toContainText('plafon Rp 5.000.000 · co-pay 10%');

  await menu.getByRole('link', { name: 'Layanan & tarif' }).click();
  await page.getByRole('button', { name: 'Tambah layanan' }).click();
  const sd = page.getByRole('dialog', { name: 'Tambah layanan' });
  await sd.getByLabel('Kode *').fill('kons-umum');
  await sd.getByLabel('Nama *').fill('Konsultasi Dokter Umum');
  await sd.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByText('Layanan "Konsultasi Dokter Umum" ditambahkan.')).toBeVisible();
  const addTariff = async (price: string, from: string) => {
    await page.getByRole('button', { name: 'Tambah tarif' }).click();
    const td = page.getByRole('dialog', { name: 'Tambah tarif' });
    await td.getByLabel('Harga (Rp) *').fill(price);
    await td.getByLabel('Berlaku mulai *').fill(from);
    await td.getByRole('button', { name: 'Simpan tarif' }).click();
    await expect(td).toBeHidden();
  };
  await addTariff('75000', '2026-01-01');
  await addTariff('90000', '2099-01-01');                                  // harga baru → tarif lama ditutup otomatis
  const rows = page.getByTestId('tariff-row');
  await expect(rows.filter({ hasText: 'Rp 90.000' })).toContainText('akan datang');
  await expect(rows.filter({ hasText: 'Rp 75.000' })).toContainText('31 Des 2098');

  await menu.getByRole('link', { name: 'Satuan & supplier' }).click();
  for (const [code, name] of [['box', 'Box'], ['strip', 'Strip']]) {
    await page.getByRole('button', { name: 'Tambah satuan' }).click();
    const ud = page.getByRole('dialog', { name: 'Tambah satuan' });
    await ud.getByLabel('Kode *').fill(code);
    await ud.getByLabel('Nama *').fill(name);
    await ud.getByRole('button', { name: 'Simpan' }).click();
    await expect(ud).toBeHidden();
  }
  const uomRow = (code: string) => page.getByTestId('uom-row').filter({ has: page.getByRole('cell', { name: code, exact: true }) });
  await uomRow('BOX').getByRole('button', { name: 'Konversi' }).click();
  const cd = page.getByRole('dialog', { name: 'Konversi dari BOX' });
  await cd.getByLabel('Satuan tujuan').selectOption({ label: 'STRIP — Strip' });
  await cd.getByLabel('Faktor *').fill('10');
  await cd.getByRole('button', { name: 'Simpan konversi' }).click();
  await expect(uomRow('BOX')).toContainText('1 BOX = 10 STRIP');
  await uomRow('STRIP').getByRole('button', { name: 'Konversi' }).click();
  const cd2 = page.getByRole('dialog', { name: 'Konversi dari STRIP' });
  await cd2.getByLabel('Satuan tujuan').selectOption({ label: 'BOX — Box' });
  await cd2.getByLabel('Faktor *').fill('0.1');
  await cd2.getByRole('button', { name: 'Simpan konversi' }).click();
  await expect(cd2.getByText(/Konversi melingkar/)).toBeVisible();          // ditolak API
  await cd2.getByRole('button', { name: 'Tutup' }).click();

  await page.getByRole('button', { name: 'Tambah supplier' }).click();
  const spd = page.getByRole('dialog', { name: 'Tambah supplier' });
  await spd.getByLabel('Nama *').fill('PBF Web Sintetis');
  await spd.getByLabel('NPWP').fill('123');
  await expect(spd.getByRole('button', { name: 'Simpan' })).toBeDisabled();
  await spd.getByLabel('NPWP').fill('01.234.567.8-901.000');
  await spd.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByTestId('supplier-row').filter({ hasText: 'PBF Web Sintetis' })).toContainText('01.234.567.8-901.000');
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
