# Stage Gate Policy — ClinicRME SaaS

| | |
|---|---|
| Versi | 0.1 — DRAFT untuk persetujuan |
| Tanggal | 3 November 2026 |

## 1. Prinsip

1. Pengembangan berjalan berurutan melalui stage gate.
2. Hanya **satu stage aktif** pada satu waktu.
3. Stage berikutnya tidak dimulai sebelum stage aktif **disetujui secara eksplisit** oleh Project Owner.
4. Requirement yang telah disetujui tidak diubah tanpa Change Request.
5. Requirement yang ambigu dicatat sebagai **OPEN DECISION**, tidak ditebak.
6. Tidak ada klaim "test lulus" tanpa test dijalankan dan buktinya disimpan.
7. Tidak ada klaim kepatuhan (HIPAA, FHIR, SATUSEHAT, PDP) tanpa bukti validasi.

## 2. Siklus Stage

```
NOT_STARTED → PLANNING → IN_PROGRESS → READY_FOR_REVIEW → APPROVED
                                  ↑             │
                                  └── REVISION ←┘  (PO meminta perbaikan)
```

| Status | Masuk bila | Keluar bila |
|---|---|---|
| PLANNING | Stage sebelumnya APPROVED | Stage Plan disetujui PO |
| IN_PROGRESS | Stage Plan disetujui | Seluruh deliverable selesai |
| READY_FOR_REVIEW | Stage Completion Report diserahkan | PO memutuskan |
| REVISION | PO meminta perbaikan | Perbaikan diserahkan ulang |
| APPROVED | PO menyetujui secara tertulis | — |

## 3. Stage Plan (awal stage)

Dibuat di `docs/reports/stage-N/STAGE_PLAN.md`, berisi: tujuan, scope, requirement ID yang dicakup, deliverable, estimasi, risiko, open decision yang harus diputuskan, dan kriteria gate.

## 4. Definition of Done (setiap stage)

1. Stage Plan dan scope disetujui.
2. Requirement ID dan acceptance criteria tersedia.
3. Implementasi sesuai requirement.
4. Unit, integration, regression, dan security test yang relevan dijalankan.
5. Test Report dengan bukti hasil (log CI, screenshot, laporan).
6. Dokumentasi arsitektur, database, dan API diperbarui.
7. Daftar defect dan risiko yang masih terbuka.
8. Security review.
9. Stage Completion Report.
10. Persetujuan eksplisit Project Owner.

Untuk stage dokumentasi (0–2), butir 3–5 dan 8 berlaku sebatas relevan (mis. review dokumen, bukan test kode).

## 5. Stage Completion Report

Lokasi: `docs/reports/stage-N/STAGE_COMPLETION_REPORT.md`. Isi minimum:

- Ringkasan hasil
- Daftar deliverable & lokasinya
- Perubahan file, migration, test
- Hasil test & bukti
- Requirement Traceability Matrix yang diperbarui
- Defect & risiko terbuka
- Open decision yang sudah/belum diputuskan
- Keputusan yang dibutuhkan dari PO
- Checklist gate

## 6. Bentuk Persetujuan

Persetujuan dianggap sah bila tercatat tertulis: tanda tangan / isian pada bagian persetujuan Stage Completion Report, **atau** pesan tertulis PO (email/chat) yang dirujuk di `DECISION_LOG.md`.

| Keputusan | Arti |
|---|---|
| Disetujui | Stage ditutup; stage berikutnya boleh dimulai |
| Disetujui dengan catatan | Stage ditutup; catatan menjadi item tindak lanjut yang dilacak di stage berikutnya |
| Revisi | Stage kembali ke REVISION |
| Ditolak | Stage dievaluasi ulang; mungkin memerlukan CR terhadap scope |

## 7. Pengecualian

Pekerjaan di luar stage aktif hanya boleh berupa: perbaikan keamanan kritis, perbaikan defect pada stage yang sudah APPROVED, atau spike/PoC yang disetujui PO dan tidak masuk ke cabang utama. Semua pengecualian dicatat di Decision Log.
