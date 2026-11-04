# ADR-0009 — Repository Layout

| | |
|---|---|
| Status | Accepted — digabung ke ADR-0001 |
| Tanggal | 3 November 2026 |
| Menyelesaikan | OD-004 |

Keputusan monorepo Nx + pnpm dan struktur `apps/`, `libs/`, `db/`, `android/`, `infra/`, `docs/`, `tools/` sudah ditetapkan di ADR-0001 dan APP_DESIGN §3.5. ADR ini hanya mencatat bahwa OD-004 telah diselesaikan.

Tambahan dari Stage 2:

| Folder | Isi |
|---|---|
| `db/schema/` | DDL kanonik per modul (urutan berdasarkan prefix angka), sumber kebenaran desain di Stage 2 |
| `db/tests/` | Uji SQL untuk RLS, immutability, audit chain |
| `api/openapi.yaml` | Draft kontrak API (Stage 2) |
| `tools/` | Skrip pendukung dokumentasi (RTM, data dictionary) |

Di Stage 4, `db/schema/` diterjemahkan menjadi skema Drizzle + migrasi awal; file migrasi yang dihasilkan harus identik secara struktur dengan `db/schema/` (diverifikasi dengan diff skema).
