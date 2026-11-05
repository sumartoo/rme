# Stage 7 — Stage Completion Report

| | |
|---|---|
| Stage | 7 — Master Data & Terminologi |
| Status | **DISETUJUI** — DEC-034 (6 Nov 2026) |
| Disusun oleh | Sumarto (dibantu Claude) |
| Rincian | [STAGE_PLAN.md](STAGE_PLAN.md) §6 · keputusan DEC-031, DEC-032, DEC-033 |
| Lingkungan uji | `https://demo.medika.atoai.id` (VPS dev, deploy otomatis dari `main`) |

## 1. Ringkasan

Admin klinik kini mengelola sendiri data referensi untuk modul-modul berikutnya:
- struktur fasilitas, cabang, dan poli;
- tenaga kesehatan dengan STR/SIP;
- layanan dan tarif berperiode;
- penjamin beserta kontraknya;
- satuan dan konversinya;
- supplier;
- kode ICD;
- wilayah Indonesia.

Semua data bisa diimpor dan diekspor lewat Excel/CSV, dengan pemeriksaan (dry-run) lebih dulu. Setiap perubahan teraudit dengan nilai sebelum/sesudah.

| Metrik | Nilai |
|---|---|
| Uji integrasi API | 141/141 (M01–M27 baru) |
| Uji matriks permission (X01) | otomatis mencakup semua operasi master baru (403 untuk user tanpa izin) |
| E2E browser | 26/26 (W13–W16 baru) |
| Uji mutasi baru | M18–M22, semua terdeteksi lokal; seluruh M1–M22 hijau di GitHub Actions, 22/22 terdeteksi (§3) |
| Uji SQL | 88 + uji migrasi lulus |
| Migrasi | 0011–0014 |
| Operasi API baru | ±35 operasi (kontrak OpenAPI 180 operasi) |

## 2. Requirement MVP

| ID | Status | Bukti |
|---|---|---|
| MST-FR-001 fasilitas, cabang, unit/poli, ruang, lokasi farmasi | ✅ | M01–M05, W13 |
| MST-FR-002 tenaga kesehatan (NIK, jenis, spesialisasi, STR/SIP & masa berlaku) | ✅ NIK terenkripsi + indeks buta, selalu tersamar | M06–M09, W13 |
| MST-FR-003 peringatan STR/SIP kedaluwarsa | LJT. Sebagai gantinya, daftar menandai yang habis dan yang tinggal ≤ 60 hari | W13 |
| MST-FR-004 layanan | ✅ | M11, W14 |
| MST-FR-005 tarif × cabang × penjamin × periode | ✅ tidak tumpang tindih, tidak pernah ditimpa (trigger DB) | M12–M14, M25, W14 |
| MST-FR-006 penjamin & kontrak | ✅ | M15, W14 |
| MST-FR-007 satuan & konversi | ✅ konversi melingkar ditolak | M16, W14 |
| MST-FR-008 impor/ekspor dengan dry-run & error per baris | ✅ 7 jenis data, CSV/XLSX, satu transaksi | M23–M27, W16 |
| MST-FR-009 perubahan tercatat sebelum/sesudah | ✅ semua entitas, termasuk lewat impor | M01, M02, M08, M13, M24 |
| MST-FR-010 supplier | ✅ | M17, W14 |
| MST-FR-011 wilayah provinsi–kelurahan | ✅ 91.599 wilayah Kepmendagri 2025 | M19–M20, W15 |
| TRM-FR-001/002 ICD-10 & ICD-9-CM dengan versi sumber | ✅ mekanisme pemuatan ber-versi. Data saat ini **CONTOH** (OD-030) | M19, M21 |
| TRM-FR-003 favorit tervalidasi tenaga medis | ✅ validasi hanya oleh dokter ber-SIP berlaku (OD-084) | M22, W15 |
| TRM-FR-004 cari kode/kata kunci/sinonim | ✅ | M21, W15 |
| TRM-FR-005 referensi obat KFA | Sebagian: kolom/code system siap; sinkronisasi menunggu sandbox SATUSEHAT (OD-031, OD-058) | — |

## 3. Checklist Gate

- [x] Semua master MVP dapat dikelola, diimpor, diekspor
- [x] Perubahan master teraudit dengan before/after
- [x] Sumber & versi ICD terdokumentasi (`docs/04-interoperability/TERMINOLOGY.md`, tabel `reference_dataset`)
- [ ] **Lisensi ICD resmi** belum ada. Dicatat sebagai **syarat terbuka S7-1**: izin resmi (WHO/Kemenkes) dan pemuatan data resmi wajib selesai sebelum pilot (Stage 16). RSK-018 tetap terbuka.
- [x] Subset diagnosis divalidasi tenaga medis. Mekanisme dan penegakan sudah ada. Validasi isi oleh dokter klinik pilot dilakukan saat data resmi dimuat.
- [x] Matriks permission X01 mencakup semua endpoint master baru
- [x] Uji mutasi lengkap M1–M22 hijau di GitHub Actions: 22/22 terdeteksi, 0 lolos ([run 42020323156](https://github.com/AtoAIs/atoai-rme-v2/actions/runs/42020323156/job/127221155254), 5 Nov 2026, ±74 menit)
- [x] PO menyetujui Stage 7 — DEC-034, dengan syarat terbuka S7-1

## 4. Keamanan & privasi

- NIK tenaga kesehatan disimpan dengan AES-256-GCM. Keunikannya dijaga lewat indeks buta HMAC dengan subkunci khusus. NIK tidak pernah muncul di respons (hanya tersamar), di audit (tercatat `[rahasia]`), maupun di ekspor.
- Database menolak penimpaan harga tarif dan penghapusan tarif, bahkan lewat SQL langsung oleh role aplikasi (uji M13, mutasi M20).
- Data referensi global (wilayah, ICD) hanya bisa dibaca oleh aplikasi. Pemuatnya memeriksa sha256 setiap berkas.
- Berkas ekspor CSV aman dibuka di Excel: nilai yang diawali `=` `+` `-` `@` diberi petik supaya tidak dijalankan sebagai rumus (M23).
- Impor juga mewajibkan izin kelola untuk jenis datanya. Kalau ada satu baris error, tidak ada satu pun baris yang tersimpan (M24, mutasi M22).
- Dependency baru: `exceljs` (MIT, OD-083). `pnpm audit` melaporkan 1 temuan **moderate** pada `uuid` transitif (GHSA-w5hq-g745-h8pq). Temuan ini hanya berlaku bila buffer diberikan ke uuid v3/v5/v6, dan gate CI (high+) tetap lulus. Dipantau, dan akan diperbarui saat exceljs merilis versi baru.

## 5. Catatan untuk Stage berikutnya

- **S7-1**: data ICD resmi dan izinnya sebelum pilot (lihat TERMINOLOGY.md §"Sebelum pilot").
- Nomor rekam medis per tenant, 8 digit, awalan opsional (OD-081), dipakai saat registrasi pasien di Stage 8.
- Konversi satuan khusus obat dan sinkronisasi KFA dikerjakan di Stage 10.
- Pemakaian tarif oleh billing dan perlakuan pajak (OD-082) dikerjakan di Stage 11.
- Vhost nginx buatan PO di VPS sebaiknya memakai `client_max_body_size 25m`, karena impor bisa sampai 5 MB. Vhost dari `nginx-install.sh` sudah memakai nilai ini.

## 6. Persetujuan

| Peran | Nama | Keputusan | Tanggal | Catatan |
|---|---|---|---|---|
| Project Owner | Sumarto | ☑ Disetujui | 6 Nov 2026 | "setuju Stage 7" (DEC-034); syarat terbuka S7-1 (lisensi & data ICD resmi) sebelum pilot |
