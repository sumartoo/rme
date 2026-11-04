# @clinicrme/ui (type:ui, scope:web)

Komponen UI bersama (ADR-0010): gaya shadcn/ui + Tailwind CSS 4, kode di repo sendiri.
Dipakai `apps/platform-admin` (Stage 5) dan `apps/web` (Stage 6).

- **Aman untuk CSP ketat (SC-WEB-01):** tidak ada `<style>` atau atribut `style` yang disisipkan saat runtime.
  Karena itu Dialog memakai elemen `<dialog>` bawaan dan Select memakai `<select>` bawaan. Primitive Radix
  dipakai bila komponennya bisa berjalan dengan nonce CSP.
- Token warna & tipografi ada di `src/styles.css` (`@theme`). Aplikasi mengimpornya dan menambah `@source` ke folder ini.
- Tidak ada akses data/HTTP di sini: komponen murni presentasi.
