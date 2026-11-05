# Stage 7 — Master Data & Terminologi

| | |
|---|---|
| Phase | C — Platform SaaS |
| Status | **Berjalan** sejak 5 Nov 2026 (DEC-031) — rencana: `docs/reports/stage-7/STAGE_PLAN.md` |
| Prasyarat | Stage 6 disetujui |
| Modul | `masterdata`, `terminology` |

## 1. Tujuan

Menyediakan data referensi untuk semua modul, dengan validasi, versi, impor/ekspor, dan audit.

## 2. Ruang Lingkup

- Fasilitas, cabang, unit/poli, ruang layanan, lokasi farmasi.
- Dokter, tenaga kesehatan (STR/SIP, spesialisasi), petugas.
- Struktur identitas pasien (jenis identifier, NIK, paspor, MRN).
- Tarif konsultasi, tindakan, paket, layanan.
- Penjamin: umum, asuransi, perusahaan, kontrak.
- ICD-10 (Bahasa Indonesia) & ICD-9-CM (subset yang sering dipakai).
- Obat & formularium (detail stok di Stage 10).
- Satuan & konversi.
- Impor/ekspor Excel/CSV.
- Versioning & validasi.

## 3. Rancangan

### 3.1 Level Master Data

| Level | Contoh | Pengelola |
|---|---|---|
| Global (platform) | ICD-10, ICD-9-CM, satuan dasar, wilayah administratif, kode KFA | Platform, read-only bagi tenant |
| Tenant | Tarif, penjamin, formularium, template | Tenant admin |
| Cabang | Poli, ruang, jadwal | Admin cabang |

Tabel global **tidak** memiliki `tenant_id` dan tidak dikenai RLS tenant; tabel tenant memakai RLS.

### 3.2 Terminologi

| Tabel | Kolom |
|---|---|
| `code_system` | code (`ICD10`, `ICD9CM`, ...), version, source, effective_date |
| `concept` | system_id, code, display_id, display_en, parent_code, active |
| `tenant_concept_subset` | tenant_id, concept_id, is_favorite, validated_by, validated_at |

Aturan: kode asli & versi tidak diubah; subset favorit per tenant wajib divalidasi tenaga medis.

### 3.3 Tarif

| Kolom | Keterangan |
|---|---|
| `service_id`, `branch_id` | |
| `payer_category` | UMUM / ASURANSI / PERUSAHAAN / spesifik payer |
| `price`, `valid_from`, `valid_to` | Berlaku berdasarkan periode, tidak di-overwrite |

### 3.4 Impor

Alur: upload → validasi (dry-run, laporan error per baris) → konfirmasi → commit dalam satu transaksi → audit. Template impor disediakan per entitas.

## 4. Requirement Awal

| ID | Ringkasan |
|---|---|
| MST-FR-001 | CRUD fasilitas, cabang, unit |
| MST-FR-002 | CRUD tenaga kesehatan dengan masa berlaku STR/SIP |
| MST-FR-003 | Tarif berlaku per periode & kategori penjamin |
| MST-FR-004 | Impor/ekspor Excel/CSV dengan dry-run |
| TRM-FR-001 | ICD-10 & ICD-9-CM tersedia dengan versi sumber |
| TRM-FR-002 | Subset diagnosis favorit per tenant tervalidasi |

## 5. Deliverable

Modul `masterdata` & `terminology`, seed data terminologi (dari sumber berlisensi/resmi), layar master, template impor, `docs/04-interoperability/TERMINOLOGY.md`, test, completion report.

## 6. Gate Checklist

- [ ] Semua master MVP dapat dikelola, diimpor, diekspor.
- [ ] Perubahan master teraudit dengan before/after.
- [ ] Sumber & versi ICD terdokumentasi, lisensi penggunaan jelas.
- [ ] Subset diagnosis divalidasi tenaga medis.
- [ ] Project Owner menyetujui Stage 7.

## 7. Open Decision

- **OD-030** — Sumber resmi ICD-10 Bahasa Indonesia & ICD-9-CM yang dipakai, serta izinnya.
- **OD-031** — Penggunaan Kamus Farmasi & Alat Kesehatan (KFA) SATUSEHAT sebagai referensi obat.
