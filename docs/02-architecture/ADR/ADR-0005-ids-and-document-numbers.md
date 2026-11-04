# ADR-0005 — Strategi ID & Nomor Dokumen Bisnis

| | |
|---|---|
| Status | Accepted — disetujui PO 4 Nov 2026 (DEC-016) |
| Tanggal | 3 November 2026 |
| Requirement | GEN-FR-006, AC-GEN-FR-006-1, SCH-FR-007 |

## Keputusan

### Primary key
- `uuid` untuk semua tabel, dibuat di aplikasi dengan **UUIDv7** (berurutan waktu → index B-tree tetap efisien).
- Default DB `gen_random_uuid()` sebagai cadangan.
- ID tidak pernah ditampilkan ke pengguna sebagai nomor bisnis.

### Nomor dokumen bisnis
Nomor yang dilihat manusia (MRN, nomor kunjungan, resep, invoice, kwitansi, surat, refund) dibuat dari tabel `document_sequence`:

| Kolom | Arti |
|---|---|
| `tenant_id`, `doc_type`, `scope_key` | Kunci counter; `scope_key` mis. `branch:<id>:2026` |
| `next_value` | Nilai berikutnya |
| `pattern` | Mis. `INV/{BRANCH}/{YYYY}{MM}/{SEQ:5}` |

Pengambilan nomor: `UPDATE ... SET next_value = next_value + 1 RETURNING` dalam transaksi yang sama dengan dokumen → atomik, bebas duplikat, bebas celah selama transaksi tidak gagal.

### Nomor antrean
Tabel terpisah `queue_counter (tenant_id, branch_id, unit_id, queue_date)` dengan mekanisme yang sama; reset harian karena kunci memuat tanggal.

## Konsekuensi
- Celah nomor dapat terjadi bila transaksi rollback setelah mengambil nomor; untuk invoice hal ini dicatat (dokumen VOID tetap memakai nomornya). Kebutuhan bebas-celah ketat (mis. pajak) ditinjau di OD-040.
- Counter per tenant/cabang tidak menjadi bottleneck pada skala klinik.
