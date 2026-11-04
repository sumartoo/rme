# ADR-0010 — UI Library Web: shadcn/ui + Tailwind CSS

| | |
|---|---|
| Status | Accepted — disetujui PO 4 Nov 2026 (DEC-016) |
| Tanggal | 3 November 2026 |
| Menyelesaikan | OD-013, OD-046 |

## Keputusan

| Kebutuhan | Pilihan |
|---|---|
| Komponen | shadcn/ui (Radix primitives, kode disalin ke `libs/ui`, tanpa lisensi berbayar) |
| Styling | Tailwind CSS |
| Tabel data | TanStack Table |
| Form | React Hook Form + Zod |
| Chart (dashboard & laporan) | Recharts |
| Ikon | lucide-react |
| Tanggal | date-fns dengan locale `id` |

Alasan: komponen berada di repo sendiri (bisa disesuaikan untuk kebutuhan klinik seperti keyboard shortcut & kepadatan tinggi), aksesibilitas baik dari Radix, tanpa biaya lisensi.

## Konsekuensi
- **Catatan Stage 5 (CSP):** primitive Radix yang menyisipkan `<style>`/atribut style saat runtime (Dialog, Select, Popover melalui react-remove-scroll) bertentangan dengan CSP bernonce tanpa `unsafe-inline` (SC-WEB-01). `libs/ui` memakai `<dialog>`/`<select>` bawaan untuk itu; Radix dipakai bila komponennya bisa berjalan dengan nonce. Tabel sederhana memakai komponen `Table`; TanStack Table saat butuh sortir/filter.
- Desain sistem visual (warna, tipografi, kepadatan) ditetapkan sekali di `libs/ui` pada Stage 4.
