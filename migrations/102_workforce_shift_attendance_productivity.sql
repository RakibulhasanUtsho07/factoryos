BEGIN;

-- Workforce v1: factory-scoped workers, skills, shift templates, roster assignments,
-- immutable attendance evidence, approved overtime and standard-minute productivity.
INSERT INTO permissions (code, description) VALUES
  ('workforce.workers.read', 'Read worker identities in an authorized factory'),
  ('workforce.workers.manage', 'Create and maintain factory-scoped workers and consent evidence'),
  ('workforce.skills.read', 'Read skills, certifications and skill matrix data'),
  ('workforce.skills.manage', 'Maintain skills, worker proficiency and certification validity'),
  ('workforce.shifts.read', 'Read shift templates and staffing rosters'),
  ('workforce.shifts.manage', 'Create shift templates and allocate workers to shifts'),
  ('workforce.staffing.read', 'Read staffing coverage and authorized backfill recommendations'),
  ('workforce.staffing.manage', 'Create and transition shift staffing assignments'),
  ('workforce.attendance.read', 'Read factory attendance and overtime records'),
  ('workforce.attendance.capture', 'Capture manual, QR, API or consented biometric attendance events'),
  ('workforce.overtime.read', 'Read approved-scope overtime requests and decisions'),
  ('workforce.overtime.request', 'Request overtime against verified attendance intervals'),
  ('workforce.overtime.approve', 'Approve or reject overtime with maker-checker enforcement'),
  ('workforce.productivity.read', 'Read operator productivity and efficiency measures'),
  ('workforce.productivity.capture', 'Capture worker-attributed production and labor minutes'),
  ('workforce.self.read', 'Read only the authenticated worker own attendance and overtime records')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'workforce.%'
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE workforce_workers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  linked_user_id UUID,
  employee_code VARCHAR(100) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  biometric_consent_at TIMESTAMPTZ,
  biometric_consent_withdrawn_at TIMESTAMPTZ,
  last_change_reason TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_workforce_worker_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_workforce_worker_user_scope UNIQUE (id, linked_user_id, tenant_id, factory_id),
  CONSTRAINT uq_workforce_worker_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_workforce_worker_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_worker_linked_user FOREIGN KEY (linked_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_worker_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_worker_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_workforce_worker_code CHECK (length(btrim(employee_code)) BETWEEN 1 AND 100),
  CONSTRAINT chk_workforce_worker_name CHECK (length(btrim(display_name)) BETWEEN 1 AND 255),
  CONSTRAINT chk_workforce_worker_status CHECK (status IN ('ACTIVE','INACTIVE')),
  CONSTRAINT chk_workforce_worker_version CHECK (row_version > 0),
  CONSTRAINT chk_workforce_worker_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_workforce_worker_consent_order CHECK (
    biometric_consent_withdrawn_at IS NULL OR biometric_consent_at IS NOT NULL
  )
);
CREATE UNIQUE INDEX uq_workforce_worker_code
  ON workforce_workers (tenant_id, factory_id, lower(employee_code));
CREATE UNIQUE INDEX uq_workforce_worker_linked_user
  ON workforce_workers (tenant_id, factory_id, linked_user_id)
  WHERE linked_user_id IS NOT NULL;
CREATE INDEX idx_workforce_workers_active
  ON workforce_workers (tenant_id, factory_id, status, employee_code);

CREATE TABLE workforce_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  skill_code VARCHAR(120) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_workforce_skill_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_workforce_skill_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_workforce_skill_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_skill_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_skill_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_workforce_skill_code CHECK (length(btrim(skill_code)) BETWEEN 1 AND 120),
  CONSTRAINT chk_workforce_skill_name CHECK (length(btrim(name)) BETWEEN 1 AND 255),
  CONSTRAINT chk_workforce_skill_status CHECK (status IN ('ACTIVE','INACTIVE')),
  CONSTRAINT chk_workforce_skill_version CHECK (row_version > 0),
  CONSTRAINT chk_workforce_skill_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX uq_workforce_skill_code
  ON workforce_skills (tenant_id, factory_id, lower(skill_code));

CREATE TABLE workforce_worker_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  worker_id UUID NOT NULL,
  skill_id UUID NOT NULL,
  skill_level SMALLINT NOT NULL,
  certified_on DATE,
  certificate_expires_on DATE,
  certificate_reference VARCHAR(255),
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_workforce_worker_skill_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_workforce_worker_skill_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_workforce_worker_skill_worker FOREIGN KEY (worker_id, tenant_id, factory_id)
    REFERENCES workforce_workers(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_worker_skill_skill FOREIGN KEY (skill_id, tenant_id, factory_id)
    REFERENCES workforce_skills(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_worker_skill_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_worker_skill_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_workforce_worker_skill_level CHECK (skill_level BETWEEN 1 AND 5),
  CONSTRAINT chk_workforce_worker_skill_dates CHECK (
    certificate_expires_on IS NULL OR certified_on IS NULL OR certificate_expires_on >= certified_on
  ),
  CONSTRAINT chk_workforce_worker_skill_status CHECK (status IN ('ACTIVE','INACTIVE')),
  CONSTRAINT chk_workforce_worker_skill_version CHECK (row_version > 0),
  CONSTRAINT chk_workforce_worker_skill_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX uq_workforce_worker_skill_active
  ON workforce_worker_skills (tenant_id, factory_id, worker_id, skill_id)
  WHERE status = 'ACTIVE';
CREATE INDEX idx_workforce_worker_skills_validity
  ON workforce_worker_skills (tenant_id, factory_id, worker_id, status, certificate_expires_on);

CREATE TABLE workforce_shift_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  shift_code VARCHAR(80) NOT NULL,
  name VARCHAR(255) NOT NULL,
  starts_at_local TIME NOT NULL,
  ends_at_local TIME NOT NULL,
  timezone_name VARCHAR(80) NOT NULL DEFAULT 'Asia/Dhaka',
  unpaid_break_minutes SMALLINT NOT NULL DEFAULT 0,
  late_grace_minutes SMALLINT NOT NULL DEFAULT 0,
  overtime_threshold_minutes SMALLINT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_workforce_shift_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_workforce_shift_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_workforce_shift_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_shift_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_shift_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_workforce_shift_code CHECK (length(btrim(shift_code)) BETWEEN 1 AND 80),
  CONSTRAINT chk_workforce_shift_name CHECK (length(btrim(name)) BETWEEN 1 AND 255),
  CONSTRAINT chk_workforce_shift_timezone CHECK (length(btrim(timezone_name)) > 0),
  CONSTRAINT chk_workforce_shift_start_end CHECK (starts_at_local <> ends_at_local),
  CONSTRAINT chk_workforce_shift_break CHECK (unpaid_break_minutes BETWEEN 0 AND 360),
  CONSTRAINT chk_workforce_shift_grace CHECK (late_grace_minutes BETWEEN 0 AND 180),
  CONSTRAINT chk_workforce_shift_overtime_threshold CHECK (overtime_threshold_minutes BETWEEN 0 AND 1440),
  CONSTRAINT chk_workforce_shift_status CHECK (status IN ('ACTIVE','INACTIVE')),
  CONSTRAINT chk_workforce_shift_version CHECK (row_version > 0),
  CONSTRAINT chk_workforce_shift_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX uq_workforce_shift_code
  ON workforce_shift_templates (tenant_id, factory_id, lower(shift_code));

CREATE TABLE workforce_shift_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  shift_template_id UUID NOT NULL,
  worker_id UUID NOT NULL,
  shift_date DATE NOT NULL,
  planned_start_at TIMESTAMPTZ NOT NULL,
  planned_end_at TIMESTAMPTZ NOT NULL,
  work_order_id UUID,
  work_order_operation_id UUID,
  operation_code VARCHAR(120),
  required_skill_code VARCHAR(120),
  status VARCHAR(16) NOT NULL DEFAULT 'PLANNED',
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  last_change_reason TEXT,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_workforce_assignment_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_workforce_assignment_worker_scope UNIQUE (id, worker_id, tenant_id, factory_id),
  CONSTRAINT uq_workforce_assignment_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_workforce_assignment_shift FOREIGN KEY (shift_template_id, tenant_id, factory_id)
    REFERENCES workforce_shift_templates(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_assignment_worker FOREIGN KEY (worker_id, tenant_id, factory_id)
    REFERENCES workforce_workers(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_assignment_work_order FOREIGN KEY (work_order_id, tenant_id, factory_id)
    REFERENCES work_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_assignment_operation FOREIGN KEY (work_order_operation_id, work_order_id, tenant_id, factory_id)
    REFERENCES work_order_operations(id, work_order_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_assignment_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_assignment_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_workforce_assignment_window CHECK (
    planned_end_at > planned_start_at AND planned_end_at <= planned_start_at + INTERVAL '24 hours'
  ),
  CONSTRAINT chk_workforce_assignment_operation_pair CHECK (
    (work_order_operation_id IS NULL OR work_order_id IS NOT NULL)
  ),
  CONSTRAINT chk_workforce_assignment_operation_code CHECK (
    operation_code IS NULL OR length(btrim(operation_code)) BETWEEN 1 AND 120
  ),
  CONSTRAINT chk_workforce_assignment_skill_code CHECK (
    required_skill_code IS NULL OR length(btrim(required_skill_code)) BETWEEN 1 AND 120
  ),
  CONSTRAINT chk_workforce_assignment_status CHECK (status IN ('PLANNED','CONFIRMED','CANCELLED','COMPLETED')),
  CONSTRAINT chk_workforce_assignment_version CHECK (row_version > 0),
  CONSTRAINT chk_workforce_assignment_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_workforce_assignment_roster
  ON workforce_shift_assignments (tenant_id, factory_id, shift_date, status, planned_start_at);
CREATE INDEX idx_workforce_assignment_worker_window
  ON workforce_shift_assignments (tenant_id, factory_id, worker_id, planned_start_at, planned_end_at)
  WHERE status IN ('PLANNED','CONFIRMED');
-- Keep at most one non-cancelled assignment for one worker/shift/date.
-- A cancelled assignment remains in audit history but must not prevent a replacement.
CREATE UNIQUE INDEX uq_workforce_assignment_shift_worker_date
  ON workforce_shift_assignments (tenant_id, factory_id, shift_template_id, worker_id, shift_date)
  WHERE status <> 'CANCELLED';

CREATE TABLE workforce_attendance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  shift_assignment_id UUID NOT NULL,
  worker_id UUID NOT NULL,
  event_type VARCHAR(24) NOT NULL,
  source_type VARCHAR(16) NOT NULL,
  source_event_id VARCHAR(255),
  occurred_at TIMESTAMPTZ NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  capture_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  request_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_workforce_attendance_event_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_workforce_attendance_event_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_workforce_attendance_assignment FOREIGN KEY (shift_assignment_id, worker_id, tenant_id, factory_id)
    REFERENCES workforce_shift_assignments(id, worker_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_attendance_recorder FOREIGN KEY (recorded_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_workforce_attendance_event_type CHECK (
    event_type IN ('CLOCK_IN','CLOCK_OUT','BREAK_START','BREAK_END','ABSENCE_RECORDED')
  ),
  CONSTRAINT chk_workforce_attendance_source CHECK (source_type IN ('MANUAL','BIOMETRIC','QR','API')),
  CONSTRAINT chk_workforce_attendance_source_event CHECK (
    source_event_id IS NULL OR length(btrim(source_event_id)) BETWEEN 1 AND 255
  ),
  CONSTRAINT chk_workforce_attendance_metadata CHECK (jsonb_typeof(capture_metadata) = 'object'),
  CONSTRAINT chk_workforce_attendance_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX uq_workforce_attendance_source_event
  ON workforce_attendance_events (tenant_id, factory_id, source_type, source_event_id)
  WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX uq_workforce_attendance_clock_in
  ON workforce_attendance_events (shift_assignment_id) WHERE event_type = 'CLOCK_IN';
CREATE UNIQUE INDEX uq_workforce_attendance_clock_out
  ON workforce_attendance_events (shift_assignment_id) WHERE event_type = 'CLOCK_OUT';
CREATE UNIQUE INDEX uq_workforce_attendance_absence
  ON workforce_attendance_events (shift_assignment_id) WHERE event_type = 'ABSENCE_RECORDED';
CREATE INDEX idx_workforce_attendance_assignment_time
  ON workforce_attendance_events (tenant_id, factory_id, shift_assignment_id, occurred_at, id);

CREATE TABLE workforce_overtime_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  shift_assignment_id UUID NOT NULL,
  worker_id UUID NOT NULL,
  requested_minutes INTEGER NOT NULL,
  approved_minutes INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  reason TEXT NOT NULL,
  decision_reason TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  decided_by_user_id UUID,
  decided_at TIMESTAMPTZ,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_workforce_overtime_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_workforce_overtime_assignment UNIQUE (tenant_id, factory_id, shift_assignment_id),
  CONSTRAINT uq_workforce_overtime_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_workforce_overtime_assignment FOREIGN KEY (shift_assignment_id, worker_id, tenant_id, factory_id)
    REFERENCES workforce_shift_assignments(id, worker_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_overtime_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_overtime_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_overtime_decider FOREIGN KEY (decided_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_workforce_overtime_requested CHECK (requested_minutes BETWEEN 1 AND 1440),
  CONSTRAINT chk_workforce_overtime_approved CHECK (approved_minutes BETWEEN 0 AND requested_minutes),
  CONSTRAINT chk_workforce_overtime_status CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  CONSTRAINT chk_workforce_overtime_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT chk_workforce_overtime_decision CHECK (
    (status = 'PENDING' AND decided_by_user_id IS NULL AND decided_at IS NULL AND decision_reason IS NULL AND approved_minutes = 0)
    OR (status = 'APPROVED' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL
      AND length(btrim(COALESCE(decision_reason,''))) > 0)
    OR (status = 'REJECTED' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL
      AND approved_minutes = 0 AND length(btrim(COALESCE(decision_reason,''))) > 0)
  ),
  CONSTRAINT chk_workforce_overtime_version CHECK (row_version > 0),
  CONSTRAINT chk_workforce_overtime_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_workforce_overtime_queue
  ON workforce_overtime_requests (tenant_id, factory_id, status, created_at DESC);

CREATE TABLE workforce_productivity_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  shift_assignment_id UUID NOT NULL,
  worker_id UUID NOT NULL,
  production_report_id UUID NOT NULL,
  work_order_id UUID NOT NULL,
  work_order_operation_id UUID NOT NULL,
  operation_code VARCHAR(120) NOT NULL,
  production_started_at TIMESTAMPTZ NOT NULL,
  production_ended_at TIMESTAMPTZ NOT NULL,
  good_quantity NUMERIC(18,4) NOT NULL,
  scrap_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  standard_minutes_per_unit NUMERIC(12,4) NOT NULL,
  actual_minutes NUMERIC(12,4) NOT NULL,
  earned_minutes NUMERIC(24,8) GENERATED ALWAYS AS (good_quantity * standard_minutes_per_unit) STORED,
  efficiency_percent NUMERIC(12,4) GENERATED ALWAYS AS (
    CASE WHEN actual_minutes > 0
      THEN ROUND(good_quantity * standard_minutes_per_unit * 100 / actual_minutes, 4)
      ELSE 0
    END
  ) STORED,
  scrap_reason TEXT,
  notes TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_workforce_productivity_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_workforce_productivity_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT uq_workforce_productivity_report_worker UNIQUE (production_report_id, worker_id),
  CONSTRAINT fk_workforce_productivity_assignment FOREIGN KEY (shift_assignment_id, worker_id, tenant_id, factory_id)
    REFERENCES workforce_shift_assignments(id, worker_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_productivity_source_report FOREIGN KEY (production_report_id, tenant_id, factory_id)
    REFERENCES order_production_reports(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_productivity_operation FOREIGN KEY (work_order_operation_id, work_order_id, tenant_id, factory_id)
    REFERENCES work_order_operations(id, work_order_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_productivity_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_workforce_productivity_code CHECK (length(btrim(operation_code)) BETWEEN 1 AND 120),
  CONSTRAINT chk_workforce_productivity_interval CHECK (
    production_ended_at > production_started_at
    AND production_ended_at <= production_started_at + INTERVAL '24 hours'
  ),
  CONSTRAINT chk_workforce_productivity_quantities CHECK (good_quantity >= 0 AND scrap_quantity >= 0 AND good_quantity + scrap_quantity > 0),
  CONSTRAINT chk_workforce_productivity_standard_time CHECK (standard_minutes_per_unit > 0),
  CONSTRAINT chk_workforce_productivity_actual_time CHECK (actual_minutes > 0 AND actual_minutes <= 1440),
  CONSTRAINT chk_workforce_productivity_scrap_reason CHECK (
    scrap_quantity = 0 OR length(btrim(COALESCE(scrap_reason,''))) > 0
  ),
  CONSTRAINT chk_workforce_productivity_version CHECK (row_version = 1),
  CONSTRAINT chk_workforce_productivity_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_workforce_productivity_worker_time
  ON workforce_productivity_reports (tenant_id, factory_id, worker_id, created_at DESC);
CREATE INDEX idx_workforce_productivity_operation
  ON workforce_productivity_reports (tenant_id, factory_id, work_order_id, work_order_operation_id, created_at DESC);

CREATE TABLE workforce_biometric_consent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  worker_id UUID NOT NULL,
  consent_granted BOOLEAN NOT NULL,
  purpose VARCHAR(255) NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  recorded_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_workforce_consent_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_workforce_consent_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_workforce_consent_worker FOREIGN KEY (worker_id, tenant_id, factory_id)
    REFERENCES workforce_workers(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_consent_actor FOREIGN KEY (recorded_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_workforce_consent_purpose CHECK (length(btrim(purpose)) BETWEEN 1 AND 255),
  CONSTRAINT chk_workforce_consent_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT chk_workforce_consent_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE workforce_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  entity_type VARCHAR(48) NOT NULL,
  entity_id UUID NOT NULL,
  entity_version BIGINT NOT NULL,
  action VARCHAR(48) NOT NULL,
  actor_user_id UUID NOT NULL,
  reason TEXT,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_workforce_audit_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_workforce_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_workforce_audit_entity_type CHECK (entity_type IN (
    'WORKER','SKILL','WORKER_SKILL','SHIFT_TEMPLATE','SHIFT_ASSIGNMENT','ATTENDANCE_EVENT',
    'OVERTIME_REQUEST','PRODUCTIVITY_REPORT','BIOMETRIC_CONSENT'
  )),
  CONSTRAINT chk_workforce_audit_version CHECK (entity_version > 0),
  CONSTRAINT chk_workforce_audit_action CHECK (length(btrim(action)) BETWEEN 1 AND 48),
  CONSTRAINT chk_workforce_audit_data CHECK (jsonb_typeof(event_data) = 'object')
);
CREATE INDEX idx_workforce_audit_entity
  ON workforce_audit_events (tenant_id, factory_id, entity_type, entity_id, created_at DESC);

-- Row-security and immutable-lifecycle guards are installed in migration 103.
INSERT INTO schema_migrations (version, checksum)
VALUES ('102_workforce_shift_attendance_productivity', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
