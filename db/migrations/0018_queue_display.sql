-- ClinicRME — migrasi 0018 (Stage 8 batch 4): layar TV antrean (SCH-FR-008; OD-088, OD-089 / DEC-035).
SET search_path = app, public;

-- Tautan layar per cabang: TV tidak login sebagai user. Token acak 32 byte hanya diberikan sekali saat dibuat;
-- database menyimpan hash-nya. Dapat dicabut kapan saja. Layar hanya membaca data antrean cabang itu.
CREATE TABLE queue_display_link (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  branch_id     uuid NOT NULL,
  label         text NOT NULL CHECK (length(label) BETWEEN 2 AND 100),
  token_hash    text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  revoked_at    timestamptz,
  revoked_by    uuid,
  last_seen_at  timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branch(tenant_id, id)
);
CREATE UNIQUE INDEX ux_queue_display_token ON queue_display_link(tenant_id, token_hash);
COMMENT ON TABLE queue_display_link IS 'Tautan layar TV antrean per cabang (OD-088); token disimpan sebagai hash, dapat dicabut';
SELECT app.enable_tenant_rls('app.queue_display_link'::regclass);
GRANT SELECT, INSERT, UPDATE ON queue_display_link TO clinicrme_app;

INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('admin.queue-displays', 'admin', 'Layar antrean', '/admin/queue-displays', 'monitor', 'tenant.profile.manage', 920)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
