BEGIN;

-- ============================================================
-- TRANSACTION-LOCAL TENANT / USER CONTEXT
-- ============================================================

CREATE OR REPLACE FUNCTION factoryos_current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT
        NULLIF(
            current_setting(
                'app.tenant_id',
                true
            ),
            ''
        )::uuid;
$$;

CREATE OR REPLACE FUNCTION factoryos_current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT
        NULLIF(
            current_setting(
                'app.user_id',
                true
            ),
            ''
        )::uuid;
$$;


-- ============================================================
-- LEGAL ENTITIES
-- ============================================================

ALTER TABLE legal_entities
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE legal_entities
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS legal_entities_tenant_isolation
ON legal_entities;

CREATE POLICY legal_entities_tenant_isolation
ON legal_entities
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- FACTORIES
-- ============================================================

ALTER TABLE factories
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE factories
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS factories_tenant_isolation
ON factories;

CREATE POLICY factories_tenant_isolation
ON factories
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- TENANT MEMBERSHIPS
-- ============================================================
--
-- Before a tenant is selected, authenticated users may discover
-- only their own memberships.
--
-- Once a tenant is selected, only that tenant is visible.
-- Writes always require an active tenant context.
-- ============================================================

ALTER TABLE tenant_memberships
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenant_memberships
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_memberships_tenant_isolation
ON tenant_memberships;

CREATE POLICY tenant_memberships_tenant_isolation
ON tenant_memberships
USING (
    tenant_id =
        factoryos_current_tenant_id()

    OR (
        factoryos_current_tenant_id()
            IS NULL

        AND user_id =
            factoryos_current_user_id()
    )
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- ROLES
-- ============================================================

ALTER TABLE roles
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE roles
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS roles_tenant_isolation
ON roles;

CREATE POLICY roles_tenant_isolation
ON roles
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- ROLE PERMISSIONS
-- ============================================================
--
-- role_permissions has no tenant_id.
-- Tenant ownership comes from roles.tenant_id.
-- ============================================================

ALTER TABLE role_permissions
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE role_permissions
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_permissions_tenant_isolation
ON role_permissions;

CREATE POLICY role_permissions_tenant_isolation
ON role_permissions
USING (
    EXISTS (
        SELECT 1
        FROM roles r
        WHERE
            r.id =
                role_permissions.role_id

            AND r.tenant_id =
                factoryos_current_tenant_id()
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1
        FROM roles r
        WHERE
            r.id =
                role_permissions.role_id

            AND r.tenant_id =
                factoryos_current_tenant_id()
    )
);


-- ============================================================
-- USER ROLES
-- ============================================================
--
-- Tenant ownership is derived from:
--
--   tenant_memberships.tenant_id
--   roles.tenant_id
--   factories.tenant_id
-- ============================================================

ALTER TABLE user_roles
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE user_roles
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_roles_tenant_isolation
ON user_roles;

CREATE POLICY user_roles_tenant_isolation
ON user_roles
USING (
    factoryos_current_tenant_id()
        IS NOT NULL

    AND EXISTS (
        SELECT 1
        FROM tenant_memberships tm
        WHERE
            tm.id =
                user_roles.membership_id

            AND tm.tenant_id =
                factoryos_current_tenant_id()
    )

    AND EXISTS (
        SELECT 1
        FROM roles r
        WHERE
            r.id =
                user_roles.role_id

            AND r.tenant_id =
                factoryos_current_tenant_id()
    )

    AND (
        user_roles.factory_id IS NULL

        OR EXISTS (
            SELECT 1
            FROM factories f
            WHERE
                f.id =
                    user_roles.factory_id

                AND f.tenant_id =
                    factoryos_current_tenant_id()
        )
    )
)
WITH CHECK (
    factoryos_current_tenant_id()
        IS NOT NULL

    AND EXISTS (
        SELECT 1
        FROM tenant_memberships tm
        WHERE
            tm.id =
                user_roles.membership_id

            AND tm.tenant_id =
                factoryos_current_tenant_id()
    )

    AND EXISTS (
        SELECT 1
        FROM roles r
        WHERE
            r.id =
                user_roles.role_id

            AND r.tenant_id =
                factoryos_current_tenant_id()
    )

    AND (
        user_roles.factory_id IS NULL

        OR EXISTS (
            SELECT 1
            FROM factories f
            WHERE
                f.id =
                    user_roles.factory_id

                AND f.tenant_id =
                    factoryos_current_tenant_id()
        )
    )
);


-- ============================================================
-- AUDIT EVENTS
-- ============================================================

ALTER TABLE audit_events
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE audit_events
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_events_tenant_isolation
ON audit_events;

CREATE POLICY audit_events_tenant_isolation
ON audit_events
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- ORDERS
-- ============================================================

ALTER TABLE orders
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE orders
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orders_tenant_isolation
ON orders;

CREATE POLICY orders_tenant_isolation
ON orders
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- ORDER LINES
-- ============================================================

ALTER TABLE order_lines
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE order_lines
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_lines_tenant_isolation
ON order_lines;

CREATE POLICY order_lines_tenant_isolation
ON order_lines
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- OUTBOX EVENTS
-- ============================================================

ALTER TABLE outbox_events
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE outbox_events
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbox_events_tenant_isolation
ON outbox_events;

CREATE POLICY outbox_events_tenant_isolation
ON outbox_events
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- INBOX EVENTS
-- ============================================================

ALTER TABLE inbox_events
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE inbox_events
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inbox_events_tenant_isolation
ON inbox_events;

CREATE POLICY inbox_events_tenant_isolation
ON inbox_events
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- ORDER EVENT PROJECTIONS
-- ============================================================

ALTER TABLE order_event_projections
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE order_event_projections
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_event_projections_tenant_isolation
ON order_event_projections;

CREATE POLICY order_event_projections_tenant_isolation
ON order_event_projections
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- ORDER IDEMPOTENCY KEYS
-- ============================================================

ALTER TABLE order_idempotency_keys
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE order_idempotency_keys
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_idempotency_keys_tenant_isolation
ON order_idempotency_keys;

CREATE POLICY order_idempotency_keys_tenant_isolation
ON order_idempotency_keys
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
    '010_postgres_rls_tenant_context'
)
ON CONFLICT (
    version
)
DO NOTHING;

COMMIT;