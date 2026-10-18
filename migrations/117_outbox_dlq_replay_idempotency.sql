BEGIN;
CREATE TABLE IF NOT EXISTS outbox_dlq_replay_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid,
  event_id uuid NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  actor_user_id uuid NOT NULL,
  event_type varchar(150) NOT NULL,
  event_version integer NOT NULL,
  replay_count integer NOT NULL,
  previous_attempts integer NOT NULL,
  correlation_id uuid,
  request_id uuid,
  trace_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_outbox_dlq_replay_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT uq_outbox_dlq_replay_event_count UNIQUE (tenant_id, event_id, replay_count),
  CONSTRAINT fk_outbox_dlq_replay_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_outbox_dlq_replay_event FOREIGN KEY (event_id, tenant_id) REFERENCES outbox_events(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_outbox_dlq_replay_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_outbox_dlq_replay_key CHECK (
    length(btrim(idempotency_key)) BETWEEN 1 AND 200 AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT chk_outbox_dlq_replay_request_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_outbox_dlq_replay_counts CHECK (event_version > 0 AND replay_count > 0 AND previous_attempts >= 0),
  CONSTRAINT chk_outbox_dlq_replay_event_type CHECK (length(btrim(event_type)) BETWEEN 1 AND 150)
);
CREATE INDEX IF NOT EXISTS idx_outbox_dlq_replay_event_created
  ON outbox_dlq_replay_requests(tenant_id, event_id, created_at DESC);
ALTER TABLE outbox_dlq_replay_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_dlq_replay_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbox_dlq_replay_requests_tenant_isolation ON outbox_dlq_replay_requests;
CREATE POLICY outbox_dlq_replay_requests_tenant_isolation ON outbox_dlq_replay_requests
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
INSERT INTO schema_migrations(version) VALUES('117_outbox_dlq_replay_idempotency') ON CONFLICT(version) DO NOTHING;
COMMIT;
