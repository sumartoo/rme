-- =====================================================================
-- Uji keamanan skema ClinicRME. Dijalankan setelah 001_seed.sql.
-- Setiap blok mencetak PASS atau menghentikan eksekusi dengan FAIL.
-- =====================================================================
\set ON_ERROR_STOP 1
SET search_path = app, public;

-- ---------------------------------------------------------------------
\echo '--- T01–T05 Isolasi tenant (ADR-0002, AC-GEN-FR-001-1/2) ---'
-- ---------------------------------------------------------------------
SET ROLE clinicrme_app;

-- T01: tanpa tenant context → 0 baris (fail-closed)
RESET app.tenant_id;
SELECT test.expect_eq('T01 tanpa tenant context: patient terlihat', (SELECT count(*) FROM patient), 0::bigint);
SELECT test.expect_eq('T01b tanpa tenant context: encounter terlihat', (SELECT count(*) FROM encounter), 0::bigint);

-- T02: tenant A hanya melihat datanya sendiri
SET app.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000000';
SELECT test.expect_eq('T02 tenant A: jumlah patient', (SELECT count(*) FROM patient), 1::bigint);
SELECT test.expect_eq('T02b tenant A: patient milik tenant lain', (SELECT count(*) FROM patient WHERE tenant_id <> app.current_tenant_id()), 0::bigint);
SELECT test.expect_eq('T02c tenant A: baca langsung ID pasien B', (SELECT count(*) FROM patient WHERE id = test.id('b',60)), 0::bigint);
SELECT test.expect_eq('T02d tenant A: baris tenant terlihat', (SELECT count(*) FROM tenant), 1::bigint);

-- T03: tenant A tidak dapat menulis baris ber-tenant_id B
SELECT test.expect_error('T03 insert patient untuk tenant B dari konteks A',
  $q$INSERT INTO patient(tenant_id, mrn, full_name, birth_date, sex, identity_type)
     VALUES ('bbbbbbbb-0000-0000-0000-000000000000','X','X','2000-01-01','L','TANPA_IDENTITAS')$q$,
  'row-level security');
SELECT test.expect_error('T03b ubah tenant_id baris sendiri ke tenant B',
  $q$UPDATE patient SET tenant_id = 'bbbbbbbb-0000-0000-0000-000000000000' WHERE id = test.id('a',60)$q$,
  'row-level security');

-- T04: tenant A tidak dapat mereferensikan objek tenant B (FK komposit)
SELECT test.expect_error('T04 encounter tenant A merujuk pasien tenant B',
  $q$INSERT INTO encounter(tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, arrival_type)
     VALUES (app.current_tenant_id(), 'KJ-X', test.id('b',60), test.id('a',10), test.id('a',11), test.id('a',20), 'WALK_IN')$q$,
  'foreign key');

-- T05: update/delete pada data tenant B tidak berefek (0 baris)
UPDATE patient SET full_name = 'DIRETAS' WHERE id = test.id('b',60);
-- queue_ticket tidak lagi boleh dihapus role aplikasi (migrasi 0017); uji pakai tabel yang masih boleh DELETE
DELETE FROM condition_dx WHERE tenant_id = 'bbbbbbbb-0000-0000-0000-000000000000';
RESET ROLE;
SELECT test.expect_eq('T05 nama pasien B setelah upaya update dari A',
  (SELECT full_name FROM patient WHERE id = test.id('b',60)), 'Pasien Uji b'::text);

-- ---------------------------------------------------------------------
\echo '--- T06 Cakupan RLS pada seluruh tabel tenant ---'
-- ---------------------------------------------------------------------
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_missing
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app'
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
   WHERE c.relkind IN ('r','p') AND NOT c.relispartition
     AND c.relname NOT IN ('tenant_subscription','tenant_status_history','tenant_feature_flag','support_access_grant','tenant_export_job')
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
          OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'));
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'FAIL T06 tabel tanpa RLS lengkap: %', v_missing; END IF;
  RAISE NOTICE 'PASS T06 semua tabel tenant memiliki RLS + FORCE + policy (% tabel)',
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='app'
      WHERE c.relrowsecurity AND c.relkind IN ('r','p'));
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('clinicrme_app','clinicrme_readonly','clinicrme_platform') AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'FAIL T06b role aplikasi memiliki BYPASSRLS/superuser';
  END IF;
  RAISE NOTICE 'PASS T06b role aplikasi tanpa BYPASSRLS';
END $$;

-- ---------------------------------------------------------------------
\echo '--- T07–T09 Immutability rekam medis (ADR-0006, AC-CLN-FR-017-2) ---'
-- ---------------------------------------------------------------------
SET ROLE clinicrme_app;
SET app.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000000';
INSERT INTO condition_dx(tenant_id, encounter_id, concept_id, rank)
  VALUES (app.current_tenant_id(), test.id('a',70), 'c1000000-0000-0000-0000-000000000001', 'PRIMER');
SELECT test.expect_error('T07 dua diagnosis primer pada satu kunjungan',
  $q$INSERT INTO condition_dx(tenant_id, encounter_id, concept_id, rank)
     VALUES (app.current_tenant_id(), test.id('a',70), 'c1000000-0000-0000-0000-000000000002', 'PRIMER')$q$, 'unique');
SELECT test.expect_error('T07b sahkan tanpa signed_by/hash',
  $q$UPDATE clinical_note SET status = 'SIGNED' WHERE id = test.id('a',71)$q$, 'check');
UPDATE clinical_note SET status = 'SIGNED', signed_by = test.id('a',20), signed_at = now(), content_hash = 'abc', signer_user_id = test.id('a',21), sign_method = 'PASSWORD'
 WHERE id = test.id('a',71);
SELECT test.expect_error('T08 ubah SOAP setelah disahkan',
  $q$UPDATE clinical_note SET assessment = 'diubah' WHERE id = test.id('a',71)$q$, 'IMMUTABLE');
SELECT test.expect_error('T08b hapus catatan yang disahkan',
  $q$DELETE FROM clinical_note WHERE id = test.id('a',71)$q$, 'IMMUTABLE|permission denied');   -- sejak 0019 DELETE juga dicabut dari role aplikasi
SELECT test.expect_error('T08c tambah diagnosis setelah disahkan',
  $q$INSERT INTO condition_dx(tenant_id, encounter_id, concept_id, rank)
     VALUES (app.current_tenant_id(), test.id('a',70), 'c1000000-0000-0000-0000-000000000002', 'SEKUNDER')$q$, 'IMMUTABLE');
SELECT test.expect_error('T08d ubah diagnosis setelah disahkan',
  $q$UPDATE condition_dx SET note = 'x' WHERE encounter_id = test.id('a',70)$q$, 'IMMUTABLE');
INSERT INTO clinical_addendum(tenant_id, note_id, reason, content, author_id, content_hash)
  VALUES (app.current_tenant_id(), test.id('a',71), 'Koreksi suhu', 'Suhu 38,5 bukan 37,5', test.id('a',20), 'h');
SELECT test.expect_error('T09 ubah addendum',
  $q$UPDATE clinical_addendum SET content = 'x'$q$, 'permission denied|IMMUTABLE');
RESET ROLE;

-- ---------------------------------------------------------------------
\echo '--- T10–T13 Farmasi & stok (PHM-FR-004/012/013) ---'
-- ---------------------------------------------------------------------
SET ROLE clinicrme_app;
SET app.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000000';
INSERT INTO stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id)
  VALUES (app.current_tenant_id(), test.id('a',51), test.id('a',50), 'RECEIPT', 100, 'GOODS_RECEIPT', gen_random_uuid()),
         (app.current_tenant_id(), test.id('a',52), test.id('a',50), 'RECEIPT', 10,  'GOODS_RECEIPT', gen_random_uuid());
INSERT INTO stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id)
  VALUES (app.current_tenant_id(), test.id('a',51), test.id('a',50), 'DISPENSE', -30, 'DISPENSE', gen_random_uuid());
SELECT test.expect_eq('T10 saldo batch setelah terima 100 & keluar 30',
  (SELECT qty_on_hand FROM stock_balance WHERE batch_id = test.id('a',51)), 70.0000::numeric);
SELECT test.expect_eq('T10b saldo = jumlah ledger',
  (SELECT sum(qty) FROM stock_movement WHERE batch_id = test.id('a',51)),
  (SELECT qty_on_hand FROM stock_balance WHERE batch_id = test.id('a',51)));
SELECT test.expect_error('T11 keluarkan melebihi saldo (stok negatif)',
  $q$INSERT INTO stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id)
     VALUES (app.current_tenant_id(), test.id('a',51), test.id('a',50), 'DISPENSE', -71, 'DISPENSE', gen_random_uuid())$q$, 'check');
SELECT test.expect_error('T11b dispensing batch kedaluwarsa',
  $q$INSERT INTO stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id)
     VALUES (app.current_tenant_id(), test.id('a',52), test.id('a',50), 'DISPENSE', -1, 'DISPENSE', gen_random_uuid())$q$, 'kedaluwarsa');
SELECT test.expect_error('T12 ubah ledger stok',
  $q$UPDATE stock_movement SET qty = 1000$q$, 'permission denied|IMMUTABLE');
SELECT test.expect_error('T12b tulis saldo stok langsung',
  $q$UPDATE stock_balance SET qty_on_hand = 9999$q$, 'permission denied');
INSERT INTO otc_sale(id, tenant_id, sale_no, branch_id, location_id, sold_by)
  VALUES (test.id('a',90), app.current_tenant_id(), 'OTC-1', test.id('a',10), test.id('a',50), test.id('a',22));
INSERT INTO otc_sale_line(tenant_id, otc_sale_id, drug_item_id, batch_id, qty_base, unit_price)
  VALUES (app.current_tenant_id(), test.id('a',90), test.id('a',41), test.id('a',51), 10, 1000);
SELECT test.expect_error('T13 jual obat keras tanpa resep',
  $q$INSERT INTO otc_sale_line(tenant_id, otc_sale_id, drug_item_id, batch_id, qty_base, unit_price)
     VALUES (app.current_tenant_id(), test.id('a',90), test.id('a',42), test.id('a',51), 1, 1000)$q$, 'tanpa resep');
RESET ROLE;

-- ---------------------------------------------------------------------
\echo '--- T14–T18 Billing (BIL-FR-002/006/009/010) ---'
-- ---------------------------------------------------------------------
SET ROLE clinicrme_app;
SET app.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000000';
INSERT INTO invoice(id, tenant_id, branch_id, patient_id, encounter_id) VALUES
  (test.id('a',100), app.current_tenant_id(), test.id('a',10), test.id('a',60), test.id('a',70));
INSERT INTO invoice_line(tenant_id, invoice_id, line_no, source_type, description, qty, unit_price, line_total, patient_portion)
  VALUES (app.current_tenant_id(), test.id('a',100), 1, 'KONSULTASI', 'Konsultasi', 1, 50000, 50000, 50000);
SELECT test.expect_error('T14 baris dengan total salah hitung',
  $q$INSERT INTO invoice_line(tenant_id, invoice_id, line_no, source_type, description, qty, unit_price, line_total, patient_portion)
     VALUES (app.current_tenant_id(), test.id('a',100), 2, 'OBAT', 'Obat', 2, 1000, 1500, 1500)$q$, 'check');
UPDATE invoice SET status = 'ISSUED', invoice_no = app.next_document_number('INVOICE','2026','INV/{YYYY}/{SEQ:5}'),
       issued_at = now(), gross_amount = 50000, net_amount = 50000, patient_portion = 50000
 WHERE id = test.id('a',100);
SELECT test.expect_eq('T14b format nomor invoice',
  (SELECT invoice_no ~ '^INV/\d{4}/00001$' FROM invoice WHERE id = test.id('a',100)), true);
SELECT test.expect_error('T15 ubah nominal invoice yang sudah diterbitkan',
  $q$UPDATE invoice SET gross_amount = 1, net_amount = 1, patient_portion = 1 WHERE id = test.id('a',100)$q$, 'IMMUTABLE');
SELECT test.expect_error('T15b tambah baris ke invoice terbit',
  $q$INSERT INTO invoice_line(tenant_id, invoice_id, line_no, source_type, description, qty, unit_price, line_total, patient_portion)
     VALUES (app.current_tenant_id(), test.id('a',100), 3, 'LAINNYA', 'x', 1, 1, 1, 1)$q$, 'IMMUTABLE');
INSERT INTO payment(id, tenant_id, receipt_no, invoice_id, shift_id, method, amount, reference, idempotency_key, received_by)
  VALUES (test.id('a',110), app.current_tenant_id(), 'KW-1', test.id('a',100), test.id('a',80), 'QRIS', 50000, 'QR-REF-1', 'idem-1', test.id('a',22));
SELECT test.expect_error('T16 pembayaran ganda dengan idempotency key sama',
  $q$INSERT INTO payment(tenant_id, receipt_no, invoice_id, shift_id, method, amount, reference, idempotency_key, received_by)
     VALUES (app.current_tenant_id(), 'KW-2', test.id('a',100), test.id('a',80), 'QRIS', 50000, 'QR-REF-1', 'idem-1', test.id('a',22))$q$, 'unique');
SELECT test.expect_error('T16b ubah pembayaran',
  $q$UPDATE payment SET amount = 1$q$, 'permission denied|IMMUTABLE');
UPDATE invoice SET status = 'PAID', paid_amount = 50000 WHERE id = test.id('a',100);
SELECT test.expect_error('T17 void invoice yang sudah dibayar',
  $q$UPDATE invoice SET status = 'VOID' WHERE id = test.id('a',100)$q$, 'tidak valid|refund');
INSERT INTO refund(id, tenant_id, refund_no, payment_id, amount, reason, method, requested_by)
  VALUES (test.id('a',120), app.current_tenant_id(), 'RF-1', test.id('a',110), 10000, 'Salah tagih', 'TUNAI', test.id('a',22));
SELECT test.expect_error('T18 refund disetujui oleh pengaju sendiri',
  $q$UPDATE refund SET status = 'APPROVED', approved_by = test.id('a',22), decided_at = now() WHERE id = test.id('a',120)$q$, 'check');
UPDATE refund SET status = 'APPROVED', approved_by = test.id('a',23), decided_at = now() WHERE id = test.id('a',120);
SELECT test.expect_error('T18b ubah refund yang sudah disetujui',
  $q$UPDATE refund SET amount = 50000 WHERE id = test.id('a',120)$q$, 'IMMUTABLE');
RESET ROLE;

-- ---------------------------------------------------------------------
\echo '--- T19 Tarif tidak tumpang tindih (AC-MST-FR-005-1) ---'
-- ---------------------------------------------------------------------
SET ROLE clinicrme_app;
SET app.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000000';
INSERT INTO tariff(tenant_id, service_item_id, payer_type, price, valid_from, valid_to)
  VALUES (app.current_tenant_id(), test.id('a',31), 'UMUM', 50000, '2026-01-01', '2026-12-31');
SELECT test.expect_error('T19 periode tarif tumpang tindih',
  $q$INSERT INTO tariff(tenant_id, service_item_id, payer_type, price, valid_from)
     VALUES (app.current_tenant_id(), test.id('a',31), 'UMUM', 60000, '2026-06-01')$q$, 'conflicting|exclusion');
INSERT INTO tariff(tenant_id, service_item_id, payer_type, price, valid_from)
  VALUES (app.current_tenant_id(), test.id('a',31), 'UMUM', 60000, '2027-01-01');
RESET ROLE;

-- ---------------------------------------------------------------------
\echo '--- T20–T22 Audit hash chain (ADR-0007, AC-AUD-FR-003) ---'
-- ---------------------------------------------------------------------
SET ROLE clinicrme_app;
SET app.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000000';
SET app.user_id = 'aaaaaaaa-0000-0000-0000-000000000021';
SELECT app.write_audit('READ', 'encounter', test.id('a',70), test.id('a',60));
SELECT app.write_audit('SIGN', 'clinical_note', test.id('a',71), test.id('a',60));
SELECT app.write_audit('CREATE', 'payment', test.id('a',110), test.id('a',60), '{"amount":50000}');
SELECT test.expect_error('T20 app menulis audit_log langsung',
  $q$INSERT INTO audit_log(tenant_id, seq, action, resource_type, prev_hash, hash) VALUES (app.current_tenant_id(), 99, 'X', 'X', 'x', 'x')$q$,
  'permission denied');
SELECT test.expect_error('T20b app mengubah audit_log',
  $q$UPDATE audit_log SET action = 'X'$q$, 'permission denied');
SELECT test.expect_eq('T20c entri audit terlihat untuk tenant A', (SELECT count(*) FROM audit_log), 3::bigint);
SET app.tenant_id = 'bbbbbbbb-0000-0000-0000-000000000000';
SELECT test.expect_eq('T20d entri audit tenant A tidak terlihat dari B', (SELECT count(*) FROM audit_log), 0::bigint);
RESET ROLE;

SELECT test.expect_eq('T21 verifikasi chain utuh',
  (SELECT ok FROM app.verify_audit_chain('aaaaaaaa-0000-0000-0000-000000000000')), true);

-- Simulasi manipulasi oleh pihak dengan akses superuser
ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_immutable;
UPDATE audit_log SET action = 'DELETE' WHERE tenant_id = 'aaaaaaaa-0000-0000-0000-000000000000' AND seq = 2;
ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_immutable;
SELECT test.expect_eq('T22 manipulasi audit terdeteksi pada seq',
  (SELECT first_bad_seq FROM app.verify_audit_chain('aaaaaaaa-0000-0000-0000-000000000000')), 2::bigint);

-- ---------------------------------------------------------------------
\echo '--- T23–T24 Role template & segregation of duties (IAM-FR-007, BIL-FR-010) ---'
-- ---------------------------------------------------------------------
SET ROLE clinicrme_app;
SET app.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000000';
SELECT app.create_template_roles();
SELECT app.create_template_roles();
SELECT test.expect_eq('T23 role template terbentuk (idempoten)', (SELECT count(*) FROM role WHERE is_template), 8::bigint);
SELECT test.expect_eq('T23b role admin, manajer, auditor & dokter (DEC-019, migrasi 0008) wajib MFA',
  (SELECT string_agg(code, ',' ORDER BY code) FROM role WHERE requires_mfa), 'AUDITOR,DOKTER,MANAJER,TENANT_ADMIN'::text);
SELECT test.expect_eq('T24 tidak ada role template yang bisa mengajukan & menyetujui refund/void/penyesuaian',
  (SELECT count(*) FROM role r WHERE r.is_template AND (
     (EXISTS (SELECT 1 FROM role_permission WHERE role_id=r.id AND permission_code='billing.refund.request')
      AND EXISTS (SELECT 1 FROM role_permission WHERE role_id=r.id AND permission_code='billing.refund.approve'))
  OR (EXISTS (SELECT 1 FROM role_permission WHERE role_id=r.id AND permission_code='billing.invoice.void.request')
      AND EXISTS (SELECT 1 FROM role_permission WHERE role_id=r.id AND permission_code='billing.invoice.void.approve'))
  OR (EXISTS (SELECT 1 FROM role_permission WHERE role_id=r.id AND permission_code='pharmacy.stock.adjust')
      AND EXISTS (SELECT 1 FROM role_permission WHERE role_id=r.id AND permission_code='pharmacy.stock.approve')))), 0::bigint);
SET app.tenant_id = 'bbbbbbbb-0000-0000-0000-000000000000';
SELECT test.expect_eq('T24b role tenant A tidak terlihat dari B', (SELECT count(*) FROM role), 0::bigint);
RESET ROLE;

\echo '=== SEMUA UJI LULUS ==='
