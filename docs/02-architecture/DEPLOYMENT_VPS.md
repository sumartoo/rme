# Deploy dev ke VPS (CR-0003)

Lingkungan **dev** ClinicRME berjalan di satu VPS dengan docker compose. Hanya data **sintetis**. Ini bukan lingkungan produksi.

```
Internet ──443──► Caddy ──► web (klinik *.DOMAIN)  ──┐
                       └──► platform-admin (admin.DOMAIN) ──► api ──► postgres
                                                     worker ──► mailpit (127.0.0.1:8025, tunnel SSH)
GitHub: ci hijau di main ──► deploy-dev ──SSH──► deploy/vps/deploy.sh <sha>
```

## Kebutuhan VPS

- Ubuntu 22.04 atau 24.04, minimal **2 vCPU / 4 GB RAM / 40 GB disk** (2 GB RAM bisa, bootstrap menambah swap; build lebih lambat).
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
   Hasil: Docker, user `deploy` (hanya kunci SSH), firewall 22/80/443, `/opt/clinicrme/.env` berisi secret acak.
   **Jangan kirim isi `.env` atau password root lewat chat.**
3. **Kunci baca repo untuk VPS (deploy key).** Sebagai user deploy:
   ```bash
   sudo -iu deploy
   ssh-keygen -t ed25519 -N '' -f ~/.ssh/github_repo -C clinicrme-vps
   printf 'Host github.com\n  IdentityFile ~/.ssh/github_repo\n  IdentitiesOnly yes\n' >> ~/.ssh/config
   cat ~/.ssh/github_repo.pub
   ```
   Tempel kunci publik itu di GitHub → repo → Settings → Deploy keys → Add deploy key (**tanpa** centang *Allow write access*). Lalu:
   ```bash
   ssh-keyscan github.com >> ~/.ssh/known_hosts
   git clone git@github.com:AtoAIs/atoai-rme-v2.git /opt/clinicrme/app
   ```
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
   Password akun demo = `DEV_SEED_PASSWORD` di `/opt/clinicrme/.env` (lihat di VPS: `sudo grep DEV_SEED /opt/clinicrme/.env`).

Setelah itu setiap merge ke `main` yang lolos CI otomatis ter-deploy.

## Operasional

| Kebutuhan | Perintah (di VPS, user `deploy`) |
|---|---|
| Status layanan | `cd /opt/clinicrme/app && docker compose -f deploy/vps/docker-compose.yml --env-file ../.env ps` |
| Log API | `... logs -f --tail 100 api` |
| Kotak masuk email dev | dari komputer Anda: `ssh -L 8025:127.0.0.1:8025 deploy@IP_VPS` → buka `http://localhost:8025` |
| Deploy ulang commit tertentu | `bash /opt/clinicrme/app/deploy/vps/deploy.sh <sha>` |
| Cadangan database | otomatis sebelum setiap migrasi di `/opt/clinicrme/backup/` (7 terakhir) |
| Pulihkan cadangan | `docker compose ... exec -T postgres pg_restore -U clinicrme_owner -d clinicrme --clean < /opt/clinicrme/backup/<berkas>.dump` |

## Keamanan

- Hanya Caddy membuka port 80/443. PostgreSQL, API, worker, Mailpit tidak terjangkau dari internet (diuji di CI job `vps-stack`).
- Sertifikat Let's Encrypt hanya diterbitkan untuk `admin.DOMAIN` dan kode klinik yang terdaftar & dilayani (`/internal/tls-allowed`, ditutup dari luar oleh Caddy).
- Role database aplikasi LOGIN tanpa superuser/BYPASSRLS; `init-roles.sh` gagal bila tidak demikian.
- Login Google: isi `GOOGLE_CLIENT_ID/SECRET` di `.env` setelah membuat OAuth client dengan redirect `https://demo.DOMAIN/api/v1/auth/google/callback`. Tanpa itu, login password + MFA tetap berfungsi.
- Bukan untuk data pasien nyata. Tidak ada klaim kepatuhan regulasi.
