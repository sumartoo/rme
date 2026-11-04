-- =====================================================================
-- 045 Terminology — Stage 7 (TRM-FR-*). Tabel global + favorit per tenant.
-- =====================================================================
SET search_path = app, public;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE code_system (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL CHECK (code IN ('ICD10','ICD9CM','KFA','LOINC','SNOMED')),
  version         text NOT NULL,
  source          text NOT NULL,
  effective_date  date,
  is_current      boolean NOT NULL DEFAULT false,
  UNIQUE (code, version)
);
CREATE UNIQUE INDEX ux_code_system_current ON code_system(code) WHERE is_current;
COMMENT ON TABLE code_system IS 'Sistem kode & versi sumber (TRM-FR-001/002, OD-030)';

CREATE TABLE concept (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id    uuid NOT NULL REFERENCES code_system(id),
  code         text NOT NULL,
  display_id   text NOT NULL,
  display_en   text,
  parent_code  text,
  synonyms     text[] NOT NULL DEFAULT '{}',
  is_active    boolean NOT NULL DEFAULT true,
  UNIQUE (system_id, code)
);
CREATE INDEX ix_concept_display_trgm ON concept USING gin (display_id gin_trgm_ops);
COMMENT ON TABLE concept IS 'Kode asli tanpa modifikasi + display Bahasa Indonesia (AC-TRM-FR-001-1)';

CREATE TABLE tenant_concept_favorite (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  concept_id    uuid NOT NULL REFERENCES concept(id),
  specialty     text,
  validated_by  uuid,
  validated_at  timestamptz,
  PRIMARY KEY (tenant_id, concept_id)
);
COMMENT ON TABLE tenant_concept_favorite IS 'Subset diagnosis/tindakan favorit tenant, wajib divalidasi tenaga medis (TRM-FR-003)';
