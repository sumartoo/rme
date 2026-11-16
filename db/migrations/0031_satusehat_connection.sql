-- ClinicRME — migrasi 0031 (Stage 12 batch 1): koneksi SATUSEHAT per fasilitas, simulator, sinkron master, lookup IHS
-- (INT-FR-001, 002, 003; OD-114, OD-116, OD-117, OD-121 / DEC-044).
SET search_path = app, public;

-- 1. Koneksi: lingkungan SIMULATOR (lokal/test, ditolak di produksi oleh aplikasi); kredensial terenkripsi aplikasi
--    sampai Stage 15 memindahkannya ke Secret Manager (OD-114). Satu koneksi aktif per fasilitas.
ALTER TABLE integration_connection DROP CONSTRAINT integration_connection_environment_check;
ALTER TABLE integration_connection ADD CONSTRAINT integration_connection_environment_check
  CHECK (environment IN ('SIMULATOR', 'SANDBOX', 'PRODUCTION'));
ALTER TABLE integration_connection
  ADD COLUMN client_id         text,
  ADD COLUMN secret_encrypted  bytea,
  ADD COLUMN organization_id   text,
  ADD COLUMN last_test_message text,
  ADD COLUMN last_sync_at      timestamptz,
  ADD COLUMN updated_at        timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_by        uuid,
  ADD COLUMN version           int NOT NULL DEFAULT 1;
ALTER TABLE integration_connection ADD CONSTRAINT integration_connection_satusehat_fields
  CHECK (kind <> 'SATUSEHAT' OR (client_id IS NOT NULL AND secret_encrypted IS NOT NULL AND organization_id IS NOT NULL));
CREATE UNIQUE INDEX ux_integration_connection_active ON integration_connection(tenant_id, facility_id, kind) WHERE is_active;
COMMENT ON COLUMN integration_connection.secret_encrypted IS 'Client secret terenkripsi AES-256-GCM (kunci aplikasi); tidak pernah dikembalikan API (OD-114)';
REVOKE DELETE ON integration_connection FROM clinicrme_app;

-- 2. Status pengiriman per koneksi (ID SATUSEHAT berbeda antara sandbox & produksi)
ALTER TABLE fhir_sync_record ADD COLUMN connection_id uuid;
ALTER TABLE fhir_sync_record ADD CONSTRAINT fhir_sync_record_connection_fk FOREIGN KEY (tenant_id, connection_id) REFERENCES integration_connection(tenant_id, id);
ALTER TABLE fhir_sync_record DROP CONSTRAINT fhir_sync_record_tenant_id_resource_type_local_type_local_i_key;
CREATE UNIQUE INDEX ux_fhir_sync_record ON fhir_sync_record(tenant_id, connection_id, resource_type, local_type, local_id);
ALTER TABLE fhir_sync_record ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
REVOKE DELETE ON fhir_sync_record FROM clinicrme_app;

-- 3. Lookup IHS pasien (OD-116): kapan terakhir dicek & pesan error terakhir untuk dashboard
ALTER TABLE patient ADD COLUMN ihs_checked_at timestamptz, ADD COLUMN ihs_last_error text;
CREATE INDEX ix_patient_ihs_pending ON patient(tenant_id, ihs_checked_at) WHERE ihs_status IN ('PENDING', 'NOT_FOUND', 'ERROR') AND identity_type = 'NIK';

-- 4. Menu: Integrasi › SATUSEHAT (admin klinik)
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('integration', NULL, 'Integrasi', NULL, 'link', NULL, 850),
  ('integration.satusehat', 'integration', 'SATUSEHAT', '/integrations/satusehat', 'link', 'integration.read', 860)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
