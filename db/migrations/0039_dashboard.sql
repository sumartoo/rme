-- ClinicRME — migrasi 0039 (Stage 14 batch 4): menu dashboard manajer (RPT-FR-009, OD-131 / DEC-047).
SET search_path = app, public;

INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('report.dashboard', 'report', 'Dashboard manajer', '/reports/dashboard', 'chart', 'report.dashboard.read', 505)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;

-- Uji performa (OD-130, 3 tahun × 300 kunjungan/hari): filter waktu kunjungan ditulis per kolom agar indeks terpakai di bawah RLS
CREATE INDEX IF NOT EXISTS ix_encounter_arrived ON encounter(tenant_id, arrived_at);
CREATE INDEX IF NOT EXISTS ix_encounter_created_noarrival ON encounter(tenant_id, created_at) WHERE arrived_at IS NULL;
