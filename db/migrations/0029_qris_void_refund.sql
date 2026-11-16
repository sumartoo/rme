-- ClinicRME — migrasi 0029 (Stage 11 batch 3): QRIS (adapter + simulator), rekonsiliasi settlement, void & refund
-- (BIL-FR-006, 009, 010, 012; OD-039, OD-041, OD-112, OD-113 / DEC-042).
SET search_path = app, public;

-- 1. Transaksi QRIS: kasir & shift pembuat QR (pembayaran dicatat ke shift itu saat callback terverifikasi)
ALTER TABLE payment_gateway_txn
  ADD COLUMN created_by   uuid,
  ADD COLUMN shift_id     uuid,
  ADD COLUMN paid_at      timestamptz,
  ADD COLUMN last_event_id text;
ALTER TABLE payment_gateway_txn ADD CONSTRAINT payment_gateway_txn_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id);
ALTER TABLE payment_gateway_txn ADD CONSTRAINT payment_gateway_txn_shift_fk FOREIGN KEY (tenant_id, shift_id) REFERENCES cashier_shift(tenant_id, id);
CREATE UNIQUE INDEX ux_gateway_txn_pending ON payment_gateway_txn(tenant_id, invoice_id) WHERE status = 'PENDING';
CREATE INDEX ix_gateway_txn_paid ON payment_gateway_txn(tenant_id, paid_at) WHERE status = 'PAID';
REVOKE DELETE ON payment_gateway_txn FROM clinicrme_app;

-- 2. Berkas settlement penyedia (BIL-FR-012): satu batch per unggahan, baris apa adanya untuk rekonsiliasi
CREATE TABLE qris_settlement_batch (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  provider         text NOT NULL,
  settlement_date  date NOT NULL,
  file_name        text,
  line_count       int NOT NULL CHECK (line_count >= 0),
  total            numeric(18,2) NOT NULL,
  uploaded_by      uuid NOT NULL,
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES app_user(tenant_id, id)
);
CREATE INDEX ix_qris_settlement_batch_date ON qris_settlement_batch(tenant_id, settlement_date);
COMMENT ON TABLE qris_settlement_batch IS 'Unggahan berkas settlement QRIS dari penyedia (BIL-FR-012)';
SELECT app.enable_tenant_rls('app.qris_settlement_batch'::regclass);
GRANT SELECT, INSERT ON qris_settlement_batch TO clinicrme_app;

CREATE TABLE qris_settlement_line (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  batch_id     uuid NOT NULL,
  provider_ref text NOT NULL,
  amount       numeric(18,2) NOT NULL,
  settled_at   timestamptz,
  txn_id       uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES qris_settlement_batch(tenant_id, id),
  FOREIGN KEY (tenant_id, txn_id) REFERENCES payment_gateway_txn(tenant_id, id)
);
CREATE INDEX ix_qris_settlement_line_ref ON qris_settlement_line(tenant_id, provider_ref);
COMMENT ON TABLE qris_settlement_line IS 'Baris settlement QRIS; txn_id terisi bila cocok dengan transaksi tercatat';
SELECT app.enable_tenant_rls('app.qris_settlement_line'::regclass);
GRANT SELECT, INSERT ON qris_settlement_line TO clinicrme_app;

-- 3. Refund (OD-112): tunai keluar dari kas shift pengaju; non-tunai dicatat sebagai transfer manual dengan referensi
ALTER TABLE refund
  ADD COLUMN shift_id      uuid,
  ADD COLUMN reference     text,
  ADD COLUMN decision_note text;
ALTER TABLE refund ADD CONSTRAINT refund_shift_fk FOREIGN KEY (tenant_id, shift_id) REFERENCES cashier_shift(tenant_id, id);
ALTER TABLE refund ADD CONSTRAINT refund_method_chk CHECK (method IN ('TUNAI', 'TRANSFER'));
ALTER TABLE refund ADD CONSTRAINT refund_method_ref CHECK ((method = 'TUNAI' AND shift_id IS NOT NULL) OR (method = 'TRANSFER' AND reference IS NOT NULL));
ALTER TABLE refund ADD CONSTRAINT refund_reject_note CHECK (status <> 'REJECTED' OR decision_note IS NOT NULL);
CREATE INDEX ix_refund_payment ON refund(tenant_id, payment_id);
CREATE INDEX ix_refund_status ON refund(tenant_id, status, requested_at);
REVOKE DELETE ON refund FROM clinicrme_app;

-- 4. Void (BIL-FR-009): satu pengajuan terbuka per tagihan; tagihan pengganti merujuk tagihan yang di-void
ALTER TABLE invoice_void ADD COLUMN decision_note text;
ALTER TABLE invoice_void ADD CONSTRAINT invoice_void_reject_note CHECK (status <> 'REJECTED' OR decision_note IS NOT NULL);
CREATE UNIQUE INDEX ux_invoice_void_pending ON invoice_void(tenant_id, invoice_id) WHERE status = 'REQUESTED';
CREATE INDEX ix_invoice_void_status ON invoice_void(tenant_id, status, created_at);
REVOKE DELETE ON invoice_void FROM clinicrme_app;
-- (invoice.replaces_invoice_id sudah ada sejak baseline)

-- Piutang tagihan yang di-void ikut batal
ALTER TABLE receivable DROP CONSTRAINT receivable_status_check;
ALTER TABLE receivable ADD CONSTRAINT receivable_status_check CHECK (status IN ('OPEN','PARTIAL','PAID','WRITTEN_OFF','VOID'));

-- 5. Refund disetujui dapat menurunkan terbayar → status lunas boleh kembali ke sebagian/terbit (OD-112: dihitung ulang)
CREATE OR REPLACE FUNCTION app.guard_invoice() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE allowed text[] := ARRAY['status','paid_amount','updated_at','updated_by','version'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'IMMUTABLE: invoice sudah diterbitkan' USING ERRCODE='P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    IF (to_jsonb(NEW) - allowed) <> (to_jsonb(OLD) - allowed) THEN
      RAISE EXCEPTION 'IMMUTABLE: isi invoice tidak dapat diubah setelah diterbitkan' USING ERRCODE='P0001';
    END IF;
    IF OLD.status = 'VOID' OR NEW.status = 'DRAFT'
       OR (OLD.status = 'PAID' AND NEW.status NOT IN ('PAID') AND NOT (NEW.status IN ('ISSUED','PARTIALLY_PAID') AND NEW.paid_amount < OLD.paid_amount)) THEN
      RAISE EXCEPTION 'Transisi status invoice % → % tidak valid', OLD.status, NEW.status USING ERRCODE='P0001';
    END IF;
    IF NEW.status = 'VOID' AND OLD.paid_amount > 0 THEN
      RAISE EXCEPTION 'Invoice yang sudah dibayar harus di-refund sebelum void' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 6. Menu: rekonsiliasi QRIS (manajer)
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('billing.qris', 'billing', 'Rekonsiliasi QRIS', '/billing/qris-reconciliation', 'qr', 'billing.reconcile', 430)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
