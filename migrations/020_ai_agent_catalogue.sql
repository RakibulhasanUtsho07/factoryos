BEGIN;

-- ============================================================
-- WP06-B3 / VERSIONED AI AGENT CATALOGUE + TOOL GRANTS
-- ============================================================
--
-- Source alignment:
--   - SRS v2.1 section 98: AI frontier agent catalogue
--   - SRS v2.1 section 99: Agent Studio / Autonomy control plane
--   - NFR-AIF2-05: quotas enforceable at tenant/factory/agent/
--                 workflow/tool levels
--   - NFR-AIF2-17: staged rollout, rollback and immutable audit
--   - Engineering Blueprint v1.0 section 14.2/14.3:
--       registered/entitled tool + explicit scopes + risk ceiling
--
-- B3 models tenant/factory-owned agent definitions and immutable
-- grant versions. No credentials/secrets are stored here.
-- ============================================================

INSERT INTO permissions (code, description)
VALUES
    (
        'ai.agents.read',
        'Read tenant/factory AI agent catalogue configuration'
    ),
    (
        'ai.agents.write',
        'Create and version tenant/factory AI agent catalogue configuration'
    )
ON CONFLICT (code)
DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT
    r.id,
    p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code IN (
      'ai.agents.read',
      'ai.agents.write'
  )
ON CONFLICT (role_id, permission_id)
DO NOTHING;

-- ------------------------------------------------------------
-- AGENT DEFINITIONS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_agent_definitions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    agent_id            VARCHAR(200) NOT NULL,
    version             VARCHAR(100) NOT NULL,

    name                VARCHAR(200) NOT NULL,
    description         VARCHAR(2000),

    capability          VARCHAR(500) NOT NULL,
    typical_output      VARCHAR(500) NOT NULL,
    authority           VARCHAR(500) NOT NULL,

    risk_ceiling        VARCHAR(20) NOT NULL DEFAULT 'L0',

    status              VARCHAR(20) NOT NULL DEFAULT 'DRAFT',

    max_steps           INTEGER NOT NULL DEFAULT 20,
    max_retries         INTEGER NOT NULL DEFAULT 3,
    max_tool_calls      INTEGER NOT NULL DEFAULT 20,
    timeout_ms          INTEGER NOT NULL DEFAULT 60000,

    config              JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_by          UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ai_agent_definition_factory_tenant
        FOREIGN KEY (factory_id, tenant_id)
        REFERENCES factories (id, tenant_id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_ai_agent_definition_created_by
        FOREIGN KEY (created_by)
        REFERENCES users (id)
        ON DELETE SET NULL,

    CONSTRAINT uq_ai_agent_definition_scope_version
        UNIQUE (
            tenant_id,
            factory_id,
            agent_id,
            version
        ),

    CONSTRAINT chk_ai_agent_definition_agent_id
        CHECK (LENGTH(BTRIM(agent_id)) > 0),

    CONSTRAINT chk_ai_agent_definition_version
        CHECK (LENGTH(BTRIM(version)) > 0),

    CONSTRAINT chk_ai_agent_definition_name
        CHECK (LENGTH(BTRIM(name)) > 0),

    CONSTRAINT chk_ai_agent_definition_capability
        CHECK (LENGTH(BTRIM(capability)) > 0),

    CONSTRAINT chk_ai_agent_definition_output
        CHECK (LENGTH(BTRIM(typical_output)) > 0),

    CONSTRAINT chk_ai_agent_definition_authority
        CHECK (LENGTH(BTRIM(authority)) > 0),

    CONSTRAINT chk_ai_agent_definition_risk
        CHECK (
            risk_ceiling IN (
                'L0',
                'L1',
                'L2',
                'L3',
                'L4'
            )
        ),

    CONSTRAINT chk_ai_agent_definition_status
        CHECK (
            status IN (
                'DRAFT',
                'ACTIVE',
                'PAUSED',
                'RETIRED'
            )
        ),

    CONSTRAINT chk_ai_agent_definition_limits
        CHECK (
            max_steps >= 1
            AND max_steps <= 100
            AND max_retries >= 0
            AND max_retries <= 20
            AND max_tool_calls >= 1
            AND max_tool_calls <= 200
            AND timeout_ms >= 100
            AND timeout_ms <= 3600000
        ),

    CONSTRAINT chk_ai_agent_definition_config
        CHECK (
            jsonb_typeof(config) = 'object'
        )
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_definitions_scope_status
ON ai_agent_definitions (
    tenant_id,
    factory_id,
    status,
    updated_at DESC
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_definitions_scope_agent
ON ai_agent_definitions (
    tenant_id,
    factory_id,
    agent_id,
    version
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_agent_definitions_id_scope
ON ai_agent_definitions (
    id,
    tenant_id,
    factory_id
);

ALTER TABLE ai_agent_definitions
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_agent_definitions
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_agent_definitions_tenant_isolation
ON ai_agent_definitions;

CREATE POLICY ai_agent_definitions_tenant_isolation
ON ai_agent_definitions
USING (
    tenant_id = factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id = factoryos_current_tenant_id()
);

DROP TRIGGER IF EXISTS ai_agent_definitions_immutable_version
ON ai_agent_definitions;

CREATE TRIGGER ai_agent_definitions_immutable_version
BEFORE UPDATE OR DELETE
ON ai_agent_definitions
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();

CREATE OR REPLACE FUNCTION factoryos_touch_ai_agent_catalogue_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_agent_definitions_updated_at
ON ai_agent_definitions;

CREATE TRIGGER ai_agent_definitions_updated_at
BEFORE UPDATE
ON ai_agent_definitions
FOR EACH ROW
EXECUTE FUNCTION factoryos_touch_ai_agent_catalogue_updated_at();

-- ai_agent_tool_grants are immutable/versioned and have no updated_at column.
-- Do not add an updated_at trigger: mutations are rejected below.

-- ------------------------------------------------------------
-- AGENT TOOL GRANTS
-- ------------------------------------------------------------
--
-- Grants are also immutable/versioned:
--   ACTIVE  = currently entitled
--   REVOKED = explicit deny version
--
-- Revoke is represented by a new version instead of mutating
-- a historical row.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_agent_tool_grants (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    agent_definition_id UUID NOT NULL,

    tool_id             VARCHAR(200) NOT NULL,
    tool_version        VARCHAR(100) NOT NULL,

    version             BIGINT NOT NULL DEFAULT 1,

    status              VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',

    effective_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ,

    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_by          UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ai_agent_tool_grant_agent_scope
        FOREIGN KEY (
            agent_definition_id,
            tenant_id,
            factory_id
        )
        REFERENCES ai_agent_definitions (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_ai_agent_tool_grant_created_by
        FOREIGN KEY (created_by)
        REFERENCES users (id)
        ON DELETE SET NULL,

    CONSTRAINT uq_ai_agent_tool_grant_version
        UNIQUE (
            tenant_id,
            factory_id,
            agent_definition_id,
            tool_id,
            tool_version,
            version
        ),

    CONSTRAINT chk_ai_agent_tool_grant_tool_id
        CHECK (LENGTH(BTRIM(tool_id)) > 0),

    CONSTRAINT chk_ai_agent_tool_grant_tool_version
        CHECK (LENGTH(BTRIM(tool_version)) > 0),

    CONSTRAINT chk_ai_agent_tool_grant_version
        CHECK (version >= 1),

    CONSTRAINT chk_ai_agent_tool_grant_status
        CHECK (
            status IN (
                'ACTIVE',
                'REVOKED'
            )
        ),

    CONSTRAINT chk_ai_agent_tool_grant_window
        CHECK (
            expires_at IS NULL
            OR expires_at > effective_from
        ),

    CONSTRAINT chk_ai_agent_tool_grant_metadata
        CHECK (
            jsonb_typeof(metadata) = 'object'
        )
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_tool_grants_scope_agent
ON ai_agent_tool_grants (
    tenant_id,
    factory_id,
    agent_definition_id,
    tool_id,
    tool_version,
    version DESC
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_tool_grants_effective
ON ai_agent_tool_grants (
    tenant_id,
    factory_id,
    effective_from,
    expires_at
);

ALTER TABLE ai_agent_tool_grants
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_agent_tool_grants
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_agent_tool_grants_tenant_isolation
ON ai_agent_tool_grants;

CREATE POLICY ai_agent_tool_grants_tenant_isolation
ON ai_agent_tool_grants
USING (
    tenant_id = factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id = factoryos_current_tenant_id()
);

DROP TRIGGER IF EXISTS ai_agent_tool_grants_immutable_version
ON ai_agent_tool_grants;

CREATE TRIGGER ai_agent_tool_grants_immutable_version
BEFORE UPDATE OR DELETE
ON ai_agent_tool_grants
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();

-- ------------------------------------------------------------
-- MIGRATION TRACKING
-- ------------------------------------------------------------

INSERT INTO schema_migrations (
    version,
    checksum
)
VALUES (
    '020_ai_agent_catalogue',
    NULL
)
ON CONFLICT (version)
DO NOTHING;

COMMIT;
