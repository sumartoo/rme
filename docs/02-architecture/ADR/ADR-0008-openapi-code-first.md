# ADR-0008 — OpenAPI Code-First & Client Generation

| | |
|---|---|
| Status | Accepted — disetujui PO 4 Nov 2026 (DEC-016) |
| Tanggal | 3 November 2026 |

## Keputusan

1. Kontrak API didefinisikan di kode NestJS: Zod schema → DTO (`nestjs-zod`) → dekorator `@nestjs/swagger`.
2. CI menghasilkan `apps/api/openapi.json` dan membandingkannya dengan versi di `main`; perubahan breaking pada `/api/v1` menggagalkan pipeline kecuali disertai CR.
3. Client TypeScript untuk Next.js dibangkitkan dengan **orval** ke `libs/api-client` (hooks TanStack Query).
4. Di Stage 2, kontrak awal ditulis sebagai `api/openapi.yaml` (draft, design-first) untuk review; di Stage 4 implementasi mengikuti draft ini, lalu sumber kebenaran pindah ke kode.
5. Konvensi: RFC 9457 Problem Details, cursor pagination, `Idempotency-Key`, `If-Match`/`version`, path `/api/v1/...`.

## Konsekuensi
- Draft YAML Stage 2 dan hasil generate Stage 4 harus dibandingkan saat gate Stage 4.
