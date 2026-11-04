-- =====================================================================
-- ClinicRME — 000 Foundation: roles, schema, helper functions
-- ADR-0002 (RLS), ADR-0006 (immutability)
-- Dijalankan oleh role owner (clinicrme_owner) pada database kosong.
-- =====================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicrme_app') THEN
    CREATE ROLE clinicrme_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicrme_platform') THEN
    CREATE ROLE clinicrme_platform NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicrme_readonly') THEN
    CREATE ROLE clinicrme_readonly NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS app;
COMMENT ON SCHEMA app IS 'Skema aplikasi ClinicRME';

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO clinicrme_app, clinicrme_platform, clinicrme_readonly;

SET search_path = app, public;

-- ---------------------------------------------------------------------
-- Tenant context
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;
COMMENT ON FUNCTION app.current_tenant_id() IS
  'Tenant aktif dari SET LOCAL app.tenant_id. NULL bila tidak di-set → RLS menolak semua baris (fail-closed).';

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------
-- Kolom standar: updated_at & version otomatis
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := COALESCE(app.current_user_id(), NEW.updated_by);
  NEW.version    := OLD.version + 1;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- Penolakan generik untuk tabel append-only (ADR-0006)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.reject_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE: % pada % tidak diizinkan', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;

-- ---------------------------------------------------------------------
-- Helper untuk mendaftarkan tabel tenant: RLS + policy + trigger touch
-- Dipanggil di 900_security.sql untuk setiap tabel ber-tenant_id.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.enable_tenant_rls(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', p_table);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s
       USING (tenant_id = app.current_tenant_id())
       WITH CHECK (tenant_id = app.current_tenant_id())', p_table);
END $$;
