# Stage 4 — Stage Plan

| | |
|---|---|
| Stage | 4 — Project Foundation & DevOps |
| Status | APPROVED WITH NOTES — 4 Nov 2026 (DEC-023) · [laporan](STAGE_COMPLETION_REPORT.md) |
| Mulai | 4 November 2026 (DEC-020) |
| Project Owner | Sumarto |
| Input | ADR-0001, ADR-0008, ADR-0009, `db/schema/`, `poc/stage-3/` (DEC-019: ditulis ulang, suite e2e jadi uji wajib) |

## 1. Tujuan

Make the repository ready for feature work starting in Stage 5:
- one command runs the local stack;
- builds are reproducible;
- CI checks quality and security on every change;
- the Stage 3 security controls live in the monorepo, not in the PoC.

## 2. Batch

| Batch | Isi | Butuh dari PO | Status |
|---|---|---|---|
| **1 — Monorepo & stack lokal** | **Monorepo:** Nx + pnpm workspace; `apps/api` (NestJS), `apps/worker` (NestJS + pg-boss), `apps/web` (Next.js skeleton); `libs/shared`, `libs/db`, `libs/iam`.<br>**Database:** migrations in `db/migrations/` + migration runner; Drizzle schema introspected from migrated DB.<br>**Local infra:** `docker-compose.yml` (postgres, mailpit, fake-gcs).<br>**Controls moved from PoC:** auth/session/tenant/permission/audit; Stage 3 e2e suite runs here.<br>**New controls:** global Zod pipe + body limit (SC-WEB-05); JSON logging with redaction (SC-LOG-01); API security headers (SC-WEB-01). | — | ✅ 4 Nov 2026 — §5 |
| **2 — CI & standar** | **CI:** GitHub Actions workflows (lint incl. module boundaries, typecheck, unit + integration tests with PostgreSQL, build, migrations on an empty DB, OpenAPI breaking-change check, dependency/secret/SAST scanning).<br>**Build:** Dockerfiles for api/worker/web.<br>**Docs:** `CONTRIBUTING.md`, `CODING_STANDARDS.md`, `TEST_STRATEGY.md`, `ENVIRONMENTS.md`.<br>**Carried over from DATABASE_DESIGN §9 / ADR-0008:** monthly `audit_log` partition job (worker); concurrency test for document numbers; OpenAPI code-first (`@nestjs/swagger`) + diff against `api/openapi.yaml`; `pnpm dev` via docker compose verified in CI. | OD-025, OD-026, OD-071–074 | ✅ 4 Nov 2026 — §6 (CI belum berjalan: repo GitHub belum ada) |
| **3 — Deploy dev** | **Terraform for the dev environment:** Cloud Run api/worker/web, Cloud SQL, Artifact Registry, Secret Manager.<br>**Deploy:** automatic on merge to `main` + smoke test. | GitHub repo (private), GCP project + billing, Google OAuth client (dev) | — |

## 3. Gate Stage 4

- [~] Clone bersih → satu perintah menjalankan stack lokal — semua langkah terbukti kecuali `docker compose up`; job CI `compose` siap, menunggu repo GitHub
- [x] Build reproducible (lockfile, versi Node/pnpm terkunci) — salinan bersih + `--frozen-lockfile`
- [~] Pipeline CI hijau untuk PR & main — workflow `ci` & `security` lolos actionlint; setiap langkahnya dijalankan lokal dan lulus; **belum pernah jalan di GitHub** (repo belum ada)
- [~] Foundation test (tenant context, RLS, audit) + suite e2e Stage 3 lulus — 52/52 lokal + 58 uji SQL; di CI setelah repo ada
- [x] Uji mutasi M1–M4 diulang di monorepo + M5 baru — 5/5 terdeteksi
- [x] Migrasi awal identik secara struktur dengan `db/schema/` (ADR-0009) — diff nol, termasuk grant
- [ ] Deploy otomatis ke dev berhasil
- [x] PO menyetujui Stage 4 — dengan catatan S4-1, S4-2 (DEC-023)

## 4. Open Decision Stage 4

| OD | Pertanyaan | Usulan |
|---|---|---|
| OD-025 | CI/CD: GitHub Actions vs Cloud Build | **GitHub Actions**: PR checks and deploy in one place; deploy to GCP via Workload Identity Federation (no service account keys). Free quota for private repos: 2,000 minutes/month (GitHub Free) |
| OD-026 | SAST & dependency scanning | Free tools only: **gitleaks** (secrets), **osv-scanner** + `pnpm audit` (dependencies), **Semgrep CE** (SAST), **Trivy** (images). CodeQL is not proposed: for private repos it requires a paid GitHub plan |
| OD-071 | Sumber kebenaran skema DB | `db/migrations/` sejak Stage 4; `db/schema/` dibekukan; migrasi yang sudah diterapkan immutable (runner menolak bila isinya berubah) |
| OD-072 | Versi stack | Node 22 LTS, TypeScript 5.9, NestJS 11, Next.js 16, Nx 24, PostgreSQL 16 |
| OD-073 | PostgreSQL untuk uji integrasi | Service container (CI) / docker compose (lokal), bukan Testcontainers |
| OD-074 | Role DB worker | Dev: owner; Stage 15: role khusus pemilik skema `pgboss` |

## 5. Hasil Batch 1 (4 Nov 2026)

Semua pemeriksaan dijalankan dari **salinan bersih** repo (tanpa `node_modules`, `.env`, `dist`) setelah `pnpm install --frozen-lockfile`.

| Pemeriksaan | Hasil | Bukti |
|---|---|---|
| Lint (termasuk module boundaries, larangan `pg` langsung & `sql.raw`) | 0 error, 7 proyek; uji pelanggaran → 3 error tertangkap | [clean_clone_checks](evidence/clean_clone_checks.txt) · [lint_rules](evidence/lint_rules.txt) |
| Typecheck · unit test · build | Lulus; 29 unit test; build api, worker, web | [clean_clone_checks](evidence/clean_clone_checks.txt) |
| Uji integrasi API vs PostgreSQL | **46/46**: suite Stage 3 (33) + fondasi Stage 4 F01–F13 | [integration_tests](evidence/integration_tests.txt) |
| Uji mutasi M1–M4 | **4/4 terdeteksi** | [mutation_tests](evidence/mutation_tests.txt) |
| Uji SQL skema (DB dibangun dari migrasi) | 46 lulus | [db_security_tests](evidence/db_security_tests.txt) |
| Migrasi ≡ `db/schema` | Sama: 90 tabel, 79 policy, 21 fungsi, 203 grant, 81 permission | [schema_parity](evidence/schema_parity.txt) |
| Worker (pg-boss) self-test | Job heartbeat diproses, shutdown bersih | [worker_selftest](evidence/worker_selftest.txt) |
| Stack lokal: `dev:env` → `dev:db` → `dev:seed` → API | readyz OK, login demo, `/me`, 401 seragam, subdomain tak dikenal 404; password & token tidak ada di log | [local_stack_smoke](evidence/local_stack_smoke.txt) |
| `docker-compose.yml` | Valid (`docker compose config`); belum `up` di lingkungan ini | [compose_config](evidence/compose_config.txt) |
| Secret scanning | 0 temuan | [secret_scan](evidence/secret_scan.txt) |

**Temuan selama batch 1:** (1) request id dari header kini disaring agar tidak bisa menyuntik log (F03); (2) Mailpit 1.27 terdampak CVE-2026-21859 → dipakai v1.28.3; (3) otplib 12 membawa sub-dependency usang → evaluasi pengganti di Stage 6; (4) pg-boss 12 hanya ESM — worker diuji lewat bundle hasil build (self-test), bukan Jest.

**Ditunda dengan sengaja:** `libs/ui`, `libs/api-client`, aplikasi `platform-admin` (Stage 5–6, saat ada UI pertama); proxy `/api` dari web ke API dengan penerusan host tenant (Stage 6, login UI); skema TypeScript Drizzle hasil introspeksi (Stage 5).

## 6. Hasil Batch 2 (4 Nov 2026)

All checks were re-run from a **clean copy** of the repo.

| Pemeriksaan | Hasil | Bukti |
|---|---|---|
| Lint · typecheck · build | 0 errors | [clean_clone_checks](evidence/clean_clone_checks.txt) |
| Unit tests | **41** (incl. 5 OpenAPI contract tests) | [clean_clone_checks](evidence/clean_clone_checks.txt) |
| API integration tests | **52/52**: E (Stage 3) 33 · F (foundation) 15 · C (concurrency) 4 | [integration_tests](evidence/integration_tests.txt) |
| SQL schema tests | **58** (incl. T25–T26 for migration 0002) | [db_security_tests](evidence/db_security_tests.txt) |
| Mutation tests | **5/5 caught** (M5 new) | [mutation_tests](evidence/mutation_tests.txt) |
| Baseline migrations ≡ `db/schema` | Identical | [schema_parity](evidence/schema_parity.txt) |
| Worker: heartbeat, audit partitions, hash-chain verification | Pass; tampering detected (job fails at `seq 2`) | [worker_selftest](evidence/worker_selftest.txt) · [audit_chain_job](evidence/audit_chain_job.txt) |
| OpenAPI contract | 5/5; caught `mfa/enroll` 201 ≠ 200 (fixed) | [contract_test](evidence/contract_test.txt) |
| Production image (content simulation) | migrate.js + API readyz OK, non-root, 62 MB of dependencies | [image_simulation](evidence/image_simulation.txt) |
| Dependency audit (production, high+) | 0 after fixing 2 high findings | [dependency_audit](evidence/dependency_audit.txt) |
| Semgrep project rules | 6 rules, 9/9 positive cases + 6/6 negative cases; code: 0 findings | [semgrep](evidence/semgrep.txt) |
| Secret scanning (detect-secrets + gitleaks) | 0 | [secret_scan](evidence/secret_scan.txt) |
| Workflow CI (actionlint + shellcheck) | 0 issues; actions pinned to SHA | [ci_workflows](evidence/ci_workflows.txt) |

### Temuan & perbaikan

1. **[Keamanan] App role could read audit across tenants and insert audit entries directly into the partition.**
   - Cause: in `900_security.sql`, `GRANT … ON ALL TABLES` also applies to the `audit_log_default` partition. `REVOKE` on `audit_log` only touches the parent table, and partitions have no RLS.
   - Proof before the fix: without tenant context, the app role read 4 audit rows through the partition and inserted a forged row.
   - Fix: migration 0002 revokes every grant on partitions (including future ones).
   - Guarded by: T25/T26g, F14, mutation M5, and risk RSK-022.
2. **[Keamanan] 2 high vulnerabilities in production dependencies.**
   - zod (memory exhaustion on large arrays) → 4.6.7, plus a Semgrep rule requiring `z.array().max()`.
   - multer (DoS) → override `^2.5.0`.
3. **[Keamanan] Supply-chain compromise of `trivy-action` (March 2026).**
   - Trivy is not used (DEC-022, awaiting PO).
   - Actions are pinned to SHAs and binaries are verified by sha256.
   - Risk recorded as RSK-021.
4. **[Kontrak]** `POST /auth/mfa/enroll` returned 201, while the contract says 200. Fixed.
5. **[Build] Production image would have crashed.**
   - pg, drizzle-orm, jose, and otplib were devDependencies, and the root `package.json` carried next/react (538 MB).
   - Fixed, and `check_bundle_deps.mjs` was added to CI.
6. **[Zod 4] `.default()` no longer runs the transform**, so `COOKIE_SECURE` became the string `"true"`. Caught by unit tests; fixed with `.prefault()`.
7. **[Stage 4 items carried over from the design]**
   - Monthly `audit_log` partitions → `ensure_audit_partitions` + daily job.
   - Daily hash-chain verification (SC-AUD-03).
   - Concurrency test for document numbers: 50 parallel transactions, unique and gapless, including rollbacks.

### Deviasi yang perlu diketahui PO

| Item | Rencana | Implementasi | Alasan |
|---|---|---|---|
| Worker | NestJS standalone (ADR-0001) | Node + pg-boss without Nest DI | Not needed yet. Nest DI is added once jobs need domain modules (Stage 9) |
| OpenAPI | Code-first `@nestjs/swagger` (ADR-0008) | The design-first contract stays the source; a test enforces implementation ≡ contract | Only 10 endpoints exist so far. Code-first generation is evaluated in Stage 5 |
| Image scanning | Trivy (OD-026) | osv-scanner | Trivy compromise (DEC-022) |
| Integration DB | Testcontainers (Stage 4 doc) | PostgreSQL service container | OD-073 |
| `CONTRIBUTING.md` | `docs/` | repo root | GitHub convention (shown on the PR page) |

### Belum dapat dibuktikan di lingkungan build

These need a GitHub repo or open container registries:
- `docker compose up`
- `docker build` with base images
- Running the CI workflows
- Public Semgrep rulesets (semgrep.dev)
- osv-scanner queries (api.osv.dev)

All of them already have CI jobs and become active once the repo is created.

