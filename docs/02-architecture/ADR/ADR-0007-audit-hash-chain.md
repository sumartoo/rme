# ADR-0007 — Audit Log Append-Only dengan Hash Chain

| | |
|---|---|
| Status | Accepted — disetujui PO 4 Nov 2026 (DEC-016) |
| Tanggal | 3 November 2026 |
| Requirement | AUD-FR-001..004, GEN-FR-002, NFR-AUD-001 |

## Keputusan

1. Tabel `audit_log` dipartisi per bulan (`PARTITION BY RANGE (occurred_at)`).
2. Role aplikasi hanya `INSERT` & `SELECT`.
3. Setiap entri memiliki `seq` per tenant (bigint berurutan), `prev_hash`, dan `hash = sha256(prev_hash || kanonik(entri))`.
4. Penulisan entri dilakukan oleh fungsi `app.write_audit(...)` yang mengunci baris `audit_chain_head` per tenant (`SELECT ... FOR UPDATE`) untuk menjamin urutan; fungsi berjalan dalam transaksi use case sehingga audit dan data domain commit/rollback bersama.
5. Audit **baca** rekam medis ditulis secara asinkron (batch) agar tidak memperlambat layar; tetap masuk hash chain.
6. Job harian memverifikasi chain per tenant; ketidakcocokan memicu alert keamanan.
7. Isi audit tidak memuat PHI mentah: hanya ID resource dan daftar field yang berubah (nilai before/after untuk master data non-PHI).

## Konsekuensi
- Kunci per tenant men-serialisasi penulisan audit dalam satu tenant; diterima pada skala klinik. Bila menjadi bottleneck → ADR baru (mis. chain per menit).
- Masa simpan audit: OD-023 — diputuskan di DEC-019 (lihat AUDIT_POLICY §6).
