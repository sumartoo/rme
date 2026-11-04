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
