BEGIN;

-- WP01 tenant-integrity hardening.
-- Composite foreign keys make the tenant relationship part of the database
-- constraint instead of relying only on application WHERE clauses.

ALTER TABLE legal_entities
    ADD CONSTRAINT uq_legal_entities_id_tenant
    UNIQUE (id, tenant_id);

ALTER TABLE factories
    ADD CONSTRAINT uq_factories_id_tenant
    UNIQUE (id, tenant_id);

ALTER TABLE orders
    ADD CONSTRAINT uq_orders_id_tenant
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

-- user_roles currently has no tenant_id column, so its membership/role/factory
-- tenant consistency remains enforced by IAM queries. A later schema revision
-- should add tenant_id to user_roles and make that relationship declarative.

INSERT INTO schema_migrations (version)
VALUES ('009_tenant_integrity_hardening')
ON CONFLICT (version) DO NOTHING;

COMMIT;
