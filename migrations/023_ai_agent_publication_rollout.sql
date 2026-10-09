BEGIN;

-- ============================================================
-- WP06-B10 / CONTROLLED AGENT PROMOTION
--
-- Source alignment:
--   - SRS v2.1 FR-AST-09: sandbox -> canary -> production + rollback
--   - SRS v2.1 NFR-AIF2-17: staged rollout, rollback, immutable audit
--   - SRS v2.1 section 99: publish_requests control-plane object
--
-- Design:
--   - Publication requests are append-only state records.
--   - Deployments are append-only stage snapshots.
--   - Latest deployment per stage is authoritative.
--   - Production promotion requires a completed sandbox run and a
--     completed policy simulation with no denied cases or policy drift.
--   - No credentials or live tool payloads are stored.
-- ============================================================

INSERT INTO permissions (code, description)
VALUES
    (
        'ai.agents.publish',
        'Request or approve staged AI agent publication'
    ),
    (
        'ai.agents.promote',
        'Promote tested AI agent versions between deployment stages'
    ),
    (
        'ai.agents.rollback',
        'Rollback AI agent stage deployments to a prior tested version'
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
      'ai.agents.publish',
      'ai.agents.promote',
      'ai.agents.rollback'
  )
ON CONFLICT (role_id, permission_id)
DO NOTHING;

-- ------------------------------------------------------------
-- APPEND-ONLY PUBLISH REQUESTS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_agent_publish_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    request_id UUID NOT NULL,
    version BIGINT NOT NULL,

    tenant_id UUID NOT NULL,
    factory_id UUID NOT NULL,

    agent_definition_id UUID NOT NULL,
    agent_key VARCHAR(200) NOT NULL,
    sandbox_id UUID NOT NULL,
    simulation_run_id UUID NOT NULL,
    policy_simulation_run_id UUID,

    target_stage VARCHAR(20) NOT NULL,
    action VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL,

    reason VARCHAR(2000),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_ai_agent_publish_request_version
        UNIQUE (request_id, version),

    CONSTRAINT fk_ai_agent_publish_request_agent
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

    CONSTRAINT fk_ai_agent_publish_request_sandbox
        FOREIGN KEY (
            sandbox_id,
            tenant_id,
            factory_id
        )
        REFERENCES agent_sandboxes (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_ai_agent_publish_request_created_by
        FOREIGN KEY (created_by)
        REFERENCES users (id)
        ON DELETE SET NULL,

    CONSTRAINT chk_ai_agent_publish_request_version
        CHECK (version >= 1),

    CONSTRAINT chk_ai_agent_publish_request_agent_key
        CHECK (LENGTH(BTRIM(agent_key)) > 0),

    CONSTRAINT chk_ai_agent_publish_request_stage
        CHECK (target_stage IN ('CANARY', 'PRODUCTION')),

    CONSTRAINT chk_ai_agent_publish_request_action
        CHECK (
            action IN (
                'REQUEST',
                'APPROVE',
                'REJECT',
                'PROMOTE',
                'ROLLBACK'
            )
        ),

    CONSTRAINT chk_ai_agent_publish_request_status
        CHECK (
            status IN (
                'PENDING',
                'APPROVED',
                'REJECTED',
                'PROMOTED',
                'ROLLED_BACK'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_publish_requests_scope_latest
ON ai_agent_publish_requests (
    tenant_id,
    factory_id,
    request_id,
    version DESC
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_publish_requests_agent
ON ai_agent_publish_requests (
    tenant_id,
    factory_id,
    agent_definition_id,
    created_at DESC
);

ALTER TABLE ai_agent_publish_requests
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_agent_publish_requests
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_agent_publish_requests_tenant_isolation
ON ai_agent_publish_requests;

CREATE POLICY ai_agent_publish_requests_tenant_isolation
ON ai_agent_publish_requests
USING (
    tenant_id = factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id = factoryos_current_tenant_id()
);

DROP TRIGGER IF EXISTS ai_agent_publish_requests_immutable
ON ai_agent_publish_requests;

CREATE TRIGGER ai_agent_publish_requests_immutable
BEFORE UPDATE OR DELETE
ON ai_agent_publish_requests
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();

-- ------------------------------------------------------------
-- APPEND-ONLY DEPLOYMENT SNAPSHOTS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_agent_deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL,
    factory_id UUID NOT NULL,

    agent_definition_id UUID NOT NULL,
    agent_key VARCHAR(200) NOT NULL,
    sandbox_id UUID NOT NULL,
    simulation_run_id UUID NOT NULL,
    policy_simulation_run_id UUID,

    stage VARCHAR(20) NOT NULL,
    deployment_version BIGINT NOT NULL,
    status VARCHAR(20) NOT NULL,

    previous_deployment_id UUID,
    rollback_of_deployment_id UUID,

    reason VARCHAR(2000),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_ai_agent_deployment_version
        UNIQUE (
            tenant_id,
            factory_id,
            agent_definition_id,
            stage,
            deployment_version
        ),

    CONSTRAINT fk_ai_agent_deployment_agent
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

    CONSTRAINT fk_ai_agent_deployment_sandbox
        FOREIGN KEY (
            sandbox_id,
            tenant_id,
            factory_id
        )
        REFERENCES agent_sandboxes (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_ai_agent_deployment_created_by
        FOREIGN KEY (created_by)
        REFERENCES users (id)
        ON DELETE SET NULL,

    CONSTRAINT chk_ai_agent_deployment_stage
        CHECK (stage IN ('CANARY', 'PRODUCTION')),

    CONSTRAINT chk_ai_agent_deployment_version
        CHECK (deployment_version >= 1),

    CONSTRAINT chk_ai_agent_deployment_agent_key
        CHECK (LENGTH(BTRIM(agent_key)) > 0),

    CONSTRAINT chk_ai_agent_deployment_status
        CHECK (
            status IN (
                'ACTIVE',
                'ROLLED_BACK'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_deployments_scope_stage
ON ai_agent_deployments (
    tenant_id,
    factory_id,
    stage,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_deployments_agent_stage
ON ai_agent_deployments (
    tenant_id,
    factory_id,
    agent_key,
    stage,
    deployment_version DESC
);

ALTER TABLE ai_agent_deployments
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_agent_deployments
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_agent_deployments_tenant_isolation
ON ai_agent_deployments;

CREATE POLICY ai_agent_deployments_tenant_isolation
ON ai_agent_deployments
USING (
    tenant_id = factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id = factoryos_current_tenant_id()
);

DROP TRIGGER IF EXISTS ai_agent_deployments_immutable
ON ai_agent_deployments;

CREATE TRIGGER ai_agent_deployments_immutable
BEFORE UPDATE OR DELETE
ON ai_agent_deployments
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();

INSERT INTO schema_migrations (
    version,
    checksum
)
VALUES (
    '023_ai_agent_publication_rollout',
    NULL
)
ON CONFLICT (version)
DO NOTHING;

COMMIT;
