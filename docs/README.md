# Dokumentasi ClinicRME SaaS

Rekam Medik Elektronik multi-tenant untuk klinik utama, klinik pratama, dan praktik dokter mandiri.

## Dokumen Utama

| Dokumen | Isi |
|---|---|
| [APP_DESIGN.md](APP_DESIGN.md) | Rancangan aplikasi: arsitektur, modul, multi-tenancy, data model, API, keamanan, integrasi, open decision |
| [stages/](stages/) | Rencana kerja per stage (0–17) |
| [00-governance/](00-governance/) | **Stage 0:** [Charter](00-governance/PROJECT_CHARTER.md) · [Scope](00-governance/SCOPE.md) · [Roadmap](00-governance/ROADMAP.md) · [Stage Gate](00-governance/STAGE_GATE_POLICY.md) · [Change Request](00-governance/CHANGE_REQUEST_POLICY.md) · [Risiko](00-governance/RISK_REGISTER.md) · [Regulasi](00-governance/REGULATORY_REGISTER.md) · [Open Decisions](00-governance/OPEN_DECISIONS.md) · [Decision Log](00-governance/DECISION_LOG.md) |
| [reports/stage-0/](reports/stage-0/STAGE_COMPLETION_REPORT.md) | Stage 0 — **disetujui** 3 Nov 2026 |
| [01-requirements/](01-requirements/) | **Stage 1 (disetujui):** [Plan](reports/stage-1/STAGE_PLAN.md) · [SRS](01-requirements/SRS.md) · [Workflows](01-requirements/WORKFLOWS.md) · [NFR](01-requirements/NFR.md) · [RTM](01-requirements/REQUIREMENT_TRACEABILITY_MATRIX.md) · [Use Cases](01-requirements/USE_CASES.md) · [Acceptance Criteria](01-requirements/ACCEPTANCE_CRITERIA.md) · [Glossary](01-requirements/GLOSSARY.md) · [Laporan](reports/stage-1/STAGE_COMPLETION_REPORT.md) |
| [02-architecture/](02-architecture/) | **Stage 2 (disetujui):** [Plan](reports/stage-2/STAGE_PLAN.md) · [System Architecture](02-architecture/SYSTEM_ARCHITECTURE.md) · [API Contracts](02-architecture/API_CONTRACTS.md) · [Integration](02-architecture/INTEGRATION_ARCHITECTURE.md) · [Deployment](02-architecture/DEPLOYMENT_ARCHITECTURE.md) · [Database Design](02-architecture/DATABASE_DESIGN.md) · [Data Dictionary](02-architecture/DATA_DICTIONARY.md) · [Tenant Isolation](02-architecture/TENANT_ISOLATION.md) · [ADR](02-architecture/ADR/) · skema `db/schema/` · uji `db/tests/` · OpenAPI `api/openapi.yaml` · [Laporan](reports/stage-2/STAGE_COMPLETION_REPORT.md) |
| [03-security/](03-security/) | **Stage 3 (disetujui):** [Plan](reports/stage-3/STAGE_PLAN.md) · [Laporan](reports/stage-3/STAGE_COMPLETION_REPORT.md) · [PoC](../poc/stage-3/README.md) · [Threat Model](03-security/THREAT_MODEL.md) · [Security Controls](03-security/SECURITY_CONTROLS.md) · [Permission Matrix](03-security/PERMISSION_MATRIX.md) · [Audit Policy](03-security/AUDIT_POLICY.md) · [Privacy & PDP](03-security/PRIVACY_AND_PDP.md) · [Retensi](03-security/DATA_RETENTION_POLICY.md) · [HIPAA Gap](03-security/HIPAA_GAP_ASSESSMENT.md) · [Incident Response](03-security/INCIDENT_RESPONSE_PLAN.md) |
| [reports/stage-4/](reports/stage-4/STAGE_PLAN.md) | **Stage 4 (disetujui dengan catatan):** [Laporan](reports/stage-4/STAGE_COMPLETION_REPORT.md) · [Plan & hasil](reports/stage-4/STAGE_PLAN.md) · [Coding Standards](CODING_STANDARDS.md) · [Test Strategy](05-testing/TEST_STRATEGY.md) · [Environments](02-architecture/ENVIRONMENTS.md) · [Contributing](../CONTRIBUTING.md) · [cara menjalankan](../README.md) |
| [ADR-0001 Stack](02-architecture/ADR/ADR-0001-tech-stack.md) | NestJS + Next.js + PostgreSQL |
| [ADR-0003 Autentikasi](02-architecture/ADR/ADR-0003-authentication.md) | Google Sign-In + email/password di NestJS |

**Stack:** NestJS · Next.js · PostgreSQL (RLS) · Drizzle · pg-boss · Nx · Android Kotlin · GCP Cloud Run

## Phase & Stage

| Phase | Stage | Dokumen | Gate |
|---|---|---|---|
| **A — Inisiasi & Desain** | 0 | [Project Charter & Feasibility](stages/STAGE_00_PROJECT_CHARTER.md) | Scope & roadmap disetujui |
| | 1 | [Requirements & Business Analysis](stages/STAGE_01_REQUIREMENTS.md) | Requirement bisnis & klinis disetujui |
| | 2 | [Arsitektur Sistem & Database](stages/STAGE_02_ARCHITECTURE.md) | Arsitektur, DB, API contract disetujui |
| **B — Fondasi Teknis** | 3 | [Security, Privacy & Compliance Foundation](stages/STAGE_03_SECURITY_FOUNDATION.md) | Uji keamanan fondasi & isolasi tenant lulus |
| | 4 | [Project Foundation & DevOps](stages/STAGE_04_DEVOPS_FOUNDATION.md) | Build reproducible, pipeline & foundation test lulus |
| **C — Platform SaaS** | 5 | [SaaS Administration & Tenant Management](stages/STAGE_05_TENANT_MANAGEMENT.md) | Tenant terkelola tanpa kebocoran lintas tenant |
| | 6 | [Identity, Role, Permission & Dynamic Menu](stages/STAGE_06_IAM_DYNAMIC_MENU.md) | Semua permission teruji di backend |
| | 7 | [Master Data & Terminologi](stages/STAGE_07_MASTER_DATA.md) | Master data dapat dikelola, impor/ekspor, diaudit |
| **D — Operasional Klinik** | 8 | [Registrasi, Jadwal & Antrean](stages/STAGE_08_REGISTRATION_QUEUE.md) | Alur registrasi & antrean teruji |
| | 9 | [Clinical Workflow & Rekam Medis](stages/STAGE_09_CLINICAL_RECORD.md) | Lulus validasi tenaga medis & integritas data |
| | 10 | [Farmasi & Inventori](stages/STAGE_10_PHARMACY_INVENTORY.md) | Stok, batch, resep, dispensing terekonsiliasi |
| | 11 | [Billing, Payment & Financial Controls](stages/STAGE_11_BILLING_PAYMENT.md) | Uji transaksi, pembayaran, refund, fraud control lulus |
| **E — Integrasi & Kanal** | 12 | [FHIR & SATUSEHAT](stages/STAGE_12_FHIR_SATUSEHAT.md) | Resource wajib tervalidasi di sandbox |
| | 13 | [Android Patient Application](stages/STAGE_13_ANDROID_PATIENT_APP.md) | Uji privasi, keamanan mobile, sinkronisasi lulus |
| | 14 | [Custom Reporting, Analytics & Dashboard](stages/STAGE_14_REPORTING.md) | UAT, validasi data, security & performance test lulus |
| **F — Produksi** | 15 | [GCP Production Infrastructure & Cost Control](stages/STAGE_15_GCP_PRODUCTION.md) | Load test, security review, restore, cost review lulus |
| | 16 | [Integration Testing, UAT & Pilot](stages/STAGE_16_UAT_PILOT.md) | Project Owner & klinik pilot menyetujui rilis |
| | 17 | [Production Release & Maintenance](stages/STAGE_17_RELEASE_MAINTENANCE.md) | Setiap rilis memenuhi release checklist |

## Aturan Kerja

1. Satu stage aktif pada satu waktu; stage berikutnya dimulai hanya setelah persetujuan eksplisit Project Owner.
2. Requirement yang sudah disetujui hanya berubah melalui Change Request.
3. Requirement ambigu dicatat sebagai **OPEN DECISION**, tidak ditebak.
4. Setiap stage ditutup dengan `reports/stage-N/STAGE_COMPLETION_REPORT.md`.
5. Tidak ada data pasien nyata di dev/test/staging.

## Skema ID

| Jenis | Format | Contoh |
|---|---|---|
| Functional requirement | `<MOD>-FR-<NNN>` | `REG-FR-012` |
| Non-functional requirement | `NFR-<KAT>-<NNN>` | `NFR-SEC-003` |
| Use case | `UC-<MOD>-<NN>` | `UC-CLN-04` |
| Acceptance criteria | `AC-<REQ-ID>-<N>` | `AC-REG-FR-012-1` |
| Test case | `TC-<MOD>-<NNNN>` | `TC-BIL-0031` |
| Open decision | `OD-<NNN>` | `OD-007` |
| ADR | `ADR-<NNNN>` | `ADR-0003` |
| Change request | `CR-<NNNN>` | `CR-0001` |
| Risiko | `RSK-<NNN>` | `RSK-014` |

Kode modul: `PLT` platform, `IAM` identitas, `AUD` audit, `MST` master data, `TRM` terminologi, `REG` registrasi/pasien, `SCH` jadwal/antrean, `CLN` klinis, `PHM` farmasi, `BIL` billing, `INT` integrasi, `POR` portal pasien, `RPT` reporting, `DOC` dokumen, `NTF` notifikasi.
