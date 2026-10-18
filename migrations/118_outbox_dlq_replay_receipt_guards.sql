BEGIN;

ALTER TABLE outbox_events
  ADD CONSTRAINT uq_outbox_events_id_tenant_factory UNIQUE (id, tenant_id, factory_id);

ALTER TABLE outbox_dlq_replay_requests
  ADD CONSTRAINT fk_outbox_dlq_replay_event_factory
  FOREIGN KEY (event_id, tenant_id, factory_id)
  REFERENCES outbox_events(id, tenant_id, factory_id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION factoryos_guard_outbox_dlq_replay_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'DLQ replay receipt actor must match the authenticated user'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'DLQ replay receipts are immutable and cannot be changed or deleted'
    USING ERRCODE = '55000';
END $$;

CREATE TRIGGER trg_outbox_dlq_replay_receipt_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON outbox_dlq_replay_requests
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_outbox_dlq_replay_receipt();

INSERT INTO schema_migrations(version)
VALUES('118_outbox_dlq_replay_receipt_guards')
ON CONFLICT(version) DO NOTHING;

COMMIT;
