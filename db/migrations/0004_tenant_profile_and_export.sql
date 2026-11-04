-- ClinicRME — migrasi 0004 (Stage 5 batch 3)
-- 1) Profil & kop klinik dapat diubah tenant admin (PLT-FR-007) — hanya kolom profil, hanya baris tenant sendiri.
-- 2) Ekspor data tenant (PLT-FR-008, OD-028): job ekspor menjadi tabel ber-RLS yang dapat dibaca/ditulis aplikasi klinik.
-- 3) Worker menjalankan ekspor sebagai clinicrme_app (SET LOCAL ROLE) sehingga RLS membatasi isi arsip ke satu tenant.
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- 1. Profil klinik
-- ---------------------------------------------------------------------
GRANT UPDATE (display_name, letterhead, settings, logo_file_id) ON tenant TO clinicrme_app;
CREATE POLICY tenant_self_update ON tenant FOR UPDATE TO clinicrme_app
  USING (id = app.current_tenant_id()) WITH CHECK (id = app.current_tenant_id());
ALTER TABLE tenant ADD CONSTRAINT tenant_logo_file_fk FOREIGN KEY (id, logo_file_id) REFERENCES stored_file(tenant_id, id);
ALTER TABLE tenant ADD CONSTRAINT tenant_display_name_check CHECK (length(trim(display_name)) BETWEEN 2 AND 200);

-- ---------------------------------------------------------------------
-- 2. Job ekspor
-- ---------------------------------------------------------------------
ALTER TABLE tenant_export_job
  ADD COLUMN started_at     timestamptz,
  ADD COLUMN size_bytes     bigint,
  ADD COLUMN sha256         text,
  ADD COLUMN key_encrypted  bytea,
  ADD COLUMN table_count    int,
  ADD COLUMN row_count      bigint,
  ADD COLUMN error          text,
  ADD COLUMN download_count int NOT NULL DEFAULT 0,
  ADD CONSTRAINT tenant_export_job_tenant_id_id_key UNIQUE (tenant_id, id),
  ADD CONSTRAINT tenant_export_job_file_fk FOREIGN KEY (tenant_id, file_id) REFERENCES stored_file(tenant_id, id);
COMMENT ON COLUMN tenant_export_job.key_encrypted IS 'Kunci AES-256 arsip, dienkripsi kunci aplikasi; ditampilkan ke tenant admin saat DONE (teraudit)';
-- Satu ekspor aktif per tenant (mencegah antrean berlebih)
CREATE UNIQUE INDEX ux_tenant_export_active ON tenant_export_job(tenant_id) WHERE status IN ('QUEUED', 'RUNNING');
CREATE INDEX ix_tenant_export_queue ON tenant_export_job(created_at) WHERE status = 'QUEUED';

SELECT app.enable_tenant_rls('tenant_export_job');
GRANT SELECT, INSERT, UPDATE ON tenant_export_job TO clinicrme_app;
-- Konsol platform cukup melihat status (offboarding); tidak boleh membaca kunci arsip atau mengubah job
REVOKE ALL ON tenant_export_job FROM clinicrme_platform;
GRANT SELECT (id, tenant_id, status, created_at, finished_at, expires_at, size_bytes) ON tenant_export_job TO clinicrme_platform;

-- ---------------------------------------------------------------------
-- 3. Worker (pemilik/OD-074) boleh SET ROLE clinicrme_app untuk job yang membaca data tenant
-- ---------------------------------------------------------------------
DO $$ BEGIN EXECUTE format('GRANT clinicrme_app TO %I', current_user); END $$;
-- tenant_export_job & stored_file memakai FORCE RLS. Klaim job lintas tenant & pembersihan ekspor kedaluwarsa
-- berjalan sebagai pemilik (worker, OD-074) tanpa tenant context; pemilik non-superuser (Cloud SQL) butuh policy eksplisit.
-- Pembacaan data tenant TIDAK memakai policy ini: worker SET LOCAL ROLE clinicrme_app untuk itu.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY export_worker ON tenant_export_job TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format($f$CREATE POLICY export_worker_files ON stored_file FOR SELECT TO %I USING (category = 'EXPORT')$f$, current_user);
END $$;
