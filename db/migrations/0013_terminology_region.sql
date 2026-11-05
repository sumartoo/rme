-- ClinicRME — migrasi 0013 (Stage 7 batch 3): terminologi ICD & wilayah (TRM-FR-001–004, MST-FR-011).
-- Data global dimuat terpisah oleh pemuat referensi (`pnpm db:reference`, job `reference` saat deploy) dari db/reference.
SET search_path = app, public;

-- Catatan dataset referensi yang sudah dimuat (idempoten per id + versi + sha256)
CREATE TABLE reference_dataset (
  id         text PRIMARY KEY,
  version    text NOT NULL,
  sha256     text NOT NULL,
  source     text NOT NULL,
  license    text NOT NULL,
  row_count  int  NOT NULL,
  loaded_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE reference_dataset IS 'Sumber, versi & lisensi data referensi global (OD-030, OD-062)';
GRANT SELECT ON reference_dataset TO clinicrme_app, clinicrme_platform, clinicrme_readonly;

-- Pencarian kode: awalan kode & sinonim
CREATE INDEX ix_concept_system_code ON concept(system_id, code text_pattern_ops);
CREATE INDEX ix_concept_synonyms ON concept USING gin (synonyms);
CREATE INDEX ix_region_parent ON region(parent_code);
CREATE INDEX ix_region_name_trgm ON region USING gin (name gin_trgm_ops);

-- Favorit: siapa yang menandai (validasi tetap kolom validated_by/validated_at, OD-084)
ALTER TABLE tenant_concept_favorite ADD COLUMN created_by uuid,
                                    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE tenant_concept_favorite
  ADD CONSTRAINT ck_favorite_validated CHECK ((validated_by IS NULL) = (validated_at IS NULL));

INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('master.terminology', 'master', 'Diagnosis & tindakan', '/master/terminology', 'book-open', 'terminology.favorite.manage', 860)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
