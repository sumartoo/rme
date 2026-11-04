# Environments — ClinicRME SaaS

| | |
|---|---|
| Versi | 1.0 — Stage 4 |
| Tanggal | 4 November 2026 |
| Terkait | DEPLOYMENT_ARCHITECTURE.md, ADR-0011 (Terraform), SECURITY_CONTROLS SC-CRY-04 |

## 1. Daftar Lingkungan

| Lingkungan | `APP_ENV` | Tempat | Data | Deploy | Status |
|---|---|---|---|---|---|
| Local | `local` | Developer laptop (`pnpm dev`, docker compose) | Synthetic (`dev:seed`) | Manual | ✅ Stage 4 |
| Test / CI | `test` | GitHub Actions + PostgreSQL service | Synthetic, deleted after each run | Every PR | Workflows ready; active once the repo exists |
| Dev | `dev` | GCP `asia-southeast2`, project `clinicrme-dev` | Synthetic | Automatic on merge to `main` | Stage 4 batch 3 (needs GCP project) |
| Staging | `staging` | GCP, separate project | Synthetic or masked; **no real patient data** | Release tag + PO approval | Stage 15 |
| Prod | `prod` | GCP, separate project | Real clinic data | Release tag + PO approval | Stage 15–16 |

Each cloud environment uses a separate GCP project, so there is no IAM or network sharing between dev, staging, and prod.

## 2. Konfigurasi

All configuration comes from environment variables (12-factor) and is validated at startup. Invalid values stop the process, and the error message names the variable but never its value.

| Variabel | Dipakai | Local | Cloud |
|---|---|---|---|
| `DATABASE_URL` | api | `.env` (role `clinicrme_api`, member of `clinicrme_app`, NOBYPASSRLS) | Secret Manager; Cloud SQL IAM user |
| `PLATFORM_DATABASE_URL` | api (platform console) | `.env` (role `clinicrme_platform_api`, member of `clinicrme_platform`) | Secret Manager; separate Cloud SQL IAM user |
| `MIGRATION_DATABASE_URL` | migrate job | `.env` (owner role) | Secret Manager; migration job only |
| `WORKER_DATABASE_URL` | worker | `.env` (owner, OD-074) | Secret Manager; dedicated `pgboss` role (Stage 15) |
| `ENCRYPTION_KEY_HEX` | api | Random from `dev:env` | **Not used.** Data key wrapped by Cloud KMS (Stage 15, SC-CRY-03) |
| `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` | api | Dev OAuth client (optional); redirect URI via the clinic app: `http://demo.localhost:4200/api/v1/auth/google/callback` | Secret Manager; one OAuth client per environment |
| `BASE_DOMAIN` | api | `localhost` (`demo.localhost`; console `admin.localhost`) | `dev.clinicrme.id` · `clinicrme.id` (proposed); console at `admin.<BASE_DOMAIN>` |
| `COOKIE_SECURE` | api | `false` allowed | **Must be `true`** (the app refuses `false`) |
| `STORAGE_DRIVER` / `STORAGE_FS_DIR` / `STORAGE_GCS_ENDPOINT` / `STORAGE_BUCKET_FILES` / `STORAGE_BUCKET_EXPORTS` | api, worker | `fs` → `.data/storage` (or `gcs` + emulator `http://localhost:4443`) | `gcs` (required), private buckets; exports bucket with 7-day lifecycle (Terraform) |
| `EXPORT_TTL_HOURS` | api, worker | `24` | `24` (AC-PLT-FR-008-1) |
| `SMTP_URL` | worker | `smtp://localhost:1025` (Mailpit, inbox at `http://localhost:8025`); empty = sending off | Secret Manager; `smtps://` to the SMTP provider (to be decided before the pilot) |
| `MAIL_FROM` / `CLINIC_URL_TEMPLATE` | worker | `ClinicRME <no-reply@clinicrme.local>` · `http://{code}.localhost:4200` | Verified sender domain · `https://{code}.<BASE_DOMAIN>` |
| `API_INTERNAL_URL` | platform-admin, web (server) | `http://localhost:3000` (default) | Internal Cloud Run URL of the API; never exposed to the browser |
| `LOG_LEVEL` | api, worker | `info` | `info` (prod), `debug` only temporarily |

`NODE_ENV` is not put in `.env`. Nx loads `.env` into every task, and `next build` requires `production`.

## 3. Database & Role

| Role | Jenis | Hak |
|---|---|---|
| `clinicrme_app` | NOLOGIN group | Tenant DML through RLS. No access to partitions, audit tables, or platform tables |
| `clinicrme_api` (local) / IAM user (cloud) | LOGIN | Member of `clinicrme_app` only |
| owner / migrator | LOGIN | Schema owner. Only for migrations (and the worker, temporarily) |
| `clinicrme_readonly` | NOLOGIN | Reporting (Stage 14) |
| `clinicrme_platform` | NOLOGIN | Platform tables only, no clinical tables (Stage 5, CR-0001) |
| `clinicrme_platform_api` (local) / IAM user (cloud) | LOGIN | Member of `clinicrme_platform` only |

## 4. Alur Rilis

```
PR → ci + security green → review → squash merge to main
main → build image → push Artifact Registry → migrate job (dev) → deploy Cloud Run (dev) → smoke test   [batch 3]
tag vX.Y.Z → same image → staging (PO approval) → prod (PO approval)                                       [Stage 15]
```

**Migrations run before the new application version** and must be backward compatible with the previous application version (expand → migrate → contract), so a rollback only swaps the image.
