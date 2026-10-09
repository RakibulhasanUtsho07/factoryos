BEGIN;

-- ============================================================
-- WP05-A / AI RUNTIME CONTRACT / WAVE 1
-- ============================================================
--
-- Persistent runtime contract for:
--   - canonical AI decision envelopes
--   - permission-scoped AI context packages
--   - immutable AI verification runs
--
-- Wave 1 does not create governed action, execution, outcome,
-- learning, or release objects. Those belong to later waves.
--
-- Design rules:
--   - every runtime record is tenant + factory scoped
--   - trace_id is the retry/idempotency anchor for decisions
--   - context packages belong to exactly one decision envelope
--   - verification runs bind to an exact decision/context pair
--   - runtime history is append-only after creation
--   - RLS fails closed when tenant context is absent
--   - tenant/factory references are structurally constrained
-- ============================================================

INSERT INTO permissions (
    code,
    description
)
VALUES
    (
        'ai.decisions.read',
        'Read tenant-scoped AI decision envelopes'
    ),
    (
        'ai.decisions.write',
        'Create tenant-scoped AI decision envelopes'
    ),
    (
        'ai.context.read',
        'Resolve permission-scoped AI context packages'
    ),
    (
        'ai.verify',
        'Run AI evidence, contradiction and policy verification'
    )
ON CONFLICT (
    code
)
DO NOTHING;

INSERT INTO role_permissions (
    role_id,
    permission_id
)
SELECT
    r.id,
    p.id
FROM roles r
CROSS JOIN permissions p
WHERE
    r.code = 'ORG_ADMIN'
    AND r.is_system = true
    AND p.code IN (
        'ai.decisions.read',
        'ai.decisions.write',
        'ai.context.read',
        'ai.verify'
    )
ON CONFLICT (
    role_id,
    permission_id
)
DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_decision_envelopes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,
    request_id          UUID NOT NULL,
    trace_id            UUID NOT NULL,
    actor_id            UUID NOT NULL,
    objective           VARCHAR(500) NOT NULL,
    reasoning_mode      VARCHAR(100) NOT NULL,
    context_version     VARCHAR(100),
    risk_class          VARCHAR(20),
    output_state        VARCHAR(50) NOT NULL,
    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ai_decision_factory_tenant
        FOREIGN KEY (
            factory_id,
            tenant_id
        )
        REFERENCES factories (
            id,
            tenant_id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_ai_decision_actor
        FOREIGN KEY (actor_id)
        REFERENCES users (id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_ai_decision_objective
        CHECK (LENGTH(BTRIM(objective)) > 0),

    CONSTRAINT chk_ai_decision_reasoning_mode
        CHECK (LENGTH(BTRIM(reasoning_mode)) > 0),

    CONSTRAINT chk_ai_decision_output_state
        CHECK (LENGTH(BTRIM(output_state)) > 0),

    CONSTRAINT chk_ai_decision_metadata
        CHECK (jsonb_typeof(metadata) = 'object'),

    CONSTRAINT uq_ai_decision_id_tenant_factory
        UNIQUE (id, tenant_id, factory_id),

    CONSTRAINT uq_ai_decision_trace_scope
        UNIQUE (tenant_id, factory_id, trace_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_decision_scope_created
    ON ai_decision_envelopes (
        tenant_id,
        factory_id,
        created_at DESC
    );

CREATE INDEX IF NOT EXISTS idx_ai_decision_request
    ON ai_decision_envelopes (
        tenant_id,
        factory_id,
        request_id
    );

CREATE INDEX IF NOT EXISTS idx_ai_decision_actor
    ON ai_decision_envelopes (
        tenant_id,
        factory_id,
        actor_id,
        created_at DESC
    );

CREATE TABLE IF NOT EXISTS ai_context_packages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,
    decision_id         UUID NOT NULL,
    context_version     VARCHAR(100) NOT NULL,
    sources             JSONB NOT NULL DEFAULT '[]'::JSONB,
    permissions         JSONB NOT NULL DEFAULT '[]'::JSONB,
    freshness           JSONB NOT NULL DEFAULT '{}'::JSONB,
    evidence_states     JSONB NOT NULL DEFAULT '[]'::JSONB,
    package_hash        VARCHAR(64) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ai_context_decision_scope
        FOREIGN KEY (
            decision_id,
            tenant_id,
            factory_id
        )
        REFERENCES ai_decision_envelopes (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE RESTRICT,

    CONSTRAINT chk_ai_context_version
        CHECK (LENGTH(BTRIM(context_version)) > 0),

    CONSTRAINT chk_ai_context_sources
        CHECK (jsonb_typeof(sources) = 'array'),

    CONSTRAINT chk_ai_context_permissions
        CHECK (jsonb_typeof(permissions) = 'array'),

    CONSTRAINT chk_ai_context_freshness
        CHECK (jsonb_typeof(freshness) = 'object'),

    CONSTRAINT chk_ai_context_evidence_states
        CHECK (jsonb_typeof(evidence_states) = 'array'),

    CONSTRAINT chk_ai_context_package_hash
        CHECK (package_hash ~ '^[0-9a-fA-F]{64}$'),

    CONSTRAINT uq_ai_context_id_tenant_factory
        UNIQUE (id, tenant_id, factory_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_context_decision_created
    ON ai_context_packages (
        tenant_id,
        factory_id,
        decision_id,
        created_at DESC
    );

CREATE INDEX IF NOT EXISTS idx_ai_context_version
    ON ai_context_packages (
        tenant_id,
        factory_id,
        context_version
    );

CREATE TABLE IF NOT EXISTS ai_verification_runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,
    decision_id         UUID NOT NULL,
    context_package_id  UUID NOT NULL,
    checks              JSONB NOT NULL DEFAULT '[]'::JSONB,
    contradictions      JSONB NOT NULL DEFAULT '[]'::JSONB,
    calc_validation     JSONB NOT NULL DEFAULT '{}'::JSONB,
    policy_checks       JSONB NOT NULL DEFAULT '{}'::JSONB,
    reviewer_result     JSONB NOT NULL DEFAULT '{}'::JSONB,
    status              VARCHAR(30) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ai_verification_decision_scope
        FOREIGN KEY (
            decision_id,
            tenant_id,
            factory_id
        )
        REFERENCES ai_decision_envelopes (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_ai_verification_context_scope
        FOREIGN KEY (
            context_package_id,
            tenant_id,
            factory_id
        )
        REFERENCES ai_context_packages (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE RESTRICT,

    CONSTRAINT chk_ai_verification_checks
        CHECK (jsonb_typeof(checks) = 'array'),

    CONSTRAINT chk_ai_verification_contradictions
        CHECK (jsonb_typeof(contradictions) = 'array'),

    CONSTRAINT chk_ai_verification_calc
        CHECK (jsonb_typeof(calc_validation) = 'object'),

    CONSTRAINT chk_ai_verification_policy
        CHECK (jsonb_typeof(policy_checks) = 'object'),

    CONSTRAINT chk_ai_verification_reviewer
        CHECK (jsonb_typeof(reviewer_result) = 'object'),

    CONSTRAINT chk_ai_verification_status
        CHECK (
            status IN (
                'PASSED',
                'BLOCKED',
                'REVIEW_REQUIRED'
            )
        ),

    CONSTRAINT uq_ai_verification_id_tenant_factory
        UNIQUE (id, tenant_id, factory_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_verification_decision_created
    ON ai_verification_runs (
        tenant_id,
        factory_id,
        decision_id,
        created_at DESC
    );

CREATE INDEX IF NOT EXISTS idx_ai_verification_context
    ON ai_verification_runs (
        tenant_id,
        factory_id,
        context_package_id,
        created_at DESC
    );

CREATE INDEX IF NOT EXISTS idx_ai_verification_status
    ON ai_verification_runs (
        tenant_id,
        factory_id,
        status,
        created_at DESC
    );

CREATE OR REPLACE FUNCTION factoryos_reject_ai_runtime_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'AI runtime history is immutable: %.% mutation is not allowed',
        TG_TABLE_SCHEMA,
        TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS
    ai_decision_envelopes_immutable
ON ai_decision_envelopes;

CREATE TRIGGER
    ai_decision_envelopes_immutable
BEFORE UPDATE OR DELETE
ON ai_decision_envelopes
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_ai_runtime_mutation();

DROP TRIGGER IF EXISTS
    ai_context_packages_immutable
ON ai_context_packages;

CREATE TRIGGER
    ai_context_packages_immutable
BEFORE UPDATE OR DELETE
ON ai_context_packages
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_ai_runtime_mutation();

DROP TRIGGER IF EXISTS
    ai_verification_runs_immutable
ON ai_verification_runs;

CREATE TRIGGER
    ai_verification_runs_immutable
BEFORE UPDATE OR DELETE
ON ai_verification_runs
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_ai_runtime_mutation();

ALTER TABLE ai_decision_envelopes
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_decision_envelopes
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_decision_envelopes_tenant_isolation
ON ai_decision_envelopes;

CREATE POLICY ai_decision_envelopes_tenant_isolation
ON ai_decision_envelopes
USING (
    tenant_id = factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id = factoryos_current_tenant_id()
);

ALTER TABLE ai_context_packages
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_context_packages
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_context_packages_tenant_isolation
ON ai_context_packages;

CREATE POLICY ai_context_packages_tenant_isolation
ON ai_context_packages
USING (
    tenant_id = factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id = factoryos_current_tenant_id()
);

ALTER TABLE ai_verification_runs
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_verification_runs
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_verification_runs_tenant_isolation
ON ai_verification_runs;

CREATE POLICY ai_verification_runs_tenant_isolation
ON ai_verification_runs
USING (
    tenant_id = factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id = factoryos_current_tenant_id()
);

INSERT INTO schema_migrations (
    version,
    checksum
)
VALUES (
    '016_ai_runtime_wave1',
    NULL
)
ON CONFLICT (
    version
)
DO NOTHING;

COMMIT;
