# Stage 2 — Stage Plan

| | |
|---|---|
| Stage | 2 — Arsitektur Sistem & Database |
| Status | APPROVED |
| Mulai | 3 November 2026 |
| Project Owner | Sumarto |
| Dasar | SRS v1.0, NFR v1.0, APP_DESIGN v0.2, ADR-0001, ADR-0003 |

## 1. Tujuan

Menetapkan fondasi teknis untuk seluruh requirement MVP: arsitektur, skema database dengan isolasi tenant, kontrak API, audit, event, integrasi, dan deployment.

## 2. Deliverable & Urutan

| # | Deliverable | Lokasi | Status |
|---|---|---|---|
| 1 | ADR-0002, 0004–0013 | `docs/02-architecture/ADR/` | ✅ Draft (Proposed) |
| 2 | Skema database MVP (DDL, RLS, trigger) + uji isolasi | `db/schema/`, `db/tests/` | ✅ 89 tabel, 42 uji lulus |
| 3 | DATABASE_DESIGN.md | `docs/02-architecture/` | ✅ Draft |
| 4 | DATA_DICTIONARY.md (dibangkitkan dari komentar skema) | `docs/02-architecture/` | ✅ Dibangkitkan |
| 5 | TENANT_ISOLATION.md | `docs/02-architecture/` | ✅ Draft |
| 6 | SYSTEM_ARCHITECTURE.md (C4) | `docs/02-architecture/` | ✅ Draft |
| 7 | API_CONTRACTS.md + draft OpenAPI | `docs/02-architecture/`, `api/openapi.yaml` | ✅ 144 operasi, lint valid |
| 8 | INTEGRATION_ARCHITECTURE.md | `docs/02-architecture/` | ✅ Draft |
| 9 | DEPLOYMENT_ARCHITECTURE.md (+ backup/DR) | `docs/02-architecture/` | ✅ Draft |
| 10 | RTM: kolom modul/tabel/API | `docs/01-requirements/` | ✅ 147/147 |
| 11 | Stage Completion Report | `docs/reports/stage-2/` | ✅ |

## 3. Usulan Keputusan Stage 2 (disetujui di gate)

| OD | Usulan | ADR |
|---|---|---|
| OD-004 | Monorepo Nx (sudah tercakup ADR-0001) | ADR-0001 |
| OD-006 | Terraform untuk IaC GCP | ADR-0011 |
| OD-007 | Shared database, shared schema + RLS | ADR-0002 |
| OD-009 | Tidak mengekspos FHIR API publik di MVP; ClinicRME hanya klien FHIR ke SATUSEHAT | ADR-0004 (bagian integrasi) |
| OD-013 | shadcn/ui + Tailwind CSS | ADR-0010 |
| OD-054 | Drizzle ORM | ADR-0001 (catatan) |

## 4. Gate Stage 2

- [x] Diagram konteks, container, komponen tersedia
- [x] Semua tabel MVP terdefinisi dengan RLS & index; DDL berjalan di PostgreSQL bersih
- [x] Uji isolasi tenant pada skema lulus (bukti tersimpan)
- [x] OpenAPI modul MVP lolos lint
- [x] Requirement MVP terpetakan ke modul/API/tabel di RTM
- [x] ADR-0002 s.d. ADR-0013 Accepted
- [x] Strategi backup & DR terdokumentasi
- [x] PO menyetujui Stage 2
