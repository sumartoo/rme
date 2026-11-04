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
