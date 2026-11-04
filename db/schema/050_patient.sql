-- =====================================================================
-- 050 Patient — Stage 8 (REG-FR-*)
-- NIK: disimpan terenkripsi (aplikasi, AES-GCM via kunci KMS) + HMAC untuk pencarian.
-- =====================================================================
SET search_path = app, public;

CREATE TABLE patient (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  mrn                text NOT NULL,
  full_name          text NOT NULL,
  birth_date         date NOT NULL,
  sex                text NOT NULL CHECK (sex IN ('L','P','TIDAK_DIKETAHUI')),
  identity_type      text NOT NULL CHECK (identity_type IN ('NIK','PASPOR','KITAS','BAYI_IDENTITAS_IBU','TANPA_IDENTITAS')),
  nik_encrypted      bytea,
  nik_hash           text,
  identity_value_encrypted bytea,
  mother_patient_id  uuid,
  phone              text,
  email              text,
  address            text,
  region_code        text REFERENCES region(code),
  ihs_number         text,
  ihs_status         text NOT NULL DEFAULT 'PENDING' CHECK (ihs_status IN ('PENDING','FOUND','NOT_FOUND','NOT_APPLICABLE','ERROR')),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','MERGED','DECEASED','INACTIVE')),
  merged_into_id     uuid,
  registered_branch_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  version            int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, mrn),
  FOREIGN KEY (tenant_id, merged_into_id) REFERENCES patient(tenant_id, id),
  FOREIGN KEY (tenant_id, mother_patient_id) REFERENCES patient(tenant_id, id),
  FOREIGN KEY (tenant_id, registered_branch_id) REFERENCES branch(tenant_id, id),
  CHECK (identity_type <> 'NIK' OR (nik_encrypted IS NOT NULL AND nik_hash IS NOT NULL)),
  CHECK (status <> 'MERGED' OR merged_into_id IS NOT NULL)
);
CREATE UNIQUE INDEX ux_patient_nik ON patient(tenant_id, nik_hash) WHERE nik_hash IS NOT NULL AND status <> 'MERGED';
CREATE INDEX ix_patient_name_trgm ON patient USING gin (full_name gin_trgm_ops);
CREATE INDEX ix_patient_dob ON patient(tenant_id, birth_date);
CREATE INDEX ix_patient_phone ON patient(tenant_id, phone);
COMMENT ON TABLE patient IS 'Master Patient Index per tenant, dipakai lintas cabang (REG-FR-001/002/012)';
COMMENT ON COLUMN patient.nik_encrypted IS 'NIK terenkripsi di aplikasi; tidak pernah ditulis ke log (REG-FR-009)';
COMMENT ON COLUMN patient.nik_hash IS 'HMAC-SHA256 NIK untuk pencarian & deteksi duplikat pasti (REG-FR-004)';
COMMENT ON COLUMN patient.merged_into_id IS 'Pasien tujuan merge; data tidak dihapus (REG-FR-005)';

CREATE TABLE patient_contact (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  patient_id   uuid NOT NULL,
  relation     text NOT NULL,
  full_name    text NOT NULL,
  phone        text NOT NULL,
  is_guardian  boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id)
);
COMMENT ON TABLE patient_contact IS 'Kontak darurat & wali (REG-FR-006)';

CREATE TABLE patient_coverage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  patient_id    uuid NOT NULL,
  payer_id      uuid NOT NULL,
  member_no     text,
  plan_name     text,
  employee_no   text,
  bpjs_faskes_code text,
  valid_from    date,
  valid_to      date,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id),
  FOREIGN KEY (tenant_id, payer_id) REFERENCES payer(tenant_id, id)
);
COMMENT ON TABLE patient_coverage IS 'Penjamin pasien; satu pasien dapat punya beberapa (REG-FR-007); field BPJS disiapkan (BPJ-FR-004)';

CREATE TABLE consent_document (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  consent_type text NOT NULL CHECK (consent_type IN ('UMUM','DATA_SHARING','PORTAL')),
  version     text NOT NULL,
  content     text NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, consent_type, version)
);
COMMENT ON TABLE consent_document IS 'Teks consent berversi';

CREATE TABLE patient_consent (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  patient_id           uuid NOT NULL,
  consent_document_id  uuid NOT NULL,
  granted              boolean NOT NULL,
  signed_by_name       text,
  signed_by_relation   text,
  recorded_by          uuid NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id),
  FOREIGN KEY (tenant_id, consent_document_id) REFERENCES consent_document(tenant_id, id)
);
COMMENT ON TABLE patient_consent IS 'Consent pasien dengan versi dokumen & waktu (REG-FR-008)';
