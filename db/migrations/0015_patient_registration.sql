-- ClinicRME — migrasi 0015 (Stage 8 batch 1): master pasien (REG-FR-001..009, 012), OD-068, OD-085, DEC-035.
SET search_path = app, public;

-- 1. Pasien: NIK & identitas lain tersamar untuk tampilan daftar (tanpa dekripsi per baris), indeks buta identitas lain,
--    pembatasan pemrosesan (OD-068), jejak penggabungan (REG-FR-005).
ALTER TABLE patient
  ADD COLUMN nik_masked            text,
  ADD COLUMN identity_value_hash   text,
  ADD COLUMN identity_value_masked text,
  ADD COLUMN processing_restricted boolean NOT NULL DEFAULT false,
  ADD COLUMN restriction_reason    text,
  ADD COLUMN restricted_at         timestamptz,
  ADD COLUMN merged_at             timestamptz,
  ADD COLUMN merge_reason          text,
  ADD CONSTRAINT patient_not_own_mother CHECK (mother_patient_id IS NULL OR mother_patient_id <> id),
  ADD CONSTRAINT patient_not_merged_into_self CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  ADD CONSTRAINT patient_identity_value CHECK (identity_type NOT IN ('PASPOR','KITAS') OR identity_value_hash IS NOT NULL),
  ADD CONSTRAINT patient_restriction_reason CHECK (NOT processing_restricted OR restriction_reason IS NOT NULL);
CREATE INDEX ix_patient_identity ON patient(tenant_id, identity_type, identity_value_hash) WHERE identity_value_hash IS NOT NULL;
CREATE INDEX ix_patient_merged_into ON patient(tenant_id, merged_into_id) WHERE merged_into_id IS NOT NULL;
COMMENT ON COLUMN patient.nik_masked IS '4 digit awal + 4 digit akhir NIK; nilai utuh hanya di nik_encrypted';
COMMENT ON COLUMN patient.identity_value_hash IS 'Indeks buta nomor paspor/KITAS (HMAC per tujuan) untuk pencarian & duplikat pasti';
COMMENT ON COLUMN patient.processing_restricted IS 'OD-068: hentikan notifikasi & pemrosesan opsional; RM, tagihan & pelaporan wajib tetap';

-- Pasien tidak pernah dihapus (retensi RM, REG-FR-005): DELETE dicabut dari role aplikasi.
REVOKE DELETE ON patient FROM clinicrme_app;

-- 2. Penjamin pasien: versi baris (If-Match) & dirujuk kunjungan → tidak dihapus, hanya dinonaktifkan.
ALTER TABLE patient_coverage
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_by uuid,
  ADD COLUMN version    int NOT NULL DEFAULT 1,
  ADD CONSTRAINT patient_coverage_period CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from);
CREATE TRIGGER trg_touch BEFORE UPDATE ON patient_coverage FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE INDEX ix_patient_coverage_patient ON patient_coverage(tenant_id, patient_id);
REVOKE DELETE ON patient_coverage FROM clinicrme_app;

CREATE INDEX ix_patient_contact_patient ON patient_contact(tenant_id, patient_id);

-- 3. Consent: teks berversi tidak diubah setelah terbit (versi baru = baris baru); catatan consent pasien tidak dihapus,
--    pencabutan mengisi revoked_at.
ALTER TABLE consent_document
  ADD COLUMN title      text,
  ADD COLUMN created_by uuid;
REVOKE UPDATE, DELETE ON consent_document FROM clinicrme_app;
REVOKE DELETE ON patient_consent FROM clinicrme_app;
CREATE INDEX ix_patient_consent_patient ON patient_consent(tenant_id, patient_id, recorded_at DESC);

-- 4. Idempotency-Key (API_CONTRACTS §2): permintaan ulang dengan kunci sama mengembalikan hasil pertama.
CREATE TABLE idempotency_record (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  operation     text NOT NULL,
  idem_key      text NOT NULL CHECK (length(idem_key) BETWEEN 16 AND 100),
  user_id       uuid NOT NULL,
  request_hash  text NOT NULL,
  status_code   int NOT NULL,
  response      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation, idem_key)
);
CREATE INDEX ix_idempotency_created ON idempotency_record(created_at);
COMMENT ON TABLE idempotency_record IS 'Hasil pertama per Idempotency-Key (24 jam); kunci sama + isi berbeda ditolak';
SELECT app.enable_tenant_rls('app.idempotency_record'::regclass);
GRANT SELECT, INSERT, DELETE ON idempotency_record TO clinicrme_app;

-- 5. Menu pelayanan & dokumen consent
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('service',          NULL,      'Pelayanan',       NULL,              'clipboard', NULL,                    100),
  ('service.patients', 'service', 'Pasien',          '/patients',       'users',     'patient.read',          110),
  ('admin.consents',   'admin',   'Dokumen consent', '/admin/consents', 'file-text', 'tenant.profile.manage', 915)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
