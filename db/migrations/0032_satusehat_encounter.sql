-- ClinicRME — migrasi 0032 (Stage 12 batch 2): pengiriman kunjungan rawat jalan ke SATUSEHAT
-- (INT-FR-004, 008; OD-115, OD-118, OD-119 / DEC-044).
SET search_path = app, public;

-- BLOCKED = belum dikirim karena data belum lengkap (dicek ulang tiap putaran); problems = daftar masalah & peringatan
ALTER TABLE fhir_sync_record DROP CONSTRAINT fhir_sync_record_status_check;
ALTER TABLE fhir_sync_record ADD CONSTRAINT fhir_sync_record_status_check
  CHECK (status IN ('PENDING', 'BLOCKED', 'SENT', 'ERROR', 'DEAD', 'SKIPPED'));
ALTER TABLE fhir_sync_record
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN problems        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN parent_id       uuid;
ALTER TABLE fhir_sync_record ADD CONSTRAINT fhir_sync_record_parent_fk FOREIGN KEY (parent_id) REFERENCES fhir_sync_record(id);
COMMENT ON COLUMN fhir_sync_record.problems IS '{"blocking": [...], "warnings": [...]} — pesan yang dapat ditindaklanjuti, tanpa isi rekam medis';
COMMENT ON COLUMN fhir_sync_record.parent_id IS 'Resource anak (Condition/Observation/Procedure) → baris Encounter-nya';
CREATE INDEX ix_fhir_sync_record_queue ON fhir_sync_record(tenant_id, connection_id, status, next_attempt_at);
CREATE INDEX ix_clinical_note_signed ON clinical_note(tenant_id, signed_at) WHERE status = 'SIGNED';
