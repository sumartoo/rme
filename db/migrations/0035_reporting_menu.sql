-- ClinicRME — migrasi 0035 (Stage 14 batch 1): menu Laporan (RPT-FR-001, 002; DEC-047).
SET search_path = app, public;

INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('report', NULL, 'Laporan', NULL, 'chart', NULL, 500),
  ('report.visits', 'report', 'Kunjungan', '/reports/visits', 'chart', 'report.operational.read', 510),
  ('report.diagnoses', 'report', '10 besar diagnosis', '/reports/diagnoses', 'chart', 'report.clinical.read', 520)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;

-- Laporan kunjungan memindai encounter per waktu kedatangan
CREATE INDEX IF NOT EXISTS ix_encounter_report_time ON encounter(tenant_id, (coalesce(arrived_at, created_at)));
