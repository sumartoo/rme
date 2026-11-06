-- ClinicRME — migrasi 0017 (Stage 8 batch 3): kunjungan & antrean (SCH-FR-005..008, 013; OD-032, OD-086, OD-087 / DEC-035).
SET search_path = app, public;

-- 1. Awalan nomor antrean per poli (OD-086): 1–3 huruf; kosong = huruf pertama kode poli.
ALTER TABLE service_unit
  ADD COLUMN queue_prefix text CHECK (queue_prefix ~ '^[A-Z]{1,3}$');
COMMENT ON COLUMN service_unit.queue_prefix IS 'Awalan nomor antrean (A-001); NULL = huruf pertama kode poli (OD-086)';

-- 2. Kunjungan: verifikasi kepesertaan penjamin manual (OD-032) & keterlambatan janji temu (OD-087).
ALTER TABLE encounter
  ADD COLUMN coverage_verified_at  timestamptz,
  ADD COLUMN coverage_verified_by  uuid,
  ADD COLUMN coverage_verification_note text,
  ADD COLUMN arrived_late          boolean NOT NULL DEFAULT false,
  ADD COLUMN cancelled_at          timestamptz,
  ADD CONSTRAINT encounter_coverage_payer CHECK ((coverage_id IS NULL) = (payer_type = 'UMUM')),
  ADD CONSTRAINT encounter_coverage_verified CHECK (payer_type NOT IN ('ASURANSI','PERUSAHAAN') OR coverage_verified_at IS NOT NULL);
-- Satu janji temu hanya dapat menjadi satu kunjungan
CREATE UNIQUE INDEX ux_encounter_appointment ON encounter(tenant_id, appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX ix_encounter_board ON encounter(tenant_id, branch_id, arrived_at);
-- Kunjungan tidak dihapus (batal = status beralasan)
REVOKE DELETE ON encounter FROM clinicrme_app;

-- 3. Tiket antrean: urutan layanan (sort_key) terpisah dari nomor tampilan. Walk-in & terlambat = waktu datang;
--    janji temu tepat waktu = jam slotnya (OD-087). Satu tiket per kunjungan.
ALTER TABLE queue_ticket
  ADD COLUMN practitioner_id uuid,
  ADD COLUMN sort_key        timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN called_by       uuid,
  ADD COLUMN skipped_at      timestamptz,
  ADD COLUMN created_at      timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at      timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_by      uuid,
  ADD COLUMN version         int NOT NULL DEFAULT 1,
  ADD CONSTRAINT queue_ticket_practitioner_fk FOREIGN KEY (tenant_id, practitioner_id) REFERENCES practitioner(tenant_id, id);
CREATE TRIGGER trg_touch BEFORE UPDATE ON queue_ticket FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE UNIQUE INDEX ux_queue_ticket_encounter ON queue_ticket(tenant_id, encounter_id);
CREATE INDEX ix_queue_ticket_waiting ON queue_ticket(tenant_id, branch_id, unit_id, queue_date, status, sort_key);
REVOKE DELETE ON queue_ticket FROM clinicrme_app;
REVOKE DELETE ON queue_counter FROM clinicrme_app;

-- 4. Menu pelayanan
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('service.visits', 'service', 'Kunjungan', '/visits', 'clipboard', 'encounter.read', 105),
  ('service.queue',  'service', 'Antrean',   '/queue',  'list-ordered', 'queue.call', 106)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
