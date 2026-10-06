BEGIN;

-- WP01 tenant-integrity hardening.
-- These composite foreign keys prevent a tenant-scoped child row from
-- referencing a parent row belonging to another tenant.

ALTER TABLE legal_entities
    ADD CONSTRAINT uq_legal_entities_id_tenant
    UNIQUE (id, tenant_id);

ALTER TABLE factories
    ADD CONSTRAINT uq_factories_id_tenant
    UNIQUE (id, tenant_id);

ALTER TABLE tenant_memberships
    ADD CONSTRAINT uq_memberships_id_tenant
    UNIQUE (id, tenant_id);

ALTER TABLE roles
    ADD CONSTRAINT uq_roles_id_tenant
    UNIQUE (id, tenant_id);

ALTER TABLE factories
    ADD CONSTRAINT fk_factories_legal_entity_tenant
    FOREIGN KEY (legal_entity_id, tenant_id)
    REFERENCES legal_entities(id, tenant_id)
    ON DELETE RESTRICT;

ALTER TABLE user_roles
    ADD CONSTRAINT fk_user_roles_membership_role_tenant
    FOREIGN KEY (membership_id, role_id)
    REFERENCES tenant_memberships(id, id)
    ON DELETE CASCADE;

-- The role/membership pair above intentionally cannot be represented as a
-- cross-table tenant constraint in PostgreSQL without duplicating tenant_id
-- on user_roles. Keep the explicit tenant check in IAM until that schema
-- expansion is introduced.

ALTER TABLE orders
    ADD CONSTRAINT uq_orders_id_tenant
    UNIQUE (id, tenant_id);

ALTER TABLE order_lines
    ADD CONSTRAINT fk_order_lines_order_tenant
    FOREIGN KEY (order_id, tenant_id)
    REFERENCES orders(id, tenant_id)
    ON DELETE CASCADE;

ALTER TABLE outbox_events
    ADD CONSTRAINT fk_outbox_factory_tenant
    FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id)
    ON DELETE RESTRICT;

ALTER TABLE inbox_events
    ADD CONSTRAINT fk_inbox_events_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants(id)
    ON DELETE RESTRICT;

INSERT INTO schema_migrations (version)
VALUES ('009_tenant_integrity_hardening')
ON CONFLICT (version) DO NOTHING;

COMMIT;
