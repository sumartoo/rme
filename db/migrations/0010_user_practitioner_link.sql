-- ClinicRME — migrasi 0010 (Stage 6 batch 3): tautan user ↔ tenaga kesehatan (IAM-FR-016).
-- Satu tenaga kesehatan hanya boleh tertaut ke satu akun (tanda tangan klinis tidak boleh dipakai bersama).
-- Undangan dapat membawa tautan; diterapkan saat undangan diterima.
SET search_path = app, public;

-- FK app_user → practitioner sudah ada sejak baseline; di sini hanya keunikan
CREATE UNIQUE INDEX ux_app_user_practitioner ON app_user(tenant_id, practitioner_id) WHERE practitioner_id IS NOT NULL;

ALTER TABLE user_invitation ADD COLUMN practitioner_id uuid;
ALTER TABLE user_invitation
  ADD CONSTRAINT user_invitation_practitioner_fk FOREIGN KEY (tenant_id, practitioner_id) REFERENCES practitioner(tenant_id, id);
