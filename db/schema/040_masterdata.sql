-- =====================================================================
-- 040 Master Data — Stage 7 (MST-FR-*), ADR-0005 (penomoran)
-- =====================================================================
SET search_path = app, public;

-- Global: wilayah administratif (MST-FR-011, sumber OD-062)
CREATE TABLE region (
  code         text PRIMARY KEY,
  parent_code  text REFERENCES region(code),
  level        smallint NOT NULL CHECK (level BETWEEN 1 AND 4),
  name         text NOT NULL
);
COMMENT ON TABLE region IS 'Wilayah: 1 provinsi, 2 kab/kota, 3 kecamatan, 4 kelurahan/desa';

CREATE TABLE facility (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  name            text NOT NULL,
  facility_type   text NOT NULL CHECK (facility_type IN ('KLINIK_UTAMA','KLINIK_PRATAMA','PRAKTIK_MANDIRI')),
  license_number  text,
  satusehat_org_id text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);
COMMENT ON TABLE facility IS 'Fasilitas pelayanan kesehatan dalam tenant; padanan Organization SATUSEHAT';

CREATE TABLE branch (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  facility_id      uuid NOT NULL,
  code             text NOT NULL,
  name             text NOT NULL,
  address          text,
  region_code      text REFERENCES region(code),
  phone            text,
  timezone         text NOT NULL DEFAULT 'Asia/Jakarta' CHECK (timezone IN ('Asia/Jakarta','Asia/Makassar','Asia/Jayapura')),
  satusehat_location_id text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES facility(tenant_id, id)
);
COMMENT ON TABLE branch IS 'Cabang / lokasi pelayanan; zona waktu menentukan tampilan waktu (AC-GEN-FR-005-2)';

ALTER TABLE user_role_assignment
  ADD FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id);
ALTER TABLE user_session
  ADD FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id);

CREATE TABLE service_unit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  branch_id   uuid NOT NULL,
  code        text NOT NULL,
  name        text NOT NULL,
  unit_type   text NOT NULL CHECK (unit_type IN ('POLI','RUANG','FARMASI','KASIR','LAB','LAINNYA')),
  specialty   text,
  default_template text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,
  version     int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, branch_id, code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id)
);
COMMENT ON TABLE service_unit IS 'Poli, ruang layanan, lokasi farmasi, kasir, lab (MST-FR-001)';

CREATE TABLE practitioner (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  full_name            text NOT NULL,
  nik_encrypted        bytea,
  nik_hash             text,
  practitioner_type    text NOT NULL CHECK (practitioner_type IN ('DOKTER','DOKTER_GIGI','DOKTER_SPESIALIS','PERAWAT','BIDAN','APOTEKER','TTK','ANALIS','LAINNYA')),
  specialty            text,
  str_number           text,
  str_valid_until      date,
  sip_number           text,
  sip_valid_until      date,
  satusehat_ihs_id     text,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid,
  version              int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, nik_hash)
);
COMMENT ON TABLE practitioner IS 'Tenaga medis & tenaga kesehatan dengan STR/SIP (MST-FR-002)';
COMMENT ON COLUMN practitioner.nik_hash IS 'HMAC-SHA256 NIK dengan kunci per lingkungan; untuk pencarian & keunikan';

ALTER TABLE app_user
  ADD FOREIGN KEY (tenant_id, practitioner_id) REFERENCES practitioner(tenant_id, id);

CREATE TABLE payer (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  code          text NOT NULL,
  name          text NOT NULL,
  payer_type    text NOT NULL CHECK (payer_type IN ('UMUM','ASURANSI','PERUSAHAAN','BPJS')),
  contract      jsonb,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
COMMENT ON TABLE payer IS 'Penjamin: Umum, Asuransi, Perusahaan, BPJS (MST-FR-006, BPJ-FR-004)';
COMMENT ON COLUMN payer.contract IS 'Ketentuan kontrak: plafon, co-pay %, termin pembayaran';

CREATE TABLE service_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  code          text NOT NULL,
  name          text NOT NULL,
  service_type  text NOT NULL CHECK (service_type IN ('KONSULTASI','TINDAKAN','PAKET','ADMINISTRASI','LAB','LAINNYA')),
  icd9cm_code   text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
COMMENT ON TABLE service_item IS 'Layanan yang dapat ditagih (MST-FR-004)';

CREATE TABLE tariff (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  service_item_id  uuid NOT NULL,
  branch_id        uuid,
  payer_type       text CHECK (payer_type IN ('UMUM','ASURANSI','PERUSAHAAN','BPJS')),
  payer_id         uuid,
  price            numeric(18,2) NOT NULL CHECK (price >= 0),
  valid_from       date NOT NULL,
  valid_to         date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, service_item_id) REFERENCES service_item(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, payer_id) REFERENCES payer(tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE tariff ADD CONSTRAINT ex_tariff_no_overlap EXCLUDE USING gist (
  tenant_id WITH =, service_item_id WITH =,
  (coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  (coalesce(payer_type, '')) WITH =,
  (coalesce(payer_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') WITH &&
);
COMMENT ON TABLE tariff IS 'Tarif per layanan × cabang × penjamin × periode; periode tidak boleh tumpang tindih (AC-MST-FR-005-1)';

CREATE TABLE uom (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  code       text NOT NULL,
  name       text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
COMMENT ON TABLE uom IS 'Satuan (tablet, strip, box, ml, botol, ...) (MST-FR-007)';

CREATE TABLE uom_conversion (
  tenant_id    uuid NOT NULL,
  from_uom_id  uuid NOT NULL,
  to_uom_id    uuid NOT NULL,
  factor       numeric(18,6) NOT NULL CHECK (factor > 0),
  drug_item_id uuid,
  PRIMARY KEY (tenant_id, from_uom_id, to_uom_id),
  FOREIGN KEY (tenant_id, from_uom_id) REFERENCES uom(tenant_id, id),
  FOREIGN KEY (tenant_id, to_uom_id)   REFERENCES uom(tenant_id, id)
);
COMMENT ON TABLE uom_conversion IS '1 from_uom = factor × to_uom; opsional spesifik obat';

CREATE TABLE supplier (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  name        text NOT NULL,
  phone       text,
  address     text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
COMMENT ON TABLE supplier IS 'Pemasok obat (MST-FR-010)';

-- Penomoran dokumen bisnis (ADR-0005)
CREATE TABLE document_sequence (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  doc_type    text NOT NULL CHECK (doc_type IN ('MRN','ENCOUNTER','PRESCRIPTION','INVOICE','RECEIPT','REFUND','LETTER','REFERRAL','GOODS_RECEIPT','OTC_SALE','LAB_ORDER')),
  scope_key   text NOT NULL,
  pattern     text NOT NULL,
  next_value  bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (tenant_id, doc_type, scope_key)
);
COMMENT ON TABLE document_sequence IS 'Counter nomor dokumen per tenant/jenis/scope; diambil atomik (GEN-FR-006)';

CREATE OR REPLACE FUNCTION app.next_document_number(p_doc_type text, p_scope_key text, p_default_pattern text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_val bigint; v_pattern text; v_out text; v_width int;
BEGIN
  INSERT INTO document_sequence(tenant_id, doc_type, scope_key, pattern)
  VALUES (app.current_tenant_id(), p_doc_type, p_scope_key, p_default_pattern)
  ON CONFLICT DO NOTHING;
  UPDATE document_sequence SET next_value = next_value + 1
   WHERE tenant_id = app.current_tenant_id() AND doc_type = p_doc_type AND scope_key = p_scope_key
  RETURNING next_value - 1, pattern INTO v_val, v_pattern;
  IF v_val IS NULL THEN RAISE EXCEPTION 'Sequence tidak tersedia (tenant context?)'; END IF;
  v_width := coalesce((regexp_match(v_pattern, '\{SEQ:(\d+)\}'))[1]::int, 6);
  v_out := regexp_replace(v_pattern, '\{SEQ(:\d+)?\}', lpad(v_val::text, v_width, '0'));
  v_out := replace(replace(v_out, '{YYYY}', to_char(now(), 'YYYY')), '{MM}', to_char(now(), 'MM'));
  RETURN v_out;
END $$;
COMMENT ON FUNCTION app.next_document_number IS 'Ambil nomor berikutnya; dipanggil di transaksi yang sama dengan dokumen';

CREATE TABLE queue_counter (
  tenant_id   uuid NOT NULL,
  branch_id   uuid NOT NULL,
  unit_id     uuid NOT NULL,
  queue_date  date NOT NULL,
  last_number int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, branch_id, unit_id, queue_date),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES service_unit(tenant_id, id)
);
COMMENT ON TABLE queue_counter IS 'Counter antrean per cabang/unit/hari (SCH-FR-007)';
