# Roadmap — ClinicRME SaaS

| | |
|---|---|
| Versi | 1.1 — Disetujui (turunan dari ROADMAP_PENGEMBANGAN_CLINICRME_SaaS v1.0) |
| Tanggal | 3 November 2026 |
| Stage | 0 |

## 1. Perubahan terhadap Roadmap v1.0

| # | Perubahan | Referensi | Status |
|---|---|---|---|
| 1 | Stack: Spring Boot + Angular → **NestJS + Next.js**; PostgreSQL, Android Kotlin, GCP tetap | DEC-001, ADR-0001 | Disetujui |
| 2 | Autentikasi: Google Sign-In + email/password langsung di NestJS | DEC-002, ADR-0003 | Disetujui |
| 3 | Stage dikelompokkan menjadi 6 phase (A–F) — tanpa mengubah isi & urutan stage | — | Disetujui |
| 4 | Integrasi aplikasi lab dipindah dari Stage 10 ke Stage 9 | DEC-009 | Disetujui |
| 5 | Stage 3 dikerjakan sebagai desain + PoC, implementasi final di Stage 4 (atau Stage 3 ↔ 4 ditukar) | DEC-008 | Disetujui |

## 2. Phase & Stage

| Phase | Stage | Nama | Gate |
|---|---|---|---|
| **A — Inisiasi & Desain** | 0 | Project Charter & Feasibility | Scope & roadmap disetujui |
| | 1 | Requirements & Business Analysis | Requirement bisnis & klinis disetujui |
| | 2 | Arsitektur Sistem & Database | Arsitektur, DB, API contract disetujui |
| **B — Fondasi Teknis** | 3 | Security, Privacy & Compliance Foundation | Uji keamanan fondasi & isolasi tenant lulus |
| | 4 | Project Foundation & DevOps | Build reproducible, pipeline & foundation test lulus |
| **C — Platform SaaS** | 5 | SaaS Administration & Tenant Management | Tenant terkelola tanpa kebocoran |
| | 6 | Identity, Role, Permission & Dynamic Menu | Permission teruji di backend |
| | 7 | Master Data & Terminologi | Master data terkelola & teraudit |
| **D — Operasional Klinik** | 8 | Registrasi, Jadwal & Antrean | Alur registrasi & antrean teruji |
| | 9 | Clinical Workflow & Rekam Medis | Validasi tenaga medis & integritas data |
| | 10 | Farmasi & Inventori | Stok, resep, dispensing terekonsiliasi |
| | 11 | Billing, Payment & Financial Controls | Uji transaksi & fraud control lulus |
| **E — Integrasi & Kanal** | 12 | FHIR & SATUSEHAT | Resource wajib tervalidasi |
| | 13 | Android Patient Application | Uji privasi & keamanan mobile lulus |
| | 14 | Custom Reporting, Analytics & Dashboard | UAT, validasi data, security & performance lulus |
| **F — Produksi** | 15 | GCP Production Infrastructure & Cost Control | Load test, restore, cost review lulus |
| | 16 | Integration Testing, UAT & Pilot | PO & klinik pilot menyetujui rilis |
| | 17 | Production Release & Maintenance | Setiap rilis memenuhi checklist |

Rincian tiap stage: `docs/stages/STAGE_XX_*.md`.

## 3. Pertimbangan MVP

Roadmap mensyaratkan stage berjalan berurutan. Untuk mempercepat umpan balik dari klinik nyata, diusulkan agar Stage 1 menandai setiap requirement sebagai **MVP** atau **Lanjutan**, lalu Stage 5–14 mengerjakan bagian MVP terlebih dulu. Requirement Lanjutan tidak dihapus; dikerjakan setelah pilot melalui siklus Stage 17 (CR + rilis). Disetujui (DEC-010).

## 4. Jadwal

Belum ditetapkan — bergantung pada kapasitas tim (OD-056) dan ketersediaan klinik pilot. Estimasi per stage disusun di awal masing-masing stage dalam Stage Plan.
