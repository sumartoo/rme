-- ClinicRME — migrasi 0011 (Stage 7 batch 1): menu master data (MST-FR-001, MST-FR-002).
-- Menu global, hanya-baca bagi aplikasi; item tampil bila user punya permission-nya (IAM-FR-010).
SET search_path = app, public;

INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('master',               NULL,     'Master data',        NULL,                    'database',    NULL,                       800),
  ('master.organization',  'master', 'Fasilitas & cabang', '/master/organization',  'building-2',  'master.facility.read',     810),
  ('master.practitioners', 'master', 'Tenaga kesehatan',   '/master/practitioners', 'stethoscope', 'master.practitioner.read', 820)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
