# ADR-0012 — Reporting: Read Replica dengan RLS

| | |
|---|---|
| Status | Accepted — disetujui PO 4 Nov 2026 (DEC-016) |
| Tanggal | 3 November 2026 |
| Menyelesaikan | OD-047 |
| Requirement | RPT-FR-001..009, NFR-PERF-005 |

## Keputusan

1. **MVP:** laporan standar dijalankan langsung di database utama dengan role `clinicrme_readonly`, `statement_timeout` 30 detik, dan index yang dirancang untuk laporan. Laporan berat & export → job asinkron di worker.
2. **Saat beban naik (atau mulai Stage 14 report builder):** Cloud SQL read replica; worker reporting diarahkan ke replica. RLS tetap berlaku karena replica memakai skema & policy yang sama.
3. Tidak membuat data warehouse terpisah di versi pertama.

## Konsekuensi
- Replica memiliki jeda replikasi; laporan menampilkan "data per pukul HH:MM".
- Read replica menambah biaya → aktifkan berdasarkan metrik (Stage 15).
