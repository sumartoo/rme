# Stage 6 — Stage Plan

| | |
|---|---|
| Stage | 6 — Identity, Role, Permission & Dynamic Menu |
| Status | IN_PROGRESS |
| Mulai | 4 November 2026 (DEC-028) |
| Project Owner | Sumarto |
| Requirement | IAM-FR-001 s.d. 016 — **MVP saja** (DEC-010): 001–005, 007–011, 013, 014, 016. LJT di luar stage ini: 006 (batas domain Google), 012 (jadwal login), 015 (delegasi) |
| Syarat terbuka | **S4-1** (CI hijau di GitHub) wajib selesai **sebelum gate stage ini** (DEC-028) |

## 1. Tujuan

Admin klinik mengelola user, role, dan cabang sendiri. Setiap user hanya melihat menu dan memanggil endpoint sesuai permission efektifnya di cabang aktif. Penegakannya selalu di backend.

## 2. Yang Sudah Ada (Stage 3–5)

Login password + lockout, Google OIDC dengan undangan, TOTP + recovery code, sesi cookie + CSRF, nonaktif user mencabut sesi (IAM-FR-014), `PermissionGuard` deny-by-default (AC-IAM-FR-011-2), 8 role template + 81 permission, `GET /auth/session`, `GET /me`.

## 3. Batch

| Batch | Isi | Requirement |
|---|---|---|
| **1 — Backend IAM** | Migrasi 0007: token reset password, `menu_item` (isi menu semua modul), anti-replay TOTP (RSK-024), MFA DOKTER default aktif (OD-024/DEC-019).<br>Endpoint: user (daftar, undang, nonaktif/aktifkan, cabut sesi), undangan (lihat, terima dengan password), reset password (email lewat outbox), role (daftar, buat custom, ubah permission & MFA), `GET /me/menu`, `POST /me/branch`, sesi saya (daftar, cabut).<br>Kebijakan password ≥ 10 karakter + daftar password umum.<br>**Uji matriks permission**: setiap endpoint di OpenAPI dipanggil user tanpa permission → 403 (AC-IAM-FR-011-1) | 001, 003, 004, 005, 007–011, 013 |
| **2 — UI aplikasi klinik** | Shell aplikasi dengan menu dinamis & pilih cabang, halaman user, role (matriks permission), sesi saya, halaman undangan & reset password. Uji E2E | 001, 004, 008–010, 013 |
| **3 — Penautan nakes & gate** | Tautan user ↔ tenaga kesehatan (IAM-FR-016; data nakes dari Stage 7 → disiapkan kolom & endpoint), completion report, **S4-1** | 016 |

## 4. Open Decision Stage 6

| OD | Pertanyaan | Usulan |
|---|---|---|
| OD-078 ✅ DEC-029 | Undangan bisa diterima dengan **password** (selain Google)? | **Ya** — halaman undangan menawarkan "Masuk dengan Google" atau "Buat password"; keduanya hanya dengan token undangan yang masih berlaku |
| OD-079 ✅ DEC-029 | Sumber daftar password umum (AC-IAM-FR-003-1) | SecLists (MIT), dibundel; dipakai daftar NCSC 100k disaring ≥ 10 karakter (9.126 entri) |
| OD-080 ✅ DEC-029 | Siapa yang boleh mengubah kewajiban MFA per role | Tenant admin untuk role selain TENANT_ADMIN & MANAJER (keduanya selalu wajib); setiap perubahan diaudit. DOKTER wajib secara default (DEC-019) |
| OD-029 | Sesi aktif saat jam jaga berakhir | **Ditunda** bersama IAM-FR-012 (LJT, DEC-028) |

## 5. Gate Stage 6

- [ ] Test otomatis: setiap endpoint menolak user tanpa permission (matriks permission)
- [ ] Menu frontend bukan satu-satunya kontrol akses (dibuktikan dengan test API langsung)
- [ ] Status akun ditegakkan (nonaktif, terkunci) — jadwal login: LJT, tidak termasuk (DEC-028)
- [ ] ~~Delegasi kedaluwarsa otomatis~~ — LJT, tidak termasuk (DEC-028)
- [ ] S4-1: CI hijau di GitHub
- [ ] PO menyetujui Stage 6

## 6. Progres Batch 1

| Tanggal | Isi | Bukti |
|---|---|---|
| 4 Nov 2026 | **Anti-replay TOTP (RSK-024 ditutup):** migrasi 0007 `last_totp_step` (klinik & platform); kode dari periode yang sama/lebih lama ditolak; daftar ulang authenticator mengosongkan penanda. Uji integrasi kini memakai kode periode baru seperti pengguna sungguhan (`support/totp.ts`) | E34, P20, unit `totp.spec.ts`, mutasi M15 |
| 4 Nov 2026 | **Backend IAM:** migrasi 0008 (reset password, MFA dokter default, menu admin); endpoint undangan + terima dengan password, reset password (token dibuat worker saat kirim, 30 menit, sekali pakai, cabut semua sesi), user (daftar, undangan aktif, undang, nonaktif/aktifkan, cabut sesi), role (daftar, buat, ubah dengan If-Match; template hanya MFA; TENANT_ADMIN/MANAJER kunci MFA), permission, `GET /me/menu`, `POST /me/branch`, sesi saya. Kebijakan password (OD-079). Cegah eskalasi izin administratif. **Uji matriks permission** X01: 19 operasi terimplementasi → semua 403 untuk user tanpa izin | I01–I15, X01, unit `password-policy.spec.ts`, mutasi M16 (eskalasi → I04), M17 (token reset dipakai ulang → I06) |
| 4 Nov 2026 | **S4-1:** repo `AtoAIs/atoai-rme-v2` tersambung. Run CI pertama: 3 kegagalan diperbaiki di PR #1 (panjang tag AES-GCM eksplisit — temuan Semgrep publik; smoke compose memakai perawat karena dokter kini wajib MFA; uji mutasi dipindah ke job sendiri karena melebihi 25 menit). PR #1 hijau (`ci` termasuk E2E, `security`) dan di-merge | [PR #1](https://github.com/AtoAIs/atoai-rme-v2/pull/1) |
| 4 Nov 2026 | **Batch 2 — UI aplikasi klinik:** shell dengan menu samping dari `/me/menu` & pilih cabang aktif; halaman Pengguna (daftar, undangan aktif, undang, nonaktif/aktifkan, cabut sesi, reset MFA), Role & izin (role custom dengan matriks izin, MFA per role), Sesi & perangkat, Terima undangan (Google / buat password), Lupa & reset password. API tambahan: `/me` memuat cabang yang dapat dipilih; `DELETE /users/{id}/mfa`; migrasi 0009 menarik menu "Log audit" sampai halamannya ada | W07–W12 (E2E 22/22), I13, I16 |
