import { expect, test, type Page } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticator } from 'otplib';
import { addClinicUser, seedClinic, setLinkToken } from '../../../tools/e2e/seed-clinic';
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

test('W15 diagnosis & tindakan: cari ICD-10 dengan sinonim, jadikan favorit; validasi ditolak untuk non-dokter; wilayah cabang (Stage 7 batch 3)', async ({ page }) => {
  watchCsp(page);
  await signInAdmin(page);
  const menu = page.getByTestId('side-menu');
  await menu.getByRole('link', { name: 'Diagnosis & tindakan' }).click();
  await expect(page.getByTestId('code-system-info')).toContainText('CONTOH');
  await page.getByLabel('Cari kode atau kata kunci').fill('darah tinggi');
  const row = page.getByTestId('concept-row').filter({ hasText: 'Hipertensi esensial' });
  await expect(row).toContainText('I10');
  await row.getByRole('button', { name: 'Jadikan favorit' }).click();
  await expect(row).toContainText('belum divalidasi');
  await row.getByRole('button', { name: 'Validasi' }).click();
  await expect(alertBox(page)).toContainText('hanya oleh dokter');
  await page.getByLabel('Tampilkan').selectOption({ label: 'Favorit klinik' });
  await page.getByLabel('Cari kode atau kata kunci').fill('');
  await expect(page.getByTestId('concept-row')).toHaveCount(1);
  await page.getByLabel('Sistem kode').selectOption({ label: 'ICD-9-CM (tindakan)' });
  await page.getByLabel('Tampilkan').selectOption({ label: 'Semua kode' });
  await page.getByLabel('Cari kode atau kata kunci').fill('nebulizer');
  await expect(page.getByTestId('concept-row')).toContainText('93.94');

  await menu.getByRole('link', { name: 'Fasilitas & cabang' }).click();
  await page.getByTestId('branch-row').filter({ hasText: 'Cabang Timur' }).getByRole('button', { name: 'Ubah' }).click();
  const bd = page.getByRole('dialog', { name: 'Ubah cabang' });
  await bd.getByLabel('Provinsi').selectOption({ label: 'Jawa Barat' });
  await bd.getByLabel('Kabupaten/kota').selectOption({ label: 'Kota Bandung' });
  await bd.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByText('Cabang "Cabang Timur" disimpan.')).toBeVisible();
  await page.getByTestId('branch-row').filter({ hasText: 'Cabang Timur' }).getByRole('button', { name: 'Ubah' }).click();
  await expect(page.getByRole('dialog', { name: 'Ubah cabang' }).getByLabel('Kabupaten/kota').locator('option:checked')).toHaveText('Kota Bandung');
});

test('W16 impor & ekspor: unduh template, periksa berkas (error per baris), simpan, data muncul di Layanan (Stage 7 batch 4)', async ({ page }) => {
  watchCsp(page);
  await signInAdmin(page);
  await page.getByTestId('side-menu').getByRole('link', { name: 'Impor & ekspor' }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Template CSV' }).click();
  expect((await dl).suggestedFilename()).toBe('service-items-template.csv');
  const upload = (text: string) => page.getByLabel('Berkas impor').setInputFiles({ name: 'layanan.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });
  await upload('code,name,serviceType\nIMP-WEB,Imunisasi,TINDAKAN\nIMP-WEB2,X,TINDAKAN\n');
  await page.getByRole('button', { name: 'Periksa' }).click();
  await expect(page.getByTestId('import-result')).toContainText('Ada kesalahan');
  await expect(page.getByTestId('import-error')).toContainText('3');
  await expect(page.getByRole('button', { name: 'Simpan' })).toBeDisabled();
  await upload('code;name;serviceType\nIMP-WEB;Imunisasi Dasar;TINDAKAN\n');
  await page.getByRole('button', { name: 'Periksa' }).click();
  await expect(page.getByTestId('import-result')).toContainText('Siap disimpan');
  await page.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByTestId('import-result')).toContainText('Tersimpan');
  await page.getByTestId('side-menu').getByRole('link', { name: 'Layanan & tarif' }).click();
  await expect(page.getByTestId('service-row').filter({ hasText: 'IMP-WEB' })).toContainText('Imunisasi Dasar');
});

test('W17 pendaftaran: daftar pasien NIK (No. RM otomatis, NIK tersamar), cari salah ketik, kandidat duplikat wajib alasan, tambah penjamin (Stage 8 batch 1)', async ({ page }) => {
  watchCsp(page);
  await addClinicUser('pendaftaran@klinik-web.test', 'Pendaftaran E2E', 'PENDAFTARAN');
  await login(page, 'pendaftaran@klinik-web.test');
  await expect(page).toHaveURL(/\/admin$/);
  const menu = page.getByTestId('side-menu');
  await menu.getByRole('link', { name: 'Pasien' }).click();
  await page.getByRole('link', { name: 'Daftar pasien baru' }).click();
  await expect(page).toHaveURL(/\/patients\/new$/);
  await page.locator('#pf-nik').fill('3273014503850001');
  await page.locator('#pf-name').fill('Siti Rahmawati');
  await page.locator('#pf-dob').fill('1985-03-12');
  await page.locator('#pf-sex').selectOption({ label: 'Perempuan' });
  await page.locator('#pf-address').fill('Jl. Melati No. 1, Bandung');
  await page.getByLabel('Provinsi').selectOption({ label: 'Jawa Barat' });
  await page.locator('#pf-phone').fill('+62 812-3456-7001');
  await page.getByRole('button', { name: 'Tambah kontak' }).click();
  await page.locator('#pf-c-rel-0').fill('Suami');
  await page.locator('#pf-c-name-0').fill('Andi Pratama');
  await page.locator('#pf-c-phone-0').fill('081234567002');
  await page.getByRole('button', { name: 'Daftarkan pasien' }).click();
  await expect(page.getByText('Pasien berhasil didaftarkan.')).toBeVisible();
  await expect(page.getByTestId('patient-mrn')).toHaveText('00000001');
  await expect(page.getByText('3273********0001')).toBeVisible();
  await expect(page.getByText('3273014503850001')).toHaveCount(0);
  await expect(page.getByTestId('contact-list')).toContainText('Andi Pratama');

  await page.getByRole('button', { name: 'Tambah penjamin' }).click();
  const cv = page.getByRole('dialog', { name: 'Tambah penjamin' });
  await cv.getByLabel('Penjamin *').selectOption({ label: 'Asuransi Web Sintetis (Asuransi)' });
  await cv.getByLabel('No. peserta/polis').fill('POL-778');
  await cv.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByTestId('coverage-row')).toContainText('POL-778');

  await menu.getByRole('link', { name: 'Pasien' }).click();
  await page.getByLabel('Cari pasien').fill('siti rahmawti');
  await expect(page.getByTestId('patient-row').first()).toContainText('Siti Rahmawati');

  await page.getByRole('link', { name: 'Daftar pasien baru' }).click();
  await page.locator('#pf-idtype').selectOption({ label: 'Tanpa identitas' });
  await page.locator('#pf-name').fill('Siti Rahmawaty');
  await page.locator('#pf-dob').fill('1985-03-12');
  await page.locator('#pf-sex').selectOption({ label: 'Perempuan' });
  await page.locator('#pf-address').fill('Jl. Melati No. 1, Bandung');
  await page.locator('#pf-phone').fill('081399999999');
  await page.getByRole('button', { name: 'Daftarkan pasien' }).click();
  const dup = page.getByTestId('duplicate-panel');
  await expect(dup).toContainText('data mirip');
  await expect(dup).toContainText('00000001');
  await expect(dup.getByRole('button', { name: 'Tetap daftarkan baru' })).toBeDisabled();
  await dup.getByLabel('Alasan tetap mendaftarkan sebagai pasien baru *').fill('Pasien berbeda, dicek dengan KK');
  await dup.getByRole('button', { name: 'Tetap daftarkan baru' }).click();
  await expect(page.getByTestId('patient-mrn')).toHaveText('00000002');
});

test('W18 consent berversi & gabung pasien: admin menerbitkan teks, petugas mencatat consent, admin menggabungkan data ganda (Stage 8 batch 1)', async ({ page }) => {
  watchCsp(page);
  await signInAdmin(page);
  const menu = page.getByTestId('side-menu');
  await menu.getByRole('link', { name: 'Dokumen consent' }).click();
  await page.getByRole('button', { name: 'Terbitkan versi baru' }).click();
  const cd = page.getByRole('dialog', { name: 'Terbitkan dokumen consent' });
  await cd.getByLabel('Versi *').fill('1');
  await cd.getByLabel('Judul *').fill('Persetujuan Umum (CONTOH)');
  await cd.getByLabel('Isi *').fill('Teks contoh persetujuan umum pelayanan rawat jalan — wajib ditinjau klinik sebelum dipakai.');
  await cd.getByRole('button', { name: 'Terbitkan' }).click();
  await expect(page.getByText('Versi 1 diterbitkan.')).toBeVisible();
  await expect(page.getByTestId('consent-doc-row')).toContainText('Persetujuan Umum (CONTOH)');

  // Admin: gabungkan "Siti Rahmawaty" (data ganda) ke "Siti Rahmawati"
  await menu.getByRole('link', { name: 'Pasien' }).click();
  await page.getByLabel('Cari pasien').fill('Rahmawaty');
  await page.getByTestId('patient-row').filter({ hasText: 'Siti Rahmawaty' }).getByRole('link', { name: 'Siti Rahmawaty', exact: true }).click();
  await page.getByRole('button', { name: 'Gabungkan ke pasien lain' }).click();
  const mg = page.getByRole('dialog', { name: 'Gabungkan pasien' });
  await mg.getByLabel('Cari pasien tujuan').fill('00000001');
  await mg.getByRole('button', { name: /Siti Rahmawati/ }).click();
  await mg.getByLabel('Alasan *').fill('Orang yang sama, terdaftar dua kali');
  await mg.getByRole('button', { name: 'Gabungkan' }).click();
  await expect(page.getByTestId('patient-mrn')).toHaveText('00000001');
  await page.getByRole('button', { name: 'Keluar' }).click();

  // Petugas pendaftaran: catat consent
  await login(page, 'pendaftaran@klinik-web.test');
  await page.getByTestId('side-menu').getByRole('link', { name: 'Pasien' }).click();
  await page.getByLabel('Cari pasien').fill('00000001');
  await page.getByTestId('patient-row').first().getByRole('link', { name: 'Siti Rahmawati', exact: true }).click();
  await expect(page.getByText('Belum ada persetujuan umum yang berlaku.')).toBeVisible();
  await page.getByRole('button', { name: 'Catat consent' }).click();
  const cs = page.getByRole('dialog', { name: 'Catat consent' });
  await expect(cs.getByTestId('consent-text')).toContainText('wajib ditinjau klinik');
  await cs.getByLabel('Nama penanda tangan').fill('Siti Rahmawati');
  await cs.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByText('Consent dicatat.')).toBeVisible();
  await expect(page.getByTestId('consent-row')).toContainText('Setuju');
  await expect(page.getByText('Belum ada persetujuan umum yang berlaku.')).toHaveCount(0);
});

test('W19 jadwal & janji temu: admin membuat jadwal & cuti, petugas memesan slot, menjadwalkan ulang, dan membatalkan (Stage 8 batch 2)', async ({ page }) => {
  watchCsp(page);
  // Tanggal Senin 1–2 minggu ke depan (WIB) & Selasa sesudahnya
  const wib = new Date(Date.now() + 7 * 3600_000);
  const d = new Date(Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + ((8 - ((d.getUTCDay() + 6) % 7 + 1)) % 7) + 7);
  const mon = d.toISOString().slice(0, 10);
  const tue = new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);

  await signInAdmin(page);
  const menu = page.getByTestId('side-menu');
  await menu.getByRole('link', { name: 'Jadwal dokter' }).click();
  await page.getByRole('button', { name: 'Tambah jadwal' }).click();
  const sd = page.getByRole('dialog', { name: 'Tambah jadwal praktik' });
  await sd.getByLabel('Dokter *').selectOption({ label: 'drg. Web Sintetis' });
  await sd.getByLabel('Cabang *').selectOption({ label: 'Cabang Timur' });
  await sd.getByLabel('Poli/ruang *').selectOption({ label: 'Poli Gigi' });
  await sd.getByLabel('Hari').selectOption({ label: 'Senin' });
  await sd.getByLabel('Mulai', { exact: true }).fill('08:00');
  await sd.getByLabel('Selesai', { exact: true }).fill('10:00');
  await sd.getByLabel('Slot (menit)').fill('30');
  await expect(sd.getByText('Kosong = 4 (jumlah slot)')).toBeVisible();
  await sd.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByText('Jadwal ditambahkan.')).toBeVisible();
  await expect(page.getByTestId('schedule-row')).toContainText('08:00–10:00');
  await expect(page.getByTestId('schedule-row')).toContainText('4 / 4');
  // Jadwal Selasa juga, lalu cuti pada Selasa itu
  await page.getByRole('button', { name: 'Tambah jadwal' }).click();
  await sd.getByLabel('Dokter *').selectOption({ label: 'drg. Web Sintetis' });
  await sd.getByLabel('Cabang *').selectOption({ label: 'Cabang Timur' });
  await sd.getByLabel('Poli/ruang *').selectOption({ label: 'Poli Gigi' });
  await sd.getByLabel('Hari').selectOption({ label: 'Selasa' });
  await sd.getByLabel('Mulai', { exact: true }).fill('13:00');
  await sd.getByLabel('Selesai', { exact: true }).fill('14:00');
  await sd.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByTestId('schedule-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Tambah cuti/libur' }).click();
  const ex = page.getByRole('dialog', { name: 'Tambah cuti/libur' });
  await ex.getByLabel('Dokter *').selectOption({ label: 'drg. Web Sintetis' });
  await ex.getByLabel('Tanggal *').fill(tue);
  await ex.getByLabel('Alasan *').fill('Pelatihan');
  await ex.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByTestId('exception-row')).toContainText('Pelatihan');
  await page.getByRole('button', { name: 'Keluar' }).click();

  await login(page, 'pendaftaran@klinik-web.test');
  await page.getByTestId('side-menu').getByRole('link', { name: 'Janji temu' }).click();
  await page.getByRole('button', { name: 'Buat janji temu' }).click();
  const bk = page.getByRole('dialog', { name: 'Buat janji temu' });
  await bk.getByLabel('Cari pasien').fill('Siti');
  await bk.getByRole('button', { name: /Siti Rahmawati/ }).click();
  await bk.getByLabel('Tanggal').fill(tue);
  await expect(bk.getByTestId('slot-picker')).toContainText('Dokter cuti: Pelatihan');
  await bk.getByLabel('Tanggal').fill(mon);
  await bk.getByRole('button', { name: 'drg. Web Sintetis 08:00' }).click();
  await bk.getByLabel('Catatan').fill('Kontrol gigi');
  await bk.getByRole('button', { name: 'Simpan janji temu' }).click();
  await expect(page.getByText(/Janji temu Siti Rahmawati — .* 08:00 dibuat\./)).toBeVisible();
  const row = page.getByTestId('appointment-row').filter({ hasText: 'Siti Rahmawati' });
  await expect(row).toContainText('Terjadwal');

  await row.getByRole('button', { name: 'Jadwal ulang' }).click();
  const rs = page.getByRole('dialog', { name: 'Jadwal ulang janji temu' });
  await expect(rs.getByRole('button', { name: 'drg. Web Sintetis 08:00 (terisi)' })).toBeDisabled();
  await rs.getByRole('button', { name: 'drg. Web Sintetis 09:00' }).click();
  await rs.getByLabel('Alasan jadwal ulang *').fill('Pasien minta lebih siang');
  await rs.getByRole('button', { name: 'Jadwalkan ulang' }).click();
  await expect(page.getByText(/Dijadwalkan ulang ke .* 09:00\./)).toBeVisible();
  await expect(page.getByTestId('appointment-row').filter({ hasText: 'Dijadwalkan ulang' })).toContainText('Pasien minta lebih siang');

  const booked = page.getByTestId('appointment-row').filter({ hasText: 'Terjadwal' });
  await booked.getByRole('button', { name: 'Batalkan' }).click();
  const cn = page.getByRole('dialog', { name: 'Batalkan janji temu' });
  await cn.getByLabel('Alasan *').fill('Pasien berhalangan');
  await cn.getByRole('button', { name: 'Batalkan janji' }).click();
  await expect(page.getByText('Janji temu dibatalkan.')).toBeVisible();
  await expect(page.getByTestId('appointment-row').filter({ hasText: 'Dibatalkan' })).toContainText('Pasien berhalangan');
});

test('W20 kunjungan & antrean: walk-in dengan verifikasi asuransi, panggil/lewati/panggil ulang, batal, riwayat pasien (Stage 8 batch 3)', async ({ page }) => {
  watchCsp(page);
  await login(page, 'pendaftaran@klinik-web.test');
  const menu = page.getByTestId('side-menu');
  await menu.getByRole('link', { name: 'Kunjungan' }).click();
  await page.getByRole('button', { name: 'Daftar walk-in' }).click();
  const wi = page.getByRole('dialog', { name: 'Daftar kunjungan walk-in' });
  await wi.getByLabel('Cari pasien').fill('Siti');
  await wi.getByRole('button', { name: /Siti Rahmawati/ }).click();
  await wi.getByLabel('Poli *').selectOption({ label: 'Poli Gigi' });
  await wi.getByLabel('Dokter *').selectOption({ label: 'drg. Web Sintetis' });
  await wi.getByLabel('Penjamin').selectOption({ label: 'Asuransi Web Sintetis (Asuransi) — POL-778' });
  const submit = wi.getByRole('button', { name: 'Daftarkan & ambil nomor antrean' });
  await expect(submit).toBeDisabled();
  await wi.getByLabel('Verifikasi kepesertaan *').fill('Konfirmasi telepon ref 778');
  await submit.click();
  await expect(page.getByTestId('visit-notice')).toContainText('Nomor antrean G-001');
  const row = page.getByTestId('visit-row').filter({ hasText: 'Siti Rahmawati' });
  await expect(row).toContainText('G-001');
  await expect(row).toContainText('Asuransi Web Sintetis');
  await expect(row).toContainText('Hadir');

  await menu.getByRole('link', { name: 'Antrean' }).click();
  await page.getByLabel('Poli').selectOption({ label: 'Poli Gigi' });
  await page.getByRole('button', { name: 'Panggil berikutnya' }).click();
  await expect(page.getByTestId('now-calling')).toContainText('G-001');
  await expect(page.getByTestId('now-calling')).toContainText('Siti Rahmawati');
  const q = page.getByTestId('queue-row').filter({ hasText: 'G-001' });
  await q.getByRole('button', { name: 'Lewati' }).click();
  await expect(q).toContainText('Dilewati');
  await q.getByRole('button', { name: 'Panggil' }).click();
  await expect(q).toContainText('Dipanggil');
  await q.getByRole('button', { name: 'Panggil ulang' }).click();
  await expect(page.getByTestId('now-calling')).toContainText('dipanggil 3×');

  await menu.getByRole('link', { name: 'Kunjungan' }).click();
  await page.getByTestId('visit-row').filter({ hasText: 'Siti Rahmawati' }).getByRole('button', { name: 'Batalkan' }).click();
  const cn = page.getByRole('dialog', { name: 'Batalkan kunjungan' });
  await cn.getByLabel('Alasan *').fill('Pasien pulang');
  await cn.getByRole('button', { name: 'Batalkan kunjungan' }).click();
  await expect(page.getByTestId('visit-notice')).toContainText('Kunjungan dibatalkan.');
  await expect(page.getByTestId('visit-row').filter({ hasText: 'Siti Rahmawati' })).toContainText('Dibatalkan');
  await page.getByTestId('visit-row').filter({ hasText: 'Siti Rahmawati' }).getByRole('link', { name: 'Siti Rahmawati' }).click();
  await expect(page.getByTestId('history-row').first()).toContainText('Poli Gigi');
  await expect(page.getByTestId('history-row').first()).toContainText('Dibatalkan');
});

test('W21 layar TV antrean: admin membuat tautan, TV tanpa login menerima panggilan secara langsung (SSE) tanpa nama pasien, tautan dicabut (Stage 8 batch 4)', async ({ page, browser }) => {
  watchCsp(page);
  await signInAdmin(page);
  await page.getByTestId('side-menu').getByRole('link', { name: 'Layar antrean' }).click();
  await page.getByRole('button', { name: 'Buat tautan layar' }).click();
  const cd = page.getByRole('dialog', { name: 'Buat tautan layar' });
  await cd.getByLabel('Label').fill('TV lobi');
  await cd.getByRole('button', { name: 'Buat tautan' }).click();
  const shown = page.getByTestId('display-url');
  await expect(shown).toContainText('/display/');
  const url = (await shown.locator('code').textContent())!.trim();
  await expect(page.getByTestId('display-row').filter({ hasText: 'TV lobi' })).toContainText('Aktif');

  // TV: konteks peramban terpisah tanpa cookie sesi
  const tvCtx = await browser.newContext();
  const tv = await tvCtx.newPage();
  await tv.goto(url);
  await expect(tv.getByTestId('queue-display')).toBeVisible();
  const gigi = tv.getByTestId('display-unit').filter({ hasText: 'Poli Gigi' });
  await expect(gigi).toBeVisible();

  // Petugas mendaftarkan walk-in & memanggil → layar TV berubah tanpa dimuat ulang
  const staffCtx = await browser.newContext();
  const staff = await staffCtx.newPage();
  await login(staff, 'pendaftaran@klinik-web.test');
  const menu = staff.getByTestId('side-menu');
  await menu.getByRole('link', { name: 'Kunjungan' }).click();
  await staff.getByRole('button', { name: 'Daftar walk-in' }).click();
  const wi = staff.getByRole('dialog', { name: 'Daftar kunjungan walk-in' });
  await wi.getByLabel('Cari pasien').fill('Siti');
  await wi.getByRole('button', { name: /Siti Rahmawati/ }).click();
  await wi.getByLabel('Poli *').selectOption({ label: 'Poli Gigi' });
  await wi.getByLabel('Dokter *').selectOption({ label: 'drg. Web Sintetis' });
  await wi.getByRole('button', { name: 'Daftarkan & ambil nomor antrean' }).click();
  const notice = staff.getByTestId('visit-notice');
  await expect(notice).toContainText(/Nomor antrean G-\d{3}/);
  const code = /G-\d{3}/.exec((await notice.textContent()) ?? '')![0];
  await expect(gigi).toContainText(`Berikutnya: ${code}`);
  await menu.getByRole('link', { name: 'Antrean' }).click();
  await staff.getByLabel('Poli').selectOption({ label: 'Poli Gigi' });
  await staff.getByRole('button', { name: 'Panggil berikutnya' }).click();
  await expect(staff.getByTestId('now-calling')).toContainText(code);
  await expect(gigi.getByTestId('display-calling')).toHaveText(code);
  await expect(tv.getByTestId('queue-display')).not.toContainText('Siti');
  await expect(tv.getByTestId('queue-display')).not.toContainText('Rahmawati');
  await staffCtx.close();

  // Admin mencabut → TV berhenti menerima data; tautan tidak dapat dibuka lagi
  await page.getByTestId('display-row').filter({ hasText: 'TV lobi' }).getByRole('button', { name: 'Cabut' }).click();
  await expect(page.getByTestId('display-row').filter({ hasText: 'TV lobi' })).toContainText('Dicabut');
  const again = await tvCtx.newPage();
  await again.goto(url);
  await expect(again.getByText('Tautan layar antrean tidak berlaku')).toBeVisible();
  await tvCtx.close();
  expect(cspViolations).toEqual([]);
});

test('W22 rekam medis: dokter membuka worklist, mulai periksa, isi vital (IMT otomatis), alergi tampil di header, SOAP, diagnosis & tindakan (Stage 9 batch 1)', async ({ page }) => {
  watchCsp(page);
  await addClinicUser('dokter@klinik-web.test', 'drg. Web Sintetis', 'DOKTER', 'drg. Web Sintetis');
  await login(page, 'dokter@klinik-web.test');
  await page.getByTestId('side-menu').getByRole('link', { name: 'Worklist klinis' }).click();
  const row = page.getByTestId('worklist-row').filter({ hasText: 'Siti Rahmawati' });
  await expect(row).toContainText('Poli Gigi');
  await row.getByRole('button', { name: 'Mulai periksa' }).click();
  await expect(page.getByTestId('chart-patient')).toHaveText('Siti Rahmawati');
  await expect(page.getByText('Diperiksa', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Tanda vital' }).click();
  await page.getByLabel('TD sistolik (mmHg)').fill('120');
  await page.getByLabel('TD diastolik (mmHg)').fill('80');
  await page.getByLabel('Suhu (°C)').fill('37,5');
  await page.getByLabel('Berat badan (kg)').fill('60');
  await page.getByLabel('Tinggi badan (cm)').fill('160');
  await page.getByRole('button', { name: 'Simpan tanda vital' }).click();
  await expect(page.getByTestId('vital-row').first()).toContainText('IMT 23.4 kg/m²');
  await expect(page.getByTestId('vital-row').first()).toContainText('Suhu 37.5 °C');

  await page.getByRole('tab', { name: 'Alergi & riwayat' }).click();
  await page.getByLabel('Zat / bahan').fill('Amoksisilin');
  await page.getByLabel('Keparahan').selectOption('BERAT');
  await page.getByRole('button', { name: 'Catat alergi' }).click();
  await expect(page.getByTestId('allergy-row').first()).toContainText('Amoksisilin');
  await expect(page.getByTestId('allergy-banner')).toContainText('Alergi: Amoksisilin (berat)');

  await page.getByRole('tab', { name: 'SOAP' }).click();
  await page.getByLabel('S — Subjektif (anamnesis)').fill('Gigi geraham kiri bawah berlubang dan nyeri saat makan.');
  await page.getByLabel('Kesadaran').selectOption('Compos mentis');
  await page.getByLabel('O — Objektif (pemeriksaan)').fill('Karies media gigi 36.');
  await page.getByLabel('A — Asesmen').fill('Karies gigi');
  await page.getByLabel('P — Rencana').fill('Tambal gigi');
  await page.getByRole('button', { name: 'Simpan draft' }).click();
  await expect(page.getByTestId('soap-saved')).toBeVisible();

  await page.getByRole('tab', { name: 'Diagnosis & tindakan' }).click();
  await page.getByLabel('Cari diagnosis').fill('gigi berlubang');
  await page.getByRole('button', { name: /K02\.9/ }).click();
  await expect(page.getByTestId('dx-row')).toContainText('Karies gigi, tidak spesifik');
  await expect(page.getByLabel('Jenis K02.9')).toHaveValue('PRIMER');
  await page.getByLabel('Layanan').selectOption({ index: 1 });
  await page.getByLabel('Cari tindakan').fill('tambal');
  await page.getByRole('button', { name: /23\.2/ }).click();
  await page.getByRole('button', { name: 'Tambah tindakan' }).click();
  await expect(page.getByTestId('procedure-row')).toContainText('23.2');
  await expect(page.getByTestId('procedure-row')).toContainText('drg. Web Sintetis');

  // Dimuat ulang: data tersimpan; ringkasan menampilkan vital terakhir
  await page.reload();
  await expect(page.getByTestId('allergy-banner')).toContainText('Amoksisilin');
  await expect(page.getByLabel('A — Asesmen')).toHaveValue('Karies gigi');
  await page.getByRole('tab', { name: 'Ringkasan' }).click();
  await expect(page.getByText('23.4 kg/m²')).toBeVisible();
  expect(cspViolations).toEqual([]);
});

test('W23 pengesahan: admin melihat tautan nakes, dokter mengesahkan dengan kata sandi, periksa integritas, addendum, riwayat rekam medis (Stage 9 batch 2)', async ({ page, browser }) => {
  watchCsp(page);
  await signInAdmin(page);
  await page.getByTestId('side-menu').getByRole('link', { name: 'Pengguna' }).click();
  await page.getByTestId('user-row').filter({ hasText: 'dokter@klinik-web.test' }).getByRole('button', { name: 'Tenaga kesehatan' }).click();
  const ld = page.getByRole('dialog', { name: 'Tautkan tenaga kesehatan' });
  await expect(ld).toContainText('Saat ini: drg. Web Sintetis');
  await ld.getByRole('button', { name: 'Batal' }).click();

  const ctx = await browser.newContext();
  const doc = await ctx.newPage();
  watchCsp(doc);
  await login(doc, 'dokter@klinik-web.test');
  await doc.getByTestId('side-menu').getByRole('link', { name: 'Worklist klinis' }).click();
  await doc.getByTestId('worklist-row').filter({ hasText: 'Siti Rahmawati' }).getByRole('link', { name: 'Buka' }).click();
  await expect(doc.getByText('Rekam medis lengkap dan siap disahkan.')).toBeVisible();
  await doc.getByRole('button', { name: 'Sahkan rekam medis' }).click();
  const sd = doc.getByRole('dialog', { name: 'Sahkan rekam medis' });
  await sd.getByLabel('Kata sandi Anda').fill('salah-sekali');
  await sd.getByRole('button', { name: 'Sahkan', exact: true }).click();
  await expect(sd).toContainText('Kata sandi tidak cocok');
  await sd.getByLabel('Kata sandi Anda').fill(USER_PASSWORD);
  await sd.getByRole('button', { name: 'Sahkan', exact: true }).click();
  const panel = doc.getByTestId('signed-panel');
  await expect(panel).toContainText('drg. Web Sintetis (SIP SIP-WEB-2)');
  await expect(panel).toContainText('konfirmasi kata sandi');
  await expect(doc.getByLabel('A — Asesmen')).toBeDisabled();
  await panel.getByRole('button', { name: 'Periksa integritas' }).click();
  await expect(doc.getByTestId('verify-result')).toContainText('Isi sesuai saat disahkan');

  await panel.getByRole('button', { name: 'Tambah addendum' }).click();
  const ad = doc.getByRole('dialog', { name: 'Tambah addendum' });
  await ad.getByLabel('Alasan *').fill('Melengkapi rencana tindak lanjut');
  await ad.getByLabel('Isi addendum *').fill('Kontrol 1 minggu untuk tambal permanen.');
  await ad.getByLabel('Kata sandi Anda').fill(USER_PASSWORD);
  await ad.getByRole('button', { name: 'Simpan addendum' }).click();
  await expect(doc.getByTestId('addendum-row')).toContainText('Kontrol 1 minggu untuk tambal permanen.');
  await expect(doc.getByLabel('A — Asesmen')).toHaveValue('Karies gigi');          // catatan asli tidak berubah

  await doc.getByRole('link', { name: 'Riwayat rekam medis' }).click();
  const entry = doc.getByTestId('record-entry').first();
  await expect(entry).toContainText('Disahkan');
  await expect(entry).toContainText('K02.9');
  await expect(entry.getByTestId('record-addendum')).toContainText('Melengkapi rencana tindak lanjut');
  await ctx.close();
  expect(cspViolations).toEqual([]);
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
