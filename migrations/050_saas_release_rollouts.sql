BEGIN;

-- WP10-F / FR-SAAS2-05: immutable, tenant-scoped progressive release snapshots.
INSERT INTO permissions(code, description) VALUES
 ('saas.releases.read', 'Read tenant release rollout state and history'),
 ('saas.releases.write', 'Register a tenant-scoped release candidate'),
 ('saas.releases.promote', 'Promote a tested release through canary and production stages'),
 ('saas.releases.rollback', 'Rollback a release to a prior tested artifact'),
 ('saas.releases.control', 'Pause, resume or retire a tenant release rollout')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code IN (
    'saas.releases.read',
    'saas.releases.write',
    'saas.releases.promote',
    'saas.releases.rollback',
    'saas.releases.control'
  )
ON CONFLICT(role_id, permission_id) DO NOTHING;

-- A row is a complete immutable snapshot of a release's current lifecycle
-- state. A release_key identifies one artifact rollout; a newer artifact gets
-- a new key, so draft/canary work never silently replaces current production.
CREATE TABLE saas_release_rollouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  rollout_key VARCHAR(80) NOT NULL,
  version BIGINT NOT NULL,
  scope_type VARCHAR(16) NOT NULL,
  factory_id UUID,
  module_key VARCHAR(80),
  agent_key VARCHAR(160),
  release_channel VARCHAR(16) NOT NULL,
  action VARCHAR(16) NOT NULL,
  stage VARCHAR(16) NOT NULL,
  last_active_stage VARCHAR(16) NOT NULL,
  artifact_version VARCHAR(120) NOT NULL,
  artifact_digest VARCHAR(64) NOT NULL,
  rollout_percentage SMALLINT NOT NULL DEFAULT 0,
  previous_version BIGINT,
  rollback_target_key VARCHAR(80),
  rollback_target_version BIGINT,
  evaluation_reference VARCHAR(200),
  reason VARCHAR(1000) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_saas_release_rollout_version UNIQUE(tenant_id, rollout_key, version),
  CONSTRAINT uq_saas_release_rollout_idempotency UNIQUE(tenant_id, idempotency_key),
  CONSTRAINT uq_saas_release_rollout_scoped_id UNIQUE(id, tenant_id),
  CONSTRAINT fk_saas_release_rollout_factory_scope FOREIGN KEY(factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_saas_release_rollout_previous FOREIGN KEY(tenant_id, rollout_key, previous_version)
    REFERENCES saas_release_rollouts(tenant_id, rollout_key, version)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_saas_release_rollout_rollback_target FOREIGN KEY(tenant_id, rollback_target_key, rollback_target_version)
    REFERENCES saas_release_rollouts(tenant_id, rollout_key, version)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_saas_release_rollout_key CHECK(rollout_key ~ '^[A-Z][A-Z0-9:_-]{0,79}$'),
  CONSTRAINT chk_saas_release_rollout_version CHECK(version BETWEEN 1 AND 9223372036854775807),
  CONSTRAINT chk_saas_release_scope CHECK(scope_type IN ('ORGANIZATION','FACTORY','MODULE','AGENT')),
  CONSTRAINT chk_saas_release_scope_fields CHECK(
    (scope_type = 'ORGANIZATION' AND factory_id IS NULL AND module_key IS NULL AND agent_key IS NULL)
    OR (scope_type = 'FACTORY' AND factory_id IS NOT NULL AND module_key IS NULL AND agent_key IS NULL)
    OR (scope_type = 'MODULE' AND module_key IS NOT NULL AND module_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$' AND agent_key IS NULL)
    OR (scope_type = 'AGENT' AND agent_key IS NOT NULL AND agent_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$')
  ),
  CONSTRAINT chk_saas_release_module_key CHECK(module_key IS NULL OR module_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
  CONSTRAINT chk_saas_release_agent_key CHECK(agent_key IS NULL OR agent_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  CONSTRAINT chk_saas_release_channel CHECK(release_channel IN ('STABLE','PREVIEW','EXPERIMENTAL')),
  CONSTRAINT chk_saas_release_action CHECK(action IN ('REGISTER','PROMOTE','PAUSE','RESUME','ROLLBACK','RETIRE')),
  CONSTRAINT chk_saas_release_stage CHECK(stage IN ('DRAFT','CANARY','PRODUCTION','PAUSED','RETIRED')),
  CONSTRAINT chk_saas_release_last_active_stage CHECK(last_active_stage IN ('DRAFT','CANARY','PRODUCTION')),
  CONSTRAINT chk_saas_release_stage_percentage CHECK(
    (stage = 'DRAFT' AND rollout_percentage = 0 AND last_active_stage = 'DRAFT')
    OR (stage = 'CANARY' AND rollout_percentage BETWEEN 1 AND 99 AND last_active_stage = 'CANARY')
    OR (stage = 'PRODUCTION' AND rollout_percentage = 100 AND last_active_stage = 'PRODUCTION')
    OR (stage = 'PAUSED' AND rollout_percentage BETWEEN 1 AND 100 AND last_active_stage IN ('CANARY','PRODUCTION'))
    OR (stage = 'RETIRED' AND rollout_percentage BETWEEN 0 AND 100 AND last_active_stage IN ('DRAFT','CANARY','PRODUCTION'))
  ),
  CONSTRAINT chk_saas_release_artifact_version CHECK(length(btrim(artifact_version)) BETWEEN 1 AND 120),
  CONSTRAINT chk_saas_release_artifact_digest CHECK(artifact_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_release_reason CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  CONSTRAINT chk_saas_release_idempotency CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_release_request_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_release_evaluation_reference CHECK(
    evaluation_reference IS NULL OR evaluation_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  CONSTRAINT chk_saas_release_version_links CHECK(
    (version = 1 AND previous_version IS NULL)
    OR (version > 1 AND previous_version = version - 1)
  ),
  CONSTRAINT chk_saas_release_rollback_link CHECK(
    (action = 'ROLLBACK' AND rollback_target_key IS NOT NULL
      AND rollback_target_version IS NOT NULL AND rollback_target_version >= 1
      AND rollback_target_key <> rollout_key)
    OR
    (action <> 'ROLLBACK' AND rollback_target_key IS NULL AND rollback_target_version IS NULL)
  )
);

CREATE INDEX idx_saas_release_rollouts_tenant_history
  ON saas_release_rollouts(tenant_id, rollout_key, version DESC);
CREATE INDEX idx_saas_release_rollouts_resolution
  ON saas_release_rollouts(tenant_id, release_channel, scope_type, created_at DESC);
CREATE INDEX idx_saas_release_rollouts_factory_module
  ON saas_release_rollouts(tenant_id, factory_id, module_key, agent_key, release_channel, created_at DESC);

ALTER TABLE saas_release_rollouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_release_rollouts FORCE ROW LEVEL SECURITY;
CREATE POLICY saas_release_rollouts_tenant_isolation
ON saas_release_rollouts
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE TRIGGER saas_release_rollouts_immutable
BEFORE UPDATE OR DELETE ON saas_release_rollouts
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

CREATE OR REPLACE FUNCTION factoryos_guard_saas_release_rollout()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_row saas_release_rollouts%ROWTYPE;
  target_row saas_release_rollouts%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Release rollout snapshots are append-only'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.version = 1 THEN
    IF NEW.action <> 'REGISTER' OR NEW.stage <> 'DRAFT'
      OR NEW.last_active_stage <> 'DRAFT' OR NEW.rollout_percentage <> 0
      OR NEW.previous_version IS NOT NULL OR NEW.rollback_target_key IS NOT NULL
      OR NEW.rollback_target_version IS NOT NULL THEN
      RAISE EXCEPTION 'A new release rollout must begin as a DRAFT registration'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO prior_row
  FROM saas_release_rollouts
  WHERE tenant_id = NEW.tenant_id AND rollout_key = NEW.rollout_key
  ORDER BY version DESC
  LIMIT 1;

  IF NOT FOUND OR NEW.version <> prior_row.version + 1
    OR NEW.previous_version IS DISTINCT FROM prior_row.version THEN
    RAISE EXCEPTION 'Release rollout versions must be appended consecutively'
      USING ERRCODE = '23514';
  END IF;

  IF ROW(NEW.scope_type, NEW.factory_id, NEW.module_key, NEW.agent_key, NEW.release_channel, NEW.evaluation_reference)
    IS DISTINCT FROM
     ROW(prior_row.scope_type, prior_row.factory_id, prior_row.module_key, prior_row.agent_key, prior_row.release_channel, prior_row.evaluation_reference) THEN
    RAISE EXCEPTION 'Release rollout target and evaluation reference are immutable within a rollout'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.action = 'PROMOTE' THEN
    IF NOT (
      (prior_row.stage = 'DRAFT' AND NEW.stage = 'CANARY' AND NEW.rollout_percentage BETWEEN 1 AND 99)
      OR (prior_row.stage = 'CANARY' AND NEW.stage = 'PRODUCTION' AND NEW.rollout_percentage = 100)
    ) THEN
      RAISE EXCEPTION 'Promotion must move DRAFT to CANARY or CANARY to PRODUCTION'
        USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.artifact_version, NEW.artifact_digest)
      IS DISTINCT FROM ROW(prior_row.artifact_version, prior_row.artifact_digest)
      OR NEW.last_active_stage <> NEW.stage
      OR NEW.rollback_target_key IS NOT NULL THEN
      RAISE EXCEPTION 'Promotion cannot change the registered artifact'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.action = 'PAUSE' THEN
    IF prior_row.stage NOT IN ('CANARY','PRODUCTION')
      OR NEW.stage <> 'PAUSED'
      OR NEW.last_active_stage <> prior_row.stage
      OR NEW.rollout_percentage <> prior_row.rollout_percentage
      OR ROW(NEW.artifact_version, NEW.artifact_digest)
        IS DISTINCT FROM ROW(prior_row.artifact_version, prior_row.artifact_digest) THEN
      RAISE EXCEPTION 'Only a live canary/production rollout can be paused'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.action = 'RESUME' THEN
    IF prior_row.stage <> 'PAUSED'
      OR NEW.stage <> prior_row.last_active_stage
      OR NEW.last_active_stage <> prior_row.last_active_stage
      OR NEW.rollout_percentage <> prior_row.rollout_percentage
      OR ROW(NEW.artifact_version, NEW.artifact_digest)
        IS DISTINCT FROM ROW(prior_row.artifact_version, prior_row.artifact_digest) THEN
      RAISE EXCEPTION 'A paused rollout can only resume its recorded stage and artifact'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.action = 'ROLLBACK' THEN
    IF prior_row.stage NOT IN ('CANARY','PRODUCTION','PAUSED') THEN
      RAISE EXCEPTION 'Only a deployed rollout can be rolled back'
        USING ERRCODE = '23514';
    END IF;
    SELECT * INTO target_row
    FROM saas_release_rollouts
    WHERE tenant_id = NEW.tenant_id AND rollout_key = NEW.rollback_target_key
    ORDER BY version DESC
    LIMIT 1;
    IF NOT FOUND OR target_row.version <> NEW.rollback_target_version
      OR target_row.stage NOT IN ('CANARY','PRODUCTION')
      OR ROW(target_row.scope_type, target_row.factory_id, target_row.module_key, target_row.agent_key, target_row.release_channel)
        IS DISTINCT FROM ROW(NEW.scope_type, NEW.factory_id, NEW.module_key, NEW.agent_key, NEW.release_channel)
      OR ROW(NEW.artifact_version, NEW.artifact_digest, NEW.stage, NEW.rollout_percentage, NEW.last_active_stage)
        IS DISTINCT FROM ROW(target_row.artifact_version, target_row.artifact_digest, target_row.stage, target_row.rollout_percentage, target_row.stage) THEN
      RAISE EXCEPTION 'Rollback target must be the latest tested live artifact for the same target and channel'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.action = 'RETIRE' THEN
    IF prior_row.stage = 'RETIRED' OR NEW.stage <> 'RETIRED'
      OR NEW.last_active_stage <> CASE WHEN prior_row.stage = 'PAUSED' THEN prior_row.last_active_stage ELSE prior_row.stage END
      OR ROW(NEW.artifact_version, NEW.artifact_digest)
        IS DISTINCT FROM ROW(prior_row.artifact_version, prior_row.artifact_digest) THEN
      RAISE EXCEPTION 'Retirement must preserve artifact provenance and prior stage'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported release rollout action'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_release_rollout_lifecycle_guard
BEFORE INSERT ON saas_release_rollouts
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_release_rollout();

INSERT INTO schema_migrations(version, checksum)
VALUES ('050_saas_release_rollouts', NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
