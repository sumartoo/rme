-- ClinicRME — migrasi 0027 (Stage 11 batch 1): tagihan dari kunjungan & penjualan bebas (BIL-FR-001–004; OD-041, OD-105–108, OD-110, OD-113 / DEC-042).
SET search_path = app, public;

-- 1. OD-105: layanan konsultasi bawaan per poli; biaya administrasi opsional per cabang
ALTER TABLE service_unit ADD COLUMN consult_service_id uuid;
ALTER TABLE service_unit ADD CONSTRAINT service_unit_consult_fk FOREIGN KEY (tenant_id, consult_service_id) REFERENCES service_item(tenant_id, id);
ALTER TABLE branch ADD COLUMN admin_service_id uuid;
ALTER TABLE branch ADD CONSTRAINT branch_admin_service_fk FOREIGN KEY (tenant_id, admin_service_id) REFERENCES service_item(tenant_id, id);

-- 2. Tagihan: jenis (kunjungan / obat susulan OD-107 / penjualan bebas OD-113), penjamin yang dipakai, catatan
ALTER TABLE invoice
  ADD COLUMN kind        text NOT NULL DEFAULT 'ENCOUNTER' CHECK (kind IN ('ENCOUNTER','DRUG','OTC')),
  ADD COLUMN payer_type  text NOT NULL DEFAULT 'UMUM' CHECK (payer_type IN ('UMUM','ASURANSI','PERUSAHAAN','BPJS')),
  ADD COLUMN coverage_id uuid,
  ADD COLUMN customer_name text,
  ADD COLUMN notes       text,
  ADD CONSTRAINT invoice_kind_ref CHECK ((kind = 'OTC') = (otc_sale_id IS NOT NULL) AND (kind = 'OTC' OR encounter_id IS NOT NULL)),
  ADD CONSTRAINT invoice_payer_fk FOREIGN KEY (tenant_id, payer_id) REFERENCES payer(tenant_id, id);
-- Satu tagihan jasa aktif per kunjungan; satu draf per kunjungan/penjualan; satu tagihan aktif per penjualan bebas
CREATE UNIQUE INDEX ux_invoice_encounter_active ON invoice(tenant_id, encounter_id) WHERE kind = 'ENCOUNTER' AND status <> 'VOID';
CREATE UNIQUE INDEX ux_invoice_encounter_draft ON invoice(tenant_id, encounter_id) WHERE status = 'DRAFT' AND encounter_id IS NOT NULL;
CREATE UNIQUE INDEX ux_invoice_otc_active ON invoice(tenant_id, otc_sale_id) WHERE otc_sale_id IS NOT NULL AND status <> 'VOID';
CREATE INDEX ix_invoice_branch_status ON invoice(tenant_id, branch_id, status, created_at DESC);
-- Draf boleh dihapus/dibangun ulang; tagihan terbit dijaga trigger guard_invoice / guard_invoice_line (baseline).

-- 3. Baris tagihan: asal tarif/obat, baris manual, alasan diskon & pembagian, status persetujuan diskon (OD-041)
ALTER TABLE invoice_line
  ADD COLUMN service_item_id uuid,
  ADD COLUMN tariff_id       uuid,
  ADD COLUMN drug_item_id    uuid,
  ADD COLUMN is_manual       boolean NOT NULL DEFAULT false,
  ADD COLUMN discount_reason text,
  ADD COLUMN discount_requested_by uuid,
  ADD COLUMN discount_status text NOT NULL DEFAULT 'NONE' CHECK (discount_status IN ('NONE','WITHIN_LIMIT','PENDING','APPROVED')),
  ADD COLUMN split_reason    text,
  ADD CONSTRAINT invoice_line_discount_reason CHECK (discount_amount = 0 OR discount_reason IS NOT NULL),
  ADD CONSTRAINT invoice_line_discount_approval CHECK (discount_status <> 'APPROVED' OR (discount_approved_by IS NOT NULL AND discount_approved_by <> discount_requested_by)),
  ADD CONSTRAINT invoice_line_portions CHECK (payer_portion >= 0 AND patient_portion >= 0),
  ADD CONSTRAINT invoice_line_service_fk FOREIGN KEY (tenant_id, service_item_id) REFERENCES service_item(tenant_id, id),
  ADD CONSTRAINT invoice_line_drug_fk FOREIGN KEY (tenant_id, drug_item_id) REFERENCES drug_item(tenant_id, id);
CREATE INDEX ix_invoice_line_invoice ON invoice_line(tenant_id, invoice_id);
CREATE INDEX ix_invoice_line_source ON invoice_line(tenant_id, source_type, source_id);

-- 4. Obat: baris penyerahan & penjualan bebas ditautkan ke baris tagihan (status tagih diubah saat tagihan terbit)
ALTER TABLE dispense_line ADD COLUMN invoice_line_id uuid;
GRANT UPDATE (billing_status, invoice_line_id) ON dispense_line TO clinicrme_app;
CREATE INDEX ix_dispense_line_invoice_line ON dispense_line(tenant_id, invoice_line_id) WHERE invoice_line_id IS NOT NULL;

-- 5. Menu kasir
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('billing',          NULL,      'Kasir',          NULL,       'receipt', NULL,                   400),
  ('billing.worklist', 'billing', 'Tagihan',        '/billing', 'receipt', 'billing.invoice.read', 410)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
