-- ClinicRME — migrasi 0024 (Stage 10 batch 2): telaah resep & penyerahan obat (PHM-FR-005–009, 011, 013; OD-037, OD-096, OD-098, OD-102–104 / DEC-039).
SET search_path = app, public;

-- 1. Resep: status CLOSED (seluruh sisa ditutup tanpa ada yang diserahkan), waktu penyerahan pertama (batas ambil sisa OD-104)
ALTER TABLE prescription DROP CONSTRAINT prescription_status_check;
ALTER TABLE prescription ADD CONSTRAINT prescription_status_check
  CHECK (status IN ('DRAFT','ISSUED','VERIFIED','PARTIALLY_DISPENSED','DISPENSED','CLOSED','CANCELLED'));
ALTER TABLE prescription
  ADD COLUMN first_dispensed_at timestamptz,
  ADD COLUMN closed_reason      text;
CREATE INDEX ix_prescription_status ON prescription(tenant_id, status, issued_at);

-- 2. Baris resep: sisa yang ditutup (tidak diambil / tidak ditebus) tidak ditagih
ALTER TABLE prescription_item
  ADD COLUMN qty_closed   numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_closed >= 0),
  ADD COLUMN close_reason text,
  ADD CONSTRAINT prescription_item_qty_settled CHECK (qty_dispensed + qty_closed <= qty);

-- 3. Guard resep: kolom proses farmasi baru boleh berubah setelah diterbitkan
CREATE OR REPLACE FUNCTION app.guard_prescription() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE allowed text[] := ARRAY['status','review_checklist','reviewed_by','reviewed_at','updated_at','updated_by','version',
                                'first_dispensed_at','closed_reason'];
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

CREATE OR REPLACE FUNCTION app.guard_prescription_item() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text; v_rx uuid; v_tenant uuid;
  allowed text[] := ARRAY['qty_dispensed','qty_closed','close_reason','drug_item_id','substituted_from_drug_id','substitution_reason','substitution_approved_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN v_rx := OLD.prescription_id; v_tenant := OLD.tenant_id;
  ELSE v_rx := NEW.prescription_id; v_tenant := NEW.tenant_id; END IF;
  SELECT status INTO v_status FROM app.prescription WHERE tenant_id = v_tenant AND id = v_rx;
  IF v_status <> 'DRAFT' THEN
    IF TG_OP IN ('INSERT','DELETE') THEN
      RAISE EXCEPTION 'IMMUTABLE: baris resep terkunci' USING ERRCODE='P0001';
    END IF;
    IF (to_jsonb(NEW) - allowed) <> (to_jsonb(OLD) - allowed) THEN
      RAISE EXCEPTION 'IMMUTABLE: hanya jumlah diserahkan/ditutup & substitusi yang dapat diubah' USING ERRCODE='P0001';
    END IF;
    IF NEW.drug_item_id IS DISTINCT FROM OLD.drug_item_id AND NEW.substitution_approved_by IS NULL THEN
      RAISE EXCEPTION 'Substitusi memerlukan persetujuan dokter' USING ERRCODE='P0001';
    END IF;
    IF NEW.qty_dispensed < OLD.qty_dispensed OR NEW.qty_closed < OLD.qty_closed THEN
      RAISE EXCEPTION 'IMMUTABLE: jumlah diserahkan/ditutup tidak dapat dikurangi' USING ERRCODE='P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

-- 4. Penyerahan: harga jual terkunci per satuan dasar & status tagih (OD-096); batch manual wajib beralasan (OD-037)
ALTER TABLE dispense
  ADD COLUMN notes text,
  ADD COLUMN pharmacist_id uuid;
ALTER TABLE dispense ADD CONSTRAINT dispense_pharmacist_fk FOREIGN KEY (tenant_id, pharmacist_id) REFERENCES practitioner(tenant_id, id);
ALTER TABLE dispense_line
  ADD COLUMN drug_item_id          uuid NOT NULL,
  ADD COLUMN unit_price            numeric(18,2) NOT NULL CHECK (unit_price >= 0),
  ADD COLUMN drug_price_id         uuid,
  ADD COLUMN billing_status        text NOT NULL DEFAULT 'UNBILLED' CHECK (billing_status IN ('UNBILLED','BILLED','VOID')),
  ADD COLUMN batch_override_reason text,
  ADD COLUMN item_qty              numeric(18,4) NOT NULL CHECK (item_qty > 0);
COMMENT ON COLUMN dispense_line.item_qty IS 'Jumlah baris resep (satuan resep) yang dipenuhi baris ini; racikan: jumlah racikan, sama di setiap komponen';
ALTER TABLE dispense_line ADD CONSTRAINT dispense_line_drug_fk FOREIGN KEY (tenant_id, drug_item_id) REFERENCES drug_item(tenant_id, id);
COMMENT ON COLUMN dispense_line.unit_price IS 'Harga jual per satuan dasar saat diserahkan (OD-096); ditagih di Stage 11 sejumlah qty_base × unit_price';
CREATE INDEX ix_dispense_rx ON dispense(tenant_id, prescription_id);
CREATE INDEX ix_dispense_line_dispense ON dispense_line(tenant_id, dispense_id);
CREATE INDEX ix_dispense_line_unbilled ON dispense_line(tenant_id, billing_status) WHERE billing_status = 'UNBILLED';
-- Riwayat penyerahan tidak dapat diubah; hanya status tagih yang diperbarui modul kasir.
REVOKE UPDATE, DELETE ON dispense FROM clinicrme_app;
REVOKE UPDATE, DELETE ON dispense_line FROM clinicrme_app;
GRANT UPDATE (billing_status) ON dispense_line TO clinicrme_app;

-- 5. Menu worklist farmasi
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('pharmacy.worklist', 'pharmacy', 'Resep masuk', '/pharmacy/worklist', 'clipboard', 'pharmacy.dispense', 305)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
