BEGIN;

-- ============================================================
-- WP01.5-B
-- POLICY + RISK CLASSES + APPROVALS
-- ============================================================
--
-- Policy service owns:
--   - RBAC / ABAC policy state
--   - risk classification
--   - approval routing metadata
--   - approval lifecycle state
--
-- Design rules:
--   - every customer-owned policy record is tenant-scoped
--   - policy and risk-class versions are immutable
--   - effective windows are database validated
--   - policy evaluation must fail closed
--   - approvals are mutable workflow state
--   - cross-tenant references are rejected structurally
--   - material writes remain auditable
-- ============================================================


-- ============================================================
-- POLICY / RISK PERMISSIONS
-- ============================================================

INSERT INTO permissions (
    code,
    description
)
VALUES
    (
        'policies.read',
        'Read tenant policy configuration'
    ),
    (
        'policies.write',
        'Create tenant policy versions'
    ),
    (
        'policies.evaluate',
        'Evaluate tenant policy decisions'
    ),
    (
        'risk_classes.read',
        'Read tenant risk-class configuration'
    ),
    (
        'risk_classes.write',
        'Create tenant risk-class versions'
    ),
    (
        'approvals.read',
        'Read tenant approval requests'
    ),
    (
        'approvals.decide',
        'Approve or reject tenant approval requests'
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
        'policies.read',
        'policies.write',
        'policies.evaluate',
        'risk_classes.read',
        'risk_classes.write',
        'approvals.read',
        'approvals.decide'
    )

ON CONFLICT (
    role_id,
    permission_id
)
DO NOTHING;


-- ============================================================
-- RISK CLASSES
-- ============================================================
--
-- L0-L4 follows the documented risk-level vocabulary used by
-- the FactoryOS AI governance model.
--
-- This first implementation keeps the classes tenant-owned so
-- the policy engine can evolve per factory/tenant without making
-- authorization state global.
-- ============================================================

CREATE TABLE IF NOT EXISTS risk_classes (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id               UUID NOT NULL,

    code                    VARCHAR(20) NOT NULL,
    name                    VARCHAR(150) NOT NULL,
    description             TEXT,

    version                 BIGINT NOT NULL DEFAULT 1,

    default_approval_required
                            BOOLEAN NOT NULL DEFAULT FALSE,

    status                  VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',

    effective_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    effective_to            TIMESTAMPTZ,

    created_by              UUID,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_risk_classes_tenant
        FOREIGN KEY (
            tenant_id
        )
        REFERENCES tenants (
            id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_risk_classes_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT uq_risk_classes_tenant_code_version
        UNIQUE (
            tenant_id,
            code,
            version
        ),

    CONSTRAINT uq_risk_classes_id_tenant
        UNIQUE (
            id,
            tenant_id
        ),

    CONSTRAINT chk_risk_classes_version
        CHECK (
            version >= 1
        ),

    CONSTRAINT chk_risk_classes_status
        CHECK (
            status IN (
                'ACTIVE',
                'DISABLED',
                'EXPIRED'
            )
        ),

    CONSTRAINT chk_risk_classes_effective_window
        CHECK (
            effective_to IS NULL
            OR effective_to > effective_from
        ),

    CONSTRAINT chk_risk_classes_code
        CHECK (
            LENGTH(BTRIM(code)) > 0
        ),

    CONSTRAINT chk_risk_classes_name
        CHECK (
            LENGTH(BTRIM(name)) > 0
        )
);


CREATE INDEX IF NOT EXISTS idx_risk_classes_tenant_code
    ON risk_classes (
        tenant_id,
        code,
        effective_from DESC
    );


CREATE INDEX IF NOT EXISTS idx_risk_classes_tenant_created
    ON risk_classes (
        tenant_id,
        created_at DESC
    );


DROP TRIGGER IF EXISTS risk_classes_immutable_version
ON risk_classes;


CREATE TRIGGER risk_classes_immutable_version
BEFORE UPDATE OR DELETE
ON risk_classes
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();


-- ============================================================
-- DEFAULT RISK CLASSES FOR EXISTING TENANTS
-- ============================================================

INSERT INTO risk_classes (
    tenant_id,
    code,
    name,
    description,
    version,
    default_approval_required,
    status
)
SELECT
    t.id,
    defaults.code,
    defaults.name,
    defaults.description,
    1,
    defaults.default_approval_required,
    'ACTIVE'

FROM tenants t

CROSS JOIN (
    VALUES
        (
            'L0',
            'Informational',
            'Read-only or informational action with no material side effect.',
            false
        ),
        (
            'L1',
            'Low Risk',
            'Low-impact business action with bounded operational effect.',
            false
        ),
        (
            'L2',
            'Moderate Risk',
            'Material operational recommendation or bounded change.',
            false
        ),
        (
            'L3',
            'High Risk',
            'High-impact action requiring explicit human oversight by default.',
            true
        ),
        (
            'L4',
            'Critical Risk',
            'Critical or safety-sensitive action requiring explicit approval.',
            true
        )
) AS defaults (
    code,
    name,
    description,
    default_approval_required
)

ON CONFLICT (
    tenant_id,
    code,
    version
)
DO NOTHING;


-- ============================================================
-- POLICY DEFINITIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS policies (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id               UUID NOT NULL,

    key                     VARCHAR(200) NOT NULL,
    version                 BIGINT NOT NULL DEFAULT 1,

    status                  VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',

    priority                INTEGER NOT NULL DEFAULT 100,

    action                  VARCHAR(200) NOT NULL,

    resource_type           VARCHAR(150),

    effect                  VARCHAR(20) NOT NULL DEFAULT 'DENY',

    risk_class_id           UUID,

    approval_required       BOOLEAN NOT NULL DEFAULT FALSE,

    conditions              JSONB NOT NULL DEFAULT '{}'::JSONB,

    approval_route          JSONB NOT NULL DEFAULT '{}'::JSONB,

    effective_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    effective_to            TIMESTAMPTZ,

    created_by              UUID,
    change_reason           TEXT,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_policies_tenant
        FOREIGN KEY (
            tenant_id
        )
        REFERENCES tenants (
            id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_policies_risk_class_tenant
        FOREIGN KEY (
            risk_class_id,
            tenant_id
        )
        REFERENCES risk_classes (
            id,
            tenant_id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_policies_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT uq_policies_tenant_key_version
        UNIQUE (
            tenant_id,
            key,
            version
        ),

    CONSTRAINT uq_policies_id_tenant
        UNIQUE (
            id,
            tenant_id
        ),

    CONSTRAINT chk_policies_version
        CHECK (
            version >= 1
        ),

    CONSTRAINT chk_policies_priority
        CHECK (
            priority >= 0
        ),

    CONSTRAINT chk_policies_status
        CHECK (
            status IN (
                'ACTIVE',
                'DISABLED',
                'EXPIRED'
            )
        ),

    CONSTRAINT chk_policies_effect
        CHECK (
            effect IN (
                'ALLOW',
                'DENY'
            )
        ),

    CONSTRAINT chk_policies_action
        CHECK (
            LENGTH(BTRIM(action)) > 0
        ),

    CONSTRAINT chk_policies_effective_window
        CHECK (
            effective_to IS NULL
            OR effective_to > effective_from
        )
);


CREATE INDEX IF NOT EXISTS idx_policies_tenant_action
    ON policies (
        tenant_id,
        action,
        effective_from DESC
    );


CREATE INDEX IF NOT EXISTS idx_policies_tenant_resource
    ON policies (
        tenant_id,
        resource_type,
        effective_from DESC
    );


CREATE INDEX IF NOT EXISTS idx_policies_tenant_priority
    ON policies (
        tenant_id,
        priority DESC,
        version DESC
    );


CREATE INDEX IF NOT EXISTS idx_policies_created_at
    ON policies (
        tenant_id,
        created_at DESC
    );


DROP TRIGGER IF EXISTS policies_immutable_version
ON policies;


CREATE TRIGGER policies_immutable_version
BEFORE UPDATE OR DELETE
ON policies
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();


-- ============================================================
-- APPROVAL REQUESTS
-- ============================================================
--
-- Policy definitions are immutable.
-- Approval requests are lifecycle state and therefore remain
-- mutable until they reach a terminal state.
-- ============================================================

CREATE TABLE IF NOT EXISTS approvals (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id               UUID NOT NULL,

    policy_id               UUID NOT NULL,

    risk_class_id           UUID,

    idempotency_key         VARCHAR(255),

    action                  VARCHAR(200) NOT NULL,

    resource_type           VARCHAR(150),

    resource_id             VARCHAR(255),

    requested_by            UUID NOT NULL,

    status                  VARCHAR(30) NOT NULL DEFAULT 'PENDING',

    metadata                JSONB NOT NULL DEFAULT '{}'::JSONB,

    requested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    expires_at              TIMESTAMPTZ,

    decided_by              UUID,

    decided_at              TIMESTAMPTZ,

    decision_reason        TEXT,

    CONSTRAINT fk_approvals_tenant
        FOREIGN KEY (
            tenant_id
        )
        REFERENCES tenants (
            id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_approvals_policy_tenant
        FOREIGN KEY (
            policy_id,
            tenant_id
        )
        REFERENCES policies (
            id,
            tenant_id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_approvals_risk_class_tenant
        FOREIGN KEY (
            risk_class_id,
            tenant_id
        )
        REFERENCES risk_classes (
            id,
            tenant_id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_approvals_requested_by
        FOREIGN KEY (
            requested_by
        )
        REFERENCES users (
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_approvals_decided_by
        FOREIGN KEY (
            decided_by
        )
        REFERENCES users (
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT chk_approvals_status
        CHECK (
            status IN (
                'PENDING',
                'APPROVED',
                'REJECTED',
                'CANCELLED',
                'EXPIRED'
            )
        ),

    CONSTRAINT chk_approvals_action
        CHECK (
            LENGTH(BTRIM(action)) > 0
        ),

    CONSTRAINT chk_approvals_decision_fields
        CHECK (
            (
                status = 'PENDING'
                AND decided_by IS NULL
                AND decided_at IS NULL
            )
            OR
            (
                status <> 'PENDING'
                AND decided_by IS NOT NULL
                AND decided_at IS NOT NULL
            )
        ),

    CONSTRAINT chk_approvals_expiry
        CHECK (
            expires_at IS NULL
            OR expires_at > requested_at
        )
);


CREATE UNIQUE INDEX IF NOT EXISTS uq_approvals_tenant_idempotency
    ON approvals (
        tenant_id,
        idempotency_key
    )
    WHERE idempotency_key IS NOT NULL;


CREATE INDEX IF NOT EXISTS idx_approvals_tenant_status
    ON approvals (
        tenant_id,
        status,
        requested_at DESC
    );


CREATE INDEX IF NOT EXISTS idx_approvals_tenant_policy
    ON approvals (
        tenant_id,
        policy_id,
        requested_at DESC
    );


CREATE INDEX IF NOT EXISTS idx_approvals_requested_by
    ON approvals (
        tenant_id,
        requested_by,
        requested_at DESC
    );


-- ============================================================
-- RLS: RISK CLASSES
-- ============================================================

ALTER TABLE risk_classes
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE risk_classes
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS risk_classes_tenant_isolation
ON risk_classes;

CREATE POLICY risk_classes_tenant_isolation
ON risk_classes
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: POLICIES
-- ============================================================

ALTER TABLE policies
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE policies
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS policies_tenant_isolation
ON policies;

CREATE POLICY policies_tenant_isolation
ON policies
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: APPROVALS
-- ============================================================

ALTER TABLE approvals
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE approvals
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS approvals_tenant_isolation
ON approvals;

CREATE POLICY approvals_tenant_isolation
ON approvals
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- MIGRATION TRACKING
-- ============================================================

INSERT INTO schema_migrations (
    version,
    checksum
)
VALUES (
    '013_policy_risk_approvals',
    NULL
)

ON CONFLICT (
    version
)
DO NOTHING;


COMMIT;