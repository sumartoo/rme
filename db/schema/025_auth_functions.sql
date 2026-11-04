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
