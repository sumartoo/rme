#!/usr/bin/env bash
# shellcheck disable=SC1090 # sumber berkas ditentukan saat runtime
# Deploy satu commit ke VPS DEV (CR-0003). Dipanggil GitHub Actions lewat SSH sebagai user `deploy`:
#   bash /opt/clinicrme/app/deploy/vps/deploy.sh <commit-sha> [--seed]
# Urutan: ambil kode → build image → PostgreSQL → migrasi → role LOGIN → layanan → cek kesehatan.
# Gagal di langkah mana pun → berhenti; layanan lama tetap jalan sampai `up` berhasil membangun penggantinya.
set -euo pipefail
SHA=${1:?pemakaian: deploy.sh <commit-sha> [--seed]}
[[ $SHA =~ ^[0-9a-f]{7,40}$ ]] || { echo "commit tidak valid"; exit 2; }
SEED=${2:-}
ROOT=${CLINICRME_ROOT:-/opt/clinicrme}
APP=${CLINICRME_APP:-$ROOT/app}
ENVF=$ROOT/.env
[ -f "$ENVF" ] || { echo "$ENVF belum ada — jalankan bootstrap.sh dulu"; exit 2; }

cd "$APP"
if [ "${DEPLOY_SKIP_GIT:-}" != 1 ]; then   # CI menguji skrip ini pada checkout yang sudah ada
  git fetch --quiet --depth 50 origin main
  git checkout --quiet --force "$SHA"
fi
echo "▶ commit $(git log -1 --format='%h %s')"

PROXY=$(sed -n 's/^PROXY=//p' "$ENVF" | tail -1); PROXY=${PROXY:-caddy}
case $PROXY in
  caddy) PROXY_FILE=""; FRONT=caddy ;;
  nginx) PROXY_FILE="-f deploy/vps/docker-compose.nginx.yml"; FRONT="" ;;   # nginx host di luar compose
  *) echo "PROXY harus caddy atau nginx"; exit 2 ;;
esac
C="docker compose -f deploy/vps/docker-compose.yml $PROXY_FILE ${COMPOSE_EXTRA:+-f $COMPOSE_EXTRA} --env-file $ENVF"
[ "$PROXY" = caddy ] && C="$C --profile caddy"
export RELEASE=$SHA
echo "▶ mode proxy: $PROXY"

DROOT=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
FREE_GB=$(df --output=avail -BG "$DROOT" 2>/dev/null | tail -1 | tr -dc 0-9)
# Build pertama (belum ada image clinicrme) ±6 GB; build berikutnya memakai cache layer → cukup ±3 GB
if docker image ls -q 'clinicrme-api' | grep -q .; then NEED=${DEPLOY_MIN_FREE_GB:-3}; else NEED=${DEPLOY_MIN_FREE_GB:-6}; fi
if [ "${FREE_GB:-0}" -lt "$NEED" ]; then
  echo "✗ ruang disk untuk Docker tinggal ${FREE_GB} GB (butuh ≥ ${NEED} GB untuk build). Kosongkan disk dulu."; exit 3
fi
echo "▶ build image"
$C build --pull api worker web platform-admin
if [ "$SEED" = "--seed" ]; then $C --profile ops build seed; fi

echo "▶ cadangan database sebelum migrasi (7 terakhir disimpan)"
$C up -d --wait postgres
set -a; . "$ENVF"; set +a
mkdir -p "$ROOT/backup"
$C exec -T postgres pg_dump -U "$POSTGRES_OWNER_USER" -d "$POSTGRES_DB" -Fc > "$ROOT/backup/pre-$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:7}.dump"
# shellcheck disable=SC2012 # nama berkas dibuat skrip ini sendiri
ls -1t "$ROOT"/backup/pre-*.dump | tail -n +8 | xargs -r rm --

echo "▶ migrasi & role"
$C --profile ops run --rm storage-init
$C --profile ops run --rm migrate
$C exec -T -e POSTGRES_API_USER -e POSTGRES_API_PASSWORD -e POSTGRES_PLATFORM_USER -e POSTGRES_PLATFORM_PASSWORD postgres sh /opt/init-roles.sh
if [ "$SEED" = "--seed" ]; then $C --profile ops run --rm seed; fi

echo "▶ jalankan layanan"
# shellcheck disable=SC2086 # FRONT kosong pada mode nginx
$C up -d --wait --remove-orphans api worker web platform-admin mailpit $FRONT
# Disk VPS terbatas: buang image & cache build lama (image rilis berjalan tidak tersentuh)
docker image prune -f --filter "until=168h" >/dev/null
docker builder prune -f --filter "until=72h" >/dev/null || true

echo "▶ cek dari luar (lewat Caddy)"
for h in "admin.$BASE_DOMAIN" "demo.$BASE_DOMAIN"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 --resolve "$h:443:127.0.0.1" "https://$h/healthz" || true)
  echo "  https://$h/healthz → $code"
done
echo "✓ deploy $SHA selesai"
