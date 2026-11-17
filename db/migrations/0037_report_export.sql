-- ClinicRME — migrasi 0037 (Stage 14 batch 3): laporan farmasi disatukan di menu Laporan (RPT-FR-005, 006) dan
-- ekspor laporan seragam XLSX/CSV/PDF dengan watermark; ekspor besar diproses worker (RPT-FR-008, OD-128 / DEC-047).
SET search_path = app, public;

-- Menu: laporan farmasi pindah ke grup Laporan (kode tetap agar penyesuaian menu tenant tidak hilang)
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('pharmacy.report', 'report', 'Stok & mutasi obat', '/reports/stock', 'chart', 'report.pharmacy.read', 560),
  ('report.near_expiry', 'report', 'Obat mendekati kedaluwarsa', '/reports/near-expiry', 'chart', 'report.pharmacy.read', 570),
  ('pharmacy.controlled', 'report', 'Obat golongan terbatas', '/reports/controlled-drugs', 'chart', 'report.pharmacy.controlled', 580)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;

-- Job ekspor laporan. Isi laporan tidak disimpan di tabel ini — hanya parameter filter (tanpa data pasien) dan berkas di bucket exports.
CREATE TABLE report_export_job (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  report_code   text NOT NULL CHECK (report_code ~ '^[a-z][a-z-]{1,40}$'),
  format        text NOT NULL CHECK (format IN ('XLSX', 'CSV', 'PDF')),
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  branch_scope  uuid[],
  status        text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'EXPIRED')),
  row_count     integer CHECK (row_count >= 0),
  file_id       uuid,
  requested_by  uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  expires_at    timestamptz,
  download_count integer NOT NULL DEFAULT 0,
  error         text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES stored_file(tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES app_user(tenant_id, id),
  CHECK (status <> 'DONE' OR (file_id IS NOT NULL AND expires_at IS NOT NULL AND row_count IS NOT NULL))
);
COMMENT ON TABLE report_export_job IS 'Ekspor laporan standar (RPT-FR-008, OD-128): ≤ 10.000 baris langsung, di atasnya worker; tautan unduh berlaku 24 jam';
COMMENT ON COLUMN report_export_job.branch_scope IS 'Cakupan cabang pemohon saat meminta (NULL = semua cabang), dipakai worker agar hasil sama dengan tampilan';
CREATE INDEX ix_report_export_queue ON report_export_job(created_at) WHERE status = 'QUEUED';
CREATE INDEX ix_report_export_expiry ON report_export_job(expires_at) WHERE status = 'DONE';
CREATE INDEX ix_report_export_user ON report_export_job(tenant_id, requested_by, created_at DESC);

SELECT app.enable_tenant_rls('app.report_export_job'::regclass);
GRANT SELECT, INSERT, UPDATE ON report_export_job TO clinicrme_app;
