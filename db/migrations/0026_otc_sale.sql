-- ClinicRME — migrasi 0026 (Stage 10 batch 4): penjualan obat bebas tanpa kunjungan & laporan stok (PHM-FR-012, RPT-FR-005; OD-101 / DEC-039).
SET search_path = app, public;

-- 1. Penjualan bebas: status menunggu bayar (dibayar di kasir, Stage 11); batal sebelum dibayar mengembalikan stok (RETURN_IN).
ALTER TABLE otc_sale
  ADD COLUMN status        text NOT NULL DEFAULT 'AWAITING_PAYMENT' CHECK (status IN ('AWAITING_PAYMENT','PAID','CANCELLED')),
  ADD COLUMN customer_name text,
  ADD COLUMN notes         text,
  ADD COLUMN total         numeric(18,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  ADD COLUMN cancel_reason text,
  ADD COLUMN cancelled_by  uuid,
  ADD COLUMN cancelled_at  timestamptz,
  ADD CONSTRAINT otc_sale_cancelled CHECK (status <> 'CANCELLED' OR (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL));
ALTER TABLE otc_sale_line ADD COLUMN drug_price_id uuid;
CREATE INDEX ix_otc_sale_branch ON otc_sale(tenant_id, branch_id, sold_at DESC);
CREATE INDEX ix_otc_sale_line_sale ON otc_sale_line(tenant_id, otc_sale_id);
-- Baris penjualan tidak berubah; header hanya status/pembatalan.
REVOKE UPDATE, DELETE ON otc_sale, otc_sale_line FROM clinicrme_app;
GRANT UPDATE (status, cancel_reason, cancelled_by, cancelled_at) ON otc_sale TO clinicrme_app;

-- 2. Laporan stok & mutasi (RPT-FR-005)
CREATE INDEX ix_stock_movement_time ON stock_movement(tenant_id, occurred_at);

-- 3. Menu
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('pharmacy.otc',    'pharmacy', 'Penjualan obat bebas', '/pharmacy/otc',    'receipt',   'pharmacy.otc.sell',   310),
  ('pharmacy.report', 'pharmacy', 'Laporan stok',         '/pharmacy/report', 'file-text', 'report.pharmacy.read', 355)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
