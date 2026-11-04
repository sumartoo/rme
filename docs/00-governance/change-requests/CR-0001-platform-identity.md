# CR-0001 — Identitas & login khusus pengguna platform

| | |
|---|---|
| Diajukan oleh | Claude (tim pengembang) |
| Tanggal | 4 November 2026 |
| Prioritas | Tinggi — penghambat Stage 5 |
| Status | **Disetujui** (DEC-025) — diimplementasikan di Stage 5 batch 1 & 2 |

## Perubahan yang diminta

1. **New tables** (migration 0003), without `tenant_id`. Readable only by `clinicrme_platform`; `clinicrme_app` has no access:
   - `platform_user`
   - `platform_credential`
   - `platform_mfa`
   - `platform_session`
   - `platform_audit_log` (append-only)
2. **Platform login endpoints** added to `api/openapi.yaml`:
   - `POST /api/platform/v1/auth/login`
   - `POST /api/platform/v1/auth/mfa/enroll`
   - `POST /api/platform/v1/auth/mfa/verify`
   - `POST /api/platform/v1/auth/logout`
   - `GET /api/platform/v1/me`
   - Plus `GET /api/platform/v1/tenants/{tenantId}` (tenant detail, needed by the console).
3. **Platform console host:** `admin.<BASE_DOMAIN>`, with a separate session cookie (`crme_psession`). Tenant sessions are never valid on this host, and vice versa.
4. **Platform login:** email + password + **mandatory** TOTP for every platform user. No Google Sign-In for now.
5. `audit_log.actor_kind` gets the value `PLATFORM`, for platform actions on a tenant (create, status change, feature flag), written into that tenant's audit chain.

6. **Permission (revisi saat implementasi):** `platformPlanList` dan `platformTenantList` di kontrak Stage 2 memakai `platform.tenant.manage`. Keduanya diubah ke `platform.tenant.read` (baru), sehingga PLATFORM_SUPPORT bisa melihat daftar tenant tanpa bisa mengubahnya. Membuat tenant, mengubah status, dan feature flag tetap `platform.tenant.manage`.
7. **Kontrak:** skema keamanan baru `platformSession` (cookie `crme_psession`) untuk semua operasi `/api/platform/v1` kecuali login. Uji kontrak memeriksa pasangan ini dua arah.

## Hasil implementasi (batch 1)

| Item | Bukti |
|---|---|
| Migrasi `0003_platform_identity_and_tenant_lifecycle.sql` | P08–P16, T27–T30 |
| Login + TOTP wajib + rotasi sesi + batas percobaan | P01–P03, P18, P19; mutasi M8 |
| Pemisahan host & cookie dua arah | P04 |
| Role DB platform tanpa tabel klinis | P15, T27 (cek katalog seluruh tabel ber-`tenant_id`); mutasi M6 |
| 5 operasi baru + 1 detail tenant di `api/openapi.yaml` | Uji kontrak (6/6) |

**Temuan sampingan:** `tenant` memakai FORCE RLS, sehingga fungsi SECURITY DEFINER milik pemilik non-superuser (Cloud SQL) tidak bisa membacanya. Celah ini tidak terlihat di lokal/CI karena pemiliknya superuser. Migrasi 0003 menambah policy `tenant_definer` untuk pemilik migrasi.

## Alasan

**The design is approved but the data model has a gap.**
- APP_DESIGN §2 and TENANT_ISOLATION §3 require a separate platform console under the `clinicrme_platform` DB role, which has no grants on clinical tables.
- The Stage 2 schema and contract do not yet define where platform users are stored or how they log in.

**The alternative weakens isolation.** Putting platform users as `app_user` inside a special "platform tenant" would mean they log in through the tenant path and the `clinicrme_app` role, which has access to clinical tables. That weakens PLT-FR-009.

## Artefak terdampak

| Artefak | Perubahan |
|---|---|
| Requirements | PLT-FR-001, PLT-FR-009, IAM-FR-005 (MFA for platform admins already required) |
| DB | Migration `0003`; `db/schema` frozen (OD-071), so it is not changed |
| API | `api/openapi.yaml`: 6 new operations under `/api/platform/v1`; `platformPlanList`/`platformTenantList` → `platform.tenant.read` |
| Permission | `platform.tenant.read` (new, view only) in addition to `platform.tenant.manage` |
| Docs | DATABASE_DESIGN §2, TENANT_ISOLATION §3, PERMISSION_MATRIX, SECURITY_CONTROLS |
| ADR | ADR-0003 (authentication): adds a platform section |

## Analisis dampak

| Aspek | Dampak |
|---|---|
| Scope | No new features. Fills a gap in an MVP requirement |
| Jadwal | Inside Stage 5 batch 1 |
| Biaya | None |
| Keamanan & privasi | **Positive.** The platform DB role cannot touch clinical tables; platform and tenant sessions are separated by host and cookie; MFA is mandatory; platform actions are audited |
| Regulasi | Supports UU PDP data-access restrictions (platform as processor) |
| Test | Platform suite P##, SQL tests for the new tables (no app-role access), mutation test (platform role granted clinical access → must fail), contract test |

## Alternatif

1. **Platform tenant** (rejected): reuses code, but weakens isolation (see Alasan).
2. **External IdP (Google Workspace / Identity Platform) for staff:** a good option once the platform team grows. For now, TOTP is enough and adds no paid dependency.

## Keputusan PO

| Keputusan | Tanggal | Catatan |
|---|---|---|
| Disetujui | 4 Nov 2026 14:50 WIB | "lanjutkan stage selanjutnya ya" atas permintaan persetujuan CR-0001 & OD-027/028/076 (DEC-025) |
