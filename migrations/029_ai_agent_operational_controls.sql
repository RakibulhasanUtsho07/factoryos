BEGIN;

-- ============================================================
-- WP06 / APPEND-ONLY AI AGENT OPERATIONAL CONTROLS
-- ============================================================
-- Runtime overrides are separate from immutable agent definition versions.
-- The latest control revision for tenant/factory/agent is authoritative.
-- RESTRICTED can only narrow the scopes already declared by a definition;
-- PAUSED blocks tool entitlement checks for every definition version.
-- ============================================================

INSERT INTO permissions (code, description)
VALUES (
  'ai.agents.control',
  'Enable, pause, or restrict an AI agent at tenant/factory scope'
)
ON CONFLICT (code)
DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code = 'ai.agents.control'
ON CONFLICT (role_id, permission_id)
DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_agent_operational_controls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  control_revision BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,

  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  agent_id VARCHAR(200) NOT NULL,
  agent_definition_id UUID NOT NULL,

  status VARCHAR(20) NOT NULL,
  execution_scopes TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  reason VARCHAR(2000) NOT NULL,

  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_ai_agent_operational_control_revision
    UNIQUE (tenant_id, factory_id, agent_id, control_revision),

  CONSTRAINT fk_ai_agent_operational_control_definition
    FOREIGN KEY (agent_definition_id, tenant_id, factory_id)
    REFERENCES ai_agent_definitions (id, tenant_id, factory_id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_ai_agent_operational_control_actor
    FOREIGN KEY (created_by)
    REFERENCES users (id)
    ON DELETE SET NULL,

  CONSTRAINT chk_ai_agent_operational_control_agent_id
    CHECK (LENGTH(BTRIM(agent_id)) > 0),

  CONSTRAINT chk_ai_agent_operational_control_status
    CHECK (status IN ('ENABLED', 'PAUSED', 'RESTRICTED')),

  CONSTRAINT chk_ai_agent_operational_control_scopes
    CHECK (
      array_position(execution_scopes, '') IS NULL
      AND array_position(execution_scopes, NULL) IS NULL
      AND cardinality(execution_scopes) <= 100
    ),

  CONSTRAINT chk_ai_agent_operational_control_scope_mode
    CHECK (status = 'RESTRICTED' OR cardinality(execution_scopes) = 0),

  CONSTRAINT chk_ai_agent_operational_control_reason
    CHECK (LENGTH(BTRIM(reason)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_operational_control_latest
ON ai_agent_operational_controls (
  tenant_id,
  factory_id,
  agent_id,
  control_revision DESC
);

ALTER TABLE ai_agent_operational_controls
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_agent_operational_controls
  FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_agent_operational_controls_tenant_isolation
ON ai_agent_operational_controls;

CREATE POLICY ai_agent_operational_controls_tenant_isolation
ON ai_agent_operational_controls
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

DROP TRIGGER IF EXISTS ai_agent_operational_controls_immutable
ON ai_agent_operational_controls;

CREATE TRIGGER ai_agent_operational_controls_immutable
BEFORE UPDATE OR DELETE
ON ai_agent_operational_controls
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();

INSERT INTO schema_migrations (version, checksum)
VALUES ('029_ai_agent_operational_controls', NULL)
ON CONFLICT (version)
DO NOTHING;

COMMIT;
