# PoC Stage 3 — Autentikasi, Sesi, Isolasi Tenant & Otorisasi

> **ARSIP — digantikan sejak Stage 4.** Kode aktif ada di `libs/iam`, `libs/db`, `libs/shared`, `apps/api`; suite uji ini dipindah utuh ke `apps/api/test-integration/security.e2e-spec.ts` (DEC-019). Folder ini tidak lagi dipelihara dan tidak termasuk workspace pnpm/Nx.

> **Status:** Proof of Concept for the Stage 3 gate (Security & Privacy Foundation). **This is not production code.** In Stage 4 these modules are moved into the Nx monorepo (`apps/api`, `libs/iam`, `libs/db`) with proper structure, logging, and observability.
> No real patient data is used. All data is synthetic.

## What is proven

| Area | Control | Test |
|---|---|---|
| Password login | Argon2id (m=19456, t=2), uniform error responses, lockout 5×/15 min, failures audited | E01–E04 |
| Session | 256-bit token, only the sha256 hash stored in the DB; cookie HttpOnly/Secure/SameSite=Lax; idle 30 min; absolute 12 h | E01, E02, E18 |
| Session revocation | Disabling a user immediately revokes all of their sessions | E19 |
| MFA TOTP | Required for roles with `requires_mfa`; secret encrypted with AES-256-GCM; recovery codes single-use; 5 wrong codes → session revoked; session ID rotated when MFA is verified | E07–E09, E14b, E32 |
| Tenant isolation | Tenant from subdomain; session bound to tenant; RLS fail-closed; other tenants' data → 404 | E05, E06, E10–E13 |
| Authorization | Deny-by-default; endpoints without an access declaration → app **refuses to start** | E14–E16 |
| CSRF | Double-submit cookie + `X-CSRF-Token` header on non-GET requests | E17 |
| Audit | Patient record READ logged with `patient_id` + `request_id`; hash chain stays valid | E20 |
| Google Sign-In | Auth Code + PKCE S256, state, nonce, minimum scope; invitation required; linked by `sub` (no auto-link by email); id_token verified (iss/aud/signature/nonce/email_verified) | E21–E31 |

Google is simulated by a **mock IdP** (`test/mock-idp.ts`) that issues its own JWKS and enforces PKCE. This lets the negative cases (foreign key, wrong audience, nonce, unverified email) be tested without contacting Google.

## Prerequisites

- Node.js ≥ 20
- PostgreSQL 16, with superuser access to a **test database that may be wiped** (the tests drop and rebuild the `app` schema)

## How to run

```bash
cd poc/stage-3
npm ci
# REPO_ROOT points to the repo root (contains db/schema, db/seed, db/tests)
REPO_ROOT=../.. PGHOST=localhost PGPORT=5432 PGDATABASE=clinicrme_test \
PGSUPERUSER=postgres PGPASSWORD=... npm test
npm run build   # type-check only (tsc --noEmit)
```

Test setup (`test/db-setup.ts`):
1. Loads `db/schema/*.sql` + `db/seed/*.sql` + `db/tests/001_seed.sql`.
2. Creates a `crme_poc_app` LOGIN role that only inherits `clinicrme_app` (NOBYPASSRLS, not the owner).
3. Creates synthetic users: `admin@a.test` (TENANT_ADMIN, requires MFA), plus a custom `GUDANG` role (only `pharmacy.stock.read`).

The app connects as `crme_poc_app`. All queries go through `Db.withTenant()`, which runs `set_config('app.tenant_id', …, true)` inside a transaction. Without it, RLS returns nothing / rejects the query.

## Structure

```
src/
  config.ts           config from env (session timeouts, lockout, keys, OIDC)
  context.ts          AsyncLocalStorage per request (tenant, user, request_id)
  db.ts               pg pool + Drizzle; withTenant / preAuth; audit helper
  crypto.ts           random token, sha256, AES-256-GCM, HMAC, PKCE
  decorators.ts       @Public, @Authenticated, @RequirePermission, @AllowWithoutMfa
  session.service.ts  create/resolve/validate/revoke sessions
  auth.service.ts     password, MFA, Google OIDC
  guards.ts           ContextMiddleware (tenant from subdomain) + SecurityGuard (global)
  controllers.ts      /auth/*, /me, /patients, /users/:id/disable
  app.module.ts       bootstrap + assertAllRoutesDeclareAccess
test/
  mock-idp.ts         OIDC provider simulator
  db-setup.ts         DB reset + synthetic data
  security.e2e.spec.ts  33 security tests (E01–E32, E14b)
```

## Order of checks in `SecurityGuard`

1. `@Public` → pass (login, OIDC callback)
2. Handler without any access declaration → 403 (and caught at bootstrap)
3. Resolve session from cookie → check tenant = subdomain, not revoked, not expired, not idle, user active
4. CSRF on non-GET methods
5. Set the request context (tenant, user, branch)
6. Load permissions for the user's roles in the active branch
7. Role requires MFA and session not yet MFA-verified → 401 `MFA_REQUIRED` (unless `@AllowWithoutMfa`)
8. `@RequirePermission(x)` → 403 if not held

## Lessons learned from the tests

- **Bug found by E04:** lockout counters and the `LOGIN_FAILED` audit entry were initially written inside the same transaction that then threw the exception. They were **rolled back**, so the lockout never triggered. The fix records failures in a separate transaction (`recordFailure`) that commits before the error is returned. The same bug class was then found in `MFA_FAILED` while matching controls, and fixed. The same pattern is applied to the Google denial path. **Rule for Stage 4+:** security audit events for failures must not share a transaction with the operation being rejected.
- Mutation tests (see `docs/reports/stage-3/evidence/poc_mutation_tests.txt`):
  - Removing the session tenant check makes E12 fail.
  - Giving the app role `BYPASSRLS` makes E05/E10/E11/E13 fail.
  - Loosening the MFA attempt limit makes E32 fail.
  - Removing session rotation on MFA makes E08 fail.

  The tests really do guard these controls.

## Known PoC limitations (addressed in Stage 4+)

- Rate limiting per IP at the edge is not implemented (only per-account lockout and MFA attempt limit per session).
- The encryption key comes from env (`ENCRYPTION_KEY_HEX`); production uses envelope encryption with Cloud KMS + Secret Manager (SC-CRY-03/04).
- There is no Next.js UI yet; tests call the API directly with supertest.
- Branch switching (SC-AUTHZ-02 is only tested for a single branch), step-up re-auth for sensitive actions, break-glass, password policy (minimum length / common passwords), and session revocation on password change / MFA reset are not implemented.
