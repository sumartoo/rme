# Coding Standards — ClinicRME SaaS

| | |
|---|---|
| Versi | 1.0 — Stage 4 |
| Tanggal | 4 November 2026 |
| Berlaku | Seluruh kode di `apps/`, `libs/`, `db/`, `tools/` |

The rules marked **[otomatis]** are enforced by lint, tests, or startup checks. Anything that breaks them fails CI or the application refuses to start. The rest are checked in code review.

## 1. Stack & Versi

| | Versi | Catatan |
|---|---|---|
| Node.js | 22 LTS (`.nvmrc`) | |
| pnpm | 10 (`packageManager` in `package.json`) | `pnpm install --frozen-lockfile` in CI |
| TypeScript | 5.9, `strict` | |
| NestJS | 11 | |
| Next.js | 16 | |
| Nx | 24 | |
| Zod | 4 | |
| PostgreSQL | 16 | |
| Drizzle ORM | 0.45 | |
| pg-boss | 12 | |

**Upgrading a major version** requires: an entry in DECISION_LOG, all CI tests passing, and the mutation tests re-run.

## 2. Struktur & Batas Modul

| Tag | Isi | Boleh bergantung pada |
|---|---|---|
| `type:app` | `apps/api`, `apps/worker`, `apps/web` | feature, data, util, ui |
| `type:feature` | `libs/iam`, `libs/patient`, … (one per business module) | data, util — **not another feature** |
| `type:data` | `libs/db` | util |
| `type:util` | `libs/shared` | util |
| `scope:web` | web app | ui / web only — never server libraries |

**Rules:**
- **[otomatis]** These boundaries are checked by `@nx/enforce-module-boundaries`.
- Communication between feature modules goes through the **outbox/event** (ADR-0004) or an interface in `libs/shared`, not through direct imports.
- New library: `pnpm nx g @nx/nest:lib libs/<nama> --tags=type:feature,scope:<nama>`. Then add tests and a README.

## 3. API (NestJS)

1. **[otomatis]** Every handler must declare access with exactly one of:
   - `@RequirePermission('<code>')`
   - `@Authenticated()` (session only)
   - `@Public()` (login/OAuth)
   - `@Infra()` (health)

   An undeclared handler stops the application from starting (SC-AUTHZ-01).
2. **[otomatis]** Every POST/PUT/PATCH/DELETE must have `@BodySchema(zodSchema)` or `@NoBody()`. Bodies are parsed by the global interceptor; undeclared fields are dropped (SC-WEB-05).
3. **[otomatis]** Every `z.array()` must have a `.max(n)` (Semgrep `crme-zod-array-without-max`; GHSA-mrhx-c7xc-m3w5). Strings get a reasonable `.max()`.
4. **[otomatis]** Endpoints must match `api/openapi.yaml`: path, method, `x-permission`, success status, and body (contract test `openapi-contract.spec.ts`). New endpoints are added to the contract first.
5. **Tenant & user come only from `ctx()`** (session), never from body/query/header. **[otomatis]** Semgrep `crme-tenant-from-request`.
6. Errors are `throw problem(status, 'MODUL-STATUS-KODE', 'Judul untuk pengguna')`:
   - the code is stable, and the title contains no internal details;
   - another tenant's resource → **404**, not 403.
7. Patient record reads and every data change are audited with `audit(tx, ...)` in the same transaction. **Failure** audits (rejected logins, wrong MFA) go in a **separate transaction** that commits before the error is thrown; otherwise the record is rolled back (Stage 3 finding E04).

## 4. Database

1. **[otomatis]** Only `libs/db` may import `pg` / `drizzle-orm/node-postgres`. Every query goes through `Db.withTenantTx` (tenant from session, fail-closed). `withTenant` is only for pre-login flows; `preAuth` is only for narrow `SECURITY DEFINER` functions.
2. **[otomatis]** No `sql.raw`. Use the ``sql`...` `` template (parameterised) and `sql.identifier()` for object names (SC-WEB-04).
3. Schema changes = a **new migration** `db/migrations/NNNN_<deskripsi>.sql` + an entry in `meta/_journal.json`.
   - **[otomatis]** Already-applied migrations must not be edited (the runner rejects a changed hash).
   - `db/schema/` is frozen as the Stage 2–3 design (OD-071).
4. A new table with `tenant_id` must have:
   - RLS `ENABLE` + `FORCE` + policy `tenant_isolation` (T06);
   - a composite FK `(tenant_id, id)`;
   - grants in the same migration;
   - a SQL test in `db/tests/020_migration_tests.sql`.
5. Partitions are never granted to application roles: RLS only applies through the parent table (Stage 4 finding, migration 0002).
6. Money uses `numeric`, never JS `Number` (ADR-0001 — `Money` type in Stage 11).

## 5. Keamanan & Data

**Allowed values:**
- Only synthetic data in every non-production environment.
- **[otomatis]** No secrets in the repo (gitleaks + detect-secrets). Synthetic test values are marked `pragma: allowlist secret`.
- Randomness for tokens comes from `randomToken()` (`node:crypto`). **[otomatis]** No `Math.random()` outside tests.

**Logging:**
- **[otomatis]** Don't log request bodies or whole domain objects (Semgrep `crme-no-log-request-body`).
- The logger already redacts passwords, tokens, cookies, NIK, and SOAP, but only at the top level or one level deep. Nested objects are not protected.

**Web:**
- **[otomatis]** No `dangerouslySetInnerHTML` (SC-WEB-03).
- CSP is nonce-based; don't add `'unsafe-inline'` or `'unsafe-eval'` for production.

**Dependencies:**
- A new dependency must have a stated reason in the PR.
- Paid dependencies require PO approval.
- **[otomatis]** CI fails if production dependencies have high/critical vulnerabilities.
- Every runtime package must be in the **application's** `package.json` (`tools/check_bundle_deps.mjs`).

## 6. Gaya Kode

- ESLint + Prettier (`printWidth` 140, single quotes). Run `pnpm lint` before pushing.
- Names: classes `PascalCase`, files `kebab-case.ts`, DB columns `snake_case`, permission codes `modul.resource.aksi`.
- Code comments may be Indonesian or English. Error messages for users are in **Indonesian**.
- Comment the **why**, not the what. Every security control in code mentions its control ID (`SC-…`) or requirement ID.

## 7. Git & Review

See [CONTRIBUTING.md](../CONTRIBUTING.md).
