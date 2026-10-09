BEGIN;

-- ------------------------------------------------------------
-- Tenant-safe parent keys
-- ------------------------------------------------------------

ALTER TABLE legal_entities
    ADD CONSTRAINT uq_legal_entities_id_tenant
    UNIQUE (id, tenant_id);

ALTER TABLE factories
    ADD CONSTRAINT uq_factories_id_tenant
    UNIQUE (id, tenant_id);

ALTER TABLE orders
    ADD CONSTRAINT uq_orders_id_tenant
    UNIQUE (id, tenant_id);


-- ------------------------------------------------------------
-- Factory -> Legal Entity
-- ------------------------------------------------------------

ALTER TABLE factories
    ADD CONSTRAINT fk_factories_legal_entity_tenant
    FOREIGN KEY (
        legal_entity_id,
        tenant_id
    )
    REFERENCES legal_entities (
        id,
        tenant_id
    )
    ON DELETE RESTRICT;


-- ------------------------------------------------------------
-- Orders -> Factory
-- ------------------------------------------------------------

ALTER TABLE orders
    ADD CONSTRAINT fk_orders_factory_tenant
    FOREIGN KEY (
        factory_id,
        tenant_id
    )
    REFERENCES factories (
        id,
        tenant_id
    )
    ON DELETE RESTRICT;


-- ------------------------------------------------------------
-- Order Lines -> Orders
-- ------------------------------------------------------------

ALTER TABLE order_lines
    ADD CONSTRAINT fk_order_lines_order_tenant
    FOREIGN KEY (
        order_id,
        tenant_id
    )
    REFERENCES orders (
        id,
        tenant_id
    )
    ON DELETE CASCADE;


-- ------------------------------------------------------------
-- Outbox -> Factory
-- ------------------------------------------------------------

ALTER TABLE outbox_events
    ADD CONSTRAINT fk_outbox_factory_tenant
    FOREIGN KEY (
        factory_id,
        tenant_id
    )
    REFERENCES factories (
        id,
        tenant_id
    )
    ON DELETE RESTRICT;


-- ------------------------------------------------------------
-- Migration tracking
-- ------------------------------------------------------------

INSERT INTO schema_migrations (
    version
)
VALUES (
    '009_tenant_integrity_hardening'
)
ON CONFLICT (version)
DO NOTHING;

COMMIT;