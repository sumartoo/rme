-- ClinicRME — migrasi 0020 (Stage 9 batch 2): pengesahan rekam medis & addendum (CLN-FR-017–019; OD-034, OD-092 / DEC-038).
SET search_path = app, public;

-- 1. Jejak pengesahan (OD-034): akun yang mengesahkan, SIP saat itu, cara konfirmasi ulang, alasan bila dokter pengganti.
--    Kolom ditulis sekali bersama status SIGNED; trigger guard_clinical_note menolak perubahan sesudahnya.
ALTER TABLE clinical_note
  ADD COLUMN signer_user_id     uuid,
  ADD COLUMN signer_sip         text,
  ADD COLUMN sign_method        text CHECK (sign_method IN ('PASSWORD','TOTP')),
  ADD COLUMN substitute_reason  text,
  ADD CONSTRAINT clinical_note_signed_meta CHECK (status <> 'SIGNED' OR (signer_user_id IS NOT NULL AND sign_method IS NOT NULL));

-- 2. Addendum: akun penulis & cara konfirmasi ulang; satu urutan per catatan.
ALTER TABLE clinical_addendum
  ADD COLUMN author_user_id  uuid,
  ADD COLUMN author_sip      text,
  ADD COLUMN sign_method     text CHECK (sign_method IN ('PASSWORD','TOTP'));
CREATE INDEX ix_addendum_note ON clinical_addendum(tenant_id, note_id, signed_at);

-- 3. Riwayat rekam medis pasien: catatan disahkan per pasien terurut waktu
CREATE INDEX ix_encounter_patient_arrived ON encounter(tenant_id, patient_id, arrived_at DESC);

-- 4. Addendum hanya untuk catatan yang sudah disahkan (penjaga di database, selain aplikasi)
CREATE OR REPLACE FUNCTION app.guard_addendum_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.clinical_note n WHERE n.tenant_id = NEW.tenant_id AND n.id = NEW.note_id AND n.status = 'SIGNED') THEN
    RAISE EXCEPTION 'Addendum hanya untuk catatan yang sudah disahkan' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_addendum_insert BEFORE INSERT ON clinical_addendum FOR EACH ROW EXECUTE FUNCTION app.guard_addendum_insert();
