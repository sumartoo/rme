#!/usr/bin/env bash
# Membuat database uji bersih, memuat skema, lalu menjalankan uji keamanan.
# Pemakaian: PGHOST=... PGPORT=... PGUSER=<superuser> [PGPASSWORD=...] MIGRATION_DATABASE_URL_BASE=postgres://user:pass@host:port \  # pragma: allowlist secret
#            ./db/tests/run_tests.sh        (DB_SOURCE=schema untuk membangun dari db/schema)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
DB="${TEST_DB:-clinicrme_schema_test}"
P="psql -v ON_ERROR_STOP=1 -q -X"
$P -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
# DB_SOURCE=migrations (default sejak Stage 4): bangun dari db/migrations seperti produksi; DB_SOURCE=schema: dari desain db/schema.
if [ "${DB_SOURCE:-migrations}" = "migrations" ]; then
  (cd "$DIR/../.." && MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL_BASE:?MIGRATION_DATABASE_URL_BASE wajib diisi (URL superuser tanpa nama database)}/$DB" npx tsx libs/db/src/bin/migrate.ts)
else
  for f in "$DIR"/../schema/*.sql "$DIR"/../seed/*.sql; do $P -d "$DB" -c "SET client_min_messages=warning" -f "$f"; done
fi
$P -d "$DB" -c "SET client_min_messages=warning" -f "$DIR/001_seed.sql"
$P -d "$DB" -f "$DIR/010_security_tests.sql" 2>&1 | grep -v '^-*$' | sed -n 's/^psql:[^:]*:[0-9]*: NOTICE:  //p; /^--- \|^===/p; /FAIL\|ERROR/p'
if [ "${DB_SOURCE:-migrations}" = "migrations" ]; then
  $P -d "$DB" -f "$DIR/020_migration_tests.sql" 2>&1 | grep -v '^-*$' | sed -n 's/^psql:[^:]*:[0-9]*: NOTICE:  //p; /^--- \|^===/p; /FAIL\|ERROR/p'
fi
