BEGIN;

-- ============================================================
-- WP06-A / AI TOOL REGISTRY
-- ============================================================
--
-- Durable registry for governed AI tools.
--
-- Registry scope:
--   - global platform tool
--   - tenant-scoped tool
--   - factory-scoped tool
--
-- Resolution precedence:
--   factory + tenant
--   tenant
--   global
--
-- Design rules:
--   - tool_id + version identifies an immutable tool contract
--   - input/output schemas are stored as JSON Schema objects
--   - risk class is explicit
--   - required IAM scopes are explicit
--   - approval mode is explicit
--   - write-capable tools require idempotency
--   - write-capable tools require rollback/compensation metadata
--   - execution timeout is bounded
--   - tool registry history is immutable
--   - credentials/secrets are never stored here
--   - RLS prevents cross-tenant registry access
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_tool_registry (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID,
    factory_id          UUID,

    tool_id             VARCHAR(200) NOT NULL,
    version             VARCHAR(100) NOT NULL,

    input_schema        JSONB NOT NULL,
    output_schema       JSONB NOT NULL,

    risk_class          VARCHAR(20) NOT NULL,

    required_scopes     TEXT[] NOT NULL DEFAULT '{}'::TEXT[],

    approval_mode       VARCHAR(20) NOT NULL DEFAULT 'none',

    write_capable       BOOLEAN NOT NULL DEFAULT false,

    idempotency_required
                        BOOLEAN NOT NULL DEFAULT false,

    timeout_ms          INTEGER NOT NULL DEFAULT 1000,

    audit_mode          VARCHAR(30) NOT NULL DEFAULT 'REDACTED',

    rollback            JSONB NOT NULL
                        DEFAULT '{"type":"NONE"}'::JSONB,

    status              VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',

    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_by          UUID,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ai_tool_factory_tenant
        FOREIGN KEY (
            factory_id,
            tenant_id
        )
        REFERENCES factories (
            id,
            tenant_id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_ai_tool_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT chk_ai_tool_id
        CHECK (
            LENGTH(BTRIM(tool_id)) > 0
        ),

    CONSTRAINT chk_ai_tool_version
        CHECK (
            LENGTH(BTRIM(version)) > 0
        ),

    CONSTRAINT chk_ai_tool_input_schema
        CHECK (
            jsonb_typeof(input_schema) = 'object'
        ),

    CONSTRAINT chk_ai_tool_output_schema
        CHECK (
            jsonb_typeof(output_schema) = 'object'
        ),

    CONSTRAINT chk_ai_tool_risk_class
        CHECK (
            risk_class IN (
                'L0',
                'L1',
                'L2',
                'L3',
                'L4'
            )
        ),

    CONSTRAINT chk_ai_tool_approval_mode
        CHECK (
            approval_mode IN (
                'none',
                'user',
                'role',
                'dual',
                'policy'
            )
        ),

    CONSTRAINT chk_ai_tool_timeout
        CHECK (
            timeout_ms >= 100
            AND timeout_ms <= 60000
        ),

    CONSTRAINT chk_ai_tool_audit_mode
        CHECK (
            audit_mode IN (
                'REDACTED'
            )
        ),

    CONSTRAINT chk_ai_tool_status
        CHECK (
            status IN (
                'ACTIVE',
                'DISABLED',
                'RETIRED'
            )
        ),

    CONSTRAINT chk_ai_tool_metadata
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    CONSTRAINT chk_ai_tool_rollback
        CHECK (
            jsonb_typeof(rollback) = 'object'
        ),

    CONSTRAINT chk_ai_tool_factory_requires_tenant
        CHECK (
            factory_id IS NULL
            OR tenant_id IS NOT NULL
        ),

    CONSTRAINT chk_ai_tool_write_idempotency
        CHECK (
            NOT write_capable
            OR idempotency_required
        ),

    CONSTRAINT chk_ai_tool_write_rollback
        CHECK (
            NOT write_capable
            OR COALESCE(
                rollback->>'type',
                'NONE'
            ) <> 'NONE'
        )
);

-- ------------------------------------------------------------
-- Registry uniqueness by scope.
-- ------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS
    uq_ai_tool_registry_global
ON ai_tool_registry (
    tool_id,
    version
)
WHERE
    tenant_id IS NULL
    AND factory_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
    uq_ai_tool_registry_tenant
ON ai_tool_registry (
    tenant_id,
    tool_id,
    version
)
WHERE
    tenant_id IS NOT NULL
    AND factory_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
    uq_ai_tool_registry_factory
ON ai_tool_registry (
    tenant_id,
    factory_id,
    tool_id,
    version
)
WHERE
    tenant_id IS NOT NULL
    AND factory_id IS NOT NULL;

-- ------------------------------------------------------------
-- Query indexes.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS
    idx_ai_tool_registry_lookup
ON ai_tool_registry (
    tenant_id,
    factory_id,
    tool_id,
    version,
    status
);

CREATE INDEX IF NOT EXISTS
    idx_ai_tool_registry_tool
ON ai_tool_registry (
    tool_id,
    version,
    status
);

-- ------------------------------------------------------------
-- Immutable registry history.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION
    factoryos_reject_ai_tool_registry_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'AI tool registry history is immutable: %.% mutation is not allowed',
        TG_TABLE_SCHEMA,
        TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS
    ai_tool_registry_immutable
ON ai_tool_registry;

CREATE TRIGGER
    ai_tool_registry_immutable
BEFORE UPDATE OR DELETE
ON ai_tool_registry
FOR EACH ROW
EXECUTE FUNCTION
    factoryos_reject_ai_tool_registry_mutation();

-- ------------------------------------------------------------
-- Tenant isolation.
--
-- Global platform tools have NULL tenant_id and contain only
-- non-secret tool contract metadata.
-- ------------------------------------------------------------

ALTER TABLE ai_tool_registry
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_tool_registry
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    ai_tool_registry_tenant_isolation
ON ai_tool_registry;

CREATE POLICY
    ai_tool_registry_tenant_isolation
ON ai_tool_registry
USING (
    tenant_id IS NULL
    OR tenant_id = factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id IS NULL
    OR tenant_id = factoryos_current_tenant_id()
);

-- ============================================================
-- Initial deterministic tools.
--
-- These are intentionally no-side-effect contract tools.
-- They allow the Tool Gateway boundary to become executable
-- without introducing unsafe business mutation.
-- ============================================================

INSERT INTO ai_tool_registry (
    tenant_id,
    factory_id,
    tool_id,
    version,
    input_schema,
    output_schema,
    risk_class,
    required_scopes,
    approval_mode,
    write_capable,
    idempotency_required,
    timeout_ms,
    audit_mode,
    rollback,
    status,
    metadata
)
VALUES
(
    NULL,
    NULL,
    'AI.RUNTIME.NOOP',
    '1.0.0',
    '{
        "type": "object",
        "additionalProperties": true
    }'::JSONB,
    '{
        "type": "object",
        "required": [
            "execution",
            "executorType",
            "actionType",
            "committed"
        ],
        "properties": {
            "execution": {
                "type": "string"
            },
            "executorType": {
                "type": "string"
            },
            "actionType": {
                "type": "string"
            },
            "committed": {
                "type": "boolean"
            }
        },
        "additionalProperties": true
    }'::JSONB,
    'L0',
    ARRAY[
        'ai.actions.execute'
    ]::TEXT[],
    'none',
    false,
    false,
    1000,
    'REDACTED',
    '{"type":"NONE"}'::JSONB,
    'ACTIVE',
    '{
        "purpose": "Deterministic no-side-effect AI runtime contract execution"
    }'::JSONB
),
(
    NULL,
    NULL,
    'AUDIT_ONLY',
    '1.0.0',
    '{
        "type": "object",
        "additionalProperties": true
    }'::JSONB,
    '{
        "type": "object",
        "required": [
            "execution",
            "executorType",
            "actionType",
            "committed"
        ],
        "properties": {
            "execution": {
                "type": "string"
            },
            "executorType": {
                "type": "string"
            },
            "actionType": {
                "type": "string"
            },
            "committed": {
                "type": "boolean"
            }
        },
        "additionalProperties": true
    }'::JSONB,
    'L0',
    ARRAY[
        'ai.actions.execute'
    ]::TEXT[],
    'none',
    false,
    false,
    1000,
    'REDACTED',
    '{"type":"NONE"}'::JSONB,
    'ACTIVE',
    '{
        "purpose": "Deterministic audit-only no-side-effect tool"
    }'::JSONB
)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- Migration marker.
-- ------------------------------------------------------------

INSERT INTO schema_migrations (
    version,
    checksum
)
VALUES (
    '018_ai_tool_registry',
    NULL
)
ON CONFLICT (
    version
)
DO NOTHING;

COMMIT;