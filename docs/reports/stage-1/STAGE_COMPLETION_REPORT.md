# Stage 1 — Stage Completion Report

| | |
|---|---|
| Stage | 1 — Requirements & Business Analysis |
| Status | **APPROVED** — 3 Nov 2026 |
| Tanggal | 3 November 2026 |
| Disusun oleh | Sumarto (dibantu Claude) |

## 1. Ringkasan

Requirement bisnis dan klinis ClinicRME sudah terdokumentasi lengkap dan dapat ditelusuri:

| Metrik | Nilai |
|---|---|
| Requirement total | 223 (189 fungsional, 34 non-fungsional) |
| MVP / Lanjutan | 181 / 42 |
| Requirement MVP dengan acceptance criteria | **181 / 181** (NFR memakai target angka sebagai AC) |
| Acceptance criteria | 175 butir untuk requirement fungsional MVP |
| Use case | 51 (8 dirinci dengan alur utama & alternatif) |
| Workflow | 15 (WF-01 s.d. WF-15) |
| Requirement bertanda `[REVIEW-MEDIS]` | 19 |
| Istilah glossary | 48 |

## 2. Deliverable

| Deliverable | Lokasi |
|---|---|
| SRS | `docs/01-requirements/SRS.md` |
| Workflows | `docs/01-requirements/WORKFLOWS.md` |
| Use cases | `docs/01-requirements/USE_CASES.md` |
| Acceptance criteria | `docs/01-requirements/ACCEPTANCE_CRITERIA.md` |
| NFR | `docs/01-requirements/NFR.md` |
| RTM | `docs/01-requirements/REQUIREMENT_TRACEABILITY_MATRIX.md` |
| Glossary | `docs/01-requirements/GLOSSARY.md` |
| Generator RTM | `tools/gen_rtm.py` |

## 3. Perubahan File

- **Ditambahkan:** 7 dokumen di `docs/01-requirements/`, `tools/gen_rtm.py`, Stage Plan & laporan ini.
- **Kode / migration / test aplikasi:** tidak ada (stage dokumentasi).

## 4. Verifikasi

Pengecekan otomatis oleh `tools/gen_rtm.py` (dijalankan 3 Nov 2026):

| Cek | Hasil |
|---|---|
| ID requirement duplikat | 0 |
| Requirement MVP tanpa acceptance criteria | 0 |
| Requirement fungsional MVP tanpa use case | 0 |
| Referensi use case ke ID yang tidak ada | 0 |
| Referensi AC ke ID yang tidak ada | 0 |

Cara menjalankan ulang setelah mengubah SRS/NFR/USE_CASES/AC:

```bash
python3 tools/gen_rtm.py docs/01-requirements
```

**Belum diverifikasi:** kebenaran klinis 19 requirement `[REVIEW-MEDIS]` dan workflow WF-01, 06, 11, 12 — menunggu review tenaga medis (DEC-005). Requirement belum divalidasi oleh klinik pilot (RSK-016).

## 5. Keputusan yang Dibutuhkan dari Project Owner

| # | Keputusan | Usulan |
|---|---|---|
| 1 | Setujui pembagian MVP / Lanjutan di SRS | Sesuai draft (Android pasien & BPJS = Lanjutan) |
| 2 | OD-008 — urutan farmasi ↔ kasir | Farmasi → kasir, dapat dikonfigurasi per tenant |
| 3 | OD-015 / OD-016 — SLA & RPO/RTO | 99,5% · RPO 15 menit · RTO 4 jam |
| 4 | OD-063 — tagihan resep parsial | Ditagih sesuai jumlah yang diserahkan |
| 5 | OD-064 — penyetuju substitusi bila dokter penulis resep tidak ada | Dokter lain yang sedang bertugas di cabang yang sama |
| 6 | OD-065 — penagihan lab | Dapat dikonfigurasi: ditagih kasir klinik (default) atau oleh lab |
| 7 | OD-022 — pasien lintas cabang dalam satu tenant | Ya |
| 8 | Nilai default di AC (lockout 5×/15 menit, password ≥ 10 karakter, auto no-show 60 menit, peringatan kedaluwarsa 90 hari, undangan 7 hari, reset 30 menit) | Setujui sebagai default yang dapat diatur tenant |

## 6. Risiko & Isu Terbuka

- **RSK-006 (skor 20):** belum ada review tenaga medis.
- **RSK-016:** belum ada klinik pilot untuk validasi requirement.
- OD-030 (sumber ICD), OD-031 (KFA), OD-039 (payment gateway), OD-059 (vendor lab) harus diputuskan sebelum stage terkait.

## 7. Checklist Gate Stage 1

- [x] WF-01 s.d. WF-15 terdokumentasi
- [x] WF-01 s.d. WF-15 **disetujui** PO
- [x] Setiap requirement memiliki ID & prioritas
- [x] Setiap requirement MVP memiliki acceptance criteria
- [x] RTM berisi semua requirement
- [x] Requirement `[REVIEW-MEDIS]` teridentifikasi
- [x] NFR memiliki angka target yang disetujui (DEC-014)
- [x] Pembagian MVP / Lanjutan disetujui (DEC-012)
- [x] Project Owner menyetujui Stage 1 (DEC-015)

## 8. Persetujuan

| Peran | Nama | Keputusan | Tanggal | Catatan |
|---|---|---|---|---|
| Project Owner | Sumarto | ☑ Disetujui | 3 Nov 2026 | Semua usulan §5 disetujui. Review medis tetap wajib sebelum gate Stage 9. |
