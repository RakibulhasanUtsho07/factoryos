BEGIN;

-- WP10-D / FR-PROD-05: versioned subscription lifecycle with an immutable event ledger.
INSERT INTO permissions(code, description) VALUES
 ('saas.subscriptions.read', 'Read tenant subscription state and lifecycle history'),
 ('saas.subscriptions.write', 'Start and transition tenant subscriptions'),
 ('saas.subscription_plans.read', 'Read tenant subscription plan catalogue'),
 ('saas.subscription_plans.write', 'Create immutable tenant subscription plan versions')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code IN (
    'saas.subscriptions.read',
    'saas.subscriptions.write',
    'saas.subscription_plans.read',
    'saas.subscription_plans.write'
  )
ON CONFLICT(role_id, permission_id) DO NOTHING;

CREATE TABLE saas_subscription_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  plan_code VARCHAR(80) NOT NULL,
  version INTEGER NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  tier_rank INTEGER NOT NULL,
  deployment_profile VARCHAR(24) NOT NULL DEFAULT 'SHARED_SAAS',
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_subscription_plan_scope_id UNIQUE(id, tenant_id),
  CONSTRAINT uq_saas_subscription_plan_version UNIQUE(tenant_id, plan_code, version),
  CONSTRAINT chk_saas_plan_code CHECK(plan_code ~ '^[A-Z][A-Z0-9_:-]{0,79}$'),
  CONSTRAINT chk_saas_plan_version CHECK(version BETWEEN 1 AND 1000000),
  CONSTRAINT chk_saas_plan_name CHECK(length(btrim(display_name)) BETWEEN 1 AND 160),
  CONSTRAINT chk_saas_plan_rank CHECK(tier_rank BETWEEN 1 AND 1000000),
  CONSTRAINT chk_saas_plan_deployment_profile CHECK(deployment_profile IN ('SHARED_SAAS','SINGLE_TENANT','DEDICATED_VPC','HYBRID_EDGE_CLOUD')),
  CONSTRAINT chk_saas_plan_status CHECK(status IN ('ACTIVE','DISABLED')),
  CONSTRAINT chk_saas_plan_capabilities CHECK(jsonb_typeof(capabilities) = 'object' AND octet_length(capabilities::text) <= 16384),
  CONSTRAINT chk_saas_plan_idempotency CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_plan_request_hash CHECK(request_hash ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX uq_saas_subscription_plan_idempotency
  ON saas_subscription_plans(tenant_id, idempotency_key);
CREATE INDEX idx_saas_subscription_plan_lookup
  ON saas_subscription_plans(tenant_id, plan_code, version DESC);
CREATE INDEX idx_saas_subscription_plan_active
  ON saas_subscription_plans(tenant_id, status, tier_rank);

CREATE TRIGGER saas_subscription_plan_immutable
BEFORE UPDATE OR DELETE ON saas_subscription_plans
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

ALTER TABLE saas_subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_subscription_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY saas_subscription_plans_tenant_isolation
ON saas_subscription_plans
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE TABLE saas_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  plan_code VARCHAR(80) NOT NULL,
  plan_version INTEGER NOT NULL,
  status VARCHAR(12) NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  trial_ends_at TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  terminated_at TIMESTAMPTZ,
  last_transition_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_subscription_scope_id UNIQUE(id, tenant_id),
  CONSTRAINT fk_saas_subscription_plan FOREIGN KEY(tenant_id, plan_code, plan_version)
    REFERENCES saas_subscription_plans(tenant_id, plan_code, version) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_subscription_status CHECK(status IN ('TRIAL','ACTIVE','SUSPENDED','TERMINATED','EXPIRED')),
  CONSTRAINT chk_saas_subscription_version CHECK(version BETWEEN 1 AND 9223372036854775807),
  CONSTRAINT chk_saas_subscription_trial_end CHECK(trial_ends_at IS NULL OR trial_ends_at > started_at),
  CONSTRAINT chk_saas_subscription_period CHECK(
    (current_period_start IS NULL AND current_period_end IS NULL)
    OR (current_period_start IS NOT NULL AND current_period_end IS NOT NULL AND current_period_end > current_period_start)
  ),
  CONSTRAINT chk_saas_subscription_termination CHECK(
    (status = 'TERMINATED' AND terminated_at IS NOT NULL)
    OR (status <> 'TERMINATED' AND terminated_at IS NULL)
  ),
  CONSTRAINT chk_saas_subscription_suspension CHECK(
    (status = 'SUSPENDED' AND suspended_at IS NOT NULL)
    OR (status <> 'SUSPENDED' AND suspended_at IS NULL)
  )
);

-- Only one non-terminal subscription per tenant; a terminated/expired
-- subscription remains available for audit and a later subscription can be created.
CREATE UNIQUE INDEX uq_saas_subscription_one_live_per_tenant
  ON saas_subscriptions(tenant_id)
  WHERE status NOT IN ('TERMINATED','EXPIRED');
CREATE INDEX idx_saas_subscription_tenant_history
  ON saas_subscriptions(tenant_id, created_at DESC, id DESC);

ALTER TABLE saas_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY saas_subscriptions_tenant_isolation
ON saas_subscriptions
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE TABLE saas_subscription_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  subscription_id UUID NOT NULL,
  subscription_version BIGINT NOT NULL,
  event_type VARCHAR(20) NOT NULL,
  from_status VARCHAR(12),
  to_status VARCHAR(12) NOT NULL,
  prior_plan_code VARCHAR(80),
  prior_plan_version INTEGER,
  plan_code VARCHAR(80) NOT NULL,
  plan_version INTEGER NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  reason VARCHAR(1000),
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_saas_subscription_event_scope FOREIGN KEY(subscription_id, tenant_id)
    REFERENCES saas_subscriptions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_saas_subscription_event_plan FOREIGN KEY(tenant_id, plan_code, plan_version)
    REFERENCES saas_subscription_plans(tenant_id, plan_code, version) ON DELETE RESTRICT,
  CONSTRAINT fk_saas_subscription_event_prior_plan FOREIGN KEY(tenant_id, prior_plan_code, prior_plan_version)
    REFERENCES saas_subscription_plans(tenant_id, plan_code, version) ON DELETE RESTRICT,
  CONSTRAINT uq_saas_subscription_event_version UNIQUE(subscription_id, subscription_version),
  CONSTRAINT uq_saas_subscription_event_idempotency UNIQUE(tenant_id, idempotency_key),
  CONSTRAINT chk_saas_subscription_event_type CHECK(event_type IN (
    'TRIAL_STARTED','ACTIVATED','SUSPENDED','RESUMED','UPGRADED','DOWNGRADED','RENEWED','TERMINATED','EXPIRED'
  )),
  CONSTRAINT chk_saas_subscription_event_from_status CHECK(from_status IS NULL OR from_status IN ('TRIAL','ACTIVE','SUSPENDED','TERMINATED','EXPIRED')),
  CONSTRAINT chk_saas_subscription_event_to_status CHECK(to_status IN ('TRIAL','ACTIVE','SUSPENDED','TERMINATED','EXPIRED')),
  CONSTRAINT chk_saas_subscription_event_version CHECK(subscription_version BETWEEN 1 AND 9223372036854775807),
  CONSTRAINT chk_saas_subscription_event_key CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_subscription_event_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_subscription_event_reason CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1000),
  CONSTRAINT chk_saas_subscription_event_plan_pair CHECK(
    (prior_plan_code IS NULL AND prior_plan_version IS NULL)
    OR (prior_plan_code IS NOT NULL AND prior_plan_version IS NOT NULL)
  )
);

CREATE INDEX idx_saas_subscription_events_timeline
  ON saas_subscription_events(tenant_id, subscription_id, subscription_version DESC);

CREATE TRIGGER saas_subscription_events_immutable
BEFORE UPDATE OR DELETE ON saas_subscription_events
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

ALTER TABLE saas_subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_subscription_events FORCE ROW LEVEL SECURITY;
CREATE POLICY saas_subscription_events_tenant_isolation
ON saas_subscription_events
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_validate_saas_subscription_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.status <> 'TRIAL' THEN
      RAISE EXCEPTION 'New subscriptions must begin at version 1 in TRIAL status'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Subscription version must increase by exactly one'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('TERMINATED','EXPIRED') THEN
    RAISE EXCEPTION 'Terminal subscriptions cannot be transitioned'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'TRIAL' AND NEW.status NOT IN ('TRIAL','ACTIVE','SUSPENDED','TERMINATED','EXPIRED') THEN
    RAISE EXCEPTION 'Invalid transition from TRIAL'
      USING ERRCODE = '23514';
  ELSIF OLD.status = 'ACTIVE' AND NEW.status NOT IN ('ACTIVE','SUSPENDED','TERMINATED','EXPIRED') THEN
    RAISE EXCEPTION 'Invalid transition from ACTIVE'
      USING ERRCODE = '23514';
  ELSIF OLD.status = 'SUSPENDED' AND NEW.status NOT IN ('ACTIVE','SUSPENDED','TERMINATED','EXPIRED') THEN
    RAISE EXCEPTION 'Invalid transition from SUSPENDED'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_subscription_state_guard
BEFORE INSERT OR UPDATE ON saas_subscriptions
FOR EACH ROW EXECUTE FUNCTION factoryos_validate_saas_subscription_transition();

CREATE TRIGGER saas_subscription_no_delete
BEFORE DELETE ON saas_subscriptions
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

-- Enforce the state/event dual write at commit time: application or SQL callers
-- cannot commit a current state version without its matching immutable event.
CREATE OR REPLACE FUNCTION factoryos_require_saas_subscription_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM saas_subscription_events e
    WHERE e.tenant_id = NEW.tenant_id
      AND e.subscription_id = NEW.id
      AND e.subscription_version = NEW.version
      AND e.to_status = NEW.status
      AND e.plan_code = NEW.plan_code
      AND e.plan_version = NEW.plan_version
  ) THEN
    RAISE EXCEPTION 'Subscription state must have a matching immutable lifecycle event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER saas_subscription_event_required
AFTER INSERT OR UPDATE ON saas_subscriptions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_require_saas_subscription_event();

INSERT INTO schema_migrations(version, checksum)
VALUES ('048_saas_subscription_lifecycle', NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
