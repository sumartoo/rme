-- ClinicRME — migrasi 0006 (Stage 5 batch 4): perbaikan isolasi tenant pada tenant_feature_flag.
-- Temuan uji E2E W04: baseline memberi clinicrme_app SELECT pada tenant_feature_flag tetapi tabel ini dikecualikan
-- dari RLS otomatis (daftar tabel platform), sehingga aplikasi klinik dapat membaca feature flag SEMUA klinik.
-- Isinya hanya kode fitur (bukan PHI), tetapi melanggar prinsip fail-closed ADR-0002. Ekspor tenant menolak
-- arsip karena memeriksa tenant_id setiap baris — itulah yang membuat celah ini terlihat.
SET search_path = app, public;

ALTER TABLE tenant_feature_flag ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_feature_flag FORCE ROW LEVEL SECURITY;
-- Aplikasi klinik: baca flag klinik sendiri saja
CREATE POLICY feature_flag_self ON tenant_feature_flag FOR SELECT TO clinicrme_app USING (tenant_id = app.current_tenant_id());
-- Konsol platform: kelola semua klinik (CR-0001)
CREATE POLICY feature_flag_platform ON tenant_feature_flag TO clinicrme_platform USING (true) WITH CHECK (true);
-- Pemilik skema non-superuser (Cloud SQL): migrasi & fungsi SECURITY DEFINER
DO $$ BEGIN
  EXECUTE format('CREATE POLICY feature_flag_owner ON tenant_feature_flag TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
