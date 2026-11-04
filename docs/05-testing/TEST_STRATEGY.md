# Test Strategy — ClinicRME SaaS

| | |
|---|---|
| Versi | 1.0 — Stage 4 |
| Tanggal | 4 November 2026 |
| Terkait | NFR.md, SECURITY_CONTROLS.md, ACCEPTANCE_CRITERIA.md |

## 1. Prinsip

1. **Security controls are tested end to end against real PostgreSQL**, not mocks. RLS, grants, and triggers are only proven in the database.
2. **The tests themselves are tested.** For the main controls, mutation tests break the control on purpose. The tests that guard that control must fail; if they don't, the test is too weak.
3. **The contract wins.** Implementation is checked against `api/openapi.yaml`, which was approved in Stage 2.
4. **Synthetic data only.** Every test DB is built from migrations (the same path as production) and wiped after use.
5. Everything here runs in CI on every PR. A merge requires everything green.

## 2. Lapisan Uji

| Lapisan | Alat | Lokasi | Perintah | Isi |
|---|---|---|---|---|
| Unit | Jest + SWC | `**/*.spec.ts` | `pnpm test` | Pure logic: config, crypto, redaction, error format, session rules, job registry, CSP |
| Kontrak API | Jest | `apps/api/src/app/openapi-contract.spec.ts` | `pnpm test` | Every route ↔ path/method/permission/status/body in `api/openapi.yaml` |
| Integrasi API | Jest + supertest + PostgreSQL | `apps/api/test-integration/*.e2e-spec.ts` | `pnpm test:integration` | HTTP → guard → service → RLS. **E##**: Stage 3 security suite; **F##**: foundation; **C##**: concurrency; **P##**: platform console (Stage 5); **K##**: clinic admin — profile & data export; **B##**: break-glass support access; **N##**: email notifications (outbox); **I##**: clinic IAM administration (Stage 6); **X01**: permission matrix — every contract operation with `x-permission` called directly by a user without it → 403 (AC-IAM-FR-011-1) |
| SQL skema | psql | `db/tests/0*.sql` | `pnpm test:db` | **T##**: RLS, immutability, stock, billing, audit chain, SoD, partitions, platform role separation, tenant status, quotas |
| Kesetaraan skema | pg_dump | `tools/check_schema_parity.sh` | `pnpm check:schema` | Baseline migrations ≡ `db/schema` design |
| Mutasi | bash | `tools/run_mutation_tests.sh` | `pnpm test:mutation` (`MUTATION_E2E=1` untuk M10) | M1–M17 must be caught (`MUTATION_ONLY="M16 M17"` runs a subset) |
| Worker | build + PostgreSQL | `apps/worker` | `WORKER_SELFTEST=1 node apps/worker/dist/main.js` | pg-boss, heartbeat job, audit partitions |
| Stack lokal | docker compose | CI job `compose` | `pnpm dev:setup` + curl | Clean clone → login demo |
| Image | Docker | CI job `images` | — | Build, migrate, run API/web/worker, non-root user |
| Statis & keamanan | ESLint, Semgrep, gitleaks, pnpm audit, osv-scanner | `.github/workflows/security.yml` | — | Module boundaries, project SAST rules, secrets, dependencies |
| E2E web | Playwright (Chromium) | `apps/platform-admin/e2e/*.e2e.ts`, `apps/web/e2e/*.e2e.ts` | `pnpm test:e2e` (`TEST_PG_ADMIN_URL`) | **U##**: platform console in a real browser — login, TOTP, tenants, status, flags, roles, break-glass, CSP. **W##**: clinic app at `klinik-web.localhost` — login, TOTP, clinic profile (If-Match), data export end to end (real worker → download → decrypt), role limits, CSP & proxy; Stage 6: dynamic side menu & active branch, invite → accept with password, custom roles & per-role MFA, forgot/reset password, sessions & devices, disable/enable users |

## 3. Uji Mutasi (RSK-020)

| ID | Kontrol yang dirusak | Uji yang wajib gagal |
|---|---|---|
| M1 | Session tenant check vs subdomain | E12 |
| M2 | App role given `BYPASSRLS` | E05, E10, E11, E13, F14 |
| M3 | MFA attempt limit | E32 |
| M4 | Session rotation after MFA | E08 |
| M5 | Revocation of grants on audit partitions (migration 0002) | F14 |
| M6 | Platform DB role granted SELECT on clinical tables | P15 |
| M7 | Clinic guard no longer blocks sessions of a SUSPENDED tenant | P12 |
| M8 | Platform guard no longer requires MFA | P01 |
| M9 | User quota trigger removed from migration 0003 | P16 |
| M10 | Console pages rendered statically (CSP nonce lost → scripts blocked) | U01 |
| M11 | Tenant export reads without `SET ROLE clinicrme_app` (owner connection bypasses RLS) | K05 |
| M12 | Break-glass functions no longer check the grant's validity window | B06 |
| M13 | A session without MFA may re-enroll TOTP (overwrites the secret) | E33 |
| M14 | RLS on `tenant_feature_flag` not enabled (migration 0006) | K10 |
| M15 | TOTP anti-replay disabled (same code accepted twice) | E34 |
| M16 | Privilege-escalation guard disabled | I04 |
| M17 | Password reset token reusable | I06 |

**Adding a new mutation:** every new security control from Stage 5 onward gets one mutation in `tools/run_mutation_tests.sh`.

## 4. Data Uji

| Data | Sumber | Isi |
|---|---|---|
| Integration tests | `db/tests/001_seed.sql` + `apps/api/test-integration/support/db-setup.ts` | Tenants A & B, synthetic users per role, patients, platform users `admin@platform.test` / `support@platform.test` |
| Local dev | `pnpm dev:seed` | `demo` tenant (refused outside `APP_ENV=local`) |
| Passwords & keys | Synthetic; the app and platform DB role passwords are random per run | — |

## 5. Target & Gerbang

| Lapisan | Gerbang merge |
|---|---|
| Lint, typecheck, build | 0 errors |
| Unit, contract, integration, SQL, parity, mutation, worker | 100% pass |
| `pnpm audit --prod --audit-level high` | 0 findings |
| Semgrep (project rules + public rulesets) | 0 findings, or a justified `nosemgrep` |
| gitleaks | 0 findings |

**Coverage:** no global percentage target. Every requirement with an acceptance criterion in `ACCEPTANCE_CRITERIA.md` must have a test that mentions its AC ID (checked in the RTM from Stage 5).

**Performance:** NFR performance tests run in Stage 15, at target volume.

**Penetration test:** an independent pentest before go-live (Stage 16).
