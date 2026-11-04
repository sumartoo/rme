-- =====================================================================
-- 900 Security — RLS, grants, search_path fungsi (ADR-0002, ADR-0006, ADR-0007)
-- Dijalankan terakhir. Idempoten.
-- =====================================================================
SET search_path = app, public;

-- 1. RLS untuk SEMUA tabel di skema app yang memiliki kolom tenant_id
--    kecuali tabel platform yang dikelola terpisah.
DO $$
DECLARE r record;
  platform_tables text[] := ARRAY['tenant','tenant_subscription','tenant_status_history',
                                  'tenant_feature_flag','support_access_grant','tenant_export_job'];
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
     WHERE c.relkind IN ('r','p') AND NOT c.relispartition
  LOOP
    IF r.relname = ANY(platform_tables) THEN CONTINUE; END IF;
    PERFORM app.enable_tenant_rls(r.tbl);
  END LOOP;
END $$;

-- Tabel tenant: app hanya boleh membaca baris tenant aktifnya sendiri.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON tenant;
CREATE POLICY tenant_self ON tenant FOR SELECT TO clinicrme_app, clinicrme_readonly
  USING (id = app.current_tenant_id());
DROP POLICY IF EXISTS tenant_platform ON tenant;
CREATE POLICY tenant_platform ON tenant TO clinicrme_platform USING (true) WITH CHECK (true);

-- 2. Trigger touch_row untuk tabel yang memiliki updated_at & version
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl, c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app'
     WHERE c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = c.oid AND attname = 'version' AND NOT attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = c.oid AND attname = 'updated_by' AND NOT attisdropped)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch ON %s', r.tbl);
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app.touch_row()', r.tbl);
  END LOOP;
END $$;

-- 3. search_path tetap untuk semua fungsi app (mencegah search_path hijacking)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'app' AND p.prokind = 'f'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = app, public', r.fn);
  END LOOP;
END $$;

-- 4. Grants
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;

-- clinicrme_app: DML pada tabel tenant
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO clinicrme_app;
-- tabel global: hanya baca
REVOKE INSERT, UPDATE, DELETE ON permission, menu_item, region, code_system, concept FROM clinicrme_app;
-- tabel platform: hanya baca tenant sendiri (melalui policy)
REVOKE ALL ON tenant_subscription, tenant_status_history, tenant_feature_flag,
              support_access_grant, tenant_export_job, subscription_plan FROM clinicrme_app;
GRANT SELECT ON subscription_plan, tenant_feature_flag TO clinicrme_app;
REVOKE INSERT, UPDATE, DELETE ON tenant FROM clinicrme_app;
-- append-only: tanpa UPDATE/DELETE
REVOKE UPDATE, DELETE ON payment, stock_movement, clinical_addendum, medical_document FROM clinicrme_app;
-- saldo stok & kepala audit hanya lewat trigger/fungsi
REVOKE INSERT, UPDATE, DELETE ON stock_balance FROM clinicrme_app;
-- audit: tidak ada akses tulis langsung
REVOKE ALL ON audit_log, audit_chain_head FROM clinicrme_app;
GRANT SELECT ON audit_log TO clinicrme_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO clinicrme_app;
REVOKE EXECUTE ON FUNCTION app.verify_audit_chain(uuid) FROM clinicrme_app;

-- clinicrme_readonly
GRANT SELECT ON ALL TABLES IN SCHEMA app TO clinicrme_readonly;
REVOKE SELECT ON user_credential, user_mfa, user_invitation, user_session FROM clinicrme_readonly;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_user_id() TO clinicrme_readonly;

-- clinicrme_platform: hanya tabel platform (tanpa data klinis — PLT-FR-009)
GRANT SELECT, INSERT, UPDATE ON tenant, subscription_plan, tenant_subscription, tenant_status_history,
                                tenant_feature_flag, support_access_grant, tenant_export_job TO clinicrme_platform;

-- Trigger stok berjalan sebagai pemilik agar dapat memperbarui stock_balance
ALTER FUNCTION app.apply_stock_movement() SECURITY DEFINER;
