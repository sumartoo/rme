-- ClinicRME — migrasi 0028 (Stage 11 batch 2): shift kasir, pembayaran, kwitansi, pembentukan piutang
-- (BIL-FR-005, 007, 008, 011, 013; OD-108–111 / DEC-042).
SET search_path = app, public;

-- 1. Shift kasir (OD-111): siapa yang menutup, rincian pecahan uang (opsional), waktu verifikasi manajer (batch 4)
ALTER TABLE cashier_shift
  ADD COLUMN closed_by     uuid,
  ADD COLUMN denominations jsonb,
  ADD COLUMN verified_at   timestamptz;
ALTER TABLE cashier_shift ADD CONSTRAINT cashier_shift_closed_by_fk FOREIGN KEY (tenant_id, closed_by) REFERENCES app_user(tenant_id, id);
REVOKE DELETE ON cashier_shift FROM clinicrme_app;
CREATE INDEX ix_cashier_shift_branch ON cashier_shift(tenant_id, branch_id, opened_at DESC);

-- 2. Pembayaran hanya ke shift yang masih terbuka (AC-BIL-FR-011-1) — pertahanan kedua di bawah aplikasi
CREATE OR REPLACE FUNCTION app.guard_payment_shift() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM cashier_shift WHERE tenant_id = NEW.tenant_id AND id = NEW.shift_id;
  IF v_status IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'Pembayaran hanya dapat dicatat pada shift kasir yang terbuka' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payment_shift BEFORE INSERT ON payment FOR EACH ROW EXECUTE FUNCTION app.guard_payment_shift();
CREATE INDEX ix_payment_invoice ON payment(tenant_id, invoice_id);
CREATE INDEX ix_payment_shift ON payment(tenant_id, shift_id);

-- 3. Piutang porsi penjamin (OD-108): satu per tagihan, dibuat saat tagihan terbit; pelunasan di batch 4
CREATE UNIQUE INDEX ux_receivable_invoice ON receivable(tenant_id, invoice_id);
CREATE INDEX ix_receivable_payer ON receivable(tenant_id, payer_id, status);
REVOKE DELETE ON receivable FROM clinicrme_app;

-- 4. Menu: piutang penjamin
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('billing.receivables', 'billing', 'Piutang penjamin', '/billing/receivables', 'receipt', 'billing.receivable.read', 420)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
