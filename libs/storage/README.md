# @clinicrme/storage (type:util)

Penyimpanan objek (ADR-0013) tanpa SDK berat: driver `gcs` (Cloud Storage JSON API via `fetch`; token dari
metadata server di Cloud Run, tanpa auth untuk emulator `fake-gcs-server`) dan driver `fs` (folder lokal, **hanya**
`APP_ENV=local/test`). Dua bucket logis: `files` (dokumen/branding) dan `exports` (ekspor tenant, lifecycle 7 hari).
Path objek divalidasi ketat — tidak ada `..`, tidak ada nama berkas asli (ADR-0013 §2).
