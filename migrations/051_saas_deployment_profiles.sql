BEGIN;

-- WP10-G / FR-SAAS2-07: versioned deployment topology assignments.
-- This is a control-plane registry; it never changes tenant identity/RLS semantics
-- and does not provision infrastructure itself.
INSERT INTO permissions(code, description) VALUES
 ('saas.deployment_profiles.read', 'Read effective tenant/factory deployment profile and its history'),
 ('saas.deployment_profiles.write', 'Register a deployment profile assignment'),
 ('saas.deployment_profiles.control', 'Progress, pause, migrate, fail or retire a deployment profile')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code IN (
    'saas.deployment_profiles.read',
    'saas.deployment_profiles.write',
    'saas.deployment_profiles.control'
  )
ON CONFLICT(role_id, permission_id) DO NOTHING;

CREATE TABLE saas_deployment_profile_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  scope_type VARCHAR(12) NOT NULL,
  scope_key VARCHAR(48) NOT NULL,
  factory_id UUID,
  version BIGINT NOT NULL,
  profile_type VARCHAR(24) NOT NULL,
  status VARCHAR(16) NOT NULL,
  action VARCHAR(24) NOT NULL,
  deployment_reference VARCHAR(200),
  region_code VARCHAR(64),
  residency_domain VARCHAR(64),
  edge_site_code VARCHAR(80),
  target_profile_type VARCHAR(24),
  target_deployment_reference VARCHAR(200),
  target_region_code VARCHAR(64),
  target_residency_domain VARCHAR(64),
  target_edge_site_code VARCHAR(80),
  previous_version BIGINT,
  reason VARCHAR(1000) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_saas_deployment_profile_version
    UNIQUE(tenant_id, scope_key, version),
  CONSTRAINT uq_saas_deployment_profile_id_scope UNIQUE(id, tenant_id),
  CONSTRAINT uq_saas_deployment_profile_idempotency UNIQUE(tenant_id, idempotency_key),
  CONSTRAINT fk_saas_deployment_profile_factory
    FOREIGN KEY(factory_id, tenant_id) REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_saas_deployment_profile_previous
    FOREIGN KEY(tenant_id, scope_key, previous_version)
    REFERENCES saas_deployment_profile_versions(tenant_id, scope_key, version)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,

  CONSTRAINT chk_saas_deployment_profile_scope CHECK(
    (scope_type = 'TENANT' AND factory_id IS NULL AND scope_key = 'TENANT')
    OR
    (scope_type = 'FACTORY' AND factory_id IS NOT NULL
      AND scope_key = 'FACTORY:' || factory_id::text)
  ),
  CONSTRAINT chk_saas_deployment_profile_version CHECK(version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_saas_deployment_profile_type CHECK(
    profile_type IN ('SHARED_SAAS','SINGLE_TENANT','DEDICATED_VPC','HYBRID_EDGE_CLOUD')
  ),
  CONSTRAINT chk_saas_deployment_profile_status CHECK(
    status IN ('PLANNED','PROVISIONING','ACTIVE','MIGRATING','PAUSED','FAILED','RETIRED')
  ),
  CONSTRAINT chk_saas_deployment_profile_action CHECK(
    action IN ('REGISTER','START_PROVISIONING','ACTIVATE','START_MIGRATION',
      'COMPLETE_MIGRATION','PAUSE','RESUME','FAIL','RETIRE')
  ),
  CONSTRAINT chk_saas_deployment_profile_reference CHECK(
    deployment_reference IS NULL OR deployment_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  CONSTRAINT chk_saas_deployment_profile_region CHECK(
    region_code IS NULL OR region_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  ),
  CONSTRAINT chk_saas_deployment_profile_residency CHECK(
    residency_domain IS NULL OR residency_domain ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  ),
  CONSTRAINT chk_saas_deployment_profile_edge CHECK(
    edge_site_code IS NULL OR edge_site_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
  ),
  CONSTRAINT chk_saas_deployment_profile_target_type CHECK(
    target_profile_type IS NULL OR target_profile_type IN (
      'SHARED_SAAS','SINGLE_TENANT','DEDICATED_VPC','HYBRID_EDGE_CLOUD'
    )
  ),
  CONSTRAINT chk_saas_deployment_profile_target_reference CHECK(
    target_deployment_reference IS NULL OR
      target_deployment_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  CONSTRAINT chk_saas_deployment_profile_target_region CHECK(
    target_region_code IS NULL OR target_region_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  ),
  CONSTRAINT chk_saas_deployment_profile_target_residency CHECK(
    target_residency_domain IS NULL OR target_residency_domain ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  ),
  CONSTRAINT chk_saas_deployment_profile_target_edge CHECK(
    target_edge_site_code IS NULL OR target_edge_site_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
  ),
  CONSTRAINT chk_saas_deployment_profile_migration_target CHECK(
    (status = 'MIGRATING' AND target_profile_type IS NOT NULL AND target_profile_type <> profile_type)
    OR
    (status <> 'MIGRATING' AND target_profile_type IS NULL
      AND target_deployment_reference IS NULL AND target_region_code IS NULL
      AND target_residency_domain IS NULL AND target_edge_site_code IS NULL)
  ),
  CONSTRAINT chk_saas_deployment_profile_active_reference CHECK(
    status NOT IN ('ACTIVE','PAUSED','MIGRATING')
    OR profile_type = 'SHARED_SAAS'
    OR deployment_reference IS NOT NULL
  ),
  CONSTRAINT chk_saas_deployment_profile_active_edge CHECK(
    status NOT IN ('ACTIVE','PAUSED','MIGRATING')
    OR profile_type <> 'HYBRID_EDGE_CLOUD'
    OR edge_site_code IS NOT NULL
  ),
  CONSTRAINT chk_saas_deployment_profile_target_requirements CHECK(
    status <> 'MIGRATING'
    OR (
      (target_profile_type = 'SHARED_SAAS' OR target_deployment_reference IS NOT NULL)
      AND (target_profile_type <> 'HYBRID_EDGE_CLOUD' OR target_edge_site_code IS NOT NULL)
    )
  ),
  CONSTRAINT chk_saas_deployment_profile_reason CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  CONSTRAINT chk_saas_deployment_profile_idempotency CHECK(
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT chk_saas_deployment_profile_request_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_deployment_profile_initial_version CHECK(
    (version = 1 AND previous_version IS NULL AND action = 'REGISTER' AND status = 'PLANNED')
    OR (version > 1 AND previous_version = version - 1 AND action <> 'REGISTER')
  )
);

CREATE UNIQUE INDEX uq_saas_deployment_profile_tenant_root
  ON saas_deployment_profile_versions(tenant_id)
  WHERE scope_type = 'TENANT' AND version = 1;
CREATE UNIQUE INDEX uq_saas_deployment_profile_factory_root
  ON saas_deployment_profile_versions(tenant_id, factory_id)
  WHERE scope_type = 'FACTORY' AND version = 1;
CREATE INDEX idx_saas_deployment_profile_history
  ON saas_deployment_profile_versions(tenant_id, scope_key, version DESC);
CREATE INDEX idx_saas_deployment_profile_effective
  ON saas_deployment_profile_versions(tenant_id, scope_type, factory_id, version DESC);

CREATE TRIGGER saas_deployment_profile_immutable
BEFORE UPDATE OR DELETE ON saas_deployment_profile_versions
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

CREATE FUNCTION factoryos_guard_saas_deployment_profile_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior saas_deployment_profile_versions%ROWTYPE;
  base_changed BOOLEAN;
BEGIN
  IF NEW.version = 1 THEN
    IF NEW.previous_version IS NOT NULL OR NEW.action <> 'REGISTER' OR NEW.status <> 'PLANNED' THEN
      RAISE EXCEPTION 'initial deployment profile version must be a REGISTERED PLANNED snapshot';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO prior
  FROM saas_deployment_profile_versions
  WHERE tenant_id = NEW.tenant_id
    AND scope_key = NEW.scope_key
    AND version = NEW.previous_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'previous deployment profile version does not exist';
  END IF;

  IF NEW.version <> prior.version + 1
     OR NEW.scope_type IS DISTINCT FROM prior.scope_type
     OR NEW.scope_key IS DISTINCT FROM prior.scope_key
     OR NEW.factory_id IS DISTINCT FROM prior.factory_id THEN
    RAISE EXCEPTION 'deployment profile versions must be contiguous and retain their scope';
  END IF;

  base_changed :=
    NEW.profile_type IS DISTINCT FROM prior.profile_type OR
    NEW.deployment_reference IS DISTINCT FROM prior.deployment_reference OR
    NEW.region_code IS DISTINCT FROM prior.region_code OR
    NEW.residency_domain IS DISTINCT FROM prior.residency_domain OR
    NEW.edge_site_code IS DISTINCT FROM prior.edge_site_code;

  IF NEW.action = 'START_PROVISIONING' THEN
    IF prior.status NOT IN ('PLANNED','FAILED') OR NEW.status <> 'PROVISIONING' OR base_changed THEN
      RAISE EXCEPTION 'invalid START_PROVISIONING transition';
    END IF;
  ELSIF NEW.action = 'ACTIVATE' THEN
    IF prior.status <> 'PROVISIONING' OR NEW.status <> 'ACTIVE' OR base_changed THEN
      RAISE EXCEPTION 'invalid ACTIVATE transition';
    END IF;
  ELSIF NEW.action = 'START_MIGRATION' THEN
    IF prior.status <> 'ACTIVE' OR NEW.status <> 'MIGRATING' OR base_changed
       OR NEW.target_profile_type IS NULL OR NEW.target_profile_type = prior.profile_type THEN
      RAISE EXCEPTION 'invalid START_MIGRATION transition';
    END IF;
  ELSIF NEW.action = 'COMPLETE_MIGRATION' THEN
    IF prior.status <> 'MIGRATING' OR NEW.status <> 'ACTIVE'
       OR NEW.profile_type IS DISTINCT FROM prior.target_profile_type
       OR NEW.deployment_reference IS DISTINCT FROM prior.target_deployment_reference
       OR NEW.region_code IS DISTINCT FROM prior.target_region_code
       OR NEW.residency_domain IS DISTINCT FROM prior.target_residency_domain
       OR NEW.edge_site_code IS DISTINCT FROM prior.target_edge_site_code
       OR NEW.target_profile_type IS NOT NULL THEN
      RAISE EXCEPTION 'invalid COMPLETE_MIGRATION transition';
    END IF;
  ELSIF NEW.action = 'PAUSE' THEN
    IF prior.status <> 'ACTIVE' OR NEW.status <> 'PAUSED' OR base_changed THEN
      RAISE EXCEPTION 'invalid PAUSE transition';
    END IF;
  ELSIF NEW.action = 'RESUME' THEN
    IF prior.status <> 'PAUSED' OR NEW.status <> 'ACTIVE' OR base_changed THEN
      RAISE EXCEPTION 'invalid RESUME transition';
    END IF;
  ELSIF NEW.action = 'FAIL' THEN
    IF prior.status NOT IN ('PROVISIONING','MIGRATING') OR NEW.status <> 'FAILED'
       OR base_changed THEN
      RAISE EXCEPTION 'invalid FAIL transition';
    END IF;
  ELSIF NEW.action = 'RETIRE' THEN
    IF prior.status NOT IN ('PLANNED','ACTIVE','PAUSED','FAILED') OR NEW.status <> 'RETIRED'
       OR base_changed THEN
      RAISE EXCEPTION 'invalid RETIRE transition';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported deployment profile lifecycle action';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_deployment_profile_version_guard
BEFORE INSERT ON saas_deployment_profile_versions
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_deployment_profile_version();

ALTER TABLE saas_deployment_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_deployment_profile_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY saas_deployment_profile_tenant_isolation
ON saas_deployment_profile_versions
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMIT;
