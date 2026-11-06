-- ClinicRME — migrasi 0019 (Stage 9 batch 1): worklist & pencatatan klinis (CLN-FR-001, 002, 004–009, 016; OD-035, OD-092 / DEC-038).
SET search_path = app, public;

-- 1. Template klinis bawaan per poli (OD-035). NULL = UMUM.
ALTER TABLE service_unit
  ADD CONSTRAINT service_unit_default_template CHECK (default_template IS NULL OR default_template IN ('UMUM','GIGI','ANAK','KEBIDANAN'));
ALTER TABLE clinical_note
  ADD CONSTRAINT clinical_note_template CHECK (template_code IN ('UMUM','GIGI','ANAK','KEBIDANAN'));

-- 2. Kunjungan: waktu triase (tanda vital pertama) untuk worklist perawat → dokter.
ALTER TABLE encounter ADD COLUMN triaged_at timestamptz;

-- 3. Alergi & riwayat: tidak dihapus; dinonaktifkan / "salah input" dengan alasan (CLN-FR-006, 007).
ALTER TABLE allergy_intolerance
  ADD COLUMN status_reason     text,
  ADD COLUMN status_changed_by uuid,
  ADD COLUMN status_changed_at timestamptz,
  ADD CONSTRAINT allergy_status_reason CHECK (status = 'ACTIVE' OR status_reason IS NOT NULL);
ALTER TABLE patient_history
  ADD COLUMN status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','ENTERED_IN_ERROR')),
  ADD COLUMN status_reason     text,
  ADD COLUMN status_changed_by uuid,
  ADD COLUMN status_changed_at timestamptz,
  ADD CONSTRAINT patient_history_status_reason CHECK (status = 'ACTIVE' OR status_reason IS NOT NULL);
CREATE INDEX ix_allergy_patient ON allergy_intolerance(tenant_id, patient_id);
CREATE INDEX ix_patient_history_patient ON patient_history(tenant_id, patient_id);
CREATE INDEX ix_observation_encounter ON observation(tenant_id, encounter_id, recorded_at);
CREATE INDEX ix_condition_encounter ON condition_dx(tenant_id, encounter_id);
CREATE INDEX ix_procedure_encounter ON procedure_act(tenant_id, encounter_id);

-- Rekam medis tidak dihapus oleh aplikasi. Diagnosis & tindakan boleh dihapus selama catatan belum disahkan
-- (trigger guard_encounter_clinical_child menolak setelah SIGNED).
REVOKE DELETE ON allergy_intolerance, patient_history, observation, clinical_note FROM clinicrme_app;

-- 4. Menu pelayanan
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('service.worklist', 'service', 'Worklist klinis', '/worklist', 'stethoscope', 'clinical.record.read', 107)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
