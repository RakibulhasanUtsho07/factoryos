BEGIN;

CREATE TABLE order_idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL,

    idempotency_key VARCHAR(255) NOT NULL,

    request_hash VARCHAR(64) NOT NULL,

    status VARCHAR(30) NOT NULL DEFAULT 'PROCESSING',

    response_payload JSONB,

    resource_type VARCHAR(100),

    resource_id UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    completed_at TIMESTAMPTZ,

    expires_at TIMESTAMPTZ NOT NULL
        DEFAULT (now() + INTERVAL '24 hours'),

    CONSTRAINT fk_order_idempotency_tenant
        FOREIGN KEY (tenant_id)
        REFERENCES tenants(id)
        ON DELETE RESTRICT,

    CONSTRAINT uq_order_idempotency_tenant_key
        UNIQUE (tenant_id, idempotency_key),

    CONSTRAINT chk_order_idempotency_status
        CHECK (
            status IN (
                'PROCESSING',
                'COMPLETED'
            )
        )
);

CREATE INDEX idx_order_idempotency_tenant
    ON order_idempotency_keys(tenant_id);

CREATE INDEX idx_order_idempotency_expires
    ON order_idempotency_keys(expires_at);

CREATE INDEX idx_order_idempotency_resource
    ON order_idempotency_keys(
        tenant_id,
        resource_type,
        resource_id
    );

COMMIT;