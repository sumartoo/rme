# Deploy dev ke VPS (CR-0003)

Lingkungan **dev** ClinicRME berjalan di satu VPS dengan docker compose. Hanya data **sintetis**. Ini bukan lingkungan produksi.

```
Internet ──443──► Caddy ──► web (klinik *.DOMAIN)  ──┐
                       └──► platform-admin (admin.DOMAIN) ──► api ──► postgres
                                                     worker ──► mailpit (127.0.0.1:8025, tunnel SSH)
GitHub: ci hijau di main ──► deploy-dev: build image di runner ──SSH (docker load + kode)──► deploy/vps/deploy.sh <sha>
```

## Dua mode proxy

| Mode (`PROXY` di `.env`) | Kapan | Yang membuka 80/443 | HTTPS |
|---|---|---|---|
| `nginx` | VPS **sudah** menjalankan nginx untuk situs lain (terdeteksi otomatis oleh bootstrap) | nginx host; ClinicRME hanya di `127.0.0.1:18080` (klinik) & `127.0.0.1:18081` (konsol) | certbot per nama: `admin`, `demo`, + kode klinik yang didaftarkan lewat `nginx-install.sh` |
| `caddy` | VPS kosong | Caddy (container) | Let's Encrypt on-demand untuk klinik terdaftar (`/internal/tls-allowed`) |

Mode `nginx` tidak mengubah firewall maupun vhost situs lain; vhost ClinicRME berada di berkas sendiri `/etc/nginx/sites-available/clinicrme` dan `nginx -t` dicek sebelum reload (gagal → dikembalikan).

## Kebutuhan VPS

- Ubuntu 22.04 / 24.04 / 26.04, minimal **2 vCPU / 4 GB RAM**. **Ruang disk kosong ≥ 3 GB**: image dibuild di runner GitHub lalu dikirim jadi (±1–1,5 GB; disimpan rilis aktif + satu sebelumnya). Build di VPS hanya bila deploy.sh dijalankan manual tanpa image (butuh ≥ 6 GB).
- Akses root lewat SSH (cukup sekali, untuk bootstrap).
- Domain milik PO dengan dua A record ke IP VPS: `DOMAIN` dan `*.DOMAIN`.
  Klinik demo: `https://demo.DOMAIN`; konsol platform: `https://admin.DOMAIN`.

## Persiapan satu kali (oleh PO, ±20 menit)

1. **DNS.** Buat A record `@` dan `*` ke IP VPS. Tunggu sampai `ping demo.DOMAIN` menunjuk IP tersebut.
2. **Bootstrap VPS.** Repo privat, jadi salin skripnya dari komputer Anda (PowerShell, di folder repo setelah `git pull`):
   ```powershell
   scp deploy\vps\bootstrap.sh root@IP_VPS:/root/
   ssh root@IP_VPS "bash /root/bootstrap.sh DOMAIN email-anda@contoh.com"
   ```
   Bila login memakai user biasa ber-sudo: `scp deploy\vps\bootstrap.sh USER@IP_VPS:~/` lalu `ssh -t USER@IP_VPS "sudo bash ~/bootstrap.sh DOMAIN EMAIL"`.
   Hasil: Docker (bila belum ada), user `deploy` (hanya kunci SSH), `/home/deploy/apps/clinicrme/.env` berisi secret acak; mode `caddy` juga menyalakan firewall 22/80/443.
   **Jangan kirim isi `.env` atau password root lewat chat.**
3. **Tidak perlu deploy key.** Kebijakan organisasi AtoAIs menonaktifkan deploy key, dan VPS memang tidak perlu kredensial repo: workflow `deploy-dev` mengirim kode rilis lewat SSH (`git archive`) ke `/home/deploy/apps/clinicrme/releases/<sha>`; `/home/deploy/apps/clinicrme/app` adalah symlink ke rilis aktif (3 rilis terakhir disimpan).
4. **Kunci SSH untuk GitHub Actions.** Masih sebagai `deploy`:
   ```bash
   ssh-keygen -t ed25519 -N '' -f ~/gh_actions -C github-actions-deploy
   cat ~/gh_actions.pub >> ~/.ssh/authorized_keys
   cat ~/gh_actions        # kunci PRIVAT → hanya ditempel ke GitHub Secrets, lalu hapus: rm ~/gh_actions*
   ```
5. **GitHub Secrets** (repo → Settings → Secrets and variables → Actions):
   | Nama | Isi |
   |---|---|
   | `VPS_HOST` | IP VPS |
   | `VPS_USER` | `deploy` |
   | `VPS_SSH_KEY` | isi `~/gh_actions` (kunci privat) |
   | `VPS_KNOWN_HOSTS` | hasil `ssh-keyscan -t ed25519 IP_VPS` dijalankan dari komputer Anda |

   Tab **Variables**: `DEPLOY_VPS_ENABLED` = `true`. Buat juga *Environment* bernama `dev` (Settings → Environments).
6. **Deploy pertama + data demo.** GitHub → Actions → `deploy-dev` → *Run workflow* → centang **seed**. Selesai ±10–15 menit (build pertama).
   Password akun demo = `DEV_SEED_PASSWORD` di `/home/deploy/apps/clinicrme/.env` (lihat di VPS: `sudo grep DEV_SEED /home/deploy/apps/clinicrme/.env`).

7. **Mode nginx saja — pasang vhost + sertifikat** (setelah deploy pertama sukses):
   ```bash
   sudo apt-get install -y certbot python3-certbot-nginx     # bila belum ada
   sudo bash /home/deploy/apps/clinicrme/app/deploy/vps/nginx-install.sh DOMAIN
   ```
   Klinik baru (dibuat dari konsol) perlu sertifikat sendiri: `sudo bash .../nginx-install.sh DOMAIN <kode-klinik>` (nama lama dipertahankan).

Setelah itu setiap merge ke `main` yang lolos CI otomatis ter-deploy.

## Operasional

| Kebutuhan | Perintah (di VPS, user `deploy`) |
|---|---|
| Status layanan | `cd /home/deploy/apps/clinicrme/app && docker compose -f deploy/vps/docker-compose.yml --env-file ../.env ps` |
| Log API | `... logs -f --tail 100 api` |
| Kotak masuk email dev | dari komputer Anda: `ssh -L 8025:127.0.0.1:8025 deploy@IP_VPS` → buka `http://localhost:8025` |
| Deploy ulang commit tertentu | GitHub → Actions → `deploy-dev` → Run workflow (dari main), atau di VPS: `cd /home/deploy/apps/clinicrme && ln -sfn releases/<sha> app && DEPLOY_SKIP_GIT=1 bash app/deploy/vps/deploy.sh <sha>` |
| Cadangan database | otomatis sebelum setiap migrasi di `/home/deploy/apps/clinicrme/backup/` (7 terakhir) |
| Pulihkan cadangan | `docker compose ... exec -T postgres pg_restore -U clinicrme_owner -d clinicrme --clean < /home/deploy/apps/clinicrme/backup/<berkas>.dump` |

## Keamanan

- Hanya Caddy membuka port 80/443. PostgreSQL, API, worker, Mailpit tidak terjangkau dari internet (diuji di CI job `vps-stack`).
- Sertifikat Let's Encrypt hanya diterbitkan untuk `admin.DOMAIN` dan kode klinik yang terdaftar & dilayani (`/internal/tls-allowed`, ditutup dari luar oleh Caddy).
- Role database aplikasi LOGIN tanpa superuser/BYPASSRLS; `init-roles.sh` gagal bila tidak demikian.
- Login Google: isi `GOOGLE_CLIENT_ID/SECRET` di `.env` setelah membuat OAuth client dengan redirect `https://demo.DOMAIN/api/v1/auth/google/callback`. Tanpa itu, login password + MFA tetap berfungsi.
- Bukan untuk data pasien nyata. Tidak ada klaim kepatuhan regulasi.
