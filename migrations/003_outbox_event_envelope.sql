BEGIN;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS correlation_id UUID;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS causation_id UUID;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS actor JSONB;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS source JSONB;

CREATE INDEX IF NOT EXISTS idx_outbox_events_correlation
  ON outbox_events (correlation_id);

INSERT INTO schema_migrations (
  version
)
SELECT
  '003_outbox_event_envelope'
WHERE NOT EXISTS (
  SELECT
    1
  FROM schema_migrations
  WHERE version = '003_outbox_event_envelope'
);

COMMIT;