-- ClinicRME — migrasi 0023 (Stage 10 batch 1): harga obat, lokasi stok, penerimaan barang (PHM-FR-001–004, 014; OD-031, OD-097, OD-100 / DEC-039).
SET search_path = app, public;

-- 1. Izin obat golongan terbatas (OD-100): narkotika & psikotropika — terima, serahkan, sesuaikan, opname
INSERT INTO permission(code, module, description) VALUES
  ('pharmacy.restricted.dispense', 'pharmacy', 'Kelola obat narkotika/psikotropika: penerimaan, penyerahan, penyesuaian, opname (OD-100)')
ON CONFLICT (code) DO NOTHING;
DO $$
DECLARE def text := pg_get_functiondef('app.create_template_roles()'::regprocedure);
  f text := $q$'pharmacy.drug.read', 'pharmacy.otc.sell', 'pharmacy.stock.adjust'$q$;
BEGIN
  IF (length(def) - length(replace(def, f, ''))) / length(f) <> 1 THEN
    RAISE EXCEPTION 'create_template_roles berubah — perbarui migrasi 0023';
  END IF;
  def := replace(def, f, $q$'pharmacy.drug.read', 'pharmacy.otc.sell', 'pharmacy.restricted.dispense', 'pharmacy.stock.adjust'$q$);
  EXECUTE def;
END $$;
INSERT INTO role_permission(tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, 'pharmacy.restricted.dispense' FROM role r WHERE r.is_template AND r.code = 'FARMASI'
ON CONFLICT DO NOTHING;

-- 2. Lokasi stok (OD-097): satu lokasi bawaan "Apotek" per cabang, dibuat otomatis
ALTER TABLE stock_location
  ADD COLUMN is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN version    integer NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_by uuid;
CREATE UNIQUE INDEX ux_stock_location_default ON stock_location(tenant_id, branch_id) WHERE is_default;
CREATE UNIQUE INDEX ux_stock_location_name ON stock_location(tenant_id, branch_id, lower(name));
CREATE TRIGGER trg_stock_location_touch BEFORE UPDATE ON stock_location FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE OR REPLACE FUNCTION app.create_default_stock_location() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO app.stock_location(tenant_id, branch_id, name, is_default) VALUES (NEW.tenant_id, NEW.id, 'Apotek', true)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_branch_default_stock_location AFTER INSERT ON branch FOR EACH ROW EXECUTE FUNCTION app.create_default_stock_location();
-- Backfill: cabang yang sudah punya lokasi → lokasi aktif bernama "Apotek" (atau yang pertama) dijadikan bawaan; sisanya dibuatkan.
UPDATE stock_location SET is_default = true
 WHERE id IN (SELECT DISTINCT ON (tenant_id, branch_id) id FROM stock_location WHERE is_active
               ORDER BY tenant_id, branch_id, (lower(name) = 'apotek') DESC, id);
INSERT INTO stock_location(tenant_id, branch_id, name, is_default)
SELECT b.tenant_id, b.id, 'Apotek', true FROM branch b
 WHERE NOT EXISTS (SELECT 1 FROM stock_location l WHERE l.tenant_id = b.tenant_id AND l.branch_id = b.id AND l.is_default)
ON CONFLICT DO NOTHING;
REVOKE DELETE ON stock_location FROM clinicrme_app;

-- 3. Harga jual (PHM-FR-002): riwayat tidak dihapus; periode ditutup lewat valid_to
ALTER TABLE drug_price
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_by uuid,
  ADD CONSTRAINT drug_price_period CHECK (valid_to IS NULL OR valid_to >= valid_from),
  ADD CONSTRAINT drug_price_het CHECK (het IS NULL OR sell_price <= het);
CREATE INDEX ix_drug_price_drug ON drug_price(tenant_id, drug_item_id, valid_from DESC);
REVOKE DELETE ON drug_price FROM clinicrme_app;

-- 4. Penerimaan barang (PHM-FR-003): langsung POSTED; faktur & baris tidak diubah (koreksi = penyesuaian stok)
ALTER TABLE goods_receipt
  ADD COLUMN invoice_date date,
  ADD COLUMN notes        text;
CREATE UNIQUE INDEX ux_goods_receipt_invoice ON goods_receipt(tenant_id, supplier_id, lower(invoice_no));
CREATE INDEX ix_goods_receipt_line_gr ON goods_receipt_line(tenant_id, goods_receipt_id);
CREATE INDEX ix_stock_balance_location ON stock_balance(tenant_id, location_id);
CREATE INDEX ix_stock_batch_drug ON stock_batch(tenant_id, drug_item_id, expiry_date);
REVOKE UPDATE, DELETE ON goods_receipt, goods_receipt_line FROM clinicrme_app;
REVOKE UPDATE, DELETE ON stock_batch FROM clinicrme_app;

-- 5. Menu Farmasi
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('pharmacy',          NULL,       'Farmasi',           NULL,                  'pill',    NULL,                     300),
  ('pharmacy.stock',    'pharmacy', 'Stok obat',         '/pharmacy/stock',     'boxes',   'pharmacy.stock.read',    320),
  ('pharmacy.receipts', 'pharmacy', 'Penerimaan barang', '/pharmacy/receipts',  'truck',   'pharmacy.stock.receive', 330)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
