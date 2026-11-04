# ADR-0013 — Penyimpanan Dokumen & Berkas

| | |
|---|---|
| Status | Accepted — disetujui PO 4 Nov 2026 (DEC-016) |
| Tanggal | 3 November 2026 |
| Requirement | DOC-FR-001..003, PLT-FR-008, NFR-RET-001 |

## Keputusan

1. Berkas (PDF dokumen medis, unggahan, ekspor tenant) disimpan di **Cloud Storage**; database hanya menyimpan metadata (`stored_file`).
2. Path objek: `tenants/{tenant_id}/{kategori}/{yyyy}/{mm}/{file_id}` — nama berkas asli tidak dipakai di path.
3. Bucket: uniform bucket-level access, tanpa akses publik; unduh/unggah hanya via **signed URL** berumur ≤ 5 menit yang dibuat setelah pemeriksaan permission.
4. Dokumen medis yang diterbitkan disimpan sekali dan tidak dibuat ulang (DOC-FR-002); `stored_file.sha256` dicatat.
5. Object versioning aktif pada bucket dokumen medis; retention policy ditetapkan sesuai kebijakan retensi (≥ 25 tahun untuk dokumen rekam medis, REG-03) dengan storage class bertahap (Standard → Coldline/Archive) melalui lifecycle rule.
6. Ekspor tenant: bucket terpisah dengan lifecycle hapus otomatis 7 hari.
7. Unggahan dipindai tipe & ukuran (PDF/JPG/PNG, ≤ 10 MB); pemindaian malware: OD-066.

## Konsekuensi
- Biaya penyimpanan jangka panjang perlu masuk model harga (RSK-011).
