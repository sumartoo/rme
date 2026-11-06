-- ClinicRME — migrasi 0016 (Stage 8 batch 2): jadwal dokter & janji temu (SCH-FR-001..003, 010, 011; OD-087, OD-090 / DEC-035).
SET search_path = app, public;

-- 1. Jadwal praktik: status & versi baris; satu dokter tidak boleh punya dua sesi yang tumpang tindih (hari, jam, dan
--    masa berlaku), termasuk di cabang berbeda. Kuota = jumlah janji temu per sesi, tidak boleh melebihi jumlah slot (OD-090).
CREATE TYPE app.timerange AS RANGE (subtype = time);
ALTER TABLE practitioner_schedule
  ADD COLUMN is_active  boolean NOT NULL DEFAULT true,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_by uuid,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_by uuid,
  ADD COLUMN version    int NOT NULL DEFAULT 1,
  ADD CONSTRAINT schedule_slot_minutes CHECK (slot_minutes BETWEEN 5 AND 120),
  ADD CONSTRAINT schedule_period CHECK (valid_to IS NULL OR valid_to >= valid_from),
  ADD CONSTRAINT schedule_quota_fits CHECK (quota * slot_minutes * 60 <= extract(epoch FROM (end_time - start_time))),
  ADD CONSTRAINT ex_schedule_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, practitioner_id WITH =, day_of_week WITH =,
    app.timerange(start_time, end_time) WITH &&,
    daterange(valid_from, valid_to, '[]') WITH &&
  ) WHERE (is_active);
CREATE TRIGGER trg_touch BEFORE UPDATE ON practitioner_schedule FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE INDEX ix_schedule_branch_day ON practitioner_schedule(tenant_id, branch_id, day_of_week) WHERE is_active;
-- Jadwal dirujuk janji temu → tidak dihapus, dinonaktifkan / diberi tanggal akhir.
REVOKE DELETE ON practitioner_schedule FROM clinicrme_app;

-- 2. Pengecualian: cuti dokter (semua cabang) ATAU libur cabang — tepat salah satu; satu per tanggal.
ALTER TABLE schedule_exception
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_by uuid,
  ADD CONSTRAINT schedule_exception_one_target CHECK ((practitioner_id IS NULL) <> (branch_id IS NULL));
CREATE UNIQUE INDEX ux_schedule_exception_practitioner ON schedule_exception(tenant_id, practitioner_id, exception_date) WHERE practitioner_id IS NOT NULL;
CREATE UNIQUE INDEX ux_schedule_exception_branch ON schedule_exception(tenant_id, branch_id, exception_date) WHERE branch_id IS NOT NULL;

-- 3. Janji temu: satu slot dokter = satu janji temu aktif; pasien tidak dapat dua janji di jam yang sama.
ALTER TABLE appointment
  ADD COLUMN slot_end timestamptz,
  ADD COLUMN notes    text,
  ADD CONSTRAINT appointment_slot_order CHECK (slot_end IS NULL OR slot_end > slot_start),
  ADD CONSTRAINT appointment_rescheduled_link CHECK (status <> 'RESCHEDULED' OR rescheduled_to_id IS NOT NULL);
CREATE UNIQUE INDEX ux_appointment_practitioner_slot ON appointment(tenant_id, practitioner_id, slot_start) WHERE status IN ('BOOKED','CHECKED_IN');
CREATE UNIQUE INDEX ux_appointment_patient_slot ON appointment(tenant_id, patient_id, slot_start) WHERE status IN ('BOOKED','CHECKED_IN');
CREATE INDEX ix_appointment_patient ON appointment(tenant_id, patient_id, slot_start DESC);
CREATE INDEX ix_appointment_branch_day ON appointment(tenant_id, branch_id, slot_start);
CREATE INDEX ix_appointment_due ON appointment(tenant_id, slot_start) WHERE status = 'BOOKED';
-- Riwayat janji temu tidak dihapus (batal/no-show = status beralasan).
REVOKE DELETE ON appointment FROM clinicrme_app;

-- 4. Menu pelayanan
INSERT INTO menu_item(code, parent_code, label, route, icon, required_permission, sort_order) VALUES
  ('service.appointments', 'service', 'Janji temu',   '/appointments', 'calendar-check', 'appointment.read', 120),
  ('service.schedules',    'service', 'Jadwal dokter', '/schedules',   'calendar',       'schedule.read',    130)
ON CONFLICT (code) DO UPDATE SET parent_code = EXCLUDED.parent_code, label = EXCLUDED.label, route = EXCLUDED.route,
  icon = EXCLUDED.icon, required_permission = EXCLUDED.required_permission, sort_order = EXCLUDED.sort_order;
