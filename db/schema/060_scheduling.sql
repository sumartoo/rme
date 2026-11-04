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
