BEGIN;

-- WP10-E / FR-SAAS2-04, FR-PPX-01, FR-PPX-04, FR-PPX-05:
-- tenant-scoped sandbox control plane. Only provenance/approval metadata is stored;
-- dataset rows or raw customer payloads must never be stored in this registry.
INSERT INTO permissions(code, description) VALUES
 ('saas.sandboxes.read', 'Read tenant sandbox environment metadata and audit history'),
 ('saas.sandboxes.write', 'Create tenant sandbox environment definitions'),
 ('saas.sandboxes.approve_masked_data', 'Approve explicitly masked data for sandbox use'),
 ('saas.sandboxes.control', 'Suspend or retire tenant sandbox environments')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code IN (
    'saas.sandboxes.read',
    'saas.sandboxes.write',
    'saas.sandboxes.approve_masked_data',
    'saas.sandboxes.control'
  )
ON CONFLICT(role_id, permission_id) DO NOTHING;

CREATE TABLE saas_sandbox_environments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  environment_code VARCHAR(48) NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  purpose VARCHAR(16) NOT NULL,
  data_mode VARCHAR(12) NOT NULL,
  status VARCHAR(20) NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  dataset_manifest JSONB NOT NULL,
  privacy_assessment JSONB NOT NULL DEFAULT '{}'::jsonb,
  approval_requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  approval_reason VARCHAR(1000),
  approved_at TIMESTAMPTZ,
  approval_expires_at TIMESTAMPTZ,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_sandbox_scope_id UNIQUE(id, tenant_id),
  CONSTRAINT uq_saas_sandbox_code UNIQUE(tenant_id, environment_code),
  CONSTRAINT uq_saas_sandbox_idempotency UNIQUE(tenant_id, idempotency_key),
  CONSTRAINT chk_saas_sandbox_code CHECK(environment_code ~ '^[A-Z][A-Z0-9_-]{0,47}$'),
  CONSTRAINT chk_saas_sandbox_name CHECK(length(btrim(display_name)) BETWEEN 1 AND 160),
  CONSTRAINT chk_saas_sandbox_purpose CHECK(purpose IN ('DEMO','TEST','EVALUATION','TRAINING')),
  CONSTRAINT chk_saas_sandbox_mode CHECK(data_mode IN ('SYNTHETIC','MASKED')),
  CONSTRAINT chk_saas_sandbox_status CHECK(status IN ('PENDING_APPROVAL','ACTIVE','SUSPENDED','RETIRED')),
  CONSTRAINT chk_saas_sandbox_version CHECK(version BETWEEN 1 AND 9223372036854775807),
  CONSTRAINT chk_saas_sandbox_requester CHECK(approval_requested_by = created_by),
  CONSTRAINT chk_saas_sandbox_manifest CHECK(
    jsonb_typeof(dataset_manifest) = 'object'
    AND octet_length(dataset_manifest::text) <= 16384
  ),
  CONSTRAINT chk_saas_sandbox_privacy_assessment CHECK(
    jsonb_typeof(privacy_assessment) = 'object'
    AND octet_length(privacy_assessment::text) <= 16384
  ),
  CONSTRAINT chk_saas_sandbox_record_count CHECK(
    CASE WHEN jsonb_typeof(dataset_manifest->'record_count') = 'number'
      THEN (dataset_manifest->>'record_count')::numeric BETWEEN 0 AND 100000000
      ELSE false
    END
  ),
  CONSTRAINT chk_saas_sandbox_manifest_mode CHECK(
    (data_mode = 'SYNTHETIC'
      AND dataset_manifest ? 'generator'
      AND dataset_manifest ? 'generator_version'
      AND dataset_manifest ? 'schema_version'
      AND dataset_manifest ? 'seed'
      AND jsonb_typeof(dataset_manifest->'record_count') = 'number'
      AND status IN ('ACTIVE','SUSPENDED','RETIRED'))
    OR
    (data_mode = 'MASKED'
      AND dataset_manifest ? 'dataset_reference'
      AND dataset_manifest ? 'schema_version'
      AND dataset_manifest ? 'masking_policy_version'
      AND dataset_manifest ? 'masked_at'
      AND dataset_manifest ? 'checksum_sha256'
      AND jsonb_typeof(dataset_manifest->'record_count') = 'number')
  ),
  CONSTRAINT chk_saas_sandbox_masked_assessment CHECK(
    data_mode <> 'MASKED'
    OR (
      privacy_assessment->>'data_minimization_status' = 'ASSESSED'
      AND privacy_assessment->>'residual_risk' IN ('LOW','MEDIUM')
      AND jsonb_typeof(privacy_assessment->'reviewed_fields') = 'array'
      AND jsonb_array_length(privacy_assessment->'reviewed_fields') BETWEEN 1 AND 100
      AND jsonb_typeof(privacy_assessment->'assessed_at') = 'string'
    )
  ),
  CONSTRAINT chk_saas_sandbox_approval CHECK(
    (data_mode = 'SYNTHETIC'
      AND approved_by IS NULL AND approval_reason IS NULL
      AND approved_at IS NULL AND approval_expires_at IS NULL)
    OR
    (data_mode = 'MASKED' AND status = 'PENDING_APPROVAL'
      AND approved_by IS NULL AND approval_reason IS NULL
      AND approved_at IS NULL AND approval_expires_at IS NULL)
    OR
    (data_mode = 'MASKED' AND status = 'RETIRED'
      AND (
        (approved_by IS NULL AND approval_reason IS NULL AND approved_at IS NULL AND approval_expires_at IS NULL)
        OR
        (approved_by IS NOT NULL AND approved_by <> created_by
          AND approval_reason IS NOT NULL AND length(btrim(approval_reason)) BETWEEN 1 AND 1000
          AND approved_at IS NOT NULL AND approval_expires_at > approved_at
          AND approval_expires_at <= approved_at + interval '90 days')
      ))
    OR
    (data_mode = 'MASKED' AND status IN ('ACTIVE','SUSPENDED')
      AND approved_by IS NOT NULL AND approved_by <> created_by
      AND approval_reason IS NOT NULL AND length(btrim(approval_reason)) BETWEEN 1 AND 1000
      AND approved_at IS NOT NULL AND approval_expires_at > approved_at
      AND approval_expires_at <= approved_at + interval '90 days')
  ),
  CONSTRAINT chk_saas_sandbox_idempotency CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_sandbox_request_hash CHECK(request_hash ~ '^[a-f0-9]{64}$')
);

CREATE INDEX idx_saas_sandbox_tenant_status
  ON saas_sandbox_environments(tenant_id, status, created_at DESC);
CREATE INDEX idx_saas_sandbox_masked_expiry
  ON saas_sandbox_environments(tenant_id, approval_expires_at)
  WHERE data_mode = 'MASKED' AND status IN ('ACTIVE','SUSPENDED');

ALTER TABLE saas_sandbox_environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_sandbox_environments FORCE ROW LEVEL SECURITY;
CREATE POLICY saas_sandbox_environments_tenant_isolation
ON saas_sandbox_environments
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE TABLE saas_sandbox_environment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  environment_id UUID NOT NULL,
  environment_version BIGINT NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  data_mode VARCHAR(12) NOT NULL,
  reason VARCHAR(1000),
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_saas_sandbox_event_scope FOREIGN KEY(environment_id, tenant_id)
    REFERENCES saas_sandbox_environments(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT uq_saas_sandbox_event_version UNIQUE(environment_id, environment_version),
  CONSTRAINT uq_saas_sandbox_event_idempotency UNIQUE(tenant_id, idempotency_key),
  CONSTRAINT chk_saas_sandbox_event_type CHECK(event_type IN (
    'CREATED','MASKED_APPROVAL_REQUESTED','MASKED_DATA_APPROVED','SUSPENDED','RESUMED','RETIRED'
  )),
  CONSTRAINT chk_saas_sandbox_event_from CHECK(from_status IS NULL OR from_status IN ('PENDING_APPROVAL','ACTIVE','SUSPENDED','RETIRED')),
  CONSTRAINT chk_saas_sandbox_event_to CHECK(to_status IN ('PENDING_APPROVAL','ACTIVE','SUSPENDED','RETIRED')),
  CONSTRAINT chk_saas_sandbox_event_mode CHECK(data_mode IN ('SYNTHETIC','MASKED')),
  CONSTRAINT chk_saas_sandbox_event_reason CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1000),
  CONSTRAINT chk_saas_sandbox_event_key CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_sandbox_event_hash CHECK(request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX idx_saas_sandbox_events_timeline
  ON saas_sandbox_environment_events(tenant_id, environment_id, environment_version DESC);
ALTER TABLE saas_sandbox_environment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_sandbox_environment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY saas_sandbox_environment_events_tenant_isolation
ON saas_sandbox_environment_events
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());
CREATE TRIGGER saas_sandbox_environment_events_immutable
BEFORE UPDATE OR DELETE ON saas_sandbox_environment_events
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_sandbox_environment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1
      OR (NEW.data_mode = 'SYNTHETIC' AND NEW.status <> 'ACTIVE')
      OR (NEW.data_mode = 'MASKED' AND NEW.status <> 'PENDING_APPROVAL') THEN
      RAISE EXCEPTION 'Sandbox creation must start in its safe initial state'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.environment_code IS DISTINCT FROM OLD.environment_code
    OR NEW.display_name IS DISTINCT FROM OLD.display_name
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.data_mode IS DISTINCT FROM OLD.data_mode
    OR NEW.dataset_manifest IS DISTINCT FROM OLD.dataset_manifest
    OR NEW.privacy_assessment IS DISTINCT FROM OLD.privacy_assessment
    OR NEW.approval_requested_by IS DISTINCT FROM OLD.approval_requested_by
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Sandbox definitions and dataset provenance are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Sandbox lifecycle version must increase by exactly one'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'PENDING_APPROVAL' AND NEW.status = 'ACTIVE'
    AND NEW.data_mode = 'MASKED'
    AND NEW.approved_by IS NOT NULL
    AND NEW.approved_by <> NEW.created_by
    AND NEW.approved_at IS NOT NULL
    AND NEW.approval_expires_at > clock_timestamp()
    AND NEW.approval_expires_at <= clock_timestamp() + interval '90 days'
    AND NEW.approval_reason IS NOT NULL THEN
    RETURN NEW;
  ELSIF OLD.status = 'PENDING_APPROVAL' AND NEW.status = 'RETIRED' THEN
    RETURN NEW;
  ELSIF OLD.status = 'ACTIVE' AND NEW.status = 'SUSPENDED' THEN
    IF (NEW.approved_by, NEW.approval_reason, NEW.approved_at, NEW.approval_expires_at)
      IS DISTINCT FROM
       (OLD.approved_by, OLD.approval_reason, OLD.approved_at, OLD.approval_expires_at) THEN
      RAISE EXCEPTION 'Suspending a sandbox cannot change its approval record'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  ELSIF OLD.status = 'SUSPENDED' AND NEW.status = 'ACTIVE' THEN
    IF NEW.data_mode = 'MASKED' AND (
      NEW.approved_by IS DISTINCT FROM OLD.approved_by
      OR NEW.approval_reason IS DISTINCT FROM OLD.approval_reason
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.approval_expires_at IS DISTINCT FROM OLD.approval_expires_at
    ) THEN
      IF NEW.approved_by IS NULL OR NEW.approved_by = NEW.created_by
        OR NEW.approved_at IS NULL OR NEW.approval_expires_at <= clock_timestamp()
        OR NEW.approval_expires_at > clock_timestamp() + interval '90 days'
        OR NEW.approval_reason IS NULL THEN
        RAISE EXCEPTION 'Renewed masked-data approval is incomplete or expired'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.data_mode = 'MASKED' AND NEW.approval_expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'Expired masked-data approval cannot resume a sandbox'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  ELSIF OLD.status = 'ACTIVE' AND NEW.status = 'ACTIVE'
    AND OLD.data_mode = 'MASKED'
    AND OLD.approval_expires_at <= clock_timestamp()
    AND NEW.approved_by IS NOT NULL
    AND NEW.approved_by <> NEW.created_by
    AND NEW.approval_expires_at > clock_timestamp()
    AND NEW.approval_expires_at <= clock_timestamp() + interval '90 days'
    AND NEW.approved_at IS NOT NULL
    AND NEW.approval_reason IS NOT NULL
    AND NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RETURN NEW;
  ELSIF OLD.status IN ('ACTIVE','SUSPENDED') AND NEW.status = 'RETIRED' THEN
    IF (NEW.approved_by, NEW.approval_reason, NEW.approved_at, NEW.approval_expires_at)
      IS DISTINCT FROM
       (OLD.approved_by, OLD.approval_reason, OLD.approved_at, OLD.approval_expires_at) THEN
      RAISE EXCEPTION 'Retiring a sandbox cannot change its approval record'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Unsupported sandbox lifecycle transition'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER saas_sandbox_environment_lifecycle_guard
BEFORE INSERT OR UPDATE ON saas_sandbox_environments
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_sandbox_environment();

CREATE OR REPLACE FUNCTION factoryos_require_saas_sandbox_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_row saas_sandbox_environment_events%ROWTYPE;
  expected_event_type VARCHAR(32);
  expected_from_status VARCHAR(20);
BEGIN
  IF TG_OP = 'INSERT' THEN
    expected_event_type := CASE WHEN NEW.data_mode = 'SYNTHETIC'
      THEN 'CREATED' ELSE 'MASKED_APPROVAL_REQUESTED' END;
    expected_from_status := NULL;
  ELSIF NEW.status = 'RETIRED' THEN
    expected_event_type := 'RETIRED';
    expected_from_status := OLD.status;
  ELSIF NEW.status = 'SUSPENDED' THEN
    expected_event_type := 'SUSPENDED';
    expected_from_status := OLD.status;
  ELSIF NEW.status = 'ACTIVE' AND OLD.status = 'SUSPENDED'
    AND (NEW.data_mode = 'SYNTHETIC' OR NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at) THEN
    expected_event_type := 'RESUMED';
    expected_from_status := OLD.status;
  ELSIF NEW.status = 'ACTIVE' AND NEW.data_mode = 'MASKED'
    AND (OLD.status = 'PENDING_APPROVAL'
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    expected_event_type := 'MASKED_DATA_APPROVED';
    expected_from_status := OLD.status;
  ELSE
    RAISE EXCEPTION 'Sandbox lifecycle event cannot be derived for this change'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO event_row
  FROM saas_sandbox_environment_events
  WHERE environment_id = NEW.id
    AND tenant_id = NEW.tenant_id
    AND environment_version = NEW.version;

  IF NOT FOUND
    OR event_row.event_type <> expected_event_type
    OR event_row.from_status IS DISTINCT FROM expected_from_status
    OR event_row.to_status <> NEW.status
    OR event_row.data_mode <> NEW.data_mode
    OR event_row.actor_user_id <> NEW.updated_by
    OR event_row.idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Sandbox state/version requires a matching lifecycle event'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER saas_sandbox_lifecycle_event_required
AFTER INSERT OR UPDATE ON saas_sandbox_environments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_require_saas_sandbox_event();

INSERT INTO schema_migrations(version, checksum)
VALUES ('049_saas_sandbox_environments', NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
