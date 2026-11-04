#!/usr/bin/env bash
# ADR-0009: migrasi BASELINE (0000–0001) harus menghasilkan struktur yang identik dengan desain db/schema + db/seed.
# Migrasi sesudahnya (0002+) adalah perubahan sah setelah db/schema dibekukan (OD-071) dan tidak ikut dibandingkan.
# Membangun dua database bersih, membandingkan pg_dump --schema-only skema `app`, dan katalog permission.
# Pemakaian: PG_ADMIN_URL=postgres://user:pass@host:port/postgres tools/check_schema_parity.sh # pragma: allowlist secret — contoh format URL
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PG_ADMIN_URL:?PG_ADMIN_URL wajib diisi}"
url_for() { node -e "const u=new URL(process.argv[1]);u.pathname='/'+process.argv[2];console.log(u.toString())" "$PG_ADMIN_URL" "$1"; }
A=crme_parity_schema; B=crme_parity_migrations
P="psql -v ON_ERROR_STOP=1 -q -X"
for d in $A $B; do $P "$PG_ADMIN_URL" -c "DROP DATABASE IF EXISTS $d WITH (FORCE)" -c "CREATE DATABASE $d"; done

for f in db/schema/*.sql db/seed/*.sql; do $P "$(url_for $A)" -c "SET client_min_messages=warning" -f "$f"; done
BASE=$(mktemp -d); mkdir -p "$BASE/meta"
node -e '
const fs=require("fs"), path=require("path"); const [src,dst]=process.argv.slice(1);
const j=JSON.parse(fs.readFileSync(path.join(src,"meta/_journal.json"),"utf8"));
j.entries=j.entries.filter(e=>["0000_baseline","0001_permissions_roles"].includes(e.tag));
for (const e of j.entries) fs.copyFileSync(path.join(src,e.tag+".sql"), path.join(dst,e.tag+".sql"));
fs.writeFileSync(path.join(dst,"meta/_journal.json"), JSON.stringify(j));' db/migrations "$BASE"
MIGRATION_DATABASE_URL="$(url_for $B)" MIGRATIONS_DIR="$BASE" npx tsx libs/db/src/bin/migrate.ts

dump() { pg_dump --schema-only --no-owner --schema=app "$1" | grep -vE '^(--|SET |SELECT pg_catalog|\\(un)?restrict )' | sed '/^$/d'; }
OUT=$(mktemp -d)
dump "$(url_for $A)" > "$OUT/schema.sql"
dump "$(url_for $B)" > "$OUT/migrations.sql"
q="select string_agg(code||':'||module, ',' order by code) from app.permission"
$P -At "$(url_for $A)" -c "$q" > "$OUT/perm_schema.txt"
$P -At "$(url_for $B)" -c "$q" > "$OUT/perm_migrations.txt"

status=0
if diff -u "$OUT/schema.sql" "$OUT/migrations.sql" > "$OUT/diff.txt"; then
  echo "SAMA  struktur skema app ($(wc -l < "$OUT/schema.sql") baris DDL, $(grep -c '^CREATE TABLE' "$OUT/schema.sql") tabel, $(grep -c '^CREATE POLICY' "$OUT/schema.sql") policy RLS, $(grep -c '^CREATE FUNCTION\|^CREATE OR REPLACE FUNCTION' "$OUT/schema.sql") fungsi, $(grep -c "^GRANT" "$OUT/schema.sql") grant)"
else
  echo "BEDA  struktur skema app:"; head -60 "$OUT/diff.txt"; status=1
fi
if diff -q "$OUT/perm_schema.txt" "$OUT/perm_migrations.txt" > /dev/null; then
  echo "SAMA  katalog permission ($(tr ',' '\n' < "$OUT/perm_schema.txt" | wc -l) permission)"
else
  echo "BEDA  katalog permission"; status=1
fi
for d in $A $B; do $P "$PG_ADMIN_URL" -c "DROP DATABASE IF EXISTS $d WITH (FORCE)"; done
exit $status
