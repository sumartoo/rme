# CR-0003 — Lingkungan dev di VPS (menggantikan GCP sementara)

| | |
|---|---|
| Diajukan oleh | Sumarto (PO) |
| Tanggal | 5 November 2026 |
| Prioritas | Tinggi — membuka butir terbuka S4-2 (lingkungan dev) |
| Status | **Disetujui** — DEC-030 |

## Perubahan yang diminta

PO: *"di deploy ke VPS biasa saja jangan dulu ke GCP"*; deploy **otomatis dari GitHub**; VPS milik PO sudah ada; domain milik PO (bukan clinicrme.id).

Lingkungan `dev` (ENVIRONMENTS.md) tidak lagi di Cloud Run + Cloud SQL, melainkan satu VPS dengan docker compose:

| Komponen | GCP (rencana awal) | VPS (CR ini) |
|---|---|---|
| Aplikasi | Cloud Run | Container docker compose (image yang sama dengan job `images` di CI) |
| Database | Cloud SQL PostgreSQL 16 | Container `postgres:16-alpine`, volume lokal, cadangan `pg_dump` sebelum setiap migrasi (7 terakhir) |
| Berkas | Cloud Storage | Driver `fs` pada volume (kini diizinkan juga di `APP_ENV=dev`) |
| HTTPS | Load balancer + sertifikat terkelola | Mode `nginx` (VPS PO sudah menjalankan nginx untuk situs lain): nginx host + certbot per nama. Mode `caddy` (VPS kosong): Let's Encrypt **on-demand** hanya untuk konsol & klinik terdaftar (`/internal/tls-allowed`) |
| Domain | `dev.clinicrme.id` (usulan) | `medika.atoai.id` (subdomain milik PO): `demo.medika.atoai.id`, `admin.medika.atoai.id` |
| Email | — (OD terbuka) | Mailpit, hanya dapat dibuka lewat tunnel SSH |
| Deploy | Push Artifact Registry → Cloud Run | Workflow `deploy-dev`: setelah `ci` hijau di main → kirim kode (`git archive`) lewat SSH → `deploy/vps/deploy.sh` (build di VPS, migrasi, layanan). VPS tanpa kredensial repo |

## Batasan & yang tidak berubah

- **Hanya data sintetis.** VPS dev bukan produksi; target staging/produksi diputuskan terpisah (GCP tetap opsi).
- Model keamanan tetap: role DB `clinicrme_api`/`clinicrme_platform_api` LOGIN tanpa superuser/BYPASSRLS (dicek `init-roles.sh`), RLS fail-closed, audit hash chain.
- PostgreSQL, API, worker, Mailpit tidak membuka port publik. Mode `nginx` tidak mengubah firewall maupun vhost situs lain di VPS.
- Secret dibuat acak di VPS (`/home/deploy/apps/clinicrme/.env`, chmod 600), tidak pernah lewat chat atau repo.
- Tidak ada layanan berbayar baru selain VPS & domain milik PO.

## Analisis dampak

| Aspek | Dampak |
|---|---|
| Kode | Endpoint `GET /internal/tls-allowed` (uji F16; diblok Caddy dari luar); driver `fs` diizinkan di `dev`; seed boleh di `dev` dengan password ≥ 16 karakter |
| CI | Job baru `vps-stack` menjalankan `deploy.sh` dua kali (deploy pertama + ulang) dengan Caddy CA internal, lalu cek login, cookie Secure, HSTS, endpoint internal tertutup, subdomain asing tanpa sertifikat, port internal tidak terbuka |
| Risiko | Satu VPS = satu titik gagal; dapat diterima untuk dev. Kehilangan disk = data sintetis hilang, dapat di-seed ulang |
| Biaya | VPS & domain milik PO; tidak ada biaya baru |
