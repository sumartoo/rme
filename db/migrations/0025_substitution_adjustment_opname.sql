-- ClinicRME — migrasi 0025 (Stage 10 batch 3): substitusi obat, penyesuaian stok, stock opname, laporan obat terbatas
-- (PHM-FR-010, 016, 017, 019; OD-099, OD-100 / DEC-039, DEC-013/OD-064).
SET search_path = app, public;

-- 1. Substitusi (OD-099): apoteker mengajukan → dokter kunjungan / dokter bertugas di cabang menyetujui di aplikasi.
--    Riwayat pengajuan tersimpan di sini; baris resep diperbarui (drug_item_id baru, substituted_from_drug_id = asli).
CREATE TABLE prescription_substitution (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  prescription_item_id   uuid NOT NULL,
  from_drug_id           uuid NOT NULL,
  to_drug_id             uuid NOT NULL,
  reason                 text NOT NULL CHECK (length(reason) >= 5),
  status                 text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED','CANCELLED')),
  requested_by           uuid NOT NULL,
  requested_at           timestamptz NOT NULL DEFAULT now(),
  decided_by_user        uuid,
  decided_by_practitioner uuid,
  decided_at             timestamptz,
  decision_note          text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, prescription_item_id) REFERENCES prescription_item(tenant_id, id),
  FOREIGN KEY (tenant_id, from_drug_id) REFERENCES drug_item(tenant_id, id),
  FOREIGN KEY (tenant_id, to_drug_id) REFERENCES drug_item(tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by_practitioner) REFERENCES practitioner(tenant_id, id),
  CHECK (from_drug_id <> to_drug_id),
  CHECK (status IN ('REQUESTED','CANCELLED') OR (decided_by_practitioner IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR decision_note IS NOT NULL)
);
CREATE UNIQUE INDEX ux_substitution_pending ON prescription_substitution(tenant_id, prescription_item_id) WHERE status = 'REQUESTED';
CREATE INDEX ix_substitution_status ON prescription_substitution(tenant_id, status, requested_at);
COMMENT ON TABLE prescription_substitution IS 'Pengajuan substitusi obat oleh apoteker & keputusan dokter (OD-099)';
SELECT app.enable_tenant_rls('app.prescription_substitution'::regclass);
GRANT SELECT, INSERT, UPDATE ON prescription_substitution TO clinicrme_app;
CREATE TRIGGER trg_substitution_guard BEFORE UPDATE OR DELETE ON prescription_substitution
  FOR EACH ROW EXECUTE FUNCTION app.guard_decided_request();

-- 2. Penyesuaian stok (PHM-FR-016): catatan keputusan; satu-satunya jalur selain trigger adalah API maker–checker.
ALTER TABLE stock_adjustment ADD COLUMN decision_note text;
ALTER TABLE stock_adjustment ADD CONSTRAINT stock_adjustment_reject_note CHECK (status <> 'REJECTED' OR decision_note IS NOT NULL);
CREATE INDEX ix_stock_adjustment_status ON stock_adjustment(tenant_id, status, created_at);
REVOKE DELETE ON stock_adjustment FROM clinicrme_app;

-- 3. Stock opname (PHM-FR-017): hitung per batch → kirim → disetujui orang lain → selisih menjadi mutasi OPNAME.
--    system_qty = saldo saat baris dihitung, sehingga mutasi sesudah penghitungan tidak ikut terkoreksi.
ALTER TABLE stock_opname
  ADD COLUMN submitted_by  uuid,
  ADD COLUMN submitted_at  timestamptz,
  ADD COLUMN decision_note text,
  ADD COLUMN notes         text,
  ADD COLUMN version       int NOT NULL DEFAULT 1,
  ADD CONSTRAINT stock_opname_approver CHECK (status <> 'APPROVED' OR (approved_by IS NOT NULL AND approved_by <> started_by AND approved_at IS NOT NULL));
ALTER TABLE stock_opname_line
  ALTER COLUMN counted_qty DROP NOT NULL,
  ADD COLUMN counted_by uuid,
  ADD COLUMN counted_at timestamptz,
  ADD CONSTRAINT stock_opname_line_counted CHECK ((counted_qty IS NULL) = (counted_at IS NULL));
CREATE UNIQUE INDEX ux_stock_opname_active ON stock_opname(tenant_id, location_id) WHERE status IN ('COUNTING','SUBMITTED');
REVOKE DELETE ON stock_opname, stock_opname_line FROM clinicrme_app;
-- Sesi yang sudah disetujui/dibatalkan tidak berubah lagi
CREATE OR REPLACE FUNCTION app.guard_opname() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  IF TG_TABLE_NAME = 'stock_opname' THEN
    v_status := OLD.status;
  ELSE
    SELECT status INTO v_status FROM app.stock_opname WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND id = COALESCE(NEW.opname_id, OLD.opname_id);
  END IF;
  IF v_status IN ('APPROVED','CANCELLED') THEN
    RAISE EXCEPTION 'IMMUTABLE: stock opname yang sudah disetujui/dibatalkan tidak dapat diubah' USING ERRCODE='P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_stock_opname_guard BEFORE UPDATE OR DELETE ON stock_opname FOR EACH ROW EXECUTE FUNCTION app.guard_opname();
CREATE TRIGGER trg_stock_opname_line_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_opname_line FOR EACH ROW EXECUTE FUNCTION app.guard_opname();

-- 4. Menu
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('service.substitutions', 'service',  'Persetujuan substitusi', '/substitutions',        'pill',       'clinical.prescription.approve_substitution', 108),
  ('pharmacy.adjustments',  'pharmacy', 'Penyesuaian stok',       '/pharmacy/adjustments', 'clipboard',  'pharmacy.stock.read',        340),
  ('pharmacy.opname',       'pharmacy', 'Stock opname',           '/pharmacy/opname',      'list-ordered', 'pharmacy.stock.read',      350),
  ('pharmacy.controlled',   'pharmacy', 'Laporan obat terbatas',  '/pharmacy/controlled',  'file-text',  'report.pharmacy.controlled', 360)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
