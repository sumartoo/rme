-- ClinicRME — migrasi 0030 (Stage 11 batch 4): pelunasan piutang penjamin, verifikasi shift, laporan transaksi tidak wajar
-- (BIL-FR-011, 013, 016; OD-041, OD-108, OD-111 / DEC-042).
SET search_path = app, public;

-- 1. Pelunasan piutang (AC-BIL-FR-013-1): append-only; saldo piutang = nominal − Σ pelunasan
CREATE TABLE receivable_payment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  receivable_id  uuid NOT NULL,
  amount         numeric(18,2) NOT NULL CHECK (amount > 0),
  paid_on        date NOT NULL,
  method         text NOT NULL CHECK (method IN ('TRANSFER', 'GIRO', 'LAINNYA')),
  reference      text NOT NULL CHECK (length(trim(reference)) >= 3),
  note           text,
  idempotency_key text NOT NULL,
  recorded_by    uuid NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, receivable_id) REFERENCES receivable(tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES app_user(tenant_id, id)
);
CREATE INDEX ix_receivable_payment_rcv ON receivable_payment(tenant_id, receivable_id);
COMMENT ON TABLE receivable_payment IS 'Pelunasan piutang penjamin (BIL-FR-013); tidak dapat diubah/dihapus';
SELECT app.enable_tenant_rls('app.receivable_payment'::regclass);
GRANT SELECT, INSERT ON receivable_payment TO clinicrme_app;

-- 2. Verifikasi shift oleh manajer (OD-111): catatan verifikasi; shift terverifikasi tidak berubah lagi
ALTER TABLE cashier_shift ADD COLUMN verify_note text;
ALTER TABLE cashier_shift ADD CONSTRAINT cashier_shift_verified_by_fk FOREIGN KEY (tenant_id, verified_by) REFERENCES app_user(tenant_id, id);
ALTER TABLE cashier_shift ADD CONSTRAINT cashier_shift_verified CHECK (status <> 'VERIFIED' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL));
ALTER TABLE cashier_shift ADD CONSTRAINT cashier_shift_verifier_not_cashier CHECK (verified_by IS NULL OR verified_by <> cashier_id);

CREATE OR REPLACE FUNCTION app.guard_cashier_shift() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'VERIFIED' THEN
    RAISE EXCEPTION 'IMMUTABLE: shift yang sudah diverifikasi tidak dapat diubah' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'CLOSED' AND (NEW.status <> 'VERIFIED' AND NEW.status <> 'CLOSED'
       OR NEW.counted_cash IS DISTINCT FROM OLD.counted_cash OR NEW.expected_cash IS DISTINCT FROM OLD.expected_cash
       OR NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.opening_cash IS DISTINCT FROM OLD.opening_cash) THEN
    RAISE EXCEPTION 'IMMUTABLE: hasil tutup shift tidak dapat diubah' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_cashier_shift_guard BEFORE UPDATE ON cashier_shift FOR EACH ROW EXECUTE FUNCTION app.guard_cashier_shift();

-- 3. Menu manajer: shift kasir & transaksi tidak wajar
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('billing.shifts', 'billing', 'Shift kasir', '/billing/shifts', 'clock', 'billing.reconcile', 440),
  ('billing.anomalies', 'billing', 'Transaksi tidak wajar', '/billing/anomalies', 'alert', 'report.finance.audit', 450)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
