# Stage 7 — Stage Plan

| | |
|---|---|
| Stage | 7 — Master Data & Terminologi |
| Status | **IN_PROGRESS** — OD §4 diputuskan (DEC-032) |
| Mulai | 5 November 2026 (DEC-031) |
| Project Owner | Sumarto |
| Requirement | **MVP saja** (DEC-010): MST-FR-001, 002, 004–011 · TRM-FR-001–004. LJT di luar stage ini: MST-FR-003 (peringatan STR/SIP kedaluwarsa). TRM-FR-005 (KFA) → hanya kolom rujukan, sinkronisasi menunggu OD-031/OD-058 |
| Lingkungan uji | VPS dev `demo.medika.atoai.id` (CR-0003) — setiap merge ke main otomatis ter-deploy |

## 1. Tujuan

Admin klinik dapat mengelola sendiri data referensi yang dipakai semua modul berikutnya (registrasi, rekam medis, farmasi, billing): struktur fasilitas–cabang–poli, tenaga kesehatan, layanan & tarif, penjamin, satuan, supplier, serta kode ICD dan wilayah. Setiap perubahan teraudit dengan nilai sebelum/sesudah, dan data dapat diimpor/diekspor lewat Excel/CSV dengan uji coba (dry-run) lebih dulu.

## 2. Yang Sudah Ada

- **Skema** (baseline Stage 3): `facility`, `branch`, `service_unit`, `practitioner` (NIK terenkripsi + HMAC), `payer`, `service_item`, `tariff` (periode berlaku), `uom`/`uom_conversion`, `supplier`, `document_sequence`, `region`, `code_system`, `concept` (indeks trigram), `tenant_concept_favorite`. Semua tabel tenant ber-RLS; tabel global (`region`, `code_system`, `concept`) read-only bagi tenant.
- **Izin** `master.*` & `terminology.favorite.manage` sudah ada di 8 role template (migrasi 0001); menu master belum ada.
- **Audit** hash chain (`write_audit`), versi baris (`version` + If-Match), RLS fail-closed, matriks permission X01.
- **IAM-FR-016**: tautan user ↔ tenaga kesehatan sudah di backend (Stage 6 batch 3); pemilihan nakes di UI menunggu daftar nakes dari stage ini.

## 3. Batch

| Batch | Isi | Requirement |
|---|---|---|
| **1 — Organisasi & tenaga kesehatan** | API + UI: fasilitas, cabang (zona waktu), unit/poli/ruang/lokasi farmasi; tenaga kesehatan (NIK terenkripsi, jenis, spesialisasi, STR/SIP & masa berlaku, status aktif). Audit before/after generik untuk semua master (diff JSON, NIK tidak pernah masuk audit dalam bentuk asli). Menu "Master data". Pilih nakes di halaman undang/ubah user (menutup UI IAM-FR-016) | MST-FR-001, 002, 009 |
| **2 — Layanan, tarif, penjamin, satuan, supplier** | Layanan (konsultasi, tindakan, paket, administrasi); tarif per layanan × cabang × kategori penjamin dengan periode berlaku — tarif lama tidak ditimpa, periode tidak boleh tumpang tindih; penjamin (Umum, Asuransi, Perusahaan + kontrak); satuan & konversi (1 box = 10 strip = 100 tablet, dicek tidak melingkar); supplier | MST-FR-004–007, 010 |
| **3 — Terminologi & wilayah** | Pemuat code system ber-versi (kode asli tidak diubah; versi lama tetap untuk data historis); pencarian kode/kata kunci/sinonim (trigram); favorit per tenant yang **divalidasi tenaga medis** (OD-084); wilayah provinsi–kelurahan (OD-062) | TRM-FR-001–004, MST-FR-011 |
| **4 — Impor/ekspor & gate** | Impor CSV/XLSX per entitas: unggah → dry-run dengan laporan error per baris → konfirmasi → commit satu transaksi → audit; template unduh; ekspor CSV/XLSX. Uji E2E, mutasi, `docs/04-interoperability/TERMINOLOGY.md`, completion report | MST-FR-008 |

Perkiraan: batch 1–2 ±1 hari kerja masing-masing, batch 3–4 ±1 hari masing-masing (di luar waktu tunggu keputusan & data resmi).

## 4. Open Decision Stage 7

| OD | Pertanyaan | Usulan |
|---|---|---|
| **OD-030** ✅ DEC-032 | Sumber & izin ICD-10 (display Bahasa Indonesia) dan ICD-9-CM | ICD-10 adalah hak cipta WHO; mendistribusikan ICD-10 di dalam produk perangkat lunak memerlukan izin/lisensi dari WHO (WHO menerbitkan lisensi komersial & non-komersial). **Usulan:** (1) sistem dibangun untuk *memuat* berkas code system resmi ber-versi, bukan membundel data di repo; (2) untuk dev dipakai **subset contoh kecil** berlabel "CONTOH — bukan data resmi"; (3) PO menempuh izin resmi (formulir lisensi WHO dan/atau konfirmasi Kemenkes/SATUSEHAT atas data ICD-10 versi Indonesia) **sebelum pilot**. ICD-9-CM diterbitkan pemerintah AS (NCHS/CMS) — status lisensinya dikonfirmasi bersamaan. Ini bukan nasihat hukum; RSK-018 tetap terbuka sampai izin jelas |
| **OD-031** ✅ DEC-032 | KFA SATUSEHAT sebagai referensi obat | Butuh kredensial SATUSEHAT (OD-058). **Usulan:** Stage 7 hanya menyiapkan kolom `kfa_code` & code system `KFA`; sinkronisasi KFA di Stage 10/12 setelah akun sandbox ada |
| **OD-062** ✅ DEC-032 | Sumber data wilayah administratif | Repositori `cahyadsn/wilayah` (lisensi **MIT**), mengikuti Kepmendagri No. 300.2.2-2430 Tahun 2025 (perubahan atas 300.2.2-2138/2025). Dimuat sebagai data global ber-versi; diperbarui saat Kepmendagri baru terbit |
| **OD-081** ✅ DEC-032 | Format nomor rekam medis (MRN) | Per tenant (berlaku lintas cabang, OD-022), angka berurutan 8 digit tanpa awalan — contoh `00000123`; awalan dapat diatur tenant admin. Dipakai mulai Stage 8 (`document_sequence` sudah ada) |
| **OD-082** ✅ DEC-032 | Harga & pajak di tarif | Harga dalam Rupiah bulat, **final** (tanpa perhitungan pajak di Stage 7). Perlakuan pajak dibahas di Stage 11 bila diperlukan |
| **OD-083** ✅ DEC-032 | Format & pustaka impor/ekspor | CSV (UTF-8) + XLSX memakai `exceljs` (lisensi MIT, gratis); batas 5.000 baris / 5 MB per unggahan |
| **OD-084** ✅ DEC-032 | Siapa yang memvalidasi favorit diagnosis/tindakan (TRM-FR-003) | User yang tertaut ke tenaga kesehatan berjenis DOKTER / DOKTER_GIGI / DOKTER_SPESIALIS dengan SIP masih berlaku. Favorit yang belum divalidasi tidak muncul di daftar pilihan klinis |

## 5. Gate Stage 7

- [ ] Semua master MVP dapat dikelola, diimpor, diekspor (uji integrasi + E2E per entitas)
- [ ] Perubahan master teraudit dengan before/after (uji: setiap endpoint ubah menghasilkan audit berisi diff)
- [ ] Sumber & versi ICD terdokumentasi, lisensi penggunaan jelas (OD-030) — **atau** dicatat sebagai syarat terbuka sebelum pilot bila izin belum keluar
- [ ] Subset diagnosis divalidasi tenaga medis (OD-084)
- [ ] Matriks permission X01 mencakup semua endpoint master baru
- [ ] PO menyetujui Stage 7

## 6. Progres

| Tanggal | Isi | Bukti |
|---|---|---|
| 5 Nov 2026 | Rencana disusun; PO menyetujui semua usulan OD (DEC-032) | — |
| 5 Nov 2026 | **Batch 1 — organisasi & tenaga kesehatan:** modul baru `libs/masterdata`. API fasilitas (daftar, tambah, ubah), cabang & poli/unit (tambah ubah — sebelumnya hanya daftar/tambah di kontrak), tenaga kesehatan (daftar dengan cari/jenis/belum tertaut, detail, tambah, ubah sebagian). Semua ubah memakai If-Match (428/412); audit generik sebelum/sesudah hanya kolom berubah (MST-FR-009). NIK nakes: AES-256-GCM + indeks buta HMAC per tujuan (`blindIndex`), keunikan per klinik, respons hanya `nikMasked`, audit mencatat `[rahasia]`. Kuota cabang paket berlaku juga saat mengaktifkan ulang. Migrasi 0011: menu "Master data". UI: halaman Fasilitas & cabang (3 tabel + dialog), Tenaga kesehatan (cari, filter, tanda STR/SIP habis/≤ 60 hari, dialog NIK tersamar); dialog undang pengguna kini dapat menautkan tenaga kesehatan (menutup UI IAM-FR-016). Tambahan kontrak: `facilityList/Create/Update`, `branchUpdate`, `unitUpdate`, `practitionerGet` | M01–M10, W13, X01 (operasi baru otomatis ikut matriks permission), unit `crypto.spec.ts` (indeks buta) |
