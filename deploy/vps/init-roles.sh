#!/bin/sh
# Role LOGIN aplikasi & konsol platform: hanya anggota role grup, NOBYPASSRLS, bukan owner (sama dengan tools/dev/db.ts).
# Dijalankan di kontainer postgres oleh deploy.sh setelah migrasi. Password dari variabel lingkungan, tidak tertulis di SQL.
set -eu
psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v api_user="$POSTGRES_API_USER" -v api_pw="$POSTGRES_API_PASSWORD" \
  -v plt_user="$POSTGRES_PLATFORM_USER" -v plt_pw="$POSTGRES_PLATFORM_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE', :'api_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'api_user') \gexec
SELECT format('CREATE ROLE %I LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE', :'plt_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'plt_user') \gexec
SELECT format('ALTER ROLE %I LOGIN NOBYPASSRLS PASSWORD %L', :'api_user', :'api_pw') \gexec
SELECT format('ALTER ROLE %I LOGIN NOBYPASSRLS PASSWORD %L', :'plt_user', :'plt_pw') \gexec
SELECT format('GRANT clinicrme_app TO %I', :'api_user') \gexec
SELECT format('GRANT clinicrme_platform TO %I', :'plt_user') \gexec
SELECT coalesce(bool_or(rolsuper OR rolbypassrls), false) AS bad FROM pg_roles WHERE rolname IN (:'api_user', :'plt_user') \gset
\if :bad
  \echo 'GAGAL: role aplikasi/platform tidak boleh superuser atau BYPASSRLS'
  SELECT 1/0;
\else
  \echo 'Role aplikasi & platform: LOGIN, NOBYPASSRLS ✓'
\endif
SQL
