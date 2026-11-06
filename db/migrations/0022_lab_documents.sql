-- ClinicRME — migrasi 0022 (Stage 9 batch 4): order & hasil lab, dokumen medis PDF, rujukan (CLN-FR-014, 015, 020–022; OD-059, OD-093 / DEC-038).
SET search_path = app, public;

-- 1. Order lab: alasan batal; hasil boleh disertai catatan. Konektor per klinik di tenant.settings.labConnector (NONE | MOCK).
ALTER TABLE lab_order
  ADD COLUMN cancel_reason text,
  ADD COLUMN resulted_at   timestamptz,
  ADD CONSTRAINT lab_order_cancel_reason CHECK (status <> 'CANCELLED' OR cancel_reason IS NOT NULL);
ALTER TABLE lab_result ADD COLUMN notes text;
CREATE INDEX ix_lab_order_encounter ON lab_order(tenant_id, encounter_id);
CREATE INDEX ix_lab_result_order ON lab_result(tenant_id, lab_order_id);
-- Hasil lab tidak diubah/dihapus (koreksi = hasil baru); order dibatalkan dengan alasan, tidak dihapus
REVOKE UPDATE, DELETE ON lab_result FROM clinicrme_app;
REVOKE DELETE ON lab_order, lab_order_item FROM clinicrme_app;

-- 2. Dokumen medis: hash isi untuk kode verifikasi pada PDF; berkas & metadata tidak dapat diubah
ALTER TABLE medical_document ADD COLUMN content_hash text CHECK (content_hash ~ '^[0-9a-f]{64}$');
CREATE INDEX ix_medical_document_encounter ON medical_document(tenant_id, encounter_id);
REVOKE UPDATE, DELETE ON stored_file FROM clinicrme_app;

-- 3. Rujukan keluar tertaut ke dokumennya
ALTER TABLE referral ADD CONSTRAINT referral_document_fk FOREIGN KEY (document_id) REFERENCES medical_document(id);
REVOKE UPDATE, DELETE ON referral FROM clinicrme_app;
