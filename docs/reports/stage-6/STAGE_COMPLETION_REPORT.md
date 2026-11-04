# Stage 6 — Stage Completion Report

| | |
|---|---|
| Stage | 6 — Identity, Role, Permission & Dynamic Menu |
| Status | **MENUNGGU PERSETUJUAN PO** |
| Disusun oleh | Sumarto (dibantu Claude) |
| Rincian | [STAGE_PLAN.md](STAGE_PLAN.md) §6 |

## 1. Ringkasan

Admin klinik kini mengelola pengguna, role, dan izin sendiri dari aplikasi klinik; setiap pengguna hanya melihat menu dan memanggil
endpoint sesuai izinnya di cabang aktif — penegakannya di backend, dibuktikan uji matriks permission. Repo GitHub tersambung
dan CI hijau (S4-1 tertutup).

| Metrik | Nilai |
|---|---|
| Uji integrasi API | 113/113 (I01–I17 & X01 baru, E33–E34, P20) |
| Uji matriks permission (X01) | 19+ operasi terimplementasi → semua 403 untuk user tanpa izin |
| E2E browser | 22/22 (konsol U01–U10, klinik W01–W12) |
| Uji mutasi | 17/17 terdeteksi (di GitHub Actions) |
| Uji SQL | 88 |
| Temuan keamanan diperbaiki | 4 — replay TOTP (RSK-024), daftar ulang TOTP tanpa MFA, panjang tag AES-GCM (Semgrep), RLS feature flag (Stage 5) |

## 2. Requirement MVP

| ID | Status | Bukti |
|---|---|---|
| IAM-FR-001 undangan | ✅ | I01–I03, W08–W09 |
| IAM-FR-002 Google OIDC | ✅ (Stage 3) + tautan nakes & cabang dari undangan | E-series |
| IAM-FR-003 password & lockout | ✅ kebijakan ≥ 10 karakter + 9.126 password umum | I03, I06, E04 |
| IAM-FR-004 reset password | ✅ | I05–I07, W11 |
| IAM-FR-005 MFA admin & dokter (default) | ✅ MFA per role, anti-replay, reset MFA oleh admin | I09, I16, E34, W10 |
| IAM-FR-007/008 role template & custom | ✅ | I08–I10, W10 |
| IAM-FR-009 cabang aktif | ✅ | I13, W07 |
| IAM-FR-010 menu dinamis | ✅ | I12, W05, W07 |
| IAM-FR-011 backend memeriksa izin | ✅ | X01 |
| IAM-FR-013 sesi | ✅ | I14–I15, W12 |
| IAM-FR-014 nonaktif mencabut sesi | ✅ | E19, I15, W12 |
| IAM-FR-016 tautan nakes | ✅ tautan; pemeriksaan SIP saat tanda tangan → Stage 9 | I17 |
| IAM-FR-006, 012, 015 | LJT — tidak termasuk (DEC-010, DEC-028) | |

## 3. Checklist Gate

Lihat [STAGE_PLAN §5](STAGE_PLAN.md): semua butir terpenuhi kecuali persetujuan PO.

## 4. Catatan untuk Stage berikutnya

- Pemilihan tenaga kesehatan saat mengundang dokter muncul di UI setelah daftar nakes ada (Stage 7, master data).
- Menu "Log audit" ditarik (migrasi 0009) sampai halaman pencarian audit dibangun.
- Uji mutasi ±60 menit (menunggu periode TOTP) — jalan di main, mingguan, dan manual; tidak per PR.
- Syarat terbuka dari Stage 4: **S4-2** deploy dev (project GCP) sebelum gate Stage 8.

## 5. Persetujuan

| Peran | Nama | Keputusan | Tanggal | Catatan |
|---|---|---|---|---|
| Project Owner | Sumarto | ☐ Menunggu | | |
