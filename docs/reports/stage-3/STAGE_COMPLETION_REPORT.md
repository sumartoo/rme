# Stage 3 — Stage Completion Report

| | |
|---|---|
| Stage | 3 — Security, Privacy & Compliance Foundation |
| Status | **APPROVED** — 4 Nov 2026 |
| Tanggal | 4 November 2026 |
| Disusun oleh | Sumarto (dibantu Claude) |

## 1. Ringkasan

The core security and privacy controls have been **designed, documented, and proven in running code** against a real PostgreSQL 16 database. No clinical data has been stored yet.

| Metrik | Nilai |
|---|---|
| Ancaman (STRIDE) | 28; all 9 threats with score ≥ 15 have controls |
| Kontrol keamanan | 63: 17 terbukti penuh · 15 terbukti sebagian (sisanya terjadwal) · 2 diimplementasi sebagian tanpa bukti · 29 terjadwal ke stage tujuan |
| Permission / role | 81 permission · 8 role tenant + 2 role platform; SoD checked automatically |
| Uji skema & seed | **46 lulus, 0 gagal** |
| Uji e2e PoC (HTTP → guard → PostgreSQL RLS) | **33 lulus, 0 gagal** |
| Uji mutasi (kontrol sengaja dirusak) | **4 / 4 terdeteksi** |
| Secret scanning | 0 temuan (2 password uji sintetis di-allowlist secara eksplisit) |
| Bug keamanan ditemukan oleh uji & sudah diperbaiki | 3 (lihat §4) |

## 2. Deliverable

| Deliverable | Lokasi |
|---|---|
| Threat model (STRIDE) | `docs/03-security/THREAT_MODEL.md` |
| Security controls catalogue v0.2 | `docs/03-security/SECURITY_CONTROLS.md` |
| Permission matrix (dibangkitkan) | `docs/03-security/PERMISSION_MATRIX.md`, `db/seed/role_templates.yaml`, `db/seed/010_permissions_roles.sql` |
| Audit policy | `docs/03-security/AUDIT_POLICY.md` |
| Privacy & PDP (UU 27/2022, PP 33/2026) + outline DPA | `docs/03-security/PRIVACY_AND_PDP.md` |
| Data retention policy | `docs/03-security/DATA_RETENTION_POLICY.md` |
| HIPAA Security Rule gap assessment (reference, not a compliance claim) | `docs/03-security/HIPAA_GAP_ASSESSMENT.md` |
| Incident response plan | `docs/03-security/INCIDENT_RESPONSE_PLAN.md` |
| PoC auth, sesi, isolasi tenant, otorisasi, audit | `poc/stage-3/` (+ `README.md` cara menjalankan) |
| Bukti uji | `docs/reports/stage-3/evidence/` |

## 3. Perubahan File (batch 3)

- **Added:**
  - `poc/stage-3/` (10 source files, 3 test files, config, README)
  - `db/schema/025_auth_functions.sql` (`resolve_tenant`, `resolve_session`, both `SECURITY DEFINER`)
  - Evidence: `poc_e2e_tests.txt`, `poc_mutation_tests.txt`
- **Changed — schema:** `db/schema/020_iam.sql`: `user_session.token_hash` (stores the token hash, not the token) and `user_session.mfa_failed_attempts`.
- **Changed — docs:**
  - `SECURITY_CONTROLS.md`: statuses updated from PoC evidence; added the SC-FIN section.
  - `DATABASE_DESIGN.md`: row for 025.
  - `DATA_DICTIONARY.md`: regenerated.
  - `RISK_REGISTER.md`: added RSK-020.
  - `STAGE_PLAN.md`: gate updated.
- **Consistency fix:** `THREAT_MODEL.md` referenced `SC-FIN-01..04` (T-11, T-12), but those controls were missing from the catalogue. Found by an automated reference check; they have now been added.
- **Migration:** none yet. The schema changes are still in the initial DDL, which becomes the first Drizzle migration in Stage 4.

## 4. Bukti Pengujian

| Area | Uji | Hasil |
|---|---|---|
| Password: Argon2id, uniform responses, lockout 5×, failures audited | E01–E04 | Lulus |
| Session: HttpOnly/Secure/SameSite, token stored only as hash, idle 30 min, rotation on MFA | E01, E02, E08, E18 | Lulus |
| MFA TOTP: required for admin, secret encrypted, recovery code single-use, 5 wrong codes → session revoked | E07–E09, E14b, E32 | Lulus |
| Tenant isolation via API: login and session bound to subdomain, other tenants' data → 404, RLS fail-closed | E05, E06, E10–E13, E30 | Lulus |
| Authorization deny-by-default: app refuses to start if any endpoint lacks an access declaration | E14–E16 | Lulus |
| CSRF double-submit | E17 | Lulus |
| Disabling a user revokes all sessions immediately | E19 | Lulus |
| Medical record READ audited with `patient_id` + `request_id`; hash chain valid | E20 | Lulus |
| Google Sign-In: PKCE S256/state/nonce, invitation required, linked by `sub`, rejects wrong state/nonce/aud/key/email_verified, no auto-link by email | E21–E31 | Lulus |
| Skema: isolasi, immutability, stok, billing, audit chain, SoD | T01–T24 | 46 lulus |

Evidence: [poc_e2e_tests.txt](evidence/poc_e2e_tests.txt) · [poc_mutation_tests.txt](evidence/poc_mutation_tests.txt) · [db_security_tests.txt](evidence/db_security_tests.txt) · [permission_matrix_check.txt](evidence/permission_matrix_check.txt) · [secret_scan.txt](evidence/secret_scan.txt)

**Uji mutasi** — each control was deliberately broken and the suite re-run. Its tests must fail:

| Mutasi | Uji yang gagal |
|---|---|
| M1 Session tenant vs subdomain check removed | E12 |
| M2 App DB role given `BYPASSRLS` | E05, E10, E11, E13 |
| M3 MFA attempt limit loosened | E32 |
| M4 Session rotation on MFA removed | E08 |

**Bugs found by the tests and fixed:**
1. **Lockout never triggered (E04).**
   - Cause: the attempt counter and the `LOGIN_FAILED` audit entry were written in the same transaction that then threw the error, so both were rolled back.
   - Fix: failures are recorded in a separate transaction.
2. **`MFA_FAILED` audit lost** — same class of bug as #1, found while checking control status against the code.
   - Fix: same pattern as #1, and E08 now asserts the audit entry.
3. **No MFA attempt limit and no session rotation on MFA.** SC-AUTH-05/06 required both, but the implementation had neither.
   - Fix: both added and tested by E32 and E08.

**Rule for Stage 4+ (into the coding guide):** audit/security counters for failures must never share a transaction with the operation being rejected.

**Not yet proven (scheduled):**

| Item | Stage |
|---|---|
| Per-IP rate limit | 4/15 |
| Password policy (length / common passwords) | 6 |
| Revoke sessions on password change / MFA reset | 6 |
| Multi-branch permissions (SC-AUTHZ-02) | 6 |
| Testing against real Google | 6 |
| Global Zod pipe + body size limit | 4 |
| Log redaction | 4 |
| Cloud KMS | 15 |
| Independent pentest | 16 |

## 5. Keputusan yang Dibutuhkan dari Project Owner

| # | Keputusan | Usulan | Ref |
|---|---|---|---|
| 1 | CMEK untuk Cloud SQL & GCS | Not in the MVP (Google default encryption + column encryption for NIK/TOTP via Cloud KMS); re-evaluate for enterprise tenants | OD-011 |
| 2 | Masa simpan audit log | Medical record access audit = medical record retention (≥ 25 years); financial audit 10 years; non-clinical login audit 2 years | OD-023 |
| 3 | MFA untuk dokter | Optional per tenant; consider making it **required by default** (the direction of the HIPAA NPRM, and medical records are specific data under UU PDP) | OD-024 |
| 4 | Pemindaian malware unggahan | Type and size validation in the MVP; malware scanning required before production (Stage 15) | OD-066 |
| 5 | Pendekatan PoC → Stage 4 | The PoC code is not used directly. Modules are moved into the Nx monorepo, and the e2e suite E01–E32 becomes a mandatory acceptance test in CI | RSK-020 |

## 6. Risiko & Isu Terbuka

| Item | Catatan |
|---|---|
| RSK-020 (baru) | Controls could be lost in the move to the monorepo → mitigated by moving the e2e suite + mutation tests into CI |
| RSK-010 PP 33/2026 | Effective 16 Jan 2027. DPIA, PPDP appointment, and DPA with clinics must be ready before production; legal consultation still needed. **These documents are not legal advice.** |
| RSK-006 | Medical review is still required before the Stage 9 gate |
| Mock IdP | Google is simulated. Behaviour of the real Google endpoints (e.g. `hd`, `email_verified` for Workspace accounts) is verified in Stage 6 using a test OAuth client |
| Kunci enkripsi | The PoC uses a local key from env. It must not be used beyond the dev environment |

## 7. Checklist Gate Stage 3

- [x] Threat model reviewed; every threat with score ≥ 15 has controls
- [x] Schema-level tenant isolation tests pass (46)
- [x] Tenant isolation tests via the API (PoC) pass
- [x] RLS fails closed without tenant context (schema + PoC, mutation M2)
- [x] MFA active for admin accounts (PoC)
- [x] Audit chain verified; update/delete attempts rejected
- [x] No secrets in the repository
- [x] HIPAA gap assessment complete (not a compliance claim)
- [x] PO menyetujui Stage 3 (DEC-020)

## 8. Persetujuan

| Peran | Nama | Keputusan | Tanggal | Catatan |
|---|---|---|---|---|
| Project Owner | Sumarto | ☑ Disetujui | 4 Nov 2026 | Semua usulan §5 disetujui; OD-024 mengikuti pilihan yang disarankan (wajib secara default) — DEC-019. |
