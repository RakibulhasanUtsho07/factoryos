BEGIN;

-- ============================================================
-- WP06-B11 / GOVERNED AGENT STUDIO DRAFT BUILDER
--
-- Source alignment:
--   - SRS v2.1 FR-AST-10: natural-language agent creation must
--     create a reviewable draft, not grant permissions.
--   - SRS v2.1 section 99: workflow_drafts control-plane object.
--   - SRS v2.1 NFR-AIF2-12: generated workflow/application
--     artifacts require schema/permission/policy validation before
--     publication.
--   - SRS v2.1 NFR-AIF2-17: immutable audit history for AI changes.
--
-- The table is append-only/versioned. Approval creates another
-- version; it never mutates the original generated draft.
-- No agent definition, tool grant, action token or deployment is
-- created by this migration or by the B11 service.
-- ============================================================

INSERT INTO permissions (code, description)
VALUES
    (
        'ai.agents.draft.read',
        'Read governed AI agent/workflow draft specifications'
    ),
    (
        'ai.agents.draft.write',
        'Create and review governed AI agent/workflow draft specifications'
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
      'ai.agents.draft.read',
      'ai.agents.draft.write'
  )
ON CONFLICT (role_id, permission_id)
DO NOTHING;

CREATE TABLE IF NOT EXISTS workflow_drafts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    draft_id            UUID NOT NULL,
    version             BIGINT NOT NULL,

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    source_prompt       TEXT NOT NULL,
    title               VARCHAR(200) NOT NULL,

    goal                VARCHAR(2000) NOT NULL,
    capability          VARCHAR(500) NOT NULL,
    typical_output      VARCHAR(500) NOT NULL,
    authority           VARCHAR(500) NOT NULL,

    risk_ceiling        VARCHAR(20) NOT NULL DEFAULT 'L0',

    requested_scopes    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    proposed_tools     JSONB NOT NULL DEFAULT '[]'::JSONB,

    generated_spec     JSONB NOT NULL,
    validation         JSONB NOT NULL,

    status              VARCHAR(30) NOT NULL DEFAULT 'DRAFT',

    review_notes       VARCHAR(2000),
    reviewed_by        UUID,
    reviewed_at        TIMESTAMPTZ,

    created_by         UUID,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_workflow_draft_version
        UNIQUE (
            draft_id,
            version
        ),

    CONSTRAINT fk_workflow_draft_factory_tenant
        FOREIGN KEY (
            factory_id,
            tenant_id
        )
        REFERENCES factories (
            id,
            tenant_id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_workflow_draft_created_by
        FOREIGN KEY (created_by)
        REFERENCES users (id)
        ON DELETE SET NULL,

    CONSTRAINT fk_workflow_draft_reviewed_by
        FOREIGN KEY (reviewed_by)
        REFERENCES users (id)
        ON DELETE SET NULL,

    CONSTRAINT chk_workflow_draft_version
        CHECK (version >= 1),

    CONSTRAINT chk_workflow_draft_source_prompt
        CHECK (LENGTH(BTRIM(source_prompt)) > 0),

    CONSTRAINT chk_workflow_draft_title
        CHECK (LENGTH(BTRIM(title)) > 0),

    CONSTRAINT chk_workflow_draft_goal
        CHECK (LENGTH(BTRIM(goal)) > 0),

    CONSTRAINT chk_workflow_draft_capability
        CHECK (LENGTH(BTRIM(capability)) > 0),

    CONSTRAINT chk_workflow_draft_typical_output
        CHECK (LENGTH(BTRIM(typical_output)) > 0),

    CONSTRAINT chk_workflow_draft_authority
        CHECK (LENGTH(BTRIM(authority)) > 0),

    CONSTRAINT chk_workflow_draft_risk
        CHECK (
            risk_ceiling IN (
                'L0',
                'L1',
                'L2',
                'L3',
                'L4'
            )
        ),

    CONSTRAINT chk_workflow_draft_status
        CHECK (
            status IN (
                'DRAFT',
                'READY_FOR_PUBLISH',
                'REJECTED',
                'ARCHIVED'
            )
        ),

    CONSTRAINT chk_workflow_draft_requested_scopes
        CHECK (
            cardinality(requested_scopes) <= 100
        ),

    CONSTRAINT chk_workflow_draft_proposed_tools
        CHECK (
            jsonb_typeof(proposed_tools) = 'array'
        ),

    CONSTRAINT chk_workflow_draft_generated_spec
        CHECK (
            jsonb_typeof(generated_spec) = 'object'
        ),

    CONSTRAINT chk_workflow_draft_validation
        CHECK (
            jsonb_typeof(validation) = 'object'
        ),

    CONSTRAINT chk_workflow_draft_review_window
        CHECK (
            (reviewed_by IS NULL AND reviewed_at IS NULL)
            OR
            (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS idx_workflow_drafts_scope_created
ON workflow_drafts (
    tenant_id,
    factory_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_workflow_drafts_scope_draft
ON workflow_drafts (
    tenant_id,
    factory_id,
    draft_id,
    version DESC
);

CREATE INDEX IF NOT EXISTS idx_workflow_drafts_scope_status
ON workflow_drafts (
    tenant_id,
    factory_id,
    status,
    created_at DESC
);

ALTER TABLE workflow_drafts
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE workflow_drafts
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_drafts_tenant_isolation
ON workflow_drafts;

CREATE POLICY workflow_drafts_tenant_isolation
ON workflow_drafts
USING (
    tenant_id = factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id = factoryos_current_tenant_id()
);

DROP TRIGGER IF EXISTS workflow_drafts_immutable
ON workflow_drafts;

CREATE TRIGGER workflow_drafts_immutable
BEFORE UPDATE OR DELETE
ON workflow_drafts
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();

INSERT INTO schema_migrations (
    version,
    checksum
)
VALUES (
    '024_ai_agent_workflow_drafts',
    NULL
)
ON CONFLICT (version)
DO NOTHING;

COMMIT;
