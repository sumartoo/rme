# Stage 4 — Project Foundation & DevOps

| | |
|---|---|
| Phase | B — Fondasi Teknis |
| Status | **Disetujui dengan catatan** 4 Nov 2026 (DEC-023) |
| Prasyarat | Stage 3 disetujui |
| Stage berikutnya | Stage 5 — Tenant Management |

## 1. Tujuan

Menyiapkan lingkungan pengembangan, build, test, dan deployment yang konsisten dan dapat direproduksi.

## 2. Ruang Lingkup

- Monorepo Nx + pnpm (apps/api, apps/worker, apps/web, libs/*, db/migrations, android, infra, docs).
- Skeleton NestJS (api & worker) dengan `libs/shared` & library modul kosong.
- Skeleton Next.js (web, platform-admin) + `libs/ui` + `libs/api-client`.
- PostgreSQL lokal (Docker Compose) & migrasi Drizzle Kit.
- Environment dev, test, staging, prod.
- CI/CD (GitHub Actions atau Cloud Build).
- Unit & integration test (Testcontainers untuk PostgreSQL).
- Static analysis, dependency & secret scanning.
- Coding standard, branching, code review.
- Logging terstruktur & observability dasar.

## 3. Rancangan Pekerjaan

### 3.1 Pipeline CI

```
PR opened
 ├─ nx affected: lint (termasuk module boundaries) → typecheck → unit test (Vitest/Jest) → build
 ├─ api: integration test dengan PostgreSQL (Testcontainers) termasuk test RLS
 ├─ openapi: generate spec → bandingkan dengan main (breaking change check)
 ├─ security: dependency scan, secret scan, SAST
 └─ migration: jalankan migrasi pada DB kosong & DB dengan migrasi sebelumnya
merge to main
 └─ build image → push Artifact Registry → deploy dev → smoke test
tag release
 └─ deploy staging (manual approval) → deploy prod (manual approval)
```

### 3.2 Standar

| Aspek | Usulan |
|---|---|
| Branching | Trunk-based, short-lived feature branch, PR wajib review 1 orang |
| Commit | Conventional Commits, menyebut requirement ID |
| TypeScript | Node.js LTS, TypeScript strict, ESLint + Prettier di seluruh monorepo |
| E2E web | Playwright |
| Test minimum | Coverage domain & application layer (target ditetapkan di TEST_STRATEGY) |
| Logging | JSON, `request_id`, `tenant_id`, `user_id`; tanpa PHI |
| Config | 12-factor; secret dari Secret Manager |

### 3.3 Docker Compose Lokal

`postgres`, `mailpit` (email undangan/reset password), emulator GCS (mis. fake-gcs-server) — semua dengan data sintetis. Login Google di lokal memakai OAuth client khusus dev dengan redirect `http://localhost`.

## 4. Deliverable

| Item | Lokasi |
|---|---|
| Skeleton backend, web, android | backend/, web/, android/ |
| docker-compose.yml | root |
| CI workflows | .github/workflows/ |
| CONTRIBUTING.md, CODING_STANDARDS.md | docs/ |
| TEST_STRATEGY.md | docs/05-testing/ |
| ENVIRONMENTS.md | docs/02-architecture/ |
| STAGE_COMPLETION_REPORT.md | docs/reports/stage-4/ |

## 5. Gate Checklist

- [ ] Clone bersih → satu perintah menjalankan stack lokal.
- [ ] Build reproducible (versi dependency terkunci).
- [ ] Pipeline CI hijau untuk PR & main.
- [ ] Foundation test (tenant context, RLS, audit) lulus di CI.
- [ ] Deploy otomatis ke dev berhasil.
- [ ] Project Owner menyetujui Stage 4.

## 6. Open Decision

- **OD-025** — GitHub Actions vs Cloud Build.
- **OD-026** — Tool SAST/dependency scanning (dependency berbayar perlu persetujuan).
