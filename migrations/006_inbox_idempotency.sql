BEGIN;

-- Required so inbox_events can enforce both event identity and tenant identity.
ALTER TABLE outbox_events
    ADD CONSTRAINT uq_outbox_events_id_tenant
    UNIQUE (id, tenant_id);

CREATE TABLE inbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL,
    consumer_name VARCHAR(150) NOT NULL,
    event_id UUID NOT NULL,

    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT fk_inbox_events_tenant
        FOREIGN KEY (tenant_id)
        REFERENCES tenants(id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_inbox_events_event_tenant
        FOREIGN KEY (event_id, tenant_id)
        REFERENCES outbox_events(id, tenant_id)
        ON DELETE RESTRICT,

    CONSTRAINT uq_inbox_events_consumer_event
        UNIQUE (consumer_name, event_id)
);

CREATE INDEX idx_inbox_events_tenant
    ON inbox_events(tenant_id);

CREATE INDEX idx_inbox_events_event
    ON inbox_events(event_id);

CREATE INDEX idx_inbox_events_consumer
    ON inbox_events(consumer_name);

COMMIT;