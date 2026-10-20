BEGIN;

INSERT INTO permissions(code,description) VALUES
 ('saas.entitlement_modes.read','Read tenant subscription-enforcement mode'),
 ('saas.entitlement_modes.write','Migrate a tenant from legacy entitlement compatibility to subscription enforcement')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code='ORG_ADMIN' AND r.is_system=true
  AND p.code IN('saas.entitlement_modes.read','saas.entitlement_modes.write')
ON CONFLICT(role_id,permission_id) DO NOTHING;

-- No row means LEGACY_COMPATIBLE for existing tenants. The first explicit
-- migration to SUBSCRIPTION_REQUIRED is recorded as immutable version 1+.
CREATE TABLE IF NOT EXISTS saas_entitlement_enforcement_modes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  mode VARCHAR(32) NOT NULL,
  reason VARCHAR(2000) NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  changed_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_entitlement_mode_version UNIQUE(tenant_id,version),
  CONSTRAINT uq_saas_entitlement_mode_idempotency UNIQUE(tenant_id,idempotency_key),
  CONSTRAINT chk_saas_entitlement_mode_version CHECK(version BETWEEN 1 AND 1000000),
  CONSTRAINT chk_saas_entitlement_mode CHECK(mode IN('LEGACY_COMPATIBLE','SUBSCRIPTION_REQUIRED')),
  CONSTRAINT chk_saas_entitlement_mode_reason CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT chk_saas_entitlement_mode_key CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_entitlement_mode_hash CHECK(request_hash ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_saas_entitlement_mode_latest
  ON saas_entitlement_enforcement_modes(tenant_id,version DESC);

ALTER TABLE saas_entitlement_enforcement_modes ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_entitlement_enforcement_modes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_entitlement_enforcement_modes_tenant_isolation
  ON saas_entitlement_enforcement_modes;
CREATE POLICY saas_entitlement_enforcement_modes_tenant_isolation
ON saas_entitlement_enforcement_modes
USING(tenant_id=factoryos_current_tenant_id())
WITH CHECK(tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_validate_saas_entitlement_mode_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  latest_version INTEGER;
BEGIN
  SELECT COALESCE(MAX(version),0)
    INTO latest_version
    FROM saas_entitlement_enforcement_modes
   WHERE tenant_id=NEW.tenant_id;

  IF NEW.version <> latest_version + 1 THEN
    RAISE EXCEPTION 'Entitlement enforcement mode version must increase by exactly one'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM saas_entitlement_enforcement_modes
     WHERE tenant_id=NEW.tenant_id
       AND mode='SUBSCRIPTION_REQUIRED'
  ) AND NEW.mode <> 'SUBSCRIPTION_REQUIRED' THEN
    RAISE EXCEPTION 'Subscription-required enforcement cannot be downgraded to legacy compatibility'
      USING ERRCODE='23514';
  END IF;

  IF NEW.mode='SUBSCRIPTION_REQUIRED' AND NOT EXISTS (
    SELECT 1
      FROM saas_subscriptions s
     WHERE s.tenant_id=NEW.tenant_id
       AND (
         (s.status='TRIAL' AND s.trial_ends_at > clock_timestamp())
         OR
         (s.status='ACTIVE'
          AND s.current_period_start <= clock_timestamp()
          AND s.current_period_end > clock_timestamp())
       )
  ) THEN
    RAISE EXCEPTION 'Subscription-required mode needs an eligible active subscription or unexpired trial'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_saas_entitlement_mode_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'SaaS entitlement mode history is append-only: % is not allowed', TG_OP
    USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS saas_entitlement_mode_insert_guard
  ON saas_entitlement_enforcement_modes;
CREATE TRIGGER saas_entitlement_mode_insert_guard
BEFORE INSERT ON saas_entitlement_enforcement_modes
FOR EACH ROW EXECUTE FUNCTION factoryos_validate_saas_entitlement_mode_insert();

DROP TRIGGER IF EXISTS saas_entitlement_mode_immutable
  ON saas_entitlement_enforcement_modes;
CREATE TRIGGER saas_entitlement_mode_immutable
BEFORE UPDATE OR DELETE ON saas_entitlement_enforcement_modes
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_entitlement_mode_mutation();

INSERT INTO schema_migrations(version,checksum)
VALUES('154_saas_entitlement_enforcement_modes',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
