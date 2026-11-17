import { expect, test, type Page } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticator } from 'otplib';
import { addClinicBillingEncounter, addClinicDrugStock, addClinicRole, addClinicTariffs, addClinicUser, markLatestSatuSehatAddendumDead, seedClinic, setLinkToken } from '../../../tools/e2e/seed-clinic';
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

/** Password kasir sudah diganti di W11 (lupa password). */
async function loginKasir(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('kasir@klinik-web.test');
  await page.getByLabel('Password').fill('sepeda-hijau-pagi-45');   // pragma: allowlist secret gitleaks:allow — password uji sintetis
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

test('W24 resep: farmasi menambah obat, dokter meresepkan, peringatan alergi wajib beralasan, selesai konsultasi menerbitkan resep (Stage 9 batch 3)', async ({ page, browser }) => {
  watchCsp(page);
  await addClinicUser('farmasi@klinik-web.test', 'Apoteker E2E', 'FARMASI');
  await login(page, 'farmasi@klinik-web.test');
  await page.getByTestId('side-menu').getByRole('link', { name: 'Obat', exact: true }).click();
  await page.getByRole('button', { name: 'Tambah obat' }).click();
  const dd = page.getByRole('dialog', { name: 'Tambah obat' });
  await dd.getByLabel('Kode *').fill('AMX500');
  await dd.getByLabel('Golongan').selectOption('KERAS');
  await dd.getByLabel('Nama generik *').fill('Amoksisilin 500 mg');
  await dd.getByLabel('Bentuk sediaan *').fill('Kapsul');
  await dd.getByLabel('Satuan dasar *').selectOption({ label: 'Strip (STRIP)' });
  await dd.getByLabel('Zat aktif *').fill('Amoksisilin');
  await dd.getByLabel('Batas per pemberian (satuan dasar)').fill('1');
  await dd.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByTestId('drug-row').filter({ hasText: 'AMX500' })).toContainText('amoksisilin');

  const ctx = await browser.newContext();
  const doc = await ctx.newPage();
  watchCsp(doc);
  await login(doc, 'dokter@klinik-web.test');
  await doc.getByTestId('side-menu').getByRole('link', { name: 'Worklist klinis' }).click();
  await doc.getByTestId('worklist-row').filter({ hasText: 'Siti Rahmawati' }).getByRole('link', { name: 'Buka' }).click();
  await doc.getByRole('tab', { name: 'Resep' }).click();
  await doc.getByRole('button', { name: 'Tambah obat' }).click();
  await doc.getByLabel('Cari obat baris 1').fill('amoks');
  await doc.getByRole('button', { name: /Amoksisilin 500 mg/ }).click();
  await doc.getByLabel('Aturan pakai').fill('Sesudah makan, habiskan');
  await expect(doc.getByLabel('Jumlah')).toHaveValue('9');
  await doc.getByRole('button', { name: 'Simpan resep' }).click();
  await expect(doc.getByTestId('rx-saved')).toBeVisible();
  const alert = doc.getByTestId('rx-alert');
  await expect(alert).toContainText('pasien tercatat alergi amoksisilin');

  await doc.getByRole('button', { name: 'Selesai konsultasi' }).click();
  await expect(doc.getByText('Ada peringatan resep yang belum diberi alasan')).toBeVisible();
  await alert.getByRole('textbox').fill('Alergi lama diragukan; dikonfirmasi ulang dengan pasien');
  await doc.getByRole('button', { name: 'Simpan resep' }).click();
  await expect(doc.getByTestId('rx-saved')).toBeVisible();
  await doc.getByRole('button', { name: 'Selesai konsultasi' }).click();
  await expect(doc.getByTestId('finish-notice')).toContainText(/resep RX\d+ diterbitkan\. Pasien diteruskan ke (kasir|farmasi)/);
  await doc.getByRole('tab', { name: 'Resep' }).click();
  await expect(doc.getByTestId('rx-line')).toContainText('Amoksisilin 500 mg');
  await expect(doc.getByText('Diterbitkan', { exact: true })).toBeVisible();
  await ctx.close();
  expect(cspViolations).toEqual([]);
});

test('W25 dokumen medis: dokter menerbitkan resume & surat sakit dari rekam medis yang disahkan, PDF dapat dibuka (Stage 9 batch 4)', async ({ page }) => {
  watchCsp(page);
  await login(page, 'dokter@klinik-web.test');
  await page.getByTestId('side-menu').getByRole('link', { name: 'Pasien' }).click();
  await page.getByLabel('Cari pasien').fill('Siti');
  await page.getByRole('link', { name: 'Siti Rahmawati', exact: true }).click();
  await page.getByRole('link', { name: 'Riwayat rekam medis' }).click();
  await page.getByTestId('record-entry').first().getByRole('link', { name: /^KJ/ }).click();
  await page.getByRole('tab', { name: 'Dokumen & kontrol' }).click();
  await page.getByRole('button', { name: 'Resume medis' }).click();
  await expect(page.getByTestId('doc-notice')).toContainText(/Resume medis RES\/\d{4}\/\d{2}\/0001 diterbitkan/);
  await page.getByRole('button', { name: 'Surat sakit' }).click();
  const sd = page.getByRole('dialog', { name: 'Surat keterangan sakit' });
  await sd.getByLabel('Lama istirahat (hari)').fill('2');
  await sd.getByRole('button', { name: 'Terbitkan' }).click();
  await expect(page.getByTestId('doc-notice')).toContainText(/Surat keterangan sakit SKS\/\d{4}\/\d{2}\/0001 diterbitkan/);
  await expect(page.getByTestId('doc-row')).toHaveCount(2);
  const href = await page.getByTestId('doc-row').filter({ hasText: 'Surat keterangan sakit' }).getByRole('link', { name: 'Buka PDF' }).getAttribute('href');
  // Diunduh dari dalam halaman (Node tidak me-resolve *.localhost; cookie sesi ikut seperti klik pengguna)
  const pdf = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'same-origin' });
    return { status: r.status, type: r.headers.get('content-type'), head: new TextDecoder('latin1').decode((await r.arrayBuffer()).slice(0, 5)) };
  }, href!);
  expect(pdf).toEqual({ status: 200, type: expect.stringContaining('application/pdf'), head: '%PDF-' });
  await expect(page.getByTestId('doc-row').first()).toContainText(/kode [0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}/);
  expect(cspViolations).toEqual([]);
});

test('W26 farmasi: stok minimum & harga jual obat, terima barang dalam Box (konversi ke Strip), stok & peringatan tampil (Stage 10 batch 1)', async ({ page }) => {
  watchCsp(page);
  await login(page, 'farmasi@klinik-web.test');
  const menu = page.getByTestId('side-menu');
  await menu.getByRole('link', { name: 'Obat', exact: true }).click();
  const row = page.getByTestId('drug-row').filter({ hasText: 'AMX500' });
  await row.getByRole('button', { name: 'Ubah' }).click();
  const dd = page.getByRole('dialog', { name: 'Ubah obat' });
  await dd.getByLabel('Kode KFA').fill('93000001');
  await dd.getByLabel('Stok minimum (satuan dasar)').fill('50');
  await dd.getByRole('button', { name: 'Simpan' }).click();
  await expect(dd).toBeHidden();
  await row.getByRole('button', { name: 'Harga' }).click();
  const pd = page.getByRole('dialog', { name: /Harga jual — Amoksisilin/ });
  await pd.getByLabel('Harga jual per Strip *').fill('12.500');
  await pd.getByLabel('HET (opsional)').fill('15000');
  await pd.getByRole('button', { name: 'Tambah harga' }).click();
  await expect(pd.getByTestId('price-row')).toContainText('Rp 12.500');
  await pd.getByLabel('Harga jual per Strip *').fill('13000');
  await pd.getByRole('button', { name: 'Tambah harga' }).click();
  await expect(pd.getByRole('alert')).toContainText('tumpang tindih');
  await pd.getByRole('button', { name: 'Tutup', exact: true }).click();

  await menu.getByRole('link', { name: 'Penerimaan barang' }).click();
  await page.getByRole('button', { name: 'Terima barang' }).click();
  const rd = page.getByRole('dialog', { name: 'Terima barang' });
  await rd.getByLabel('Supplier *').selectOption({ label: 'PBF Web Sintetis' });
  await expect(rd.getByLabel('Lokasi penyimpanan *')).toHaveValue(/.+/);
  await rd.getByLabel('Nomor faktur *').fill('FKT-WEB-001');
  await rd.getByLabel('Obat *').fill('amoks');
  await rd.getByRole('option', { name: /Amoksisilin 500 mg/ }).click();
  await rd.getByLabel('No. batch *').fill('AMX-W1');
  const exp = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  await rd.getByLabel('Kedaluwarsa *').fill(exp);
  await rd.getByLabel('Jumlah *').fill('2');
  await rd.getByLabel('Satuan *', { exact: true }).selectOption({ label: 'Box' });
  await rd.getByLabel('Harga beli per satuan *').fill('80.000');
  await expect(rd.getByText('Rp 160.000')).toBeVisible();
  await rd.getByRole('button', { name: 'Simpan penerimaan' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Penerimaan GR\d+ tersimpan/ })).toBeVisible();
  const rr = page.getByTestId('receipt-row').filter({ hasText: 'FKT-WEB-001' });
  await expect(rr).toContainText('Rp 160.000');
  await rr.getByRole('button', { name: 'Lihat' }).click();
  await expect(page.getByRole('dialog')).toContainText('2 Box (= 20 Strip)');
  await page.getByRole('dialog').getByRole('button', { name: 'Tutup' }).click();

  await menu.getByRole('link', { name: 'Stok obat' }).click();
  const sr = page.getByTestId('stock-row').filter({ hasText: 'AMX500' });
  await expect(sr).toContainText('20 Strip');
  await expect(sr).toContainText('Menipis');
  await expect(sr).toContainText('20 akan ED');
  await page.getByLabel('Filter stok').selectOption('LOW');
  await expect(page.getByTestId('stock-row')).toHaveCount(1);
  await sr.getByRole('button', { name: 'Rincian' }).click();
  const det = page.getByRole('dialog', { name: /Stok — Amoksisilin/ });
  await expect(det.getByTestId('batch-row')).toContainText('AMX-W1');
  await expect(det).toContainText('Penerimaan');
  await expect(det).toContainText('Apoteker E2E');
  expect(cspViolations).toEqual([]);
});

test('W27 farmasi: resep dari dokter masuk worklist, telaah checklist, serahkan obat FEFO dengan harga terkunci, etiket PDF, resep selesai (Stage 10 batch 2)', async ({ page }) => {
  watchCsp(page);
  await login(page, 'farmasi@klinik-web.test');
  await page.getByTestId('side-menu').getByRole('link', { name: 'Resep masuk' }).click();
  const row = page.getByTestId('rx-row').filter({ hasText: 'Siti Rahmawati' });
  await expect(row).toContainText('Perlu telaah');
  await expect(row).toContainText('1 peringatan dokter');
  await row.getByRole('button', { name: 'Buka' }).click();
  const dlg = page.getByTestId('rx-dialog');
  await expect(dlg.getByTestId('rx-alerts')).toContainText('Alergi lama diragukan');
  await expect(dlg.getByTestId('rx-item')).toContainText('Amoksisilin 500 mg');
  await expect(dlg.getByRole('button', { name: 'Serahkan obat' })).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Telaah resep' }).click();
  const rf = dlg.getByTestId('review-form');
  await expect(rf.getByRole('button', { name: 'Simpan telaah' })).toBeDisabled();
  await rf.getByRole('button', { name: 'Tandai semua sesuai' }).click();
  await rf.getByRole('button', { name: 'Simpan telaah' }).click();
  await expect(dlg.getByRole('status').filter({ hasText: 'siap diserahkan' })).toBeVisible();
  await expect(dlg.getByTestId('review-summary')).toContainText('Telaah sesuai oleh Apoteker E2E');

  await dlg.getByRole('button', { name: 'Serahkan obat' }).click();
  const df = dlg.getByTestId('dispense-form');
  await expect(df).toContainText('dari Apotek (FEFO)');
  await expect(df.getByTestId('dispense-line')).toContainText('batch AMX-W1');
  await expect(df.getByLabel('Jumlah diserahkan (Strip)')).toHaveValue('9');
  await df.getByLabel('Diterima oleh (opsional)').fill('Pasien sendiri');
  await expect(df).toContainText('Rp 112.500');
  await df.getByRole('button', { name: 'Simpan penyerahan' }).click();
  await expect(dlg.getByRole('status').filter({ hasText: 'Obat diserahkan. Resep selesai.' })).toBeVisible();
  const card = dlg.getByTestId('dispense-card');
  await expect(card).toContainText('AMX-W1');
  await expect(card).toContainText('Rp 112.500');
  const href = await card.getByRole('link', { name: 'Cetak etiket' }).getAttribute('href');
  const pdf = await page.evaluate(async (u) => {
    const r = await fetch(u!, { credentials: 'same-origin' });
    return { status: r.status, type: r.headers.get('content-type'), head: new TextDecoder().decode((await r.arrayBuffer()).slice(0, 5)) };
  }, href);
  expect(pdf).toEqual({ status: 200, type: 'application/pdf', head: '%PDF-' });
  await dlg.getByRole('button', { name: 'Tutup', exact: true }).click();
  await page.getByRole('tab', { name: 'Selesai hari ini' }).click();
  await expect(page.getByTestId('rx-row').filter({ hasText: 'Siti Rahmawati' })).toContainText('Selesai');
  await page.getByTestId('side-menu').getByRole('link', { name: 'Stok obat' }).click();
  await expect(page.getByTestId('stock-row').filter({ hasText: 'AMX500' })).toContainText('11 Strip');
  expect(cspViolations).toEqual([]);
});

test('W28 kontrol stok: farmasi mengajukan penyesuaian, penyetuju lain menyetujui; stock opname dihitung, dikirim, disetujui; laporan obat terbatas (Stage 10 batch 3)', async ({ page, browser }) => {
  watchCsp(page);
  await addClinicRole('PENYETUJU_STOK', 'Penyetuju stok', ['pharmacy.stock.read', 'pharmacy.stock.approve', 'master.facility.read']);
  await addClinicUser('penyetuju@klinik-web.test', 'Penyetuju E2E', 'PENYETUJU_STOK');
  await login(page, 'farmasi@klinik-web.test');
  const menu = page.getByTestId('side-menu');
  await menu.getByRole('link', { name: 'Penyesuaian stok' }).click();
  await page.getByRole('button', { name: 'Ajukan penyesuaian' }).click();
  const ad = page.getByRole('dialog', { name: 'Ajukan penyesuaian stok' });
  await ad.getByLabel('Obat *').fill('amoks');
  await ad.getByRole('option', { name: /Amoksisilin 500 mg/ }).click();
  const batchOpt = ad.getByLabel('Batch & lokasi *').locator('option', { hasText: 'AMX-W1' });
  await expect(batchOpt).toContainText('saldo 11');
  await ad.getByLabel('Batch & lokasi *').selectOption((await batchOpt.getAttribute('value'))!);
  await ad.getByLabel('Jumlah (Strip) *').fill('1');
  await ad.getByLabel('Alasan *').selectOption('Rusak / pecah');
  await ad.getByLabel('Keterangan').fill('Strip robek saat dirapikan');
  await ad.getByRole('button', { name: 'Ajukan', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'menunggu persetujuan' })).toBeVisible();
  const row = page.getByTestId('adjustment-row').filter({ hasText: 'AMX-W1' });
  await expect(row).toContainText('Menunggu orang lain');
  await expect(row).toContainText(/[-−]1 Strip/);

  const ctx = await browser.newContext();
  const ap = await ctx.newPage();
  watchCsp(ap);
  await login(ap, 'penyetuju@klinik-web.test');
  await ap.getByTestId('side-menu').getByRole('link', { name: 'Penyesuaian stok' }).click();
  await ap.getByTestId('adjustment-row').filter({ hasText: 'AMX-W1' }).getByRole('button', { name: 'Putuskan' }).click();
  await ap.getByRole('dialog', { name: 'Putuskan penyesuaian stok' }).getByRole('button', { name: 'Setujui' }).click();
  await expect(ap.getByRole('status').filter({ hasText: 'Penyesuaian disetujui' })).toBeVisible();

  await menu.getByRole('link', { name: 'Stock opname' }).click();
  await page.getByRole('button', { name: 'Mulai opname' }).click();
  const od = page.getByTestId('opname-dialog');
  const line = od.getByTestId('opname-line').filter({ hasText: 'AMX-W1' });
  await expect(line).toContainText('10');
  await od.getByLabel('Hitung Amoksisilin 500 mg AMX-W1').fill('9');
  await od.getByLabel('Catatan Amoksisilin 500 mg AMX-W1').fill('Satu strip tidak ditemukan');
  await od.getByRole('button', { name: 'Simpan hitungan' }).click();
  await expect(od.getByRole('status').filter({ hasText: 'Hasil hitung disimpan' })).toBeVisible();
  await od.getByRole('button', { name: 'Kirim untuk disetujui' }).click();
  await expect(od.getByRole('status').filter({ hasText: 'dikirim untuk disetujui' })).toBeVisible();

  await ap.getByTestId('side-menu').getByRole('link', { name: 'Stock opname' }).click();
  await ap.getByTestId('opname-row').filter({ hasText: 'Menunggu persetujuan' }).getByRole('button', { name: 'Buka' }).click();
  const aod = ap.getByTestId('opname-dialog');
  await expect(aod.getByTestId('opname-line').filter({ hasText: 'AMX-W1' })).toContainText(/[-−]1/);
  await aod.getByRole('button', { name: 'Setujui' }).click();
  await expect(aod.getByRole('status').filter({ hasText: 'Opname disetujui' })).toBeVisible();
  await ctx.close();

  await page.reload();
  await menu.getByRole('link', { name: 'Stok obat' }).click();
  await expect(page.getByTestId('stock-row').filter({ hasText: 'AMX500' })).toContainText('9 Strip');
  await menu.getByRole('link', { name: 'Laporan obat terbatas' }).click();
  await expect(page.getByText('Tidak ada obat golongan terbatas.')).toBeVisible();
  const href = await page.getByTestId('controlled-csv').getAttribute('href');
  const csv = await page.evaluate(async (u) => { const r = await fetch(u!, { credentials: 'same-origin' }); return { s: r.status, t: (await r.text()).slice(0, 40) }; }, href);
  expect(csv.s).toBe(200);
  expect(csv.t).toContain('Kode,Nama obat,Golongan');
  expect(cspViolations).toEqual([]);
});

test('W29 dokter: halaman persetujuan substitusi tersedia di menu Pelayanan (Stage 10 batch 3)', async ({ page }) => {
  watchCsp(page);
  await login(page, 'dokter@klinik-web.test');
  await page.getByTestId('side-menu').getByRole('link', { name: 'Persetujuan substitusi' }).click();
  await expect(page.getByRole('heading', { name: 'Persetujuan substitusi' })).toBeVisible();
  await expect(page.getByText('Tidak ada pengajuan.')).toBeVisible();
  expect(cspViolations).toEqual([]);
});

test('W30 farmasi: penjualan obat bebas (keras ditolak), batal mengembalikan stok, laporan stok & CSV mutasi (Stage 10 batch 4)', async ({ page }) => {
  watchCsp(page);
  const branchName = await addClinicDrugStock({ code: 'PCT500', name: 'Parasetamol 500 mg', drugClass: 'BEBAS', uomCode: 'STRIP', price: 5000, qty: 10, batchNo: 'PCT-W1' });
  await login(page, 'farmasi@klinik-web.test');
  const menu = page.getByTestId('side-menu');
  await menu.getByRole('link', { name: 'Penjualan obat bebas' }).click();
  await expect(page.getByRole('button', { name: 'Penjualan baru' })).toBeDisabled();
  await page.getByLabel('Cabang', { exact: true }).selectOption({ label: branchName });
  await page.getByRole('button', { name: 'Penjualan baru' }).click();
  const sd = page.getByRole('dialog', { name: 'Penjualan obat bebas' });
  await sd.getByLabel('Obat *').fill('amoks');
  await sd.getByRole('option', { name: /Amoksisilin 500 mg/ }).click();
  await expect(sd.getByRole('alert')).toContainText('hanya dengan resep');
  await expect(sd.getByRole('button', { name: 'Simpan penjualan' })).toBeDisabled();
  await sd.getByRole('button', { name: 'Ganti' }).click();
  await sd.getByLabel('Obat *').fill('parase');
  await sd.getByRole('option', { name: /Parasetamol 500 mg/ }).click();
  await sd.getByLabel('Jumlah (Strip)').fill('3');
  await sd.getByLabel('Nama pembeli (opsional)').fill('Pembeli E2E');
  await sd.getByRole('button', { name: 'Simpan penjualan' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Penjualan OTC\d+ tersimpan \(Rp 15\.000\)/ })).toBeVisible();
  const row = page.getByTestId('otc-row').filter({ hasText: 'Pembeli E2E' });
  await expect(row).toContainText('Menunggu bayar');
  await row.getByRole('button', { name: 'Lihat' }).click();
  const od = page.getByTestId('otc-dialog');
  await expect(od).toContainText('PCT-W1');
  await od.getByLabel('Batalkan penjualan — alasan').selectOption('Pembeli batal membeli');
  await od.getByRole('button', { name: 'Batalkan penjualan' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'dibatalkan; stok dikembalikan' })).toBeVisible();
  await expect(row).toContainText('Dibatalkan');

  await menu.getByRole('link', { name: 'Laporan stok' }).click();
  const rr = page.getByTestId('report-row').filter({ hasText: 'PCT500' });
  await expect(rr).toContainText('10');
  const amx = page.getByTestId('report-row').filter({ hasText: 'AMX500' });
  await expect(amx).toContainText('9');
  const href = await page.getByTestId('movements-csv').getAttribute('href');
  const csv = await page.evaluate(async (u) => { const r = await fetch(u!, { credentials: 'same-origin' }); return { s: r.status, t: await r.text() }; }, href);
  expect(csv.s).toBe(200);
  expect(csv.t).toContain('Waktu,Jenis,Kode,Nama obat');
  expect(csv.t).toMatch(/OTC_SALE,PCT500/);
  expect(csv.t).toMatch(/RETURN_IN,PCT500/);
  expect(cspViolations).toEqual([]);
});

test('W31 kasir: admin mengatur layanan konsultasi poli; kasir membuat tagihan kunjungan, memberi diskon beralasan, menerbitkan, PDF (Stage 11 batch 1)', async ({ page, browser }) => {
  watchCsp(page);
  await addClinicTariffs(50000);
  await signInAdmin(page);
  await page.getByTestId('side-menu').getByRole('link', { name: 'Fasilitas & cabang' }).click();
  await page.getByTestId('unit-row').filter({ hasText: 'Poli Gigi' }).getByRole('button', { name: 'Ubah' }).click();
  const ud = page.getByRole('dialog', { name: 'Ubah poli/unit' });
  await ud.getByLabel('Layanan konsultasi (tagihan)').selectOption({ label: 'Konsultasi dokter gigi (KONS-GIGI)' });
  await ud.getByRole('button', { name: 'Simpan' }).click();
  await expect(ud).toBeHidden();

  const kasir = await browser.newPage();
  watchCsp(kasir);
  await loginKasir(kasir);
  await kasir.getByTestId('side-menu').getByRole('link', { name: 'Tagihan' }).click();
  const row = kasir.getByTestId('billing-row').filter({ hasText: 'Siti Rahmawati' });
  await expect(row).toContainText('Kunjungan');
  await expect(row).toContainText('Belum dibuat');
  await row.getByRole('button', { name: 'Buat tagihan' }).click();
  await expect(kasir).toHaveURL(/\/billing\/invoices\/[0-9a-f-]{36}$/);
  await expect(kasir.getByTestId('invoice-status')).toHaveText('Draf');
  const consult = kasir.getByTestId('invoice-line').filter({ hasText: 'Konsultasi dokter gigi' });
  await expect(consult).toContainText('Rp 50.000');
  await expect(kasir.getByTestId('invoice-line').filter({ hasText: 'Amoksisilin' })).toHaveCount(1);
  await consult.getByRole('button', { name: /^Ubah/ }).click();
  const ed = kasir.getByRole('dialog', { name: /Ubah baris/ });
  await ed.getByLabel('Diskon (Rp)').fill('5000');
  await ed.getByLabel('Alasan diskon').fill('Pasien lansia');
  await ed.getByRole('button', { name: 'Simpan' }).click();
  await expect(ed).toBeHidden();
  await expect(consult).toContainText('Rp 45.000');
  await expect(consult).toContainText('Pasien lansia');
  await kasir.getByRole('button', { name: 'Terbitkan tagihan' }).click();
  await expect(kasir.getByTestId('invoice-status')).toHaveText('Terbit');
  await expect(kasir.getByRole('heading', { level: 1 })).toHaveText(/^INV\d{12}$/);
  await expect(kasir.getByRole('button', { name: 'Terbitkan tagihan' })).toHaveCount(0);
  const href = await kasir.getByRole('link', { name: 'Rincian PDF' }).getAttribute('href');
  const pdf = await kasir.evaluate(async (u) => { const r = await fetch(u!, { credentials: 'same-origin' }); return { s: r.status, t: r.headers.get('content-type') }; }, href);
  expect(pdf).toEqual({ s: 200, t: 'application/pdf' });
  await kasir.getByRole('link', { name: '← Tagihan' }).click();
  await expect(kasir.getByTestId('billing-row').filter({ hasText: 'Siti Rahmawati' })).toContainText('Terbit');
  expect(cspViolations).toEqual([]);
  await kasir.close();
});

test('W32 kasir: buka shift, bayar sebagian tunai (kembalian) lalu debit, lunas, kwitansi PDF, kunjungan keluar antrean, tutup shift (Stage 11 batch 2)', async ({ page }) => {
  watchCsp(page);
  await loginKasir(page);
  const menu = page.getByTestId('side-menu');
  await menu.getByRole('link', { name: 'Tagihan' }).click();
  const panel = page.getByTestId('shift-panel');
  await expect(panel).toContainText('Shift belum dibuka');
  await panel.getByRole('button', { name: 'Buka shift' }).click();
  const od = page.getByRole('dialog', { name: 'Buka shift kasir' });
  // Shift dibuka di cabang tagihan (kunjungan W20 terdaftar di Cabang Timur)
  await od.getByLabel('Cabang').selectOption({ label: 'Cabang Timur' });
  await od.getByLabel('Kas awal (Rp)').fill('100000');
  await od.getByRole('button', { name: 'Buka shift' }).click();
  await expect(panel).toContainText('Shift terbuka');
  await expect(page.getByTestId('expected-cash')).toHaveText('Rp 100.000');

  const row = page.getByTestId('billing-row').filter({ hasText: 'Siti Rahmawati' });
  await row.getByRole('button', { name: 'Buka' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveText('Terbit');
  const total = Number(((await page.getByTestId('outstanding').textContent()) ?? '').replace(/\D/g, ''));
  expect(total).toBeGreaterThan(20000);
  await page.getByRole('button', { name: 'Terima pembayaran' }).click();
  let pd = page.getByRole('dialog', { name: 'Terima pembayaran' });
  await pd.getByLabel('Nominal (Rp)').fill('20000');
  await pd.getByLabel('Uang diterima (Rp)').fill('50000');
  await expect(pd.getByTestId('change')).toHaveText('Kembalian: Rp 30.000');
  await pd.getByRole('button', { name: 'Simpan pembayaran' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Pembayaran KW\d{12} tercatat — kembalian Rp 30\.000/ })).toBeVisible();
  await expect(page.getByTestId('invoice-status')).toHaveText('Dibayar sebagian');
  await page.getByRole('button', { name: 'Terima pembayaran' }).click();
  pd = page.getByRole('dialog', { name: 'Terima pembayaran' });
  await pd.getByLabel('Metode').selectOption({ label: 'Kartu debit' });
  await pd.getByLabel('Nominal (Rp)').fill(String(total - 20000));
  await pd.getByLabel('Nomor referensi (EDC / transfer)').fill('EDC-123456');
  await pd.getByRole('button', { name: 'Simpan pembayaran' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveText('Lunas');
  await expect(page.getByTestId('payment-row')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Terima pembayaran' })).toHaveCount(0);
  const href = await page.getByTestId('payment-row').first().getByRole('link', { name: 'Kwitansi' }).getAttribute('href');
  const pdf = await page.evaluate(async (u) => { const r = await fetch(u!, { credentials: 'same-origin' }); return { s: r.status, t: r.headers.get('content-type') }; }, href);
  expect(pdf).toEqual({ s: 200, t: 'application/pdf' });

  await page.getByRole('link', { name: '← Tagihan' }).click();
  await expect(page.getByTestId('billing-row').filter({ hasText: 'Siti Rahmawati' })).toHaveCount(0);
  await expect(page.getByTestId('expected-cash')).toHaveText('Rp 120.000');
  await page.getByTestId('shift-panel').getByRole('button', { name: 'Tutup shift' }).click();
  const cd = page.getByRole('dialog', { name: 'Tutup shift kasir' });
  await cd.getByLabel('Kas fisik dihitung (Rp)').fill('120000');
  await expect(cd.getByTestId('variance')).toHaveText('Selisih: Rp 0');
  await cd.getByRole('button', { name: 'Tutup shift' }).click();
  await expect(page.getByTestId('shift-panel')).toContainText('Shift ditutup. Kas seharusnya Rp 120.000, dihitung Rp 120.000, selisih Rp 0.');
  await expect(page.getByTestId('shift-panel')).toContainText('Shift belum dibuka');

  await menu.getByRole('link', { name: 'Piutang penjamin' }).click();
  await expect(page.getByRole('heading', { name: 'Piutang penjamin' })).toBeVisible();
  await expect(page.getByText('Tidak ada piutang.')).toBeVisible();
  expect(cspViolations).toEqual([]);
});

test('W33 kasir: QRIS simulator, refund & void diajukan; supervisor menyetujui; rekonsiliasi QRIS tanpa selisih (Stage 11 batch 3)', async ({ page, browser }) => {
  watchCsp(page);
  const enc = { patientName: 'Siti Rahmawati', branchName: 'Cabang Timur', unitName: 'Poli Gigi', practitionerName: 'drg. Web Sintetis' };
  await addClinicBillingEncounter(enc);
  await addClinicBillingEncounter(enc);
  await addClinicRole('SPV_KASIR', 'Supervisor kasir', ['billing.invoice.read', 'billing.invoice.void.approve', 'billing.refund.approve', 'billing.reconcile',
    'billing.receivable.read', 'billing.receivable.manage', 'report.finance.audit']);
  await addClinicUser('spv-kasir@klinik-web.test', 'Supervisor Kasir E2E', 'SPV_KASIR');

  await loginKasir(page);
  await page.getByTestId('side-menu').getByRole('link', { name: 'Tagihan' }).click();
  const panel = page.getByTestId('shift-panel');
  await panel.getByRole('button', { name: 'Buka shift' }).click();
  const od = page.getByRole('dialog', { name: 'Buka shift kasir' });
  await od.getByLabel('Cabang').selectOption({ label: 'Cabang Timur' });
  await od.getByLabel('Kas awal (Rp)').fill('100000');
  await od.getByRole('button', { name: 'Buka shift' }).click();
  await expect(panel).toContainText('Shift terbuka');
  const fresh = () => page.getByTestId('billing-row').filter({ hasText: 'Siti Rahmawati' }).filter({ hasText: 'Belum dibuat' });
  await expect(fresh()).toHaveCount(2);

  // 1) Tagihan pertama: terbit → QRIS (simulator) → lunas → ajukan refund transfer
  await fresh().first().getByRole('button', { name: 'Buat tagihan' }).click();
  await page.getByRole('button', { name: 'Terbitkan tagihan' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveText('Terbit');
  await page.getByRole('button', { name: 'Bayar QRIS' }).click();
  const qd = page.getByRole('dialog', { name: 'Bayar dengan QRIS' });
  await expect(qd.getByRole('img', { name: 'Kode QR pembayaran' })).toBeVisible();
  await expect(qd.getByTestId('qris-status')).toHaveText('Menunggu pembayaran');
  await expect(qd).toContainText('Mode simulator');
  await qd.getByRole('button', { name: 'Simulasikan bayar' }).click();
  await expect(qd.getByTestId('qris-status')).toHaveText('Dibayar');
  await qd.getByRole('button', { name: 'Tutup' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveText('Lunas');
  const prow = page.getByTestId('payment-row');
  await expect(prow).toHaveCount(1);
  await expect(prow).toContainText('QRIS');
  await prow.getByRole('button', { name: 'Refund' }).click();
  const rd = page.getByRole('dialog', { name: /Ajukan refund KW/ });
  await rd.getByLabel('Nominal refund (Rp)').fill('10000');
  await rd.getByLabel('Alasan refund').fill('Kelebihan bayar (uji)');
  await rd.getByLabel('Rekening / referensi transfer').fill('BCA 0000000000 a.n. Siti');
  await rd.getByRole('button', { name: 'Ajukan refund' }).click();
  await expect(page.getByTestId('refund-row')).toContainText('Menunggu persetujuan');
  await expect(page.getByTestId('refund-row')).toContainText('Transfer · BCA 0000000000 a.n. Siti');

  // 2) Tagihan kedua: terbit → ajukan void (pembayaran ditahan)
  await page.getByRole('link', { name: '← Tagihan' }).click();
  await fresh().first().getByRole('button', { name: 'Buat tagihan' }).click();
  await page.getByRole('button', { name: 'Terbitkan tagihan' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveText('Terbit');
  const voidUrl = page.url();
  await page.getByTestId('void-card').getByRole('button', { name: 'Ajukan void' }).click();
  const vd = page.getByRole('dialog', { name: 'Ajukan void tagihan' });
  await vd.getByLabel('Alasan void').fill('Pasien batal berobat (uji)');
  await vd.getByRole('button', { name: 'Ajukan' }).click();
  await expect(page.getByTestId('void-row')).toContainText('Menunggu persetujuan');
  await expect(page.getByRole('button', { name: 'Terima pembayaran' })).toHaveCount(0);
  await expect(page.getByTestId('void-card').getByRole('button', { name: 'Putuskan void' })).toHaveCount(0);

  // 3) Tutup shift: QRIS tidak menambah kas tunai
  await page.getByRole('link', { name: '← Tagihan' }).click();
  await expect(page.getByTestId('expected-cash')).toHaveText('Rp 100.000');
  await page.getByTestId('shift-panel').getByRole('button', { name: 'Tutup shift' }).click();
  const cd = page.getByRole('dialog', { name: 'Tutup shift kasir' });
  await cd.getByLabel('Kas fisik dihitung (Rp)').fill('100000');
  await cd.getByRole('button', { name: 'Tutup shift' }).click();
  await expect(page.getByTestId('shift-panel')).toContainText('Shift belum dibuka');

  // 4) Supervisor: setujui void & refund, rekonsiliasi QRIS hari ini
  const spv = await browser.newPage();
  watchCsp(spv);
  await login(spv, 'spv-kasir@klinik-web.test');
  await spv.getByTestId('side-menu').getByRole('link', { name: 'Tagihan' }).click();
  await expect(spv.getByTestId('approval-row')).toHaveCount(2);
  await spv.getByTestId('approval-row').filter({ hasText: 'Void' }).getByRole('button', { name: 'Tinjau' }).click();
  await expect(spv).toHaveURL(voidUrl);
  await spv.getByTestId('void-card').getByRole('button', { name: 'Putuskan void' }).click();
  await spv.getByRole('dialog', { name: /Void:/ }).getByRole('button', { name: 'Setujui' }).click();
  await expect(spv.getByTestId('invoice-status')).toHaveText('Void');
  await expect(spv.getByTestId('void-banner')).toContainText('Buat tagihan pengganti dari antrean kasir');
  await spv.getByRole('link', { name: '← Tagihan' }).click();
  await spv.getByTestId('approval-row').filter({ hasText: 'Refund' }).getByRole('button', { name: 'Tinjau' }).click();
  await spv.getByTestId('refund-row').getByRole('button', { name: 'Putuskan' }).click();
  const dd = spv.getByRole('dialog', { name: /Refund RF/ });
  await dd.getByLabel('Catatan').fill('Transfer dilakukan bagian keuangan');
  await dd.getByRole('button', { name: 'Setujui' }).click();
  await expect(spv.getByTestId('refund-row')).toContainText('Disetujui');
  await expect(spv.getByTestId('invoice-status')).toHaveText('Dibayar sebagian');

  await spv.getByTestId('side-menu').getByRole('link', { name: 'Rekonsiliasi QRIS' }).click();
  await expect(spv.getByTestId('rec-summary')).toContainText('QRIS lunas di sistem: 1');
  await spv.getByRole('button', { name: 'Ambil CSV simulasi' }).click();
  await expect(spv.getByLabel('Isi CSV')).toHaveValue(/^provider_ref,amount,settled_at\nSIM-[0-9A-F]{20},/);
  await spv.getByRole('button', { name: 'Unggah & cocokkan' }).click();
  await expect(spv.getByRole('status').filter({ hasText: 'Settlement diunggah: 1 baris, 1 cocok dengan transaksi.' })).toBeVisible();
  await expect(spv.getByTestId('rec-issue-count')).toHaveText('0');
  await expect(spv.getByText('Tidak ada selisih.')).toBeVisible();
  expect(cspViolations).toEqual([]);
  await spv.close();
});

test('W34 supervisor: tutup shift yang lupa ditutup & verifikasi, pelunasan piutang penjamin, laporan transaksi tidak wajar (Stage 11 batch 4)', async ({ page, browser }) => {
  watchCsp(page);
  await addClinicBillingEncounter({ patientName: 'Siti Rahmawati', branchName: 'Cabang Timur', unitName: 'Poli Gigi', practitionerName: 'drg. Web Sintetis',
    insurer: { code: 'ASR-E2E', name: 'Asuransi E2E', copayPercent: 20 } });
  // Kasir: tagihan penjamin (porsi pasien 20%) dibayar tunai; shift dibiarkan terbuka
  await loginKasir(page);
  await page.getByTestId('side-menu').getByRole('link', { name: 'Tagihan' }).click();
  const panel = page.getByTestId('shift-panel');
  await panel.getByRole('button', { name: 'Buka shift' }).click();
  const od = page.getByRole('dialog', { name: 'Buka shift kasir' });
  await od.getByLabel('Cabang').selectOption({ label: 'Cabang Timur' });
  await od.getByLabel('Kas awal (Rp)').fill('100000');
  await od.getByRole('button', { name: 'Buka shift' }).click();
  await expect(panel).toContainText('Shift terbuka');
  await page.getByTestId('billing-row').filter({ hasText: 'Asuransi E2E' }).getByRole('button', { name: 'Buat tagihan' }).click();
  await page.getByRole('button', { name: 'Terbitkan tagihan' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveText('Terbit');
  await expect(page.getByTestId('receivable')).toContainText('Piutang ke Asuransi E2E: Rp 40.000');
  await page.getByRole('button', { name: 'Terima pembayaran' }).click();
  await page.getByRole('dialog', { name: 'Terima pembayaran' }).getByRole('button', { name: 'Simpan pembayaran' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveText('Lunas');

  const spv = await browser.newPage();
  watchCsp(spv);
  await login(spv, 'spv-kasir@klinik-web.test');
  const menu = spv.getByTestId('side-menu');
  // Shift kasir terbuka → ditutup supervisor (tercatat) → diverifikasi
  await menu.getByRole('link', { name: 'Shift kasir' }).click();
  await spv.getByLabel('Status shift').selectOption({ label: 'Terbuka' });
  const openRow = spv.getByTestId('shift-row').filter({ hasText: 'Cabang Timur' });
  await expect(openRow).toHaveCount(1);
  await expect(openRow).toContainText('Rp 110.000');
  await openRow.getByRole('button', { name: 'Tutup shift' }).click();
  const fd = spv.getByRole('dialog', { name: /Tutup shift/ });
  await fd.getByLabel('Kas fisik dihitung (Rp)').fill('105000');
  await fd.getByLabel('Keterangan').fill('Kasir pulang tanpa tutup shift (uji)');
  await fd.getByRole('button', { name: 'Tutup shift' }).click();
  await expect(spv.getByRole('status').filter({ hasText: /ditutup\.$/ })).toBeVisible();
  await spv.getByLabel('Status shift').selectOption({ label: 'Ditutup' });
  const closedRow = spv.getByTestId('shift-row').filter({ hasText: 'ditutup Supervisor Kasir E2E' });
  await expect(closedRow).toContainText('Rp -5.000');
  await closedRow.getByRole('button', { name: 'Verifikasi' }).click();
  await spv.getByRole('dialog', { name: /Verifikasi shift/ }).getByRole('button', { name: 'Verifikasi' }).click();
  await expect(spv.getByRole('status').filter({ hasText: /diverifikasi\.$/ })).toBeVisible();
  await spv.getByLabel('Status shift').selectOption({ label: 'Terverifikasi' });
  await expect(spv.getByTestId('shift-row').filter({ hasText: 'ditutup Supervisor Kasir E2E' })).toContainText('Terverifikasi');

  // Pelunasan piutang penjamin
  await menu.getByRole('link', { name: 'Piutang penjamin' }).click();
  const rrow = spv.getByTestId('receivable-row').filter({ hasText: 'Asuransi E2E' });
  await expect(rrow).toContainText('Rp 40.000');
  await rrow.getByRole('button', { name: 'Pelunasan' }).click();
  const rd = spv.getByRole('dialog', { name: /Piutang Asuransi E2E/ });
  await expect(rd.getByTestId('receivable-balance')).toHaveText('Rp 40.000');
  await rd.getByLabel('Referensi (no. transfer / giro)').fill('TRF-E2E-001');
  await rd.getByRole('button', { name: 'Catat pelunasan' }).click();
  await expect(spv.getByRole('status').filter({ hasText: 'Pelunasan tercatat. Saldo Asuransi E2E: Rp 0.' })).toBeVisible();
  await expect(spv.getByTestId('receivable-row').filter({ hasText: 'Asuransi E2E' })).toHaveCount(0);

  // Laporan transaksi tidak wajar (ambang bawaan)
  await menu.getByRole('link', { name: 'Transaksi tidak wajar' }).click();
  await expect(spv.getByRole('heading', { name: 'Transaksi tidak wajar' })).toBeVisible();
  await expect(spv.getByText(/Ambang: jam kasir 07:00–21:00, maks\. 3 void per shift, toleransi kas Rp 10\.000/)).toBeVisible();
  await expect(spv.getByTestId('anomaly-counts')).toContainText('Selisih kas (0)');
  const csv = await spv.getByRole('link', { name: 'Unduh CSV' }).getAttribute('href');
  const res = await spv.evaluate(async (u) => { const r = await fetch(u!, { credentials: 'same-origin' }); return { s: r.status, t: r.headers.get('content-type') }; }, csv);
  expect(res).toEqual({ s: 200, t: 'text/csv; charset=utf-8' });
  expect(cspViolations).toEqual([]);
  await spv.close();
});

test('W35 SATUSEHAT (simulator): admin menyimpan kredensial, uji koneksi, sinkron master; pendaftaran mencari IHS pasien (Stage 12 batch 1)', async ({ page, browser }) => {
  watchCsp(page);
  await signInAdmin(page);
  await page.getByTestId('side-menu').getByRole('link', { name: 'SATUSEHAT', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Integrasi SATUSEHAT' })).toBeVisible();
  const card = page.getByTestId('satusehat-facility').first();
  await expect(card).toContainText('Belum terhubung.');
  await card.getByLabel('Lingkungan').selectOption({ label: 'Simulator (uji lokal, bukan SATUSEHAT)' });
  await card.getByLabel('Organization ID').fill('10000004');
  await card.getByLabel('Client ID').fill('e2e-client-001');
  await card.getByLabel('Client secret').fill('rahasia-simulator-e2e');   // pragma: allowlist secret — nilai sintetis
  await card.getByRole('button', { name: 'Simpan kredensial' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Kredensial disimpan.' })).toBeVisible();
  await expect(card).toContainText('Organization 10000004 · client e2e••••001');
  await expect(card.getByLabel('Client secret')).toHaveValue('');
  await card.getByRole('button', { name: 'Uji koneksi' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Terhubung ke SATUSEHAT simulator — Organisasi Simulasi 10000004' })).toBeVisible();
  await expect(card.getByTestId('connection-test')).toContainText('Terhubung');
  await card.getByRole('button', { name: 'Sinkron master' }).click();
  await expect(card.getByTestId('sync-result')).toContainText(/Location: \d+ dibuat, 0 sudah ada, 0 gagal/);
  await expect(card.getByTestId('location-row').filter({ hasText: 'Poli Gigi' })).toContainText('Terdaftar');
  await card.getByRole('button', { name: 'Sinkron master' }).click();
  await expect(card.getByTestId('sync-result')).toContainText(/Location: 0 dibuat, \d+ sudah ada, 0 gagal/);

  const reg = await browser.newPage();
  watchCsp(reg);
  await login(reg, 'pendaftaran@klinik-web.test');
  await reg.getByTestId('side-menu').getByRole('link', { name: 'Pasien' }).click();
  await reg.getByLabel('Cari pasien').fill('siti rahmawati');
  await reg.getByTestId('patient-row').filter({ hasText: '00000001' }).getByRole('link', { name: 'Siti Rahmawati', exact: true }).click();
  const ihs = reg.getByTestId('ihs-status');
  await ihs.getByRole('button', { name: 'Cari di SATUSEHAT' }).click();
  await expect(reg.getByRole('status').filter({ hasText: /^IHS ditemukan: P\d{10}$/ })).toBeVisible();
  await expect(ihs).toContainText('Terhubung');
  await expect(ihs.getByRole('button', { name: 'Cari di SATUSEHAT' })).toHaveCount(0);
  expect(cspViolations).toEqual([]);
  await reg.close();
});

/**
 * Worker sungguhan, sekali jalan: job pengiriman SATUSEHAT (Stage 12). Rekonsiliasi jarak jauh tidak dijalankan di sini karena isi simulator
 * hanya hidup di satu proses worker (tiap pemanggilan = proses baru); rekonsiliasi diuji di integrasi O02–O03.
 */
const sendOnce = () => execFileSync(process.execPath, [join(ROOT, 'apps/worker/dist/main.js')], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, APP_ENV: 'test',
  LOG_LEVEL: 'warn', WORKER_DATABASE_URL: dbUrl(), ENCRYPTION_KEY_HEX: E2E_ENCRYPTION_KEY, STORAGE_DRIVER: 'fs', STORAGE_FS_DIR: STORAGE_DIR,
  WORKER_RUN_ONCE: 'integration.satusehat_send', SMTP_URL: '' } });

test('W36 SATUSEHAT (simulator): RM disahkan → dalam antrean; tertahan dengan masalah yang dapat ditindaklanjuti; setelah dilengkapi → terkirim (Stage 12 batch 2)', async ({ page, browser }) => {
  watchCsp(page);
  const ctx = await browser.newContext();
  const doc = await ctx.newPage();
  watchCsp(doc);
  await login(doc, 'dokter@klinik-web.test');
  await doc.getByTestId('side-menu').getByRole('link', { name: 'Pasien' }).click();
  await doc.getByLabel('Cari pasien').fill('siti rahmawati');
  await doc.getByTestId('patient-row').filter({ hasText: '00000001' }).getByRole('link', { name: 'Siti Rahmawati', exact: true }).click();
  await doc.getByRole('link', { name: 'Riwayat rekam medis' }).click();
  await doc.getByTestId('record-entry').filter({ hasText: 'K02.9' }).first().locator('a[href^="/encounters/"]').click();
  const panel = doc.getByTestId('satusehat-status');
  await expect(panel).toContainText('Dalam antrean kirim');
  await expect(panel).toContainText('(simulator)');

  // IHS dokter dikosongkan admin (mis. salah isi) → kunjungan tertahan dengan pesan yang dapat ditindaklanjuti
  await signInAdmin(page);
  await page.getByTestId('side-menu').getByRole('link', { name: 'Tenaga kesehatan' }).click();
  await page.getByTestId('practitioner-row').filter({ hasText: 'drg. Web Sintetis' }).getByRole('button', { name: 'Ubah' }).click();
  const dlg = page.getByRole('dialog', { name: 'Ubah tenaga kesehatan' });
  await expect(dlg.getByLabel('ID SATUSEHAT (IHS)')).toHaveValue(/^1\d{10}$/);   // terisi dari Sinkron master (W35)
  await dlg.getByLabel('ID SATUSEHAT (IHS)').fill('');
  await dlg.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByText('drg. Web Sintetis disimpan.')).toBeVisible();
  sendOnce();
  await doc.reload();
  await expect(panel).toContainText('Tertahan — data belum lengkap');
  await expect(doc.getByTestId('satusehat-blocking')).toContainText('Dokter drg. Web Sintetis belum punya IHS SATUSEHAT — lengkapi NIK lalu jalankan Sinkron master');

  // Ditindaklanjuti: sinkron master mengisi kembali IHS dari NIK → terkirim pada putaran berikutnya
  await page.getByTestId('side-menu').getByRole('link', { name: 'SATUSEHAT', exact: true }).click();
  const card = page.getByTestId('satusehat-facility').first();
  await card.getByRole('button', { name: 'Sinkron master' }).click();
  await expect(card.getByTestId('sync-result')).toContainText(/Tenaga kesehatan: 1 ditemukan/);

  sendOnce();
  await doc.reload();
  await expect(panel).toContainText('Terkirim');
  await expect(panel).toContainText(/\d+ data/);
  await expect(doc.getByTestId('satusehat-blocking')).toHaveCount(0);
  expect(cspViolations).toEqual([]);
  await ctx.close();
});

test('W37 SATUSEHAT (simulator): addendum mengganti diagnosis → terkirim sebagai update; kiriman gagal tampil di "Perlu tindakan" dan dapat dikirim ulang (Stage 12 batch 3)', async ({ page, browser }) => {
  watchCsp(page);
  const ctx = await browser.newContext();
  const doc = await ctx.newPage();
  watchCsp(doc);
  await login(doc, 'dokter@klinik-web.test');
  await doc.getByTestId('side-menu').getByRole('link', { name: 'Pasien' }).click();
  await doc.getByLabel('Cari pasien').fill('siti rahmawati');
  await doc.getByTestId('patient-row').filter({ hasText: '00000001' }).getByRole('link', { name: 'Siti Rahmawati', exact: true }).click();
  await doc.getByRole('link', { name: 'Riwayat rekam medis' }).click();
  await doc.getByTestId('record-entry').filter({ hasText: 'K02.9' }).first().locator('a[href^="/encounters/"]').click();
  await expect(doc.getByTestId('satusehat-status')).toContainText('Terkirim');

  await doc.getByRole('button', { name: 'Tambah addendum' }).click();
  const ad = doc.getByRole('dialog', { name: 'Tambah addendum' });
  await ad.getByLabel('Alasan *').fill('Koreksi diagnosis setelah pemeriksaan ulang');
  await ad.getByLabel('Isi addendum *').fill('Nyeri spontan; diagnosis kerja pulpitis.');
  await ad.getByLabel('Ubah diagnosis').check();
  await expect(ad.getByTestId('addendum-dx-row')).toContainText('K02.9');
  await ad.getByLabel('Tambah diagnosis').fill('pulpitis');
  await ad.getByRole('button', { name: /K04\.0/ }).click();
  await ad.getByLabel('Jenis K04.0').selectOption('PRIMER');
  await expect(ad.getByLabel('Jenis K02.9')).toHaveValue('SEKUNDER');
  await ad.getByLabel('Kata sandi Anda').fill(USER_PASSWORD);
  await ad.getByRole('button', { name: 'Simpan addendum' }).click();
  await expect(doc.getByTestId('addendum-diagnoses').last()).toHaveText('Diagnosis diperbarui: K02.9 Karies gigi, tidak spesifik; K04.0 Pulpitis (primer)');

  sendOnce();
  await doc.reload();
  await expect(doc.getByTestId('satusehat-status')).toContainText('Terkirim');
  await expect(doc.getByTestId('satusehat-followups')).toHaveCount(0);

  // Gangguan berkepanjangan (disimulasikan) → admin melihat "Perlu tindakan" lalu mengirim ulang
  await markLatestSatuSehatAddendumDead();
  await signInAdmin(page);
  await page.getByTestId('side-menu').getByRole('link', { name: 'SATUSEHAT', exact: true }).click();
  const issues = page.getByTestId('satusehat-facility').first().getByTestId('satusehat-issues');
  const row = issues.getByTestId('issue-row').filter({ hasText: 'Koreksi diagnosis' });
  await expect(row).toContainText('Gagal setelah beberapa percobaan');
  await expect(row).toContainText('SATUSEHAT sementara gagal (HTTP 503)');
  await expect(issues).not.toContainText('Siti Rahmawati');
  await row.getByRole('button', { name: 'Kirim ulang' }).click();
  await expect(issues.getByRole('status')).toHaveText('Dijadwalkan dikirim ulang pada putaran berikutnya (± 5 menit).');
  await expect(row).toHaveCount(0);
  sendOnce();
  await doc.reload();
  await expect(doc.getByTestId('satusehat-status')).toContainText('Terkirim');
  await expect(doc.getByTestId('satusehat-followups')).toHaveCount(0);
  expect(cspViolations).toEqual([]);
  await ctx.close();
});

test('W38 Pemantauan SATUSEHAT (simulator): dashboard per hari & rekonsiliasi tanpa nama pasien (Stage 12 batch 4)', async ({ page }) => {
  watchCsp(page);
  await signInAdmin(page);
  await page.getByTestId('side-menu').getByRole('link', { name: 'Pemantauan SATUSEHAT' }).click();
  await expect(page.getByRole('heading', { name: 'Pemantauan SATUSEHAT' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Dashboard pengiriman/ })).toContainText('(simulator)');
  await expect(page.getByTestId('tile-sent').locator('dd')).toHaveText(/^[1-9]\d*$/);
  await expect(page.getByTestId('tile-duplicates').locator('dd')).toHaveText('0');
  await expect(page.getByTestId('sync-day')).toHaveCount(14);
  await expect(page.getByTestId('sync-day').first().locator('td').nth(1)).toHaveText(/^[1-9]\d*$/);   // hari ini ada yang terkirim
  await page.getByLabel('Rentang').selectOption('7');
  await expect(page.getByTestId('sync-day')).toHaveCount(7);
  const sum = page.getByTestId('recon-summary');
  await expect(sum).toContainText(/Disahkan \d+ · Terkirim [1-9]\d* ·/);
  await expect(sum).toContainText(/Selisih \d+/);
  await expect(page.getByText(/kunjungan terkirim menunggu pencocokan otomatis dengan SATUSEHAT/)).toBeVisible();
  // Rentang tanpa kunjungan → selisih 0
  await page.getByLabel('Dari').fill('2026-01-01');
  await page.getByLabel('Sampai').fill('2026-01-31');
  await page.getByRole('button', { name: 'Tampilkan' }).click();
  await expect(sum).toContainText('Disahkan 0 · Terkirim 0');
  await expect(page.getByTestId('recon-difference')).toHaveText('Selisih 0');
  await expect(page.getByText('Semua kunjungan yang disahkan pada rentang ini sudah terkirim dan cocok.')).toBeVisible();
  await expect(page.locator('main')).not.toContainText('Siti Rahmawati');
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
