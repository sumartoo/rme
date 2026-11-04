# Stage 3 — Stage Plan

| | |
|---|---|
| Stage | 3 — Security, Privacy & Compliance Foundation |
| Status | APPROVED — 4 Nov 2026 (DEC-020) |
| Mulai | 4 November 2026 |
| Pendekatan | Desain kontrol + proof-of-concept; implementasi final di Stage 4 (DEC-008) |
| Project Owner | Sumarto |

## 1. Tujuan

Menetapkan dan membuktikan kontrol keamanan & privasi inti sebelum data klinis apa pun disimpan.

## 2. Deliverable

| # | Deliverable | Lokasi | Batch | Status |
|---|---|---|---|---|
| 1 | Threat model (STRIDE) | `docs/03-security/THREAT_MODEL.md` | 1 | ✅ Draft — 28 ancaman |
| 2 | Security controls catalogue | `docs/03-security/SECURITY_CONTROLS.md` | 1 | ✅ v0.2 — 63 kontrol (status dari PoC; + SC-FIN-01..04) |
| 3 | Permission matrix + role template + seed SQL | `docs/03-security/PERMISSION_MATRIX.md`, `db/seed/` | 1 | ✅ Dibangkitkan & diuji |
| 4 | Audit policy | `docs/03-security/AUDIT_POLICY.md` | 1 | ✅ Draft |
| 5 | Privacy & PDP (UU 27/2022, PP 33/2026) | `docs/03-security/PRIVACY_AND_PDP.md` | 2 | ✅ Draft (+ outline DPA) |
| 6 | Data retention policy | `docs/03-security/DATA_RETENTION_POLICY.md` | 2 | ✅ Draft |
| 7 | HIPAA Security Rule gap assessment | `docs/03-security/HIPAA_GAP_ASSESSMENT.md` | 2 | ✅ Draft |
| 8 | Incident response plan | `docs/03-security/INCIDENT_RESPONSE_PLAN.md` | 2 | ✅ Draft |
| 9 | PoC: auth (Google OIDC, password, TOTP, sesi), TenantGuard + `withTenantTx`, PermissionGuard, audit | `poc/stage-3/` | 3 | ✅ |
| 10 | Uji PoC (e2e terhadap PostgreSQL) + bukti | `docs/reports/stage-3/evidence/` | 3 | ✅ 33/33 lulus + 4 uji mutasi |
| 11 | Stage Completion Report | `docs/reports/stage-3/` | Akhir | ✅ READY_FOR_REVIEW |

## 3. Gate Stage 3

- [x] Threat model direview; semua ancaman skor ≥ 15 memiliki kontrol; referensi kontrol divalidasi otomatis (temuan: SC-FIN-01..04 belum ada di katalog → ditambahkan)
- [x] Uji isolasi tenant pada skema lulus (diulang dengan perubahan skema Stage 3 — 46 lulus)
- [x] Uji isolasi tenant melalui API (PoC) lulus — E05, E06, E10–E13, E30
- [x] RLS gagal-aman tanpa tenant context — skema (T01) dan PoC (E13); mutasi M2 (BYPASSRLS) terdeteksi
- [x] MFA aktif untuk akun admin (PoC) — E07–E09, E14b, E32
- [x] Audit chain terverifikasi; upaya update/delete ditolak (T20–T22)
- [x] Tidak ada secret di repository (secret scanning — 0 temuan)
- [x] HIPAA gap assessment selesai (bukan klaim kepatuhan)
- [x] PO menyetujui Stage 3 (DEC-020)

## 4. Open Decision Stage 3

| OD | Pertanyaan | Usulan |
|---|---|---|
| OD-011 | CMEK untuk Cloud SQL & GCS | Tidak di MVP (enkripsi Google default + enkripsi kolom NIK via Cloud KMS); evaluasi ulang untuk tenant enterprise |
| OD-023 | Masa simpan audit log | Sama dengan retensi rekam medis (≥ 25 tahun) untuk audit akses RM; 2 tahun untuk audit login non-klinis |
| OD-024 | MFA dokter | Opsional per tenant; wajib bila tenant mengaktifkan |
| OD-066 | Pemindaian malware unggahan | Validasi tipe & ukuran di MVP; pemindaian malware sebelum produksi (Stage 15) |
