-- ClinicRME — migrasi 0005 (Stage 5 batch 3b)
-- 1) Notifikasi lewat outbox (ADR-0004): setiap undangan user → event INVITATION_CREATED (email dikirim worker).
-- 2) Break-glass akses dukungan (PLT-FR-009, OD-076, OD-077): grant berbatas waktu; selama berlaku support hanya dapat
--    MEMBACA daftar user/role & log audit tenant lewat fungsi sempit (tanpa data pasien), setiap pembacaan diaudit.
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- 1. Outbox
-- ---------------------------------------------------------------------
-- Worker (pemilik, OD-074) mengklaim event lintas tenant tanpa tenant context; FORCE RLS butuh policy eksplisit
-- untuk pemilik non-superuser. Isi event hanya ID/teks non-PHI; penerima diambil worker sebagai clinicrme_app.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY outbox_worker ON outbox_event TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

CREATE OR REPLACE FUNCTION app.enqueue_invitation_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $$
BEGIN
  INSERT INTO outbox_event(tenant_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES (NEW.tenant_id, 'INVITATION_CREATED', 'user_invitation', NEW.id, '{}'::jsonb);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.enqueue_invitation_email() FROM PUBLIC;
CREATE TRIGGER trg_invitation_outbox AFTER INSERT ON user_invitation
  FOR EACH ROW EXECUTE FUNCTION app.enqueue_invitation_email();

-- ---------------------------------------------------------------------
-- 2. Break-glass
-- ---------------------------------------------------------------------
ALTER TABLE support_access_grant
  ADD CONSTRAINT support_access_grant_user_fk FOREIGN KEY (platform_user) REFERENCES platform_user(id),
  ADD COLUMN revoked_by uuid REFERENCES platform_user(id),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX ix_support_access_grant_tenant ON support_access_grant(tenant_id, expires_at DESC);
REVOKE DELETE ON support_access_grant FROM clinicrme_platform;

/** Grant berlaku untuk pengguna ini? Juga membuka tenant context + aktor untuk audit. Internal (tidak di-GRANT). */
CREATE OR REPLACE FUNCTION app.support_open(p_grant uuid, p_user uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $$
DECLARE v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM support_access_grant
   WHERE id = p_grant AND platform_user = p_user AND revoked_at IS NULL
     AND now() >= starts_at AND now() < expires_at;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'PLT-403-GRANT: akses dukungan tidak berlaku (kedaluwarsa, dicabut, atau bukan milik Anda)' USING ERRCODE = 'CRG01';
  END IF;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  PERFORM set_config('app.user_id', p_user::text, true);
  RETURN v_tenant;
END $$;
REVOKE ALL ON FUNCTION app.support_open(uuid, uuid) FROM PUBLIC;

/** Daftar user & role tenant (tanpa kredensial) untuk troubleshooting akses. */
CREATE OR REPLACE FUNCTION app.support_read_users(p_grant uuid, p_user uuid)
RETURNS TABLE(user_id uuid, email text, full_name text, status text, last_login_at timestamptz, roles text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $$
DECLARE v_tenant uuid := app.support_open(p_grant, p_user);
BEGIN
  PERFORM app.write_audit('SUPPORT_VIEWED_USERS', 'support_access_grant', p_grant, NULL, NULL, 'PLATFORM_SUPPORT', NULL, NULL);
  RETURN QUERY
    SELECT u.id, u.email, u.full_name, u.status, u.last_login_at,
           coalesce(array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '{}')
      FROM app_user u
      LEFT JOIN user_role_assignment a ON a.user_id = u.id AND a.tenant_id = v_tenant AND (a.valid_to IS NULL OR a.valid_to > now())
      LEFT JOIN role r ON r.id = a.role_id AND r.tenant_id = v_tenant
     WHERE u.tenant_id = v_tenant
     GROUP BY u.id ORDER BY u.email;
END $$;

/** Log audit tenant terbaru (tanpa patient_id, IP, user agent). Keyset mundur dengan p_before_seq. */
CREATE OR REPLACE FUNCTION app.support_read_audit(p_grant uuid, p_user uuid, p_limit int, p_before_seq bigint)
RETURNS TABLE(seq bigint, occurred_at timestamptz, actor_kind text, actor_user_id uuid, action text, resource_type text, resource_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $$
DECLARE v_tenant uuid := app.support_open(p_grant, p_user);
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'PLT-400-LIMIT: limit 1..200' USING ERRCODE = 'CRP01';
  END IF;
  PERFORM app.write_audit('SUPPORT_VIEWED_AUDIT', 'support_access_grant', p_grant, NULL,
    jsonb_build_object('limit', p_limit, 'before_seq', p_before_seq), 'PLATFORM_SUPPORT', NULL, NULL);
  RETURN QUERY
    SELECT l.seq, l.occurred_at, l.actor_kind, l.actor_user_id, l.action, l.resource_type, l.resource_id
      FROM audit_log l
     WHERE l.tenant_id = v_tenant AND (p_before_seq IS NULL OR l.seq < p_before_seq)
       AND l.action NOT IN ('SUPPORT_VIEWED_USERS', 'SUPPORT_VIEWED_AUDIT')
     ORDER BY l.seq DESC LIMIT p_limit;
END $$;

/** Event notifikasi break-glass (diberikan/dicabut) — hanya jenis ini yang boleh dikirim konsol platform. */
CREATE OR REPLACE FUNCTION app.enqueue_support_notification(p_grant uuid, p_event text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $$
DECLARE g support_access_grant;
BEGIN
  IF p_event NOT IN ('SUPPORT_ACCESS_GRANTED', 'SUPPORT_ACCESS_REVOKED') THEN
    RAISE EXCEPTION 'jenis event tidak diizinkan' USING ERRCODE = 'CRP01';
  END IF;
  SELECT * INTO g FROM support_access_grant WHERE id = p_grant;
  IF g.id IS NULL THEN RAISE EXCEPTION 'grant tidak ditemukan' USING ERRCODE = 'CRP01'; END IF;
  INSERT INTO outbox_event(tenant_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES (g.tenant_id, p_event, 'support_access_grant', g.id, '{}'::jsonb);
END $$;

/** Detail grant untuk isi email (dibaca worker sebagai clinicrme_app; tabel grant sendiri tertutup bagi aplikasi). */
CREATE OR REPLACE FUNCTION app.support_grant_for_notification(p_grant uuid)
RETURNS TABLE(reason text, starts_at timestamptz, expires_at timestamptz, revoked_at timestamptz, support_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public AS $$
  SELECT g.reason, g.starts_at, g.expires_at, g.revoked_at, u.full_name
    FROM support_access_grant g JOIN platform_user u ON u.id = g.platform_user
   WHERE g.id = p_grant AND g.tenant_id = app.current_tenant_id()
$$;

REVOKE ALL ON FUNCTION app.support_read_users(uuid, uuid), app.support_read_audit(uuid, uuid, int, bigint),
  app.enqueue_support_notification(uuid, text), app.support_grant_for_notification(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.support_read_users(uuid, uuid), app.support_read_audit(uuid, uuid, int, bigint),
  app.enqueue_support_notification(uuid, text) TO clinicrme_platform;
GRANT EXECUTE ON FUNCTION app.support_grant_for_notification(uuid) TO clinicrme_app;
