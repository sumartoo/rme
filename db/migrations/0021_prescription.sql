-- ClinicRME — migrasi 0021 (Stage 9 batch 3): master obat minimal & resep elektronik (CLN-FR-010–012; OD-033, OD-091, OD-094 / DEC-038).
SET search_path = app, public;

-- 1. Master obat (OD-091): batas dosis opsional dalam satuan dasar obat (OD-033). Stok/harga/KFA di Stage 10.
ALTER TABLE drug_item
  ADD COLUMN max_dose_qty  numeric(18,4) CHECK (max_dose_qty > 0),
  ADD COLUMN max_daily_qty numeric(18,4) CHECK (max_daily_qty > 0),
  ADD CONSTRAINT drug_item_daily_ge_dose CHECK (max_dose_qty IS NULL OR max_daily_qty IS NULL OR max_daily_qty >= max_dose_qty);
COMMENT ON COLUMN drug_item.max_dose_qty IS 'Batas jumlah per pemberian (satuan dasar) untuk peringatan resep — [REVIEW-MEDIS]';
COMMENT ON COLUMN drug_item.max_daily_qty IS 'Batas jumlah per hari (satuan dasar) untuk peringatan resep — [REVIEW-MEDIS]';
REVOKE DELETE ON drug_item FROM clinicrme_app;

-- 2. Resep: satu resep aktif per kunjungan; peringatan & alasan dokter melanjutkan (OD-033) disimpan saat diterbitkan.
ALTER TABLE prescription
  ADD COLUMN issued_at timestamptz,
  ADD COLUMN alerts    jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN notes     text,
  ADD CONSTRAINT prescription_issued_at CHECK (status = 'DRAFT' OR status = 'CANCELLED' OR issued_at IS NOT NULL);
CREATE UNIQUE INDEX ux_prescription_encounter_active ON prescription(tenant_id, encounter_id) WHERE status <> 'CANCELLED';
REVOKE DELETE ON prescription FROM clinicrme_app;

-- 3. Item resep: dosis terstruktur untuk validasi batas (jumlah per pemberian × kali per hari)
ALTER TABLE prescription_item
  ADD COLUMN dose_qty      numeric(18,4) CHECK (dose_qty > 0),
  ADD COLUMN times_per_day smallint CHECK (times_per_day BETWEEN 1 AND 24);

-- 4. Komponen racikan ikut terkunci setelah resep diterbitkan
CREATE OR REPLACE FUNCTION app.guard_compound_component() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_item uuid; v_tenant uuid; v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN v_item := OLD.prescription_item_id; v_tenant := OLD.tenant_id;
  ELSE v_item := NEW.prescription_item_id; v_tenant := NEW.tenant_id; END IF;
  SELECT p.status INTO v_status FROM app.prescription_item i JOIN app.prescription p ON p.tenant_id = i.tenant_id AND p.id = i.prescription_id
   WHERE i.tenant_id = v_tenant AND i.id = v_item;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'IMMUTABLE: komponen racikan tidak dapat diubah setelah resep diterbitkan' USING ERRCODE='P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_compound_component_guard BEFORE INSERT OR UPDATE OR DELETE ON prescription_compound_component
  FOR EACH ROW EXECUTE FUNCTION app.guard_compound_component();
CREATE INDEX ix_prescription_item_rx ON prescription_item(tenant_id, prescription_id);
CREATE INDEX ix_compound_component_item ON prescription_compound_component(tenant_id, prescription_item_id);

-- 5. Menu master obat
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('master.drugs', 'master', 'Obat', '/master/drugs', 'package', 'pharmacy.drug.read', 855)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
