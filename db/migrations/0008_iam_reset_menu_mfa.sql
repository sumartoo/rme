-- ClinicRME — migrasi 0008 (Stage 6 batch 1, DEC-029).
-- 1) Reset password (IAM-FR-004): permintaan dicatat tanpa token; token dibuat worker saat email dikirim
--    (hanya hash yang disimpan, token mentah hanya ada di email). Berlaku 30 menit, sekali pakai.
-- 2) MFA DOKTER wajib secara default (DEC-019/OD-024, IAM-FR-005); tenant admin dapat mengubah (OD-080).
-- 3) Menu aplikasi klinik (IAM-FR-010): menu administrasi; menu modul klinis ditambah bersama modulnya.
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- 1. Reset password
-- ---------------------------------------------------------------------
CREATE TABLE password_reset_request (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  user_id     uuid NOT NULL,
  token_hash  text UNIQUE,                 -- diisi worker saat email dikirim
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  used_at     timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id)
);
CREATE INDEX ix_password_reset_user ON password_reset_request(tenant_id, user_id, created_at DESC);
COMMENT ON TABLE password_reset_request IS 'IAM-FR-004: tautan reset sekali pakai 30 menit; token mentah tidak pernah disimpan';
SELECT app.enable_tenant_rls('app.password_reset_request'::regclass);
GRANT SELECT, INSERT, UPDATE ON password_reset_request TO clinicrme_app;
-- Worker (pemilik) mengirim email lintas tenant; FORCE RLS butuh policy eksplisit untuk pemilik non-superuser
DO $$ BEGIN
  EXECUTE format('CREATE POLICY reset_worker ON password_reset_request TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

CREATE OR REPLACE FUNCTION app.enqueue_password_reset_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $$
BEGIN
  INSERT INTO outbox_event(tenant_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES (NEW.tenant_id, 'PASSWORD_RESET_REQUESTED', 'password_reset_request', NEW.id, '{}'::jsonb);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.enqueue_password_reset_email() FROM PUBLIC;
CREATE TRIGGER trg_password_reset_outbox AFTER INSERT ON password_reset_request
  FOR EACH ROW EXECUTE FUNCTION app.enqueue_password_reset_email();

-- Undangan: token juga dibuat ulang worker saat email dikirim (untuk "Buat password", OD-078)
ALTER TABLE user_invitation ADD COLUMN token_sent_at timestamptz;

-- ---------------------------------------------------------------------
-- 2. MFA DOKTER default aktif (DEC-019) — template untuk tenant baru + role template tenant yang sudah ada
-- ---------------------------------------------------------------------
DO $$
DECLARE def text := pg_get_functiondef('app.create_template_roles()'::regprocedure);
BEGIN
  IF position($q$'DOKTER', 'Dokter', true, false)$q$ IN def) = 0 THEN
    RAISE EXCEPTION 'create_template_roles berubah — perbarui migrasi 0008';
  END IF;
  EXECUTE replace(def, $q$'DOKTER', 'Dokter', true, false)$q$, $q$'DOKTER', 'Dokter', true, true)$q$);
END $$;
UPDATE role SET requires_mfa = true WHERE code = 'DOKTER' AND is_template;

-- ---------------------------------------------------------------------
-- 3. Menu (global, hanya-baca bagi aplikasi)
-- ---------------------------------------------------------------------
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('admin',          NULL,    'Pengaturan klinik', NULL,               'settings',  NULL,                    900),
  ('admin.profile',  'admin', 'Profil klinik',     '/admin/profile',   'building',  'tenant.profile.read',   910),
  ('admin.users',    'admin', 'Pengguna',          '/admin/users',     'users',     'iam.user.read',         920),
  ('admin.roles',    'admin', 'Role & izin',       '/admin/roles',     'shield',    'iam.role.read',         930),
  ('admin.exports',  'admin', 'Ekspor data',       '/admin/exports',   'download',  'tenant.data.export',    940),
  ('admin.audit',    'admin', 'Log audit',         '/admin/audit',     'scroll',    'audit.log.read',        950),
  ('account',        NULL,    'Akun saya',         NULL,               'user',      NULL,                    990),
  ('account.sessions','account','Sesi & perangkat','/account/sessions','monitor',   NULL,                    991)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
