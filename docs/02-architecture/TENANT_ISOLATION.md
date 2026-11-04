# Tenant Isolation — ClinicRME SaaS

| | |
|---|---|
| Versi | 1.0 — Disetujui (DEC-018) |
| Tanggal | 3 November 2026 |
| ADR | ADR-0002 |
| Requirement | GEN-FR-001, PLT-FR-009, NFR-SEC-001 |

## 1. Model

Shared database, shared schema. Setiap baris milik tenant ditandai `tenant_id`. Isolasi ditegakkan berlapis sehingga satu kesalahan di satu lapisan tidak membocorkan data.

## 2. Lapisan Kontrol

| # | Lapisan | Kontrol | Gagal bila… | Bukti |
|---|---|---|---|---|
| 1 | Sesi | Tenant & cabang aktif disimpan di `user_session`; cookie hanya membawa ID sesi | Sesi dicuri → mitigasi: HttpOnly, rotasi, pencabutan | Stage 3 |
| 2 | Guard NestJS | `TenantGuard` mengisi `AsyncLocalStorage` dari sesi; tenant **tidak pernah** diambil dari body/query | Endpoint lupa guard → guard global, deny by default | Stage 3, AC-IAM-FR-011-2 |
| 3 | Akses DB | Semua query via `withTenantTx()` yang menjalankan `set_config('app.tenant_id', ..., true)`; lint melarang akses pool langsung | Developer memakai koneksi langsung → lapis 4 | Stage 4 |
| 4 | RLS PostgreSQL | `ENABLE` + `FORCE` RLS, policy `tenant_id = app.current_tenant_id()`, fail-closed bila context kosong | Role memiliki BYPASSRLS → diuji T06b | **T01–T06 lulus** |
| 5 | FK komposit | `(tenant_id, x_id)` mencegah referensi ke objek tenant lain | — | **T04 lulus** |
| 6 | Storage | Path `tenants/{tenant_id}/...`, signed URL setelah cek permission | — | Stage 9 |
| 7 | Job & cache | Payload job & kunci cache menyertakan `tenant_id`; worker men-set context sebelum query | Job tanpa tenant → ditolak | Stage 4 |
| 8 | Log & observability | `tenant_id` dicatat; tanpa PHI | — | Stage 4 |

## 3. Akses Platform

- Konsol platform memakai role `clinicrme_platform` yang **tidak punya grant** ke tabel klinis. T27 memeriksa katalog: role platform tidak punya hak apa pun pada tabel ber-`tenant_id` selain 5 tabel platform, dan tidak punya `DELETE` sama sekali.
- Pengguna platform punya identitas sendiri (`platform_user`, CR-0001) dan hanya dilayani di host `admin.<domain>` dengan cookie `crme_psession`. Route platform tidak ada di host klinik, route klinik tidak ada di host admin, dan sesi kedua sisi tidak saling berlaku (P04).
- Aksi platform atas tenant (provisioning, status, feature flag) dicatat dua kali: di `platform_audit_log` dan di rantai audit tenant itu dengan `actor_kind = 'PLATFORM'`.
- Dukungan teknis yang butuh melihat data tenant memakai `support_access_grant` (alasan wajib, ≤ 8 jam, notifikasi ke tenant admin, diaudit dengan `actor_kind = 'PLATFORM_SUPPORT'`).

## 4. Pengujian

| Uji | Lokasi | Kapan |
|---|---|---|
| Uji skema (RLS, FK komposit, cakupan semua tabel, role tanpa BYPASSRLS) | `db/tests/run_tests.sh` | Setiap PR yang mengubah `db/` (CI, Stage 4) |
| Uji API lintas tenant — setiap endpoint dipanggil dengan resource tenant lain → 404 | `apps/api/test/tenant-isolation` | Setiap PR (Stage 4+) |
| Uji job/worker tanpa tenant context → gagal | Stage 4 | Setiap PR |
| Penetration test independen | Stage 16 | Sebelum go-live |

T06 memeriksa katalog PostgreSQL sehingga **tabel baru yang lupa diberi RLS otomatis membuat CI gagal**.

## 5. Hasil Uji Stage 2

42 pemeriksaan lulus, 0 gagal, PostgreSQL 16.15 — [db_security_tests.txt](../reports/stage-2/evidence/db_security_tests.txt).
