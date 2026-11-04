# CR-0002 — Kontrak API ekspor data tenant

| | |
|---|---|
| Diajukan oleh | Claude (tim pengembang) |
| Tanggal | 4 November 2026 |
| Prioritas | Sedang — bagian dari PLT-FR-008 (Stage 5 batch 3) |
| Status | **Disetujui** — DEC-026 (4 November 2026) |

## Perubahan yang diminta

Kontrak Stage 2 hanya punya `POST /tenant/exports` dan `GET /tenant/exports/{jobId}` dengan `downloadUrl` berupa signed URL. Diubah menjadi:

| Operasi | Isi |
|---|---|
| `POST /api/v1/tenant/exports` | Tetap (202). Tambahan: 409 `PLT-409-EXPORT-ACTIVE` bila masih ada ekspor yang diproses |
| `GET /api/v1/tenant/exports` | **Baru** — riwayat 20 ekspor terakhir |
| `GET /api/v1/tenant/exports/{jobId}` | Skema baru `TenantExportJob` (waktu, ukuran, sha256, jumlah tabel/baris) |
| `GET /api/v1/tenant/exports/{jobId}/key` | **Baru** — kunci dekripsi AES-256-GCM; setiap pengambilan diaudit |
| `GET /api/v1/tenant/exports/{jobId}/file` | **Baru** — unduh arsip lewat API; diaudit; 410 setelah kedaluwarsa |
| `PUT /api/v1/tenant/profile` | Tambahan: 428 bila `If-Match` tidak dikirim; `version` di respons; logo (`logoFileId`) baru dapat dipakai setelah unggah berkas (Stage 9) |

## Alasan

1. **Audit unduhan (AC-PLT-FR-008-2).** Dengan signed URL, browser mengunduh langsung dari Cloud Storage sehingga aplikasi tidak tahu kapan/siapa yang mengunduh. Lewat API, setiap unduhan tercatat di rantai audit tenant. Ini berbeda dari ADR-0013 §3 (signed URL) khusus untuk ekspor; dokumen medis tetap signed URL (Stage 9).
2. **Kunci terpisah dari berkas.** Arsip terenkripsi dan kuncinya diambil lewat dua permintaan berbeda, keduanya diaudit; berkas yang bocor sendirian tidak dapat dibuka.

## Analisis dampak

| Aspek | Dampak |
|---|---|
| Scope | Tidak ada fitur baru di luar PLT-FR-008 |
| Keamanan | Positif: setiap akses teraudit; kunci terpisah; konsol platform tidak dapat membaca kunci (T32e, K08) |
| Biaya | Unduhan melewati API (bandwidth Cloud Run). Untuk ekspor besar dievaluasi di Stage 15 |
| Test | K04–K09, T32, mutasi M11, uji kontrak |

## Keputusan PO

| Keputusan | Tanggal | Catatan |
|---|---|---|
| | | |
