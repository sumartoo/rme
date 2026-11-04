# ADR-0004 — Transactional Outbox untuk Event & Integrasi

| | |
|---|---|
| Status | Accepted — disetujui PO 4 Nov 2026 (DEC-016) |
| Tanggal | 3 November 2026 |
| Menyelesaikan | OD-009 |
| Requirement | INT-FR-004, INT-FR-005, INT-FR-009, PHM-FR-008, CLN-FR-014, BIL-FR-006 |

## Konteks

Pengesahan rekam medis harus memicu beberapa efek: worklist farmasi, pengiriman SATUSEHAT, order lab, notifikasi. Efek eksternal tidak boleh hilang bila proses mati, dan tidak boleh terkirim bila transaksi utama gagal.

## Keputusan

1. **Outbox di PostgreSQL.** Use case menulis data domain + baris `outbox_event` dalam transaksi yang sama.
2. **Pemrosesan dengan pg-boss.** Worker mengambil event, menjalankan handler, dan menandai selesai. pg-boss memakai `SKIP LOCKED` sehingga worker dapat diskalakan.
3. **Handler idempoten.** Setiap pengiriman eksternal memakai idempotency key = `outbox_event.id`; status sinkronisasi per resource disimpan (`fhir_sync_record`, `lab_order`, `payment_gateway_txn`).
4. **Retry & dead-letter.** Backoff eksponensial; melewati batas → `integration_dead_letter` + notifikasi admin; kirim ulang manual teraudit.
5. **Efek internal sinkron.** Efek di dalam monolith yang wajib konsisten (mis. dispensing ⇒ baris invoice) dilakukan **dalam transaksi yang sama**, bukan lewat event.
6. **FHIR (OD-009):** ClinicRME **tidak** mengekspos FHIR API publik di MVP; hanya bertindak sebagai klien FHIR ke SATUSEHAT. Endpoint FHIR dapat ditambahkan via CR.

## Konsekuensi

- Event bersifat at-least-once; handler harus aman dijalankan ulang.
- Tabel `outbox_event` dipartisi/dibersihkan berkala (event selesai > 30 hari dihapus; tidak memuat PHI di luar ID referensi).
