# Stage 5 — Stage Plan

| | |
|---|---|
| Stage | 5 — SaaS Administration & Tenant Management |
| Status | **APPROVED WITH NOTES** — 4 Nov 2026 (DEC-028) · [completion report](STAGE_COMPLETION_REPORT.md) |
| Mulai | 4 November 2026 (DEC-023) |
| Project Owner | Sumarto |
| Requirement | PLT-FR-001 s.d. 013 (MVP: 001–009, 011, 013) |
| Syarat masuk terbuka | S4-1 (CI green on GitHub) must be closed **before this stage's gate** |

## 1. Tujuan

Manage clinics as SaaS customers:
- provisioning,
- plans & quotas,
- tenant status (trial → active → grace → suspended → terminated),
- feature flags,
- data export,
- strict separation of the platform console from clinical data.

## 2. Batch

| Batch | Isi | Butuh dari PO |
|---|---|---|
| **1 — Backend platform** | Migration 0003 (CR-0001): platform users, platform sessions, platform audit, `provision_tenant`, quota triggers.<br>`libs/platform`: platform login + mandatory MFA, tenant list/detail/create, status changes (state machine + history + audit), feature flags, plans.<br>Suspended tenant: only tenant admin can log in (PLT-FR-006). Quotas enforced in the DB (PLT-FR-004).<br>Tests: P## suite, SQL, mutation | CR-0001, OD-075 |
| **2 — UI konsol platform** (ditukar, DEC-024) | `libs/ui` (gaya shadcn/ui + Tailwind 4), aplikasi `apps/platform-admin`: login, TOTP, daftar/detail/buat tenant, ubah status, feature flag; uji Playwright pertama | — |
| **3a — Profil & ekspor** ✅ | Profil & kop klinik (PLT-FR-007, tanpa logo); ekspor data terenkripsi via worker + unduhan teraudit (PLT-FR-008); `libs/storage` (fs + GCS) | CR-0002 |
| **3b — Break-glass & email** ✅ | Break-glass akses dukungan (PLT-FR-009): grant, cabut, baca user & log audit tenant; email ke semua tenant admin; email undangan tenant admin (outbox → worker → SMTP) | OD-076, OD-077 (DEC-026) |
| **4 — UI break-glass & admin klinik** ✅ | Konsol: minta/daftar/cabut akses dukungan, baca user & audit. Aplikasi klinik `apps/web`: login (email/password + Google), TOTP, profil & kop klinik, ekspor data | DEC-027 |

## 3. Gate Stage 5

- [x] Full tenant status lifecycle tested (all valid and invalid transitions) — P07 (36 pasangan), P10, P13, U04
- [x] Quotas enforced in the backend (users & branches) — P16, mutasi M9
- [x] Test: superadmin/platform cannot access clinical endpoints or tables — P04, P15, B08, T27, mutasi M6
- [x] Cross-tenant isolation tested on every new endpoint — K03/K06, B05, W06, T34 (semua tabel ber-`tenant_id`), mutasi M2/M11/M14
- [x] Tenant export produces a complete, encrypted archive — K05, W04 (worker sungguhan → unduh → dibuka dengan kunci)
- [ ] S4-1: CI green on GitHub — **dipindah ke sebelum gate Stage 6** (DEC-028)
- [x] PO approves Stage 5 — dengan catatan (DEC-028)

## 4. Open Decision Stage 5

| OD | Pertanyaan | Usulan |
|---|---|---|
| OD-027 | SaaS subscription billing: automatic (payment gateway) or manual invoice? | **Manual invoice** for the pilot; automatic billing (PLT-FR-012) is Lanjutan |
| OD-028 | Tenant data export format | **NDJSON per table + `manifest.json` (row counts, sha256 per file), in an AES-256-GCM-encrypted archive**; FHIR Bundle added in Stage 12 |
| OD-075 | Platform identity | Separate tables + `admin.<domain>` console + password & mandatory TOTP (CR-0001) |
| OD-076 | Tenant notification on break-glass | Email to all tenant admins + entry in the tenant's audit — **diputuskan DEC-025, dibangun batch 3b** |
| OD-077 | Cara support melihat data tenant selama break-glass | **Diputuskan DEC-026**: lewat konsol platform, hanya daftar user/role & log audit, fungsi DB ber-grant, tanpa data pasien |
| OD-070 | Pricing & archive storage after a tenant stops (from Stage 3) | Data is not deleted (PLT-FR-013): a TERMINATED tenant can't log in; data is kept until the retention period ends. Archive pricing decided with the PO before the pilot |

## 5. Hasil Batch 1 (4 Nov 2026)

Semua pemeriksaan dijalankan dari **salinan bersih** repo setelah `pnpm install --frozen-lockfile`.

| Pemeriksaan | Hasil | Bukti |
|---|---|---|
| Lint · typecheck · build | 0 error, 8 proyek (lib baru `libs/platform`) | [clean_clone_checks](evidence/clean_clone_checks.txt) |
| Unit test | **50** (+9: mesin status, peta permission platform, pemetaan error DB, kontrak) | [clean_clone_checks](evidence/clean_clone_checks.txt) |
| Uji integrasi API | **71/71**: E 33 · F 15 · C 4 · **P 19 (baru)** | [integration_tests](evidence/integration_tests.txt) |
| Uji SQL (DB dari migrasi) | **72** (+14: T27–T30) | [db_security_tests](evidence/db_security_tests.txt) |
| Uji mutasi | **9/9 terdeteksi** (M6–M9 baru) | [mutation_tests](evidence/mutation_tests.txt) |
| Baseline ≡ `db/schema` | Sama (migrasi 0003 di luar baseline, sesuai ADR-0009) | [schema_parity](evidence/schema_parity.txt) |
| Kontrak OpenAPI | 6/6 (uji baru: route platform ↔ skema `platformSession`); Redocly valid | [contract_test](evidence/contract_test.txt) |
| Stack lokal, jalur upgrade dari `.env` Stage 4 | `dev:env` menambah 3 kunci tanpa menyentuh nilai lama → `dev:db` → `dev:seed` → bundle API: login platform, TOTP, buat tenant, suspend; tidak ada secret di log | [local_stack_smoke](evidence/local_stack_smoke.txt) |
| Worker self-test (DB dengan migrasi 0003) | OK | [clean_clone_checks](evidence/clean_clone_checks.txt) |
| gitleaks · detect-secrets · Semgrep · `pnpm audit --prod` · actionlint | 0 temuan | [security_scans](evidence/security_scans.txt) |

### Yang dibangun

| Area | Isi | Requirement |
|---|---|---|
| Migrasi `0003` | 5 tabel `platform_*`; `actor_kind` + `PLATFORM`; trigger mesin status tenant; kode tercadang; `app.provision_tenant()`; trigger kuota user & cabang; paket `PILOT`; permission `platform.tenant.read` | CR-0001, PLT-FR-001/003/004/005 |
| `libs/platform` | Login password + TOTP wajib, sesi `crme_psession`, `PlatformSecurityGuard`; tenant list (keyset)/detail/create/status/flag; paket | PLT-FR-001/003/005/011, IAM-FR-005 |
| `libs/iam` | Host `admin.<domain>` dikenali; route klinik 404 di host admin (dan sebaliknya); **SUSPENDED** → hanya `TENANT_ADMIN` bisa login, sesi user lain diblokir; **TERMINATED** → 404, data tetap | PLT-FR-006, PLT-FR-013 |
| `libs/db` | `PlatformDb` (role DB platform), `platformAudit`, audit tenant `actor_kind = PLATFORM` | PLT-FR-009 |
| `libs/shared` | Dekorator `@PlatformPublic/@PlatformAuthenticated/@PlatformPermission`; cek startup menolak campuran deklarasi; `ProblemFilter` memetakan SQLSTATE kustom (`CRQ01` → `PLT-403-QUOTA`, `CRS01` → `PLT-409-STATUS`) | AC-PLT-FR-004-1 |
| Dev & CI | `PLATFORM_DATABASE_URL`; `dev:env` menambah kunci yang belum ada; `dev:db` membuat role `clinicrme_platform_api`; `dev:seed` membuat `admin@platform.test`; job image CI memakai role platform terpisah | — |

### Temuan & keputusan teknis

1. **[Keamanan] Fungsi SECURITY DEFINER tidak bisa membaca `tenant` bila pemilik migrasi bukan superuser.** `tenant` memakai FORCE RLS dan tidak punya policy untuk pemilik. Di lokal/CI pemiliknya superuser (RLS dilewati), jadi tidak terlihat; di Cloud SQL pemiliknya bukan superuser, sehingga `resolve_tenant` (resolusi subdomain) akan gagal total. Diperbaiki di migrasi 0003 dengan policy `tenant_definer`. Pemeriksaan dengan pemilik non-superuser masuk ke deploy dev (S4-2).
2. **[Keamanan] Token undangan tenant admin tidak pernah dikembalikan ke pengguna platform.** Bila dikembalikan, staf platform bisa masuk sebagai admin klinik dan membuka data klinis, melanggar PLT-FR-009. Tenant admin masuk lewat Google dengan email undangan (alur yang sudah ada); email undangan dikirim di batch 2.
3. **TOTP pengguna platform tidak bisa didaftar ulang hanya dengan password** (berbeda dari aplikasi klinik). Pemulihan perangkat hilang dicatat sebagai RSK-023.
4. **Permission daftar tenant & paket** diubah dari `platform.tenant.manage` ke `platform.tenant.read` agar PLATFORM_SUPPORT bisa melihat tanpa mengubah (bagian CR-0001).
5. **Kuota ditegakkan di trigger database**, bukan hanya di API: semua jalur tulis (termasuk impor & skrip) ikut dibatasi, dan dua penambahan bersamaan diserialisasi dengan kunci baris tenant.
6. `db/seed` dibekukan bersama `db/schema`: `tools/gen_permission_matrix.py` kini hanya menulis seed SQL dengan `--seed`; permission baru masuk lewat migrasi.

### Belum (batch 2–3)

- Profil klinik, kop surat, logo (PLT-FR-007).
- Ekspor data terenkripsi (PLT-FR-008).
- Break-glass + notifikasi tenant (PLT-FR-009).
- Email undangan tenant admin.
- UI konsol.
- Hitungan pemakaian kuota di detail tenant (butuh fungsi agregat khusus, karena role platform tidak boleh membaca `app_user`).
- Rate limit per IP untuk login platform (bersama SC-AUTH-04, Stage 15).

## 6. Hasil Batch 2 — UI Konsol Platform (4 Nov 2026)

Urutan ditukar atas permintaan PO (DEC-024). Pemeriksaan dari **salinan bersih** repo.

| Pemeriksaan | Hasil | Bukti |
|---|---|---|
| Lint · typecheck · build | 0 error, 10 proyek (baru: `libs/ui`, `apps/platform-admin`) | [clean_clone_checks](evidence/clean_clone_checks.txt) |
| Unit test | **55** (+5: aturan proxy konsol, CSP konsol) | [clean_clone_checks](evidence/clean_clone_checks.txt) |
| **E2E Playwright (pertama)** | **8/8** — U01–U08 di Chromium, bundle produksi API + build standalone konsol | [e2e_tests](evidence/e2e_tests.txt) |
| Uji integrasi API | 71/71 (P08/P13 kini memeriksa `allowedTransitions`) | [integration_tests](evidence/integration_tests.txt) |
| Uji SQL · baseline ≡ `db/schema` | 72 · sama | [db_security_tests](evidence/db_security_tests.txt) · [schema_parity](evidence/schema_parity.txt) |
| Uji mutasi | **10/10** — M10 baru: konsol dirender statis (nonce CSP hilang) → U01 gagal | [mutation_tests](evidence/mutation_tests.txt) |
| Kontrak OpenAPI | 6/6; Redocly valid | [contract_test](evidence/contract_test.txt) |
| gitleaks · detect-secrets · Semgrep · `pnpm audit --prod` · actionlint | 0 temuan | [security_scans](evidence/security_scans.txt) |
| Tangkapan layar | login, buat tenant, daftar, detail, dialog konfirmasi | [evidence/ui](evidence/ui/) |

### Yang dibangun

| Area | Isi |
|---|---|
| `libs/ui` (type:ui) | Token desain (Tailwind 4 `@theme`), Button, Input/Textarea/Select/Switch/Field, Card, Badge, Alert, Table, Dialog. Tanpa style inline runtime → aman untuk CSP bernonce |
| `apps/platform-admin` (Next.js 16, port 4300) | `/login` → `/mfa` (QR + kunci manual + 8 recovery code, wajib centang "sudah disimpan") → `/tenants` (keyset "muat lebih") → `/tenants/new` (React Hook Form + Zod) → `/tenants/[id]` (info, ubah status dengan dampak & konfirmasi, feature flag) |
| Proxy `/api/platform/v1/*` | Route handler Next.js meneruskan ke API dengan `Host: admin.<BASE_DOMAIN>` (node:http). Hanya path platform, segmen divalidasi, header diteruskan lewat daftar izin, body ≤ 1 MB. Browser hanya bicara ke satu origin; cookie sesi tetap HttpOnly |
| API | Detail tenant memuat `allowedTransitions` (mesin status tidak disalin ke UI) |
| Image & CI | `docker/web.Dockerfile` kini `ARG APP` (web / platform-admin); job CI: image konsol + healthz, Playwright di job integrasi, trace disimpan bila gagal |

### Catatan teknis

1. **Semua halaman dirender dinamis** (`await headers()` di root layout): nonce CSP hanya bisa disisipkan Next.js ke script pada render per request. Halaman statis akan diblokir CSP sehingga konsol mati total. Ini dijaga mutasi M10.
2. **Dialog & Select memakai elemen bawaan browser**, bukan Radix: primitive Radix (melalui react-remove-scroll) menyisipkan `<style>` saat runtime yang ditolak CSP tanpa `unsafe-inline`. Perilaku aksesibilitas (fokus terkunci, Esc, label) tetap ada. Dicatat di ADR-0010.
3. Tombol & form yang tidak sesuai izin disembunyikan di UI (support hanya melihat), tetapi penegakannya tetap di API (P06).
4. Uji E2E memakai database `clinicrme_e2e` yang dibuat ulang setiap kali (`tools/e2e/prepare-db.ts`). Chromium: `npx playwright install chromium`, atau `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

### Belum

- Batch 3: profil & kop klinik, ekspor terenkripsi, break-glass, email undangan.
- Batch 4: halaman admin klinik.
- Bahasa/tema gelap dan TanStack Table (dipakai saat butuh sortir/filter kolom) belum diperlukan untuk konsol.

## 7. Hasil Batch 3a — Profil Klinik & Ekspor Data (4 Nov 2026)

Disetujui PO sebelum batch dimulai: CR-0001, OD-027/028/075/076 (DEC-025). Pemeriksaan dari **salinan bersih** repo.

| Pemeriksaan | Hasil | Bukti |
|---|---|---|
| Lint · typecheck · build | 0 error, 12 proyek (baru: `libs/storage`, `libs/tenant`) | [clean_clone_checks](evidence/clean_clone_checks.txt) |
| Unit test | **62** (+7: arsip terenkripsi, penyimpanan fs & emulator GCS, konfigurasi) | [clean_clone_checks](evidence/clean_clone_checks.txt) |
| Uji integrasi API | **80/80** (K01–K09 baru) | [integration_tests](evidence/integration_tests.txt) |
| Uji SQL | **80** (T31–T32 baru) | [db_security_tests](evidence/db_security_tests.txt) |
| Uji mutasi | **11/11** (M11 baru: ekspor tanpa `SET ROLE` → K05 gagal) | [mutation_tests](evidence/mutation_tests.txt) |
| Worker + emulator GCS (`fake-gcs-server` 1.52.3) | Job `tenant.export.run` → arsip di bucket `clinicrme-exports`, status DONE | [worker_export](evidence/worker_export.txt) |
| E2E konsol · kontrak · pemindaian | 8/8 · lulus · 0 temuan | [e2e_tests](evidence/e2e_tests.txt) · [contract_test](evidence/contract_test.txt) · [security_scans](evidence/security_scans.txt) |

### Yang dibangun

| Area | Isi |
|---|---|
| Migrasi `0004` | Aplikasi boleh `UPDATE` **hanya** kolom profil (`display_name`, `letterhead`, `settings`, `logo_file_id`) pada baris tenant sendiri; `tenant_export_job` jadi tabel ber-RLS + kolom hasil; satu ekspor aktif per tenant; konsol platform hanya melihat kolom status (tanpa kunci); worker boleh `SET ROLE clinicrme_app` |
| `libs/tenant` | `GET/PUT /api/v1/tenant/profile` (If-Match/ETag, 412 bila versi lama, pengaturan dengan kunci yang dikenal saja); `POST/GET /api/v1/tenant/exports`, `/key`, `/file` |
| `@clinicrme/db/tenant-export` | Mesin ekspor: snapshot `REPEATABLE READ READ ONLY` sebagai `clinicrme_app` + tenant context, semua tabel ber-`tenant_id` yang dapat dibaca aplikasi (otomatis dari katalog), cursor 1000 baris, NDJSON + `manifest.json` (jumlah baris, sha256), tar → gzip → AES-256-GCM streaming. Kredensial/token **tidak** diekspor |
| `libs/storage` | Driver `fs` (lokal/test) dan `gcs` (JSON API via `fetch`, token metadata server di Cloud Run) — tanpa SDK; path objek tervalidasi |
| Worker | `tenant.export.run` (tiap menit, `FOR UPDATE SKIP LOCKED`) dan `tenant.export.expire` (tiap jam: hapus objek kedaluwarsa, job macet → FAILED) |
| `tools/export/decrypt-export.mjs` | Alat mandiri (hanya Node.js) untuk membuka arsip: verifikasi tag GCM, ekstrak ke folder |

### Catatan teknis

1. **Isolasi isi arsip dijaga dua lapis.** RLS (role `clinicrme_app`) memfilter baris; selain itu setiap baris diperiksa `tenant_id`-nya, dan satu baris tenant lain membuat ekspor **gagal** tanpa berkas. Diuji dengan dua tenant yang mengekspor bersamaan (K05, K06) dan mutasi M11.
2. **Unduhan & kunci lewat API, bukan signed URL** — supaya setiap akses teraudit (AC-PLT-FR-008-2). Usulan perubahan kontrak: CR-0002.
3. **Policy pemilik untuk worker** (`export_worker`): sama seperti `tenant_definer` di 0003, `FORCE RLS` menolak pemilik non-superuser (Cloud SQL). Klaim job & pembersihan tidak membaca data tenant.
4. Kolom `*_encrypted` (NIK) ikut sebagai ciphertext; dekripsi untuk serah terima menyusul saat modul pasien (Stage 8). Tercatat di `manifest.json`.
5. **Logo** (bagian PLT-FR-007) menunggu alur unggah berkas Stage 9 (DOC-FR-003, pemeriksaan tipe & ukuran); kolomnya sudah ada dan divalidasi.

### Belum (batch 3b & 4)

- Break-glass: grant, cabut, notifikasi email ke tenant admin; cara support melihat data → **OD-077** (perlu keputusan PO).
- Email: undangan tenant admin saat provisioning (outbox → worker → SMTP/Mailpit).
- Batch 4: halaman admin klinik (profil, ekspor dengan tombol unduh & kunci).

## 8. Hasil Batch 3b — Break-glass & Email (4 Nov 2026)

Disetujui PO sebelum batch dimulai: CR-0002 dan OD-077 (DEC-026, dari jawaban "oke lanjutkan ke stage selanjutnya"). Pemeriksaan dari **salinan bersih** repo.

| Pemeriksaan | Hasil | Bukti |
|---|---|---|
| Lint · typecheck · build | 0 error, 12 proyek | [clean_clone_checks](evidence/clean_clone_checks.txt) |
| Unit test | **63** (+1: job `notify.outbox.dispatch` tanpa SMTP) | [clean_clone_checks](evidence/clean_clone_checks.txt) |
| Uji integrasi API | **91/91** (B01–B08 break-glass, N01–N03 email baru) | [integration_tests](evidence/integration_tests.txt) |
| Uji SQL | **86** (T33 baru: hak fungsi, grant tak terhapus, trigger undangan) | [db_security_tests](evidence/db_security_tests.txt) |
| Uji mutasi | **12/12** (M12 baru: masa berlaku grant tidak diperiksa → B06 gagal) | [mutation_tests](evidence/mutation_tests.txt) |
| Worker + Mailpit v1.28.3 | Undangan & notifikasi break-glass terkirim via SMTP, outbox DONE | [worker_email](evidence/worker_email.txt) |
| E2E konsol · kontrak · paritas · pemindaian | 8/8 · lulus (157 operasi) · SAMA · 0 temuan | [e2e_tests](evidence/e2e_tests.txt) · [contract_test](evidence/contract_test.txt) · [schema_parity](evidence/schema_parity.txt) · [security_scans](evidence/security_scans.txt) |

### Yang dibangun

| Area | Isi |
|---|---|
| Migrasi `0005` | `support_access_grant` lengkap (FK ke `platform_user`, `revoked_by`, tanpa DELETE untuk konsol). Fungsi `support_open` (grant milik user ini, belum dicabut, `starts_at ≤ now() < expires_at`, else `CRG01`) — tidak dapat dipanggil langsung. `support_read_users` / `support_read_audit` (tanpa `patient_id`/IP; setiap panggilan menulis audit `SUPPORT_VIEWED_*` aktor `PLATFORM_SUPPORT` di rantai audit tenant). Trigger undangan → outbox `INVITATION_CREATED` (payload kosong, tanpa token) |
| `libs/platform` | `POST/GET /api/platform/v1/support-access`, `/{grantId}/revoke`, `/{grantId}/users`, `/{grantId}/audit-log` (keyset). Alasan ≥ 10 karakter, 15–480 menit, satu grant aktif per support per tenant. Grant & cabut diaudit di platform **dan** tenant |
| `@clinicrme/db/notifications` | Dispatcher outbox: klaim `FOR UPDATE SKIP LOCKED`, render sebagai `clinicrme_app` + tenant context, satu email per penerima, ulang sampai 5× lalu FAILED; event tanpa penerima dilaporkan |
| Worker | Job `notify.outbox.dispatch` tiap menit; nodemailer (`SMTP_URL`, `MAIL_FROM`, `CLINIC_URL_TEMPLATE`). Tanpa `SMTP_URL` job dilewati dengan peringatan (event tetap PENDING) |

### Catatan teknis

1. **Masa berlaku grant ditegakkan di database pada setiap pembacaan**, bukan hanya saat grant dibuat — grant kedaluwarsa atau dicabut langsung ditolak (B06, B07; mutasi M12).
2. **Support tidak dapat membuka data pasien.** Fungsi baca hanya mengembalikan user/role dan metadata audit; role DB platform tetap tanpa grant tabel klinis (B08, P15).
3. **Zod 4 `z.uuid()` menolak UUID non-RFC** (mis. ID sintetis `aaaaaaaa-0000-…`); input grant memakai `z.guid()`.
4. **Ditemukan saat bukti Mailpit:** tenant tanpa admin aktif membuat notifikasi break-glass "selesai" tanpa terkirim ke siapa pun. Kini dihitung `noRecipient` dan worker memberi peringatan (N03). Alert sungguhan menyusul Stage 15.
5. Bentuk OD-077 lebih sempit dari usulan awal (sesi baca-saja ke aplikasi klinik ditunda) — mohon dikonfirmasi PO.

### Belum

- UI konsol untuk break-glass (form minta akses, daftar grant, tampilan user/audit) — diusulkan masuk batch 4 bersama UI admin klinik.
- Penyedia SMTP cloud untuk dev/prod → OD baru sebelum pilot (tidak berbayar tanpa persetujuan PO).
- Batch 4 (UI admin klinik), gate Stage 5, S4-1 (repo GitHub + CI hijau).

## 9. Hasil Batch 4 — UI Break-glass & Admin Klinik (4 Nov 2026)

Disetujui PO sebelum batch dimulai: bentuk sempit OD-077 dan lingkup batch 4 (DEC-027, dari jawaban "oke lanjutkan ke stage selanjutnya"). Pemeriksaan dari **salinan bersih** repo.

| Pemeriksaan | Hasil | Bukti |
|---|---|---|
| Lint · typecheck · build | 0 error, 12 proyek | [clean_clone_checks](evidence/clean_clone_checks.txt) |
| Unit test | **68** (+5: proxy aplikasi klinik, `SMTP_URL` kosong) | [clean_clone_checks](evidence/clean_clone_checks.txt) |
| Uji integrasi API | **93/93** (E33, K10 baru) | [integration_tests](evidence/integration_tests.txt) |
| Uji SQL | **88** (T34 baru) | [db_security_tests](evidence/db_security_tests.txt) |
| Uji mutasi | **14/14** (M13, M14 baru) | [mutation_tests](evidence/mutation_tests.txt) |
| E2E browser | **16/16** — konsol U01–U10, aplikasi klinik W01–W06 | [e2e_tests](evidence/e2e_tests.txt) |
| Kontrak · paritas · pemindaian | lulus (158 operasi) · SAMA · 0 temuan | [contract_test](evidence/contract_test.txt) · [schema_parity](evidence/schema_parity.txt) · [security_scans](evidence/security_scans.txt) |

### Yang dibangun

| Area | Isi |
|---|---|
| Konsol platform | Kartu "Akses dukungan" di detail tenant (alasan + durasi, konfirmasi menjelaskan cakupan & email ke admin klinik); halaman `/support` (daftar) dan `/support/{id}` (user & role, log audit dengan "muat lebih lama", cabut akses). Admin platform melihat & mencabut, tidak membaca data |
| Aplikasi klinik `apps/web` | Proxy `/api/v1` (klinik dari subdomain tervalidasi, respons di-stream), login email/password + tombol Google, TOTP (daftar/verifikasi), `/admin/profile` (nama, kop dokumen, pengaturan alur; simpan dengan If-Match, konflik → muat versi terbaru), `/admin/exports` (minta, status otomatis, unduh arsip, tampilkan kunci + SHA-256). Non-admin melihat beranda tanpa menu pengaturan |
| API | `GET /api/v1/auth/session` — status sesi untuk halaman login/MFA, boleh sebelum MFA, tanpa permission. `/me` tetap terkunci sampai MFA |
| Uji E2E | Satu konfigurasi Playwright dua proyek (konsol → klinik); W04 menjalankan bundle worker sungguhan lalu membuka arsip dengan `decrypt-export` |

### Temuan keamanan & perbaikan

1. **Feature flag klinik lain terbaca aplikasi klinik.** `tenant_feature_flag` diberi `SELECT` untuk role aplikasi sejak baseline tetapi tanpa RLS. Ditemukan karena ekspor W04 **gagal** (pemeriksaan `tenant_id` per baris menolak arsip). Isinya hanya kode fitur, bukan data pasien. Perbaikan: migrasi `0006` (RLS ENABLE + FORCE), uji SQL **T34** yang memeriksa *semua* tabel ber-`tenant_id` yang dapat dibaca aplikasi, K10, mutasi M14.
2. **TOTP dapat didaftar ulang dari sesi password saja** (menimpa secret lama = melewati MFA bagi pemegang password). Kini hanya dari sesi yang sudah lolos MFA, sama seperti konsol platform (P02). E33, mutasi M13.
3. **Worker gagal start bila `SMTP_URL=` kosong** padahal `.env.example` menyarankan mengosongkannya. Kini kosong = email mati.
4. Tercatat sebagai risiko (belum diperbaiki): kode TOTP yang sama dapat dipakai ulang dalam periode 30 detiknya — **RSK-024**, usulan perbaikan di Stage 6.

### Catatan

- Login Google lewat aplikasi klinik butuh `GOOGLE_REDIRECT_URI=http://demo.localhost:4200/api/v1/auth/google/callback` (default `.env.example` diubah; `.env` lama tidak ditimpa).
- Gate Stage 5 tinggal **S4-1** (repo GitHub + CI hijau) dan persetujuan PO.
