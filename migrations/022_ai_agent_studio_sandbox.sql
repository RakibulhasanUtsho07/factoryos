BEGIN;

-- ============================================================
-- WP06 / Agent Studio sandbox foundation
-- Source alignment:
--   FR-AST-01..05
--   NFR-AIF2-04
--   AS-113 / AS-134
--
-- Safety invariant:
-- sandbox execution is simulation-only; live credentials, live
-- write tools and unrestricted network access are prohibited.
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_sandboxes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL,
    factory_id UUID NOT NULL,

    name VARCHAR(200) NOT NULL,
    mode VARCHAR(20) NOT NULL DEFAULT 'SIMULATION',

    agent_spec JSONB NOT NULL,
    input_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
    policy_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,

    network_access VARCHAR(20) NOT NULL DEFAULT 'NONE',
    credentials_access VARCHAR(20) NOT NULL DEFAULT 'NONE',
    live_write_allowed BOOLEAN NOT NULL DEFAULT FALSE,

    status VARCHAR(20) NOT NULL DEFAULT 'CREATED',

    created_by UUID,
    trace_id UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_agent_sandbox_factory_tenant
        FOREIGN KEY (factory_id, tenant_id)
        REFERENCES factories (id, tenant_id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_agent_sandbox_created_by
        FOREIGN KEY (created_by)
        REFERENCES users (id)
        ON DELETE SET NULL,

    CONSTRAINT uq_agent_sandbox_id_scope
        UNIQUE (id, tenant_id, factory_id),

    CONSTRAINT chk_agent_sandbox_name
        CHECK (LENGTH(BTRIM(name)) > 0),

    CONSTRAINT chk_agent_sandbox_mode
        CHECK (mode IN ('SIMULATION')),

    CONSTRAINT chk_agent_sandbox_network
        CHECK (network_access IN ('NONE')),

    CONSTRAINT chk_agent_sandbox_credentials
        CHECK (credentials_access IN ('NONE')),

    CONSTRAINT chk_agent_sandbox_live_write
        CHECK (live_write_allowed = FALSE),

    CONSTRAINT chk_agent_sandbox_status
        CHECK (
            status IN (
                'CREATED',
                'RUNNING',
                'COMPLETED',
                'FAILED',
                'BLOCKED'
            )
        ),

    CONSTRAINT chk_agent_sandbox_agent_spec
        CHECK (jsonb_typeof(agent_spec) = 'object'),

    CONSTRAINT chk_agent_sandbox_input_snapshot
        CHECK (jsonb_typeof(input_snapshot) = 'object'),

    CONSTRAINT chk_agent_sandbox_policy_snapshot
        CHECK (jsonb_typeof(policy_snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_agent_sandboxes_scope_status
ON agent_sandboxes (
    tenant_id,
    factory_id,
    status,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_agent_sandboxes_scope_creator
ON agent_sandboxes (
    tenant_id,
    factory_id,
    created_by,
    created_at DESC
);

ALTER TABLE agent_sandboxes
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE agent_sandboxes
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_sandboxes_tenant_isolation
ON agent_sandboxes;

CREATE POLICY agent_sandboxes_tenant_isolation
ON agent_sandboxes
USING (
    tenant_id = factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id = factoryos_current_tenant_id()
);

-- ------------------------------------------------------------
-- Simulation runs
-- One sandbox may have many immutable/replayable simulation runs.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS simulation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL,
    factory_id UUID NOT NULL,

    sandbox_id UUID NOT NULL,
    parent_run_id UUID,

    mode VARCHAR(20) NOT NULL DEFAULT 'SIMULATION',
    status VARCHAR(20) NOT NULL DEFAULT 'COMPLETED',

    plan JSONB NOT NULL DEFAULT '[]'::JSONB,
    simulated_tool_responses JSONB NOT NULL DEFAULT '{}'::JSONB,
    observations JSONB NOT NULL DEFAULT '[]'::JSONB,
    result JSONB NOT NULL DEFAULT '{}'::JSONB,

    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    created_by UUID,
    trace_id UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_simulation_run_factory_tenant
        FOREIGN KEY (factory_id, tenant_id)
        REFERENCES factories (id, tenant_id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_simulation_run_sandbox_scope
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

    CONSTRAINT fk_simulation_run_parent
        FOREIGN KEY (parent_run_id)
        REFERENCES simulation_runs (id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_simulation_run_created_by
        FOREIGN KEY (created_by)
        REFERENCES users (id)
        ON DELETE SET NULL,

    CONSTRAINT chk_simulation_run_mode
        CHECK (mode IN ('SIMULATION')),

    CONSTRAINT chk_simulation_run_status
        CHECK (
            status IN (
                'COMPLETED',
                'FAILED',
                'BLOCKED'
            )
        ),

    CONSTRAINT chk_simulation_run_plan
        CHECK (jsonb_typeof(plan) = 'array'),

    CONSTRAINT chk_simulation_run_responses
        CHECK (jsonb_typeof(simulated_tool_responses) = 'object'),

    CONSTRAINT chk_simulation_run_observations
        CHECK (jsonb_typeof(observations) = 'array'),

    CONSTRAINT chk_simulation_run_result
        CHECK (jsonb_typeof(result) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_simulation_runs_scope_sandbox
ON simulation_runs (
    tenant_id,
    factory_id,
    sandbox_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_simulation_runs_parent
ON simulation_runs (
    tenant_id,
    factory_id,
    parent_run_id,
    created_at DESC
);

ALTER TABLE simulation_runs
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE simulation_runs
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS simulation_runs_tenant_isolation
ON simulation_runs;

CREATE POLICY simulation_runs_tenant_isolation
ON simulation_runs
USING (
    tenant_id = factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id = factoryos_current_tenant_id()
);

-- Immutable simulation records: UPDATE/DELETE is rejected.
DROP TRIGGER IF EXISTS simulation_runs_immutable
ON simulation_runs;

CREATE TRIGGER simulation_runs_immutable
BEFORE UPDATE OR DELETE
ON simulation_runs
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();

-- Touch sandbox updated_at.
CREATE OR REPLACE FUNCTION factoryos_touch_agent_sandbox_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_sandboxes_updated_at
ON agent_sandboxes;

CREATE TRIGGER agent_sandboxes_updated_at
BEFORE UPDATE
ON agent_sandboxes
FOR EACH ROW
EXECUTE FUNCTION factoryos_touch_agent_sandbox_updated_at();

INSERT INTO schema_migrations (
    version,
    checksum
)
VALUES (
    '022_ai_agent_studio_sandbox',
    NULL
)
ON CONFLICT (version)
DO NOTHING;

COMMIT;
