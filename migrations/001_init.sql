BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version      VARCHAR(100) PRIMARY KEY,
    checksum     VARCHAR(128),
    applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenants (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                VARCHAR(100) NOT NULL,
    name                VARCHAR(200) NOT NULL,
    status              VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    timezone            VARCHAR(80) NOT NULL DEFAULT 'Asia/Dhaka',
    default_locale      VARCHAR(20) NOT NULL DEFAULT 'en-BD',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT chk_tenants_status
        CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_slug
    ON tenants (LOWER(slug));


CREATE TABLE IF NOT EXISTS legal_entities (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    code                VARCHAR(100) NOT NULL,
    name                VARCHAR(200) NOT NULL,
    country_code        CHAR(2) NOT NULL DEFAULT 'BD',
    status              VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT fk_legal_entities_tenant
        FOREIGN KEY (tenant_id)
        REFERENCES tenants(id)
        ON DELETE RESTRICT,

    CONSTRAINT uq_legal_entities_tenant_code
        UNIQUE (tenant_id, code)
);


CREATE TABLE IF NOT EXISTS factories (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    legal_entity_id     UUID,
    code                VARCHAR(100) NOT NULL,
    name                VARCHAR(200) NOT NULL,
    status              VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    timezone            VARCHAR(80) NOT NULL DEFAULT 'Asia/Dhaka',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT fk_factories_tenant
        FOREIGN KEY (tenant_id)
        REFERENCES tenants(id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_factories_legal_entity
        FOREIGN KEY (legal_entity_id)
        REFERENCES legal_entities(id)
        ON DELETE RESTRICT,

    CONSTRAINT uq_factories_tenant_code
        UNIQUE (tenant_id, code)
);


CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_subject    VARCHAR(255),
    email               VARCHAR(320),
    display_name        VARCHAR(200) NOT NULL,
    status              VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT chk_users_status
        CHECK (status IN ('ACTIVE', 'INVITED', 'DISABLED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_external_subject
    ON users (external_subject)
    WHERE external_subject IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email
    ON users (LOWER(email))
    WHERE email IS NOT NULL;


CREATE TABLE IF NOT EXISTS tenant_memberships (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    user_id             UUID NOT NULL,
    status              VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    joined_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_memberships_tenant
        FOREIGN KEY (tenant_id)
        REFERENCES tenants(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_memberships_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    CONSTRAINT uq_memberships_tenant_user
        UNIQUE (tenant_id, user_id),

    CONSTRAINT chk_memberships_status
        CHECK (status IN ('ACTIVE', 'INVITED', 'SUSPENDED', 'REMOVED'))
);


CREATE TABLE IF NOT EXISTS permissions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                VARCHAR(150) NOT NULL,
    description         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_permissions_code
        UNIQUE (code)
);


CREATE TABLE IF NOT EXISTS roles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    code                VARCHAR(100) NOT NULL,
    name                VARCHAR(150) NOT NULL,
    description         TEXT,
    is_system           BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT fk_roles_tenant
        FOREIGN KEY (tenant_id)
        REFERENCES tenants(id)
        ON DELETE CASCADE,

    CONSTRAINT uq_roles_tenant_code
        UNIQUE (tenant_id, code)
);


CREATE TABLE IF NOT EXISTS role_permissions (
    role_id             UUID NOT NULL,
    permission_id       UUID NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (role_id, permission_id),

    CONSTRAINT fk_role_permissions_role
        FOREIGN KEY (role_id)
        REFERENCES roles(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_role_permissions_permission
        FOREIGN KEY (permission_id)
        REFERENCES permissions(id)
        ON DELETE CASCADE
);


CREATE TABLE IF NOT EXISTS user_roles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    membership_id       UUID NOT NULL,
    role_id             UUID NOT NULL,
    factory_id          UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_user_roles_membership
        FOREIGN KEY (membership_id)
        REFERENCES tenant_memberships(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_user_roles_role
        FOREIGN KEY (role_id)
        REFERENCES roles(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_user_roles_factory
        FOREIGN KEY (factory_id)
        REFERENCES factories(id)
        ON DELETE CASCADE
);


CREATE TABLE IF NOT EXISTS audit_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    factory_id          UUID,
    actor_user_id       UUID,
    event_type          VARCHAR(150) NOT NULL,
    action              VARCHAR(100) NOT NULL,
    resource_type       VARCHAR(100),
    resource_id         UUID,
    correlation_id      UUID,
    request_id          UUID,
    data_class          VARCHAR(50) NOT NULL DEFAULT 'INTERNAL',
    payload             JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_audit_tenant
        FOREIGN KEY (tenant_id)
        REFERENCES tenants(id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_audit_factory
        FOREIGN KEY (factory_id)
        REFERENCES factories(id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_audit_actor
        FOREIGN KEY (actor_user_id)
        REFERENCES users(id)
        ON DELETE SET NULL
);


CREATE INDEX IF NOT EXISTS idx_legal_entities_tenant
    ON legal_entities (tenant_id);

CREATE INDEX IF NOT EXISTS idx_factories_tenant
    ON factories (tenant_id);

CREATE INDEX IF NOT EXISTS idx_memberships_tenant
    ON tenant_memberships (tenant_id);

CREATE INDEX IF NOT EXISTS idx_memberships_user
    ON tenant_memberships (user_id);

CREATE INDEX IF NOT EXISTS idx_roles_tenant
    ON roles (tenant_id);

CREATE INDEX IF NOT EXISTS idx_user_roles_membership
    ON user_roles (membership_id);

CREATE INDEX IF NOT EXISTS idx_user_roles_factory
    ON user_roles (factory_id);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_created
    ON audit_events (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_correlation
    ON audit_events (correlation_id);

INSERT INTO schema_migrations (version, checksum)
VALUES ('001_init', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;