-- =====================================================================
-- 070 Clinical & Medical Record — Stage 9 (CLN-FR-*), ADR-0006
-- Satu clinical_note utama per encounter. Setelah SIGNED, catatan dan seluruh
-- data klinis encounter (vital, diagnosis, tindakan, resep) terkunci.
-- =====================================================================
SET search_path = app, public;

CREATE TABLE stored_file (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  category      text NOT NULL CHECK (category IN ('MEDICAL_DOCUMENT','UPLOAD','LAB_RESULT','EXPORT','BRANDING','REPORT')),
  object_path   text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  sha256        text NOT NULL,
  patient_id    uuid,
  uploaded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (object_path)
);
COMMENT ON TABLE stored_file IS 'Metadata berkas di Cloud Storage (ADR-0013, DOC-FR-002/003)';

CREATE TABLE clinical_note (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  encounter_id    uuid NOT NULL,
  template_code   text NOT NULL DEFAULT 'UMUM',
  subjective      text,
  objective       text,
  assessment      text,
  plan            text,
  structured      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SIGNED')),
  signed_by       uuid,
  signed_at       timestamptz,
  content_hash    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, encounter_id),
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id),
  FOREIGN KEY (tenant_id, signed_by) REFERENCES practitioner(tenant_id, id),
  CHECK (status <> 'SIGNED' OR (signed_by IS NOT NULL AND signed_at IS NOT NULL AND content_hash IS NOT NULL))
);
COMMENT ON TABLE clinical_note IS 'Catatan SOAP utama per kunjungan; SIGNED = immutable (CLN-FR-004/017)';
COMMENT ON COLUMN clinical_note.structured IS 'Isian terstruktur dari template spesialisasi (CLN-FR-005)';
COMMENT ON COLUMN clinical_note.content_hash IS 'SHA-256 isi kanonik saat pengesahan (ADR-0006)';

CREATE TABLE clinical_addendum (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  note_id       uuid NOT NULL,
  reason        text NOT NULL CHECK (length(trim(reason)) > 0),
  content       text NOT NULL,
  changes       jsonb,
  author_id     uuid NOT NULL,
  signed_at     timestamptz NOT NULL DEFAULT now(),
  content_hash  text NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, note_id) REFERENCES clinical_note(tenant_id, id),
  FOREIGN KEY (tenant_id, author_id) REFERENCES practitioner(tenant_id, id)
);
COMMENT ON TABLE clinical_addendum IS 'Koreksi atas catatan yang sudah disahkan; append-only (CLN-FR-019)';

CREATE TABLE observation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  encounter_id  uuid NOT NULL,
  code          text NOT NULL CHECK (code IN ('SYSTOLIC','DIASTOLIC','HEART_RATE','RESP_RATE','TEMPERATURE','SPO2','WEIGHT','HEIGHT','BMI','PAIN_SCALE','OTHER')),
  value_num     numeric(10,2),
  value_text    text,
  unit          text,
  recorded_by   uuid NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id),
  CHECK (code <> 'TEMPERATURE' OR value_num BETWEEN 25 AND 45),
  CHECK (code <> 'SPO2' OR value_num BETWEEN 0 AND 100)
);
COMMENT ON TABLE observation IS 'Tanda vital & observasi (CLN-FR-002); batas fisik menolak salah input (AC-CLN-FR-002-2)';

CREATE TABLE allergy_intolerance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  patient_id    uuid NOT NULL,
  substance     text NOT NULL,
  category      text NOT NULL CHECK (category IN ('OBAT','MAKANAN','LINGKUNGAN','LAINNYA')),
  reaction      text,
  severity      text CHECK (severity IN ('RINGAN','SEDANG','BERAT')),
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','ENTERED_IN_ERROR')),
  recorded_by   uuid NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id)
);
COMMENT ON TABLE allergy_intolerance IS 'Alergi pasien, tampil di header klinis & farmasi (CLN-FR-006)';

CREATE TABLE patient_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  patient_id   uuid NOT NULL,
  history_type text NOT NULL CHECK (history_type IN ('PENYAKIT','OBAT_RUTIN','KELUARGA','SOSIAL','OPERASI')),
  description  text NOT NULL,
  recorded_by  uuid NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id)
);
COMMENT ON TABLE patient_history IS 'Riwayat penyakit & obat rutin (CLN-FR-007)';

CREATE TABLE condition_dx (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  encounter_id  uuid NOT NULL,
  concept_id    uuid NOT NULL REFERENCES concept(id),
  rank          text NOT NULL CHECK (rank IN ('PRIMER','SEKUNDER')),
  case_status   text NOT NULL DEFAULT 'BARU' CHECK (case_status IN ('BARU','LAMA')),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id)
);
CREATE UNIQUE INDEX ux_condition_primary ON condition_dx(tenant_id, encounter_id) WHERE rank = 'PRIMER';
COMMENT ON TABLE condition_dx IS 'Diagnosis ICD-10; tepat satu primer per kunjungan (AC-CLN-FR-008-1)';

CREATE TABLE procedure_act (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  encounter_id     uuid NOT NULL,
  concept_id       uuid REFERENCES concept(id),
  service_item_id  uuid NOT NULL,
  performed_by     uuid NOT NULL,
  qty              numeric(10,2) NOT NULL DEFAULT 1 CHECK (qty > 0),
  performed_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id),
  FOREIGN KEY (tenant_id, service_item_id) REFERENCES service_item(tenant_id, id),
  FOREIGN KEY (tenant_id, performed_by) REFERENCES practitioner(tenant_id, id)
);
COMMENT ON TABLE procedure_act IS 'Tindakan ICD-9-CM; otomatis menjadi baris tagihan (CLN-FR-009)';

CREATE TABLE prescription (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  prescription_no  text NOT NULL,
  encounter_id     uuid NOT NULL,
  prescriber_id    uuid NOT NULL,
  status           text NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT','ISSUED','VERIFIED','PARTIALLY_DISPENSED','DISPENSED','CANCELLED')),
  review_checklist jsonb,
  reviewed_by      uuid,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, prescription_no),
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id),
  FOREIGN KEY (tenant_id, prescriber_id) REFERENCES practitioner(tenant_id, id),
  CHECK (status NOT IN ('VERIFIED','PARTIALLY_DISPENSED','DISPENSED') OR review_checklist IS NOT NULL)
);
COMMENT ON TABLE prescription IS 'Resep elektronik; status farmasi tetap dapat berubah setelah RM disahkan (CLN-FR-010, PHM-FR-007)';

CREATE TABLE prescription_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  prescription_id  uuid NOT NULL,
  line_no          smallint NOT NULL,
  is_compound      boolean NOT NULL DEFAULT false,
  drug_item_id     uuid,
  compound_name    text,
  compound_form    text,
  dose             text,
  frequency        text NOT NULL,
  route            text NOT NULL,
  duration_days    smallint,
  qty              numeric(18,4) NOT NULL CHECK (qty > 0),
  uom_id           uuid NOT NULL,
  instructions     text,
  qty_dispensed    numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_dispensed >= 0),
  substituted_from_drug_id uuid,
  substitution_reason text,
  substitution_approved_by uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, prescription_id, line_no),
  FOREIGN KEY (tenant_id, prescription_id) REFERENCES prescription(tenant_id, id),
  FOREIGN KEY (tenant_id, drug_item_id) REFERENCES drug_item(tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uom(tenant_id, id),
  FOREIGN KEY (tenant_id, substitution_approved_by) REFERENCES practitioner(tenant_id, id),
  CHECK (is_compound OR drug_item_id IS NOT NULL),
  CHECK (NOT is_compound OR compound_name IS NOT NULL),
  CHECK (qty_dispensed <= qty),
  CHECK (substituted_from_drug_id IS NULL OR (substitution_reason IS NOT NULL AND substitution_approved_by IS NOT NULL))
);
COMMENT ON TABLE prescription_item IS 'Baris resep non-racikan / racikan; qty_dispensed melacak resep parsial (PHM-FR-009/010)';

CREATE TABLE prescription_compound_component (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  prescription_item_id  uuid NOT NULL,
  drug_item_id          uuid NOT NULL,
  qty                   numeric(18,4) NOT NULL CHECK (qty > 0),
  uom_id                uuid NOT NULL,
  FOREIGN KEY (tenant_id, prescription_item_id) REFERENCES prescription_item(tenant_id, id),
  FOREIGN KEY (tenant_id, drug_item_id) REFERENCES drug_item(tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uom(tenant_id, id)
);
COMMENT ON TABLE prescription_compound_component IS 'Komponen resep racikan (CLN-FR-011)';

CREATE TABLE lab_order (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  order_no           text NOT NULL,
  encounter_id       uuid NOT NULL,
  ordered_by         uuid NOT NULL,
  lab_connector      text,
  external_order_id  text,
  status             text NOT NULL DEFAULT 'ORDERED' CHECK (status IN ('ORDERED','SENT','RECEIVED','RESULTED','CANCELLED','ERROR')),
  clinical_info      text,
  ordered_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, order_no),
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id),
  FOREIGN KEY (tenant_id, ordered_by) REFERENCES practitioner(tenant_id, id)
);
COMMENT ON TABLE lab_order IS 'Order ke aplikasi lab eksisting (CLN-FR-014, DEC-009)';

CREATE TABLE lab_order_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  lab_order_id     uuid NOT NULL,
  service_item_id  uuid NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, lab_order_id) REFERENCES lab_order(tenant_id, id),
  FOREIGN KEY (tenant_id, service_item_id) REFERENCES service_item(tenant_id, id)
);

CREATE TABLE lab_result (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  lab_order_id       uuid NOT NULL,
  lab_order_item_id  uuid,
  source             text NOT NULL CHECK (source IN ('CONNECTOR','MANUAL','UPLOAD')),
  test_name          text,
  value_text         text,
  unit               text,
  reference_range    text,
  flag               text CHECK (flag IN ('N','L','H','LL','HH','A')),
  file_id            uuid,
  resulted_at        timestamptz NOT NULL DEFAULT now(),
  entered_by         uuid,
  FOREIGN KEY (tenant_id, lab_order_id) REFERENCES lab_order(tenant_id, id),
  FOREIGN KEY (tenant_id, lab_order_item_id) REFERENCES lab_order_item(tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES stored_file(tenant_id, id),
  CHECK (source <> 'UPLOAD' OR file_id IS NOT NULL)
);
COMMENT ON TABLE lab_result IS 'Hasil lab dari konektor, input manual, atau unggahan PDF (CLN-FR-015)';

CREATE TABLE medical_document (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  document_no   text NOT NULL,
  doc_type      text NOT NULL CHECK (doc_type IN ('RESUME','SURAT_SEHAT','SURAT_SAKIT','RUJUKAN','KWITANSI','ETIKET','LAINNYA')),
  encounter_id  uuid,
  patient_id    uuid NOT NULL,
  file_id       uuid NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_by     uuid NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, document_no),
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES stored_file(tenant_id, id)
);
COMMENT ON TABLE medical_document IS 'Dokumen medis terbit (PDF tersimpan, tidak dibuat ulang) (CLN-FR-020/021, DOC-FR-002)';

CREATE TABLE referral (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  encounter_id     uuid NOT NULL,
  destination      text NOT NULL,
  destination_unit text,
  reason           text NOT NULL,
  clinical_summary text,
  document_id      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id)
);
COMMENT ON TABLE referral IS 'Rujukan keluar (CLN-FR-022)';

-- ---------------------------------------------------------------------
-- Immutability (ADR-0006)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.guard_clinical_note() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'SIGNED' THEN RAISE EXCEPTION 'IMMUTABLE: clinical_note sudah disahkan' USING ERRCODE='P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'SIGNED' THEN
    RAISE EXCEPTION 'IMMUTABLE: clinical_note sudah disahkan; gunakan addendum' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_clinical_note_guard BEFORE UPDATE OR DELETE ON clinical_note
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_note();

CREATE OR REPLACE FUNCTION app.guard_encounter_clinical_child() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_enc uuid; v_tenant uuid; v_signed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN v_enc := OLD.encounter_id; v_tenant := OLD.tenant_id;
  ELSE v_enc := NEW.encounter_id; v_tenant := NEW.tenant_id; END IF;
  SELECT EXISTS (SELECT 1 FROM clinical_note n
                  WHERE n.tenant_id = v_tenant AND n.encounter_id = v_enc AND n.status = 'SIGNED')
    INTO v_signed;
  IF v_signed THEN
    RAISE EXCEPTION 'IMMUTABLE: % untuk encounter yang sudah disahkan', TG_TABLE_NAME USING ERRCODE='P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_observation_guard  BEFORE INSERT OR UPDATE OR DELETE ON observation  FOR EACH ROW EXECUTE FUNCTION app.guard_encounter_clinical_child();
CREATE TRIGGER trg_condition_guard    BEFORE INSERT OR UPDATE OR DELETE ON condition_dx FOR EACH ROW EXECUTE FUNCTION app.guard_encounter_clinical_child();
CREATE TRIGGER trg_procedure_guard    BEFORE INSERT OR UPDATE OR DELETE ON procedure_act FOR EACH ROW EXECUTE FUNCTION app.guard_encounter_clinical_child();

-- Resep: isi klinis terkunci setelah ISSUED; hanya kolom proses farmasi yang boleh berubah.
CREATE OR REPLACE FUNCTION app.guard_prescription() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE allowed text[] := ARRAY['status','review_checklist','reviewed_by','reviewed_at','updated_at','updated_by','version'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'IMMUTABLE: resep sudah diterbitkan' USING ERRCODE='P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' AND (to_jsonb(NEW) - allowed) <> (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION 'IMMUTABLE: isi resep tidak dapat diubah setelah diterbitkan' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_prescription_guard BEFORE UPDATE OR DELETE ON prescription
  FOR EACH ROW EXECUTE FUNCTION app.guard_prescription();

CREATE OR REPLACE FUNCTION app.guard_prescription_item() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text; v_rx uuid; v_tenant uuid;
  allowed text[] := ARRAY['qty_dispensed','drug_item_id','substituted_from_drug_id','substitution_reason','substitution_approved_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN v_rx := OLD.prescription_id; v_tenant := OLD.tenant_id;
  ELSE v_rx := NEW.prescription_id; v_tenant := NEW.tenant_id; END IF;
  SELECT status INTO v_status FROM prescription WHERE tenant_id = v_tenant AND id = v_rx;
  IF v_status <> 'DRAFT' THEN
    IF TG_OP IN ('INSERT','DELETE') THEN
      RAISE EXCEPTION 'IMMUTABLE: baris resep terkunci' USING ERRCODE='P0001';
    END IF;
    IF (to_jsonb(NEW) - allowed) <> (to_jsonb(OLD) - allowed) THEN
      RAISE EXCEPTION 'IMMUTABLE: hanya jumlah diserahkan & substitusi yang dapat diubah' USING ERRCODE='P0001';
    END IF;
    IF NEW.drug_item_id IS DISTINCT FROM OLD.drug_item_id AND NEW.substitution_approved_by IS NULL THEN
      RAISE EXCEPTION 'Substitusi memerlukan persetujuan dokter' USING ERRCODE='P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_prescription_item_guard BEFORE INSERT OR UPDATE OR DELETE ON prescription_item
  FOR EACH ROW EXECUTE FUNCTION app.guard_prescription_item();

CREATE TRIGGER trg_addendum_immutable BEFORE UPDATE OR DELETE ON clinical_addendum
  FOR EACH ROW EXECUTE FUNCTION app.reject_modification();
CREATE TRIGGER trg_medical_document_immutable BEFORE UPDATE OR DELETE ON medical_document
  FOR EACH ROW EXECUTE FUNCTION app.reject_modification();

COMMENT ON TABLE lab_order_item IS 'Pemeriksaan yang diminta dalam satu order lab';
