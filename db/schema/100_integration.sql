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
