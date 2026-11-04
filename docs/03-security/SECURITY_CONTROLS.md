# Security Controls — ClinicRME SaaS

| | |
|---|---|
| Versi | 0.2 — Stage 3 (status diperbarui dari PoC) |
| Tanggal | 4 November 2026 |
| Status kolom | ✅ Terbukti (ada uji/bukti) · 🔧 Sebagian diimplementasi, belum terbukti penuh · 📅 Dijadwalkan (stage disebut) |

## 1. Isolasi Tenant (SC-TEN)

| ID | Kontrol | Mitigasi | Status | Bukti / Rencana |
|---|---|---|---|---|
| SC-TEN-01 | Tenant & cabang aktif hanya dari sesi server; tidak pernah dari input klien | T-01 | ✅ | [PoC e2e](../reports/stage-3/evidence/poc_e2e_tests.txt) E05, E06, E12, E30 |
| SC-TEN-02 | PostgreSQL RLS `ENABLE + FORCE`, fail-closed tanpa context | T-01, T-02 | ✅ | T01–T06 · T34: setiap tabel ber-`tenant_id` yang dapat dibaca aplikasi wajib RLS (temuan batch 4: `tenant_feature_flag`, migrasi 0006, K10, mutasi M14) |
| SC-TEN-03 | Uji katalog: setiap tabel ber-`tenant_id` wajib punya RLS (CI) | T-02 | ✅ | T06 |
| SC-TEN-04 | FK komposit `(tenant_id, id)` | T-01 | ✅ | T04 |
| SC-TEN-05 | Resource tenant lain → 404 | T-01 | ✅ | [PoC e2e](../reports/stage-3/evidence/poc_e2e_tests.txt) E10, E11, E13; mutasi M1/M2 |
| SC-TEN-06 | Role DB platform tanpa grant tabel klinis; break-glass ≤ 8 jam, beralasan, teraudit, notifikasi tenant | T-18 | ✅ grant (P15, T27; mutasi M6) · ✅ break-glass: grant ≤ 8 jam beralasan, diperiksa DB pada setiap baca (B01–B08, T33; mutasi M12), audit `PLATFORM_SUPPORT` di rantai audit tenant, email ke semua tenant admin (N01) | migrasi 0003, 0005 |
| SC-TEN-07 | Konsol platform hanya di host `admin.<domain>` dengan cookie sendiri (`crme_psession`); route platform 404 di host klinik dan sebaliknya; sesi klinik tidak berlaku di konsol | T-18 | ✅ P04 | CR-0001 |
| SC-TEN-08 | Tenant SUSPENDED: hanya `TENANT_ADMIN` yang bisa login, sesi user lain diblokir di guard; TERMINATED tidak dilayani (404), data tetap disimpan | — | ✅ P11–P13; mutasi M7 | PLT-FR-006/013 |

## 2. Autentikasi & Sesi (SC-AUTH)

| ID | Kontrol | Mitigasi | Status |
|---|---|---|---|
| SC-AUTH-01 | Akun hanya dari undangan berbatas waktu (7 hari), token di-hash | T-05 | ✅ undangan wajib (E22, E23, E31) · 📅 alur kirim/terima undangan & uji kedaluwarsa Stage 6 |
| SC-AUTH-02 | Google OIDC Authorization Code + PKCE; verifikasi `iss`, `aud`, `exp`, `nonce`, `state`, `email_verified`; tautan pada `sub` | T-03, T-05 | ✅ PoC + mock IdP (E21–E31) · 📅 uji dengan Google asli Stage 6 |
| SC-AUTH-03 | Password Argon2id (memory ≥ 19 MiB, t ≥ 2), minimal 10 karakter, tolak password umum | T-03 | ✅ Argon2id (E01–E04) · ✅ ≥ 10 karakter, 9.126 password umum (SecLists), tanpa nama email (I03, I06, unit `password-policy.spec.ts`; OD-079) |
| SC-AUTH-04 | Lockout 5 gagal → 15 menit; rate limit per IP & per akun; respons seragam | T-03 | ✅ lockout & respons seragam (E03, E04) · 📅 rate limit per IP Stage 4/15 |
| SC-AUTH-05 | MFA TOTP (RFC 6238) wajib untuk role `requires_mfa`; recovery code sekali pakai (hash); 5 kode salah per sesi → sesi dicabut | T-04 | ✅ E07–E09, E14b, E32; flag role T23b; mutasi M3 · TOTP hanya dapat didaftar ulang dari sesi yang sudah lolos MFA (E33, mutasi M13; temuan batch 4) · kode yang sudah diterima tidak dapat dipakai ulang dalam periodenya (E34, mutasi M15; RSK-024 ditutup Stage 6) |
| SC-AUTH-06 | Sesi server-side; cookie `HttpOnly; Secure; SameSite=Lax`, ID sesi 256-bit acak; idle 30 menit, absolut 12 jam; rotasi ID saat login & naik MFA | T-19 | ✅ E01, E02, E08, E18; mutasi M4 · batas absolut diuji unit di Stage 6 |
| SC-AUTH-07 | Nonaktif user / ganti password / reset MFA mencabut semua sesi | T-05 | ✅ nonaktif user (E19) · ✅ reset password mencabut semua sesi (I06, mutasi M17) · admin mencabut sesi user (I15) · ✅ reset MFA oleh admin mencabut semua sesi, tanpa eskalasi (I16) |
| SC-AUTH-09 | Pengguna platform: tabel identitas terpisah, password Argon2id + **TOTP wajib** untuk semua, lockout 5/15, rotasi sesi saat MFA, 5 kode salah → sesi dicabut; TOTP tidak bisa didaftar ulang hanya dengan password | T-04, T-18 | ✅ P01–P03, P18, P19, P20 (anti-replay); mutasi M8 |
| SC-AUTH-08 | Re-autentikasi (password atau TOTP) untuk aksi sangat sensitif bila diaktifkan tenant: pengesahan RM, export massal | T-14 | 📅 Stage 9/14 |

## 3. Otorisasi (SC-AUTHZ)

| ID | Kontrol | Mitigasi | Status |
|---|---|---|---|
| SC-AUTHZ-01 | Guard permission global: endpoint tanpa deklarasi `@RequirePermission` gagal (deny by default) | T-09 | ✅ E14–E16 (aplikasi menolak start) |
| SC-AUTHZ-02 | Permission efektif per cabang aktif | T-09, T-10 | 🔧 dimuat per cabang di guard, belum diuji multi-cabang · 📅 Stage 6 |
| SC-AUTHZ-03 | Matriks permission dibangkitkan dari OpenAPI; uji otomatis setiap endpoint dengan user tanpa permission → 403 | T-09 | ✅ matriks · 📅 uji per endpoint Stage 4+ |
| SC-AUTHZ-04 | Segregation of duties pada role template + `approved_by <> requested_by` di DB | T-11 | ✅ T18, T24 |
| SC-AUTHZ-05 | Permission khusus obat narkotika/psikotropika | T-13 | ✅ matriks · 📅 Stage 10 |

## 4. Integritas Data (SC-INT)

| ID | Kontrol | Mitigasi | Status |
|---|---|---|---|
| SC-INT-01 | Rekam medis disahkan immutable (trigger), koreksi via addendum, content hash | T-06 | ✅ T07–T09 |
| SC-INT-02 | Idempotency key + unique constraint untuk transaksi; CHECK stok ≥ 0 | T-28 | ✅ T11, T16 |
| SC-INT-03 | Trigger golongan obat untuk penjualan bebas; batch kedaluwarsa ditolak | T-13 | ✅ T11b, T13 |
| SC-INT-04 | Optimistic locking (`version` / If-Match) | — | ✅ skema · 📅 API Stage 6+ |

## 5. Audit (SC-AUD)

| ID | Kontrol | Mitigasi | Status |
|---|---|---|---|
| SC-AUD-01 | Audit aksi tulis, baca RM, login, export, perubahan permission | T-07, T-10 | ✅ fungsi · ✅ integrasi PoC: login gagal, MFA, baca RM (E03, E04, E08, E20) · 📅 export & perubahan permission Stage 6 |
| SC-AUD-02 | Append-only; app tidak punya hak tulis langsung | T-08 | ✅ T20, T20b · ✅ termasuk partisi: temuan Stage 4 — partisi `audit_log_default` dapat dibaca lintas tenant & ditulis langsung oleh role aplikasi; diperbaiki migrasi 0002 (T25, T26g, [F14](../reports/stage-4/evidence/integration_tests.txt), mutasi M5) |
| SC-AUD-03 | Hash chain + verifikasi harian | T-08 | ✅ T21, T22 · ✅ job worker `system.audit_chain_verify` harian, gagal bila rantai rusak ([bukti](../reports/stage-4/evidence/audit_chain_job.txt)) · 📅 alert Stage 15 |
| SC-AUD-04 | Laporan "siapa mengakses RM pasien X" | T-10 | 📅 Stage 9 |

Detail: [AUDIT_POLICY.md](AUDIT_POLICY.md).

## 6. Kriptografi (SC-CRY)

| ID | Kontrol | Mitigasi | Status |
|---|---|---|---|
| SC-CRY-01 | TLS 1.2+ di seluruh jalur publik; HSTS | T-19 | 📅 Stage 15 |
| SC-CRY-02 | Enkripsi at rest default Google (Cloud SQL, GCS); CMEK tidak di MVP (OD-011) | T-17 | 📅 Stage 15 |
| SC-CRY-03 | NIK & secret TOTP dienkripsi di aplikasi (AES-256-GCM, envelope encryption dengan Cloud KMS); pencarian via HMAC-SHA256 dengan kunci terpisah | T-17 | ✅ secret TOTP AES-256-GCM (E08) dengan kunci lokal · 📅 KMS Stage 15, NIK Stage 7 |
| SC-CRY-04 | Semua secret di Secret Manager; tidak di repo, image, atau variabel build | T-25, T-26 | ✅ lokal: `.env` dibuat acak, di-gitignore, konfigurasi gagal start tanpa nilai valid · 📅 Secret Manager Stage 4 batch 3 / 15 |

## 7. Aplikasi Web (SC-WEB)

| ID | Kontrol | Mitigasi | Status |
|---|---|---|---|
| SC-WEB-01 | Content-Security-Policy ketat (nonce), `X-Content-Type-Options`, `frame-ancestors 'none'`, Referrer-Policy | T-19 | ✅ API: helmet, CSP `default-src 'none'` ([F02](../reports/stage-4/evidence/integration_tests.txt)) · web: CSP nonce per request via `proxy.ts` + header statis (uji `apps/web/specs`, build standalone) |
| SC-WEB-01b | Konsol platform: semua halaman dirender per request agar nonce CSP terpasang; tidak ada style inline runtime; `Cache-Control: no-store`; proxy `/api/platform/v1` hanya meneruskan path platform & header dari daftar izin | T-19, T-18 | ✅ U08, uji `apps/platform-admin/specs`; mutasi M10 |
| SC-WEB-01c | Aplikasi klinik (`apps/web`): render per request (nonce CSP), `no-store`; proxy `/api/v1` menentukan klinik dari subdomain yang divalidasi (bukan header Host mentah), menolak host konsol & host tanpa kode klinik, hanya meneruskan path `/api/v1` & header dari daftar izin | T-01, T-19 | ✅ W01, W06, uji `apps/web/specs` |
| SC-WEB-02 | SameSite=Lax + header anti-CSRF (`X-CSRF-Token` double-submit) untuk metode non-GET | T-20 | ✅ E17 |
| SC-WEB-03 | Tidak ada `dangerouslySetInnerHTML` tanpa sanitasi (lint) | T-19 | ✅ Semgrep `crme-no-dangerously-set-inner-html` ([uji aturan](../reports/stage-4/evidence/semgrep.txt)) |
| SC-WEB-04 | Query terparameter; lint melarang `sql.raw` dengan input | T-21 | ✅ lint `no-restricted-syntax` ([bukti](../reports/stage-4/evidence/lint_rules.txt)) |
| SC-WEB-05 | Validasi input Zod di setiap endpoint; batas ukuran body | T-21 | ✅ interceptor global `@BodySchema`/`@NoBody`, aplikasi menolak start bila endpoint tulis tanpa deklarasi, batas body 1 MB ([F04–F09, F12](../reports/stage-4/evidence/integration_tests.txt)) |

## 8. Data & Berkas (SC-DATA)

| ID | Kontrol | Mitigasi | Status |
|---|---|---|---|
| SC-DATA-01 | Data minimal: hanya field yang diperlukan requirement | — | ✅ skema |
| SC-DATA-02 | NIK ditampilkan ter-mask kecuali permission khusus | T-15 | 📅 Stage 8 |
| SC-DATA-03 | Signed URL ≤ 5 menit setelah cek permission | T-16 | 📅 Stage 9 |
| SC-DATA-04 | Export: permission, watermark, batas baris, audit, alert volume tidak wajar | T-14 | 📅 Stage 14 |
| SC-DATA-07 | Ekspor data tenant: permission `tenant.data.export` (TENANT_ADMIN + MFA), arsip AES-256-GCM dengan kunci per ekspor, isi dibatasi RLS + pemeriksaan `tenant_id` per baris, kredensial tidak ikut, unduh & kunci teraudit, tautan 24 jam lalu objek dihapus | T-14, T-01 | ✅ K04–K09, T32; mutasi M11 |
| SC-DATA-05 | `statement_timeout` & laporan berat asinkron | T-23 | 📅 Stage 14 |
| SC-DATA-06 | Unggahan: whitelist tipe, ≤ 10 MB, pemeriksaan magic bytes; pemindaian malware (OD-066) | T-27 | 📅 Stage 9/15 |

## 9. Logging & Monitoring (SC-LOG)

| ID | Kontrol | Mitigasi | Status |
|---|---|---|---|
| SC-LOG-01 | Log terstruktur tanpa PHI; redaksi otomatis field sensitif (`nik`, `password`, `soap.*`) | T-15 | ✅ pino JSON, tanpa body & query string, redaksi header/field ([F13](../reports/stage-4/evidence/integration_tests.txt), `logging.spec.ts`) · batas: wildcard pino hanya 1 tingkat |
| SC-LOG-02 | Notifikasi tanpa isi medis | T-15 | 📅 Stage 8/13 |
| SC-LOG-03 | Alert keamanan: lonjakan login gagal, akses lintas tenant ditolak (404 berulang), callback signature invalid, audit chain rusak | T-01, T-03, T-08, T-12 | 📅 Stage 15 |

## 10. Jaringan & Infrastruktur (SC-NET)

| ID | Kontrol | Mitigasi | Status |
|---|---|---|---|
| SC-NET-01 | Cloud Armor (OWASP CRS), rate limit per IP | T-22 | 📅 Stage 15 |
| SC-NET-02 | Max instance Cloud Run, connection pool terbatas | T-22 | 📅 Stage 15 |
| SC-NET-03 | Cloud SQL private IP; worker tanpa ingress publik | T-17 | 📅 Stage 15 |
| SC-NET-04 | Service account per layanan, least privilege | T-26 | 📅 Stage 15 |

## 11. Siklus Pengembangan (SC-SDLC)

| ID | Kontrol | Mitigasi | Status |
|---|---|---|---|
| SC-SDLC-01 | Code review wajib; branch `main` terlindungi | — | ✅ aturan & template PR (CONTRIBUTING.md) · 📅 branch protection aktif setelah repo GitHub dibuat |
| SC-SDLC-02 | Lockfile & versi terkunci; dependency baru direview | T-24 | ✅ `pnpm-lock.yaml`, `--frozen-lockfile`, Node/pnpm terkunci ([bukti](../reports/stage-4/evidence/clean_clone_checks.txt)) · ✅ Dependabot + checklist PR · ✅ Action dipin SHA, binary diverifikasi checksum (RSK-021) |
| SC-SDLC-03 | Dependency & image scanning di CI; tidak rilis dengan temuan kritis | T-24 | ✅ `pnpm audit --prod --audit-level high` = 0 (2 temuan high diperbaiki: zod, multer — [bukti](../reports/stage-4/evidence/dependency_audit.txt)) · ✅ workflow `security` & job `images` siap (osv-scanner) · 📅 aktif setelah repo GitHub dibuat |
| SC-SDLC-04 | Secret scanning (detect-secrets / gitleaks) pre-commit & CI | T-25 | ✅ detect-secrets & gitleaks 0 temuan ([bukti](../reports/stage-4/evidence/secret_scan.txt)) · ✅ gitleaks di workflow `security` (seluruh riwayat git) |
| SC-SDLC-05 | Data sintetis saja di non-prod | — | ✅ seed uji |
| SC-SDLC-06 | Penetration test independen sebelum go-live | Semua | 📅 Stage 16 |

## 12. Keuangan (SC-FIN)

| ID | Kontrol | Mitigasi | Status |
|---|---|---|---|
| SC-FIN-01 | Maker–checker refund, void & penyesuaian: pengaju ≠ penyetuju (DB menolak `approved_by = requested_by` + role template tanpa kombinasi ajukan+setujui) | T-11 | ✅ T18, T24 · 📅 alur API Stage 11 |
| SC-FIN-02 | Laporan anomali kasir (refund/void di atas ambang, diskon manual, void berulang) untuk manajer | T-11 | 📅 Stage 13 |
| SC-FIN-03 | Tutup shift kasir dengan rekonsiliasi kas; invoice & pembayaran terbit tidak dapat diubah (koreksi via dokumen pembalik) | T-11 | ✅ immutability invoice & pembayaran (T15, T15b, T16b) · 📅 alur shift Stage 11 |
| SC-FIN-04 | Callback payment gateway: verifikasi signature, cek nominal & invoice, idempotency per `gateway_txn_id`, rekonsiliasi harian | T-12 | 📅 Stage 11/12 |

## 13. Kontrol Organisasional (untuk klinik & platform)

| ID | Kontrol | Status |
|---|---|---|
| SC-ORG-01 | Perjanjian pemrosesan data (DPA) klinik ↔ ClinicRME | 📅 [PRIVACY_AND_PDP.md](PRIVACY_AND_PDP.md) §4 |
| SC-ORG-02 | Panduan peran & pelatihan kerahasiaan untuk staf klinik | 📅 Stage 16 |
| SC-ORG-03 | Incident response plan | ✅ desain — [INCIDENT_RESPONSE_PLAN.md](INCIDENT_RESPONSE_PLAN.md) |
| SC-ORG-04 | Review akses berkala oleh tenant admin (user aktif, role) | 📅 Stage 6 |
