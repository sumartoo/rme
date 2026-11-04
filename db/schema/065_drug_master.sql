-- =====================================================================
-- 065 Drug Master — Stage 10 (PHM-FR-001/002), dibuat sebelum modul klinis
-- karena resep merujuk ke drug_item.
-- =====================================================================
SET search_path = app, public;

CREATE TABLE drug_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  code            text NOT NULL,
  generic_name    text NOT NULL,
  brand_name      text,
  dosage_form     text NOT NULL,
  strength        text,
  base_uom_id     uuid NOT NULL,
  drug_class      text NOT NULL CHECK (drug_class IN ('BEBAS','BEBAS_TERBATAS','KERAS','NARKOTIKA','PSIKOTROPIKA','PREKURSOR','ALKES','LAINNYA')),
  kfa_code        text,
  ingredients     text[] NOT NULL DEFAULT '{}',
  min_stock       numeric(18,4) NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, base_uom_id) REFERENCES uom(tenant_id, id)
);
CREATE INDEX ix_drug_name_trgm ON drug_item USING gin (generic_name gin_trgm_ops);
COMMENT ON TABLE drug_item IS 'Master obat tenant; golongan menentukan aturan jual bebas & akses (PHM-FR-001, PHM-FR-019)';
COMMENT ON COLUMN drug_item.ingredients IS 'Zat aktif (lowercase) untuk pengecekan alergi & duplikasi (CLN-FR-012)';
COMMENT ON COLUMN drug_item.kfa_code IS 'Kode KFA SATUSEHAT (TRM-FR-005)';

ALTER TABLE uom_conversion ADD FOREIGN KEY (tenant_id, drug_item_id) REFERENCES drug_item(tenant_id, id);

CREATE TABLE drug_price (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  drug_item_id  uuid NOT NULL,
  branch_id     uuid,
  payer_type    text CHECK (payer_type IN ('UMUM','ASURANSI','PERUSAHAAN','BPJS')),
  hna           numeric(18,2),
  het           numeric(18,2),
  sell_price    numeric(18,2) NOT NULL CHECK (sell_price >= 0),
  valid_from    date NOT NULL,
  valid_to      date,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, drug_item_id) REFERENCES drug_item(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  EXCLUDE USING gist (
    tenant_id WITH =, drug_item_id WITH =,
    (coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (coalesce(payer_type, '')) WITH =,
    daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') WITH &&)
);
COMMENT ON TABLE drug_price IS 'Harga jual obat per penjamin & periode (PHM-FR-002). Harga beli ada di batch.';
