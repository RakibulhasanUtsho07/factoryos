BEGIN;

ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS chk_outbox_status;

ALTER TABLE outbox_events
  ADD CONSTRAINT chk_outbox_status
  CHECK (
    status IN (
      'PENDING',
      'PROCESSING',
      'PUBLISHED',
      'FAILED',
      'QUARANTINED'
    )
  );

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS quarantined_by VARCHAR(150);

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS quarantine_reason TEXT;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS replay_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS last_replayed_at TIMESTAMPTZ;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS last_replayed_by UUID;

ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS chk_outbox_replay_count;

ALTER TABLE outbox_events
  ADD CONSTRAINT chk_outbox_replay_count
  CHECK (replay_count >= 0);

CREATE INDEX IF NOT EXISTS idx_outbox_events_quarantined
  ON outbox_events (
    tenant_id,
    quarantined_at DESC
  )
  WHERE status = 'QUARANTINED';

CREATE INDEX IF NOT EXISTS idx_outbox_events_quarantined_factory
  ON outbox_events (
    tenant_id,
    factory_id,
    quarantined_at DESC
  )
  WHERE status = 'QUARANTINED';

INSERT INTO permissions (
  code,
  description
)
VALUES
  (
    'outbox.dlq.read',
    'Read quarantined outbox events within the authorized tenant/factory scope'
  ),
  (
    'outbox.dlq.replay',
    'Replay quarantined outbox events within the authorized tenant/factory scope'
  )
ON CONFLICT (code)
DO UPDATE SET
  description = EXCLUDED.description;

INSERT INTO role_permissions (
  role_id,
  permission_id
)
SELECT
  r.id,
  p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'Organization Administrator'
  AND p.code IN (
    'outbox.dlq.read',
    'outbox.dlq.replay'
  )
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (
  version
)
SELECT
  '004_outbox_dlq_replay'
WHERE NOT EXISTS (
  SELECT 1
  FROM schema_migrations
  WHERE version = '004_outbox_dlq_replay'
);

COMMIT;