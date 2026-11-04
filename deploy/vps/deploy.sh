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

C="docker compose -f deploy/vps/docker-compose.yml ${COMPOSE_EXTRA:+-f $COMPOSE_EXTRA} --env-file $ENVF"
export RELEASE=$SHA

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
$C up -d --wait --remove-orphans api worker web platform-admin mailpit caddy
docker image prune -f --filter "until=168h" >/dev/null

echo "▶ cek dari luar (lewat Caddy)"
for h in "admin.$BASE_DOMAIN" "demo.$BASE_DOMAIN"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 --resolve "$h:443:127.0.0.1" "https://$h/healthz" || true)
  echo "  https://$h/healthz → $code"
done
echo "✓ deploy $SHA selesai"
