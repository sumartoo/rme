# ADR-0006 — Immutability Rekam Medis & Transaksi

| | |
|---|---|
| Status | Accepted — disetujui PO 4 Nov 2026 (DEC-016) |
| Tanggal | 3 November 2026 |
| Requirement | GEN-FR-003, CLN-FR-017, CLN-FR-019, BIL-FR-009, BIL-FR-010, PHM-FR-004 |

## Keputusan

Kontrol berlapis — aplikasi **dan** database.

| Objek | Menjadi immutable saat | Koreksi melalui |
|---|---|---|
| `clinical_note` (+ diagnosis, tindakan, vital, resep pada encounter tsb.) | `status = 'SIGNED'` | `clinical_addendum` |
| `clinical_addendum` | Saat dibuat (`signed_at` terisi) | Addendum baru |
| `invoice` | `status` ≠ `DRAFT` | Void (approval) + invoice baru |
| `payment` | Saat dibuat | `refund` |
| `refund` | `status = 'APPROVED'` | Tidak dapat dikoreksi; refund baru bila perlu |
| `stock_movement` | Saat dibuat | Movement penyesuaian |
| `audit_log` | Saat dibuat | — |

### Penegakan di database
- Trigger `BEFORE UPDATE OR DELETE` menolak perubahan pada baris yang sudah final. Hanya kolom status tertentu yang boleh berubah (mis. invoice `ISSUED → PAID/VOID`), divalidasi di trigger.
- Tabel append-only (`payment`, `stock_movement`, `audit_log`): role aplikasi tidak memiliki hak `UPDATE`/`DELETE` sama sekali.
- `clinical_note.content_hash` = SHA-256 isi kanonik saat pengesahan.

### Penegakan di aplikasi
- Use case memeriksa status sebelum menulis dan mengembalikan error domain yang jelas (`CLN-409-SIGNED`).

## Konsekuensi
- Perbaikan data produksi oleh developer pun harus lewat mekanisme koreksi; tidak ada "UPDATE manual".
- Test: setiap trigger diuji dengan upaya update/delete langsung (`db/tests/`).
