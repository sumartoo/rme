#!/usr/bin/env bash
# Pasang vhost ClinicRME di nginx host yang sudah ada (PROXY=nginx). Jalankan sebagai root SETELAH deploy pertama:
#   sudo bash nginx-install.sh <BASE_DOMAIN> [kode-klinik ...]
# Membuat /etc/nginx/sites-available/clinicrme (tidak menyentuh vhost lain), cek `nginx -t` sebelum reload,
# lalu sertifikat Let's Encrypt (certbot --nginx) untuk admin.<BASE_DOMAIN>, demo.<BASE_DOMAIN> & kode klinik tambahan.
set -euo pipefail
BASE_DOMAIN=${1:?pemakaian: nginx-install.sh <BASE_DOMAIN> [kode-klinik ...]}
shift
[[ $BASE_DOMAIN =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "BASE_DOMAIN tidak valid"; exit 2; }
[ "$(id -u)" = 0 ] || { echo "jalankan sebagai root (sudo)"; exit 2; }
command -v nginx >/dev/null || { echo "nginx tidak ditemukan — pakai PROXY=caddy"; exit 2; }
DIR=$(cd "$(dirname "$0")" && pwd)
SITE=/etc/nginx/sites-available/clinicrme
ENVF=${CLINICRME_ROOT:-/home/deploy/apps/clinicrme}/.env
port() { v=$(sed -n "s/^$1=//p" "$ENVF" 2>/dev/null | tail -1); echo "${v:-$2}"; }
WEB_PORT=$(port WEB_PORT 18080); ADMIN_PORT=$(port ADMIN_PORT 18081)
EMAIL=$(sed -n 's/^ACME_EMAIL=//p' "$ENVF" 2>/dev/null | tail -1)

codes=(demo)
for c in "$@"; do
  [[ $c =~ ^[a-z0-9-]+$ && $c != admin ]] || { echo "kode klinik tidak valid: $c"; exit 2; }
  codes+=("$c")
done
# Nama klinik yang sudah ada di vhost sebelumnya dipertahankan
if [ -f "$SITE" ]; then
  RE=${BASE_DOMAIN//./\\.}
  while read -r n; do codes+=("${n%%."$BASE_DOMAIN"}"); done < <(grep -E '^[[:space:]]*server_name ' "$SITE" | grep -oE "[a-z0-9-]+\.$RE" | grep -v '^admin\.' | sort -u)
fi
mapfile -t codes < <(printf '%s\n' "${codes[@]}" | sort -u)
CLINIC_NAMES=$(printf "%s.$BASE_DOMAIN " "${codes[@]}"); CLINIC_NAMES=${CLINIC_NAMES% }

[ -f "$SITE" ] && cp "$SITE" "$SITE.bak"
install -m 644 "$DIR/nginx-clinicrme-proxy.inc" /etc/nginx/clinicrme-proxy.inc
sed -e "s/CLINIC_NAMES/$CLINIC_NAMES/" -e "s/BASE_DOMAIN/$BASE_DOMAIN/g" -e "s/ADMIN_PORT/$ADMIN_PORT/" -e "s/WEB_PORT/$WEB_PORT/" \
  "$DIR/nginx-clinicrme.conf" > "$SITE"
ln -sf "$SITE" /etc/nginx/sites-enabled/clinicrme
if ! nginx -t; then
  echo "konfigurasi nginx salah — dikembalikan"; if [ -f "$SITE.bak" ]; then mv "$SITE.bak" "$SITE"; else rm -f "$SITE" /etc/nginx/sites-enabled/clinicrme; fi
  exit 1
fi
systemctl reload-or-restart nginx

names=(-d "admin.$BASE_DOMAIN")
for c in "${codes[@]}"; do names+=(-d "$c.$BASE_DOMAIN"); done
if command -v certbot >/dev/null; then
  certbot --nginx --non-interactive --agree-tos ${EMAIL:+-m "$EMAIL"} --cert-name clinicrme --keep-until-expiring --expand --redirect "${names[@]}"
  nginx -t && systemctl reload-or-restart nginx
else
  echo "certbot tidak ada: sudo apt-get install -y certbot python3-certbot-nginx, lalu jalankan ulang skrip ini"
fi
for h in admin demo; do
  echo "https://$h.$BASE_DOMAIN/healthz → $(curl -s -o /dev/null -w '%{http_code}' --max-time 20 --resolve "$h.$BASE_DOMAIN:443:127.0.0.1" "https://$h.$BASE_DOMAIN/healthz" || true)"
done
