-- ClinicRME — migrasi 0003 (Stage 5 batch 1, CR-0001)
-- 1) Identitas platform: pengguna, kredensial, MFA, sesi, audit platform — hanya untuk clinicrme_platform.
-- 2) Siklus status tenant ditegakkan di database (trigger) + kode tenant tercadang.
-- 3) Provisioning tenant lewat satu fungsi SECURITY DEFINER sempit (PLT-FR-001).
-- 4) Kuota paket (user aktif & cabang) ditegakkan di database (PLT-FR-004).
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- 1. Identitas platform (tanpa tenant_id; tidak pernah dapat diakses clinicrme_app)
-- ---------------------------------------------------------------------
CREATE TABLE platform_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  full_name     text NOT NULL,
  roles         text[] NOT NULL CHECK (cardinality(roles) > 0 AND roles <@ ARRAY['PLATFORM_ADMIN','PLATFORM_SUPPORT']),
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
COMMENT ON TABLE platform_user IS 'Pengguna konsol platform (CR-0001). Terpisah dari app_user; MFA wajib.';

CREATE TABLE platform_credential (
  user_id             uuid PRIMARY KEY REFERENCES platform_user(id),
  password_hash       text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts     int NOT NULL DEFAULT 0,
  locked_until        timestamptz
);

CREATE TABLE platform_mfa (
  user_id               uuid PRIMARY KEY REFERENCES platform_user(id),
  totp_secret_encrypted bytea NOT NULL,
  recovery_codes_hash   text[] NOT NULL DEFAULT '{}',
  enabled_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_session (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES platform_user(id),
  token_hash          text NOT NULL UNIQUE,
  mfa_verified        boolean NOT NULL DEFAULT false,
  mfa_failed_attempts int NOT NULL DEFAULT 0,
  ip                  inet,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoke_reason       text
);
COMMENT ON COLUMN platform_session.token_hash IS 'SHA-256 token sesi konsol platform (cookie crme_psession)';

CREATE TABLE platform_audit_log (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_platform_user uuid,
  action              text NOT NULL,
  target_tenant_id    uuid,
  resource_type       text,
  resource_id         text,
  ip                  inet,
  request_id          text,
  change_summary      jsonb
);
COMMENT ON TABLE platform_audit_log IS 'Audit aksi konsol platform (login, provisioning, status, flag). Append-only.';
CREATE TRIGGER trg_platform_audit_immutable BEFORE UPDATE OR DELETE ON platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION app.reject_modification();

REVOKE ALL ON platform_user, platform_credential, platform_mfa, platform_session, platform_audit_log
  FROM PUBLIC, clinicrme_app, clinicrme_readonly;
GRANT SELECT, INSERT, UPDATE ON platform_user, platform_credential, platform_mfa, platform_session TO clinicrme_platform;
GRANT SELECT, INSERT ON platform_audit_log TO clinicrme_platform;

-- Aksi platform pada tenant dicatat di rantai audit tenant itu dengan actor_kind PLATFORM
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_kind_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_kind_check
  CHECK (actor_kind IN ('USER','SYSTEM','PLATFORM_SUPPORT','PLATFORM'));
GRANT EXECUTE ON FUNCTION app.write_audit(text, text, uuid, uuid, jsonb, text, inet, text) TO clinicrme_platform;
-- touch_row() pada tenant dan write_audit memakai fungsi konteks ini
GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_user_id() TO clinicrme_platform;

-- ---------------------------------------------------------------------
-- 2. Siklus status tenant & kode tercadang
-- ---------------------------------------------------------------------
ALTER TABLE tenant ADD CONSTRAINT tenant_code_not_reserved
  CHECK (code NOT IN ('admin','api','app','www','platform','static','status','mail','support','login','auth'));

CREATE OR REPLACE FUNCTION app.tenant_status_transition_allowed(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = app, public AS $$
  SELECT (p_from, p_to) IN (
    ('PROVISIONING','TRIAL'), ('PROVISIONING','ACTIVE'),
    ('TRIAL','ACTIVE'), ('TRIAL','GRACE'), ('TRIAL','SUSPENDED'),
    ('ACTIVE','GRACE'), ('ACTIVE','SUSPENDED'),
    ('GRACE','ACTIVE'), ('GRACE','SUSPENDED'),
    ('SUSPENDED','ACTIVE'), ('SUSPENDED','TERMINATED')
  )
$$;
COMMENT ON FUNCTION app.tenant_status_transition_allowed(text, text) IS
  'Mesin status tenant (STAGE_05 §3.2). TERMINATED final; terminasi hanya dari SUSPENDED. Cermin di libs/platform tenant-status.ts';

CREATE OR REPLACE FUNCTION app.enforce_tenant_status_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, public AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT app.tenant_status_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'PLT-409-STATUS: transisi status % → % tidak diizinkan', OLD.status, NEW.status USING ERRCODE = 'CRS01';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.tenant_status_transition_allowed(text, text), app.enforce_tenant_status_transition() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_status_transition_allowed(text, text) TO clinicrme_platform;
CREATE TRIGGER trg_tenant_status_transition BEFORE UPDATE OF status ON tenant
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_status_transition();

-- ---------------------------------------------------------------------
-- 3. Provisioning tenant (PLT-FR-001/002/003)
--    Tenant + langganan + role template + undangan tenant admin pertama + audit, dalam satu transaksi.
--    Token undangan mentah dibuat di aplikasi; yang disimpan hanya hash-nya.
-- ---------------------------------------------------------------------
-- Fungsi SECURITY DEFINER di bawah berjalan sebagai pemilik migrasi. `tenant` memakai FORCE RLS,
-- jadi pemilik non-superuser (mis. Cloud SQL) butuh policy eksplisit agar fungsi tetap bekerja.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY tenant_definer ON tenant TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

CREATE OR REPLACE FUNCTION app.provision_tenant(
  p_code text, p_legal_name text, p_display_name text, p_tenant_type text, p_plan_id uuid,
  p_trial_days int, p_admin_email text, p_invite_token_hash text, p_actor uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $$
DECLARE
  v_tenant uuid;
  v_admin_role uuid;
  v_first text := CASE WHEN coalesce(p_trial_days, 0) > 0 THEN 'TRIAL' ELSE 'ACTIVE' END;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM subscription_plan WHERE id = p_plan_id AND is_active) THEN
    RAISE EXCEPTION 'PLT-400-PLAN: paket tidak ditemukan atau tidak aktif' USING ERRCODE = 'CRP01';
  END IF;
  IF p_trial_days IS NOT NULL AND (p_trial_days < 0 OR p_trial_days > 90) THEN
    RAISE EXCEPTION 'PLT-400-TRIAL: masa trial 0..90 hari' USING ERRCODE = 'CRP01';
  END IF;

  INSERT INTO tenant(code, legal_name, display_name, tenant_type, status, updated_by)
  VALUES (p_code, p_legal_name, coalesce(nullif(trim(p_display_name), ''), p_legal_name), p_tenant_type, 'PROVISIONING', p_actor)
  RETURNING id INTO v_tenant;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  PERFORM set_config('app.user_id', coalesce(p_actor::text, ''), true);
  INSERT INTO tenant_status_history(tenant_id, from_status, to_status, reason, actor_id)
  VALUES (v_tenant, NULL, 'PROVISIONING', 'Tenant dibuat', p_actor);

  INSERT INTO tenant_subscription(tenant_id, plan_id, start_at, trial_end_at, is_current)
  VALUES (v_tenant, p_plan_id, now(),
          CASE WHEN coalesce(p_trial_days, 0) > 0 THEN now() + make_interval(days => p_trial_days) END, true);

  PERFORM app.create_template_roles();
  SELECT id INTO v_admin_role FROM role WHERE tenant_id = v_tenant AND code = 'TENANT_ADMIN';

  INSERT INTO user_invitation(tenant_id, email, role_ids, token_hash, invited_by, expires_at)
  VALUES (v_tenant, lower(p_admin_email), ARRAY[v_admin_role], p_invite_token_hash, NULL, now() + interval '7 days');

  UPDATE tenant SET status = v_first WHERE id = v_tenant;
  INSERT INTO tenant_status_history(tenant_id, from_status, to_status, reason, actor_id)
  VALUES (v_tenant, 'PROVISIONING', v_first, 'Provisioning selesai', p_actor);

  PERFORM app.write_audit('TENANT_PROVISIONED', 'tenant', v_tenant, NULL,
    jsonb_build_object('code', p_code, 'plan_id', p_plan_id, 'trial_days', coalesce(p_trial_days, 0), 'status', v_first),
    'PLATFORM', NULL, NULL);
  RETURN v_tenant;
END $$;
COMMENT ON FUNCTION app.provision_tenant IS 'PLT-FR-001: satu-satunya jalur membuat tenant (dipanggil konsol platform)';
REVOKE ALL ON FUNCTION app.provision_tenant(text, text, text, text, uuid, int, text, text, uuid) FROM PUBLIC, clinicrme_app, clinicrme_readonly;
GRANT EXECUTE ON FUNCTION app.provision_tenant(text, text, text, text, uuid, int, text, text, uuid) TO clinicrme_platform;

-- ---------------------------------------------------------------------
-- 4. Kuota paket (PLT-FR-004) — ditegakkan untuk SEMUA jalur tulis, bukan hanya UI/API
--    Tenant tanpa langganan aktif (hanya data uji lama) tidak dibatasi; provisioning selalu membuat langganan.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.enforce_plan_quota() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $$
DECLARE v_max int; v_count int; v_kind text := TG_ARGV[0];
BEGIN
  -- Hanya penambahan unit aktif yang dihitung (insert aktif / reaktivasi). Cabang IF terpisah karena
  -- PL/pgSQL meresolusi NEW.<kolom> saat evaluasi: app_user tidak punya is_active, branch tidak punya status.
  IF v_kind = 'users' THEN
    IF NEW.status <> 'ACTIVE' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' THEN IF OLD.status = 'ACTIVE' THEN RETURN NEW; END IF; END IF;
  ELSE
    IF NOT NEW.is_active THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' THEN IF OLD.is_active THEN RETURN NEW; END IF; END IF;
  END IF;
  -- Serialisasi per tenant agar dua penambahan bersamaan tidak sama-sama lolos
  PERFORM 1 FROM tenant WHERE id = NEW.tenant_id FOR UPDATE;
  SELECT CASE v_kind WHEN 'users' THEN p.max_users ELSE p.max_branches END INTO v_max
    FROM tenant_subscription s JOIN subscription_plan p ON p.id = s.plan_id
   WHERE s.tenant_id = NEW.tenant_id AND s.is_current;
  IF v_max IS NULL THEN RETURN NEW; END IF;
  IF v_kind = 'users' THEN
    SELECT count(*) INTO v_count FROM app_user WHERE tenant_id = NEW.tenant_id AND status = 'ACTIVE' AND id <> NEW.id;
  ELSE
    SELECT count(*) INTO v_count FROM branch WHERE tenant_id = NEW.tenant_id AND is_active AND id <> NEW.id;
  END IF;
  IF v_count + 1 > v_max THEN
    RAISE EXCEPTION 'PLT-403-QUOTA: batas % paket (%) tercapai', CASE v_kind WHEN 'users' THEN 'user aktif' ELSE 'cabang' END, v_max
      USING ERRCODE = 'CRQ01';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.enforce_plan_quota() FROM PUBLIC;
CREATE TRIGGER trg_quota_users BEFORE INSERT OR UPDATE OF status ON app_user
  FOR EACH ROW EXECUTE FUNCTION app.enforce_plan_quota('users');
CREATE TRIGGER trg_quota_branches BEFORE INSERT OR UPDATE OF is_active ON branch
  FOR EACH ROW EXECUTE FUNCTION app.enforce_plan_quota('branches');

-- ---------------------------------------------------------------------
-- 5. Paket awal untuk pilot (harga diputuskan PO — OD-070; dapat diubah lewat migrasi berikutnya)
-- ---------------------------------------------------------------------
INSERT INTO subscription_plan(code, name, max_users, max_branches, features, monthly_price)
VALUES ('PILOT', 'Pilot (tanpa biaya)', 25, 2, '{"pharmacy": true, "billing": true, "lab": true}'::jsonb, 0)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- 6. Katalog permission: platform.tenant.read (CR-0001). Permission platform tidak pernah dipetakan ke role tenant;
--    pemetaan role platform → permission ada di libs/platform (PLATFORM_ROLE_PERMISSIONS).
-- ---------------------------------------------------------------------
INSERT INTO permission(code, module, description)
VALUES ('platform.tenant.read', 'platform', 'platformPlanList; platformTenantGet; platformTenantList')
ON CONFLICT (code) DO NOTHING;
