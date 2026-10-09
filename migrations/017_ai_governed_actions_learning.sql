BEGIN;

-- ============================================================
-- WP05-B / AI RUNTIME CONTRACT / WAVE 2
-- ============================================================
--
-- Governed action + learning lifecycle:
--   - action intents and scoped action tokens
--   - execution records
--   - expected/observed outcome links
--   - structured learning signals
--   - gated AI release records
--
-- This migration deliberately does not mutate domain aggregates.
-- Actual business side effects stay behind a future Tool Gateway / domain
-- adapter boundary. The runtime records authorization and execution results,
-- and fails closed when no executable adapter exists.
-- ============================================================

INSERT INTO permissions (code, description)
VALUES
  ('ai.actions.authorize', 'Classify and authorize tenant-scoped AI action intents'),
  ('ai.actions.execute', 'Execute tenant-scoped AI action tokens'),
  ('ai.outcomes.write', 'Record observed outcomes for AI decisions'),
  ('ai.learning.write', 'Record structured tenant-scoped AI learning signals'),
  ('ai.release.write', 'Promote approved tenant-scoped AI artifacts'),
  ('ai.replay.read', 'Read tenant-scoped AI material-decision replay state')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code IN (
    'ai.actions.authorize',
    'ai.actions.execute',
    'ai.outcomes.write',
    'ai.learning.write',
    'ai.release.write',
    'ai.replay.read'
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- PostgreSQL requires the referenced column set of a foreign key
-- to be backed by a PRIMARY KEY or UNIQUE constraint.
-- The AI runtime intentionally binds approvals to the tenant,
-- therefore the composite approval identity is indexed explicitly.
CREATE UNIQUE INDEX IF NOT EXISTS uq_approvals_id_tenant
  ON approvals (id, tenant_id);

CREATE TABLE IF NOT EXISTS ai_action_intents (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL,
    factory_id            UUID NOT NULL,
    decision_id           UUID NOT NULL,
    action_type           VARCHAR(200) NOT NULL,
    target                JSONB NOT NULL,
    resource_type         VARCHAR(150),
    resource_id           VARCHAR(255),
    payload               JSONB NOT NULL,
    payload_hash          VARCHAR(64) NOT NULL,
    risk_class            VARCHAR(20),
    authorization_status  VARCHAR(30) NOT NULL,
    "authorization"         JSONB NOT NULL DEFAULT '{}'::JSONB,
    approval_id           UUID,
    action_token_hash     VARCHAR(64),
    token_expires_at      TIMESTAMPTZ,
    idempotency_key       VARCHAR(255),
    created_by            UUID NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ai_action_decision_scope
      FOREIGN KEY (decision_id, tenant_id, factory_id)
      REFERENCES ai_decision_envelopes (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_ai_action_factory_tenant
      FOREIGN KEY (factory_id, tenant_id)
      REFERENCES factories (id, tenant_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_ai_action_actor
      FOREIGN KEY (created_by)
      REFERENCES users (id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_ai_action_approval_tenant
      FOREIGN KEY (approval_id, tenant_id)
      REFERENCES approvals (id, tenant_id)
      ON DELETE RESTRICT,

    CONSTRAINT chk_ai_action_target
      CHECK (jsonb_typeof(target) = 'object'),

    CONSTRAINT chk_ai_action_payload
      CHECK (jsonb_typeof(payload) = 'object'),

    CONSTRAINT chk_ai_action_authorization
      CHECK (jsonb_typeof("authorization") = 'object'),

    CONSTRAINT chk_ai_action_hash
      CHECK (payload_hash ~ '^[0-9a-fA-F]{64}$'),

    CONSTRAINT chk_ai_action_status
      CHECK (authorization_status IN ('DENIED', 'APPROVAL_REQUIRED', 'AUTHORIZED')),

    CONSTRAINT chk_ai_action_token_pair
      CHECK (
        (authorization_status = 'AUTHORIZED'
          AND action_token_hash IS NOT NULL
          AND token_expires_at IS NOT NULL)
        OR
        (authorization_status <> 'AUTHORIZED'
          AND action_token_hash IS NULL
          AND token_expires_at IS NULL)
      ),

    CONSTRAINT uq_ai_action_id_tenant_factory
      UNIQUE (id, tenant_id, factory_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_action_token_hash
  ON ai_action_intents (action_token_hash)
  WHERE action_token_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_action_idempotency
  ON ai_action_intents (tenant_id, factory_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_action_decision_created
  ON ai_action_intents (tenant_id, factory_id, decision_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_action_status_created
  ON ai_action_intents (tenant_id, factory_id, authorization_status, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_execution_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,
    decision_id         UUID NOT NULL,
    action_intent_id    UUID NOT NULL,
    execution_key       VARCHAR(255) NOT NULL,
    executor_type       VARCHAR(100) NOT NULL,
    tool_version        VARCHAR(100) NOT NULL,
    inputs_hash         VARCHAR(64) NOT NULL,
    result              JSONB NOT NULL DEFAULT '{}'::JSONB,
    error               JSONB NOT NULL DEFAULT '{}'::JSONB,
    status              VARCHAR(30) NOT NULL,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at         TIMESTAMPTZ,

    CONSTRAINT fk_ai_execution_action_scope
      FOREIGN KEY (action_intent_id, tenant_id, factory_id)
      REFERENCES ai_action_intents (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_ai_execution_decision_scope
      FOREIGN KEY (decision_id, tenant_id, factory_id)
      REFERENCES ai_decision_envelopes (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT chk_ai_execution_result
      CHECK (jsonb_typeof(result) = 'object'),

    CONSTRAINT chk_ai_execution_error
      CHECK (jsonb_typeof(error) = 'object'),

    CONSTRAINT chk_ai_execution_hash
      CHECK (inputs_hash ~ '^[0-9a-fA-F]{64}$'),

    CONSTRAINT chk_ai_execution_status
      CHECK (status IN ('SUCCEEDED', 'FAILED')),

    CONSTRAINT uq_ai_execution_id_tenant_factory
      UNIQUE (id, tenant_id, factory_id),

    CONSTRAINT uq_ai_execution_action_once
      UNIQUE (action_intent_id),

    CONSTRAINT uq_ai_execution_key
      UNIQUE (tenant_id, factory_id, execution_key)
);

CREATE INDEX IF NOT EXISTS idx_ai_execution_decision_created
  ON ai_execution_records (tenant_id, factory_id, decision_id, started_at DESC);

CREATE TABLE IF NOT EXISTS ai_outcome_links (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,
    decision_id         UUID NOT NULL,
    action_intent_id    UUID,
    execution_record_id UUID,
    expected_metric     JSONB NOT NULL,
    actual_metric       JSONB NOT NULL DEFAULT '{}'::JSONB,
    outcome_window      JSONB NOT NULL DEFAULT '{}'::JSONB,
    causal_notes        TEXT,
    status              VARCHAR(30) NOT NULL DEFAULT 'EXPECTED',
    created_by          UUID NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ai_outcome_decision_scope
      FOREIGN KEY (decision_id, tenant_id, factory_id)
      REFERENCES ai_decision_envelopes (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_ai_outcome_action_scope
      FOREIGN KEY (action_intent_id, tenant_id, factory_id)
      REFERENCES ai_action_intents (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_ai_outcome_execution_scope
      FOREIGN KEY (execution_record_id, tenant_id, factory_id)
      REFERENCES ai_execution_records (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_ai_outcome_actor
      FOREIGN KEY (created_by)
      REFERENCES users (id)
      ON DELETE RESTRICT,

    CONSTRAINT chk_ai_outcome_expected
      CHECK (jsonb_typeof(expected_metric) = 'object'),

    CONSTRAINT chk_ai_outcome_actual
      CHECK (jsonb_typeof(actual_metric) = 'object'),

    CONSTRAINT chk_ai_outcome_window
      CHECK (jsonb_typeof(outcome_window) = 'object'),

    CONSTRAINT chk_ai_outcome_status
      CHECK (status IN ('EXPECTED', 'PARTIAL', 'OBSERVED', 'FAILED')),

    CONSTRAINT uq_ai_outcome_id_tenant_factory
      UNIQUE (id, tenant_id, factory_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_outcome_decision_created
  ON ai_outcome_links (tenant_id, factory_id, decision_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_learning_signals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,
    source_decision_id  UUID NOT NULL,
    source_outcome_id   UUID,
    source_execution_id UUID,
    signal_type         VARCHAR(100) NOT NULL,
    label               VARCHAR(200) NOT NULL,
    confidence          NUMERIC(5,4) NOT NULL,
    tenant_scope        VARCHAR(50) NOT NULL DEFAULT 'TENANT',
    payload             JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_by          UUID NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ai_learning_decision_scope
      FOREIGN KEY (source_decision_id, tenant_id, factory_id)
      REFERENCES ai_decision_envelopes (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_ai_learning_outcome_scope
      FOREIGN KEY (source_outcome_id, tenant_id, factory_id)
      REFERENCES ai_outcome_links (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_ai_learning_execution_scope
      FOREIGN KEY (source_execution_id, tenant_id, factory_id)
      REFERENCES ai_execution_records (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_ai_learning_actor
      FOREIGN KEY (created_by)
      REFERENCES users (id)
      ON DELETE RESTRICT,

    CONSTRAINT chk_ai_learning_confidence
      CHECK (confidence >= 0 AND confidence <= 1),

    CONSTRAINT chk_ai_learning_payload
      CHECK (jsonb_typeof(payload) = 'object'),

    CONSTRAINT chk_ai_learning_scope
      CHECK (tenant_scope IN ('TENANT', 'FACTORY', 'GLOBAL_CANDIDATE')),

    CONSTRAINT uq_ai_learning_id_tenant_factory
      UNIQUE (id, tenant_id, factory_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_learning_decision_created
  ON ai_learning_signals (tenant_id, factory_id, source_decision_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_release_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,
    source_decision_id UUID,
    artifact_type       VARCHAR(100) NOT NULL,
    artifact_key        VARCHAR(200) NOT NULL,
    version             VARCHAR(100) NOT NULL,
    tests               JSONB NOT NULL DEFAULT '{}'::JSONB,
    approval_id         UUID NOT NULL,
    rollback_ref        VARCHAR(255),
    status              VARCHAR(30) NOT NULL DEFAULT 'PROMOTED',
    effective_at        TIMESTAMPTZ,
    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_by          UUID NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ai_release_decision_scope
      FOREIGN KEY (source_decision_id, tenant_id, factory_id)
      REFERENCES ai_decision_envelopes (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_ai_release_factory_tenant
      FOREIGN KEY (factory_id, tenant_id)
      REFERENCES factories (id, tenant_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_ai_release_approval_tenant
      FOREIGN KEY (approval_id, tenant_id)
      REFERENCES approvals (id, tenant_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_ai_release_actor
      FOREIGN KEY (created_by)
      REFERENCES users (id)
      ON DELETE RESTRICT,

    CONSTRAINT chk_ai_release_tests
      CHECK (jsonb_typeof(tests) = 'object'),

    CONSTRAINT chk_ai_release_metadata
      CHECK (jsonb_typeof(metadata) = 'object'),

    CONSTRAINT chk_ai_release_status
      CHECK (status IN ('PROMOTED', 'ROLLED_BACK')),

    CONSTRAINT uq_ai_release_id_tenant_factory
      UNIQUE (id, tenant_id, factory_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_release_artifact_version
  ON ai_release_records (tenant_id, factory_id, artifact_type, artifact_key, version);

CREATE INDEX IF NOT EXISTS idx_ai_release_artifact
  ON ai_release_records (tenant_id, factory_id, artifact_type, artifact_key, version);

CREATE OR REPLACE FUNCTION factoryos_reject_ai_governed_runtime_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'AI governed runtime history is immutable: %.% mutation is not allowed',
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS ai_action_intents_immutable ON ai_action_intents;
CREATE TRIGGER ai_action_intents_immutable
BEFORE UPDATE OR DELETE ON ai_action_intents
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_ai_governed_runtime_mutation();

DROP TRIGGER IF EXISTS ai_execution_records_immutable ON ai_execution_records;
CREATE TRIGGER ai_execution_records_immutable
BEFORE UPDATE OR DELETE ON ai_execution_records
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_ai_governed_runtime_mutation();

DROP TRIGGER IF EXISTS ai_outcome_links_immutable ON ai_outcome_links;
CREATE TRIGGER ai_outcome_links_immutable
BEFORE UPDATE OR DELETE ON ai_outcome_links
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_ai_governed_runtime_mutation();

DROP TRIGGER IF EXISTS ai_learning_signals_immutable ON ai_learning_signals;
CREATE TRIGGER ai_learning_signals_immutable
BEFORE UPDATE OR DELETE ON ai_learning_signals
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_ai_governed_runtime_mutation();

DROP TRIGGER IF EXISTS ai_release_records_immutable ON ai_release_records;
CREATE TRIGGER ai_release_records_immutable
BEFORE UPDATE OR DELETE ON ai_release_records
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_ai_governed_runtime_mutation();

ALTER TABLE ai_action_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_action_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_action_intents_tenant_isolation ON ai_action_intents;
CREATE POLICY ai_action_intents_tenant_isolation ON ai_action_intents
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE ai_execution_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_execution_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_execution_records_tenant_isolation ON ai_execution_records;
CREATE POLICY ai_execution_records_tenant_isolation ON ai_execution_records
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE ai_outcome_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_outcome_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_outcome_links_tenant_isolation ON ai_outcome_links;
CREATE POLICY ai_outcome_links_tenant_isolation ON ai_outcome_links
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE ai_learning_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_learning_signals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_learning_signals_tenant_isolation ON ai_learning_signals;
CREATE POLICY ai_learning_signals_tenant_isolation ON ai_learning_signals
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE ai_release_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_release_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_release_records_tenant_isolation ON ai_release_records;
CREATE POLICY ai_release_records_tenant_isolation ON ai_release_records
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version, checksum)
VALUES ('017_ai_governed_actions_learning', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
