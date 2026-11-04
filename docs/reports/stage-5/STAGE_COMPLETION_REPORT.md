# Stage 5 — Stage Completion Report

| | |
|---|---|
| Stage | 5 — SaaS Administration & Tenant Management |
| Status | **APPROVED WITH NOTES** — 4 Nov 2026 (DEC-028) |
| Disusun oleh | Sumarto (dibantu Claude) |
| Rincian | [STAGE_PLAN.md](STAGE_PLAN.md) §5–§9 (batch 1, 2, 3a, 3b, 4) |

## 1. Ringkasan

Platform SaaS siap dipakai untuk pilot dengan data sintetis:
- **Konsol platform** (`admin.<domain>`, identitas terpisah, TOTP wajib): buat tenant, status & histori, paket & kuota, feature flag, akses dukungan darurat (break-glass) yang diberitahukan ke admin klinik.
- **Aplikasi klinik** (`<kode>.<domain>`): login + TOTP, profil & kop klinik, ekspor seluruh data terenkripsi.
- **Worker**: ekspor data, email undangan & notifikasi break-glass lewat outbox.

| Metrik | Nilai |
|---|---|
| Uji integrasi API | 93/93 (E · F · C · P · K · B · N) |
| Uji SQL skema | 88 |
| Unit test | 68 (termasuk kontrak OpenAPI) |
| E2E browser | 16/16 (konsol U01–U10, klinik W01–W06) |
| Uji mutasi | 14/14 terdeteksi |
| Pemindaian (gitleaks, detect-secrets, Semgrep, pnpm audit, actionlint) | 0 temuan |
| Temuan keamanan diperbaiki di stage ini | 3 (RLS `tenant_feature_flag`, daftar ulang TOTP tanpa MFA, `SMTP_URL` kosong) + 1 tercatat (RSK-024) |

## 2. Checklist Gate

| Item | Status | Bukti |
|---|---|---|
| Siklus status tenant lengkap teruji (sah & tidak sah) | ✅ | P07 (36 pasangan), P10, P13, U04 |
| Kuota ditegakkan di backend (user & cabang) | ✅ | P16, mutasi M9 |
| Platform tidak dapat mengakses endpoint/tabel klinis | ✅ | P04, P15, B08, T27, mutasi M6 |
| Isolasi lintas tenant teruji di setiap endpoint baru | ✅ | K03/K06, B05, W06, T34, mutasi M2/M11/M14 |
| Ekspor tenant menghasilkan arsip lengkap & terenkripsi | ✅ | K05, W04 |
| S4-1: CI hijau di GitHub | ❌ → dipindah | Repo GitHub belum dibuat; dipindah ke sebelum gate Stage 6 (DEC-028) |
| PO menyetujui Stage 5 | ✅ | Dengan catatan (DEC-028) |

## 3. Syarat Terbuka

| # | Syarat | Butuh dari PO | Batas |
|---|---|---|---|
| S4-1 | Workflow `ci` & `security` hijau di GitHub (termasuk `compose`, `images`, E2E) | Repo GitHub private + push; ganti nama `_github` → `.github` | **Sebelum gate Stage 6** (dipindah dari gate Stage 5, DEC-028) |
| S4-2 | Deploy otomatis ke dev | Project GCP + billing, OAuth client dev | Sebelum demo pilot; paling lambat gate Stage 8 |
| OD SMTP | Penyedia SMTP untuk dev/prod | Pilihan penyedia (bisa berbayar → perlu persetujuan) | Sebelum pilot |

## 4. Keputusan Stage 5

DEC-024 (urutan batch), DEC-025 (CR-0001, OD-027/028/075/076), DEC-026 (CR-0002, OD-077), DEC-027 (batch 4), DEC-028 (persetujuan stage).

## 5. Persetujuan

| Peran | Nama | Keputusan | Tanggal | Catatan |
|---|---|---|---|---|
| Project Owner | Sumarto | ☑ Approved with notes | 4 Nov 2026 | "lanjutkan ke stage selanjut nya" (18:58 WIB), lalu memilih "Setujui dgn catatan": S4-1 dipindah ke sebelum gate Stage 6 |
