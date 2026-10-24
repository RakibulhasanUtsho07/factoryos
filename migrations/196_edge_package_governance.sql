BEGIN;
-- WP11-J: tenant/factory-scoped edge package signer trust and remote package controls.

INSERT INTO permissions(code, description) VALUES
 ('edge.packages.keys.read', 'Read edge package signing-key metadata'),
 ('edge.packages.keys.manage', 'Register, rotate, and revoke edge package signing keys'),
 ('edge.packages.controls.read', 'Read scoped edge package pause and revocation controls'),
 ('edge.packages.controls.manage', 'Pause, resume, and revoke packages by factory, device, group, or use case')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code IN (
    'edge.packages.keys.read',
    'edge.packages.keys.manage',
    'edge.packages.controls.read',
    'edge.packages.controls.manage'
  )
ON CONFLICT(role_id, permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS edge_package_signing_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  key_id VARCHAR(128) NOT NULL,
  public_key_pem TEXT NOT NULL,
  fingerprint_sha256 VARCHAR(64) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  replaces_key_id UUID,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_by UUID,
  revoked_at TIMESTAMPTZ,
  revoke_reason VARCHAR(300),
  CONSTRAINT fk_edge_package_key_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_edge_package_key_factory_scope FOREIGN KEY (factory_id, tenant_id) REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_edge_package_key_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_edge_package_key_revoker FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_edge_package_key_replacement_scope FOREIGN KEY (replaces_key_id, tenant_id, factory_id)
    REFERENCES edge_package_signing_keys(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_edge_package_key_id CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_edge_package_key_public_pem CHECK (
    length(public_key_pem) BETWEEN 64 AND 4096
    AND public_key_pem LIKE '-----BEGIN PUBLIC KEY-----%'
    AND public_key_pem NOT LIKE '%PRIVATE KEY-----%'
  ),
  CONSTRAINT chk_edge_package_key_fingerprint CHECK (fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_edge_package_key_status CHECK (status IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT chk_edge_package_key_revocation CHECK (
    (status = 'ACTIVE' AND revoked_by IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR
    (status = 'REVOKED' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL
      AND revoke_reason IS NOT NULL AND length(btrim(revoke_reason)) BETWEEN 8 AND 300)
  ),
  CONSTRAINT uq_edge_package_key_id_scope UNIQUE (tenant_id, factory_id, key_id),
  CONSTRAINT uq_edge_package_key_scope_id UNIQUE (id, tenant_id, factory_id)
);
CREATE INDEX IF NOT EXISTS idx_edge_package_keys_status
  ON edge_package_signing_keys (tenant_id, factory_id, status, created_at DESC);

ALTER TABLE edge_package_signing_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_package_signing_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS edge_package_signing_keys_tenant_isolation ON edge_package_signing_keys;
CREATE POLICY edge_package_signing_keys_tenant_isolation ON edge_package_signing_keys
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS edge_package_signing_key_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  signing_key_id UUID NOT NULL,
  related_key_id UUID,
  event_type VARCHAR(20) NOT NULL,
  actor_user_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_edge_package_key_event_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_edge_package_key_event_factory_scope FOREIGN KEY (factory_id, tenant_id) REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_edge_package_key_event_key_scope FOREIGN KEY (signing_key_id, tenant_id, factory_id)
    REFERENCES edge_package_signing_keys(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_edge_package_key_event_related_scope FOREIGN KEY (related_key_id, tenant_id, factory_id)
    REFERENCES edge_package_signing_keys(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_edge_package_key_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_edge_package_key_event_type CHECK (event_type IN ('REGISTERED', 'ROTATION_ADDED', 'REVOKED')),
  CONSTRAINT chk_edge_package_key_event_metadata CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 4096
  )
);
CREATE INDEX IF NOT EXISTS idx_edge_package_key_event_history
  ON edge_package_signing_key_events (tenant_id, factory_id, signing_key_id, occurred_at DESC, id DESC);
ALTER TABLE edge_package_signing_key_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_package_signing_key_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS edge_package_signing_key_events_tenant_isolation ON edge_package_signing_key_events;
CREATE POLICY edge_package_signing_key_events_tenant_isolation ON edge_package_signing_key_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
DROP TRIGGER IF EXISTS edge_package_signing_key_events_immutable ON edge_package_signing_key_events;
CREATE TRIGGER edge_package_signing_key_events_immutable
  BEFORE UPDATE OR DELETE ON edge_package_signing_key_events
  FOR EACH ROW EXECUTE FUNCTION edge_reject_ledger_mutation();

CREATE TABLE IF NOT EXISTS edge_package_controls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  package_id VARCHAR(128) NOT NULL,
  package_version VARCHAR(32) NOT NULL DEFAULT '*',
  target_kind VARCHAR(16) NOT NULL,
  target_key VARCHAR(128) NOT NULL,
  status VARCHAR(12) NOT NULL,
  reason VARCHAR(300) NOT NULL,
  created_by UUID NOT NULL,
  updated_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT fk_edge_package_control_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_edge_package_control_factory_scope FOREIGN KEY (factory_id, tenant_id) REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_edge_package_control_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_edge_package_control_updater FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_edge_package_control_package CHECK (package_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  CONSTRAINT chk_edge_package_control_version CHECK (
    package_version = '*' OR package_version ~ '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?([+][0-9A-Za-z.-]+)?$'
  ),
  CONSTRAINT chk_edge_package_control_target_kind CHECK (target_kind IN ('FACTORY', 'DEVICE', 'DEVICE_GROUP', 'USE_CASE')),
  CONSTRAINT chk_edge_package_control_target_key CHECK (
    (target_kind = 'FACTORY' AND target_key = '*')
    OR (target_kind = 'DEVICE' AND target_key ~ '^[0-9a-fA-F-]{36}$')
    OR (target_kind IN ('DEVICE_GROUP', 'USE_CASE') AND target_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$')
  ),
  CONSTRAINT chk_edge_package_control_status CHECK (status IN ('ACTIVE', 'PAUSED', 'REVOKED')),
  CONSTRAINT chk_edge_package_control_reason CHECK (length(btrim(reason)) BETWEEN 8 AND 300),
  CONSTRAINT chk_edge_package_control_revocation CHECK (
    (status = 'REVOKED' AND revoked_at IS NOT NULL)
    OR (status <> 'REVOKED' AND revoked_at IS NULL)
  ),
  CONSTRAINT uq_edge_package_control_scope UNIQUE (
    tenant_id, factory_id, package_id, package_version, target_kind, target_key
  ),
  CONSTRAINT uq_edge_package_control_scope_id UNIQUE (id, tenant_id, factory_id)
);
CREATE INDEX IF NOT EXISTS idx_edge_package_controls_lookup
  ON edge_package_controls (tenant_id, factory_id, package_id, package_version, status);
CREATE INDEX IF NOT EXISTS idx_edge_package_controls_target
  ON edge_package_controls (tenant_id, factory_id, target_kind, target_key, status);

ALTER TABLE edge_package_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_package_controls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS edge_package_controls_tenant_isolation ON edge_package_controls;
CREATE POLICY edge_package_controls_tenant_isolation ON edge_package_controls
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS edge_package_control_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  control_id UUID NOT NULL,
  event_type VARCHAR(12) NOT NULL,
  previous_status VARCHAR(12),
  next_status VARCHAR(12) NOT NULL,
  actor_user_id UUID NOT NULL,
  reason VARCHAR(300) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_edge_package_control_event_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_edge_package_control_event_factory_scope FOREIGN KEY (factory_id, tenant_id) REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_edge_package_control_event_control_scope FOREIGN KEY (control_id, tenant_id, factory_id)
    REFERENCES edge_package_controls(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_edge_package_control_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_edge_package_control_event_type CHECK (event_type IN ('PAUSED', 'RESUMED', 'REVOKED')),
  CONSTRAINT chk_edge_package_control_event_previous CHECK (previous_status IS NULL OR previous_status IN ('ACTIVE', 'PAUSED', 'REVOKED')),
  CONSTRAINT chk_edge_package_control_event_next CHECK (next_status IN ('ACTIVE', 'PAUSED', 'REVOKED')),
  CONSTRAINT chk_edge_package_control_event_reason CHECK (length(btrim(reason)) BETWEEN 8 AND 300),
  CONSTRAINT chk_edge_package_control_event_metadata CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 4096
  )
);
CREATE INDEX IF NOT EXISTS idx_edge_package_control_event_history
  ON edge_package_control_events (tenant_id, factory_id, control_id, occurred_at DESC, id DESC);
ALTER TABLE edge_package_control_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_package_control_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS edge_package_control_events_tenant_isolation ON edge_package_control_events;
CREATE POLICY edge_package_control_events_tenant_isolation ON edge_package_control_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
DROP TRIGGER IF EXISTS edge_package_control_events_immutable ON edge_package_control_events;
CREATE TRIGGER edge_package_control_events_immutable
  BEFORE UPDATE OR DELETE ON edge_package_control_events
  FOR EACH ROW EXECUTE FUNCTION edge_reject_ledger_mutation();

CREATE OR REPLACE FUNCTION edge_package_signing_key_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Edge package signing keys cannot be deleted; revoke the key instead';
  END IF;
  IF OLD.status = 'REVOKED' THEN
    RAISE EXCEPTION 'Revoked edge package signing keys are immutable';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.factory_id, NEW.key_id, NEW.public_key_pem,
      NEW.fingerprint_sha256, NEW.replaces_key_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.factory_id, OLD.key_id, OLD.public_key_pem,
      OLD.fingerprint_sha256, OLD.replaces_key_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Edge package signing key identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS edge_package_signing_key_guard ON edge_package_signing_keys;
CREATE TRIGGER edge_package_signing_key_guard
  BEFORE UPDATE OR DELETE ON edge_package_signing_keys
  FOR EACH ROW EXECUTE FUNCTION edge_package_signing_key_guard();

CREATE OR REPLACE FUNCTION edge_package_control_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Edge package controls cannot be deleted; resume or revoke the control instead';
  END IF;
  IF OLD.status = 'REVOKED' THEN
    RAISE EXCEPTION 'Revoked edge package controls are permanent';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.factory_id, NEW.package_id, NEW.package_version,
      NEW.target_kind, NEW.target_key, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.factory_id, OLD.package_id, OLD.package_version,
      OLD.target_kind, OLD.target_key, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Edge package control scope is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS edge_package_control_guard ON edge_package_controls;
CREATE TRIGGER edge_package_control_guard
  BEFORE UPDATE OR DELETE ON edge_package_controls
  FOR EACH ROW EXECUTE FUNCTION edge_package_control_guard();

INSERT INTO schema_migrations(version, checksum)
VALUES ('196_edge_package_governance', NULL)
ON CONFLICT (version) DO NOTHING;
COMMIT;
