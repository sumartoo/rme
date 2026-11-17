# Stage 14 — Stage Completion Report

| | |
|---|---|
| Stage | 14 — Reporting, Analytics & Dashboard (MVP) |
| Status | **SELESAI — MENUNGGU PERSETUJUAN PO**. Tindak lanjut: uji mutasi lengkap M1–M214 di Actions setelah 1 Des; UAT laporan oleh manajer klinik di Stage 16 |
| Disusun oleh | Sumarto (dibantu Claude) |
| Rincian | [STAGE_PLAN.md](STAGE_PLAN.md) · DEC-047 (OD-123–131), DEC-048 (OD-132) · [REPORT_CATALOG.md](../../02-architecture/REPORT_CATALOG.md) · [PERFORMANCE_TEST.md](PERFORMANCE_TEST.md) |
| Repo kerja | `AtoAIs/atoai-rme-v2`, PR #49, #50, #51, #52, #53. Diverifikasi penuh di lokal lalu digabung tanpa CI (DEC-036) |

> **Batas klaim.** Laporan keuangan adalah laporan **operasional**, bukan laporan akuntansi atau pajak. Format laporan obat golongan terbatas
> **belum diverifikasi** terhadap format pelaporan resmi (REG-10).

## 1. Ringkasan

Klinik kini punya laporan standar dengan angka yang divalidasi:

1. **Kunjungan & diagnosis** (batch 1).
   - Kunjungan harian/bulanan per cabang, poli, dokter, atau penjamin: pasien unik, baru/lama, per status, dan no-show.
   - 10 besar diagnosis dari RM disahkan, memakai diagnosis yang berlaku setelah addendum.
2. **Keuangan** (batch 2).
   - Pendapatan dari dua sudut pandang berlabel jelas: tagihan terbit dan penerimaan kas.
   - Closing kasir per shift, dan umur piutang penjamin dari jatuh tempo.
3. **Farmasi & ekspor** (batch 3).
   - Stok, mutasi, obat golongan terbatas, dan laporan baru obat mendekati kedaluwarsa kini ada di menu Laporan.
   - Ekspor seragam Excel/CSV/PDF dengan watermark. Ekspor besar diproses worker, tautan unduh 24 jam, setiap ekspor diaudit tanpa isi laporan.
   - Unduhan CSV kini wajib izin `report.export` (DEC-048).
4. **Dashboard & gate** (batch 4).
   - Dashboard manajer hari ini: kunjungan per status, antrean per poli, kas, tagihan belum lunas, stok kritis, SATUSEHAT perlu tindakan, grafik 14 hari. Dimuat ulang tiap 60 detik.
   - Validasi angka terhadap hitungan independen, uji keamanan menyeluruh, dan uji performa volume target.

| Metrik | Nilai |
|---|---|
| Uji integrasi API | 308/308 (baru di Stage 14: T01–T05, A01–A05, Y01–Y08, Z01–Z06) |
| Uji keamanan & migrasi SQL | lulus (`test:db`); paritas skema lulus |
| E2E browser | 52/52 (baru: W39–W42) |
| Uji mutasi baru | M176–M214 (39), semua terdeteksi di lokal (subset suite laporan & farmasi); M83, M88, M89 (Stage 10) dipindah ke kode baru dan tetap terdeteksi |
| Uji performa | 15 skenario ≤ 3 detik pada 328.502 kunjungan (terlama 2,8 detik) |
| Migrasi | 0035–0039 |
| Kontrak API | 266 operasi |
| Modul baru | `libs/reporting` (API); `@clinicrme/db/reports` (hitung, render ekspor, job ekspor, dashboard) |
| Job worker baru | `report.export.run` (tiap menit), `report.export.expire` (tiap jam) |
| Dependency baru | `recharts` 3.11.0 + `react-is` (MIT, gratis; DEC-016/OD-046). `exceljs` & `pdfmake` dipakai ulang |

## 2. Requirement MVP

| ID | Status | Bukti |
|---|---|---|
| RPT-FR-001 kunjungan | ✅ OD-124 | T01–T03, Z01, W39 |
| RPT-FR-002 10 besar diagnosis | ✅ OD-125, diagnosis berlaku setelah addendum | T04, W39 |
| RPT-FR-003 pendapatan | ✅ tagihan terbit & kas (OD-126) | A01–A02, Z02, W40 |
| RPT-FR-004 closing kasir | ✅ rekap shift (OD-127) | A03, W40 |
| RPT-FR-005 stok, mutasi, kedaluwarsa | ✅ di menu Laporan, cakupan cabang | G02, Y01–Y02, W30, W41 |
| RPT-FR-006 obat golongan terbatas | ✅ per bulan dari ledger; **format resmi belum diverifikasi (REG-10)** | S06, W28 |
| RPT-FR-007 umur piutang | ✅ dari jatuh tempo, per tanggal posisi | A04, Z03 |
| RPT-FR-008 ekspor | ✅ XLSX/CSV/PDF berwatermark, > 10.000 baris asinkron, tautan 24 jam, audit (OD-128, OD-132) | Y03–Y08, W41 |
| RPT-FR-009 dashboard | ✅ OD-131, grafik Recharts | Z04, W42 |
| RPT-FR-010–012 builder, jadwal, waktu tunggu | LJT (OD-123) | — |

**Penyimpangan dan hal yang perlu Bapak ketahui:**
- **Dashboard tidak diaudit per tampilan.** Halaman dimuat ulang tiap 60 detik dan hanya berisi angka agregat. Semua laporan lain dan semua ekspor tetap diaudit.
- **Batas yang saya tetapkan:** PDF maksimal 10.000 baris, satu ekspor maksimal 100.000 baris, tampilan mutasi stok maksimal 5.000 baris.
- **Laporan 366 hari** (kunjungan per dokter, diagnosis semua) memakan 2,7–2,8 detik di mesin uji 2 vCPU: masih dalam target, tetapi margin tipis. Langkah bila lambat di produksi ada di PERFORMANCE_TEST §4.
- **Bug yang ditemukan uji performa** dan sudah diperbaiki:
  - penanda pasien baru di laporan kunjungan lambat secara kuadratik;
  - filter waktu kunjungan tidak memakai indeks di bawah RLS;
  - CTE dashboard dieksekusi berulang.
- **Bug lain yang ditemukan:** daftar shift kasir bisa menampilkan hasil filter lama (W34 flaky). Sudah diperbaiki di batch 3.
- **Uji mutasi Stage 14 dijalankan pada subset suite** (laporan & farmasi) agar cepat. Suite penuh berjalan di Actions setelah 1 Des.

## 3. Checklist Gate

- [x] Hasil setiap laporan divalidasi terhadap hitungan sumber pada dataset uji, angka identik:
  - Z01–Z03: dataset acak berbenih, dua zona waktu, dibandingkan dengan hitungan independen;
  - T01–T05, A01–A05, G02, S06, Y01–Y02, Z04: angka hitung manual.
- [x] Uji keamanan:
  - laporan tanpa izin ditolak (Z05: setiap role template × setiap laporan, dicocokkan dengan matriks izin di DB);
  - cakupan cabang & RLS tenant berlaku (T05, Y01–Y02, Z01, Z04, Z06);
  - parameter injeksi ditolak (Z06).
- [x] Ekspor XLSX/CSV/PDF berwatermark dan teraudit; ekspor besar asinkron dengan tautan kedaluwarsa (Y03–Y07, W41)
- [x] Uji performa dengan volume target (OD-130): semua ≤ 3 detik
- [x] Matriks permission X01 mencakup semua endpoint baru; uji mutasi kontrol baru terdeteksi (M176–M214)
- [ ] Uji mutasi lengkap M1–M214 di GitHub Actions — setelah kuota aktif 1 Des
- [ ] UAT oleh manajer klinik — dijadwalkan di Stage 16 (pengingat UAT)
- [ ] PO menyetujui Stage 14

## 4. Keamanan & privasi

- **Agregat tanpa identitas pasien**: Z04 dan Z06 memeriksa tidak ada nama atau No. RM pasien di respons laporan maupun dashboard.
- **Izin akses**:

  | Izin | Mencakup |
  |---|---|
  | `report.operational.read` | kunjungan |
  | `report.clinical.read` | diagnosis |
  | `report.finance.read` | pendapatan, closing kasir, piutang |
  | `report.pharmacy.read` | stok, mutasi, kedaluwarsa |
  | `report.pharmacy.controlled` | obat golongan terbatas |
  | `report.dashboard.read` | dashboard |
  | `report.export` | semua ekspor & CSV (DEC-048) |

  Role template yang punya `report.export`: Manajer, Admin Klinik, Apoteker/TTK.
- **Cakupan cabang** mengikuti penugasan role, termasuk untuk ekspor yang diproses worker (cakupan disimpan saat diminta).
- **Ekspor**:
  - berkas di bucket `exports` dan hanya dapat diunduh pemohon, maksimal 24 jam, lalu dihapus;
  - worker membaca data sebagai `clinicrme_app` dengan konteks tenant, jadi RLS tetap berlaku;
  - audit mencatat laporan, filter, jumlah baris, dan format, tanpa isi laporan.
- **SQL**: semua filter adalah parameter terikat; nilai enum divalidasi Zod.

## 5. Yang perlu diputuskan atau ditindaklanjuti

- **Persetujuan Stage 14** oleh PO.
- **REG-10 / S10-1**: apoteker penanggung jawab klinik pilot mengonfirmasi format laporan obat golongan terbatas.
- **UAT laporan oleh manajer klinik** di Stage 16, termasuk mencocokkan angka dengan catatan klinik.
- **Uji performa ulang** di infrastruktur target (Stage 15) memakai skrip yang sama.
- Pengingat UAT yang sudah ada:
  - S9-1 (review medis) dan S10-1 (review apoteker);
  - penyedia QRIS;
  - OD-058 (sandbox SATUSEHAT) dan S7-1 (data ICD-10 resmi);
  - uji mutasi lengkap setelah 1 Des.
