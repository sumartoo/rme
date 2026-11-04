-- Uji untuk perubahan skema setelah baseline (migrasi 0002+). Dijalankan oleh run_tests.sh bila DB_SOURCE=migrations.
SET search_path = app, public;

-- ---------------------------------------------------------------------
\echo '--- T25 Partisi tidak dapat diakses langsung oleh role aplikasi (migrasi 0002) ---'
-- ---------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(c.relname || ':' || r.rolname || ':' || p.priv, ', ') INTO v_bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app'
    CROSS JOIN (VALUES ('clinicrme_app'), ('clinicrme_readonly'), ('clinicrme_platform')) r(rolname)
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
   WHERE c.relispartition AND c.relkind IN ('r', 'p') AND has_table_privilege(r.rolname, c.oid, p.priv);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL T25 hak langsung pada partisi: %', v_bad; END IF;
  RAISE NOTICE 'PASS T25 tidak ada hak role aplikasi pada % partisi',
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app' WHERE c.relispartition AND c.relkind IN ('r', 'p'));
END $$;

SET ROLE clinicrme_app;
SELECT test.expect_error('T25b role aplikasi membaca partisi default langsung (melewati RLS)',
  $q$SELECT count(*) FROM app.audit_log_default$q$, 'permission denied');
SELECT test.expect_error('T25c role aplikasi menyisipkan audit langsung ke partisi',
  $q$INSERT INTO app.audit_log_default(tenant_id, seq, action, resource_type, prev_hash, hash)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 999999, 'FORGED', 'x', 'x', 'x')$q$, 'permission denied');
SELECT test.expect_error('T25d role aplikasi tidak dapat menjalankan pembuat partisi',
  $q$SELECT * FROM app.ensure_audit_partitions(1)$q$, 'permission denied');
SET app.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000000';
SELECT test.expect_eq('T25e lewat tabel induk, RLS tetap berlaku (hanya tenant aktif)',
  (SELECT count(DISTINCT tenant_id) FROM audit_log) <= 1, true);
RESET app.tenant_id;
RESET ROLE;

-- ---------------------------------------------------------------------
\echo '--- T26 Partisi bulanan audit_log ---'
-- ---------------------------------------------------------------------
SELECT test.expect_eq('T26 partisi bulan berjalan (UTC) dibuat oleh migrasi',
  to_regclass('app.audit_log_' || to_char(now() AT TIME ZONE 'UTC', 'YYYY_MM')) IS NOT NULL, true);
SELECT test.expect_eq('T26b audit baru masuk partisi bulanan, bukan default',
  (SELECT count(*) FROM app.audit_log_default WHERE occurred_at >= date_trunc('month', now(), 'UTC')), 0::bigint);
SELECT test.expect_eq('T26c idempoten: panggilan ulang tidak membuat apa pun',
  (SELECT count(*) FROM app.ensure_audit_partitions(2) WHERE status <> 'EXISTS'), 0::bigint);
-- Baris yang terlanjur masuk default untuk bulan yang belum dipartisi tidak dipindah (immutable): bulan itu dilewati & dilaporkan
INSERT INTO app.audit_log(tenant_id, seq, occurred_at, action, resource_type, prev_hash, hash)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 900001, date_trunc('month', now(), 'UTC') + interval '5 months' + interval '1 day',
          'TEST', 'x', repeat('0', 64), repeat('0', 64));
SELECT test.expect_eq('T26d bulan yang barisnya sudah di default → SKIPPED_DEFAULT_HAS_ROWS',
  (SELECT status FROM app.ensure_audit_partitions(5)
    WHERE partition_name = 'audit_log_' || to_char((date_trunc('month', now(), 'UTC') + interval '5 months') AT TIME ZONE 'UTC', 'YYYY_MM')),
  'SKIPPED_DEFAULT_HAS_ROWS');
SELECT test.expect_eq('T26e bulan lain tetap dibuat (bulan +3, +4)',
  (SELECT count(*) FROM pg_class WHERE relname IN (
     'audit_log_' || to_char((date_trunc('month', now(), 'UTC') + interval '3 months') AT TIME ZONE 'UTC', 'YYYY_MM'),
     'audit_log_' || to_char((date_trunc('month', now(), 'UTC') + interval '4 months') AT TIME ZONE 'UTC', 'YYYY_MM'))), 2::bigint);
SELECT test.expect_error('T26f p_months_ahead di luar batas ditolak', $q$SELECT * FROM app.ensure_audit_partitions(25)$q$, 'harus 0..24');

SELECT test.expect_eq('T26g partisi yang dibuat fungsi juga tanpa hak role aplikasi',
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app'
     CROSS JOIN (VALUES ('clinicrme_app'), ('clinicrme_readonly')) r(rolname)
    WHERE c.relispartition AND c.relkind IN ('r', 'p') AND has_table_privilege(r.rolname, c.oid, 'SELECT')), 0::bigint);

-- ---------------------------------------------------------------------
\echo '--- T27 Pemisahan role platform (migrasi 0003, CR-0001, PLT-FR-009) ---'
-- ---------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  -- (a) tabel identitas platform: tidak ada hak untuk role aplikasi/readonly/PUBLIC
  SELECT string_agg(t || ':' || r || ':' || p, ', ') INTO v_bad
    FROM unnest(ARRAY['platform_user','platform_credential','platform_mfa','platform_session','platform_audit_log']) t
    CROSS JOIN unnest(ARRAY['clinicrme_app','clinicrme_readonly','public']) r
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
   WHERE has_table_privilege(r, 'app.' || t, p);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL T27 hak pada tabel platform: %', v_bad; END IF;
  -- (b) role platform: tidak ada hak pada tabel ber-tenant_id selain tabel platform yang memang dikelolanya
  SELECT string_agg(DISTINCT c.relname, ', ') INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app'
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
   WHERE c.relkind IN ('r','p') AND NOT c.relispartition
     AND c.relname NOT IN ('tenant_subscription','tenant_status_history','tenant_feature_flag','support_access_grant','tenant_export_job')
     AND has_table_privilege('clinicrme_platform', c.oid, p);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL T27b role platform punya hak pada tabel tenant: %', v_bad; END IF;
  -- (c) platform tidak boleh DELETE apa pun (riwayat & audit dipertahankan)
  SELECT string_agg(c.relname, ', ') INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app'
   WHERE c.relkind IN ('r','p') AND has_table_privilege('clinicrme_platform', c.oid, 'DELETE');
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL T27c role platform dapat DELETE: %', v_bad; END IF;
  RAISE NOTICE 'PASS T27 tabel platform tertutup bagi role aplikasi; role platform tanpa akses tabel klinis & tanpa DELETE';
END $$;
SELECT test.expect_eq('T27d provision_tenant hanya dapat dijalankan role platform',
  (has_function_privilege('clinicrme_platform', 'app.provision_tenant(text,text,text,text,uuid,int,text,text,uuid)', 'EXECUTE'),
   has_function_privilege('clinicrme_app', 'app.provision_tenant(text,text,text,text,uuid,int,text,text,uuid)', 'EXECUTE'),
   has_function_privilege('clinicrme_readonly', 'app.provision_tenant(text,text,text,text,uuid,int,text,text,uuid)', 'EXECUTE'))::text,
  '(t,f,f)');
INSERT INTO app.platform_audit_log(action) VALUES ('T27_TEST');
SELECT test.expect_error('T27e audit platform append-only (juga untuk owner)',
  $q$UPDATE app.platform_audit_log SET action = 'X'$q$, 'IMMUTABLE');

-- ---------------------------------------------------------------------
\echo '--- T28 Mesin status tenant ditegakkan trigger ---'
-- ---------------------------------------------------------------------
INSERT INTO app.tenant(id, code, legal_name, display_name, tenant_type, status)
  VALUES ('cccccccc-0000-0000-0000-000000000000', 'klinik-t28', 'PT T28', 'T28', 'KLINIK_PRATAMA', 'ACTIVE');
SELECT test.expect_error('T28 ACTIVE → TERMINATED langsung ditolak',
  $q$UPDATE app.tenant SET status = 'TERMINATED' WHERE code = 'klinik-t28'$q$, 'PLT-409-STATUS');
SELECT test.expect_error('T28b kembali ke PROVISIONING ditolak',
  $q$UPDATE app.tenant SET status = 'PROVISIONING' WHERE code = 'klinik-t28'$q$, 'PLT-409-STATUS');
UPDATE app.tenant SET status = 'SUSPENDED' WHERE code = 'klinik-t28';
UPDATE app.tenant SET status = 'TERMINATED' WHERE code = 'klinik-t28';
SELECT test.expect_error('T28c TERMINATED final',
  $q$UPDATE app.tenant SET status = 'ACTIVE' WHERE code = 'klinik-t28'$q$, 'PLT-409-STATUS');
UPDATE app.tenant SET display_name = 'T28 (arsip)' WHERE code = 'klinik-t28';
SELECT test.expect_eq('T28d perubahan kolom lain pada tenant TERMINATED tetap boleh (mis. arsip nama)',
  (SELECT display_name FROM app.tenant WHERE code = 'klinik-t28'), 'T28 (arsip)');

-- ---------------------------------------------------------------------
\echo '--- T29 Kode tenant tercadang & provisioning atomik ---'
-- ---------------------------------------------------------------------
SELECT test.expect_error('T29 subdomain konsol "admin" tidak dapat menjadi kode klinik',
  $q$INSERT INTO app.tenant(code, legal_name, display_name, tenant_type) VALUES ('admin', 'X', 'X', 'KLINIK_PRATAMA')$q$, 'tenant_code_not_reserved');
SELECT test.expect_error('T29b paket tidak aktif ditolak sebelum apa pun dibuat',
  $q$SELECT app.provision_tenant('klinik-t29', 'PT T29', '', 'KLINIK_PRATAMA', gen_random_uuid(), 0, 'a@t29.test', 'h29', NULL)$q$, 'PLT-400-PLAN');
SELECT test.expect_eq('T29c tidak ada sisa tenant dari provisioning yang gagal',
  (SELECT count(*) FROM app.tenant WHERE code = 'klinik-t29'), 0::bigint);
SELECT test.expect_eq('T29d paket PILOT tersedia',
  (SELECT count(*) FROM app.subscription_plan WHERE code = 'PILOT' AND is_active), 1::bigint);

-- ---------------------------------------------------------------------
\echo '--- T30 Kuota paket & kebersihan fungsi SECURITY DEFINER ---'
-- ---------------------------------------------------------------------
SELECT test.expect_eq('T30 trigger kuota terpasang di app_user dan branch',
  (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_quota_users', 'trg_quota_branches') AND NOT tgisinternal), 2::bigint);
SELECT test.expect_eq('T30b semua fungsi SECURITY DEFINER di skema app memakai search_path tetap',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'app'
    WHERE p.prosecdef AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')), 0::bigint);
SELECT test.expect_eq('T30c tidak ada fungsi SECURITY DEFINER baru yang dapat dijalankan PUBLIC',
  (SELECT string_agg(p.proname, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'app'
    WHERE p.prosecdef AND has_function_privilege('public', p.oid, 'EXECUTE')
      AND p.proname IN ('provision_tenant', 'enforce_plan_quota', 'ensure_audit_partitions')), NULL::text);

-- ---------------------------------------------------------------------
\echo '--- T31 Profil klinik: hak kolom aplikasi (migrasi 0004, PLT-FR-007) ---'
-- ---------------------------------------------------------------------
SELECT test.expect_eq('T31 aplikasi boleh UPDATE kolom profil saja',
  (SELECT string_agg(col, ',' ORDER BY col) FROM unnest(ARRAY['code','display_name','letterhead','logo_file_id','settings','status','legal_name','tenant_type']) col
    WHERE has_column_privilege('clinicrme_app', 'app.tenant', col, 'UPDATE')), 'display_name,letterhead,logo_file_id,settings');
SET ROLE clinicrme_app;
SET app.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000000';
SELECT test.expect_eq('T31b baris tenant lain tidak terlihat sehingga tidak dapat diubah (RLS)',
  (SELECT count(*) FROM app.tenant WHERE id = 'bbbbbbbb-0000-0000-0000-000000000000'), 0::bigint);
SELECT test.expect_error('T31c status tenant tidak dapat diubah aplikasi',
  $q$UPDATE app.tenant SET status = 'SUSPENDED' WHERE id = 'aaaaaaaa-0000-0000-0000-000000000000'$q$, 'permission denied');
RESET app.tenant_id;
RESET ROLE;

-- ---------------------------------------------------------------------
\echo '--- T32 Job ekspor: RLS, satu aktif per tenant, konsol platform tanpa kunci (migrasi 0004, PLT-FR-008) ---'
-- ---------------------------------------------------------------------
SELECT test.expect_eq('T32 tenant_export_job ber-RLS (ENABLE + FORCE)',
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'app.tenant_export_job'::regclass), true);
SET ROLE clinicrme_app;
SET app.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000000';
INSERT INTO app.tenant_export_job(tenant_id, requested_by) VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000024');
SELECT test.expect_error('T32b ekspor aktif kedua untuk tenant yang sama ditolak',
  $q$INSERT INTO app.tenant_export_job(tenant_id, requested_by) VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000024')$q$, 'ux_tenant_export_active');
SELECT test.expect_error('T32c membuat job untuk tenant lain ditolak (WITH CHECK)',
  $q$INSERT INTO app.tenant_export_job(tenant_id, requested_by) VALUES ('bbbbbbbb-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000024')$q$, 'row-level security');
RESET app.tenant_id;
SELECT test.expect_eq('T32d tanpa tenant context tidak ada job terlihat (fail-closed)', (SELECT count(*) FROM app.tenant_export_job), 0::bigint);
RESET ROLE;
SELECT test.expect_eq('T32e konsol platform: kolom status terbaca, kunci & berkas tidak',
  (has_column_privilege('clinicrme_platform', 'app.tenant_export_job', 'status', 'SELECT'),
   has_column_privilege('clinicrme_platform', 'app.tenant_export_job', 'key_encrypted', 'SELECT'),
   has_column_privilege('clinicrme_platform', 'app.tenant_export_job', 'file_id', 'SELECT'),
   has_table_privilege('clinicrme_platform', 'app.tenant_export_job', 'UPDATE'))::text, '(t,f,f,f)');

-- ---------------------------------------------------------------------
\echo '--- T33 Break-glass & notifikasi: hak fungsi, grant tak terhapus, trigger undangan (migrasi 0005, OD-077) ---'
-- ---------------------------------------------------------------------
SELECT test.expect_eq('T33 support_open tidak dapat dipanggil langsung oleh peran mana pun',
  (has_function_privilege('clinicrme_app', 'app.support_open(uuid, uuid)', 'EXECUTE'),
   has_function_privilege('clinicrme_platform', 'app.support_open(uuid, uuid)', 'EXECUTE'),
   has_function_privilege('clinicrme_readonly', 'app.support_open(uuid, uuid)', 'EXECUTE'),
   has_function_privilege('public', 'app.support_open(uuid, uuid)', 'EXECUTE'))::text, '(f,f,f,f)');
SELECT test.expect_eq('T33b fungsi baca support hanya untuk konsol platform; detail email hanya untuk aplikasi',
  (has_function_privilege('clinicrme_platform', 'app.support_read_users(uuid, uuid)', 'EXECUTE'),
   has_function_privilege('clinicrme_app', 'app.support_read_users(uuid, uuid)', 'EXECUTE'),
   has_function_privilege('clinicrme_platform', 'app.support_read_audit(uuid, uuid, int, bigint)', 'EXECUTE'),
   has_function_privilege('clinicrme_app', 'app.support_read_audit(uuid, uuid, int, bigint)', 'EXECUTE'),
   has_function_privilege('clinicrme_app', 'app.support_grant_for_notification(uuid)', 'EXECUTE'),
   has_function_privilege('clinicrme_platform', 'app.support_grant_for_notification(uuid)', 'EXECUTE'))::text, '(t,f,t,f,t,f)');
SELECT test.expect_eq('T33c riwayat grant tidak dapat dihapus konsol platform',
  has_table_privilege('clinicrme_platform', 'app.support_access_grant', 'DELETE'), false);
SELECT test.expect_eq('T33d semua fungsi SECURITY DEFINER migrasi 0005 tertutup bagi PUBLIC',
  (SELECT string_agg(p.proname, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'app'
    WHERE p.prosecdef AND has_function_privilege('public', p.oid, 'EXECUTE')
      AND p.proname IN ('support_open', 'support_read_users', 'support_read_audit', 'enqueue_support_notification',
                        'support_grant_for_notification', 'enqueue_invitation_email')), NULL::text);
INSERT INTO app.user_invitation(tenant_id, email, role_ids, token_hash, expires_at)
VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'undangan@a.test', '{}', 'sql-test-token-hash', now() + interval '1 day');
SELECT test.expect_eq('T33e undangan baru menghasilkan satu event outbox INVITATION_CREATED tanpa token di payload',
  (SELECT count(*)::text || ':' || max(payload::text) FROM app.outbox_event o JOIN app.user_invitation i ON i.id = o.aggregate_id
    WHERE i.token_hash = 'sql-test-token-hash' AND o.event_type = 'INVITATION_CREATED' AND o.tenant_id = i.tenant_id), '1:{}');
SELECT test.expect_error('T33f enqueue_support_notification menolak jenis event lain',
  $q$SELECT app.enqueue_support_notification(gen_random_uuid(), 'INVITATION_CREATED')$q$, 'jenis event tidak diizinkan');

-- ---------------------------------------------------------------------
\echo '--- T34 Isolasi menyeluruh: setiap tabel ber-tenant_id yang dapat DIBACA aplikasi wajib RLS (migrasi 0006) ---'
-- ---------------------------------------------------------------------
SELECT test.expect_eq('T34 tidak ada tabel ber-tenant_id yang dapat dibaca clinicrme_app tanpa RLS ENABLE + FORCE',
  (SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app'
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND has_table_privilege('clinicrme_app', c.oid, 'SELECT')
      AND NOT (c.relrowsecurity AND c.relforcerowsecurity)), NULL::text);
INSERT INTO app.tenant_feature_flag(tenant_id, feature_code, enabled) VALUES ('bbbbbbbb-0000-0000-0000-000000000000', 'sql.test.flag', true);
SET ROLE clinicrme_app;
SET app.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000000';
SELECT test.expect_eq('T34b feature flag klinik lain tidak terlihat aplikasi',
  (SELECT count(*) FROM app.tenant_feature_flag WHERE tenant_id <> 'aaaaaaaa-0000-0000-0000-000000000000'), 0::bigint);
RESET app.tenant_id;
RESET ROLE;

\echo '=== UJI MIGRASI LULUS ==='
