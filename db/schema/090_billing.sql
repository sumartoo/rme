-- =====================================================================
-- 090 Billing & Payment — Stage 11 (BIL-FR-*), ADR-0006
-- =====================================================================
SET search_path = app, public;

CREATE TABLE cashier_shift (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  branch_id       uuid NOT NULL,
  cashier_id      uuid NOT NULL,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  opening_cash    numeric(18,2) NOT NULL CHECK (opening_cash >= 0),
  closed_at       timestamptz,
  counted_cash    numeric(18,2),
  expected_cash   numeric(18,2),
  variance        numeric(18,2) GENERATED ALWAYS AS (counted_cash - expected_cash) STORED,
  variance_note   text,
  verified_by     uuid,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','VERIFIED')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, cashier_id) REFERENCES app_user(tenant_id, id),
  CHECK (status = 'OPEN' OR (closed_at IS NOT NULL AND counted_cash IS NOT NULL AND expected_cash IS NOT NULL))
);
CREATE UNIQUE INDEX ux_cashier_shift_open ON cashier_shift(tenant_id, cashier_id) WHERE status = 'OPEN';
COMMENT ON TABLE cashier_shift IS 'Shift kasir; satu shift OPEN per kasir; variance otomatis (BIL-FR-011)';

CREATE TABLE invoice (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  invoice_no       text,
  branch_id        uuid NOT NULL,
  patient_id       uuid,
  encounter_id     uuid,
  otc_sale_id      uuid,
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ISSUED','PARTIALLY_PAID','PAID','VOID')),
  gross_amount     numeric(18,2) NOT NULL DEFAULT 0 CHECK (gross_amount >= 0),
  discount_amount  numeric(18,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  net_amount       numeric(18,2) NOT NULL DEFAULT 0 CHECK (net_amount >= 0),
  payer_portion    numeric(18,2) NOT NULL DEFAULT 0 CHECK (payer_portion >= 0),
  patient_portion  numeric(18,2) NOT NULL DEFAULT 0 CHECK (patient_portion >= 0),
  paid_amount      numeric(18,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  payer_id         uuid,
  issued_at        timestamptz,
  issued_by        uuid,
  replaces_invoice_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, invoice_no),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id),
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id),
  FOREIGN KEY (tenant_id, otc_sale_id) REFERENCES otc_sale(tenant_id, id),
  FOREIGN KEY (tenant_id, payer_id) REFERENCES payer(tenant_id, id),
  FOREIGN KEY (tenant_id, replaces_invoice_id) REFERENCES invoice(tenant_id, id),
  CHECK (status = 'DRAFT' OR (invoice_no IS NOT NULL AND issued_at IS NOT NULL)),
  CHECK (net_amount = gross_amount - discount_amount),
  CHECK (payer_portion + patient_portion = net_amount),
  CHECK (encounter_id IS NOT NULL OR otc_sale_id IS NOT NULL)
);
COMMENT ON TABLE invoice IS 'Tagihan; setelah ISSUED hanya status & paid_amount yang berubah (BIL-FR-001/004/009)';

CREATE TABLE invoice_line (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  invoice_id        uuid NOT NULL,
  line_no           smallint NOT NULL,
  source_type       text NOT NULL CHECK (source_type IN ('KONSULTASI','TINDAKAN','OBAT','LAB','ADMINISTRASI','LAINNYA')),
  source_id         uuid,
  description       text NOT NULL,
  qty               numeric(18,4) NOT NULL CHECK (qty > 0),
  unit_price        numeric(18,2) NOT NULL CHECK (unit_price >= 0),
  discount_amount   numeric(18,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  line_total        numeric(18,2) NOT NULL,
  payer_portion     numeric(18,2) NOT NULL DEFAULT 0,
  patient_portion   numeric(18,2) NOT NULL DEFAULT 0,
  discount_approved_by uuid,
  UNIQUE (tenant_id, invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice(tenant_id, id),
  CHECK (line_total = round(qty * unit_price, 2) - discount_amount),
  CHECK (payer_portion + patient_portion = line_total)
);
COMMENT ON TABLE invoice_line IS 'Baris tagihan dengan harga snapshot (BIL-FR-002)';

CREATE TABLE payment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  receipt_no       text NOT NULL,
  invoice_id       uuid NOT NULL,
  shift_id         uuid NOT NULL,
  method           text NOT NULL CHECK (method IN ('TUNAI','DEBIT','KARTU_KREDIT','TRANSFER','QRIS','PIUTANG_PELUNASAN')),
  amount           numeric(18,2) NOT NULL CHECK (amount > 0),
  cash_tendered    numeric(18,2),
  reference        text,
  idempotency_key  text NOT NULL,
  received_by      uuid NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, receipt_no),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice(tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES cashier_shift(tenant_id, id),
  CHECK (method NOT IN ('DEBIT','KARTU_KREDIT','TRANSFER','QRIS') OR reference IS NOT NULL),
  CHECK (method <> 'TUNAI' OR cash_tendered IS NULL OR cash_tendered >= amount)
);
COMMENT ON TABLE payment IS 'Pembayaran append-only; idempotency_key mencegah pencatatan ganda (BIL-FR-005..007, AC-BIL-FR-006-2)';

CREATE TABLE payment_gateway_txn (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  invoice_id       uuid NOT NULL,
  provider         text NOT NULL,
  provider_ref     text,
  amount           numeric(18,2) NOT NULL CHECK (amount > 0),
  qr_payload       text,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','EXPIRED','FAILED','CANCELLED')),
  expires_at       timestamptz,
  payment_id       uuid,
  callback_count   int NOT NULL DEFAULT 0,
  last_callback_at timestamptz,
  settled          boolean NOT NULL DEFAULT false,
  settlement_ref   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider, provider_ref),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payment(tenant_id, id)
);
COMMENT ON TABLE payment_gateway_txn IS 'Transaksi QRIS & status callback/settlement (BIL-FR-006/012)';

CREATE TABLE refund (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  refund_no     text NOT NULL,
  payment_id    uuid NOT NULL,
  amount        numeric(18,2) NOT NULL CHECK (amount > 0),
  reason        text NOT NULL CHECK (length(trim(reason)) > 0),
  method        text NOT NULL,
  requested_by  uuid NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  approved_by   uuid,
  decided_at    timestamptz,
  status        text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, refund_no),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payment(tenant_id, id),
  CHECK (status = 'REQUESTED' OR (approved_by IS NOT NULL AND approved_by <> requested_by AND decided_at IS NOT NULL))
);
COMMENT ON TABLE refund IS 'Refund maker–checker; penyetuju ≠ pengaju (BIL-FR-010)';

CREATE TABLE invoice_void (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  invoice_id    uuid NOT NULL,
  reason        text NOT NULL,
  requested_by  uuid NOT NULL,
  approved_by   uuid,
  status        text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice(tenant_id, id),
  CHECK (status = 'REQUESTED' OR (approved_by IS NOT NULL AND approved_by <> requested_by))
);
COMMENT ON TABLE invoice_void IS 'Permintaan void invoice dengan persetujuan (BIL-FR-009)';

CREATE TABLE receivable (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  invoice_id    uuid NOT NULL,
  payer_id      uuid NOT NULL,
  amount        numeric(18,2) NOT NULL CHECK (amount > 0),
  paid_amount   numeric(18,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  due_date      date,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PARTIAL','PAID','WRITTEN_OFF')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice(tenant_id, id),
  FOREIGN KEY (tenant_id, payer_id) REFERENCES payer(tenant_id, id),
  CHECK (paid_amount <= amount)
);
COMMENT ON TABLE receivable IS 'Piutang porsi penjamin (BIL-FR-013)';

-- ---------------------------------------------------------------------
-- Immutability (ADR-0006)
-- ---------------------------------------------------------------------
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
    IF OLD.status = 'VOID' OR (OLD.status = 'PAID' AND NEW.status NOT IN ('PAID')) THEN
      RAISE EXCEPTION 'Transisi status invoice % → % tidak valid', OLD.status, NEW.status USING ERRCODE='P0001';
    END IF;
    IF NEW.status = 'VOID' AND OLD.paid_amount > 0 THEN
      RAISE EXCEPTION 'Invoice yang sudah dibayar harus di-refund sebelum void' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_invoice_guard BEFORE UPDATE OR DELETE ON invoice
  FOR EACH ROW EXECUTE FUNCTION app.guard_invoice();

CREATE OR REPLACE FUNCTION app.guard_invoice_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text; v_inv uuid; v_tenant uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_inv := OLD.invoice_id; v_tenant := OLD.tenant_id;
  ELSE v_inv := NEW.invoice_id; v_tenant := NEW.tenant_id; END IF;
  SELECT status INTO v_status FROM invoice WHERE tenant_id = v_tenant AND id = v_inv;
  IF v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'IMMUTABLE: baris invoice terkunci' USING ERRCODE='P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_invoice_line_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_line
  FOR EACH ROW EXECUTE FUNCTION app.guard_invoice_line();

CREATE TRIGGER trg_payment_immutable BEFORE UPDATE OR DELETE ON payment
  FOR EACH ROW EXECUTE FUNCTION app.reject_modification();

CREATE OR REPLACE FUNCTION app.guard_decided_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'IMMUTABLE: % yang sudah diputuskan tidak dapat diubah', TG_TABLE_NAME USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_refund_guard BEFORE UPDATE OR DELETE ON refund FOR EACH ROW EXECUTE FUNCTION app.guard_decided_request();
CREATE TRIGGER trg_invoice_void_guard BEFORE UPDATE OR DELETE ON invoice_void FOR EACH ROW EXECUTE FUNCTION app.guard_decided_request();
CREATE TRIGGER trg_stock_adjustment_guard BEFORE UPDATE OR DELETE ON stock_adjustment FOR EACH ROW EXECUTE FUNCTION app.guard_decided_request();
