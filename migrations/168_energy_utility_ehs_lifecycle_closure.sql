BEGIN;

-- Task 16: connect approved utility source mappings to normalized readings,
-- threshold evaluation/alert evidence, and the remaining EHS lifecycle registers.

ALTER TABLE utility_audit_events DROP CONSTRAINT IF EXISTS chk_utility_audit_entity;
ALTER TABLE utility_audit_events ADD CONSTRAINT chk_utility_audit_entity
 CHECK(entity_type IN ('METER','READING','UTILITY_EVENT','METER_SOURCE_BINDING','THRESHOLD_POLICY'));
INSERT INTO permissions(code,description) VALUES
 ('utilities.sources.manage','Manage approved vendor meter source and unit mappings; this does not deploy a vendor driver'),
 ('utilities.alerts.read','Read threshold policies and source-linked utility alerts'),
 ('utilities.alerts.manage','Manage versioned utility threshold policies'),
 ('ehs.drills.read','Read emergency-drill plans, attendance and response evidence'),
 ('ehs.drills.manage','Manage emergency-drill lifecycle, attendance and response evidence'),
 ('ehs.chemicals.read','Read chemical hazard and SDS registry'),
 ('ehs.chemicals.manage','Manage versioned chemical hazard and SDS references'),
 ('ehs.contractors.read','Read contractor induction and validity records'),
 ('ehs.contractors.manage','Record and maintain contractor induction evidence'),
 ('notifications.inbox.read','Read assigned utility and EHS operational notifications'),
 ('notifications.inbox.manage','Acknowledge assigned operational notifications with an accountable reason')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('ORG_ADMIN','FACTORY_MANAGER','EHS_MANAGER')
  AND p.code IN (
    'utilities.sources.manage','utilities.alerts.read','utilities.alerts.manage',
    'ehs.drills.read','ehs.drills.manage','ehs.chemicals.read','ehs.chemicals.manage',
    'ehs.contractors.read','ehs.contractors.manage','notifications.inbox.read','notifications.inbox.manage'
  )
ON CONFLICT(role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS utility_meter_source_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  source_system_code VARCHAR(100) NOT NULL,
  source_meter_code VARCHAR(160) NOT NULL,
  vendor_adapter VARCHAR(24) NOT NULL,
  meter_id UUID NOT NULL,
  source_unit_code VARCHAR(24) NOT NULL,
  factor_to_meter_unit NUMERIC(18,8) NOT NULL DEFAULT 1,
  polling_interval_seconds INTEGER,
  credential_reference VARCHAR(255),
  config_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  approved_by_user_id UUID,
  approved_at TIMESTAMPTZ,
  last_change_reason TEXT,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_utility_source_binding_scope UNIQUE(id,tenant_id,factory_id),
  CONSTRAINT uq_utility_source_binding_key UNIQUE(tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_utility_source_binding_meter FOREIGN KEY(meter_id,tenant_id,factory_id)
    REFERENCES utility_meters(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_source_binding_creator FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_source_binding_updater FOREIGN KEY(updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_source_binding_approver FOREIGN KEY(approved_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_utility_source_binding_adapter CHECK(vendor_adapter IN ('REST_POLL','OPC_UA','MQTT','MODBUS','FILE_IMPORT','MANUAL_IMPORT')),
  CONSTRAINT chk_utility_source_binding_factor CHECK(factor_to_meter_unit > 0),
  CONSTRAINT chk_utility_source_binding_poll CHECK((vendor_adapter IN ('REST_POLL','OPC_UA','MODBUS') AND polling_interval_seconds IS NOT NULL AND polling_interval_seconds BETWEEN 5 AND 86400) OR (vendor_adapter NOT IN ('REST_POLL','OPC_UA','MODBUS') AND (polling_interval_seconds IS NULL OR polling_interval_seconds BETWEEN 5 AND 86400))),
  CONSTRAINT chk_utility_source_binding_status CHECK(status IN ('DRAFT','ACTIVE','INACTIVE','RETIRED')),
  CONSTRAINT chk_utility_source_binding_metadata CHECK(jsonb_typeof(config_metadata)='object'),
  CONSTRAINT chk_utility_source_binding_approval CHECK(
    (status='ACTIVE' AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
    OR (status<>'ACTIVE' AND approved_at IS NULL AND approved_by_user_id IS NULL)
  ),
  CONSTRAINT chk_utility_source_binding_key CHECK(length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_utility_source_binding_hash CHECK(request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_utility_source_binding_lookup
 ON utility_meter_source_bindings(tenant_id,factory_id,source_system_code,status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_utility_source_binding_active_identity
 ON utility_meter_source_bindings(tenant_id,factory_id,source_system_code,source_meter_code)
 WHERE status='ACTIVE';

CREATE TABLE IF NOT EXISTS utility_threshold_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  policy_code VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  meter_id UUID,
  utility_type VARCHAR(24),
  metric VARCHAR(16) NOT NULL,
  comparison VARCHAR(4) NOT NULL,
  threshold_value NUMERIC(24,8) NOT NULL,
  threshold_unit_code VARCHAR(24) NOT NULL,
  severity VARCHAR(12) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  approved_by_user_id UUID,
  approved_at TIMESTAMPTZ,
  last_change_reason TEXT,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_utility_threshold_policy_scope UNIQUE(id,tenant_id,factory_id),
  CONSTRAINT uq_utility_threshold_policy_code UNIQUE(tenant_id,factory_id,policy_code),
  CONSTRAINT uq_utility_threshold_policy_key UNIQUE(tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_utility_threshold_factory FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_threshold_meter FOREIGN KEY(meter_id,tenant_id,factory_id)
    REFERENCES utility_meters(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_threshold_creator FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_threshold_updater FOREIGN KEY(updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_threshold_approver FOREIGN KEY(approved_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_utility_threshold_selector CHECK(meter_id IS NOT NULL OR utility_type IS NOT NULL),
  CONSTRAINT chk_utility_threshold_type CHECK(utility_type IS NULL OR utility_type IN ('ELECTRICITY','GAS','STEAM','WATER','COMPRESSED_AIR','FUEL','OTHER')),
  CONSTRAINT chk_utility_threshold_metric CHECK(metric IN ('CONSUMPTION','COST','INTENSITY')),
  CONSTRAINT chk_utility_threshold_comparison CHECK(comparison IN ('GT','GTE','LT','LTE')),
  CONSTRAINT chk_utility_threshold_severity CHECK(severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  CONSTRAINT chk_utility_threshold_status CHECK(status IN ('DRAFT','ACTIVE','INACTIVE','RETIRED')),
  CONSTRAINT chk_utility_threshold_threshold CHECK(threshold_value >= 0),
  CONSTRAINT chk_utility_threshold_approval CHECK(
    (status='ACTIVE' AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
    OR (status<>'ACTIVE' AND approved_by_user_id IS NULL AND approved_at IS NULL)
  ),
  CONSTRAINT chk_utility_threshold_version CHECK(row_version>0),
  CONSTRAINT chk_utility_threshold_hash CHECK(request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_utility_threshold_active
 ON utility_threshold_policies(tenant_id,factory_id,status,utility_type,meter_id);

CREATE TABLE IF NOT EXISTS utility_threshold_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  policy_id UUID NOT NULL,
  reading_id UUID NOT NULL,
  utility_event_id UUID NOT NULL,
  metric VARCHAR(16) NOT NULL,
  observed_value NUMERIC(24,8) NOT NULL,
  threshold_snapshot NUMERIC(24,8) NOT NULL,
  unit_code VARCHAR(24) NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_utility_threshold_alert_scope UNIQUE(id,tenant_id,factory_id),
  CONSTRAINT uq_utility_threshold_alert_reading_policy UNIQUE(tenant_id,factory_id,reading_id,policy_id),
  CONSTRAINT uq_utility_threshold_alert_event UNIQUE(tenant_id,factory_id,utility_event_id),
  CONSTRAINT fk_utility_threshold_alert_policy FOREIGN KEY(policy_id,tenant_id,factory_id)
    REFERENCES utility_threshold_policies(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_threshold_alert_reading FOREIGN KEY(reading_id,tenant_id,factory_id)
    REFERENCES utility_meter_readings(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_threshold_alert_event FOREIGN KEY(utility_event_id,tenant_id,factory_id)
    REFERENCES utility_events(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_utility_threshold_alert_metric CHECK(metric IN ('CONSUMPTION','COST','INTENSITY')),
  CONSTRAINT chk_utility_threshold_alert_evidence CHECK(jsonb_typeof(evidence)='object' AND evidence<>'{}'::jsonb)
);
CREATE INDEX IF NOT EXISTS idx_utility_threshold_alert_reading
 ON utility_threshold_alerts(tenant_id,factory_id,reading_id);

CREATE TABLE IF NOT EXISTS ehs_emergency_drills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  drill_number VARCHAR(100) NOT NULL,
  drill_type VARCHAR(32) NOT NULL,
  title VARCHAR(255) NOT NULL,
  location VARCHAR(255) NOT NULL,
  planned_at TIMESTAMPTZ NOT NULL,
  owner_user_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PLANNED',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  outcome_summary TEXT,
  close_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  last_change_reason TEXT,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_ehs_drill_scope UNIQUE(id,tenant_id,factory_id),
  CONSTRAINT uq_ehs_drill_number UNIQUE(tenant_id,factory_id,drill_number),
  CONSTRAINT uq_ehs_drill_key UNIQUE(tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_ehs_drill_factory FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_drill_owner FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_drill_creator FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_drill_updater FOREIGN KEY(updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_ehs_drill_type CHECK(drill_type IN ('FIRE','EVACUATION','CHEMICAL_SPILL','MEDICAL','NATURAL_DISASTER','OTHER')),
  CONSTRAINT chk_ehs_drill_status CHECK(status IN ('PLANNED','IN_PROGRESS','COMPLETED','CANCELLED')),
  CONSTRAINT chk_ehs_drill_title CHECK(length(btrim(title)) BETWEEN 1 AND 255),
  CONSTRAINT chk_ehs_drill_location CHECK(length(btrim(location)) BETWEEN 1 AND 255),
  CONSTRAINT chk_ehs_drill_window CHECK((started_at IS NULL OR started_at>=planned_at-INTERVAL '30 days')
    AND (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at>=started_at))),
  CONSTRAINT chk_ehs_drill_completed CHECK(
    (status='COMPLETED' AND completed_at IS NOT NULL AND length(btrim(COALESCE(outcome_summary,'')))>0
      AND close_evidence<>'{}'::jsonb)
    OR (status<>'COMPLETED' AND completed_at IS NULL)
  ),
  CONSTRAINT chk_ehs_drill_close_json CHECK(jsonb_typeof(close_evidence)='object'),
  CONSTRAINT chk_ehs_drill_version CHECK(row_version>0),
  CONSTRAINT chk_ehs_drill_hash CHECK(request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_ehs_drill_queue
 ON ehs_emergency_drills(tenant_id,factory_id,status,planned_at DESC);

CREATE TABLE IF NOT EXISTS ehs_drill_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  drill_id UUID NOT NULL,
  attendee_ref VARCHAR(160) NOT NULL,
  attendee_name VARCHAR(255) NOT NULL,
  user_id UUID,
  attendance_status VARCHAR(16) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  notes TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  recorded_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  CONSTRAINT uq_ehs_drill_attendance_scope UNIQUE(id,tenant_id,factory_id),
  CONSTRAINT uq_ehs_drill_attendance_ref UNIQUE(tenant_id,factory_id,drill_id,attendee_ref),
  CONSTRAINT uq_ehs_drill_attendance_key UNIQUE(tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_ehs_drill_attendance_drill FOREIGN KEY(drill_id,tenant_id,factory_id)
    REFERENCES ehs_emergency_drills(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_drill_attendance_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_drill_attendance_recorder FOREIGN KEY(recorded_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_ehs_drill_attendance_status CHECK(attendance_status IN ('PRESENT','ABSENT','EXCUSED')),
  CONSTRAINT chk_ehs_drill_attendance_evidence CHECK(jsonb_typeof(evidence)='object'),
  CONSTRAINT chk_ehs_drill_attendance_hash CHECK(request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_ehs_drill_attendance_drill
 ON ehs_drill_attendance(tenant_id,factory_id,drill_id);

CREATE TABLE IF NOT EXISTS ehs_drill_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  drill_id UUID NOT NULL,
  response_code VARCHAR(100) NOT NULL,
  response_action TEXT NOT NULL,
  responder_user_id UUID,
  elapsed_seconds INTEGER,
  occurred_at TIMESTAMPTZ NOT NULL,
  evidence JSONB NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  recorded_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_ehs_drill_response_scope UNIQUE(id,tenant_id,factory_id),
  CONSTRAINT uq_ehs_drill_response_code UNIQUE(tenant_id,factory_id,drill_id,response_code,idempotency_key),
  CONSTRAINT uq_ehs_drill_response_key UNIQUE(tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_ehs_drill_response_drill FOREIGN KEY(drill_id,tenant_id,factory_id)
    REFERENCES ehs_emergency_drills(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_drill_response_responder FOREIGN KEY(responder_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_drill_response_recorder FOREIGN KEY(recorded_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_ehs_drill_response_elapsed CHECK(elapsed_seconds IS NULL OR elapsed_seconds BETWEEN 0 AND 604800),
  CONSTRAINT chk_ehs_drill_response_evidence CHECK(jsonb_typeof(evidence)='object' AND evidence<>'{}'::jsonb),
  CONSTRAINT chk_ehs_drill_response_hash CHECK(request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_ehs_drill_response_drill
 ON ehs_drill_responses(tenant_id,factory_id,drill_id);

CREATE TABLE IF NOT EXISTS ehs_chemical_sds_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  chemical_code VARCHAR(100) NOT NULL,
  chemical_name VARCHAR(255) NOT NULL,
  manufacturer VARCHAR(255),
  hazard_class VARCHAR(100) NOT NULL,
  storage_location VARCHAR(255) NOT NULL,
  sds_revision VARCHAR(100) NOT NULL,
  sds_document_uri TEXT NOT NULL,
  sds_issued_at TIMESTAMPTZ NOT NULL,
  sds_review_due_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  handling_instructions TEXT NOT NULL,
  emergency_instructions TEXT NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  approved_by_user_id UUID,
  approved_at TIMESTAMPTZ,
  last_change_reason TEXT,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_ehs_chemical_scope UNIQUE(id,tenant_id,factory_id),
  CONSTRAINT uq_ehs_chemical_code_revision UNIQUE(tenant_id,factory_id,chemical_code,sds_revision),
  CONSTRAINT uq_ehs_chemical_key UNIQUE(tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_ehs_chemical_factory FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_chemical_creator FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_chemical_updater FOREIGN KEY(updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_chemical_approver FOREIGN KEY(approved_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_ehs_chemical_status CHECK(status IN ('DRAFT','ACTIVE','INACTIVE','RETIRED')),
  CONSTRAINT chk_ehs_chemical_approval CHECK(
    (status='ACTIVE' AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
    OR (status<>'ACTIVE' AND approved_by_user_id IS NULL AND approved_at IS NULL)
  ),
  CONSTRAINT chk_ehs_chemical_dates CHECK(sds_review_due_at>=sds_issued_at),
  CONSTRAINT chk_ehs_chemical_uri CHECK(length(btrim(sds_document_uri)) BETWEEN 1 AND 2048),
  CONSTRAINT chk_ehs_chemical_handling CHECK(length(btrim(handling_instructions))>0 AND length(btrim(emergency_instructions))>0),
  CONSTRAINT chk_ehs_chemical_version CHECK(row_version>0),
  CONSTRAINT chk_ehs_chemical_hash CHECK(request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_ehs_chemical_current
 ON ehs_chemical_sds_registry(tenant_id,factory_id,status,sds_review_due_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ehs_chemical_single_active_revision
 ON ehs_chemical_sds_registry(tenant_id,factory_id,chemical_code)
 WHERE status='ACTIVE';

CREATE TABLE IF NOT EXISTS ehs_contractor_inductions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  contractor_code VARCHAR(100) NOT NULL,
  company_name VARCHAR(255) NOT NULL,
  person_name VARCHAR(255) NOT NULL,
  induction_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  topics JSONB NOT NULL,
  evidence JSONB NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  recorded_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  last_change_reason TEXT,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_ehs_contractor_scope UNIQUE(id,tenant_id,factory_id),
  CONSTRAINT uq_ehs_contractor_induction_key UNIQUE(tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_ehs_contractor_factory FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_contractor_recorder FOREIGN KEY(recorded_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_contractor_updater FOREIGN KEY(updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_ehs_contractor_dates CHECK(expires_at>induction_at),
  CONSTRAINT chk_ehs_contractor_status CHECK(status IN ('ACTIVE','EXPIRED','REVOKED')),
  CONSTRAINT chk_ehs_contractor_topics CHECK(jsonb_typeof(topics)='array' AND jsonb_array_length(topics)>0),
  CONSTRAINT chk_ehs_contractor_evidence CHECK(jsonb_typeof(evidence)='object' AND evidence<>'{}'::jsonb),
  CONSTRAINT chk_ehs_contractor_version CHECK(row_version>0),
  CONSTRAINT chk_ehs_contractor_hash CHECK(request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_ehs_contractor_validity
 ON ehs_contractor_inductions(tenant_id,factory_id,status,expires_at);

CREATE TABLE IF NOT EXISTS operational_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  recipient_user_id UUID NOT NULL,
  source_event_id UUID NOT NULL,
  source_event_type VARCHAR(100) NOT NULL,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id UUID NOT NULL,
  category VARCHAR(24) NOT NULL,
  severity VARCHAR(12) NOT NULL DEFAULT 'MEDIUM',
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  action_required BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(16) NOT NULL DEFAULT 'UNREAD',
  row_version BIGINT NOT NULL DEFAULT 1,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_by_user_id UUID,
  acknowledged_at TIMESTAMPTZ,
  last_change_reason TEXT,
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_operational_notification_scope UNIQUE(id,tenant_id,factory_id),
  CONSTRAINT uq_operational_notification_source_recipient UNIQUE(tenant_id,factory_id,recipient_user_id,source_event_id),
  CONSTRAINT fk_operational_notification_factory FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_operational_notification_recipient FOREIGN KEY(recipient_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_operational_notification_acknowledger FOREIGN KEY(acknowledged_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_operational_notification_category CHECK(category IN ('UTILITY_THRESHOLD','EHS_LIFECYCLE')),
  CONSTRAINT chk_operational_notification_severity CHECK(severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  CONSTRAINT chk_operational_notification_status CHECK(status IN ('UNREAD','ACKNOWLEDGED')),
  CONSTRAINT chk_operational_notification_title CHECK(length(btrim(title)) BETWEEN 1 AND 255),
  CONSTRAINT chk_operational_notification_body CHECK(length(btrim(body)) BETWEEN 1 AND 4000),
  CONSTRAINT chk_operational_notification_state CHECK(
    (status='UNREAD' AND acknowledged_by_user_id IS NULL AND acknowledged_at IS NULL)
    OR (status='ACKNOWLEDGED' AND acknowledged_by_user_id IS NOT NULL AND acknowledged_at IS NOT NULL)
  ),
  CONSTRAINT chk_operational_notification_version CHECK(row_version>0),
  CONSTRAINT chk_operational_notification_payload CHECK(jsonb_typeof(payload)='object')
);
CREATE INDEX IF NOT EXISTS idx_operational_notification_inbox
 ON operational_notifications(tenant_id,factory_id,recipient_user_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS operational_notification_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  notification_id UUID NOT NULL,
  notification_version BIGINT NOT NULL,
  action VARCHAR(32) NOT NULL,
  from_status VARCHAR(16),
  to_status VARCHAR(16) NOT NULL,
  actor_user_id UUID,
  reason TEXT NOT NULL,
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_operational_notification_audit_version UNIQUE(tenant_id,factory_id,notification_id,notification_version),
  CONSTRAINT fk_operational_notification_audit_notification FOREIGN KEY(notification_id,tenant_id,factory_id)
    REFERENCES operational_notifications(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_operational_notification_audit_actor FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_operational_notification_audit_action CHECK(action IN ('CREATED','ACKNOWLEDGED')),
  CONSTRAINT chk_operational_notification_audit_reason CHECK(length(btrim(reason))>0)
);
CREATE INDEX IF NOT EXISTS idx_operational_notification_audit
 ON operational_notification_audit_events(tenant_id,factory_id,notification_id,created_at DESC);

CREATE TABLE IF NOT EXISTS ehs_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id UUID NOT NULL,
  action VARCHAR(64) NOT NULL,
  reason TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_ehs_lifecycle_event_scope UNIQUE(id,tenant_id,factory_id),
  CONSTRAINT uq_ehs_lifecycle_event_key UNIQUE(tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_ehs_lifecycle_event_factory FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_lifecycle_event_actor FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_ehs_lifecycle_event_type CHECK(entity_type IN ('EMERGENCY_DRILL','DRILL_ATTENDANCE','DRILL_RESPONSE','CHEMICAL_SDS','CONTRACTOR_INDUCTION')),
  CONSTRAINT chk_ehs_lifecycle_event_payload CHECK(jsonb_typeof(payload)='object'),
  CONSTRAINT chk_ehs_lifecycle_event_reason CHECK(length(btrim(reason))>0),
  CONSTRAINT chk_ehs_lifecycle_event_hash CHECK(request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_ehs_lifecycle_event_entity
 ON ehs_lifecycle_events(tenant_id,factory_id,entity_type,entity_id,created_at DESC);

-- New registries/evidence inherit the same tenant boundary as the original utility/EHS slice.
DO $policies$
DECLARE t TEXT;
BEGIN
 FOREACH t IN ARRAY ARRAY[
  'utility_meter_source_bindings','utility_threshold_policies','utility_threshold_alerts',
  'ehs_emergency_drills','ehs_drill_attendance','ehs_drill_responses',
  'ehs_chemical_sds_registry','ehs_contractor_inductions','ehs_lifecycle_events',
  'operational_notifications','operational_notification_audit_events'
 ] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I',t||'_tenant_isolation',t);
  EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id())',
    t||'_tenant_isolation',t);
 END LOOP;
END;
$policies$;

CREATE OR REPLACE FUNCTION factoryos_jsonb_has_sensitive_key(p_value JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $sensitive_json$
DECLARE
 v_entry RECORD;
BEGIN
 IF jsonb_typeof(p_value)='object' THEN
  FOR v_entry IN SELECT key,value FROM jsonb_each(p_value) LOOP
   IF lower(v_entry.key) ~ '(secret|password|token|credential|private.?key|api.?key|authorization|cookie|client.?secret|access.?key)'
     OR factoryos_jsonb_has_sensitive_key(v_entry.value) THEN
    RETURN TRUE;
   END IF;
  END LOOP;
 ELSIF jsonb_typeof(p_value)='array' THEN
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_value) LOOP
   IF factoryos_jsonb_has_sensitive_key(v_entry.value) THEN RETURN TRUE; END IF;
  END LOOP;
 END IF;
 RETURN FALSE;
END;
$sensitive_json$;

CREATE OR REPLACE FUNCTION factoryos_guard_utility_source_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Meter-source bindings are retained; use lifecycle transitions' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'DRAFT' OR NEW.row_version<>1 OR NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
    OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
   RAISE EXCEPTION 'Meter-source mapping must start as DRAFT under the authenticated actor' USING ERRCODE='42501';
  END IF;
  IF factoryos_jsonb_has_sensitive_key(NEW.config_metadata) THEN
   RAISE EXCEPTION 'Meter-source metadata cannot contain credential material; use a secret-manager reference' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.row_version<>OLD.row_version+1 OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
  OR length(btrim(COALESCE(NEW.last_change_reason,'')))=0
  OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
  OR NEW.source_system_code IS DISTINCT FROM OLD.source_system_code OR NEW.source_meter_code IS DISTINCT FROM OLD.source_meter_code
  OR NEW.vendor_adapter IS DISTINCT FROM OLD.vendor_adapter OR NEW.meter_id IS DISTINCT FROM OLD.meter_id
  OR NEW.source_unit_code IS DISTINCT FROM OLD.source_unit_code OR NEW.factor_to_meter_unit IS DISTINCT FROM OLD.factor_to_meter_unit
  OR NEW.polling_interval_seconds IS DISTINCT FROM OLD.polling_interval_seconds
  OR NEW.credential_reference IS DISTINCT FROM OLD.credential_reference OR NEW.config_metadata IS DISTINCT FROM OLD.config_metadata
  OR (NEW.status IS NOT DISTINCT FROM OLD.status AND ROW(NEW.approved_by_user_id,NEW.approved_at) IS DISTINCT FROM ROW(OLD.approved_by_user_id,OLD.approved_at))
  OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
  OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id THEN
  RAISE EXCEPTION 'Meter-source mapping and credential reference are immutable; create a new approved binding' USING ERRCODE='23514';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  (OLD.status='DRAFT' AND NEW.status IN ('ACTIVE','RETIRED')) OR
  (OLD.status='ACTIVE' AND NEW.status IN ('INACTIVE','RETIRED')) OR
  (OLD.status='INACTIVE' AND NEW.status IN ('ACTIVE','RETIRED'))
 ) THEN RAISE EXCEPTION 'Invalid meter-source binding transition' USING ERRCODE='23514'; END IF;
 IF NEW.status='ACTIVE' THEN
  IF NEW.approved_by_user_id IS DISTINCT FROM factoryos_current_user_id() OR NEW.approved_by_user_id=NEW.created_by_user_id
    OR NEW.approved_at IS NULL THEN
   RAISE EXCEPTION 'Activating a meter-source mapping requires independent approval' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM utility_meters m WHERE m.id=NEW.meter_id AND m.tenant_id=NEW.tenant_id
      AND m.factory_id=NEW.factory_id AND m.status='ACTIVE' AND m.unit_code=NEW.source_unit_code AND NEW.factor_to_meter_unit=1)
   AND NOT EXISTS (SELECT 1 FROM utility_meters m WHERE m.id=NEW.meter_id AND m.tenant_id=NEW.tenant_id
      AND m.factory_id=NEW.factory_id AND m.status='ACTIVE') THEN
   RAISE EXCEPTION 'Meter-source mapping needs an active meter in the same factory' USING ERRCODE='23503';
  END IF;
 ELSIF NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
  RAISE EXCEPTION 'Only an ACTIVE source mapping can retain approval evidence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_utility_source_binding_guard ON utility_meter_source_bindings;
CREATE TRIGGER trg_utility_source_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON utility_meter_source_bindings
 FOR EACH ROW EXECUTE FUNCTION factoryos_guard_utility_source_binding();

CREATE OR REPLACE FUNCTION factoryos_guard_utility_threshold_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Threshold policy revisions are retained; use lifecycle transitions' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'DRAFT' OR NEW.row_version<>1 OR NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
    OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
   RAISE EXCEPTION 'Threshold policy must start as DRAFT under the authenticated actor' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.row_version<>OLD.row_version+1 OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
  OR length(btrim(COALESCE(NEW.last_change_reason,'')))=0
  OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
  OR NEW.policy_code IS DISTINCT FROM OLD.policy_code OR NEW.name IS DISTINCT FROM OLD.name OR NEW.meter_id IS DISTINCT FROM OLD.meter_id
  OR NEW.utility_type IS DISTINCT FROM OLD.utility_type OR NEW.metric IS DISTINCT FROM OLD.metric OR NEW.comparison IS DISTINCT FROM OLD.comparison
  OR NEW.threshold_value IS DISTINCT FROM OLD.threshold_value OR NEW.threshold_unit_code IS DISTINCT FROM OLD.threshold_unit_code
  OR NEW.severity IS DISTINCT FROM OLD.severity OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
  OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
  OR (NEW.status IS NOT DISTINCT FROM OLD.status AND ROW(NEW.approved_by_user_id,NEW.approved_at) IS DISTINCT FROM ROW(OLD.approved_by_user_id,OLD.approved_at)) THEN
  RAISE EXCEPTION 'Threshold policy definition is immutable; create a new policy code for changed settings' USING ERRCODE='23514';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  (OLD.status='DRAFT' AND NEW.status IN ('ACTIVE','RETIRED')) OR
  (OLD.status='ACTIVE' AND NEW.status IN ('INACTIVE','RETIRED')) OR
  (OLD.status='INACTIVE' AND NEW.status IN ('ACTIVE','RETIRED'))
 ) THEN RAISE EXCEPTION 'Invalid threshold policy transition' USING ERRCODE='23514'; END IF;
 IF NEW.status='ACTIVE' THEN
  IF NEW.approved_by_user_id IS DISTINCT FROM factoryos_current_user_id() OR NEW.approved_by_user_id=NEW.created_by_user_id
    OR NEW.approved_at IS NULL THEN
   RAISE EXCEPTION 'Threshold policies require independent approval' USING ERRCODE='42501';
  END IF;
 ELSIF NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
  RAISE EXCEPTION 'Only an ACTIVE threshold policy can retain approval evidence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_utility_threshold_policy_guard ON utility_threshold_policies;
CREATE TRIGGER trg_utility_threshold_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON utility_threshold_policies
 FOR EACH ROW EXECUTE FUNCTION factoryos_guard_utility_threshold_policy();

CREATE OR REPLACE FUNCTION factoryos_create_utility_threshold_alerts()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 v_policy utility_threshold_policies%ROWTYPE;
 v_meter utility_meters%ROWTYPE;
 v_value NUMERIC(24,8);
 v_event_id UUID;
 v_alert_id UUID;
 v_unit VARCHAR(24);
 v_event_key VARCHAR(255);
 v_hash CHAR(64);
 v_operator_pass BOOLEAN;
BEGIN
 SELECT * INTO v_meter FROM utility_meters WHERE id=NEW.meter_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
 FOR v_policy IN SELECT * FROM utility_threshold_policies p
  WHERE p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id AND p.status='ACTIVE'
   AND (p.meter_id IS NULL OR p.meter_id=NEW.meter_id)
   AND (p.utility_type IS NULL OR p.utility_type=v_meter.utility_type)
  ORDER BY p.id
 LOOP
  IF v_policy.metric='CONSUMPTION' THEN v_value:=NEW.consumption_quantity; v_unit:=NEW.unit_code;
  ELSIF v_policy.metric='COST' THEN v_value:=NEW.cost_amount; v_unit:=v_meter.currency_code;
  ELSE v_value:=NEW.intensity_per_unit; v_unit:=NEW.unit_code||'/unit';
  END IF;
  IF v_value IS NULL OR v_unit<>v_policy.threshold_unit_code THEN CONTINUE; END IF;
  v_operator_pass:=CASE v_policy.comparison
   WHEN 'GT' THEN v_value>v_policy.threshold_value WHEN 'GTE' THEN v_value>=v_policy.threshold_value
   WHEN 'LT' THEN v_value<v_policy.threshold_value WHEN 'LTE' THEN v_value<=v_policy.threshold_value ELSE FALSE END;
  IF NOT v_operator_pass THEN CONTINUE; END IF;
  v_event_id:=gen_random_uuid();
  v_event_key:='threshold:'||v_policy.id::text||':'||NEW.id::text;
  v_hash:=encode(digest((v_event_key||':'||v_value::text||':'||v_policy.threshold_value::text),'sha256'),'hex');
  INSERT INTO utility_events(id,tenant_id,factory_id,meter_id,event_number,event_type,severity,title,description,occurred_at,
    impact_quantity,cause,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id)
  VALUES(v_event_id,NEW.tenant_id,NEW.factory_id,NEW.meter_id,'UT-'||upper(substr(v_event_id::text,1,12)),'EFFICIENCY_EXCEPTION',
    v_policy.severity,'Threshold alert: '||v_policy.name,
    'Normalized reading '||NEW.id::text||' observed '||v_value::text||' '||v_unit||' matched policy rule '||
      v_policy.comparison||' '||v_policy.threshold_value::text||' '||v_policy.threshold_unit_code,
    NEW.reading_at,v_value,'policy='||v_policy.policy_code, v_event_key,v_hash,NEW.recorded_by_user_id,NEW.recorded_by_user_id,NEW.correlation_id);
  INSERT INTO utility_threshold_alerts(tenant_id,factory_id,policy_id,reading_id,utility_event_id,metric,observed_value,
    threshold_snapshot,unit_code,evidence)
  VALUES(NEW.tenant_id,NEW.factory_id,v_policy.id,NEW.id,v_event_id,v_policy.metric,v_value,v_policy.threshold_value,v_unit,
    jsonb_build_object('reading_id',NEW.id,'meter_id',NEW.meter_id,'policy_code',v_policy.policy_code,
      'source_type',NEW.source_type,'source_event_id',NEW.source_event_id,'reading_at',NEW.reading_at,
      'comparison',v_policy.comparison,'threshold',v_policy.threshold_value))
  RETURNING id INTO v_alert_id;
  INSERT INTO outbox_events(tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES(NEW.tenant_id,NEW.factory_id,'UTILITY_THRESHOLD_ALERT',v_alert_id,'UTILITIES.THRESHOLD_ALERT_RAISED',
    jsonb_build_object('alert_id',v_alert_id,'utility_event_id',v_event_id,'reading_id',NEW.id,'meter_id',NEW.meter_id,
      'policy_id',v_policy.id,'metric',v_policy.metric,'observed_value',v_value,'threshold',v_policy.threshold_value,
      'unit_code',v_unit,'severity',v_policy.severity));
 END LOOP;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_utility_create_threshold_alerts ON utility_meter_readings;
CREATE TRIGGER trg_utility_create_threshold_alerts AFTER INSERT ON utility_meter_readings
 FOR EACH ROW EXECUTE FUNCTION factoryos_create_utility_threshold_alerts();

CREATE OR REPLACE FUNCTION factoryos_append_utility_config_audit()
RETURNS trigger LANGUAGE plpgsql AS $utility_config_audit$
DECLARE
 v_type VARCHAR(24);
 v_id UUID;
 v_version BIGINT;
 v_tenant UUID;
 v_factory UUID;
 v_action VARCHAR(48);
 v_reason TEXT;
 v_payload JSONB;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Utility source and threshold configuration is retained' USING ERRCODE='55000'; END IF;
 v_tenant:=(to_jsonb(NEW)->>'tenant_id')::uuid;
 v_factory:=(to_jsonb(NEW)->>'factory_id')::uuid;
 v_id:=(to_jsonb(NEW)->>'id')::uuid;
 v_version:=COALESCE(NULLIF(to_jsonb(NEW)->>'row_version','')::bigint,1);
 v_action:=CASE WHEN TG_OP='INSERT' THEN 'CREATED' ELSE COALESCE(to_jsonb(NEW)->>'status','UPDATED') END;
 v_reason:=COALESCE(NULLIF(to_jsonb(NEW)->>'last_change_reason',''),
   CASE WHEN TG_OP='INSERT' THEN 'Configuration recorded as DRAFT' ELSE 'Configuration lifecycle changed' END);
 IF TG_OP='UPDATE' AND length(btrim(COALESCE(to_jsonb(NEW)->>'last_change_reason','')))=0 THEN
  RAISE EXCEPTION 'Utility configuration changes require an auditable reason' USING ERRCODE='23514';
 END IF;
 v_type:=CASE WHEN TG_TABLE_NAME='utility_meter_source_bindings' THEN 'METER_SOURCE_BINDING' ELSE 'THRESHOLD_POLICY' END;
 v_payload:=CASE WHEN TG_TABLE_NAME='utility_meter_source_bindings'
  THEN jsonb_build_object('source_system_code',to_jsonb(NEW)->>'source_system_code',
    'source_meter_code',to_jsonb(NEW)->>'source_meter_code','meter_id',to_jsonb(NEW)->>'meter_id',
    'vendor_adapter',to_jsonb(NEW)->>'vendor_adapter','status',to_jsonb(NEW)->>'status')
  ELSE jsonb_build_object('policy_code',to_jsonb(NEW)->>'policy_code','metric',to_jsonb(NEW)->>'metric',
    'comparison',to_jsonb(NEW)->>'comparison','threshold_value',to_jsonb(NEW)->>'threshold_value',
    'threshold_unit_code',to_jsonb(NEW)->>'threshold_unit_code','severity',to_jsonb(NEW)->>'severity',
    'status',to_jsonb(NEW)->>'status') END;
 INSERT INTO utility_audit_events(tenant_id,factory_id,entity_type,entity_id,entity_version,action,actor_user_id,reason,event_data,correlation_id)
 VALUES(v_tenant,v_factory,v_type,v_id,v_version,v_action,factoryos_current_user_id(),v_reason,
   jsonb_strip_nulls(v_payload),COALESCE(NULLIF(to_jsonb(NEW)->>'correlation_id','')::uuid,gen_random_uuid()));
 INSERT INTO outbox_events(tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
 VALUES(v_tenant,v_factory,'UTILITY_CONFIG',v_id,'UTILITIES.CONFIG_CHANGED',
   jsonb_build_object('entity_type',v_type,'entity_id',v_id,'version',v_version,'action',v_action,'status',to_jsonb(NEW)->>'status'));
 RETURN NEW;
END;
$utility_config_audit$;
DROP TRIGGER IF EXISTS trg_utility_source_binding_audit ON utility_meter_source_bindings;
CREATE TRIGGER trg_utility_source_binding_audit AFTER INSERT OR UPDATE ON utility_meter_source_bindings
 FOR EACH ROW EXECUTE FUNCTION factoryos_append_utility_config_audit();
DROP TRIGGER IF EXISTS trg_utility_threshold_policy_audit ON utility_threshold_policies;
CREATE TRIGGER trg_utility_threshold_policy_audit AFTER INSERT OR UPDATE ON utility_threshold_policies
 FOR EACH ROW EXECUTE FUNCTION factoryos_append_utility_config_audit();

-- EHS append-only event log is both audit evidence and the source for notification workers.
CREATE OR REPLACE FUNCTION factoryos_guard_operational_notification()
RETURNS trigger LANGUAGE plpgsql AS $notification_guard$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Operational notifications are retained for audit' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'UNREAD' OR NEW.row_version<>1 OR NEW.acknowledged_by_user_id IS NOT NULL
    OR NEW.acknowledged_at IS NOT NULL THEN
   RAISE EXCEPTION 'Operational notifications must be created unread at version 1' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM users u JOIN tenant_memberships tm ON tm.user_id=u.id
      WHERE u.id=NEW.recipient_user_id AND u.status='ACTIVE'
        AND tm.tenant_id=NEW.tenant_id AND tm.status='ACTIVE'
  ) THEN RAISE EXCEPTION 'Notification recipient must be an active member of its tenant' USING ERRCODE='23503'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
  OR NEW.factory_id IS DISTINCT FROM OLD.factory_id OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
  OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id OR NEW.source_event_type IS DISTINCT FROM OLD.source_event_type
  OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
  OR NEW.category IS DISTINCT FROM OLD.category OR NEW.severity IS DISTINCT FROM OLD.severity
  OR NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body
  OR NEW.action_required IS DISTINCT FROM OLD.action_required OR NEW.payload IS DISTINCT FROM OLD.payload
  OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'Notification source evidence and recipient are immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.status<>'UNREAD' OR NEW.status<>'ACKNOWLEDGED' OR NEW.row_version<>OLD.row_version+1
   OR NEW.acknowledged_by_user_id IS DISTINCT FROM factoryos_current_user_id()
   OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
   OR NEW.recipient_user_id IS DISTINCT FROM factoryos_current_user_id()
   OR NEW.acknowledged_at IS NULL OR length(btrim(COALESCE(NEW.last_change_reason,'')))=0 THEN
  RAISE EXCEPTION 'Only the assigned recipient can acknowledge an unread notification with a reason and one version increment' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$notification_guard$;
CREATE OR REPLACE FUNCTION factoryos_guard_ehs_lifecycle_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'EHS lifecycle events are immutable' USING ERRCODE='55000'; END IF;
 IF NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
  RAISE EXCEPTION 'EHS lifecycle actor must match authenticated database context' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_ehs_lifecycle_event_guard ON ehs_lifecycle_events;
CREATE TRIGGER trg_ehs_lifecycle_event_guard BEFORE INSERT OR UPDATE OR DELETE ON ehs_lifecycle_events
 FOR EACH ROW EXECUTE FUNCTION factoryos_guard_ehs_lifecycle_event();

DO $immutable$
DECLARE t TEXT;
BEGIN
 FOREACH t IN ARRAY ARRAY['utility_threshold_alerts','ehs_drill_attendance','ehs_drill_responses'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',t||'_immutable',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_utility_evidence_mutation()',t||'_immutable',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['ehs_emergency_drills','ehs_chemical_sds_registry','ehs_contractor_inductions'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',t||'_guard_delete',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_utility_delete()',t||'_guard_delete',t);
 END LOOP;
END;
$immutable$;

CREATE OR REPLACE FUNCTION factoryos_guard_ehs_drill()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Emergency-drill records are retained; use lifecycle transitions' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'PLANNED' OR NEW.row_version<>1 OR NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
    OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
   RAISE EXCEPTION 'Emergency drills must begin PLANNED under the authenticated actor' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.row_version<>OLD.row_version+1 OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
  OR length(btrim(COALESCE(NEW.last_change_reason,'')))=0
  OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
  OR NEW.drill_number IS DISTINCT FROM OLD.drill_number OR NEW.drill_type IS DISTINCT FROM OLD.drill_type
  OR NEW.title IS DISTINCT FROM OLD.title OR NEW.location IS DISTINCT FROM OLD.location OR NEW.planned_at IS DISTINCT FROM OLD.planned_at
  OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
  OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id THEN
  RAISE EXCEPTION 'Emergency drill plan identity is immutable; revise through a new drill' USING ERRCODE='23514';
 END IF;
 IF NOT (
  (OLD.status='PLANNED' AND NEW.status IN ('IN_PROGRESS','CANCELLED')) OR
  (OLD.status='IN_PROGRESS' AND NEW.status IN ('COMPLETED','CANCELLED'))
 ) THEN RAISE EXCEPTION 'Invalid emergency-drill transition: % -> %',OLD.status,NEW.status USING ERRCODE='23514'; END IF;
 IF NEW.status='COMPLETED' THEN
  IF NEW.started_at IS NULL OR NEW.completed_at IS NULL OR length(btrim(COALESCE(NEW.outcome_summary,'')))=0
   OR NEW.close_evidence='{}'::jsonb
   OR NOT EXISTS(SELECT 1 FROM ehs_drill_attendance a WHERE a.drill_id=NEW.id AND a.tenant_id=NEW.tenant_id
      AND a.factory_id=NEW.factory_id AND a.attendance_status='PRESENT')
   OR NOT EXISTS(SELECT 1 FROM ehs_drill_responses r WHERE r.drill_id=NEW.id AND r.tenant_id=NEW.tenant_id AND r.factory_id=NEW.factory_id) THEN
   RAISE EXCEPTION 'Drill completion requires outcome/evidence, present attendance, and a response record' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_ehs_drill_guard ON ehs_emergency_drills;
CREATE TRIGGER trg_ehs_drill_guard BEFORE INSERT OR UPDATE OR DELETE ON ehs_emergency_drills
 FOR EACH ROW EXECUTE FUNCTION factoryos_guard_ehs_drill();

CREATE OR REPLACE FUNCTION factoryos_guard_ehs_chemical()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Chemical/SDS records are retained; use lifecycle transitions' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'DRAFT' OR NEW.row_version<>1 OR NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
    OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
    OR NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
   RAISE EXCEPTION 'Chemical/SDS records must begin DRAFT under the authenticated actor' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.row_version<>OLD.row_version+1 OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
  OR length(btrim(COALESCE(NEW.last_change_reason,'')))=0
  OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
  OR NEW.chemical_code IS DISTINCT FROM OLD.chemical_code OR NEW.chemical_name IS DISTINCT FROM OLD.chemical_name
  OR NEW.manufacturer IS DISTINCT FROM OLD.manufacturer OR NEW.hazard_class IS DISTINCT FROM OLD.hazard_class
  OR NEW.storage_location IS DISTINCT FROM OLD.storage_location OR NEW.sds_revision IS DISTINCT FROM OLD.sds_revision
  OR NEW.sds_document_uri IS DISTINCT FROM OLD.sds_document_uri OR NEW.sds_issued_at IS DISTINCT FROM OLD.sds_issued_at
  OR NEW.sds_review_due_at IS DISTINCT FROM OLD.sds_review_due_at OR NEW.handling_instructions IS DISTINCT FROM OLD.handling_instructions
  OR NEW.emergency_instructions IS DISTINCT FROM OLD.emergency_instructions OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
  OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
  OR (NEW.status IS NOT DISTINCT FROM OLD.status AND ROW(NEW.approved_by_user_id,NEW.approved_at) IS DISTINCT FROM ROW(OLD.approved_by_user_id,OLD.approved_at)) THEN
  RAISE EXCEPTION 'SDS revision is immutable; create a new revision for document or hazard changes' USING ERRCODE='23514';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  (OLD.status='DRAFT' AND NEW.status IN ('ACTIVE','RETIRED')) OR
  (OLD.status='ACTIVE' AND NEW.status IN ('INACTIVE','RETIRED')) OR
  (OLD.status='INACTIVE' AND NEW.status IN ('ACTIVE','RETIRED'))
 ) THEN RAISE EXCEPTION 'Invalid chemical/SDS transition' USING ERRCODE='23514'; END IF;
 IF NEW.status='ACTIVE' THEN
  IF NEW.approved_by_user_id IS DISTINCT FROM factoryos_current_user_id()
    OR NEW.approved_by_user_id IS NULL OR NEW.approved_by_user_id=NEW.created_by_user_id OR NEW.approved_at IS NULL THEN
   RAISE EXCEPTION 'Activating an SDS revision requires an independent approver' USING ERRCODE='42501';
  END IF;
  IF NEW.sds_review_due_at<clock_timestamp() THEN
   RAISE EXCEPTION 'An expired SDS review cannot be activated' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
  RAISE EXCEPTION 'Only an ACTIVE SDS revision can retain approval evidence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_ehs_chemical_guard ON ehs_chemical_sds_registry;
CREATE TRIGGER trg_ehs_chemical_guard BEFORE INSERT OR UPDATE OR DELETE ON ehs_chemical_sds_registry
 FOR EACH ROW EXECUTE FUNCTION factoryos_guard_ehs_chemical();

CREATE OR REPLACE FUNCTION factoryos_guard_ehs_contractor_induction()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Contractor induction evidence is retained; use lifecycle transitions' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.recorded_by_user_id IS DISTINCT FROM factoryos_current_user_id()
    OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
    OR NEW.status<>'ACTIVE' OR NEW.row_version<>1 THEN
   RAISE EXCEPTION 'Contractor induction must start ACTIVE under authenticated recorder' USING ERRCODE='42501';
  END IF;
  IF NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Expired contractor induction cannot be registered active' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.row_version<>OLD.row_version+1 OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
  OR length(btrim(COALESCE(NEW.last_change_reason,'')))=0
  OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
  OR NEW.contractor_code IS DISTINCT FROM OLD.contractor_code OR NEW.company_name IS DISTINCT FROM OLD.company_name
  OR NEW.person_name IS DISTINCT FROM OLD.person_name OR NEW.induction_at IS DISTINCT FROM OLD.induction_at
  OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.topics IS DISTINCT FROM OLD.topics OR NEW.evidence IS DISTINCT FROM OLD.evidence
  OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
  OR NEW.recorded_by_user_id IS DISTINCT FROM OLD.recorded_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id THEN
  RAISE EXCEPTION 'Contractor induction evidence is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.row_version<>OLD.row_version+1 OR NEW.status IS DISTINCT FROM OLD.status
  AND NOT(OLD.status='ACTIVE' AND NEW.status IN ('EXPIRED','REVOKED')) THEN
  RAISE EXCEPTION 'Contractor induction may only transition ACTIVE to EXPIRED or REVOKED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_ehs_contractor_induction_guard ON ehs_contractor_inductions;
CREATE TRIGGER trg_ehs_contractor_induction_guard BEFORE INSERT OR UPDATE OR DELETE ON ehs_contractor_inductions
 FOR EACH ROW EXECUTE FUNCTION factoryos_guard_ehs_contractor_induction();

CREATE OR REPLACE FUNCTION factoryos_ehs_append_lifecycle_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 v_actor UUID;
 v_tenant UUID;
 v_factory UUID;
 v_id UUID;
 v_type VARCHAR(32);
 v_version BIGINT;
 v_action VARCHAR(64);
 v_payload JSONB;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EHS lifecycle records are retained' USING ERRCODE='55000'; END IF;
 v_tenant:=(to_jsonb(NEW)->>'tenant_id')::uuid;
 v_factory:=(to_jsonb(NEW)->>'factory_id')::uuid;
 v_id:=(to_jsonb(NEW)->>'id')::uuid;
 v_actor:=factoryos_current_user_id();
 IF TG_TABLE_NAME='ehs_emergency_drills' THEN v_type:='EMERGENCY_DRILL';
 ELSIF TG_TABLE_NAME='ehs_drill_attendance' THEN v_type:='DRILL_ATTENDANCE';
 ELSIF TG_TABLE_NAME='ehs_drill_responses' THEN v_type:='DRILL_RESPONSE';
 ELSIF TG_TABLE_NAME='ehs_chemical_sds_registry' THEN v_type:='CHEMICAL_SDS';
 ELSE v_type:='CONTRACTOR_INDUCTION'; END IF;
 v_version:=COALESCE(NULLIF(to_jsonb(NEW)->>'row_version','')::bigint,1);
 v_action:=CASE WHEN TG_OP='INSERT' THEN 'CREATED' ELSE COALESCE(to_jsonb(NEW)->>'status','UPDATED') END;
 v_payload:=CASE WHEN TG_TABLE_NAME='ehs_emergency_drills'
   THEN jsonb_build_object('status',to_jsonb(NEW)->>'status','drill_number',to_jsonb(NEW)->>'drill_number')
   WHEN TG_TABLE_NAME='ehs_chemical_sds_registry'
   THEN jsonb_build_object('status',to_jsonb(NEW)->>'status','chemical_code',to_jsonb(NEW)->>'chemical_code','sds_revision',to_jsonb(NEW)->>'sds_revision')
   WHEN TG_TABLE_NAME='ehs_contractor_inductions'
   THEN jsonb_build_object('status',to_jsonb(NEW)->>'status','contractor_code',to_jsonb(NEW)->>'contractor_code','expires_at',to_jsonb(NEW)->>'expires_at')
   ELSE jsonb_build_object('entity_id',v_id,'action',v_action) END;
 INSERT INTO ehs_lifecycle_events(tenant_id,factory_id,entity_type,entity_id,action,reason,payload,idempotency_key,request_hash,actor_user_id,correlation_id)
 VALUES(v_tenant,v_factory,v_type,v_id,v_action,
   COALESCE(NULLIF(to_jsonb(NEW)->>'last_change_reason',''), 'Evidence recorded'),
   jsonb_strip_nulls(v_payload),
   'ehs-db:'||TG_TABLE_NAME||':'||v_id::text||':'||v_version::text,
   encode(digest((v_type||':'||v_id::text||':'||v_version::text||':'||v_action),'sha256'),'hex'),
   v_actor,COALESCE(NULLIF(to_jsonb(NEW)->>'correlation_id','')::uuid,gen_random_uuid()));
 INSERT INTO outbox_events(tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
 VALUES(v_tenant,v_factory,'EHS_'||v_type,v_id,'EHS.LIFECYCLE_CHANGED',
   jsonb_build_object('entity_type',v_type,'entity_id',v_id,'action',v_action,'version',v_version,'payload',v_payload));
 RETURN NEW;
END;
$$;
DO $ehs_triggers$
DECLARE t TEXT;
BEGIN
 FOREACH t IN ARRAY ARRAY['ehs_emergency_drills','ehs_drill_attendance','ehs_drill_responses','ehs_chemical_sds_registry','ehs_contractor_inductions'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',t||'_lifecycle_audit',t);
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION factoryos_ehs_append_lifecycle_audit()',t||'_lifecycle_audit',t);
 END LOOP;
END;
$ehs_triggers$;

CREATE OR REPLACE FUNCTION factoryos_guard_operational_notification_audit()
RETURNS trigger LANGUAGE plpgsql AS $notification_audit_guard$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Notification audit events are append-only' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END;
$notification_audit_guard$;
DROP TRIGGER IF EXISTS trg_operational_notification_audit_immutable ON operational_notification_audit_events;
CREATE TRIGGER trg_operational_notification_audit_immutable
 BEFORE UPDATE OR DELETE ON operational_notification_audit_events
 FOR EACH ROW EXECUTE FUNCTION factoryos_guard_operational_notification_audit();

CREATE OR REPLACE FUNCTION factoryos_append_operational_notification_audit()
RETURNS trigger LANGUAGE plpgsql AS $notification_audit$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO operational_notification_audit_events(tenant_id,factory_id,notification_id,notification_version,
    action,from_status,to_status,actor_user_id,reason,correlation_id)
  VALUES(NEW.tenant_id,NEW.factory_id,NEW.id,NEW.row_version,'CREATED',NULL,NEW.status,NULL,
    'Operational notification queued from source event',NEW.correlation_id);
 ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
  INSERT INTO operational_notification_audit_events(tenant_id,factory_id,notification_id,notification_version,
    action,from_status,to_status,actor_user_id,reason,correlation_id)
  VALUES(NEW.tenant_id,NEW.factory_id,NEW.id,NEW.row_version,'ACKNOWLEDGED',OLD.status,NEW.status,
    factoryos_current_user_id(),NEW.last_change_reason,NEW.correlation_id);
 END IF;
 RETURN NEW;
END;
$notification_audit$;
DROP TRIGGER IF EXISTS trg_operational_notification_guard ON operational_notifications;
CREATE TRIGGER trg_operational_notification_guard BEFORE INSERT OR UPDATE OR DELETE ON operational_notifications
 FOR EACH ROW EXECUTE FUNCTION factoryos_guard_operational_notification();
DROP TRIGGER IF EXISTS trg_operational_notification_audit ON operational_notifications;
CREATE TRIGGER trg_operational_notification_audit AFTER INSERT OR UPDATE ON operational_notifications
 FOR EACH ROW EXECUTE FUNCTION factoryos_append_operational_notification_audit();

CREATE OR REPLACE FUNCTION factoryos_validate_utility_source_reading()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_binding utility_meter_source_bindings%ROWTYPE; v_meter utility_meters%ROWTYPE;
BEGIN
 IF NEW.source_type<>'METER_GATEWAY' THEN RETURN NEW; END IF;
 IF NEW.source_event_id IS NULL OR length(btrim(NEW.source_event_id))=0 THEN
  RAISE EXCEPTION 'Vendor-gateway readings require a stable source event identity' USING ERRCODE='23514';
 END IF;
 IF NEW.recorded_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
  RAISE EXCEPTION 'Normalized vendor reading actor must be authenticated' USING ERRCODE='42501';
 END IF;
 SELECT * INTO v_binding FROM utility_meter_source_bindings b
 WHERE b.tenant_id=NEW.tenant_id AND b.factory_id=NEW.factory_id AND b.meter_id=NEW.meter_id
   AND b.status='ACTIVE' AND (split_part(NEW.source_event_id,':',1)=b.source_system_code)
 FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Vendor reading requires an ACTIVE approved source binding' USING ERRCODE='23514'; END IF;
 SELECT * INTO v_meter FROM utility_meters m WHERE m.id=NEW.meter_id AND m.tenant_id=NEW.tenant_id AND m.factory_id=NEW.factory_id;
 IF NOT FOUND OR NEW.unit_code<>v_meter.unit_code THEN RAISE EXCEPTION 'Vendor reading must be normalized into the meter unit' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_utility_source_reading_guard ON utility_meter_readings;
CREATE TRIGGER trg_utility_source_reading_guard BEFORE INSERT ON utility_meter_readings
 FOR EACH ROW EXECUTE FUNCTION factoryos_validate_utility_source_reading();

INSERT INTO schema_migrations(version,checksum)
VALUES('168_energy_utility_ehs_lifecycle_closure',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
