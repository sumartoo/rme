-- ClinicRME — migrasi 0033 (Stage 12 batch 3): obat, koreksi addendum, kirim ulang manual
-- (INT-FR-005, 009, 012; OD-118, OD-119, OD-120 / DEC-044).
SET search_path = app, public;

ALTER TABLE fhir_sync_record
  ADD COLUMN local_code          text,
  ADD COLUMN resource_version    integer NOT NULL DEFAULT 1,
  ADD COLUMN entered_in_error_at timestamptz,
  ADD COLUMN resend_requested_at timestamptz,
  ADD COLUMN resend_requested_by uuid;
COMMENT ON COLUMN fhir_sync_record.local_code IS 'Kode lokal yang dikirim (mis. ICD-10 Condition) — untuk membandingkan perubahan diagnosis lewat addendum (OD-120)';
COMMENT ON COLUMN fhir_sync_record.resource_version IS 'Naik setiap resource di-update di SATUSEHAT (riwayat versi, OD-120)';
COMMENT ON COLUMN fhir_sync_record.entered_in_error_at IS 'Condition yang dihapus lewat addendum dikirim ulang dengan verificationStatus entered-in-error';
ALTER TABLE fhir_sync_record ADD CONSTRAINT fhir_sync_record_resend_by_fk
  FOREIGN KEY (tenant_id, resend_requested_by) REFERENCES app_user(tenant_id, id);
CREATE INDEX ix_fhir_sync_record_parent ON fhir_sync_record(tenant_id, parent_id);
-- Addendum yang mengubah diagnosis dipindai worker
CREATE INDEX ix_clinical_addendum_dx ON clinical_addendum(tenant_id, signed_at) WHERE changes ? 'diagnoses';
COMMENT ON COLUMN clinical_addendum.changes IS '{"diagnoses": [{conceptId, code, display, rank, caseStatus, note}]} — daftar diagnosis pengganti (OD-120); ikut di-hash';
