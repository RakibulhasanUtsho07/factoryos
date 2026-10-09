BEGIN;

-- ============================================================
-- WP01.5-A
-- ENTITLEMENTS + VERSIONED FEATURE FLAGS
-- ============================================================
--
-- Control-plane configuration for:
--   - tenant entitlements / package capabilities
--   - tenant-scoped feature flags
--
-- Design rules:
--   - every row is tenant-owned
--   - tenant isolation is enforced with PostgreSQL RLS
--   - configuration history is append-only
--   - a new version is created instead of mutating an old version
--   - security-critical flags require a non-empty change reason
--   - expiry/effective windows are database-validated
-- ============================================================


-- ============================================================
-- IMMUTABLE VERSIONED-ROW GUARD
-- ============================================================
--
-- Versioned control-plane records must not be mutated after
-- creation. Roll-forward or rollback is represented by creating
-- another versioned row.
-- ============================================================

CREATE OR REPLACE FUNCTION factoryos_reject_versioned_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'Versioned configuration is immutable: % on % is not allowed',
        TG_OP,
        TG_TABLE_NAME;
END;
$$;


-- ============================================================
-- ENTITLEMENTS
-- ============================================================
--
-- Canonical logical shape:
--   tenant_id
--   package
--   feature_key
--   limit_value
--   period
--
-- Additional fields provide:
--   - versioned history
--   - lifecycle / effective window
--   - typed configuration extension
--   - change attribution
-- ============================================================

CREATE TABLE IF NOT EXISTS entitlements (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    package             VARCHAR(100) NOT NULL,
    feature_key         VARCHAR(150) NOT NULL,

    limit_value         NUMERIC(20,6),
    period              VARCHAR(50),

    version             BIGINT NOT NULL DEFAULT 1,
    status              VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',

    effective_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    effective_to        TIMESTAMPTZ,

    config              JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_by          UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_entitlements_tenant
        FOREIGN KEY (tenant_id)
        REFERENCES tenants(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_entitlements_created_by
        FOREIGN KEY (created_by)
        REFERENCES users(id)
        ON DELETE SET NULL,

    CONSTRAINT uq_entitlements_tenant_feature_version
        UNIQUE (
            tenant_id,
            package,
            feature_key,
            version
        ),

    CONSTRAINT chk_entitlements_version
        CHECK (
            version >= 1
        ),

    CONSTRAINT chk_entitlements_limit_value
        CHECK (
            limit_value IS NULL
            OR limit_value >= 0
        ),

    CONSTRAINT chk_entitlements_status
        CHECK (
            status IN (
                'ACTIVE',
                'DISABLED',
                'EXPIRED'
            )
        ),

    CONSTRAINT chk_entitlements_effective_window
        CHECK (
            effective_to IS NULL
            OR effective_to > effective_from
        ),

    CONSTRAINT chk_entitlements_package
        CHECK (
            LENGTH(BTRIM(package)) > 0
        ),

    CONSTRAINT chk_entitlements_feature_key
        CHECK (
            LENGTH(BTRIM(feature_key)) > 0
        )
);


CREATE INDEX IF NOT EXISTS idx_entitlements_tenant_feature
    ON entitlements (
        tenant_id,
        feature_key,
        effective_from DESC
    );


CREATE INDEX IF NOT EXISTS idx_entitlements_tenant_package
    ON entitlements (
        tenant_id,
        package,
        effective_from DESC
    );


CREATE INDEX IF NOT EXISTS idx_entitlements_created_at
    ON entitlements (
        tenant_id,
        created_at DESC
    );


DROP TRIGGER IF EXISTS entitlements_immutable_version
ON entitlements;

CREATE TRIGGER entitlements_immutable_version
BEFORE UPDATE OR DELETE
ON entitlements
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();


-- ============================================================
-- ENTITLEMENTS RLS
-- ============================================================

ALTER TABLE entitlements
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE entitlements
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entitlements_tenant_isolation
ON entitlements;

CREATE POLICY entitlements_tenant_isolation
ON entitlements
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- FEATURE FLAGS
-- ============================================================
--
-- Every flag belongs to a tenant.
--
-- Versioning means:
--
--   v1 -> old configuration
--   v2 -> next rollout
--   v3 -> later correction / rollback target
--
-- Old versions are retained for audit/replay/diagnostics.
-- ============================================================

CREATE TABLE IF NOT EXISTS feature_flags (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,

    key                 VARCHAR(200) NOT NULL,
    version             BIGINT NOT NULL DEFAULT 1,

    enabled             BOOLEAN NOT NULL DEFAULT FALSE,

    config              JSONB NOT NULL DEFAULT '{}'::JSONB,

    owner               VARCHAR(150) NOT NULL,

    security_critical   BOOLEAN NOT NULL DEFAULT FALSE,
    change_reason       TEXT,

    effective_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ,

    created_by          UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_feature_flags_tenant
        FOREIGN KEY (tenant_id)
        REFERENCES tenants(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_feature_flags_created_by
        FOREIGN KEY (created_by)
        REFERENCES users(id)
        ON DELETE SET NULL,

    CONSTRAINT uq_feature_flags_tenant_key_version
        UNIQUE (
            tenant_id,
            key,
            version
        ),

    CONSTRAINT chk_feature_flags_version
        CHECK (
            version >= 1
        ),

    CONSTRAINT chk_feature_flags_key
        CHECK (
            LENGTH(BTRIM(key)) > 0
        ),

    CONSTRAINT chk_feature_flags_owner
        CHECK (
            LENGTH(BTRIM(owner)) > 0
        ),

    CONSTRAINT chk_feature_flags_expiry
        CHECK (
            expires_at IS NULL
            OR expires_at > effective_from
        ),

    CONSTRAINT chk_feature_flags_security_reason
        CHECK (
            security_critical = FALSE
            OR LENGTH(
                BTRIM(
                    COALESCE(
                        change_reason,
                        ''
                    )
                )
            ) > 0
        )
);


CREATE INDEX IF NOT EXISTS idx_feature_flags_tenant_key
    ON feature_flags (
        tenant_id,
        key,
        effective_from DESC
    );


CREATE INDEX IF NOT EXISTS idx_feature_flags_tenant_expiry
    ON feature_flags (
        tenant_id,
        expires_at
    );


CREATE INDEX IF NOT EXISTS idx_feature_flags_created_at
    ON feature_flags (
        tenant_id,
        created_at DESC
    );


DROP TRIGGER IF EXISTS feature_flags_immutable_version
ON feature_flags;

CREATE TRIGGER feature_flags_immutable_version
BEFORE UPDATE OR DELETE
ON feature_flags
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();


-- ============================================================
-- FEATURE FLAGS RLS
-- ============================================================

ALTER TABLE feature_flags
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE feature_flags
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feature_flags_tenant_isolation
ON feature_flags;

CREATE POLICY feature_flags_tenant_isolation
ON feature_flags
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
    version
)
VALUES (
    '011_entitlement_feature_flags'
)
ON CONFLICT (
    version
)
DO NOTHING;


COMMIT;