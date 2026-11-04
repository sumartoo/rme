-- ClinicRME — migrasi 0002 (Stage 4 batch 2)
-- 1) PERBAIKAN KEAMANAN: partisi tabel tidak boleh diakses langsung oleh role aplikasi.
--    Temuan: 900_security.sql memberi GRANT ... ON ALL TABLES (termasuk partisi audit_log_default),
--    sedangkan REVOKE pada audit_log hanya berlaku untuk tabel induk dan partisi tidak memiliki RLS.
--    Akibatnya clinicrme_app dapat MEMBACA audit lintas tenant tanpa tenant context dan MENYISIPKAN baris
--    di luar app.write_audit langsung ke partisi. RLS & hak akses hanya berlaku melalui tabel induk.
-- 2) Partisi bulanan audit_log (DATABASE_DESIGN §9): fungsi ensure_audit_partitions, dipanggil job worker harian.
SET search_path = app, public;

-- 1. Cabut semua hak role aplikasi pada setiap partisi yang ada
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.oid::regclass AS t
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app'
            WHERE c.relispartition AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, clinicrme_app, clinicrme_readonly, clinicrme_platform', r.t);
  END LOOP;
END $$;

-- 2. Pembuat partisi bulanan (batas bulan dalam UTC). Idempoten; aman dipanggil bersamaan (advisory lock).
--    Bulan yang barisnya sudah terlanjur masuk partisi default TIDAK dibuat (baris audit immutable, tidak dipindah)
--    dan dilaporkan sebagai SKIPPED_DEFAULT_HAS_ROWS → job gagal → alert (SC-LOG-03).
CREATE OR REPLACE FUNCTION app.ensure_audit_partitions(p_months_ahead int DEFAULT 2)
RETURNS TABLE(partition_name text, status text)
LANGUAGE plpgsql SET search_path = app, public AS $$
DECLARE
  v_from timestamptz;
  v_to   timestamptz;
  v_name text;
BEGIN
  IF p_months_ahead < 0 OR p_months_ahead > 24 THEN
    RAISE EXCEPTION 'p_months_ahead harus 0..24';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('app.ensure_audit_partitions'));
  FOR i IN 0..p_months_ahead LOOP
    v_from := date_trunc('month', now(), 'UTC') + make_interval(months => i);
    v_to   := v_from + interval '1 month';
    v_name := 'audit_log_' || to_char(v_from AT TIME ZONE 'UTC', 'YYYY_MM');
    partition_name := v_name;
    IF to_regclass('app.' || v_name) IS NOT NULL THEN
      status := 'EXISTS';
    ELSIF EXISTS (SELECT 1 FROM app.audit_log_default WHERE occurred_at >= v_from AND occurred_at < v_to) THEN
      status := 'SKIPPED_DEFAULT_HAS_ROWS';
    ELSE
      EXECUTE format('CREATE TABLE app.%I PARTITION OF app.audit_log FOR VALUES FROM (%L) TO (%L)', v_name, v_from, v_to);
      EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC, clinicrme_app, clinicrme_readonly, clinicrme_platform', v_name);
      status := 'CREATED';
    END IF;
    RETURN NEXT;
  END LOOP;
END $$;
COMMENT ON FUNCTION app.ensure_audit_partitions(int) IS
  'Membuat partisi audit_log bulan ini + N bulan ke depan (UTC). Dijalankan job worker system.audit_partitions (harian).';
-- Fungsi baru otomatis dapat dieksekusi PUBLIC; hanya owner/worker yang boleh
REVOKE ALL ON FUNCTION app.ensure_audit_partitions(int) FROM PUBLIC, clinicrme_app, clinicrme_readonly, clinicrme_platform;

-- 3. Buat partisi bulan berjalan + 2 bulan ke depan saat migrasi (bulan yang sudah berisi baris di default dilewati)
SELECT * FROM app.ensure_audit_partitions(2);
