# Katalog Laporan Standar — ClinicRME (Stage 14)

| | |
|---|---|
| Cakupan | Laporan standar MVP RPT-FR-001–009 (OD-123 / DEC-047). Report builder, laporan terjadwal, dan laporan waktu tunggu adalah LJT |
| Kode | Logika hitung: `libs/db/src/lib/reports` (`@clinicrme/db/reports`, dipakai API & worker). API: `libs/reporting`. Web: `apps/web/src/app/(admin)/reports` |
| Keputusan | DEC-047 (OD-123–131), DEC-048 (OD-132) |

> **Batas klaim.** Laporan pendapatan, closing kasir, dan piutang adalah **laporan operasional**, bukan laporan akuntansi resmi atau pengganti
> pembukuan/pajak. Format laporan obat golongan terbatas **belum diverifikasi** terhadap format pelaporan resmi (REG-10).

## 1. Aturan bersama

| Aturan | Isi |
|---|---|
| Tanggal | Tanggal lokal **zona waktu cabang** tempat transaksi terjadi; "hari ini" per cabang. Rentang `from`–`to` inklusif |
| Rentang | Maksimal **366 hari** (OD-130). `statement_timeout` **30 detik** per permintaan |
| Cakupan cabang | Dari penugasan role pengguna (IAM-FR-009, OD-129): penugasan tanpa cabang = semua cabang; penugasan bercabang berlaku saat cabang aktif = cabang itu. `branchId` di luar cakupan → 403 `RPT-403-BRANCH`; cabang tidak dikenal/tenant lain → 404 |
| Isolasi tenant | RLS PostgreSQL (transaksi sebagai `clinicrme_app` dengan `app.tenant_id`) — juga untuk worker ekspor |
| Identitas pasien | Semua laporan **agregat**, tanpa nama/No. RM/NIK pasien (OD-129) |
| Audit tampilan | Setiap tampilan/unduhan CSV dicatat `REPORT_<KODE>_VIEWED` berisi filter (tanpa isi laporan). Dashboard **tidak** diaudit per tampilan (dimuat ulang tiap 60 detik, agregat) |
| Parameter | Divalidasi skema Zod; nilai di luar daftar (mis. `groupBy`) ditolak 400. Semua nilai masuk SQL sebagai parameter terikat (tanpa SQL dinamis) |

## 2. Daftar laporan

| Kode (URL `/api/v1/reports/{kode}`) | Menu web | Izin | Requirement / OD | Definisi singkat |
|---|---|---|---|---|
| `visits` | Laporan › Kunjungan | `report.operational.read` | RPT-FR-001, OD-124 | Encounter **tidak batal** per tanggal kedatangan (`coalesce(arrived_at, created_at)`). Per hari/bulan, dikelompokkan tanpa/cabang/poli/dokter/penjamin. Pasien unik; pasien **baru** = kunjungan tidak batal pertama pasien di klinik; status menunggu/dilayani/selesai. Janji temu tidak datang (no-show) dihitung terpisah |
| `top-diagnoses` | Laporan › 10 besar diagnosis | `report.clinical.read` | RPT-FR-002, OD-125 | Kunjungan dengan **RM disahkan**, diagnosis **yang berlaku** (addendum terakhir yang mengganti diagnosis, OD-120, atau diagnosis saat pengesahan). Bawaan primer; `scope=all` semua diagnosis. Kasus baru/lama, pasien unik, persentase |
| `revenue` | Laporan › Pendapatan | `report.finance.read` | RPT-FR-003, OD-126 | `view=billed`: tagihan **terbit** (ISSUED/PARTIALLY_PAID/PAID; draf & void tidak dihitung) per tanggal terbit — bruto, diskon, neto, porsi pasien & penjamin per kategori/layanan/penjamin/hari. `view=cash`: pembayaran (tanggal terima) + pelunasan piutang (tanggal bayar) − refund **disetujui** (tanggal keputusan), per metode/hari |
| `cashier-closing` | Laporan › Closing kasir | `report.finance.read` | RPT-FR-004, OD-127 | Rekap **shift** per tanggal buka: kas awal, tunai masuk, refund tunai, kas seharusnya (nilai tersimpan saat tutup, atau kas awal + tunai − refund), dihitung, selisih, non-tunai, status verifikasi |
| `receivables` | Laporan › Umur piutang | `report.finance.read` | RPT-FR-007, OD-127 | Per penjamin pada tanggal posisi (bawaan hari ini): sisa = nominal − pelunasan s.d. tanggal itu, dari tagihan terbit s.d. tanggal itu (tidak void). Umur dari **jatuh tempo**: belum, 1–30, 31–60, 61–90, > 90 hari |
| `stock` | Laporan › Stok & mutasi obat | `report.pharmacy.read` | RPT-FR-005 | Per obat: saldo awal, penerimaan, retur masuk, penyerahan resep, penjualan bebas, keluar lain, penyesuaian/opname, saldo akhir, nilai harga beli per batch (HPP ditunda, OD-038) |
| `stock-movements` | (tombol di halaman stok) | `report.pharmacy.read` | RPT-FR-005 | Daftar mutasi ledger dengan referensi dokumen; tampilan maks. 5.000 baris (`truncated`), ekspor maks. 100.000 baris |
| `near-expiry` | Laporan › Obat mendekati kedaluwarsa | `report.pharmacy.read` | RPT-FR-005 | Batch bersaldo yang kedaluwarsa dalam `days` hari (bawaan pengaturan `expiryWarningDays`, 90), termasuk yang sudah kedaluwarsa (`includeExpired`). Nilai = saldo × harga beli |
| `controlled-drugs` | Laporan › Obat golongan terbatas | `report.pharmacy.controlled` | RPT-FR-006, OD-100 | Per obat narkotika/psikotropika/prekursor per bulan: saldo awal, pemasukan, pengeluaran resep, pengeluaran lain, penyesuaian/opname, saldo akhir. **Format resmi belum diverifikasi (REG-10)** |
| `GET /api/v1/dashboard/today` | Laporan › Dashboard manajer | `report.dashboard.read` | RPT-FR-009, OD-131 | Hari ini per cabang: kunjungan per status, antrean menunggu/dipanggil per poli, kas bersih (definisi sama dengan `revenue` kas), tagihan belum lunas (porsi pasien − terbayar, semua tanggal), obat aktif dengan stok layak pakai ≤ stok minimum, batch kedaluwarsa ≤ 30 hari & sudah kedaluwarsa, SATUSEHAT perlu tindakan (ERROR/DEAD/BLOCKED), tren 14 hari kunjungan & kas |

Laporan lain di luar katalog ini: transaksi tidak wajar `GET /reports/anomalies` (Stage 11, BIL-FR-016, izin `report.finance.audit`) dan
dashboard/rekonsiliasi SATUSEHAT (Stage 12, `integration.read`).

## 3. Ekspor (RPT-FR-008, OD-128, OD-132)

| Aturan | Isi |
|---|---|
| Endpoint | `POST /api/v1/reports/{kode}/exports` `{ format: XLSX|CSV|PDF, parameters: {…filter yang sama dengan GET} }` → `ExportJob`; status `GET /api/v1/report-exports/{id}`; unduh `GET /api/v1/report-exports/{id}/download` |
| Izin | `report.export` **dan** izin lihat laporan itu. Unduhan CSV cepat (`?format=csv` di GET laporan) juga wajib `report.export` (OD-132 / DEC-048) |
| Format | XLSX (`exceljs`, kolom angka berformat), CSV UTF-8 **BOM**, PDF A4 **lanskap** (`pdfmake`, maks. 10.000 baris) |
| Watermark | Nama klinik, nama pengekspor, waktu ekspor (zona waktu tenant), "Rahasia — untuk internal klinik" — di preamble berkas, kop/kaki halaman cetak XLSX, dan watermark diagonal + kaki PDF |
| Ukuran | ≤ **10.000** baris dibuat langsung (status `DONE`). Di atasnya job `QUEUED` diproses worker `report.export.run` (tiap menit) dengan cakupan cabang pemohon saat meminta. Maks. 100.000 baris per ekspor |
| Tautan | Hanya pemohon; berlaku **24 jam**; setelahnya 410 dan berkas dihapus job `report.export.expire` (tiap jam). Job macet > 1 jam → FAILED |
| Audit | `REPORT_EXPORTED` / `REPORT_EXPORT_REQUESTED` (laporan, format, filter, jumlah baris), `REPORT_EXPORT_FAILED`, `REPORT_EXPORT_DOWNLOADED` — **tanpa isi laporan** |
| Penyimpanan | Bucket `exports`, `stored_file` kategori `REPORT`; tabel `report_export_job` hanya menyimpan parameter filter |

## 4. Validasi & performa

- **Validasi angka** (gate): `apps/api/test-integration/reporting-gate.e2e-spec.ts` Z01–Z03 membangun dataset acak berbenih (2 cabang, zona waktu
  berbeda, 50 hari, kunjungan batal, tagihan void/draf, refund, pelunasan piutang sebagian) dan membandingkan laporan kunjungan, pendapatan
  (tagihan & kas), dan umur piutang dengan hitungan independen di sisi uji. Uji per laporan dengan angka hitung manual: T01–T05, A01–A05, G02, S06, Y01–Y02, Z04.
- **Keamanan**: Z05 (setiap role template × setiap laporan & dashboard, dicocokkan dengan matriks izin di DB; CSV mengikuti `report.export`),
  Z06 (isolasi tenant, tanpa identitas pasien, parameter tidak valid/injeksi ditolak), Y05/Y08 (ekspor).
- **Performa** (OD-130): [`docs/reports/stage-14/PERFORMANCE_TEST.md`](../reports/stage-14/PERFORMANCE_TEST.md), skrip `libs/db/perf/report-perf.ts`.
