# Stage 1 — Stage Plan

| | |
|---|---|
| Stage | 1 — Requirements & Business Analysis |
| Status | APPROVED |
| Mulai | 3 November 2026 |
| Project Owner | Sumarto |

## 1. Tujuan

Mendokumentasikan seluruh kebutuhan bisnis dan klinis dengan ID unik, prioritas MVP/Lanjutan, dan acceptance criteria yang dapat diuji.

## 2. Deliverable & Urutan Kerja

| # | Deliverable | Lokasi | Status |
|---|---|---|---|
| 1 | SRS — functional requirements per modul | `docs/01-requirements/SRS.md` | Draft v0.1 |
| 2 | Workflows WF-01 s.d. WF-15 | `docs/01-requirements/WORKFLOWS.md` | Draft v0.1 |
| 3 | Non-functional requirements | `docs/01-requirements/NFR.md` | Draft v0.1 |
| 4 | Requirement Traceability Matrix (awal) | `docs/01-requirements/REQUIREMENT_TRACEABILITY_MATRIX.md` | Draft v0.1 (dibangkitkan dari SRS) |
| 5 | Use cases | `docs/01-requirements/USE_CASES.md` | Draft v0.1 |
| 6 | Acceptance criteria | `docs/01-requirements/ACCEPTANCE_CRITERIA.md` | Draft v0.1 |
| 7 | Glossary | `docs/01-requirements/GLOSSARY.md` | Draft v0.1 |
| 8 | Stage Completion Report | `docs/reports/stage-1/STAGE_COMPLETION_REPORT.md` | Selesai |

## 3. Konvensi

- ID requirement: `<MOD>-FR-NNN`, NFR: `NFR-<KAT>-NNN`.
- Prioritas: **MVP** (wajib untuk pilot) / **LJT** (Lanjutan, setelah pilot) — DEC-010.
- Tag `[REVIEW-MEDIS]`: requirement klinis yang wajib direview tenaga medis sebelum gate Stage 9 (DEC-005).
- Tag `[OD-xxx]`: requirement yang bergantung pada open decision.

## 4. Sumber Requirement

Roadmap v1.0, APP_DESIGN v0.2, file stage 5–17, regulatory register, dan pengalaman PO membangun sistem klinik. **Belum** ada masukan klinik pilot — requirement akan divalidasi ulang ketika klinik pilot tersedia (RSK-016).

## 5. Gate Stage 1

- [ ] WF-01 s.d. WF-15 terdokumentasi & disetujui
- [ ] Setiap requirement memiliki ID, prioritas, dan acceptance criteria
- [ ] RTM berisi semua requirement
- [ ] Requirement `[REVIEW-MEDIS]` teridentifikasi
- [ ] NFR memiliki angka target (OD-015, OD-016)
- [ ] Pembagian MVP/Lanjutan disetujui
- [ ] Project Owner menyetujui Stage 1
