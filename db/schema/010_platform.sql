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
