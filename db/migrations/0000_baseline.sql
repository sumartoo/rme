-- ClinicRME — migrasi 0000: baseline skema Stage 2–3.
-- Dibangkitkan SEKALI dari db/schema/*.sql (tools/build_baseline_migration.py). Jangan diedit: migrasi yang sudah
-- diterapkan bersifat immutable; perubahan skema selanjutnya = migrasi baru (CODING_STANDARDS §Database).

-- ===== 000_foundation.sql =====
-- =====================================================================
-- ClinicRME — 000 Foundation: roles, schema, helper functions
-- ADR-0002 (RLS), ADR-0006 (immutability)
-- Dijalankan oleh role owner (clinicrme_owner) pada database kosong.
-- =====================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicrme_app') THEN
    CREATE ROLE clinicrme_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicrme_platform') THEN
    CREATE ROLE clinicrme_platform NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicrme_readonly') THEN
    CREATE ROLE clinicrme_readonly NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS app;
COMMENT ON SCHEMA app IS 'Skema aplikasi ClinicRME';

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO clinicrme_app, clinicrme_platform, clinicrme_readonly;

SET search_path = app, public;

-- ---------------------------------------------------------------------
-- Tenant context
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;
COMMENT ON FUNCTION app.current_tenant_id() IS
  'Tenant aktif dari SET LOCAL app.tenant_id. NULL bila tidak di-set → RLS menolak semua baris (fail-closed).';

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------
-- Kolom standar: updated_at & version otomatis
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := COALESCE(app.current_user_id(), NEW.updated_by);
  NEW.version    := OLD.version + 1;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- Penolakan generik untuk tabel append-only (ADR-0006)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.reject_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE: % pada % tidak diizinkan', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;

-- ---------------------------------------------------------------------
-- Helper untuk mendaftarkan tabel tenant: RLS + policy + trigger touch
-- Dipanggil di 900_security.sql untuk setiap tabel ber-tenant_id.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.enable_tenant_rls(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', p_table);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s
       USING (tenant_id = app.current_tenant_id())
       WITH CHECK (tenant_id = app.current_tenant_id())', p_table);
END $$;

-- ===== 010_platform.sql =====
-- =====================================================================
-- 010 Platform & Tenant — Stage 5 (PLT-FR-*)
-- Tabel di modul ini adalah tabel PLATFORM: dikelola clinicrme_platform.
-- `tenant` juga dapat dibaca app untuk tenant aktif saja (policy khusus).
-- =====================================================================
SET search_path = app, public;

CREATE TABLE subscription_plan (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  max_users     int  NOT NULL CHECK (max_users > 0),
  max_branches  int  NOT NULL CHECK (max_branches > 0),
  features      jsonb NOT NULL DEFAULT '{}'::jsonb,
  monthly_price numeric(18,2) NOT NULL DEFAULT 0 CHECK (monthly_price >= 0),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE subscription_plan IS 'Paket langganan SaaS (PLT-FR-003)';
COMMENT ON COLUMN subscription_plan.features IS 'Fitur yang diaktifkan paket, mis. {"pharmacy":true,"lab":true}';

CREATE TABLE tenant (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]{3,40}$'),
  legal_name        text NOT NULL,
  display_name      text NOT NULL,
  tenant_type       text NOT NULL CHECK (tenant_type IN ('KLINIK_UTAMA','KLINIK_PRATAMA','PRAKTIK_MANDIRI')),
  status            text NOT NULL DEFAULT 'PROVISIONING'
                    CHECK (status IN ('PROVISIONING','TRIAL','ACTIVE','GRACE','SUSPENDED','TERMINATED')),
  timezone          text NOT NULL DEFAULT 'Asia/Jakarta',
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,
  logo_file_id      uuid,
  letterhead        jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  version           int NOT NULL DEFAULT 1
);
COMMENT ON TABLE tenant IS 'Pelanggan SaaS: klinik utama, klinik pratama, atau praktik mandiri (PLT-FR-001/002/005)';
COMMENT ON COLUMN tenant.settings IS 'Konfigurasi tenant: alur farmasi/kasir (DEC-013), batas diskon, lockout, toleransi no-show, dll.';
COMMENT ON COLUMN tenant.letterhead IS 'Kop surat: nama, alamat, telepon, izin (PLT-FR-007)';

CREATE TABLE tenant_subscription (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  plan_id        uuid NOT NULL REFERENCES subscription_plan(id),
  start_at       timestamptz NOT NULL,
  end_at         timestamptz,
  trial_end_at   timestamptz,
  is_current     boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_tenant_subscription_current ON tenant_subscription(tenant_id) WHERE is_current;
COMMENT ON TABLE tenant_subscription IS 'Riwayat langganan; tepat satu baris is_current per tenant';

CREATE TABLE tenant_status_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  from_status  text,
  to_status    text NOT NULL,
  reason       text NOT NULL CHECK (length(trim(reason)) > 0),
  actor_id     uuid,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE tenant_status_history IS 'Histori perubahan status tenant beserta alasan (AC-PLT-FR-005-1)';

CREATE TABLE tenant_feature_flag (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  feature_code  text NOT NULL,
  enabled       boolean NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_code)
);
COMMENT ON TABLE tenant_feature_flag IS 'Feature flag per tenant untuk rilis bertahap (PLT-FR-011)';

CREATE TABLE support_access_grant (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  platform_user   uuid NOT NULL,
  reason          text NOT NULL CHECK (length(trim(reason)) > 10),
  starts_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  CHECK (expires_at > starts_at AND expires_at <= starts_at + interval '8 hours')
);
COMMENT ON TABLE support_access_grant IS 'Break-glass akses dukungan: beralasan, maks. 8 jam, teraudit (PLT-FR-009)';

CREATE TABLE tenant_export_job (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  requested_by  uuid NOT NULL,
  status        text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED','EXPIRED')),
  file_id       uuid,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
COMMENT ON TABLE tenant_export_job IS 'Permintaan ekspor seluruh data tenant (PLT-FR-008)';

-- ===== 020_iam.sql =====
-- =====================================================================
-- 020 Identity & Access — Stage 3, 6 (IAM-FR-*), ADR-0003
-- Konvensi tabel tenant: kolom tenant_id, UNIQUE (tenant_id, id), FK komposit
-- (tenant_id, x_id) agar referensi lintas tenant mustahil (ADR-0002).
-- =====================================================================
SET search_path = app, public;

-- Global: daftar permission dikelola sistem
CREATE TABLE permission (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z]+(\.[a-z_]+)+$'),
  module       text NOT NULL,
  description  text NOT NULL
);
COMMENT ON TABLE permission IS 'Daftar permission global, format <modul>.<resource>.<aksi> (IAM-FR-008)';

-- Global: definisi menu
CREATE TABLE menu_item (
  code                 text PRIMARY KEY,
  parent_code          text REFERENCES menu_item(code),
  label                text NOT NULL,
  route                text,
  icon                 text,
  required_permission  text REFERENCES permission(code),
  sort_order           int NOT NULL DEFAULT 0
);
COMMENT ON TABLE menu_item IS 'Definisi menu sidebar; ditampilkan sesuai permission efektif (IAM-FR-010)';

CREATE TABLE app_user (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  email            text NOT NULL,
  full_name        text NOT NULL,
  phone            text,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  practitioner_id  uuid,
  mfa_required     boolean NOT NULL DEFAULT false,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email)
);
COMMENT ON TABLE app_user IS 'Akun staf klinik; hanya dibuat dari undangan (IAM-FR-001)';
COMMENT ON COLUMN app_user.practitioner_id IS 'Tautan ke tenaga kesehatan untuk tanda tangan klinis (IAM-FR-016)';

CREATE TABLE user_identity (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  user_id        uuid NOT NULL,
  provider       text NOT NULL CHECK (provider IN ('google','password')),
  subject        text NOT NULL,
  email_at_link  text,
  linked_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id),
  UNIQUE (tenant_id, provider, subject)
);
COMMENT ON TABLE user_identity IS 'Identitas login per provider; Google dikunci pada claim sub (IAM-FR-002, ADR-0003)';

CREATE TABLE user_credential (
  tenant_id            uuid NOT NULL,
  user_id              uuid NOT NULL,
  password_hash        text NOT NULL,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  failed_attempts      int NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id)
);
COMMENT ON TABLE user_credential IS 'Password Argon2id & status lockout (IAM-FR-003)';

CREATE TABLE user_mfa (
  tenant_id              uuid NOT NULL,
  user_id                uuid NOT NULL,
  totp_secret_encrypted  bytea NOT NULL,
  recovery_codes_hash    text[] NOT NULL DEFAULT '{}',
  enabled_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id)
);
COMMENT ON TABLE user_mfa IS 'TOTP terenkripsi & hash recovery code (IAM-FR-005)';

CREATE TABLE user_invitation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  email        text NOT NULL,
  role_ids     uuid[] NOT NULL,
  branch_ids   uuid[] NOT NULL DEFAULT '{}',
  token_hash   text NOT NULL UNIQUE,
  invited_by   uuid,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_user_id uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
COMMENT ON TABLE user_invitation IS 'Undangan user, default berlaku 7 hari (AC-IAM-FR-001-2)';

CREATE TABLE role (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  code         text NOT NULL,
  name         text NOT NULL,
  is_template  boolean NOT NULL DEFAULT false,
  requires_mfa boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid,
  version      int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
COMMENT ON TABLE role IS 'Role tenant; template bawaan + custom (IAM-FR-007/008)';

CREATE TABLE role_permission (
  tenant_id        uuid NOT NULL,
  role_id          uuid NOT NULL,
  permission_code  text NOT NULL REFERENCES permission(code),
  PRIMARY KEY (tenant_id, role_id, permission_code),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE user_role_assignment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  role_id     uuid NOT NULL,
  branch_id   uuid,
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role(tenant_id, id)
);
COMMENT ON TABLE user_role_assignment IS 'Penugasan role ke user, opsional per cabang (NULL = semua cabang) (IAM-FR-009)';
COMMENT ON COLUMN user_role_assignment.branch_id IS 'FK ke branch ditambahkan di 040_masterdata.sql';

CREATE TABLE user_session (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  user_id        uuid NOT NULL,
  branch_id      uuid,
  mfa_verified   boolean NOT NULL DEFAULT false,
  ip             inet,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoke_reason  text,
  token_hash     text NOT NULL UNIQUE,
  mfa_failed_attempts int NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id)
);
COMMENT ON COLUMN user_session.token_hash IS 'SHA-256 dari token sesi 256-bit di cookie; token mentah tidak pernah disimpan (SC-AUTH-06)';
COMMENT ON COLUMN user_session.mfa_failed_attempts IS 'Kode MFA salah pada sesi ini; mencapai batas → sesi dicabut (SC-AUTH-05)';
CREATE INDEX ix_user_session_active ON user_session(tenant_id, user_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE user_session IS 'Sesi login; dicabut saat user dinonaktifkan (IAM-FR-013/014)';

COMMENT ON TABLE role_permission IS 'Permission yang dimiliki role';

-- ===== 025_auth_functions.sql =====
-- =====================================================================
-- 025 Fungsi pra-autentikasi — Stage 3 (ADR-0003, SC-AUTH-06, SC-TEN-01)
-- Sebelum sesi diketahui, aplikasi belum punya tenant context sehingga RLS
-- menolak semua baris. Dua fungsi SECURITY DEFINER berikut membuka jalan
-- SEMPIT: hanya mengembalikan kolom minimum yang diperlukan.
-- =====================================================================
SET search_path = app, public;

-- Tenant dari subdomain (kode tenant). Hanya id & status.
CREATE OR REPLACE FUNCTION app.resolve_tenant(p_code text)
RETURNS TABLE(tenant_id uuid, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public AS $$
  SELECT id, status FROM tenant WHERE code = lower(p_code)
$$;
COMMENT ON FUNCTION app.resolve_tenant(text) IS 'Pra-auth: kode subdomain → tenant_id (tanpa data lain)';

-- Sesi dari hash token. Mengembalikan status sesi & user; pemanggil WAJIB
-- mencocokkan tenant_id dengan tenant dari subdomain.
CREATE OR REPLACE FUNCTION app.resolve_session(p_token_hash text)
RETURNS TABLE(session_id uuid, tenant_id uuid, user_id uuid, branch_id uuid, mfa_verified boolean,
              last_seen_at timestamptz, expires_at timestamptz, revoked_at timestamptz, user_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public AS $$
  SELECT s.id, s.tenant_id, s.user_id, s.branch_id, s.mfa_verified, s.last_seen_at, s.expires_at, s.revoked_at, u.status
    FROM user_session s JOIN app_user u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
   WHERE s.token_hash = p_token_hash
$$;
COMMENT ON FUNCTION app.resolve_session(text) IS 'Pra-auth: hash token sesi → konteks sesi (SC-AUTH-06)';

-- ===== 030_audit.sql =====
-- =====================================================================
-- 030 Audit — Stage 3 (AUD-FR-*), ADR-0007
-- audit_log: partisi bulanan, append-only, hash chain per tenant.
-- App hanya menulis melalui app.write_audit() (SECURITY DEFINER).
-- =====================================================================
SET search_path = app, public;

CREATE TABLE audit_chain_head (
  tenant_id  uuid PRIMARY KEY REFERENCES tenant(id),
  last_seq   bigint NOT NULL DEFAULT 0,
  last_hash  text   NOT NULL DEFAULT repeat('0', 64)
);
COMMENT ON TABLE audit_chain_head IS 'Kepala hash chain audit per tenant; hanya diubah oleh app.write_audit()';

CREATE TABLE audit_log (
  tenant_id       uuid NOT NULL,
  seq             bigint NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid,
  actor_kind      text NOT NULL DEFAULT 'USER' CHECK (actor_kind IN ('USER','SYSTEM','PLATFORM_SUPPORT')),
  on_behalf_of    uuid,
  action          text NOT NULL,
  resource_type   text NOT NULL,
  resource_id     uuid,
  patient_id      uuid,
  ip              inet,
  user_agent      text,
  request_id      text,
  change_summary  jsonb,
  prev_hash       text NOT NULL,
  hash            text NOT NULL,
  PRIMARY KEY (tenant_id, seq, occurred_at)
) PARTITION BY RANGE (occurred_at);
COMMENT ON TABLE audit_log IS 'Audit append-only berantai hash (AUD-FR-001..003). Tanpa PHI mentah.';
COMMENT ON COLUMN audit_log.action IS 'CREATE, UPDATE, READ, SIGN, ADDENDUM, VOID, REFUND, EXPORT, LOGIN, LOGIN_FAILED, LOGOUT, PERMISSION_CHANGE, ...';
COMMENT ON COLUMN audit_log.patient_id IS 'Diisi untuk aksi terkait pasien agar pencarian "siapa mengakses RM pasien X" cepat (AUD-FR-002/004)';
COMMENT ON COLUMN audit_log.hash IS 'sha256(prev_hash || representasi kanonik entri)';

CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
CREATE INDEX ix_audit_patient ON audit_log (tenant_id, patient_id, occurred_at) WHERE patient_id IS NOT NULL;
CREATE INDEX ix_audit_actor   ON audit_log (tenant_id, actor_user_id, occurred_at);

-- Partisi bulanan dibuat oleh job (Stage 4). Contoh:
-- CREATE TABLE audit_log_2026_11 PARTITION OF audit_log FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

CREATE OR REPLACE FUNCTION app.audit_canonical(
  p_tenant uuid, p_seq bigint, p_at timestamptz, p_actor uuid, p_action text,
  p_rtype text, p_rid uuid, p_patient uuid, p_summary jsonb
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|', p_tenant, p_seq, to_char(p_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),
                   coalesce(p_actor::text,''), p_action, p_rtype, coalesce(p_rid::text,''),
                   coalesce(p_patient::text,''), coalesce(p_summary::text,''))
$$;

CREATE OR REPLACE FUNCTION app.write_audit(
  p_action text, p_resource_type text, p_resource_id uuid,
  p_patient_id uuid DEFAULT NULL, p_change_summary jsonb DEFAULT NULL,
  p_actor_kind text DEFAULT 'USER', p_ip inet DEFAULT NULL, p_request_id text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_actor  uuid := app.current_user_id();
  v_seq    bigint;
  v_prev   text;
  v_at     timestamptz := clock_timestamp();
  v_hash   text;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'AUDIT: tenant context belum di-set';
  END IF;
  INSERT INTO audit_chain_head(tenant_id) VALUES (v_tenant) ON CONFLICT DO NOTHING;
  SELECT last_seq + 1, last_hash INTO v_seq, v_prev
    FROM audit_chain_head WHERE tenant_id = v_tenant FOR UPDATE;
  v_hash := encode(sha256(convert_to(v_prev || app.audit_canonical(
              v_tenant, v_seq, v_at, v_actor, p_action, p_resource_type,
              p_resource_id, p_patient_id, p_change_summary), 'UTF8')), 'hex');
  INSERT INTO audit_log(tenant_id, seq, occurred_at, actor_user_id, actor_kind, action,
                        resource_type, resource_id, patient_id, ip, request_id,
                        change_summary, prev_hash, hash)
  VALUES (v_tenant, v_seq, v_at, v_actor, p_actor_kind, p_action, p_resource_type,
          p_resource_id, p_patient_id, p_ip, p_request_id, p_change_summary, v_prev, v_hash);
  UPDATE audit_chain_head SET last_seq = v_seq, last_hash = v_hash WHERE tenant_id = v_tenant;
  RETURN v_seq;
END $$;
COMMENT ON FUNCTION app.write_audit IS 'Satu-satunya jalur menulis audit_log (ADR-0007)';

CREATE OR REPLACE FUNCTION app.verify_audit_chain(p_tenant uuid)
RETURNS TABLE(ok boolean, first_bad_seq bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $$
DECLARE r record; v_prev text := repeat('0',64); v_expected text;
BEGIN
  FOR r IN SELECT * FROM audit_log WHERE tenant_id = p_tenant ORDER BY seq LOOP
    v_expected := encode(sha256(convert_to(v_prev || app.audit_canonical(
      r.tenant_id, r.seq, r.occurred_at, r.actor_user_id, r.action, r.resource_type,
      r.resource_id, r.patient_id, r.change_summary), 'UTF8')), 'hex');
    IF r.prev_hash <> v_prev OR r.hash <> v_expected THEN
      ok := false; first_bad_seq := r.seq; RETURN NEXT; RETURN;
    END IF;
    v_prev := r.hash;
  END LOOP;
  ok := true; first_bad_seq := NULL; RETURN NEXT;
END $$;
COMMENT ON FUNCTION app.verify_audit_chain IS 'Verifikasi integritas chain per tenant (AC-AUD-FR-003-2)';

CREATE TRIGGER trg_audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.reject_modification();

-- ===== 040_masterdata.sql =====
-- =====================================================================
-- 040 Master Data — Stage 7 (MST-FR-*), ADR-0005 (penomoran)
-- =====================================================================
SET search_path = app, public;

-- Global: wilayah administratif (MST-FR-011, sumber OD-062)
CREATE TABLE region (
  code         text PRIMARY KEY,
  parent_code  text REFERENCES region(code),
  level        smallint NOT NULL CHECK (level BETWEEN 1 AND 4),
  name         text NOT NULL
);
COMMENT ON TABLE region IS 'Wilayah: 1 provinsi, 2 kab/kota, 3 kecamatan, 4 kelurahan/desa';

CREATE TABLE facility (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  name            text NOT NULL,
  facility_type   text NOT NULL CHECK (facility_type IN ('KLINIK_UTAMA','KLINIK_PRATAMA','PRAKTIK_MANDIRI')),
  license_number  text,
  satusehat_org_id text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);
COMMENT ON TABLE facility IS 'Fasilitas pelayanan kesehatan dalam tenant; padanan Organization SATUSEHAT';

CREATE TABLE branch (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  facility_id      uuid NOT NULL,
  code             text NOT NULL,
  name             text NOT NULL,
  address          text,
  region_code      text REFERENCES region(code),
  phone            text,
  timezone         text NOT NULL DEFAULT 'Asia/Jakarta' CHECK (timezone IN ('Asia/Jakarta','Asia/Makassar','Asia/Jayapura')),
  satusehat_location_id text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES facility(tenant_id, id)
);
COMMENT ON TABLE branch IS 'Cabang / lokasi pelayanan; zona waktu menentukan tampilan waktu (AC-GEN-FR-005-2)';

ALTER TABLE user_role_assignment
  ADD FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id);
ALTER TABLE user_session
  ADD FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id);

CREATE TABLE service_unit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  branch_id   uuid NOT NULL,
  code        text NOT NULL,
  name        text NOT NULL,
  unit_type   text NOT NULL CHECK (unit_type IN ('POLI','RUANG','FARMASI','KASIR','LAB','LAINNYA')),
  specialty   text,
  default_template text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,
  version     int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, branch_id, code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id)
);
COMMENT ON TABLE service_unit IS 'Poli, ruang layanan, lokasi farmasi, kasir, lab (MST-FR-001)';

CREATE TABLE practitioner (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  full_name            text NOT NULL,
  nik_encrypted        bytea,
  nik_hash             text,
  practitioner_type    text NOT NULL CHECK (practitioner_type IN ('DOKTER','DOKTER_GIGI','DOKTER_SPESIALIS','PERAWAT','BIDAN','APOTEKER','TTK','ANALIS','LAINNYA')),
  specialty            text,
  str_number           text,
  str_valid_until      date,
  sip_number           text,
  sip_valid_until      date,
  satusehat_ihs_id     text,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid,
  version              int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, nik_hash)
);
COMMENT ON TABLE practitioner IS 'Tenaga medis & tenaga kesehatan dengan STR/SIP (MST-FR-002)';
COMMENT ON COLUMN practitioner.nik_hash IS 'HMAC-SHA256 NIK dengan kunci per lingkungan; untuk pencarian & keunikan';

ALTER TABLE app_user
  ADD FOREIGN KEY (tenant_id, practitioner_id) REFERENCES practitioner(tenant_id, id);

CREATE TABLE payer (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  code          text NOT NULL,
  name          text NOT NULL,
  payer_type    text NOT NULL CHECK (payer_type IN ('UMUM','ASURANSI','PERUSAHAAN','BPJS')),
  contract      jsonb,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
COMMENT ON TABLE payer IS 'Penjamin: Umum, Asuransi, Perusahaan, BPJS (MST-FR-006, BPJ-FR-004)';
COMMENT ON COLUMN payer.contract IS 'Ketentuan kontrak: plafon, co-pay %, termin pembayaran';

CREATE TABLE service_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  code          text NOT NULL,
  name          text NOT NULL,
  service_type  text NOT NULL CHECK (service_type IN ('KONSULTASI','TINDAKAN','PAKET','ADMINISTRASI','LAB','LAINNYA')),
  icd9cm_code   text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
COMMENT ON TABLE service_item IS 'Layanan yang dapat ditagih (MST-FR-004)';

CREATE TABLE tariff (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  service_item_id  uuid NOT NULL,
  branch_id        uuid,
  payer_type       text CHECK (payer_type IN ('UMUM','ASURANSI','PERUSAHAAN','BPJS')),
  payer_id         uuid,
  price            numeric(18,2) NOT NULL CHECK (price >= 0),
  valid_from       date NOT NULL,
  valid_to         date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, service_item_id) REFERENCES service_item(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, payer_id) REFERENCES payer(tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE tariff ADD CONSTRAINT ex_tariff_no_overlap EXCLUDE USING gist (
  tenant_id WITH =, service_item_id WITH =,
  (coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  (coalesce(payer_type, '')) WITH =,
  (coalesce(payer_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') WITH &&
);
COMMENT ON TABLE tariff IS 'Tarif per layanan × cabang × penjamin × periode; periode tidak boleh tumpang tindih (AC-MST-FR-005-1)';

CREATE TABLE uom (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  code       text NOT NULL,
  name       text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
COMMENT ON TABLE uom IS 'Satuan (tablet, strip, box, ml, botol, ...) (MST-FR-007)';

CREATE TABLE uom_conversion (
  tenant_id    uuid NOT NULL,
  from_uom_id  uuid NOT NULL,
  to_uom_id    uuid NOT NULL,
  factor       numeric(18,6) NOT NULL CHECK (factor > 0),
  drug_item_id uuid,
  PRIMARY KEY (tenant_id, from_uom_id, to_uom_id),
  FOREIGN KEY (tenant_id, from_uom_id) REFERENCES uom(tenant_id, id),
  FOREIGN KEY (tenant_id, to_uom_id)   REFERENCES uom(tenant_id, id)
);
COMMENT ON TABLE uom_conversion IS '1 from_uom = factor × to_uom; opsional spesifik obat';

CREATE TABLE supplier (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  name        text NOT NULL,
  phone       text,
  address     text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
COMMENT ON TABLE supplier IS 'Pemasok obat (MST-FR-010)';

-- Penomoran dokumen bisnis (ADR-0005)
CREATE TABLE document_sequence (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  doc_type    text NOT NULL CHECK (doc_type IN ('MRN','ENCOUNTER','PRESCRIPTION','INVOICE','RECEIPT','REFUND','LETTER','REFERRAL','GOODS_RECEIPT','OTC_SALE','LAB_ORDER')),
  scope_key   text NOT NULL,
  pattern     text NOT NULL,
  next_value  bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (tenant_id, doc_type, scope_key)
);
COMMENT ON TABLE document_sequence IS 'Counter nomor dokumen per tenant/jenis/scope; diambil atomik (GEN-FR-006)';

CREATE OR REPLACE FUNCTION app.next_document_number(p_doc_type text, p_scope_key text, p_default_pattern text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_val bigint; v_pattern text; v_out text; v_width int;
BEGIN
  INSERT INTO document_sequence(tenant_id, doc_type, scope_key, pattern)
  VALUES (app.current_tenant_id(), p_doc_type, p_scope_key, p_default_pattern)
  ON CONFLICT DO NOTHING;
  UPDATE document_sequence SET next_value = next_value + 1
   WHERE tenant_id = app.current_tenant_id() AND doc_type = p_doc_type AND scope_key = p_scope_key
  RETURNING next_value - 1, pattern INTO v_val, v_pattern;
  IF v_val IS NULL THEN RAISE EXCEPTION 'Sequence tidak tersedia (tenant context?)'; END IF;
  v_width := coalesce((regexp_match(v_pattern, '\{SEQ:(\d+)\}'))[1]::int, 6);
  v_out := regexp_replace(v_pattern, '\{SEQ(:\d+)?\}', lpad(v_val::text, v_width, '0'));
  v_out := replace(replace(v_out, '{YYYY}', to_char(now(), 'YYYY')), '{MM}', to_char(now(), 'MM'));
  RETURN v_out;
END $$;
COMMENT ON FUNCTION app.next_document_number IS 'Ambil nomor berikutnya; dipanggil di transaksi yang sama dengan dokumen';

CREATE TABLE queue_counter (
  tenant_id   uuid NOT NULL,
  branch_id   uuid NOT NULL,
  unit_id     uuid NOT NULL,
  queue_date  date NOT NULL,
  last_number int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, branch_id, unit_id, queue_date),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES service_unit(tenant_id, id)
);
COMMENT ON TABLE queue_counter IS 'Counter antrean per cabang/unit/hari (SCH-FR-007)';

-- ===== 045_terminology.sql =====
-- =====================================================================
-- 045 Terminology — Stage 7 (TRM-FR-*). Tabel global + favorit per tenant.
-- =====================================================================
SET search_path = app, public;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE code_system (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL CHECK (code IN ('ICD10','ICD9CM','KFA','LOINC','SNOMED')),
  version         text NOT NULL,
  source          text NOT NULL,
  effective_date  date,
  is_current      boolean NOT NULL DEFAULT false,
  UNIQUE (code, version)
);
CREATE UNIQUE INDEX ux_code_system_current ON code_system(code) WHERE is_current;
COMMENT ON TABLE code_system IS 'Sistem kode & versi sumber (TRM-FR-001/002, OD-030)';

CREATE TABLE concept (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id    uuid NOT NULL REFERENCES code_system(id),
  code         text NOT NULL,
  display_id   text NOT NULL,
  display_en   text,
  parent_code  text,
  synonyms     text[] NOT NULL DEFAULT '{}',
  is_active    boolean NOT NULL DEFAULT true,
  UNIQUE (system_id, code)
);
CREATE INDEX ix_concept_display_trgm ON concept USING gin (display_id gin_trgm_ops);
COMMENT ON TABLE concept IS 'Kode asli tanpa modifikasi + display Bahasa Indonesia (AC-TRM-FR-001-1)';

CREATE TABLE tenant_concept_favorite (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  concept_id    uuid NOT NULL REFERENCES concept(id),
  specialty     text,
  validated_by  uuid,
  validated_at  timestamptz,
  PRIMARY KEY (tenant_id, concept_id)
);
COMMENT ON TABLE tenant_concept_favorite IS 'Subset diagnosis/tindakan favorit tenant, wajib divalidasi tenaga medis (TRM-FR-003)';

-- ===== 050_patient.sql =====
-- =====================================================================
-- 050 Patient — Stage 8 (REG-FR-*)
-- NIK: disimpan terenkripsi (aplikasi, AES-GCM via kunci KMS) + HMAC untuk pencarian.
-- =====================================================================
SET search_path = app, public;

CREATE TABLE patient (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  mrn                text NOT NULL,
  full_name          text NOT NULL,
  birth_date         date NOT NULL,
  sex                text NOT NULL CHECK (sex IN ('L','P','TIDAK_DIKETAHUI')),
  identity_type      text NOT NULL CHECK (identity_type IN ('NIK','PASPOR','KITAS','BAYI_IDENTITAS_IBU','TANPA_IDENTITAS')),
  nik_encrypted      bytea,
  nik_hash           text,
  identity_value_encrypted bytea,
  mother_patient_id  uuid,
  phone              text,
  email              text,
  address            text,
  region_code        text REFERENCES region(code),
  ihs_number         text,
  ihs_status         text NOT NULL DEFAULT 'PENDING' CHECK (ihs_status IN ('PENDING','FOUND','NOT_FOUND','NOT_APPLICABLE','ERROR')),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','MERGED','DECEASED','INACTIVE')),
  merged_into_id     uuid,
  registered_branch_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  version            int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, mrn),
  FOREIGN KEY (tenant_id, merged_into_id) REFERENCES patient(tenant_id, id),
  FOREIGN KEY (tenant_id, mother_patient_id) REFERENCES patient(tenant_id, id),
  FOREIGN KEY (tenant_id, registered_branch_id) REFERENCES branch(tenant_id, id),
  CHECK (identity_type <> 'NIK' OR (nik_encrypted IS NOT NULL AND nik_hash IS NOT NULL)),
  CHECK (status <> 'MERGED' OR merged_into_id IS NOT NULL)
);
CREATE UNIQUE INDEX ux_patient_nik ON patient(tenant_id, nik_hash) WHERE nik_hash IS NOT NULL AND status <> 'MERGED';
CREATE INDEX ix_patient_name_trgm ON patient USING gin (full_name gin_trgm_ops);
CREATE INDEX ix_patient_dob ON patient(tenant_id, birth_date);
CREATE INDEX ix_patient_phone ON patient(tenant_id, phone);
COMMENT ON TABLE patient IS 'Master Patient Index per tenant, dipakai lintas cabang (REG-FR-001/002/012)';
COMMENT ON COLUMN patient.nik_encrypted IS 'NIK terenkripsi di aplikasi; tidak pernah ditulis ke log (REG-FR-009)';
COMMENT ON COLUMN patient.nik_hash IS 'HMAC-SHA256 NIK untuk pencarian & deteksi duplikat pasti (REG-FR-004)';
COMMENT ON COLUMN patient.merged_into_id IS 'Pasien tujuan merge; data tidak dihapus (REG-FR-005)';

CREATE TABLE patient_contact (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  patient_id   uuid NOT NULL,
  relation     text NOT NULL,
  full_name    text NOT NULL,
  phone        text NOT NULL,
  is_guardian  boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id)
);
COMMENT ON TABLE patient_contact IS 'Kontak darurat & wali (REG-FR-006)';

CREATE TABLE patient_coverage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  patient_id    uuid NOT NULL,
  payer_id      uuid NOT NULL,
  member_no     text,
  plan_name     text,
  employee_no   text,
  bpjs_faskes_code text,
  valid_from    date,
  valid_to      date,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id),
  FOREIGN KEY (tenant_id, payer_id) REFERENCES payer(tenant_id, id)
);
COMMENT ON TABLE patient_coverage IS 'Penjamin pasien; satu pasien dapat punya beberapa (REG-FR-007); field BPJS disiapkan (BPJ-FR-004)';

CREATE TABLE consent_document (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  consent_type text NOT NULL CHECK (consent_type IN ('UMUM','DATA_SHARING','PORTAL')),
  version     text NOT NULL,
  content     text NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, consent_type, version)
);
COMMENT ON TABLE consent_document IS 'Teks consent berversi';

CREATE TABLE patient_consent (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  patient_id           uuid NOT NULL,
  consent_document_id  uuid NOT NULL,
  granted              boolean NOT NULL,
  signed_by_name       text,
  signed_by_relation   text,
  recorded_by          uuid NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id),
  FOREIGN KEY (tenant_id, consent_document_id) REFERENCES consent_document(tenant_id, id)
);
COMMENT ON TABLE patient_consent IS 'Consent pasien dengan versi dokumen & waktu (REG-FR-008)';

-- ===== 060_scheduling.sql =====
-- =====================================================================
-- 060 Scheduling, Encounter & Queue — Stage 8 (SCH-FR-*)
-- =====================================================================
SET search_path = app, public;

CREATE TABLE practitioner_schedule (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  practitioner_id  uuid NOT NULL,
  branch_id        uuid NOT NULL,
  unit_id          uuid NOT NULL,
  day_of_week      smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_time       time NOT NULL,
  end_time         time NOT NULL,
  slot_minutes     smallint NOT NULL DEFAULT 15 CHECK (slot_minutes > 0),
  quota            int NOT NULL CHECK (quota > 0),
  valid_from       date NOT NULL DEFAULT current_date,
  valid_to         date,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, practitioner_id) REFERENCES practitioner(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES service_unit(tenant_id, id),
  CHECK (end_time > start_time)
);
COMMENT ON TABLE practitioner_schedule IS 'Jadwal praktik mingguan dokter (SCH-FR-001); 1 = Senin';

CREATE TABLE schedule_exception (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  practitioner_id  uuid,
  branch_id        uuid,
  exception_date   date NOT NULL,
  reason           text NOT NULL,
  FOREIGN KEY (tenant_id, practitioner_id) REFERENCES practitioner(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  CHECK (practitioner_id IS NOT NULL OR branch_id IS NOT NULL)
);
COMMENT ON TABLE schedule_exception IS 'Cuti dokter atau libur cabang (SCH-FR-002)';

CREATE TABLE appointment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  patient_id       uuid NOT NULL,
  practitioner_id  uuid NOT NULL,
  branch_id        uuid NOT NULL,
  unit_id          uuid NOT NULL,
  schedule_id      uuid,
  slot_start       timestamptz NOT NULL,
  channel          text NOT NULL DEFAULT 'STAFF' CHECK (channel IN ('STAFF','PATIENT_APP','FOLLOW_UP')),
  status           text NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED','CHECKED_IN','CANCELLED','NO_SHOW','RESCHEDULED')),
  status_reason    text,
  rescheduled_to_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id),
  FOREIGN KEY (tenant_id, practitioner_id) REFERENCES practitioner(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES service_unit(tenant_id, id),
  FOREIGN KEY (tenant_id, schedule_id) REFERENCES practitioner_schedule(tenant_id, id),
  CHECK (status NOT IN ('CANCELLED','RESCHEDULED') OR status_reason IS NOT NULL)
);
CREATE INDEX ix_appointment_slot ON appointment(tenant_id, practitioner_id, slot_start) WHERE status IN ('BOOKED','CHECKED_IN');
COMMENT ON TABLE appointment IS 'Janji temu; pembatalan/reschedule wajib alasan (SCH-FR-003/010/011)';

CREATE TABLE encounter (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  encounter_no     text NOT NULL,
  patient_id       uuid NOT NULL,
  branch_id        uuid NOT NULL,
  unit_id          uuid NOT NULL,
  practitioner_id  uuid NOT NULL,
  appointment_id   uuid,
  coverage_id      uuid,
  payer_type       text NOT NULL DEFAULT 'UMUM' CHECK (payer_type IN ('UMUM','ASURANSI','PERUSAHAAN','BPJS')),
  arrival_type     text NOT NULL CHECK (arrival_type IN ('WALK_IN','APPOINTMENT')),
  status           text NOT NULL DEFAULT 'ARRIVED'
                   CHECK (status IN ('REGISTERED','ARRIVED','TRIAGED','IN_CONSULTATION','CONSULT_DONE','PHARMACY','BILLING','FINISHED','CANCELLED')),
  cancel_reason    text,
  arrived_at       timestamptz,
  consult_started_at timestamptz,
  consult_ended_at timestamptz,
  finished_at      timestamptz,
  satusehat_id     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, encounter_no),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES service_unit(tenant_id, id),
  FOREIGN KEY (tenant_id, practitioner_id) REFERENCES practitioner(tenant_id, id),
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointment(tenant_id, id),
  FOREIGN KEY (tenant_id, coverage_id) REFERENCES patient_coverage(tenant_id, id),
  CHECK (status <> 'CANCELLED' OR cancel_reason IS NOT NULL)
);
CREATE INDEX ix_encounter_worklist ON encounter(tenant_id, branch_id, practitioner_id, status, arrived_at);
CREATE INDEX ix_encounter_patient ON encounter(tenant_id, patient_id, arrived_at DESC);
COMMENT ON TABLE encounter IS 'Kunjungan rawat jalan; status mengikuti WF-01 (SCH-FR-013)';

CREATE TABLE queue_ticket (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  branch_id     uuid NOT NULL,
  unit_id       uuid NOT NULL,
  queue_date    date NOT NULL,
  queue_number  int NOT NULL CHECK (queue_number > 0),
  display_code  text NOT NULL,
  encounter_id  uuid NOT NULL,
  status        text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','CALLED','SKIPPED','SERVED','CANCELLED')),
  called_at     timestamptz,
  call_count    int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, branch_id, unit_id, queue_date, queue_number),
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES service_unit(tenant_id, id)
);
COMMENT ON TABLE queue_ticket IS 'Nomor antrean unik per cabang/unit/hari (SCH-FR-007/008)';

-- ===== 065_drug_master.sql =====
-- =====================================================================
-- 065 Drug Master — Stage 10 (PHM-FR-001/002), dibuat sebelum modul klinis
-- karena resep merujuk ke drug_item.
-- =====================================================================
SET search_path = app, public;

CREATE TABLE drug_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  code            text NOT NULL,
  generic_name    text NOT NULL,
  brand_name      text,
  dosage_form     text NOT NULL,
  strength        text,
  base_uom_id     uuid NOT NULL,
  drug_class      text NOT NULL CHECK (drug_class IN ('BEBAS','BEBAS_TERBATAS','KERAS','NARKOTIKA','PSIKOTROPIKA','PREKURSOR','ALKES','LAINNYA')),
  kfa_code        text,
  ingredients     text[] NOT NULL DEFAULT '{}',
  min_stock       numeric(18,4) NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, base_uom_id) REFERENCES uom(tenant_id, id)
);
CREATE INDEX ix_drug_name_trgm ON drug_item USING gin (generic_name gin_trgm_ops);
COMMENT ON TABLE drug_item IS 'Master obat tenant; golongan menentukan aturan jual bebas & akses (PHM-FR-001, PHM-FR-019)';
COMMENT ON COLUMN drug_item.ingredients IS 'Zat aktif (lowercase) untuk pengecekan alergi & duplikasi (CLN-FR-012)';
COMMENT ON COLUMN drug_item.kfa_code IS 'Kode KFA SATUSEHAT (TRM-FR-005)';

ALTER TABLE uom_conversion ADD FOREIGN KEY (tenant_id, drug_item_id) REFERENCES drug_item(tenant_id, id);

CREATE TABLE drug_price (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  drug_item_id  uuid NOT NULL,
  branch_id     uuid,
  payer_type    text CHECK (payer_type IN ('UMUM','ASURANSI','PERUSAHAAN','BPJS')),
  hna           numeric(18,2),
  het           numeric(18,2),
  sell_price    numeric(18,2) NOT NULL CHECK (sell_price >= 0),
  valid_from    date NOT NULL,
  valid_to      date,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, drug_item_id) REFERENCES drug_item(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  EXCLUDE USING gist (
    tenant_id WITH =, drug_item_id WITH =,
    (coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (coalesce(payer_type, '')) WITH =,
    daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') WITH &&)
);
COMMENT ON TABLE drug_price IS 'Harga jual obat per penjamin & periode (PHM-FR-002). Harga beli ada di batch.';

-- ===== 070_clinical.sql =====
-- =====================================================================
-- 070 Clinical & Medical Record — Stage 9 (CLN-FR-*), ADR-0006
-- Satu clinical_note utama per encounter. Setelah SIGNED, catatan dan seluruh
-- data klinis encounter (vital, diagnosis, tindakan, resep) terkunci.
-- =====================================================================
SET search_path = app, public;

CREATE TABLE stored_file (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  category      text NOT NULL CHECK (category IN ('MEDICAL_DOCUMENT','UPLOAD','LAB_RESULT','EXPORT','BRANDING','REPORT')),
  object_path   text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  sha256        text NOT NULL,
  patient_id    uuid,
  uploaded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (object_path)
);
COMMENT ON TABLE stored_file IS 'Metadata berkas di Cloud Storage (ADR-0013, DOC-FR-002/003)';

CREATE TABLE clinical_note (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  encounter_id    uuid NOT NULL,
  template_code   text NOT NULL DEFAULT 'UMUM',
  subjective      text,
  objective       text,
  assessment      text,
  plan            text,
  structured      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SIGNED')),
  signed_by       uuid,
  signed_at       timestamptz,
  content_hash    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, encounter_id),
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id),
  FOREIGN KEY (tenant_id, signed_by) REFERENCES practitioner(tenant_id, id),
  CHECK (status <> 'SIGNED' OR (signed_by IS NOT NULL AND signed_at IS NOT NULL AND content_hash IS NOT NULL))
);
COMMENT ON TABLE clinical_note IS 'Catatan SOAP utama per kunjungan; SIGNED = immutable (CLN-FR-004/017)';
COMMENT ON COLUMN clinical_note.structured IS 'Isian terstruktur dari template spesialisasi (CLN-FR-005)';
COMMENT ON COLUMN clinical_note.content_hash IS 'SHA-256 isi kanonik saat pengesahan (ADR-0006)';

CREATE TABLE clinical_addendum (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  note_id       uuid NOT NULL,
  reason        text NOT NULL CHECK (length(trim(reason)) > 0),
  content       text NOT NULL,
  changes       jsonb,
  author_id     uuid NOT NULL,
  signed_at     timestamptz NOT NULL DEFAULT now(),
  content_hash  text NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, note_id) REFERENCES clinical_note(tenant_id, id),
  FOREIGN KEY (tenant_id, author_id) REFERENCES practitioner(tenant_id, id)
);
COMMENT ON TABLE clinical_addendum IS 'Koreksi atas catatan yang sudah disahkan; append-only (CLN-FR-019)';

CREATE TABLE observation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  encounter_id  uuid NOT NULL,
  code          text NOT NULL CHECK (code IN ('SYSTOLIC','DIASTOLIC','HEART_RATE','RESP_RATE','TEMPERATURE','SPO2','WEIGHT','HEIGHT','BMI','PAIN_SCALE','OTHER')),
  value_num     numeric(10,2),
  value_text    text,
  unit          text,
  recorded_by   uuid NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id),
  CHECK (code <> 'TEMPERATURE' OR value_num BETWEEN 25 AND 45),
  CHECK (code <> 'SPO2' OR value_num BETWEEN 0 AND 100)
);
COMMENT ON TABLE observation IS 'Tanda vital & observasi (CLN-FR-002); batas fisik menolak salah input (AC-CLN-FR-002-2)';

CREATE TABLE allergy_intolerance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  patient_id    uuid NOT NULL,
  substance     text NOT NULL,
  category      text NOT NULL CHECK (category IN ('OBAT','MAKANAN','LINGKUNGAN','LAINNYA')),
  reaction      text,
  severity      text CHECK (severity IN ('RINGAN','SEDANG','BERAT')),
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','ENTERED_IN_ERROR')),
  recorded_by   uuid NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id)
);
COMMENT ON TABLE allergy_intolerance IS 'Alergi pasien, tampil di header klinis & farmasi (CLN-FR-006)';

CREATE TABLE patient_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  patient_id   uuid NOT NULL,
  history_type text NOT NULL CHECK (history_type IN ('PENYAKIT','OBAT_RUTIN','KELUARGA','SOSIAL','OPERASI')),
  description  text NOT NULL,
  recorded_by  uuid NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id)
);
COMMENT ON TABLE patient_history IS 'Riwayat penyakit & obat rutin (CLN-FR-007)';

CREATE TABLE condition_dx (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  encounter_id  uuid NOT NULL,
  concept_id    uuid NOT NULL REFERENCES concept(id),
  rank          text NOT NULL CHECK (rank IN ('PRIMER','SEKUNDER')),
  case_status   text NOT NULL DEFAULT 'BARU' CHECK (case_status IN ('BARU','LAMA')),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id)
);
CREATE UNIQUE INDEX ux_condition_primary ON condition_dx(tenant_id, encounter_id) WHERE rank = 'PRIMER';
COMMENT ON TABLE condition_dx IS 'Diagnosis ICD-10; tepat satu primer per kunjungan (AC-CLN-FR-008-1)';

CREATE TABLE procedure_act (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  encounter_id     uuid NOT NULL,
  concept_id       uuid REFERENCES concept(id),
  service_item_id  uuid NOT NULL,
  performed_by     uuid NOT NULL,
  qty              numeric(10,2) NOT NULL DEFAULT 1 CHECK (qty > 0),
  performed_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id),
  FOREIGN KEY (tenant_id, service_item_id) REFERENCES service_item(tenant_id, id),
  FOREIGN KEY (tenant_id, performed_by) REFERENCES practitioner(tenant_id, id)
);
COMMENT ON TABLE procedure_act IS 'Tindakan ICD-9-CM; otomatis menjadi baris tagihan (CLN-FR-009)';

CREATE TABLE prescription (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  prescription_no  text NOT NULL,
  encounter_id     uuid NOT NULL,
  prescriber_id    uuid NOT NULL,
  status           text NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT','ISSUED','VERIFIED','PARTIALLY_DISPENSED','DISPENSED','CANCELLED')),
  review_checklist jsonb,
  reviewed_by      uuid,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, prescription_no),
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id),
  FOREIGN KEY (tenant_id, prescriber_id) REFERENCES practitioner(tenant_id, id),
  CHECK (status NOT IN ('VERIFIED','PARTIALLY_DISPENSED','DISPENSED') OR review_checklist IS NOT NULL)
);
COMMENT ON TABLE prescription IS 'Resep elektronik; status farmasi tetap dapat berubah setelah RM disahkan (CLN-FR-010, PHM-FR-007)';

CREATE TABLE prescription_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  prescription_id  uuid NOT NULL,
  line_no          smallint NOT NULL,
  is_compound      boolean NOT NULL DEFAULT false,
  drug_item_id     uuid,
  compound_name    text,
  compound_form    text,
  dose             text,
  frequency        text NOT NULL,
  route            text NOT NULL,
  duration_days    smallint,
  qty              numeric(18,4) NOT NULL CHECK (qty > 0),
  uom_id           uuid NOT NULL,
  instructions     text,
  qty_dispensed    numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_dispensed >= 0),
  substituted_from_drug_id uuid,
  substitution_reason text,
  substitution_approved_by uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, prescription_id, line_no),
  FOREIGN KEY (tenant_id, prescription_id) REFERENCES prescription(tenant_id, id),
  FOREIGN KEY (tenant_id, drug_item_id) REFERENCES drug_item(tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uom(tenant_id, id),
  FOREIGN KEY (tenant_id, substitution_approved_by) REFERENCES practitioner(tenant_id, id),
  CHECK (is_compound OR drug_item_id IS NOT NULL),
  CHECK (NOT is_compound OR compound_name IS NOT NULL),
  CHECK (qty_dispensed <= qty),
  CHECK (substituted_from_drug_id IS NULL OR (substitution_reason IS NOT NULL AND substitution_approved_by IS NOT NULL))
);
COMMENT ON TABLE prescription_item IS 'Baris resep non-racikan / racikan; qty_dispensed melacak resep parsial (PHM-FR-009/010)';

CREATE TABLE prescription_compound_component (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  prescription_item_id  uuid NOT NULL,
  drug_item_id          uuid NOT NULL,
  qty                   numeric(18,4) NOT NULL CHECK (qty > 0),
  uom_id                uuid NOT NULL,
  FOREIGN KEY (tenant_id, prescription_item_id) REFERENCES prescription_item(tenant_id, id),
  FOREIGN KEY (tenant_id, drug_item_id) REFERENCES drug_item(tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uom(tenant_id, id)
);
COMMENT ON TABLE prescription_compound_component IS 'Komponen resep racikan (CLN-FR-011)';

CREATE TABLE lab_order (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  order_no           text NOT NULL,
  encounter_id       uuid NOT NULL,
  ordered_by         uuid NOT NULL,
  lab_connector      text,
  external_order_id  text,
  status             text NOT NULL DEFAULT 'ORDERED' CHECK (status IN ('ORDERED','SENT','RECEIVED','RESULTED','CANCELLED','ERROR')),
  clinical_info      text,
  ordered_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, order_no),
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id),
  FOREIGN KEY (tenant_id, ordered_by) REFERENCES practitioner(tenant_id, id)
);
COMMENT ON TABLE lab_order IS 'Order ke aplikasi lab eksisting (CLN-FR-014, DEC-009)';

CREATE TABLE lab_order_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  lab_order_id     uuid NOT NULL,
  service_item_id  uuid NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, lab_order_id) REFERENCES lab_order(tenant_id, id),
  FOREIGN KEY (tenant_id, service_item_id) REFERENCES service_item(tenant_id, id)
);

CREATE TABLE lab_result (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  lab_order_id       uuid NOT NULL,
  lab_order_item_id  uuid,
  source             text NOT NULL CHECK (source IN ('CONNECTOR','MANUAL','UPLOAD')),
  test_name          text,
  value_text         text,
  unit               text,
  reference_range    text,
  flag               text CHECK (flag IN ('N','L','H','LL','HH','A')),
  file_id            uuid,
  resulted_at        timestamptz NOT NULL DEFAULT now(),
  entered_by         uuid,
  FOREIGN KEY (tenant_id, lab_order_id) REFERENCES lab_order(tenant_id, id),
  FOREIGN KEY (tenant_id, lab_order_item_id) REFERENCES lab_order_item(tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES stored_file(tenant_id, id),
  CHECK (source <> 'UPLOAD' OR file_id IS NOT NULL)
);
COMMENT ON TABLE lab_result IS 'Hasil lab dari konektor, input manual, atau unggahan PDF (CLN-FR-015)';

CREATE TABLE medical_document (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  document_no   text NOT NULL,
  doc_type      text NOT NULL CHECK (doc_type IN ('RESUME','SURAT_SEHAT','SURAT_SAKIT','RUJUKAN','KWITANSI','ETIKET','LAINNYA')),
  encounter_id  uuid,
  patient_id    uuid NOT NULL,
  file_id       uuid NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_by     uuid NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, document_no),
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES stored_file(tenant_id, id)
);
COMMENT ON TABLE medical_document IS 'Dokumen medis terbit (PDF tersimpan, tidak dibuat ulang) (CLN-FR-020/021, DOC-FR-002)';

CREATE TABLE referral (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  encounter_id     uuid NOT NULL,
  destination      text NOT NULL,
  destination_unit text,
  reason           text NOT NULL,
  clinical_summary text,
  document_id      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id)
);
COMMENT ON TABLE referral IS 'Rujukan keluar (CLN-FR-022)';

-- ---------------------------------------------------------------------
-- Immutability (ADR-0006)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.guard_clinical_note() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'SIGNED' THEN RAISE EXCEPTION 'IMMUTABLE: clinical_note sudah disahkan' USING ERRCODE='P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'SIGNED' THEN
    RAISE EXCEPTION 'IMMUTABLE: clinical_note sudah disahkan; gunakan addendum' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_clinical_note_guard BEFORE UPDATE OR DELETE ON clinical_note
  FOR EACH ROW EXECUTE FUNCTION app.guard_clinical_note();

CREATE OR REPLACE FUNCTION app.guard_encounter_clinical_child() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_enc uuid; v_tenant uuid; v_signed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN v_enc := OLD.encounter_id; v_tenant := OLD.tenant_id;
  ELSE v_enc := NEW.encounter_id; v_tenant := NEW.tenant_id; END IF;
  SELECT EXISTS (SELECT 1 FROM clinical_note n
                  WHERE n.tenant_id = v_tenant AND n.encounter_id = v_enc AND n.status = 'SIGNED')
    INTO v_signed;
  IF v_signed THEN
    RAISE EXCEPTION 'IMMUTABLE: % untuk encounter yang sudah disahkan', TG_TABLE_NAME USING ERRCODE='P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_observation_guard  BEFORE INSERT OR UPDATE OR DELETE ON observation  FOR EACH ROW EXECUTE FUNCTION app.guard_encounter_clinical_child();
CREATE TRIGGER trg_condition_guard    BEFORE INSERT OR UPDATE OR DELETE ON condition_dx FOR EACH ROW EXECUTE FUNCTION app.guard_encounter_clinical_child();
CREATE TRIGGER trg_procedure_guard    BEFORE INSERT OR UPDATE OR DELETE ON procedure_act FOR EACH ROW EXECUTE FUNCTION app.guard_encounter_clinical_child();

-- Resep: isi klinis terkunci setelah ISSUED; hanya kolom proses farmasi yang boleh berubah.
CREATE OR REPLACE FUNCTION app.guard_prescription() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE allowed text[] := ARRAY['status','review_checklist','reviewed_by','reviewed_at','updated_at','updated_by','version'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'IMMUTABLE: resep sudah diterbitkan' USING ERRCODE='P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' AND (to_jsonb(NEW) - allowed) <> (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION 'IMMUTABLE: isi resep tidak dapat diubah setelah diterbitkan' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_prescription_guard BEFORE UPDATE OR DELETE ON prescription
  FOR EACH ROW EXECUTE FUNCTION app.guard_prescription();

CREATE OR REPLACE FUNCTION app.guard_prescription_item() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text; v_rx uuid; v_tenant uuid;
  allowed text[] := ARRAY['qty_dispensed','drug_item_id','substituted_from_drug_id','substitution_reason','substitution_approved_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN v_rx := OLD.prescription_id; v_tenant := OLD.tenant_id;
  ELSE v_rx := NEW.prescription_id; v_tenant := NEW.tenant_id; END IF;
  SELECT status INTO v_status FROM prescription WHERE tenant_id = v_tenant AND id = v_rx;
  IF v_status <> 'DRAFT' THEN
    IF TG_OP IN ('INSERT','DELETE') THEN
      RAISE EXCEPTION 'IMMUTABLE: baris resep terkunci' USING ERRCODE='P0001';
    END IF;
    IF (to_jsonb(NEW) - allowed) <> (to_jsonb(OLD) - allowed) THEN
      RAISE EXCEPTION 'IMMUTABLE: hanya jumlah diserahkan & substitusi yang dapat diubah' USING ERRCODE='P0001';
    END IF;
    IF NEW.drug_item_id IS DISTINCT FROM OLD.drug_item_id AND NEW.substitution_approved_by IS NULL THEN
      RAISE EXCEPTION 'Substitusi memerlukan persetujuan dokter' USING ERRCODE='P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_prescription_item_guard BEFORE INSERT OR UPDATE OR DELETE ON prescription_item
  FOR EACH ROW EXECUTE FUNCTION app.guard_prescription_item();

CREATE TRIGGER trg_addendum_immutable BEFORE UPDATE OR DELETE ON clinical_addendum
  FOR EACH ROW EXECUTE FUNCTION app.reject_modification();
CREATE TRIGGER trg_medical_document_immutable BEFORE UPDATE OR DELETE ON medical_document
  FOR EACH ROW EXECUTE FUNCTION app.reject_modification();

COMMENT ON TABLE lab_order_item IS 'Pemeriksaan yang diminta dalam satu order lab';

-- ===== 080_pharmacy.sql =====
-- =====================================================================
-- 080 Pharmacy & Inventory — Stage 10 (PHM-FR-*)
-- Stok = ledger stock_movement (append-only). stock_balance dipelihara trigger
-- dan tidak dapat negatif (PHM-FR-013).
-- =====================================================================
SET search_path = app, public;

CREATE TABLE stock_location (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  branch_id   uuid NOT NULL,
  unit_id     uuid,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES service_unit(tenant_id, id)
);
COMMENT ON TABLE stock_location IS 'Lokasi stok: apotek, gudang (per cabang)';

CREATE TABLE stock_batch (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  drug_item_id   uuid NOT NULL,
  batch_no       text NOT NULL,
  expiry_date    date NOT NULL,
  unit_cost      numeric(18,4) NOT NULL CHECK (unit_cost >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, drug_item_id, batch_no, expiry_date),
  FOREIGN KEY (tenant_id, drug_item_id) REFERENCES drug_item(tenant_id, id)
);
COMMENT ON TABLE stock_batch IS 'Batch obat dengan tanggal kedaluwarsa & harga beli per satuan dasar (PHM-FR-003)';

CREATE TABLE stock_balance (
  tenant_id     uuid NOT NULL,
  batch_id      uuid NOT NULL,
  location_id   uuid NOT NULL,
  qty_on_hand   numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id, location_id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batch(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_location(tenant_id, id)
);
COMMENT ON TABLE stock_balance IS 'Saldo per batch per lokasi; hanya diubah trigger ledger; CHECK >= 0 menolak stok negatif';

CREATE TABLE stock_movement (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  batch_id       uuid NOT NULL,
  location_id    uuid NOT NULL,
  movement_type  text NOT NULL CHECK (movement_type IN ('RECEIPT','DISPENSE','OTC_SALE','RETURN_IN','RETURN_OUT','ADJUSTMENT','OPNAME','TRANSFER_IN','TRANSFER_OUT')),
  qty            numeric(18,4) NOT NULL CHECK (qty <> 0),
  ref_type       text NOT NULL,
  ref_id         uuid NOT NULL,
  actor_id       uuid,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batch(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_location(tenant_id, id),
  CHECK ((movement_type IN ('RECEIPT','RETURN_IN','TRANSFER_IN') AND qty > 0)
      OR (movement_type IN ('DISPENSE','OTC_SALE','RETURN_OUT','TRANSFER_OUT') AND qty < 0)
      OR  movement_type IN ('ADJUSTMENT','OPNAME'))
);
CREATE INDEX ix_stock_movement_batch ON stock_movement(tenant_id, batch_id, occurred_at);
COMMENT ON TABLE stock_movement IS 'Ledger mutasi stok, append-only (PHM-FR-004); qty bertanda (+ masuk, − keluar)';

CREATE OR REPLACE FUNCTION app.apply_stock_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_expiry date;
BEGIN
  IF NEW.qty < 0 THEN
    SELECT expiry_date INTO v_expiry FROM stock_batch WHERE tenant_id = NEW.tenant_id AND id = NEW.batch_id;
    IF NEW.movement_type IN ('DISPENSE','OTC_SALE') AND v_expiry < current_date THEN
      RAISE EXCEPTION 'Batch kedaluwarsa tidak dapat dikeluarkan (PHM-FR-013)' USING ERRCODE='P0001';
    END IF;
  END IF;
  INSERT INTO stock_balance(tenant_id, batch_id, location_id, qty_on_hand)
  VALUES (NEW.tenant_id, NEW.batch_id, NEW.location_id, 0)
  ON CONFLICT DO NOTHING;
  UPDATE stock_balance SET qty_on_hand = qty_on_hand + NEW.qty, updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND batch_id = NEW.batch_id AND location_id = NEW.location_id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_stock_movement_apply AFTER INSERT ON stock_movement
  FOR EACH ROW EXECUTE FUNCTION app.apply_stock_movement();
CREATE TRIGGER trg_stock_movement_immutable BEFORE UPDATE OR DELETE ON stock_movement
  FOR EACH ROW EXECUTE FUNCTION app.reject_modification();

CREATE TABLE goods_receipt (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  receipt_no    text NOT NULL,
  supplier_id   uuid NOT NULL,
  location_id   uuid NOT NULL,
  invoice_no    text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  received_by   uuid NOT NULL,
  status        text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT','POSTED')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, receipt_no),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES supplier(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_location(tenant_id, id)
);
COMMENT ON TABLE goods_receipt IS 'Penerimaan barang dari supplier (PHM-FR-003)';

CREATE TABLE goods_receipt_line (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  goods_receipt_id  uuid NOT NULL,
  batch_id          uuid NOT NULL,
  qty               numeric(18,4) NOT NULL CHECK (qty > 0),
  uom_id            uuid NOT NULL,
  qty_base          numeric(18,4) NOT NULL CHECK (qty_base > 0),
  unit_price        numeric(18,2) NOT NULL CHECK (unit_price >= 0),
  FOREIGN KEY (tenant_id, goods_receipt_id) REFERENCES goods_receipt(tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batch(tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uom(tenant_id, id)
);

CREATE TABLE dispense (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  prescription_id  uuid NOT NULL,
  location_id      uuid NOT NULL,
  dispensed_by     uuid NOT NULL,
  dispensed_at     timestamptz NOT NULL DEFAULT now(),
  handed_to        text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, prescription_id) REFERENCES prescription(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_location(tenant_id, id)
);
COMMENT ON TABLE dispense IS 'Satu sesi penyerahan obat; resep parsial = beberapa dispense (PHM-FR-008/009)';

CREATE TABLE dispense_line (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  dispense_id           uuid NOT NULL,
  prescription_item_id  uuid NOT NULL,
  batch_id              uuid NOT NULL,
  qty_base              numeric(18,4) NOT NULL CHECK (qty_base > 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, dispense_id) REFERENCES dispense(tenant_id, id),
  FOREIGN KEY (tenant_id, prescription_item_id) REFERENCES prescription_item(tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batch(tenant_id, id)
);

CREATE TABLE otc_sale (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  sale_no      text NOT NULL,
  branch_id    uuid NOT NULL,
  location_id  uuid NOT NULL,
  patient_id   uuid,
  sold_by      uuid NOT NULL,
  sold_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sale_no),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_location(tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id)
);
COMMENT ON TABLE otc_sale IS 'Penjualan obat bebas tanpa kunjungan (PHM-FR-012)';

CREATE TABLE otc_sale_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  otc_sale_id   uuid NOT NULL,
  drug_item_id  uuid NOT NULL,
  batch_id      uuid NOT NULL,
  qty_base      numeric(18,4) NOT NULL CHECK (qty_base > 0),
  unit_price    numeric(18,2) NOT NULL CHECK (unit_price >= 0),
  FOREIGN KEY (tenant_id, otc_sale_id) REFERENCES otc_sale(tenant_id, id),
  FOREIGN KEY (tenant_id, drug_item_id) REFERENCES drug_item(tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batch(tenant_id, id)
);

CREATE OR REPLACE FUNCTION app.guard_otc_drug_class() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_class text;
BEGIN
  SELECT drug_class INTO v_class FROM drug_item WHERE tenant_id = NEW.tenant_id AND id = NEW.drug_item_id;
  IF v_class NOT IN ('BEBAS','BEBAS_TERBATAS') THEN
    RAISE EXCEPTION 'Obat golongan % tidak boleh dijual tanpa resep (AC-PHM-FR-012-1)', v_class USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_otc_drug_class BEFORE INSERT OR UPDATE ON otc_sale_line
  FOR EACH ROW EXECUTE FUNCTION app.guard_otc_drug_class();

CREATE TABLE stock_adjustment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  batch_id      uuid NOT NULL,
  location_id   uuid NOT NULL,
  qty_delta     numeric(18,4) NOT NULL CHECK (qty_delta <> 0),
  reason        text NOT NULL,
  requested_by  uuid NOT NULL,
  approved_by   uuid,
  status        text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batch(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_location(tenant_id, id),
  CHECK (status = 'REQUESTED' OR (approved_by IS NOT NULL AND approved_by <> requested_by))
);
COMMENT ON TABLE stock_adjustment IS 'Penyesuaian stok dengan maker–checker (PHM-FR-016)';

CREATE TABLE stock_opname (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  location_id  uuid NOT NULL,
  status       text NOT NULL DEFAULT 'COUNTING' CHECK (status IN ('COUNTING','SUBMITTED','APPROVED','CANCELLED')),
  started_by   uuid NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  approved_by  uuid,
  approved_at  timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_location(tenant_id, id)
);
COMMENT ON TABLE stock_opname IS 'Sesi stock opname; selisih menjadi movement OPNAME setelah disetujui (PHM-FR-017)';

CREATE TABLE stock_opname_line (
  tenant_id     uuid NOT NULL,
  opname_id     uuid NOT NULL,
  batch_id      uuid NOT NULL,
  system_qty    numeric(18,4) NOT NULL,
  counted_qty   numeric(18,4) NOT NULL CHECK (counted_qty >= 0),
  note          text,
  PRIMARY KEY (tenant_id, opname_id, batch_id),
  FOREIGN KEY (tenant_id, opname_id) REFERENCES stock_opname(tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batch(tenant_id, id)
);

COMMENT ON TABLE goods_receipt_line IS 'Baris penerimaan barang; qty_base = qty dalam satuan dasar obat';
COMMENT ON TABLE dispense_line IS 'Obat & batch yang diserahkan per baris resep; memicu stock_movement DISPENSE';
COMMENT ON TABLE otc_sale_line IS 'Baris penjualan bebas; hanya obat golongan BEBAS/BEBAS_TERBATAS (trigger)';
COMMENT ON TABLE stock_opname_line IS 'Hasil hitung fisik per batch pada sesi opname';

-- ===== 090_billing.sql =====
-- =====================================================================
-- 090 Billing & Payment — Stage 11 (BIL-FR-*), ADR-0006
-- =====================================================================
SET search_path = app, public;

CREATE TABLE cashier_shift (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  branch_id       uuid NOT NULL,
  cashier_id      uuid NOT NULL,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  opening_cash    numeric(18,2) NOT NULL CHECK (opening_cash >= 0),
  closed_at       timestamptz,
  counted_cash    numeric(18,2),
  expected_cash   numeric(18,2),
  variance        numeric(18,2) GENERATED ALWAYS AS (counted_cash - expected_cash) STORED,
  variance_note   text,
  verified_by     uuid,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','VERIFIED')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, cashier_id) REFERENCES app_user(tenant_id, id),
  CHECK (status = 'OPEN' OR (closed_at IS NOT NULL AND counted_cash IS NOT NULL AND expected_cash IS NOT NULL))
);
CREATE UNIQUE INDEX ux_cashier_shift_open ON cashier_shift(tenant_id, cashier_id) WHERE status = 'OPEN';
COMMENT ON TABLE cashier_shift IS 'Shift kasir; satu shift OPEN per kasir; variance otomatis (BIL-FR-011)';

CREATE TABLE invoice (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  invoice_no       text,
  branch_id        uuid NOT NULL,
  patient_id       uuid,
  encounter_id     uuid,
  otc_sale_id      uuid,
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ISSUED','PARTIALLY_PAID','PAID','VOID')),
  gross_amount     numeric(18,2) NOT NULL DEFAULT 0 CHECK (gross_amount >= 0),
  discount_amount  numeric(18,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  net_amount       numeric(18,2) NOT NULL DEFAULT 0 CHECK (net_amount >= 0),
  payer_portion    numeric(18,2) NOT NULL DEFAULT 0 CHECK (payer_portion >= 0),
  patient_portion  numeric(18,2) NOT NULL DEFAULT 0 CHECK (patient_portion >= 0),
  paid_amount      numeric(18,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  payer_id         uuid,
  issued_at        timestamptz,
  issued_by        uuid,
  replaces_invoice_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, invoice_no),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patient(tenant_id, id),
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id),
  FOREIGN KEY (tenant_id, otc_sale_id) REFERENCES otc_sale(tenant_id, id),
  FOREIGN KEY (tenant_id, payer_id) REFERENCES payer(tenant_id, id),
  FOREIGN KEY (tenant_id, replaces_invoice_id) REFERENCES invoice(tenant_id, id),
  CHECK (status = 'DRAFT' OR (invoice_no IS NOT NULL AND issued_at IS NOT NULL)),
  CHECK (net_amount = gross_amount - discount_amount),
  CHECK (payer_portion + patient_portion = net_amount),
  CHECK (encounter_id IS NOT NULL OR otc_sale_id IS NOT NULL)
);
COMMENT ON TABLE invoice IS 'Tagihan; setelah ISSUED hanya status & paid_amount yang berubah (BIL-FR-001/004/009)';

CREATE TABLE invoice_line (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  invoice_id        uuid NOT NULL,
  line_no           smallint NOT NULL,
  source_type       text NOT NULL CHECK (source_type IN ('KONSULTASI','TINDAKAN','OBAT','LAB','ADMINISTRASI','LAINNYA')),
  source_id         uuid,
  description       text NOT NULL,
  qty               numeric(18,4) NOT NULL CHECK (qty > 0),
  unit_price        numeric(18,2) NOT NULL CHECK (unit_price >= 0),
  discount_amount   numeric(18,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  line_total        numeric(18,2) NOT NULL,
  payer_portion     numeric(18,2) NOT NULL DEFAULT 0,
  patient_portion   numeric(18,2) NOT NULL DEFAULT 0,
  discount_approved_by uuid,
  UNIQUE (tenant_id, invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice(tenant_id, id),
  CHECK (line_total = round(qty * unit_price, 2) - discount_amount),
  CHECK (payer_portion + patient_portion = line_total)
);
COMMENT ON TABLE invoice_line IS 'Baris tagihan dengan harga snapshot (BIL-FR-002)';

CREATE TABLE payment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  receipt_no       text NOT NULL,
  invoice_id       uuid NOT NULL,
  shift_id         uuid NOT NULL,
  method           text NOT NULL CHECK (method IN ('TUNAI','DEBIT','KARTU_KREDIT','TRANSFER','QRIS','PIUTANG_PELUNASAN')),
  amount           numeric(18,2) NOT NULL CHECK (amount > 0),
  cash_tendered    numeric(18,2),
  reference        text,
  idempotency_key  text NOT NULL,
  received_by      uuid NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, receipt_no),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice(tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES cashier_shift(tenant_id, id),
  CHECK (method NOT IN ('DEBIT','KARTU_KREDIT','TRANSFER','QRIS') OR reference IS NOT NULL),
  CHECK (method <> 'TUNAI' OR cash_tendered IS NULL OR cash_tendered >= amount)
);
COMMENT ON TABLE payment IS 'Pembayaran append-only; idempotency_key mencegah pencatatan ganda (BIL-FR-005..007, AC-BIL-FR-006-2)';

CREATE TABLE payment_gateway_txn (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  invoice_id       uuid NOT NULL,
  provider         text NOT NULL,
  provider_ref     text,
  amount           numeric(18,2) NOT NULL CHECK (amount > 0),
  qr_payload       text,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','EXPIRED','FAILED','CANCELLED')),
  expires_at       timestamptz,
  payment_id       uuid,
  callback_count   int NOT NULL DEFAULT 0,
  last_callback_at timestamptz,
  settled          boolean NOT NULL DEFAULT false,
  settlement_ref   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider, provider_ref),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payment(tenant_id, id)
);
COMMENT ON TABLE payment_gateway_txn IS 'Transaksi QRIS & status callback/settlement (BIL-FR-006/012)';

CREATE TABLE refund (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  refund_no     text NOT NULL,
  payment_id    uuid NOT NULL,
  amount        numeric(18,2) NOT NULL CHECK (amount > 0),
  reason        text NOT NULL CHECK (length(trim(reason)) > 0),
  method        text NOT NULL,
  requested_by  uuid NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  approved_by   uuid,
  decided_at    timestamptz,
  status        text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, refund_no),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payment(tenant_id, id),
  CHECK (status = 'REQUESTED' OR (approved_by IS NOT NULL AND approved_by <> requested_by AND decided_at IS NOT NULL))
);
COMMENT ON TABLE refund IS 'Refund maker–checker; penyetuju ≠ pengaju (BIL-FR-010)';

CREATE TABLE invoice_void (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  invoice_id    uuid NOT NULL,
  reason        text NOT NULL,
  requested_by  uuid NOT NULL,
  approved_by   uuid,
  status        text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice(tenant_id, id),
  CHECK (status = 'REQUESTED' OR (approved_by IS NOT NULL AND approved_by <> requested_by))
);
COMMENT ON TABLE invoice_void IS 'Permintaan void invoice dengan persetujuan (BIL-FR-009)';

CREATE TABLE receivable (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  invoice_id    uuid NOT NULL,
  payer_id      uuid NOT NULL,
  amount        numeric(18,2) NOT NULL CHECK (amount > 0),
  paid_amount   numeric(18,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  due_date      date,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PARTIAL','PAID','WRITTEN_OFF')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice(tenant_id, id),
  FOREIGN KEY (tenant_id, payer_id) REFERENCES payer(tenant_id, id),
  CHECK (paid_amount <= amount)
);
COMMENT ON TABLE receivable IS 'Piutang porsi penjamin (BIL-FR-013)';

-- ---------------------------------------------------------------------
-- Immutability (ADR-0006)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.guard_invoice() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE allowed text[] := ARRAY['status','paid_amount','updated_at','updated_by','version'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'IMMUTABLE: invoice sudah diterbitkan' USING ERRCODE='P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    IF (to_jsonb(NEW) - allowed) <> (to_jsonb(OLD) - allowed) THEN
      RAISE EXCEPTION 'IMMUTABLE: isi invoice tidak dapat diubah setelah diterbitkan' USING ERRCODE='P0001';
    END IF;
    IF OLD.status = 'VOID' OR (OLD.status = 'PAID' AND NEW.status NOT IN ('PAID')) THEN
      RAISE EXCEPTION 'Transisi status invoice % → % tidak valid', OLD.status, NEW.status USING ERRCODE='P0001';
    END IF;
    IF NEW.status = 'VOID' AND OLD.paid_amount > 0 THEN
      RAISE EXCEPTION 'Invoice yang sudah dibayar harus di-refund sebelum void' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_invoice_guard BEFORE UPDATE OR DELETE ON invoice
  FOR EACH ROW EXECUTE FUNCTION app.guard_invoice();

CREATE OR REPLACE FUNCTION app.guard_invoice_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text; v_inv uuid; v_tenant uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_inv := OLD.invoice_id; v_tenant := OLD.tenant_id;
  ELSE v_inv := NEW.invoice_id; v_tenant := NEW.tenant_id; END IF;
  SELECT status INTO v_status FROM invoice WHERE tenant_id = v_tenant AND id = v_inv;
  IF v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'IMMUTABLE: baris invoice terkunci' USING ERRCODE='P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_invoice_line_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_line
  FOR EACH ROW EXECUTE FUNCTION app.guard_invoice_line();

CREATE TRIGGER trg_payment_immutable BEFORE UPDATE OR DELETE ON payment
  FOR EACH ROW EXECUTE FUNCTION app.reject_modification();

CREATE OR REPLACE FUNCTION app.guard_decided_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'IMMUTABLE: % yang sudah diputuskan tidak dapat diubah', TG_TABLE_NAME USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_refund_guard BEFORE UPDATE OR DELETE ON refund FOR EACH ROW EXECUTE FUNCTION app.guard_decided_request();
CREATE TRIGGER trg_invoice_void_guard BEFORE UPDATE OR DELETE ON invoice_void FOR EACH ROW EXECUTE FUNCTION app.guard_decided_request();
CREATE TRIGGER trg_stock_adjustment_guard BEFORE UPDATE OR DELETE ON stock_adjustment FOR EACH ROW EXECUTE FUNCTION app.guard_decided_request();

-- ===== 100_integration.sql =====
-- =====================================================================
-- 100 Integration & Outbox — Stage 12 (INT-FR-*), ADR-0004
-- Antrean job memakai pg-boss (skema pgboss dibuat oleh library di Stage 4).
-- =====================================================================
SET search_path = app, public;

CREATE TABLE outbox_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  event_type      text NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DISPATCHED','DONE','FAILED')),
  attempts        int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  dispatched_at   timestamptz
);
CREATE INDEX ix_outbox_pending ON outbox_event(created_at) WHERE status = 'PENDING';
COMMENT ON TABLE outbox_event IS 'Event domain ditulis dalam transaksi yang sama dengan data (ADR-0004); payload hanya ID, tanpa PHI';

CREATE TABLE integration_connection (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  facility_id      uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('SATUSEHAT','LAB','PAYMENT_GATEWAY')),
  environment      text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  secret_ref       text NOT NULL,
  config           jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_test_at     timestamptz,
  last_test_ok     boolean,
  is_active        boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, facility_id, kind, environment),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES facility(tenant_id, id)
);
COMMENT ON TABLE integration_connection IS 'Konfigurasi integrasi; secret_ref menunjuk Secret Manager, bukan nilai rahasia (INT-FR-001)';

CREATE TABLE fhir_sync_record (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  resource_type    text NOT NULL,
  local_type       text NOT NULL,
  local_id         uuid NOT NULL,
  satusehat_id     text,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','ERROR','DEAD','SKIPPED')),
  attempts         int NOT NULL DEFAULT 0,
  last_error       text,
  payload_hash     text,
  last_sent_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, resource_type, local_type, local_id)
);
CREATE INDEX ix_fhir_sync_status ON fhir_sync_record(tenant_id, status, created_at);
COMMENT ON TABLE fhir_sync_record IS 'Status pengiriman per resource FHIR; dasar dashboard & rekonsiliasi (INT-FR-009..011)';

CREATE TABLE integration_dead_letter (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  source          text NOT NULL,
  ref_id          uuid,
  error           text NOT NULL,
  payload_ref     jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     uuid,
  resolution      text
);
COMMENT ON TABLE integration_dead_letter IS 'Kegagalan permanen yang perlu ditangani manual; kirim ulang teraudit (INT-FR-009)';

-- ===== 900_security.sql =====
-- =====================================================================
-- 900 Security — RLS, grants, search_path fungsi (ADR-0002, ADR-0006, ADR-0007)
-- Dijalankan terakhir. Idempoten.
-- =====================================================================
SET search_path = app, public;

-- 1. RLS untuk SEMUA tabel di skema app yang memiliki kolom tenant_id
--    kecuali tabel platform yang dikelola terpisah.
DO $$
DECLARE r record;
  platform_tables text[] := ARRAY['tenant','tenant_subscription','tenant_status_history',
                                  'tenant_feature_flag','support_access_grant','tenant_export_job'];
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
     WHERE c.relkind IN ('r','p') AND NOT c.relispartition
  LOOP
    IF r.relname = ANY(platform_tables) THEN CONTINUE; END IF;
    PERFORM app.enable_tenant_rls(r.tbl);
  END LOOP;
END $$;

-- Tabel tenant: app hanya boleh membaca baris tenant aktifnya sendiri.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON tenant;
CREATE POLICY tenant_self ON tenant FOR SELECT TO clinicrme_app, clinicrme_readonly
  USING (id = app.current_tenant_id());
DROP POLICY IF EXISTS tenant_platform ON tenant;
CREATE POLICY tenant_platform ON tenant TO clinicrme_platform USING (true) WITH CHECK (true);

-- 2. Trigger touch_row untuk tabel yang memiliki updated_at & version
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl, c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app'
     WHERE c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = c.oid AND attname = 'version' AND NOT attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = c.oid AND attname = 'updated_by' AND NOT attisdropped)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch ON %s', r.tbl);
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app.touch_row()', r.tbl);
  END LOOP;
END $$;

-- 3. search_path tetap untuk semua fungsi app (mencegah search_path hijacking)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'app' AND p.prokind = 'f'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = app, public', r.fn);
  END LOOP;
END $$;

-- 4. Grants
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;

-- clinicrme_app: DML pada tabel tenant
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO clinicrme_app;
-- tabel global: hanya baca
REVOKE INSERT, UPDATE, DELETE ON permission, menu_item, region, code_system, concept FROM clinicrme_app;
-- tabel platform: hanya baca tenant sendiri (melalui policy)
REVOKE ALL ON tenant_subscription, tenant_status_history, tenant_feature_flag,
              support_access_grant, tenant_export_job, subscription_plan FROM clinicrme_app;
GRANT SELECT ON subscription_plan, tenant_feature_flag TO clinicrme_app;
REVOKE INSERT, UPDATE, DELETE ON tenant FROM clinicrme_app;
-- append-only: tanpa UPDATE/DELETE
REVOKE UPDATE, DELETE ON payment, stock_movement, clinical_addendum, medical_document FROM clinicrme_app;
-- saldo stok & kepala audit hanya lewat trigger/fungsi
REVOKE INSERT, UPDATE, DELETE ON stock_balance FROM clinicrme_app;
-- audit: tidak ada akses tulis langsung
REVOKE ALL ON audit_log, audit_chain_head FROM clinicrme_app;
GRANT SELECT ON audit_log TO clinicrme_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO clinicrme_app;
REVOKE EXECUTE ON FUNCTION app.verify_audit_chain(uuid) FROM clinicrme_app;

-- clinicrme_readonly
GRANT SELECT ON ALL TABLES IN SCHEMA app TO clinicrme_readonly;
REVOKE SELECT ON user_credential, user_mfa, user_invitation, user_session FROM clinicrme_readonly;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_user_id() TO clinicrme_readonly;

-- clinicrme_platform: hanya tabel platform (tanpa data klinis — PLT-FR-009)
GRANT SELECT, INSERT, UPDATE ON tenant, subscription_plan, tenant_subscription, tenant_status_history,
                                tenant_feature_flag, support_access_grant, tenant_export_job TO clinicrme_platform;

-- Trigger stok berjalan sebagai pemilik agar dapat memperbarui stock_balance
ALTER FUNCTION app.apply_stock_movement() SECURITY DEFINER;

