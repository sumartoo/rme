# Scope — ClinicRME SaaS

| | |
|---|---|
| Versi | 1.0 — Disetujui (DEC-011) |
| Tanggal | 3 November 2026 |
| Stage | 0 |

Setelah disetujui, perubahan pada dokumen ini hanya melalui Change Request ([CHANGE_REQUEST_POLICY.md](CHANGE_REQUEST_POLICY.md)).

---

## 1. Pernyataan Scope

ClinicRME adalah aplikasi Rekam Medis Elektronik **rawat jalan** berbasis SaaS multi-tenant untuk klinik utama, klinik pratama, dan praktik dokter mandiri di Indonesia, mencakup alur pasien dari pendaftaran sampai pembayaran, integrasi SATUSEHAT, integrasi aplikasi laboratorium yang sudah ada, aplikasi Android untuk pasien, dan pelaporan.

## 2. Segmen Pelanggan

| Aspek | Praktik Dokter Mandiri | Klinik Pratama | Klinik Utama |
|---|---|---|---|
| Layanan | Dokter umum / dokter gigi / spesialis tunggal | Pelayanan medik dasar | Pelayanan medik spesialistik |
| Pengguna khas | 1–3 | 5–20 | 20–100+ |
| Cabang | 1 | 1–beberapa | Beberapa |
| Farmasi | Opsional | Umum ada | Umum ada |
| Lab | Jarang | Kadang | Sering (aplikasi lab eksisting) |
| Penjamin | Umum | Umum, perusahaan, BPJS (FKTP)* | Umum, asuransi, perusahaan |
| Usulan paket | Basic | Standard | Professional |

\* Integrasi BPJS menunggu OD-001. Angka pengguna & cabang adalah perkiraan untuk divalidasi di Stage 1.

## 3. Batas Sistem

### 3.1 Termasuk (In Scope)

| # | Area | Cakupan | Stage |
|---|---|---|---|
| S-01 | Administrasi SaaS | Tenant, paket, kuota, status, branding, ekspor data tenant | 5 |
| S-02 | Identitas & akses | User, undangan, login Google & email/password, MFA admin, role & permission, menu dinamis, jadwal login, delegasi | 3, 6 |
| S-03 | Master data | Fasilitas, cabang, unit, tenaga kesehatan, tarif, penjamin, satuan, impor/ekspor | 7 |
| S-04 | Terminologi | ICD-10, ICD-9-CM (subset), referensi obat | 7 |
| S-05 | Registrasi & antrean | MPI, cegah duplikat, appointment, walk-in, antrean & layar TV | 8 |
| S-06 | Rekam medis rawat jalan | SOAP, vital, alergi, diagnosis, tindakan, resep elektronik, dokumen medis, rujukan, pengesahan, addendum | 9 |
| S-07 | Integrasi lab eksisting | Order keluar & hasil masuk (minimal satu vendor) | 9 (OD-036) |
| S-08 | Farmasi klinik | Stok per batch, FEFO, dispensing, resep parsial, substitusi, opname, obat bebas | 10 |
| S-09 | Billing & pembayaran | Invoice, split penjamin, tunai/debit/kartu/QRIS, refund, void, closing shift, rekonsiliasi | 11 |
| S-10 | SATUSEHAT | Resource wajib, retry, dead-letter, rekonsiliasi | 12 |
| S-11 | Aplikasi Android pasien | Riwayat, resep, hasil lab, dokumen, jadwal, akun wali | 13 |
| S-12 | Pelaporan | Laporan standar, report builder terkontrol, dashboard, export | 14 |
| S-13 | Audit & keamanan | Audit log berantai hash, RLS, enkripsi, consent, retensi | 3 |
| S-14 | Infrastruktur & operasi | GCP produksi, backup, DR, monitoring, biaya | 15, 17 |

### 3.2 Tidak Termasuk (Out of Scope)

| # | Area | Alasan / catatan |
|---|---|---|
| X-01 | Rawat inap, kamar, IGD, kamar operasi | Wilayah SIMRS |
| X-02 | Sistem informasi laboratorium (LIS) | Lab memakai aplikasi sendiri; ClinicRME hanya integrasi |
| X-03 | Radiologi / PACS | Belum diminta; bila diperlukan → CR |
| X-04 | Akuntansi umum, general ledger, penggajian | Di luar rekam medis; cukup ekspor data keuangan |
| X-05 | Pengadaan / purchasing lengkap ke supplier | Hanya penerimaan barang & stok |
| X-06 | Klaim asuransi elektronik ke masing-masing insurer | Hanya pencatatan penjamin & piutang |
| X-07 | Pembayaran langganan SaaS otomatis | Tahap awal invoice manual (OD-027) |
| X-08 | Aplikasi iOS | Tidak disebut di roadmap; bila diperlukan → CR |
| X-09 | Telemedicine (video konsultasi) | DEC-007 — dapat diajukan via CR setelah rilis |

### 3.3 Termasuk sebagai Lanjutan (setelah MVP)

| # | Area | Catatan | Ref |
|---|---|---|---|
| L-01 | Bridging BPJS (P-Care untuk FKTP; V-Claim bila relevan) | Model data pasien & penjamin disiapkan sejak MVP agar tidak perlu migrasi besar | DEC-006 |

## 4. Integrasi Eksternal

| Sistem | Arah | Status inventaris |
|---|---|---|
| SATUSEHAT (Kemenkes) | Keluar (+ lookup) | Perlu akun sandbox (OD-058) |
| Aplikasi lab eksisting | Dua arah | **Vendor belum diidentifikasi** — perlu data dari klinik pilot (OD-059) |
| Payment gateway QRIS | Dua arah | Vendor belum dipilih (OD-039) |
| Google Sign-In | Masuk | OAuth client per lingkungan |
| Email / SMS / WhatsApp / push | Keluar | Provider belum dipilih (OD-012) |
| BPJS | Dua arah | Lanjutan (DEC-006); spesifikasi dikumpulkan di Stage 1 |

## 5. Regulasi & Standar

Lihat [REGULATORY_REGISTER.md](REGULATORY_REGISTER.md).

## 6. Deliverable Proyek

Per stage, sesuai `docs/stages/STAGE_XX_*.md`. Deliverable akhir: aplikasi web staf, konsol platform, aplikasi Android pasien, backend & worker, infrastruktur produksi, dokumentasi, dan laporan pengujian.

## 7. Kriteria Penerimaan Scope

Disetujui Project Owner pada 3 November 2026 (DEC-011).
