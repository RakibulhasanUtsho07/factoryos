BEGIN;

CREATE TABLE order_event_projections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL,
    event_id UUID NOT NULL,

    order_id UUID NOT NULL,
    factory_id UUID NOT NULL,

    order_number VARCHAR(100) NOT NULL,
    status VARCHAR(30) NOT NULL,

    event_version INTEGER NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT fk_order_event_projections_tenant
        FOREIGN KEY (tenant_id)
        REFERENCES tenants(id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_order_event_projections_event_tenant
        FOREIGN KEY (event_id, tenant_id)
        REFERENCES outbox_events(id, tenant_id)
        ON DELETE RESTRICT,

    CONSTRAINT uq_order_event_projections_event
        UNIQUE (event_id),

    CONSTRAINT chk_order_event_projections_status
        CHECK (
            status IN (
                'DRAFT',
                'CONFIRMED',
                'IN_PROGRESS',
                'COMPLETED',
                'CANCELLED'
            )
        ),

    CONSTRAINT chk_order_event_projections_version
        CHECK (event_version > 0)
);

CREATE INDEX idx_order_event_projections_tenant
    ON order_event_projections(tenant_id);

CREATE INDEX idx_order_event_projections_order
    ON order_event_projections(tenant_id, order_id);

CREATE INDEX idx_order_event_projections_factory
    ON order_event_projections(tenant_id, factory_id);

COMMIT;