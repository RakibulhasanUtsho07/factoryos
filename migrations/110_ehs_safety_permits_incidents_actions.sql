BEGIN;

-- EHS first functional slice: auditable permit-to-work/lockout verification,
-- incident and near-miss reporting, and independent corrective-action verification.

INSERT INTO permissions (code, description) VALUES
  ('ehs.permits.read', 'Read factory safety permits and isolation/closure evidence'),
  ('ehs.permits.manage', 'Create and submit permits to work'),
  ('ehs.permits.approve', 'Approve or reject safety permits as an independent approver'),
  ('ehs.permits.execute', 'Verify isolation, activate, and close permits to work'),
  ('ehs.incidents.read', 'Read incidents, near misses, unsafe observations and audit findings'),
  ('ehs.incidents.report', 'Report safety incidents, near misses and unsafe observations'),
  ('ehs.incidents.manage', 'Investigate incidents and manage corrective actions'),
  ('ehs.corrective_actions.verify', 'Independently verify corrective-action closure evidence')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'ehs.%'
WHERE r.code IN ('ORG_ADMIN','FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE ehs_safety_permits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  work_order_id UUID,
  permit_number VARCHAR(100) NOT NULL,
  permit_type VARCHAR(32) NOT NULL,
  risk_level VARCHAR(12) NOT NULL,
  title VARCHAR(255) NOT NULL,
  work_scope TEXT NOT NULL,
  location VARCHAR(255) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  requires_isolation BOOLEAN NOT NULL DEFAULT FALSE,
  isolation_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  isolation_verification JSONB NOT NULL DEFAULT '[]'::jsonb,
  isolation_verified_by_user_id UUID,
  isolation_verified_at TIMESTAMPTZ,
  valid_from TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  requested_by_user_id UUID NOT NULL,
  approved_by_user_id UUID,
  approved_at TIMESTAMPTZ,
  decision_reason TEXT,
  activated_by_user_id UUID,
  activated_at TIMESTAMPTZ,
  closed_by_user_id UUID,
  closed_at TIMESTAMPTZ,
  closure_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  closure_reason TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  last_change_reason TEXT,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_ehs_permit_scope UNIQUE (id,tenant_id,factory_id),
  CONSTRAINT uq_ehs_permit_number UNIQUE (tenant_id,factory_id,permit_number),
  CONSTRAINT uq_ehs_permit_idempotency UNIQUE (tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_ehs_permit_factory FOREIGN KEY (factory_id,tenant_id)
    REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_permit_work_order FOREIGN KEY (work_order_id,tenant_id,factory_id)
    REFERENCES work_orders(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_permit_requester FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_permit_approver FOREIGN KEY (approved_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_permit_isolation_actor FOREIGN KEY (isolation_verified_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_permit_activator FOREIGN KEY (activated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_permit_closer FOREIGN KEY (closed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_ehs_permit_type CHECK (permit_type IN ('HOT_WORK','ELECTRICAL_LOTO','CONFINED_SPACE','WORK_AT_HEIGHT','CHEMICAL_HANDLING','GENERAL')),
  CONSTRAINT chk_ehs_permit_risk CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  CONSTRAINT chk_ehs_permit_status CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','ACTIVE','CLOSED','CANCELLED','EXPIRED')),
  CONSTRAINT chk_ehs_permit_title CHECK (length(btrim(title)) BETWEEN 1 AND 255),
  CONSTRAINT chk_ehs_permit_scope CHECK (length(btrim(work_scope))>0 AND length(btrim(location))>0),
  CONSTRAINT chk_ehs_permit_window CHECK (expires_at>valid_from AND expires_at<=valid_from+INTERVAL '7 days'),
  CONSTRAINT chk_ehs_permit_isolation_json CHECK (
    jsonb_typeof(isolation_points)='array' AND jsonb_typeof(isolation_verification)='array'
  ),
  CONSTRAINT chk_ehs_permit_closure_json CHECK (jsonb_typeof(closure_evidence)='object'),
  CONSTRAINT chk_ehs_permit_high_risk_isolation CHECK (
    permit_type NOT IN ('ELECTRICAL_LOTO','CONFINED_SPACE') AND risk_level NOT IN ('HIGH','CRITICAL')
    OR requires_isolation=TRUE
  ),
  CONSTRAINT chk_ehs_permit_approval_evidence CHECK (
    (status IN ('APPROVED','ACTIVE','CLOSED','EXPIRED') AND approved_by_user_id IS NOT NULL
      AND approved_at IS NOT NULL AND approved_by_user_id<>requested_by_user_id)
    OR (status IN ('DRAFT','PENDING_APPROVAL','REJECTED','CANCELLED')
      AND (status='REJECTED' OR (approved_by_user_id IS NULL AND approved_at IS NULL)))
  ),
  CONSTRAINT chk_ehs_permit_activation_evidence CHECK (
    (status IN ('ACTIVE','CLOSED','EXPIRED') AND activated_by_user_id IS NOT NULL AND activated_at IS NOT NULL)
    OR (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','CANCELLED')
      AND activated_by_user_id IS NULL AND activated_at IS NULL)
  ),
  CONSTRAINT chk_ehs_permit_closure_evidence CHECK (
    (status='CLOSED' AND closed_by_user_id IS NOT NULL AND closed_at IS NOT NULL
      AND jsonb_typeof(closure_evidence)='object' AND closure_evidence<>'{}'::jsonb
      AND length(btrim(COALESCE(closure_reason,'')))>0)
    OR (status<>'CLOSED' AND closed_by_user_id IS NULL AND closed_at IS NULL)
  ),
  CONSTRAINT chk_ehs_permit_isolation_stamp CHECK (
    (isolation_verified_at IS NULL AND isolation_verified_by_user_id IS NULL)
    OR (isolation_verified_at IS NOT NULL AND isolation_verified_by_user_id IS NOT NULL
      AND jsonb_array_length(isolation_verification)>0)
  ),
  CONSTRAINT chk_ehs_permit_version CHECK (row_version>0),
  CONSTRAINT chk_ehs_permit_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_ehs_permit_queue
  ON ehs_safety_permits(tenant_id,factory_id,status,risk_level,expires_at);
CREATE INDEX idx_ehs_permit_work_order
  ON ehs_safety_permits(tenant_id,factory_id,work_order_id,created_at DESC);

CREATE TABLE ehs_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  incident_number VARCHAR(100) NOT NULL,
  incident_type VARCHAR(32) NOT NULL,
  severity VARCHAR(12) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  location VARCHAR(255) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  immediate_action TEXT,
  assigned_owner_user_id UUID,
  due_at TIMESTAMPTZ,
  investigation_summary TEXT,
  root_cause TEXT,
  closure_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  closed_by_user_id UUID,
  closed_at TIMESTAMPTZ,
  row_version BIGINT NOT NULL DEFAULT 1,
  last_change_reason TEXT,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_ehs_incident_scope UNIQUE (id,tenant_id,factory_id),
  CONSTRAINT uq_ehs_incident_number UNIQUE (tenant_id,factory_id,incident_number),
  CONSTRAINT uq_ehs_incident_idempotency UNIQUE (tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_ehs_incident_factory FOREIGN KEY (factory_id,tenant_id)
    REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_incident_owner FOREIGN KEY (assigned_owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_incident_closer FOREIGN KEY (closed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_incident_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_incident_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_ehs_incident_type CHECK (incident_type IN ('INCIDENT','NEAR_MISS','UNSAFE_OBSERVATION','INJURY','ENVIRONMENTAL_RELEASE','AUDIT_FINDING')),
  CONSTRAINT chk_ehs_incident_severity CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  CONSTRAINT chk_ehs_incident_status CHECK (status IN ('OPEN','INVESTIGATING','ACTION_REQUIRED','RESOLVED','CLOSED','CANCELLED')),
  CONSTRAINT chk_ehs_incident_title CHECK (length(btrim(title)) BETWEEN 1 AND 255),
  CONSTRAINT chk_ehs_incident_description CHECK (length(btrim(description))>0 AND length(btrim(location))>0),
  CONSTRAINT chk_ehs_incident_due CHECK (due_at IS NULL OR due_at>=occurred_at),
  CONSTRAINT chk_ehs_incident_evidence CHECK (jsonb_typeof(closure_evidence)='object'),
  CONSTRAINT chk_ehs_incident_closure CHECK (
    (status='CLOSED' AND closed_by_user_id IS NOT NULL AND closed_at IS NOT NULL
      AND length(btrim(COALESCE(root_cause,'')))>0 AND closure_evidence<>'{}'::jsonb)
    OR (status<>'CLOSED' AND closed_by_user_id IS NULL AND closed_at IS NULL)
  ),
  CONSTRAINT chk_ehs_incident_version CHECK (row_version>0),
  CONSTRAINT chk_ehs_incident_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_ehs_incident_queue
  ON ehs_incidents(tenant_id,factory_id,status,severity,due_at,occurred_at DESC);

CREATE TABLE ehs_corrective_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  incident_id UUID NOT NULL,
  action_number VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  assigned_owner_user_id UUID NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'OPEN',
  root_cause TEXT,
  completion_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  verification_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_by_user_id UUID,
  submitted_at TIMESTAMPTZ,
  verified_by_user_id UUID,
  verified_at TIMESTAMPTZ,
  row_version BIGINT NOT NULL DEFAULT 1,
  last_change_reason TEXT,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_ehs_action_scope UNIQUE (id,tenant_id,factory_id),
  CONSTRAINT uq_ehs_action_number UNIQUE (tenant_id,factory_id,action_number),
  CONSTRAINT uq_ehs_action_idempotency UNIQUE (tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_ehs_action_incident FOREIGN KEY (incident_id,tenant_id,factory_id)
    REFERENCES ehs_incidents(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_action_owner FOREIGN KEY (assigned_owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_action_submitter FOREIGN KEY (submitted_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_action_verifier FOREIGN KEY (verified_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_action_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ehs_action_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_ehs_action_status CHECK (status IN ('OPEN','IN_PROGRESS','READY_FOR_VERIFICATION','VERIFIED','CANCELLED')),
  CONSTRAINT chk_ehs_action_description CHECK (length(btrim(description))>0),
  CONSTRAINT chk_ehs_action_evidence CHECK (
    jsonb_typeof(completion_evidence)='object' AND jsonb_typeof(verification_evidence)='object'
  ),
  CONSTRAINT chk_ehs_action_verification CHECK (
    (status='VERIFIED' AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL
      AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL
      AND verified_by_user_id<>assigned_owner_user_id AND verified_by_user_id<>submitted_by_user_id
      AND completion_evidence<>'{}'::jsonb AND verification_evidence<>'{}'::jsonb)
    OR (status<>'VERIFIED' AND verified_by_user_id IS NULL AND verified_at IS NULL)
  ),
  CONSTRAINT chk_ehs_action_submission CHECK (
    (status IN ('READY_FOR_VERIFICATION','VERIFIED') AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL
      AND completion_evidence<>'{}'::jsonb)
    OR (status NOT IN ('READY_FOR_VERIFICATION','VERIFIED') AND submitted_by_user_id IS NULL AND submitted_at IS NULL)
  ),
  CONSTRAINT chk_ehs_action_version CHECK (row_version>0),
  CONSTRAINT chk_ehs_action_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_ehs_actions_incident
  ON ehs_corrective_actions(tenant_id,factory_id,incident_id,status,due_at);
CREATE INDEX idx_ehs_actions_owner
  ON ehs_corrective_actions(tenant_id,factory_id,assigned_owner_user_id,status,due_at);

CREATE TABLE ehs_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id UUID NOT NULL,
  entity_version BIGINT NOT NULL,
  action VARCHAR(48) NOT NULL,
  actor_user_id UUID NOT NULL,
  reason TEXT,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_ehs_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_ehs_audit_type CHECK (entity_type IN ('PERMIT','INCIDENT','CORRECTIVE_ACTION')),
  CONSTRAINT chk_ehs_audit_version CHECK (entity_version>0),
  CONSTRAINT chk_ehs_audit_data CHECK (jsonb_typeof(event_data)='object')
);
CREATE INDEX idx_ehs_audit_entity
  ON ehs_audit_events(tenant_id,factory_id,entity_type,entity_id,created_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ehs_safety_permits','ehs_incidents','ehs_corrective_actions','ehs_audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id())',
      t||'_tenant_isolation',t);
  END LOOP;
END;
$$;

INSERT INTO schema_migrations(version,checksum)
VALUES ('110_ehs_safety_permits_incidents_actions',NULL)
ON CONFLICT(version) DO NOTHING;
COMMIT;
