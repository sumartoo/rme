-- ClinicRME — migrasi 0012 (Stage 7 batch 2): layanan, tarif, penjamin, satuan, supplier (MST-FR-004–007, 010).
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- 1. Izin kelola satuan & supplier (baseline hanya punya izin baca). Admin klinik & farmasi mengelola.
-- ---------------------------------------------------------------------
INSERT INTO permission(code, module, description) VALUES
  ('master.supplier.manage', 'master', 'supplierCreate; supplierUpdate'),
  ('master.uom.manage', 'master', 'uomCreate; uomUpdate; uomConversionSet; uomConversionDelete')
ON CONFLICT (code) DO NOTHING;

-- Template untuk tenant baru (pola migrasi 0008: ganti teks fungsi, gagal bila teks yang diharapkan tidak ada)
DO $$
DECLARE def text := pg_get_functiondef('app.create_template_roles()'::regprocedure);
  a text := $q$'master.uom.read', 'patient.merge'$q$;
  f text := $q$'master.uom.read', 'patient.read', 'pharmacy.dispense'$q$;
BEGIN
  IF position(a IN def) = 0 OR position(f IN def) = 0 THEN
    RAISE EXCEPTION 'create_template_roles berubah — perbarui migrasi 0012';
  END IF;
  def := replace(def, a, $q$'master.uom.read', 'master.uom.manage', 'master.supplier.manage', 'patient.merge'$q$);
  def := replace(def, f, $q$'master.uom.read', 'master.uom.manage', 'master.supplier.manage', 'patient.read', 'pharmacy.dispense'$q$);
  EXECUTE def;
END $$;
-- Role template tenant yang sudah ada
INSERT INTO role_permission(tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, p.code FROM role r CROSS JOIN (VALUES ('master.supplier.manage'), ('master.uom.manage')) p(code)
 WHERE r.is_template AND r.code IN ('TENANT_ADMIN', 'FARMASI')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. Satuan & supplier: versi baris (If-Match, GEN-FR-007) + status aktif satuan
-- ---------------------------------------------------------------------
ALTER TABLE uom ADD COLUMN is_active boolean NOT NULL DEFAULT true,
                ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
                ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
                ADD COLUMN updated_by uuid,
                ADD COLUMN version int NOT NULL DEFAULT 1;
ALTER TABLE supplier ADD COLUMN code text,
                     ADD COLUMN contact_person text,
                     ADD COLUMN email text,
                     ADD COLUMN npwp text,
                     ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
                     ADD COLUMN updated_by uuid,
                     ADD COLUMN version int NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX ux_supplier_code ON supplier(tenant_id, code) WHERE code IS NOT NULL;
CREATE TRIGGER trg_touch BEFORE UPDATE ON uom FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER trg_touch BEFORE UPDATE ON supplier FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- Konversi satuan umum (drug_item_id null) unik per pasangan; konversi khusus obat (Stage 10) terpisah
ALTER TABLE uom_conversion DROP CONSTRAINT uom_conversion_pkey;
ALTER TABLE uom_conversion ADD CONSTRAINT ck_uom_conversion_distinct CHECK (from_uom_id <> to_uom_id);
CREATE UNIQUE INDEX ux_uom_conversion_general ON uom_conversion(tenant_id, from_uom_id, to_uom_id) WHERE drug_item_id IS NULL;
CREATE UNIQUE INDEX ux_uom_conversion_drug ON uom_conversion(tenant_id, drug_item_id, from_uom_id, to_uom_id) WHERE drug_item_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3. Tarif tidak pernah ditimpa (MST-FR-005): hanya tanggal akhir yang boleh diisi/dimajukan; tidak dihapus
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tariff_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.service_item_id IS DISTINCT FROM OLD.service_item_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.payer_type IS DISTINCT FROM OLD.payer_type OR NEW.payer_id IS DISTINCT FROM OLD.payer_id
     OR NEW.price IS DISTINCT FROM OLD.price OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'MST-409-TARIFF-IMMUTABLE: tarif tidak dapat diubah; buat periode tarif baru' USING ERRCODE = 'CRM01';
  END IF;
  IF OLD.valid_to IS NOT NULL AND (NEW.valid_to IS NULL OR NEW.valid_to > OLD.valid_to) THEN
    RAISE EXCEPTION 'MST-409-TARIFF-IMMUTABLE: periode tarif yang sudah ditutup tidak dapat diperpanjang' USING ERRCODE = 'CRM01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_tariff_guard BEFORE UPDATE ON tariff FOR EACH ROW EXECUTE FUNCTION app.tariff_guard();
REVOKE DELETE ON tariff FROM clinicrme_app;
COMMENT ON TABLE tariff IS 'Tarif per layanan × cabang × penjamin × periode; tidak tumpang tindih (AC-MST-FR-005-1); hanya valid_to yang dapat dimajukan';

-- ---------------------------------------------------------------------
-- 4. Menu master batch 2
-- ---------------------------------------------------------------------
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('master.services', 'master', 'Layanan & tarif', '/master/services', 'receipt',  'master.service.read', 830),
  ('master.payers',   'master', 'Penjamin',        '/master/payers',   'shield-check', 'master.payer.read', 840),
  ('master.supplies', 'master', 'Satuan & supplier', '/master/supplies', 'package', 'master.uom.read',   850)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
