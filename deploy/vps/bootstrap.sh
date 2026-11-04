#!/usr/bin/env bash
# shellcheck disable=SC1091 # sumber berkas ditentukan saat runtime
# Persiapan SATU KALI di VPS (Ubuntu 22.04/24.04) untuk lingkungan DEV ClinicRME (CR-0003). Jalankan sebagai root:
#   (repo privat: salin berkas ini ke VPS dengan scp — docs/02-architecture/DEPLOYMENT_VPS.md) lalu:
#   sudo bash bootstrap.sh <BASE_DOMAIN> <ACME_EMAIL> [caddy|nginx]
# Mode proxy: `nginx` bila VPS sudah punya nginx untuk situs lain (otomatis terdeteksi) — port 80/443 & firewall
# TIDAK disentuh; `caddy` untuk VPS kosong — firewall ufw 22/80/443 dinyalakan.
# Yang dilakukan: Docker Engine + plugin compose (bila belum ada), user `deploy` (tanpa password, hanya kunci SSH),
# swap 2 GB bila RAM < 4 GB, folder /opt/clinicrme, dan /opt/clinicrme/.env berisi secret acak (chmod 600).
# Tidak menyentuh data bila dijalankan ulang (.env yang ada tidak ditimpa).
set -euo pipefail
BASE_DOMAIN=${1:?pemakaian: bootstrap.sh <BASE_DOMAIN> <ACME_EMAIL>}
ACME_EMAIL=${2:?pemakaian: bootstrap.sh <BASE_DOMAIN> <ACME_EMAIL>}
[[ $BASE_DOMAIN =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "BASE_DOMAIN tidak valid"; exit 2; }
[ "$(id -u)" = 0 ] || { echo "jalankan sebagai root (sudo)"; exit 2; }
PROXY=${3:-}
if [ -z "$PROXY" ]; then
  if systemctl is-active --quiet nginx 2>/dev/null || ss -ltnH 'sport = :80' 2>/dev/null | grep -q .; then PROXY=nginx; else PROXY=caddy; fi
fi
[[ $PROXY =~ ^(caddy|nginx)$ ]] || { echo "mode proxy harus caddy atau nginx"; exit 2; }
echo "Mode proxy: $PROXY"

if ! command -v docker >/dev/null; then
  apt-get update -q && apt-get install -y -q ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  if apt-get update -q && apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then :
  else   # rilis Ubuntu yang belum didukung repo Docker → paket Docker dari Ubuntu sendiri
    rm -f /etc/apt/sources.list.d/docker.list && apt-get update -q
    apt-get install -y -q docker.io docker-compose-v2 docker-buildx
  fi
fi
docker compose version >/dev/null || { echo "plugin docker compose v2 tidak tersedia"; exit 2; }
apt-get install -y -q git >/dev/null
[ "$PROXY" = caddy ] && apt-get install -y -q ufw >/dev/null

id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash deploy
usermod -aG docker deploy
passwd -l deploy >/dev/null                      # login hanya dengan kunci SSH
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys && chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys

if [ "$PROXY" = caddy ]; then
  ufw allow OpenSSH >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
else
  echo "Mode nginx: firewall tidak diubah."
fi

if [ "$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)" -lt 3800 ] && ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

install -d -m 750 -o deploy -g deploy /opt/clinicrme /opt/clinicrme/backup
ENV=/opt/clinicrme/.env
if [ ! -f "$ENV" ]; then
  r() { openssl rand -base64 33 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"; }
  umask 077
  cat > "$ENV" <<EOV
# ClinicRME DEV (VPS) — dibuat bootstrap.sh $(date -u +%F). JANGAN di-commit / dikirim lewat chat.
BASE_DOMAIN=$BASE_DOMAIN
PROXY=$PROXY
WEB_PORT=18080
ADMIN_PORT=18081
ACME_EMAIL=$ACME_EMAIL
POSTGRES_DB=clinicrme
POSTGRES_OWNER_USER=clinicrme_owner
POSTGRES_OWNER_PASSWORD=$(r)
POSTGRES_API_USER=clinicrme_api
POSTGRES_API_PASSWORD=$(r)
POSTGRES_PLATFORM_USER=clinicrme_platform_api
POSTGRES_PLATFORM_PASSWORD=$(r)
ENCRYPTION_KEY_HEX=$(openssl rand -hex 32)
DEV_SEED_PASSWORD=$(r 20)
# Isi bila OAuth client Google untuk dev sudah ada (redirect: https://demo.$BASE_DOMAIN/api/v1/auth/google/callback)
GOOGLE_CLIENT_ID=belum-diisi
GOOGLE_CLIENT_SECRET=belum-diisi
EOV
  chown deploy:deploy "$ENV"
  echo "Dibuat $ENV (secret acak)."
else
  echo "$ENV sudah ada — tidak diubah."
  grep -q '^PROXY=' "$ENV" || echo "PROXY=$PROXY" >> "$ENV"
fi
if [ "$PROXY" = nginx ]; then
  for p in 18080 18081; do ss -ltnH "sport = :$p" | grep -q . && echo "⚠ port $p sudah dipakai — ubah WEB_PORT/ADMIN_PORT di $ENV dan di vhost nginx"; done
  echo "Ruang disk Docker: $(df -h --output=avail /var/lib 2>/dev/null | tail -1) (butuh ≥ 6 GB kosong untuk build)"
fi

cat <<MSG

Selesai. Langkah berikutnya:
 1. DNS: A record  $BASE_DOMAIN  dan  *.$BASE_DOMAIN  → IP VPS ini.
    Mode nginx: setelah deploy pertama jalankan  sudo bash deploy/vps/nginx-install.sh $BASE_DOMAIN
 2. Tambahkan kunci publik deploy (dari GitHub) ke /home/deploy/.ssh/authorized_keys.
 3. Tambahkan deploy key (read-only) repo agar VPS dapat git clone — lihat docs/02-architecture/DEPLOYMENT_VPS.md langkah 3–5.
MSG
