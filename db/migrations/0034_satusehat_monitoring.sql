-- ClinicRME — migrasi 0034 (Stage 12 batch 4): pemantauan & rekonsiliasi SATUSEHAT (INT-FR-010, INT-FR-011).
SET search_path = app, public;

ALTER TABLE fhir_sync_record
  ADD COLUMN remote_checked_at timestamptz,
  ADD COLUMN remote_duplicates integer NOT NULL DEFAULT 0 CHECK (remote_duplicates >= 0);
COMMENT ON COLUMN fhir_sync_record.remote_checked_at IS 'Terakhir dicocokkan dengan SATUSEHAT oleh job rekonsiliasi (Encounter)';
COMMENT ON COLUMN fhir_sync_record.remote_duplicates IS 'Jumlah resource ganda yang ditemukan di SATUSEHAT untuk kunjungan ini saat rekonsiliasi (dilaporkan, tidak dihapus otomatis)';
CREATE INDEX ix_fhir_sync_record_activity ON fhir_sync_record(tenant_id, connection_id, (coalesce(last_sent_at, updated_at)));

-- Menu: Integrasi › Pemantauan SATUSEHAT (dashboard & rekonsiliasi)
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('integration.satusehat_monitoring', 'integration', 'Pemantauan SATUSEHAT', '/integrations/satusehat/monitoring', 'link', 'integration.read', 865)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
