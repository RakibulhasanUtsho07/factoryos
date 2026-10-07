BEGIN;

-- ============================================================
-- WP06-B1 / DURABLE AI AGENT RUNTIME CORE
-- ============================================================
--
-- Durable task/step state for governed AI agent workflows.
--
-- Source contracts:
--   - SRS v2.1: FR-AIN, FR-AGO, FR-AOP, NFR-AI-18
--   - HLD/LLD v1.0: Agent Runtime + workflow/checkpoint design
--   - Engineering Blueprint v1.0: section 9.3 and section 14
--
-- This migration intentionally does NOT introduce a new execution
-- ledger. AI execution remains linked to the existing:
--   ai_action_intents
--   ai_execution_records
--
-- All customer-owned records are tenant/factory scoped and RLS
-- protected. Workflow history is made auditable through AuditService;
-- task rows remain mutable state, not immutable event history.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_decision_scope
ON ai_decision_envelopes (id, tenant_id, factory_id);

CREATE TABLE IF NOT EXISTS agent_tasks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,
    decision_id         UUID NOT NULL,
    parent_trace_id     UUID NOT NULL,
    actor_user_id       UUID NOT NULL,
    goal                VARCHAR(1000) NOT NULL,
    state               VARCHAR(30) NOT NULL DEFAULT 'CREATED',
    max_steps           INTEGER NOT NULL DEFAULT 20,
    max_retries         INTEGER NOT NULL DEFAULT 3,
    max_tool_calls      INTEGER NOT NULL DEFAULT 20,
    timeout_ms          INTEGER NOT NULL DEFAULT 60000,
    deadline_at         TIMESTAMPTZ NOT NULL,
    retry_count         INTEGER NOT NULL DEFAULT 0,
    tool_call_count     INTEGER NOT NULL DEFAULT 0,
    completed_step_count INTEGER NOT NULL DEFAULT 0,
    current_step_id     UUID NULL,
    context_version     VARCHAR(100) NULL,
    plan_version        VARCHAR(100) NULL,
    context_hash        VARCHAR(128) NULL,
    cancel_requested_at TIMESTAMPTZ NULL,
    failure_code        VARCHAR(100) NULL,
    failure_reason      VARCHAR(2000) NULL,
    idempotency_key     VARCHAR(255) NULL,
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_agent_task_factory_tenant
        FOREIGN KEY (factory_id, tenant_id)
        REFERENCES factories (id, tenant_id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_agent_task_decision_scope
        FOREIGN KEY (decision_id, tenant_id, factory_id)
        REFERENCES ai_decision_envelopes (id, tenant_id, factory_id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_agent_task_actor
        FOREIGN KEY (actor_user_id)
        REFERENCES users (id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_agent_task_goal
        CHECK (LENGTH(BTRIM(goal)) > 0),

    CONSTRAINT chk_agent_task_state
        CHECK (state IN (
            'CREATED',
            'CONTEXT_READY',
            'PLAN_READY',
            'AWAITING_AUTH',
            'AWAITING_APPROVAL',
            'EXECUTING',
            'VERIFYING',
            'COMPLETED',
            'BLOCKED',
            'FAILED',
            'CANCELLED'
        )),

    CONSTRAINT chk_agent_task_limits
        CHECK (
            max_steps >= 1 AND max_steps <= 100
            AND max_retries >= 0 AND max_retries <= 20
            AND max_tool_calls >= 1 AND max_tool_calls <= 200
            AND timeout_ms >= 100 AND timeout_ms <= 3600000
        ),

    CONSTRAINT chk_agent_task_counters
        CHECK (
            retry_count >= 0
            AND retry_count <= max_retries
            AND tool_call_count >= 0
            AND tool_call_count <= max_tool_calls
            AND completed_step_count >= 0
        ),

    CONSTRAINT chk_agent_task_version
        CHECK (version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_tasks_tenant_idempotency
ON agent_tasks (tenant_id, factory_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_tasks_id_tenant_factory
ON agent_tasks (id, tenant_id, factory_id);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_scope_state
ON agent_tasks (tenant_id, factory_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_trace
ON agent_tasks (tenant_id, factory_id, parent_trace_id);

CREATE TABLE IF NOT EXISTS agent_task_steps (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL,
    factory_id            UUID NOT NULL,
    task_id               UUID NOT NULL,
    step_key              VARCHAR(200) NOT NULL,
    step_index            INTEGER NOT NULL,
    agent_id              VARCHAR(200) NULL,
    capability            VARCHAR(200) NOT NULL,
    input_schema          JSONB NOT NULL DEFAULT '{}'::JSONB,
    output_schema         JSONB NOT NULL DEFAULT '{}'::JSONB,
    tool_id               VARCHAR(200) NOT NULL,
    tool_version          VARCHAR(100) NOT NULL,
    action_type           VARCHAR(200) NOT NULL,
    target                JSONB NOT NULL DEFAULT '{}'::JSONB,
    payload               JSONB NOT NULL DEFAULT '{}'::JSONB,
    resource_type         VARCHAR(150) NULL,
    resource_id           VARCHAR(255) NULL,
    risk_class            VARCHAR(20) NULL,
    timeout_ms            INTEGER NOT NULL DEFAULT 1000,
    retry_limit           INTEGER NOT NULL DEFAULT 0,
    authority_level       VARCHAR(100) NOT NULL DEFAULT 'TASK_SCOPED',
    depends_on            JSONB NOT NULL DEFAULT '[]'::JSONB,
    status                VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    retry_count           INTEGER NOT NULL DEFAULT 0,
    authorization_attempt INTEGER NOT NULL DEFAULT 0,
    action_intent_id      UUID NULL,
    approval_id           UUID NULL,
    execution_record_id   UUID NULL,
    output                JSONB NOT NULL DEFAULT '{}'::JSONB,
    error                 JSONB NOT NULL DEFAULT '{}'::JSONB,
    started_at            TIMESTAMPTZ NULL,
    finished_at           TIMESTAMPTZ NULL,
    version               INTEGER NOT NULL DEFAULT 1,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_agent_step_task_scope
        FOREIGN KEY (task_id, tenant_id, factory_id)
        REFERENCES agent_tasks (id, tenant_id, factory_id)
        ON DELETE CASCADE,

    CONSTRAINT chk_agent_step_key
        CHECK (LENGTH(BTRIM(step_key)) > 0),

    CONSTRAINT chk_agent_step_index
        CHECK (step_index >= 0 AND step_index < 100),

    CONSTRAINT chk_agent_step_schemas
        CHECK (
            jsonb_typeof(input_schema) = 'object'
            AND jsonb_typeof(output_schema) = 'object'
        ),

    CONSTRAINT chk_agent_step_payload
        CHECK (
            jsonb_typeof(target) = 'object'
            AND jsonb_typeof(payload) = 'object'
        ),

    CONSTRAINT chk_agent_step_risk
        CHECK (
            risk_class IS NULL
            OR risk_class IN ('L0', 'L1', 'L2', 'L3', 'L4')
        ),

    CONSTRAINT chk_agent_step_limits
        CHECK (
            timeout_ms >= 100
            AND timeout_ms <= 60000
            AND retry_limit >= 0
            AND retry_limit <= 20
            AND retry_count >= 0
            AND retry_count <= retry_limit
            AND authorization_attempt >= 0
        ),

    CONSTRAINT chk_agent_step_status
        CHECK (status IN (
            'PENDING',
            'RUNNING',
            'AWAITING_APPROVAL',
            'SUCCEEDED',
            'FAILED',
            'BLOCKED',
            'CANCELLED'
        )),

    CONSTRAINT chk_agent_step_depends
        CHECK (jsonb_typeof(depends_on) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_task_steps_task_key
ON agent_task_steps (task_id, step_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_task_steps_task_index
ON agent_task_steps (task_id, step_index);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_task_steps_id_scope
ON agent_task_steps (id, tenant_id, factory_id);

CREATE INDEX IF NOT EXISTS idx_agent_task_steps_scope_status
ON agent_task_steps (tenant_id, factory_id, task_id, status, step_index);

CREATE INDEX IF NOT EXISTS idx_agent_task_steps_action
ON agent_task_steps (tenant_id, factory_id, action_intent_id);

CREATE TABLE IF NOT EXISTS agent_action_attempts (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL,
    factory_id            UUID NOT NULL,
    task_id               UUID NOT NULL,
    step_id               UUID NOT NULL,
    attempt_number        INTEGER NOT NULL,
    attempt_type          VARCHAR(30) NOT NULL DEFAULT 'EXECUTION',
    action_intent_id      UUID NULL,
    execution_record_id   UUID NULL,
    status                VARCHAR(30) NOT NULL,
    error                 JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at           TIMESTAMPTZ NULL,

    CONSTRAINT fk_agent_attempt_task_scope
        FOREIGN KEY (task_id, tenant_id, factory_id)
        REFERENCES agent_tasks (id, tenant_id, factory_id)
        ON DELETE CASCADE,

    CONSTRAINT fk_agent_attempt_step_scope
        FOREIGN KEY (step_id, tenant_id, factory_id)
        REFERENCES agent_task_steps (id, tenant_id, factory_id)
        ON DELETE CASCADE,

    CONSTRAINT chk_agent_attempt_number
        CHECK (attempt_number >= 1),

    CONSTRAINT chk_agent_attempt_type
        CHECK (attempt_type IN ('EXECUTION', 'COMPENSATION')),

    CONSTRAINT chk_agent_attempt_status
        CHECK (status IN (
            'STARTED',
            'SUCCEEDED',
            'FAILED',
            'BLOCKED',
            'CANCELLED'
        )),

    CONSTRAINT chk_agent_attempt_error
        CHECK (jsonb_typeof(error) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_attempt_identity
ON agent_action_attempts (task_id, step_id, attempt_number, attempt_type);

CREATE INDEX IF NOT EXISTS idx_agent_attempts_scope
ON agent_action_attempts (tenant_id, factory_id, task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_handoffs (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL,
    factory_id            UUID NOT NULL,
    source_agent_id       VARCHAR(200) NOT NULL,
    target_agent_id       VARCHAR(200) NOT NULL,
    purpose               VARCHAR(1000) NOT NULL,
    allowed_data_classes  TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    permitted_tools       TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    expires_at            TIMESTAMPTZ NOT NULL,
    parent_trace_id       UUID NOT NULL,
    expected_artifact     JSONB NULL,
    handoff_hash          VARCHAR(128) NOT NULL,
    status                VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    accepted_by           UUID NULL,
    accepted_at           TIMESTAMPTZ NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_agent_handoff_factory_tenant
        FOREIGN KEY (factory_id, tenant_id)
        REFERENCES factories (id, tenant_id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_agent_handoff_accepted_by
        FOREIGN KEY (accepted_by)
        REFERENCES users (id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_agent_handoff_purpose
        CHECK (LENGTH(BTRIM(purpose)) > 0),

    CONSTRAINT chk_agent_handoff_expiry
        CHECK (expires_at > created_at),

    CONSTRAINT chk_agent_handoff_status
        CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED')),

    CONSTRAINT chk_agent_handoff_artifact
        CHECK (
            expected_artifact IS NULL
            OR jsonb_typeof(expected_artifact) = 'object'
        )
);

CREATE INDEX IF NOT EXISTS idx_agent_handoffs_scope_status
ON agent_handoffs (tenant_id, factory_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_agent_handoffs_parent_trace
ON agent_handoffs (tenant_id, factory_id, parent_trace_id);

CREATE OR REPLACE FUNCTION factoryos_touch_agent_runtime_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_tasks_updated_at ON agent_tasks;
CREATE TRIGGER agent_tasks_updated_at
BEFORE UPDATE ON agent_tasks
FOR EACH ROW
EXECUTE FUNCTION factoryos_touch_agent_runtime_updated_at();

DROP TRIGGER IF EXISTS agent_task_steps_updated_at ON agent_task_steps;
CREATE TRIGGER agent_task_steps_updated_at
BEFORE UPDATE ON agent_task_steps
FOR EACH ROW
EXECUTE FUNCTION factoryos_touch_agent_runtime_updated_at();

DROP TRIGGER IF EXISTS agent_handoffs_updated_at ON agent_handoffs;
CREATE TRIGGER agent_handoffs_updated_at
BEFORE UPDATE ON agent_handoffs
FOR EACH ROW
EXECUTE FUNCTION factoryos_touch_agent_runtime_updated_at();

ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_tasks_tenant_isolation ON agent_tasks;
CREATE POLICY agent_tasks_tenant_isolation
ON agent_tasks
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE agent_task_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_task_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_task_steps_tenant_isolation ON agent_task_steps;
CREATE POLICY agent_task_steps_tenant_isolation
ON agent_task_steps
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE agent_action_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_action_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_action_attempts_tenant_isolation ON agent_action_attempts;
CREATE POLICY agent_action_attempts_tenant_isolation
ON agent_action_attempts
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE agent_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_handoffs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_handoffs_tenant_isolation ON agent_handoffs;
CREATE POLICY agent_handoffs_tenant_isolation
ON agent_handoffs
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version, checksum)
VALUES ('019_ai_agent_runtime', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
