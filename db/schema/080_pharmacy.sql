-- =====================================================================
-- 080 Pharmacy & Inventory — Stage 10 (PHM-FR-*)
-- Stok = ledger stock_movement (append-only). stock_balance dipelihara trigger
-- dan tidak dapat negatif (PHM-FR-013).
-- =====================================================================
SET search_path = app, public;

CREATE TABLE stock_location (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  branch_id   uuid NOT NULL,
  unit_id     uuid,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES service_unit(tenant_id, id)
);
COMMENT ON TABLE stock_location IS 'Lokasi stok: apotek, gudang (per cabang)';

CREATE TABLE stock_batch (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  drug_item_id   uuid NOT NULL,
  batch_no       text NOT NULL,
  expiry_date    date NOT NULL,
  unit_cost      numeric(18,4) NOT NULL CHECK (unit_cost >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, drug_item_id, batch_no, expiry_date),
  FOREIGN KEY (tenant_id, drug_item_id) REFERENCES drug_item(tenant_id, id)
);
COMMENT ON TABLE stock_batch IS 'Batch obat dengan tanggal kedaluwarsa & harga beli per satuan dasar (PHM-FR-003)';

CREATE TABLE stock_balance (
  tenant_id     uuid NOT NULL,
  batch_id      uuid NOT NULL,
  location_id   uuid NOT NULL,
  qty_on_hand   numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id, location_id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batch(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_location(tenant_id, id)
);
COMMENT ON TABLE stock_balance IS 'Saldo per batch per lokasi; hanya diubah trigger ledger; CHECK >= 0 menolak stok negatif';

CREATE TABLE stock_movement (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  batch_id       uuid NOT NULL,
  location_id    uuid NOT NULL,
  movement_type  text NOT NULL CHECK (movement_type IN ('RECEIPT','DISPENSE','OTC_SALE','RETURN_IN','RETURN_OUT','ADJUSTMENT','OPNAME','TRANSFER_IN','TRANSFER_OUT')),
  qty            numeric(18,4) NOT NULL CHECK (qty <> 0),
  ref_type       text NOT NULL,
  ref_id         uuid NOT NULL,
  actor_id       uuid,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batch(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_location(tenant_id, id),
  CHECK ((movement_type IN ('RECEIPT','RETURN_IN','TRANSFER_IN') AND qty > 0)
      OR (movement_type IN ('DISPENSE','OTC_SALE','RETURN_OUT','TRANSFER_OUT') AND qty < 0)
      OR  movement_type IN ('ADJUSTMENT','OPNAME'))
);
CREATE INDEX ix_stock_movement_batch ON stock_movement(tenant_id, batch_id, occurred_at);
COMMENT ON TABLE stock_movement IS 'Ledger mutasi stok, append-only (PHM-FR-004); qty bertanda (+ masuk, − keluar)';

CREATE OR REPLACE FUNCTION app.apply_stock_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_expiry date;
BEGIN
  IF NEW.qty < 0 THEN
    SELECT expiry_date INTO v_expiry FROM stock_batch WHERE tenant_id = NEW.tenant_id AND id = NEW.batch_id;
    IF NEW.movement_type IN ('DISPENSE','OTC_SALE') AND v_expiry < current_date THEN
      RAISE EXCEPTION 'Batch kedaluwarsa tidak dapat dikeluarkan (PHM-FR-013)' USING ERRCODE='P0001';
    END IF;
  END IF;
  INSERT INTO stock_balance(tenant_id, batch_id, location_id, qty_on_hand)
  VALUES (NEW.tenant_id, NEW.batch_id, NEW.location_id, 0)
  ON CONFLICT DO NOTHING;
  UPDATE stock_balance SET qty_on_hand = qty_on_hand + NEW.qty, updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND batch_id = NEW.batch_id AND location_id = NEW.location_id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_stock_movement_apply AFTER INSERT ON stock_movement
  FOR EACH ROW EXECUTE FUNCTION app.apply_stock_movement();
CREATE TRIGGER trg_stock_movement_immutable BEFORE UPDATE OR DELETE ON stock_movement
  FOR EACH ROW EXECUTE FUNCTION app.reject_modification();

CREATE TABLE goods_receipt (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  receipt_no    text NOT NULL,
  supplier_id   uuid NOT NULL,
  location_id   uuid NOT NULL,
  invoice_no    text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  received_by   uuid NOT NULL,
  status        text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT','POSTED')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, receipt_no),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES supplier(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_location(tenant_id, id)
);
COMMENT ON TABLE goods_receipt IS 'Penerimaan barang dari supplier (PHM-FR-003)';

CREATE TABLE goods_receipt_line (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  goods_receipt_id  uuid NOT NULL,
  batch_id          uuid NOT NULL,
  qty               numeric(18,4) NOT NULL CHECK (qty > 0),
  uom_id            uuid NOT NULL,
  qty_base          numeric(18,4) NOT NULL CHECK (qty_base > 0),
  unit_price        numeric(18,2) NOT NULL CHECK (unit_price >= 0),
  FOREIGN KEY (tenant_id, goods_receipt_id) REFERENCES goods_receipt(tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batch(tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uom(tenant_id, id)
);

CREATE TABLE dispense (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  prescription_id  uuid NOT NULL,
  location_id      uuid NOT NULL,
  dispensed_by     uuid NOT NULL,
  dispensed_at     timestamptz NOT NULL DEFAULT now(),
  handed_to        text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, prescription_id) REFERENCES prescription(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_location(tenant_id, id)
);
COMMENT ON TABLE dispense IS 'Satu sesi penyerahan obat; resep parsial = beberapa dispense (PHM-FR-008/009)';

CREATE TABLE dispense_line (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  dispense_id           uuid NOT NULL,
  prescription_item_id  uuid NOT NULL,
  batch_id              uuid NOT NULL,
  qty_base              numeric(18,4) NOT NULL CHECK (qty_base > 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, dispense_id) REFERENCES dispense(tenant_id, id),
  FOREIGN KEY (tenant_id, prescription_item_id) REFERENCES prescription_item(tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batch(tenant_id, id)
);

CREATE TABLE otc_sale (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  sale_no      text NOT NULL,
  branch_id    uuid NOT NULL,
  location_id  uuid NOT NULL,
  patient_id   uuid,
  sold_by      uuid NOT NULL,
  sold_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sale_no),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_location(tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id)
);
COMMENT ON TABLE otc_sale IS 'Penjualan obat bebas tanpa kunjungan (PHM-FR-012)';

CREATE TABLE otc_sale_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  otc_sale_id   uuid NOT NULL,
  drug_item_id  uuid NOT NULL,
  batch_id      uuid NOT NULL,
  qty_base      numeric(18,4) NOT NULL CHECK (qty_base > 0),
  unit_price    numeric(18,2) NOT NULL CHECK (unit_price >= 0),
  FOREIGN KEY (tenant_id, otc_sale_id) REFERENCES otc_sale(tenant_id, id),
  FOREIGN KEY (tenant_id, drug_item_id) REFERENCES drug_item(tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batch(tenant_id, id)
);

CREATE OR REPLACE FUNCTION app.guard_otc_drug_class() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_class text;
BEGIN
  SELECT drug_class INTO v_class FROM drug_item WHERE tenant_id = NEW.tenant_id AND id = NEW.drug_item_id;
  IF v_class NOT IN ('BEBAS','BEBAS_TERBATAS') THEN
    RAISE EXCEPTION 'Obat golongan % tidak boleh dijual tanpa resep (AC-PHM-FR-012-1)', v_class USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_otc_drug_class BEFORE INSERT OR UPDATE ON otc_sale_line
  FOR EACH ROW EXECUTE FUNCTION app.guard_otc_drug_class();

CREATE TABLE stock_adjustment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  batch_id      uuid NOT NULL,
  location_id   uuid NOT NULL,
  qty_delta     numeric(18,4) NOT NULL CHECK (qty_delta <> 0),
  reason        text NOT NULL,
  requested_by  uuid NOT NULL,
  approved_by   uuid,
  status        text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batch(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_location(tenant_id, id),
  CHECK (status = 'REQUESTED' OR (approved_by IS NOT NULL AND approved_by <> requested_by))
);
COMMENT ON TABLE stock_adjustment IS 'Penyesuaian stok dengan maker–checker (PHM-FR-016)';

CREATE TABLE stock_opname (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  location_id  uuid NOT NULL,
  status       text NOT NULL DEFAULT 'COUNTING' CHECK (status IN ('COUNTING','SUBMITTED','APPROVED','CANCELLED')),
  started_by   uuid NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  approved_by  uuid,
  approved_at  timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_location(tenant_id, id)
);
COMMENT ON TABLE stock_opname IS 'Sesi stock opname; selisih menjadi movement OPNAME setelah disetujui (PHM-FR-017)';

CREATE TABLE stock_opname_line (
  tenant_id     uuid NOT NULL,
  opname_id     uuid NOT NULL,
  batch_id      uuid NOT NULL,
  system_qty    numeric(18,4) NOT NULL,
  counted_qty   numeric(18,4) NOT NULL CHECK (counted_qty >= 0),
  note          text,
  PRIMARY KEY (tenant_id, opname_id, batch_id),
  FOREIGN KEY (tenant_id, opname_id) REFERENCES stock_opname(tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batch(tenant_id, id)
);

COMMENT ON TABLE goods_receipt_line IS 'Baris penerimaan barang; qty_base = qty dalam satuan dasar obat';
COMMENT ON TABLE dispense_line IS 'Obat & batch yang diserahkan per baris resep; memicu stock_movement DISPENSE';
COMMENT ON TABLE otc_sale_line IS 'Baris penjualan bebas; hanya obat golongan BEBAS/BEBAS_TERBATAS (trigger)';
COMMENT ON TABLE stock_opname_line IS 'Hasil hitung fisik per batch pada sesi opname';
