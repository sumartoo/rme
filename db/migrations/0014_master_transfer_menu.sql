-- ClinicRME — migrasi 0014 (Stage 7 batch 4): menu impor & ekspor master data (MST-FR-008).
SET search_path = app, public;

INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('master.transfer', 'master', 'Impor & ekspor', '/master/transfer', 'upload', 'master.import', 870)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
