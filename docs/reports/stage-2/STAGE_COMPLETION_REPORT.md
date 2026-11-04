# Stage 2 — Stage Completion Report

| | |
|---|---|
| Stage | 2 — Arsitektur Sistem & Database |
| Status | **APPROVED** — 4 Nov 2026 |
| Tanggal | 4 November 2026 |
| Disusun oleh | Sumarto (dibantu Claude) |

## 1. Ringkasan

Fondasi teknis untuk seluruh requirement MVP sudah dirancang **dan diuji**:

| Metrik | Nilai |
|---|---|
| Tabel database | 89 (82 ber-`tenant_id`, 78 dengan RLS) |
| Uji keamanan skema | **42 lulus, 0 gagal** (PostgreSQL 16.15) |
| Operasi API (draft OpenAPI 3.1) | 144 operasi, 130 path, 119 skema |
| Lint OpenAPI (Redocly recommended) | **Valid** (2 pengecualian disengaja: redirect OAuth 302) |
| Requirement fungsional MVP → API/mekanisme | **147 / 147** |
| Requirement fungsional MVP → tabel | **147 / 147** |
| ADR | 13 (0001, 0003, 0009 Accepted; 10 Proposed) |
| Diagram Mermaid | 8, semua berhasil dirender |

## 2. Deliverable

| Deliverable | Lokasi |
|---|---|
| System architecture (C4) | `docs/02-architecture/SYSTEM_ARCHITECTURE.md` |
| Database design | `docs/02-architecture/DATABASE_DESIGN.md` |
| Data dictionary (otomatis) | `docs/02-architecture/DATA_DICTIONARY.md` |
| Tenant isolation | `docs/02-architecture/TENANT_ISOLATION.md` |
| API contracts | `docs/02-architecture/API_CONTRACTS.md` + `api/openapi.yaml` |
| Integration architecture | `docs/02-architecture/INTEGRATION_ARCHITECTURE.md` |
| Deployment architecture (+ backup/DR) | `docs/02-architecture/DEPLOYMENT_ARCHITECTURE.md` |
| ADR-0002, 0004–0013 | `docs/02-architecture/ADR/` |
| Skema DDL | `db/schema/*.sql` (14 file) + `requirement_table_map.yaml` |
| Uji skema | `db/tests/` |
| RTM (kolom Tabel & API) | `docs/01-requirements/REQUIREMENT_TRACEABILITY_MATRIX.md` |
| Generator | `tools/gen_openapi.py`, `tools/gen_data_dictionary.py`, `tools/gen_rtm.py` |

## 3. Perubahan File

- **Ditambahkan:** 7 dokumen arsitektur, 10 ADR, 14 file DDL, 3 file uji, `api/openapi.yaml`, `.redocly.lint-ignore.yaml`, 2 generator baru, bukti uji.
- **Diubah:** `tools/gen_rtm.py` (kolom Tabel & API), RTM dibangkitkan ulang.
- **Perbaikan format pada dokumen Stage 1 yang sudah disetujui:** diagram WF-01 di `WORKFLOWS.md` gagal dirender karena titik koma di label Mermaid → diganti koma. Isi tidak berubah, jadi tidak perlu CR (CHANGE_REQUEST_POLICY §1).
- **Migration:** belum ada; DDL di `db/schema/` akan menjadi migrasi awal Drizzle di Stage 4.

## 4. Bukti Pengujian

| Uji | Hasil | Bukti |
|---|---|---|
| DDL dimuat di database PostgreSQL 16 bersih | Berhasil | `db/tests/run_tests.sh` |
| Isolasi tenant (T01–T06) | Lulus | [db_security_tests.txt](evidence/db_security_tests.txt) |
| Immutability rekam medis (T07–T09) | Lulus | idem |
| Stok & farmasi (T10–T13) | Lulus | idem |
| Billing (T14–T18) | Lulus | idem |
| Tarif tidak tumpang tindih (T19) | Lulus | idem |
| Audit hash chain + deteksi manipulasi (T20–T22) | Lulus | idem |
| Lint OpenAPI | Valid | [openapi_lint.txt](evidence/openapi_lint.txt) |
| Render diagram Mermaid | 8/8 | `mmdc` |
| Konsistensi RTM | 0 ID duplikat, 0 referensi salah, 0 MVP tanpa AC/UC/API/tabel | `tools/gen_rtm.py` |

**Belum diuji (dijadwalkan):** konkurensi nomor antrean & nomor dokumen (Stage 4/8), performa query pada volume target (Stage 15), validasi payload FHIR terhadap SATUSEHAT sandbox (Stage 12).

## 5. Keputusan yang Dibutuhkan dari Project Owner

| # | Keputusan | Usulan | Ref |
|---|---|---|---|
| 1 | Model multi-tenancy | Shared schema + RLS | OD-007, ADR-0002 |
| 2 | FHIR API publik | Tidak di MVP | OD-009, ADR-0004 |
| 3 | IaC | Terraform | OD-006, ADR-0011 |
| 4 | UI library | shadcn/ui + Tailwind + Recharts | OD-013/046, ADR-0010 |
| 5 | Query layer | Drizzle ORM | OD-054, ADR-0001 |
| 6 | Reporting | DB utama + job asinkron; read replica saat dibutuhkan | OD-047, ADR-0012 |
| 7 | ADR-0004–0008, 0012, 0013 | Setujui | — |
| 8 | DR lintas region | Diputuskan di Stage 15 berdasarkan biaya; RTO 4 jam untuk kegagalan region hanya terjamin bila replica lintas region diaktifkan | DEPLOYMENT_ARCHITECTURE §5 |

## 6. Risiko & Isu Terbuka

| Item | Catatan |
|---|---|
| RSK-006 | Review medis tetap dibutuhkan sebelum gate Stage 9 |
| Biaya Cloud SQL HA + DR lintas region | Bisa menjadi komponen biaya terbesar → estimasi di Stage 15 (RSK-005) |
| OD-039 payment gateway, OD-059 vendor lab, OD-030 sumber ICD | Harus diputuskan sebelum stage terkait |
| Pengecekan alergi berbasis daftar zat (`drug_item.ingredients`) | Sederhana; akurasinya bergantung pada kualitas master obat → validasi di Stage 9/10 |
| Partisi `audit_log` | Perlu job pembuat partisi bulanan (Stage 4) — sementara masuk partisi default |

## 7. Checklist Gate Stage 2

- [x] Diagram konteks, container, komponen tersedia
- [x] Semua tabel MVP terdefinisi dengan RLS & index; DDL berjalan di PostgreSQL bersih
- [x] Uji isolasi tenant pada skema lulus (bukti tersimpan)
- [x] OpenAPI modul MVP lolos lint
- [x] Requirement MVP terpetakan ke modul/API/tabel di RTM
- [x] ADR-0002 s.d. ADR-0013 **Accepted** (DEC-016)
- [x] Strategi backup & DR terdokumentasi
- [x] PO menyetujui Stage 2 (DEC-018)

## 8. Persetujuan

| Peran | Nama | Keputusan | Tanggal | Catatan |
|---|---|---|---|---|
| Project Owner | Sumarto | ☑ Disetujui | 4 Nov 2026 | Semua usulan §5 disetujui; DR lintas region diputuskan di Stage 15 (DEC-017). |
