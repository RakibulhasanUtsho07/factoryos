BEGIN;

ALTER TABLE outbox_events
    ADD COLUMN IF NOT EXISTS locked_at timestamptz;

ALTER TABLE outbox_events
    ADD COLUMN IF NOT EXISTS locked_by varchar(150);

ALTER TABLE outbox_events
    ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_outbox_dispatch_claim
    ON outbox_events (
        status,
        next_attempt_at,
        created_at
    )
    WHERE status IN ('PENDING', 'FAILED');

CREATE INDEX IF NOT EXISTS idx_outbox_processing_lease
    ON outbox_events (
        status,
        next_attempt_at
    )
    WHERE status = 'PROCESSING';

INSERT INTO schema_migrations (version)
VALUES ('005_outbox_dispatcher')
ON CONFLICT (version) DO NOTHING;

COMMIT;