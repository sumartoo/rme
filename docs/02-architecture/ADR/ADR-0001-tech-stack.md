# ADR-0001 — Stack Teknologi: NestJS + Next.js + PostgreSQL

| | |
|---|---|
| Status | Accepted — disetujui PO 3 Nov 2026 |
| Tanggal | 3 November 2026 |
| Menggantikan | Stack di Roadmap v1.0 (Spring Boot + Angular) |

## Konteks

Roadmap v1.0 menetapkan Java Spring Boot + Angular. Tim pengembang utama lebih kuat di TypeScript, React/Next.js, dan Node.js. Satu bahasa di backend dan frontend mengurangi biaya konteks, memungkinkan berbagi tipe & schema validasi, serta mempercepat MVP.

## Keputusan

| Lapisan | Pilihan |
|---|---|
| Backend | Node.js LTS + NestJS (TypeScript strict), modular monolith |
| Worker | Aplikasi NestJS standalone terpisah, antrean **pg-boss** di PostgreSQL |
| Web | Next.js App Router — hanya UI, tanpa akses DB langsung |
| Database | PostgreSQL + Row-Level Security |
| Query & migrasi | Drizzle ORM + Drizzle Kit (SQL ber-versi); Kysely sebagai alternatif (OD-054) |
| Validasi | Zod |
| OpenAPI | `@nestjs/swagger` (code-first) → client via orval |
| Monorepo | Nx + pnpm, `@nx/enforce-module-boundaries` sebagai penegak batas modul |
| Android | Kotlin + Jetpack Compose (tidak berubah) |

## Alasan Pemilihan Detail

- **Bukan Prisma:** RLS mengharuskan `set_config('app.tenant_id', ..., true)` dijalankan di koneksi & transaksi yang sama dengan query. Di Drizzle/Kysely transaksi eksplisit membuat ini sederhana dan dapat diuji; di Prisma memerlukan extension + interactive transaction yang lebih rawan terlewat.
- **pg-boss, bukan BullMQ:** tidak menambah Redis (biaya & komponen operasional), dan job dapat dibuat dalam transaksi yang sama dengan data (cocok untuk outbox).
- **Next.js tanpa akses DB:** satu titik otorisasi & audit di NestJS.

## Konsekuensi

**Positif**
- Satu bahasa, tipe DTO & schema Zod dapat dibagi.
- Rekrutmen & kecepatan pengembangan lebih baik untuk tim TypeScript.

**Negatif / mitigasi**
| Risiko | Mitigasi |
|---|---|
| Node single-thread — pekerjaan berat memblokir API | PDF, export, integrasi di worker terpisah |
| `numeric` uang terbaca sebagai string | Tipe `Money` di `libs/shared` berbasis `decimal.js`; lint melarang `Number()` pada kolom uang |
| Validator FHIR resmi berbasis Java | Jalankan HL7 Validator sebagai container di CI/test; produksi mengandalkan validasi sandbox/endpoint SATUSEHAT |
| Ekosistem modular kurang ketat dibanding Spring Modulith | Nx module boundaries + test arsitektur sederhana |

## Tindak Lanjut

- Catat di `00-governance/DECISION_LOG.md` sebagai perubahan terhadap Roadmap v1.0.
- Perbarui `ROADMAP.md` (Stage 0) bagian stack.
