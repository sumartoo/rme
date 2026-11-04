# ClinicRME SaaS

Multi-tenant electronic medical record (RME) for Indonesian clinics. Documentation, decisions, and per-stage plans are in [docs/README.md](docs/README.md).

> All data in this repository is **synthetic**. Do not put real patient data in dev/test environments.

## Requirements

| Tool | Version |
|---|---|
| Node.js | 22 LTS (≥ 22.12, see `.nvmrc`) |
| pnpm | 10 (`corepack enable`) |
| Docker | Docker Desktop / Engine with Compose v2 |

## Quick start (clean clone)

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` does the following:
1. Creates `.env` with random secrets (`dev:env`). An existing `.env` is never overwritten; keys added in later stages (e.g. `PLATFORM_DATABASE_URL`) are appended.
2. Starts Postgres, Mailpit and the GCS emulator (`dev:infra`).
3. Runs migrations and creates the API and platform-console login roles (`dev:db`).
4. Fills the synthetic **demo** tenant (`dev:seed`).
5. Runs the API, worker and web app.

| Service | Address |
|---|---|
| API (tenant `demo`) | http://demo.localhost:3000 — e.g. `POST /api/v1/auth/login` |
| Platform console (UI) | http://localhost:4300 — login `admin@platform.test` |
| Platform console API | http://admin.localhost:3000 — e.g. `POST /api/platform/v1/auth/login` |
| API health | http://localhost:3000/healthz · `/readyz` |
| Clinic app (tenant `demo`) | http://demo.localhost:4200 — login `admin@demo.test` (TOTP on first login); profile & data export under `/admin` |
| Mailpit (all local email: tenant admin invitations, break-glass notices) | http://localhost:8025 |

**Already running PostgreSQL on port 5432?** Either change `POSTGRES_PORT` (and the port in both database URLs) in `.env`, or disable the container and use your own PostgreSQL 16 with a `docker-compose.override.yml` (not committed):

```yaml
services:
  postgres:
    profiles: ["docker-db"]
```

In that case, create a superuser login role matching `POSTGRES_OWNER_USER`/`POSTGRES_OWNER_PASSWORD` and the `POSTGRES_DB` database yourself before `pnpm dev`.

Demo accounts are `admin@demo.test`, `dokter@demo.test`, `perawat@demo.test`, `pendaftaran@demo.test` and `kasir@demo.test`. The password is `DEV_SEED_PASSWORD` in `.env`. `admin@demo.test` and `dokter@demo.test` must enroll TOTP on first login (doctor MFA is on by default, DEC-019; the clinic admin can turn it off under Role & izin).
The platform console account is `admin@platform.test` (same password); TOTP is mandatory and is enrolled on first login (`POST /api/platform/v1/auth/mfa/enroll`, then `.../mfa/verify`).

## Common commands

| Command | Purpose |
|---|---|
| `pnpm lint` · `pnpm typecheck` · `pnpm test` | Lint (including module boundaries), type check, unit tests |
| `pnpm test:integration` | API security + foundation tests against real PostgreSQL. Needs `TEST_PG_ADMIN_URL` (superuser URL to the `postgres` database) |
| `pnpm test:db` | SQL schema tests (RLS, immutability, audit chain) on a DB built from migrations |
| `pnpm check:schema` | Migrations ≡ the `db/schema` design (ADR-0009). Needs `PG_ADMIN_URL` |
| `node tools/export/decrypt-export.mjs <file.crmex> <key> <dir>` | Open a tenant data export (key from `GET /api/v1/tenant/exports/{id}/key`) |
| `pnpm dev:reset-mfa <email>` | Local only: remove a platform user's TOTP (e.g. QR never scanned), revoke their sessions and unlock; next login asks to enroll again |
| `pnpm test:e2e` | Playwright tests of the platform console in Chromium (builds API + console; needs `TEST_PG_ADMIN_URL`; first time: `pnpm exec playwright install chromium`) |
| `pnpm test:mutation` | Breaks the security controls on purpose (M1–M9) and checks that the tests catch it |
| `pnpm db:migrate` | Apply migrations (`MIGRATION_DATABASE_URL` = schema owner role) |
| `pnpm build` | Build api, worker, web |
| `docker build -f docker/node-app.Dockerfile --build-arg APP=api .` | Production image for api (also `APP=worker`; web: `docker/web.Dockerfile`) |
| `pnpm dev:down` | Stop the local infrastructure |

## Contributing

Workflow, commits and review: [CONTRIBUTING.md](CONTRIBUTING.md) · coding standards: [docs/CODING_STANDARDS.md](docs/CODING_STANDARDS.md) · test strategy: [docs/05-testing/TEST_STRATEGY.md](docs/05-testing/TEST_STRATEGY.md).

## Structure

```
apps/api        NestJS API (modular monolith)            apps/worker   NestJS + pg-boss (asynchronous jobs)
apps/web        Next.js (UI only, no DB access)
libs/shared     config, context, crypto, error format, decorators (type:util)
libs/db         the only gateway to the DB + migration runner (type:data)
libs/iam        auth, sessions, tenant, global guard (type:feature)
libs/patient    patient (minimal endpoints; Stage 8) (type:feature)
db/migrations   source of truth for the DB schema from Stage 4 · db/schema = Stage 2–3 design (frozen)
db/tests        SQL security tests          api/openapi.yaml   Stage 2 API contract
docs/           requirements, architecture, security, stage reports
tools/          documentation generators, schema/mutation/bundle checks, dev scripts
docker/         Dockerfiles for api/worker/web (distroless, non-root)
.github/        CI & security workflows, Dependabot, PR template
.semgrep/       project SAST rules + their test files
poc/stage-3     Stage 3 PoC (archive; replaced by apps/ + libs/)
```

Module boundaries are enforced by lint:
- an app can use feature/data/util libraries;
- a feature library cannot import another feature library;
- only `libs/db` may import `pg`;
- `sql.raw` is forbidden.
