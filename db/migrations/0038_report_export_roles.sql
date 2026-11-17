-- ClinicRME — migrasi 0038 (Stage 14 batch 3, OD-132 / DEC-048): unduhan CSV laporan wajib izin report.export.
-- Role template yang sebelumnya mengunduh CSV laporan dari halamannya (Admin Klinik: kunjungan; Apoteker/TTK: stok, mutasi,
-- golongan terbatas, kedaluwarsa) diberi report.export agar kemampuan itu tetap ada — kini lewat ekspor ber-watermark.
SET search_path = app, public;

DO $$
DECLARE def text := pg_get_functiondef('app.create_template_roles()'::regprocedure);
  a text := $q$'report.dashboard.read', 'report.operational.read', 'schedule.manage'$q$;
  f text := $q$'pharmacy.stock.receive', 'report.pharmacy.controlled', 'report.pharmacy.read'$q$;
BEGIN
  IF (length(def) - length(replace(def, a, ''))) / length(a) <> 1 OR (length(def) - length(replace(def, f, ''))) / length(f) <> 1 THEN
    RAISE EXCEPTION 'create_template_roles berubah — perbarui migrasi 0038';
  END IF;
  def := replace(def, a, $q$'report.dashboard.read', 'report.export', 'report.operational.read', 'schedule.manage'$q$);
  def := replace(def, f, $q$'pharmacy.stock.receive', 'report.export', 'report.pharmacy.controlled', 'report.pharmacy.read'$q$);
  EXECUTE def;
END $$;

INSERT INTO role_permission(tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, 'report.export' FROM role r WHERE r.is_template AND r.code IN ('TENANT_ADMIN', 'FARMASI')
ON CONFLICT DO NOTHING;
