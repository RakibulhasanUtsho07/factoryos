BEGIN;

CREATE TABLE IF NOT EXISTS ai_artifact_trusted_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    source_key VARCHAR(120) NOT NULL,
    label VARCHAR(240) NOT NULL,
    public_key_pem TEXT NOT NULL,
    key_fingerprint CHAR(64) NOT NULL,
    valid_until TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    revision INTEGER NOT NULL DEFAULT 1,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    approved_at TIMESTAMPTZ,
    approval_reason TEXT,
    revoked_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    revoked_at TIMESTAMPTZ,
    revoke_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_ai_artifact_source_key CHECK (source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
    CONSTRAINT chk_ai_artifact_source_label CHECK (length(btrim(label)) BETWEEN 3 AND 240),
    CONSTRAINT chk_ai_artifact_source_fingerprint CHECK (key_fingerprint ~ '^[a-f0-9]{64}$'),
    CONSTRAINT chk_ai_artifact_source_status CHECK (status IN ('PENDING', 'APPROVED', 'REVOKED')),
    CONSTRAINT chk_ai_artifact_source_revision CHECK (revision >= 1),
    CONSTRAINT chk_ai_artifact_source_approval CHECK (
      (status <> 'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND COALESCE(length(btrim(approval_reason)), 0) >= 8))
      AND (status <> 'REVOKED' OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND COALESCE(length(btrim(revoke_reason)), 0) >= 8))
    ),
    CONSTRAINT uq_ai_artifact_trusted_source_identity UNIQUE (tenant_id, source_key),
    CONSTRAINT uq_ai_artifact_trusted_source_fingerprint UNIQUE (tenant_id, key_fingerprint),
    CONSTRAINT uq_ai_artifact_trusted_source_tenant_ref UNIQUE (id, tenant_id)
);

CREATE TABLE IF NOT EXISTS ai_artifact_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    artifact_type VARCHAR(16) NOT NULL,
    artifact_key VARCHAR(200) NOT NULL,
    version VARCHAR(100) NOT NULL,
    sha256 CHAR(64) NOT NULL,
    source_id UUID NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    signature_base64 VARCHAR(256) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    revision INTEGER NOT NULL DEFAULT 1,
    registered_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    revoked_at TIMESTAMPTZ,
    revoke_reason TEXT,
    CONSTRAINT chk_ai_artifact_type CHECK (artifact_type IN ('MODEL', 'TOOL', 'PROMPT', 'POLICY')),
    CONSTRAINT chk_ai_artifact_key CHECK (artifact_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'),
    CONSTRAINT chk_ai_artifact_version CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$'),
    CONSTRAINT chk_ai_artifact_sha256 CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    CONSTRAINT chk_ai_artifact_signature_base64 CHECK (signature_base64 ~ '^[A-Za-z0-9+/]+={0,2}$'),
    CONSTRAINT chk_ai_artifact_status CHECK (status IN ('ACTIVE', 'REVOKED')),
    CONSTRAINT chk_ai_artifact_revision CHECK (revision >= 1),
    CONSTRAINT chk_ai_artifact_revocation CHECK (
      (status <> 'REVOKED' OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND COALESCE(length(btrim(revoke_reason)), 0) >= 8))
    ),
    CONSTRAINT uq_ai_artifact_registry_version_identity UNIQUE (tenant_id, artifact_type, artifact_key, version),
    CONSTRAINT uq_ai_artifact_registry_id_tenant UNIQUE (id, tenant_id),
    CONSTRAINT fk_ai_artifact_source_tenant FOREIGN KEY (source_id, tenant_id)
      REFERENCES ai_artifact_trusted_sources (id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_ai_artifact_registry_admission
  ON ai_artifact_registry (tenant_id, artifact_type, artifact_key, version, status);
CREATE INDEX IF NOT EXISTS idx_ai_artifact_source_status_expiry
  ON ai_artifact_trusted_sources (tenant_id, status, valid_until);

CREATE TABLE IF NOT EXISTS ai_artifact_provenance_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    factory_id UUID NOT NULL,
    actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    entity_type VARCHAR(16) NOT NULL,
    entity_id UUID NOT NULL,
    action VARCHAR(40) NOT NULL,
    reason TEXT NOT NULL,
    request_ref UUID,
    artifact_type VARCHAR(16),
    artifact_key VARCHAR(200),
    artifact_version VARCHAR(100),
    artifact_sha256 CHAR(64),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_ai_artifact_event_entity_type CHECK (entity_type IN ('SOURCE', 'ARTIFACT')),
    CONSTRAINT chk_ai_artifact_event_action CHECK (
      action IN ('SOURCE_REGISTERED', 'SOURCE_APPROVED', 'SOURCE_REVOKED', 'ARTIFACT_REGISTERED', 'ARTIFACT_REVOKED')
    ),
    CONSTRAINT chk_ai_artifact_event_payload CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT fk_ai_artifact_event_factory_tenant FOREIGN KEY (factory_id, tenant_id)
      REFERENCES factories (id, tenant_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS ai_artifact_admission_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    factory_id UUID NOT NULL,
    actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    artifact_id UUID,
    artifact_type VARCHAR(16) NOT NULL,
    artifact_key VARCHAR(200) NOT NULL,
    artifact_version VARCHAR(100) NOT NULL,
    expected_sha256 CHAR(64),
    registry_sha256 CHAR(64),
    decision VARCHAR(8) NOT NULL,
    reason_code VARCHAR(64) NOT NULL,
    request_ref UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_ai_artifact_admission_type CHECK (artifact_type IN ('MODEL', 'TOOL', 'PROMPT', 'POLICY')),
    CONSTRAINT chk_ai_artifact_admission_decision CHECK (decision IN ('ALLOW', 'DENY')),
    CONSTRAINT chk_ai_artifact_admission_reason CHECK (length(btrim(reason_code)) > 0),
    CONSTRAINT fk_ai_artifact_admission_factory_tenant FOREIGN KEY (factory_id, tenant_id)
      REFERENCES factories (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT fk_ai_artifact_admission_artifact_tenant FOREIGN KEY (artifact_id, tenant_id)
      REFERENCES ai_artifact_registry (id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_ai_artifact_admission_history
  ON ai_artifact_admission_events (tenant_id, factory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_artifact_provenance_history
  ON ai_artifact_provenance_events (tenant_id, entity_type, entity_id, created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_ai_artifact_trusted_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI artifact trust-source history is retained; deletion is forbidden'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.revision <> 1
      OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.approval_reason IS NOT NULL
      OR NEW.revoked_by IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.revoke_reason IS NOT NULL
    THEN
      RAISE EXCEPTION 'new AI artifact trust sources must start pending without approval or revocation fields'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.source_key IS DISTINCT FROM OLD.source_key
    OR NEW.label IS DISTINCT FROM OLD.label
    OR NEW.public_key_pem IS DISTINCT FROM OLD.public_key_pem
    OR NEW.key_fingerprint IS DISTINCT FROM OLD.key_fingerprint
    OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'AI artifact trust-source identity is immutable; register a new key to rotate'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'AI artifact trust-source revision must advance exactly once'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'PENDING' AND NEW.status = 'APPROVED' THEN
    IF NEW.approved_by IS NULL OR NEW.approved_by = OLD.created_by
      OR NEW.approved_at IS NULL OR COALESCE(length(btrim(NEW.approval_reason)), 0) < 8
      OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
      OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
      OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason
    THEN
      RAISE EXCEPTION 'source approval requires independent reviewer and reason'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status IN ('PENDING', 'APPROVED') AND NEW.status = 'REVOKED' THEN
    IF NEW.revoked_by IS NULL OR NEW.revoked_at IS NULL OR COALESCE(length(btrim(NEW.revoke_reason)), 0) < 8
      OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.approval_reason IS DISTINCT FROM OLD.approval_reason
    THEN
      RAISE EXCEPTION 'source revocation requires a reason and actor'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid AI artifact trust-source lifecycle transition'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_artifact_trusted_sources_guard ON ai_artifact_trusted_sources;
CREATE TRIGGER ai_artifact_trusted_sources_guard
BEFORE INSERT OR UPDATE OR DELETE ON ai_artifact_trusted_sources
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_ai_artifact_trusted_source();

CREATE OR REPLACE FUNCTION factoryos_guard_ai_artifact_registry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI artifact registry history is retained; deletion is forbidden'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' OR NEW.revision <> 1
      OR NEW.revoked_by IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.revoke_reason IS NOT NULL
    THEN
      RAISE EXCEPTION 'new AI artifacts must start active at revision one without revocation fields'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.artifact_type IS DISTINCT FROM OLD.artifact_type
    OR NEW.artifact_key IS DISTINCT FROM OLD.artifact_key
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.signature_base64 IS DISTINCT FROM OLD.signature_base64
    OR NEW.registered_by IS DISTINCT FROM OLD.registered_by
    OR NEW.registered_at IS DISTINCT FROM OLD.registered_at
  THEN
    RAISE EXCEPTION 'AI artifact identity/signature is immutable; publish a new version for changed bytes'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'REVOKED'
    OR NEW.revision <> OLD.revision + 1
    OR NEW.revoked_by IS NULL OR NEW.revoked_at IS NULL
    OR COALESCE(length(btrim(NEW.revoke_reason)), 0) < 8
  THEN
    RAISE EXCEPTION 'AI artifacts may transition from ACTIVE to REVOKED only, with reason and actor'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_artifact_registry_guard ON ai_artifact_registry;
CREATE TRIGGER ai_artifact_registry_guard
BEFORE INSERT OR UPDATE OR DELETE ON ai_artifact_registry
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_ai_artifact_registry();

CREATE OR REPLACE FUNCTION factoryos_reject_ai_artifact_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AI artifact provenance/admission evidence is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS ai_artifact_provenance_events_immutable ON ai_artifact_provenance_events;
CREATE TRIGGER ai_artifact_provenance_events_immutable
BEFORE UPDATE OR DELETE ON ai_artifact_provenance_events
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_ai_artifact_event_mutation();

DROP TRIGGER IF EXISTS ai_artifact_admission_events_immutable ON ai_artifact_admission_events;
CREATE TRIGGER ai_artifact_admission_events_immutable
BEFORE UPDATE OR DELETE ON ai_artifact_admission_events
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_ai_artifact_event_mutation();

ALTER TABLE ai_artifact_trusted_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_artifact_trusted_sources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_artifact_trusted_sources_tenant_isolation ON ai_artifact_trusted_sources;
CREATE POLICY ai_artifact_trusted_sources_tenant_isolation ON ai_artifact_trusted_sources
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE ai_artifact_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_artifact_registry FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_artifact_registry_tenant_isolation ON ai_artifact_registry;
CREATE POLICY ai_artifact_registry_tenant_isolation ON ai_artifact_registry
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE ai_artifact_provenance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_artifact_provenance_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_artifact_provenance_events_tenant_isolation ON ai_artifact_provenance_events;
CREATE POLICY ai_artifact_provenance_events_tenant_isolation ON ai_artifact_provenance_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE ai_artifact_admission_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_artifact_admission_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_artifact_admission_events_tenant_isolation ON ai_artifact_admission_events;
CREATE POLICY ai_artifact_admission_events_tenant_isolation ON ai_artifact_admission_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMIT;
