BEGIN;

-- WP10-H / FR-SAAS2-08: tenant export and schema-compatible migration control plane.
INSERT INTO permissions(code, description) VALUES
 ('saas.data_transfers.read', 'Read tenant export and migration manifests and history'),
 ('saas.data_transfers.write', 'Request tenant exports and register compatibility rules'),
 ('saas.data_transfers.execute', 'Attest exports and advance validated tenant migrations')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code IN (
    'saas.data_transfers.read',
    'saas.data_transfers.write',
    'saas.data_transfers.execute'
  )
ON CONFLICT(role_id, permission_id) DO NOTHING;

CREATE TABLE saas_schema_compatibility_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  rule_key VARCHAR(80) NOT NULL,
  version BIGINT NOT NULL,
  source_schema_version VARCHAR(32) NOT NULL,
  target_schema_version VARCHAR(32) NOT NULL,
  decision VARCHAR(24) NOT NULL,
  required_categories JSONB NOT NULL,
  mapping_reference VARCHAR(200),
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  reason VARCHAR(1000) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_saas_schema_compatibility_version UNIQUE(tenant_id, rule_key, version),
  CONSTRAINT uq_saas_schema_compatibility_scoped_id UNIQUE(id, tenant_id),
  CONSTRAINT uq_saas_schema_compatibility_idempotency UNIQUE(tenant_id, idempotency_key),
  CONSTRAINT chk_saas_schema_compatibility_key CHECK(rule_key ~ '^[A-Z0-9][A-Z0-9._:-]{0,79}$'),
  CONSTRAINT chk_saas_schema_source_version CHECK(source_schema_version ~ '^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}$'),
  CONSTRAINT chk_saas_schema_target_version CHECK(target_schema_version ~ '^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}$'),
  CONSTRAINT chk_saas_schema_compatibility_decision CHECK(decision IN ('COMPATIBLE','TRANSFORM_REQUIRED','INCOMPATIBLE')),
  CONSTRAINT chk_saas_schema_compatibility_categories CHECK(
    jsonb_typeof(required_categories) = 'array'
    AND jsonb_array_length(required_categories) BETWEEN 5 AND 9
    AND octet_length(required_categories::text) <= 4096
  ),
  CONSTRAINT chk_saas_schema_compatibility_mapping CHECK(
    mapping_reference IS NULL OR mapping_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  CONSTRAINT chk_saas_schema_compatibility_status CHECK(status IN ('ACTIVE','DISABLED')),
  CONSTRAINT chk_saas_schema_compatibility_reason CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  CONSTRAINT chk_saas_schema_compatibility_idempotency CHECK(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_schema_compatibility_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_schema_compatibility_transform CHECK(
    decision <> 'TRANSFORM_REQUIRED' OR mapping_reference IS NOT NULL
  )
);

CREATE INDEX idx_saas_schema_compatibility_latest
  ON saas_schema_compatibility_rules(tenant_id, source_schema_version, target_schema_version, version DESC);

CREATE TRIGGER saas_schema_compatibility_immutable
BEFORE UPDATE OR DELETE ON saas_schema_compatibility_rules
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

CREATE FUNCTION factoryos_guard_saas_schema_compatibility_rule()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior saas_schema_compatibility_rules%ROWTYPE;
BEGIN
  IF NEW.version = 1 THEN
    RETURN NEW;
  END IF;
  SELECT * INTO prior
  FROM saas_schema_compatibility_rules
  WHERE tenant_id = NEW.tenant_id AND rule_key = NEW.rule_key AND version = NEW.version - 1;
  IF NOT FOUND OR
     NEW.source_schema_version IS DISTINCT FROM prior.source_schema_version OR
     NEW.target_schema_version IS DISTINCT FROM prior.target_schema_version THEN
    RAISE EXCEPTION 'schema compatibility rule versions must be contiguous and preserve the same source/target schemas';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_schema_compatibility_version_guard
BEFORE INSERT ON saas_schema_compatibility_rules
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_schema_compatibility_rule();

ALTER TABLE saas_schema_compatibility_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_schema_compatibility_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY saas_schema_compatibility_tenant_isolation
ON saas_schema_compatibility_rules
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE TABLE saas_tenant_data_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  transfer_id UUID NOT NULL,
  version BIGINT NOT NULL,
  operation_type VARCHAR(12) NOT NULL,
  status VARCHAR(16) NOT NULL,
  source_schema_version VARCHAR(32) NOT NULL,
  target_schema_version VARCHAR(32),
  compatibility_rule_key VARCHAR(80),
  compatibility_rule_version BIGINT,
  compatibility_decision VARCHAR(24),
  required_categories JSONB NOT NULL,
  source_transfer_id UUID,
  source_transfer_version BIGINT,
  source_bundle_reference VARCHAR(200),
  source_bundle_digest VARCHAR(64),
  source_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_bundle_reference VARCHAR(200),
  target_bundle_digest VARCHAR(64),
  target_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  preservation_verified BOOLEAN NOT NULL DEFAULT FALSE,
  reason VARCHAR(1000) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_saas_data_transfer_version UNIQUE(tenant_id, transfer_id, version),
  CONSTRAINT uq_saas_data_transfer_scoped_id UNIQUE(id, tenant_id),
  CONSTRAINT uq_saas_data_transfer_idempotency UNIQUE(tenant_id, idempotency_key),
  CONSTRAINT fk_saas_data_transfer_source
    FOREIGN KEY(tenant_id, source_transfer_id, source_transfer_version)
    REFERENCES saas_tenant_data_transfers(tenant_id, transfer_id, version)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_saas_data_transfer_compatibility_rule
    FOREIGN KEY(tenant_id, compatibility_rule_key, compatibility_rule_version)
    REFERENCES saas_schema_compatibility_rules(tenant_id, rule_key, version)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,

  CONSTRAINT chk_saas_data_transfer_version CHECK(version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_saas_data_transfer_operation CHECK(operation_type IN ('EXPORT','MIGRATION')),
  CONSTRAINT chk_saas_data_transfer_status CHECK(status IN (
    'REQUESTED','COMPLETED','VALIDATED','BLOCKED','IN_PROGRESS','FAILED','CANCELLED'
  )),
  CONSTRAINT chk_saas_data_transfer_source_schema CHECK(source_schema_version ~ '^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}$'),
  CONSTRAINT chk_saas_data_transfer_target_schema CHECK(
    target_schema_version IS NULL OR target_schema_version ~ '^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}$'
  ),
  CONSTRAINT chk_saas_data_transfer_compatibility_decision CHECK(
    compatibility_decision IS NULL OR compatibility_decision IN ('EXACT','COMPATIBLE','TRANSFORM_REQUIRED','INCOMPATIBLE')
  ),
  CONSTRAINT chk_saas_data_transfer_categories CHECK(
    jsonb_typeof(required_categories) = 'array'
    AND jsonb_array_length(required_categories) BETWEEN 5 AND 9
    AND octet_length(required_categories::text) <= 4096
  ),
  CONSTRAINT chk_saas_data_transfer_source_digest CHECK(
    source_bundle_digest IS NULL OR source_bundle_digest ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_saas_data_transfer_source_bundle_pair CHECK(
    (source_bundle_reference IS NULL AND source_bundle_digest IS NULL)
    OR (source_bundle_reference IS NOT NULL AND source_bundle_digest IS NOT NULL)
  ),
  CONSTRAINT chk_saas_data_transfer_target_digest CHECK(
    target_bundle_digest IS NULL OR target_bundle_digest ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_saas_data_transfer_target_bundle_pair CHECK(
    (target_bundle_reference IS NULL AND target_bundle_digest IS NULL)
    OR (target_bundle_reference IS NOT NULL AND target_bundle_digest IS NOT NULL)
  ),
  CONSTRAINT chk_saas_data_transfer_source_reference CHECK(
    source_bundle_reference IS NULL OR source_bundle_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  CONSTRAINT chk_saas_data_transfer_target_reference CHECK(
    target_bundle_reference IS NULL OR target_bundle_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  CONSTRAINT chk_saas_data_transfer_source_manifest CHECK(
    jsonb_typeof(source_manifest) = 'object' AND octet_length(source_manifest::text) <= 65536
  ),
  CONSTRAINT chk_saas_data_transfer_target_manifest CHECK(
    jsonb_typeof(target_manifest) = 'object' AND octet_length(target_manifest::text) <= 65536
  ),
  CONSTRAINT chk_saas_data_transfer_reason CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  CONSTRAINT chk_saas_data_transfer_idempotency CHECK(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_data_transfer_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_data_transfer_source_pointer CHECK(
    (source_transfer_id IS NULL AND source_transfer_version IS NULL)
    OR (source_transfer_id IS NOT NULL AND source_transfer_version IS NOT NULL)
  ),
  CONSTRAINT chk_saas_data_transfer_export_shape CHECK(
    (operation_type = 'EXPORT' AND target_schema_version IS NULL
      AND compatibility_rule_key IS NULL AND compatibility_rule_version IS NULL
      AND compatibility_decision IS NULL AND source_transfer_id IS NULL
      AND source_transfer_version IS NULL)
    OR
    (operation_type = 'MIGRATION' AND target_schema_version IS NOT NULL
      AND source_transfer_id IS NOT NULL AND source_transfer_version IS NOT NULL)
  ),
  CONSTRAINT chk_saas_data_transfer_initial_version CHECK(
    (version = 1 AND operation_type = 'EXPORT' AND status = 'REQUESTED'
      AND source_bundle_reference IS NULL AND source_bundle_digest IS NULL
      AND source_manifest = '{}'::jsonb AND target_bundle_reference IS NULL
      AND target_bundle_digest IS NULL AND target_manifest = '{}'::jsonb)
    OR
    (version = 1 AND operation_type = 'MIGRATION' AND status IN ('VALIDATED','BLOCKED')
      AND source_bundle_reference IS NOT NULL AND source_bundle_digest IS NOT NULL
      AND source_manifest <> '{}'::jsonb)
    OR version > 1
  ),
  CONSTRAINT chk_saas_data_transfer_completion CHECK(
    status <> 'COMPLETED' OR (
      operation_type = 'EXPORT'
      AND source_bundle_reference IS NOT NULL
      AND source_bundle_digest IS NOT NULL
      AND source_manifest <> '{}'::jsonb
    ) OR (
      operation_type = 'MIGRATION'
      AND target_bundle_reference IS NOT NULL
      AND target_bundle_digest IS NOT NULL
      AND target_manifest <> '{}'::jsonb
      AND preservation_verified = TRUE
    )
  ),
  CONSTRAINT chk_saas_data_transfer_compatibility_pointer CHECK(
    (compatibility_rule_key IS NULL AND compatibility_rule_version IS NULL)
    OR (compatibility_rule_key IS NOT NULL AND compatibility_rule_version IS NOT NULL)
  )
);

CREATE INDEX idx_saas_data_transfer_history
  ON saas_tenant_data_transfers(tenant_id, transfer_id, version DESC);
CREATE INDEX idx_saas_data_transfer_listing
  ON saas_tenant_data_transfers(tenant_id, operation_type, created_at DESC);

CREATE TRIGGER saas_tenant_data_transfer_immutable
BEFORE UPDATE OR DELETE ON saas_tenant_data_transfers
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

CREATE FUNCTION factoryos_guard_saas_tenant_data_transfer_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior saas_tenant_data_transfers%ROWTYPE;
BEGIN
  IF NEW.version = 1 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO prior
  FROM saas_tenant_data_transfers
  WHERE tenant_id = NEW.tenant_id AND transfer_id = NEW.transfer_id AND version = NEW.version - 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'prior tenant data transfer version does not exist';
  END IF;
  IF NEW.operation_type IS DISTINCT FROM prior.operation_type
     OR NEW.source_schema_version IS DISTINCT FROM prior.source_schema_version
     OR NEW.required_categories IS DISTINCT FROM prior.required_categories
     OR NEW.source_transfer_id IS DISTINCT FROM prior.source_transfer_id
     OR NEW.source_transfer_version IS DISTINCT FROM prior.source_transfer_version
     OR NEW.target_schema_version IS DISTINCT FROM prior.target_schema_version
     OR NEW.compatibility_rule_key IS DISTINCT FROM prior.compatibility_rule_key
     OR NEW.compatibility_rule_version IS DISTINCT FROM prior.compatibility_rule_version
     OR NEW.compatibility_decision IS DISTINCT FROM prior.compatibility_decision THEN
    RAISE EXCEPTION 'tenant data transfer identity and compatibility decision are immutable';
  END IF;

  IF prior.operation_type = 'EXPORT' THEN
    IF prior.status <> 'REQUESTED' OR NEW.status NOT IN ('COMPLETED','FAILED','CANCELLED') THEN
      RAISE EXCEPTION 'invalid export lifecycle transition';
    END IF;
    IF NEW.status <> 'COMPLETED' AND (
      NEW.source_bundle_reference IS DISTINCT FROM prior.source_bundle_reference
      OR NEW.source_bundle_digest IS DISTINCT FROM prior.source_bundle_digest
      OR NEW.source_manifest IS DISTINCT FROM prior.source_manifest
    ) THEN
      RAISE EXCEPTION 'non-completed exports cannot attach an artifact';
    END IF;
  ELSE
    IF NEW.source_bundle_reference IS DISTINCT FROM prior.source_bundle_reference
       OR NEW.source_bundle_digest IS DISTINCT FROM prior.source_bundle_digest
       OR NEW.source_manifest IS DISTINCT FROM prior.source_manifest THEN
      RAISE EXCEPTION 'migration source bundle and manifest are immutable';
    END IF;
    IF prior.status = 'VALIDATED' AND NEW.status NOT IN ('IN_PROGRESS','CANCELLED') THEN
      RAISE EXCEPTION 'invalid validated migration transition';
    ELSIF prior.status = 'IN_PROGRESS' AND NEW.status NOT IN ('COMPLETED','FAILED','CANCELLED') THEN
      RAISE EXCEPTION 'invalid in-progress migration transition';
    ELSIF prior.status NOT IN ('VALIDATED','IN_PROGRESS') THEN
      RAISE EXCEPTION 'terminal or blocked migration state cannot transition';
    END IF;
    IF NEW.status = 'IN_PROGRESS' AND prior.compatibility_decision NOT IN ('EXACT','COMPATIBLE') THEN
      RAISE EXCEPTION 'migration cannot start without an approved compatible schema rule';
    END IF;
    IF NEW.status <> 'COMPLETED' AND (
      NEW.target_bundle_reference IS DISTINCT FROM prior.target_bundle_reference
      OR NEW.target_bundle_digest IS DISTINCT FROM prior.target_bundle_digest
      OR NEW.target_manifest IS DISTINCT FROM prior.target_manifest
      OR NEW.preservation_verified IS DISTINCT FROM prior.preservation_verified
    ) THEN
      RAISE EXCEPTION 'migration artifacts are attached only when completing the migration';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_tenant_data_transfer_version_guard
BEFORE INSERT ON saas_tenant_data_transfers
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_tenant_data_transfer_version();

ALTER TABLE saas_tenant_data_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_data_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY saas_tenant_data_transfer_isolation
ON saas_tenant_data_transfers
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMIT;
