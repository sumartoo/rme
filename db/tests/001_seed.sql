-- Seed data sintetis untuk uji keamanan skema (dijalankan sebagai owner).
SET search_path = app, public;

CREATE SCHEMA IF NOT EXISTS test;
GRANT USAGE ON SCHEMA test TO clinicrme_app;

-- Helper: jalankan SQL dan pastikan GAGAL (dengan pola pesan opsional)
CREATE OR REPLACE FUNCTION test.expect_error(p_label text, p_sql text, p_pattern text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF p_pattern IS NOT NULL AND SQLERRM !~* p_pattern THEN
      RAISE EXCEPTION 'FAIL % — error tak terduga: %', p_label, SQLERRM;
    END IF;
    RAISE NOTICE 'PASS %  (ditolak: %)', p_label, left(SQLERRM, 90);
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL % — perintah seharusnya ditolak', p_label;
END $$;

CREATE OR REPLACE FUNCTION test.expect_eq(p_label text, p_actual anyelement, p_expected anyelement)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'FAIL % — dapat %, harap %', p_label, p_actual, p_expected;
  END IF;
  RAISE NOTICE 'PASS %  (= %)', p_label, p_actual;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA test TO clinicrme_app;

-- Data global
INSERT INTO code_system(id, code, version, source, is_current)
VALUES ('c0000000-0000-0000-0000-000000000001','ICD10','2010-ID','Data uji sintetis', true);
INSERT INTO concept(id, system_id, code, display_id) VALUES
 ('c1000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001','R50.9','Demam, tidak spesifik'),
 ('c1000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000001','J06.9','ISPA akut, tidak spesifik');

-- Dua tenant: A dan B
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
     ('a','aaaaaaaa-0000-0000-0000-000000000000'::uuid,'klinik-a'),
     ('b','bbbbbbbb-0000-0000-0000-000000000000'::uuid,'klinik-b')) v(k, tid, code)
  LOOP
    INSERT INTO tenant(id, code, legal_name, display_name, tenant_type, status)
      VALUES (t.tid, t.code, 'PT '||t.code, t.code, 'KLINIK_PRATAMA', 'ACTIVE');
    INSERT INTO facility(id, tenant_id, name, facility_type)
      VALUES (overlay(t.tid::text placing '0001' from 33)::uuid, t.tid, 'Fasilitas '||t.k, 'KLINIK_PRATAMA');
  END LOOP;
END $$;

-- Data per tenant (ID berpola <prefix>...-<suffix>)
CREATE OR REPLACE FUNCTION test.id(p_tenant char, p_n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT (repeat(p_tenant, 8) || '-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
GRANT EXECUTE ON FUNCTION test.id(char, int) TO clinicrme_app;

DO $$
DECLARE k char; tid uuid;
BEGIN
  FOREACH k IN ARRAY ARRAY['a','b'] LOOP
    tid := test.id(k, 0);
    INSERT INTO branch(id, tenant_id, facility_id, code, name) VALUES (test.id(k,10), tid, test.id(k,1), 'CBG1', 'Cabang 1');
    INSERT INTO service_unit(id, tenant_id, branch_id, code, name, unit_type) VALUES (test.id(k,11), tid, test.id(k,10), 'UMUM', 'Poli Umum', 'POLI');
    INSERT INTO practitioner(id, tenant_id, full_name, practitioner_type) VALUES (test.id(k,20), tid, 'dr. Uji '||k, 'DOKTER');
    INSERT INTO app_user(id, tenant_id, email, full_name, practitioner_id) VALUES (test.id(k,21), tid, 'dokter@'||k||'.test', 'dr. Uji', test.id(k,20));
    INSERT INTO app_user(id, tenant_id, email, full_name) VALUES (test.id(k,22), tid, 'kasir@'||k||'.test', 'Kasir');
    INSERT INTO app_user(id, tenant_id, email, full_name) VALUES (test.id(k,23), tid, 'manajer@'||k||'.test', 'Manajer');
    INSERT INTO payer(id, tenant_id, code, name, payer_type) VALUES (test.id(k,30), tid, 'UMUM', 'Umum', 'UMUM');
    INSERT INTO service_item(id, tenant_id, code, name, service_type) VALUES (test.id(k,31), tid, 'KONS', 'Konsultasi Umum', 'KONSULTASI');
    INSERT INTO uom(id, tenant_id, code, name) VALUES (test.id(k,40), tid, 'TAB', 'Tablet');
    INSERT INTO drug_item(id, tenant_id, code, generic_name, dosage_form, base_uom_id, drug_class, ingredients)
      VALUES (test.id(k,41), tid, 'PCT500', 'Parasetamol 500 mg', 'Tablet', test.id(k,40), 'BEBAS', ARRAY['parasetamol']),
             (test.id(k,42), tid, 'AMX500', 'Amoksisilin 500 mg', 'Kapsul', test.id(k,40), 'KERAS', ARRAY['amoksisilin']);
    INSERT INTO stock_location(id, tenant_id, branch_id, name) VALUES (test.id(k,50), tid, test.id(k,10), 'Apotek');
    INSERT INTO stock_batch(id, tenant_id, drug_item_id, batch_no, expiry_date, unit_cost)
      VALUES (test.id(k,51), tid, test.id(k,41), 'B-OK', current_date + 365, 200),
             (test.id(k,52), tid, test.id(k,41), 'B-EXP', current_date - 1, 200);
    INSERT INTO patient(id, tenant_id, mrn, full_name, birth_date, sex, identity_type, nik_encrypted, nik_hash)
      VALUES (test.id(k,60), tid, 'RM-'||k||'-0001', 'Pasien Uji '||k, '1990-01-01', 'L', 'NIK', '\x00', 'hash-'||k);
    INSERT INTO encounter(id, tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, arrival_type, status)
      VALUES (test.id(k,70), tid, 'KJ-'||k||'-0001', test.id(k,60), test.id(k,10), test.id(k,11), test.id(k,20), 'WALK_IN', 'IN_CONSULTATION');
    INSERT INTO clinical_note(id, tenant_id, encounter_id, subjective, assessment)
      VALUES (test.id(k,71), tid, test.id(k,70), 'Demam 2 hari', 'Febris');
    INSERT INTO cashier_shift(id, tenant_id, branch_id, cashier_id, opening_cash)
      VALUES (test.id(k,80), tid, test.id(k,10), test.id(k,22), 100000);
  END LOOP;
END $$;
