# Stage 14 — Stage Plan

| | |
|---|---|
| Stage | 14 — Reporting, Analytics & Dashboard |
| Status | **SELESAI — menunggu persetujuan PO** ([completion report](STAGE_COMPLETION_REPORT.md)). OD diputuskan DEC-047, DEC-048 |
| Project Owner | Sumarto |
| Urutan | Dikerjakan setelah Stage 12. **Stage 13 (aplikasi Android pasien) ditunda sampai setelah pilot** (DEC-046, sesuai DEC-012) |
| Requirement | **MVP saja** (DEC-010): RPT-FR-001–009. LJT: RPT-FR-010 report builder tanpa SQL, RPT-FR-011 laporan terjadwal & distribusi, RPT-FR-012 waktu tunggu pasien |
| Mode verifikasi | Lokal penuh, digabung tanpa CI sampai Actions aktif 1 Des 2026 (DEC-036) |

## 1. Tujuan

Manajer, kasir, dan apoteker klinik pilot mendapat laporan standar yang angkanya dapat dipercaya:
- kunjungan dan 10 besar diagnosis;
- pendapatan, closing kasir, dan umur piutang;
- stok, mutasi, kedaluwarsa, dan obat golongan khusus;
- dashboard harian untuk manajer.

Semua laporan dapat diekspor ke Excel, CSV, atau PDF dengan watermark, dan setiap ekspor tercatat di audit.
Setiap angka divalidasi terhadap query sumber pada dataset uji, karena laporan yang salah lebih berbahaya daripada tidak ada laporan.

## 2. Yang Sudah Ada

| Bagian | Asal | Status untuk Stage 14 |
|---|---|---|
| Laporan stok & mutasi ledger (JSON/CSV), posisi stok dengan stok minimum & kedaluwarsa ≤ 90 hari | Stage 10 | RPT-FR-005 sebagian besar ada; dirapikan ke menu Laporan + ekspor seragam |
| Laporan bulanan obat golongan terbatas (narkotika/psikotropika/prekursor, CSV) | Stage 10 (OD-100) | RPT-FR-006 ada; format resmi REG-10 masih **belum diverifikasi** |
| Daftar piutang penjamin, shift kasir (closing per shift), laporan transaksi tidak wajar | Stage 11 | Dasar RPT-FR-004 & 007; perlu rekap per hari/kasir & umur piutang |
| Dashboard & rekonsiliasi SATUSEHAT | Stage 12 | Indikator untuk dashboard manajer |
| Izin `report.operational.read`, `report.clinical.read`, `report.finance.read`, `report.pharmacy.read`, `report.pharmacy.controlled`, `report.export`, `report.dashboard.read` | Stage 3/6 | Sudah dipetakan ke operasi `reportVisits`, `reportTopDiagnoses`, `reportRevenue`, `reportCashierClosing`, `reportReceivables`, `reportExport`, `dashboardToday` di OpenAPI |
| Pustaka `exceljs` (impor master) & `pdfmake` (dokumen) | Stage 7/9 | Dipakai ulang untuk ekspor; **tidak ada dependency berbayar** |
| Recharts untuk grafik | DEC-016 (OD-046) | Belum terpasang di web; dipasang saat dashboard (gratis, MIT) |
| Laporan di DB utama, read replica bila perlu | DEC-016 (OD-047) | Diikuti; batas waktu query 30 detik |

## 3. Batch

| Batch | Isi | Requirement |
|---|---|---|
| **1 — Fondasi & kunjungan/diagnosis** | Modul `libs/reporting`: filter seragam (rentang tanggal, cabang, poli, dokter, penjamin) dalam zona waktu cabang, cakupan cabang dari penugasan role, batas rentang & baris, `statement_timeout`. Menu **Laporan**. Laporan kunjungan harian/bulanan per cabang/poli/dokter/penjamin. 10 besar diagnosis | RPT-FR-001, 002 |
| **2 — Keuangan** | Pendapatan per layanan/penjamin (tagihan terbit) & per metode (kas). Closing kasir per hari/kasir/cabang dari shift. Umur piutang per penjamin | RPT-FR-003, 004, 007 |
| **3 — Farmasi & ekspor** | Stok, mutasi, mendekati kedaluwarsa & golongan khusus disatukan di menu Laporan. **Ekspor seragam** Excel/CSV/PDF dengan watermark & audit; ekspor besar asinkron lewat worker + tautan unduh sementara | RPT-FR-005, 006, 008 |
| **4 — Dashboard manajer & gate** | Dashboard harian (kunjungan, antrean, kas, tagihan belum lunas, stok kritis, SATUSEHAT perlu tindakan) dengan grafik. Uji validasi angka terhadap query manual, uji keamanan (izin, RLS, cakupan cabang), uji performa dengan volume target. `REPORT_CATALOG.md`. Completion report | RPT-FR-009, gate |

Perkiraan: ±1 hari kerja per batch.

## 4. Open Decision — ✅ semua disetujui sesuai usulan (DEC-047)

| OD | Pertanyaan | Usulan |
|---|---|---|
| **OD-123** | Cakupan Stage 14 | **Laporan standar MVP saja** (RPT-FR-001–009). Report builder tanpa SQL, laporan terjadwal/distribusi email, dan laporan waktu tunggu = LJT sesuai SRS. Rancangan katalog data di STAGE_14 §3.1 disimpan untuk LJT |
| **OD-124** | Definisi "kunjungan" di laporan | Kunjungan = `encounter` yang **tidak batal**, dihitung pada **tanggal kedatangan** menurut zona waktu cabang. Ditampilkan juga per status (menunggu, dilayani, selesai). Janji temu yang tidak datang (no-show) dilaporkan terpisah. Pasien unik dihitung per periode. Kategori pasien baru/lama mengikuti kunjungan pertama di klinik |
| **OD-125** | 10 besar diagnosis | Dari kunjungan dengan **RM disahkan**, memakai **diagnosis yang berlaku** (setelah addendum, OD-120). Bawaan: **diagnosis primer**; pilihan "semua diagnosis". Per kode ICD-10 dengan jumlah kasus baru/lama. Laporan agregat, tanpa identitas pasien |
| **OD-126** | Dasar angka pendapatan | Dua sudut pandang yang diberi label jelas: **(a) Tagihan terbit** per layanan & penjamin (porsi pasien + porsi penjamin), tanggal terbit, tagihan void dikecualikan. **(b) Penerimaan kas** per metode bayar, tanggal terima, dikurangi refund yang disetujui. Keduanya bukan laporan akuntansi resmi (bukan pengganti pembukuan) |
| **OD-127** | Closing kasir & umur piutang | Closing kasir = **rekap shift** per hari, kasir, dan cabang (kas awal, tunai masuk, refund tunai, kas seharusnya, kas dihitung, selisih, status verifikasi), memakai data shift Stage 11 apa adanya. Umur piutang dihitung dari **jatuh tempo**: belum jatuh tempo, 1–30, 31–60, 61–90, > 90 hari, per penjamin |
| **OD-128** | Ekspor & watermark | Format **XLSX** (`exceljs`), **CSV** (UTF-8 BOM), dan **PDF** A4 lanskap (`pdfmake`). Watermark di setiap ekspor: nama klinik, nama pengekspor, waktu ekspor, dan teks "Rahasia — untuk internal klinik". Hingga **10.000 baris** langsung diunduh; di atas itu diproses asinkron oleh worker dan tautan unduh berlaku **24 jam**. Setiap ekspor teraudit (laporan, filter, jumlah baris, format), tanpa isi laporan di audit |
| **OD-129** | Cakupan cabang & data pasien | Laporan mengikuti **cakupan cabang dari penugasan role** user (IAM-FR-009), sama seperti laporan stok. Laporan berupa **agregat tanpa identitas pasien**, kecuali laporan golongan khusus yang memang memerlukan nama pasien (REG-10, izin `report.pharmacy.controlled`). Data RLS tenant tetap berlaku |
| **OD-130** | Batas & performa | Rentang interaktif ≤ **366 hari**, tampilan ≤ 10.000 baris, `statement_timeout` **30 detik**. Uji performa dengan volume target per tenant: **3 tahun × 300 kunjungan/hari** (≈ 330 ribu kunjungan beserta diagnosis, tagihan, dan pembayaran). Target respons laporan ≤ 3 detik pada volume itu di mesin uji lokal. Bila tidak tercapai: indeks/agregasi harian dulu; read replica (OD-047) baru di Stage 15 bila perlu |
| **OD-131** | Isi dashboard manajer | Hari ini (zona waktu cabang): kunjungan per status, antrean menunggu per poli, penerimaan kas & tagihan belum lunas, obat di bawah stok minimum & kedaluwarsa ≤ 30 hari, kiriman SATUSEHAT yang perlu tindakan. Grafik kunjungan & kas 14 hari terakhir. Dimuat ulang manual atau tiap 60 detik saat halaman terbuka. Tanpa identitas pasien |

## 5. Gate (dari STAGE_14_REPORTING.md, disesuaikan ke MVP)

- [x] Hasil setiap laporan divalidasi terhadap query sumber manual pada dataset uji (angka identik)
- [x] Uji keamanan: laporan tanpa izin ditolak; cakupan cabang & RLS tenant berlaku; filter tidak dapat menyuntik SQL
- [x] Ekspor XLSX/CSV/PDF berwatermark, teraudit; ekspor besar asinkron dengan tautan kedaluwarsa
- [x] Uji performa dengan volume target (OD-130)
- [x] Matriks permission X01 mencakup semua endpoint baru; uji mutasi kontrol baru terdeteksi
- [ ] UAT oleh manajer klinik — dijadwalkan di Stage 16 (dicatat sebagai pengingat UAT)
- [ ] PO menyetujui Stage 14

## 6. Risiko & catatan

- **Format laporan narkotika/psikotropika resmi (REG-10)** belum diverifikasi. Format yang ada sekarang hanya usulan. Apoteker penanggung jawab klinik pilot perlu mengonfirmasinya (terkait S10-1).
- **Angka keuangan bukan laporan akuntansi.** Laporan pendapatan membantu operasional; pembukuan/pajak tetap memakai sistem akuntansi klinik (e-Faktur = LJT).
- **Stage 13 ditunda** (DEC-046). Aplikasi pasien dikerjakan setelah pilot bersama requirement LJT lain.

## 7. Progres

| Tanggal | Catatan | Bukti |
|---|---|---|
| 17 Nov 2026 | Stage 12 disetujui bersyarat (DEC-045). PO memilih menunda Stage 13 sampai setelah pilot dan lanjut ke Stage 14 (DEC-046). Draf rencana & OD Stage 14 disusun | — |
| 17 Nov 2026 | PO menyetujui semua OD Stage 14 (DEC-047). Batch 1 dimulai | — |
| 17 Nov 2026 | **Batch 1 selesai** — fondasi & kunjungan/diagnosis: modul `libs/reporting` (filter seragam, tanggal menurut zona waktu cabang, cakupan cabang dari penugasan role, batas 366 hari, `statement_timeout` 30 detik, CSV). Laporan kunjungan harian/bulanan per cabang/poli/dokter/penjamin dengan pasien unik, baru/lama, status, dan no-show (OD-124). 10 besar diagnosis dari RM disahkan memakai diagnosis yang berlaku setelah addendum, primer/semua (OD-125). Menu Laporan (migrasi 0035) | Integrasi T01–T05, E2E W39, mutasi M176–M185 |
| 17 Nov 2026 | **Batch 2 selesai** — keuangan: pendapatan dua sudut pandang — tagihan terbit per kategori/layanan/penjamin/hari (bruto, diskon, neto, porsi pasien & penjamin; void/draf tidak dihitung) dan penerimaan kas per metode/hari (pembayaran + pelunasan piutang − refund disetujui) (OD-126). Closing kasir = rekap shift per tanggal buka (kas seharusnya, dihitung, selisih, non-tunai, status) dan umur piutang penjamin per tanggal posisi dari jatuh tempo (OD-127). Menu laporan keuangan (migrasi 0036) | Integrasi A01–A05, E2E W40, mutasi M186–M195 |
| 18 Nov 2026 | **Batch 3 selesai** — farmasi & ekspor: laporan stok, mutasi, golongan terbatas dan laporan baru **obat mendekati kedaluwarsa** dipindah ke menu Laporan (halaman lama dialihkan), semuanya mengikuti cakupan cabang (OD-129). Logika hitung semua laporan dipindah ke `@clinicrme/db/reports` (dipakai API & worker). **Ekspor seragam** `POST /reports/{kode}/exports` XLSX/CSV(BOM)/PDF A4 lanskap dengan watermark nama klinik, pengekspor, waktu, "Rahasia — untuk internal klinik"; ≤ 10.000 baris langsung, di atasnya job worker `report.export.run`; tautan 24 jam hanya untuk pemohon lalu berkas dihapus (`report.export.expire`); audit permintaan/selesai/unduhan berisi laporan, filter, jumlah baris, format — tanpa isi (OD-128). Ekspor butuh `report.export` **dan** izin lihat laporan itu. PDF dibatasi 10.000 baris; satu ekspor maks. 100.000 baris. Migrasi 0037 | Integrasi Y01–Y07, E2E W41, mutasi M196–M206 |
| 18 Nov 2026 | **OD-132 disetujui (DEC-048):** CSV cepat di laporan wajib `report.export`; role template Admin Klinik & Apoteker/TTK diberi `report.export` (migrasi 0038). Tautan CSV disembunyikan bagi yang tidak berizin | Integrasi Y08, mutasi M207–M208 |
| 18 Nov 2026 | **Batch 4 selesai** — dashboard manajer hari ini (kunjungan per status, antrean per poli, kas, tagihan belum lunas, stok kritis, SATUSEHAT perlu tindakan, grafik 14 hari Recharts, muat ulang 60 detik; OD-131). Gate: validasi angka terhadap hitungan independen dari dataset acak berbenih, uji keamanan setiap role × setiap laporan, uji performa 328.502 kunjungan (semua ≤ 3 detik; 3 perbaikan performa). `REPORT_CATALOG.md`, completion report. Migrasi 0039 | Integrasi Z01–Z06, E2E W42, mutasi M209–M214, PERFORMANCE_TEST.md |
