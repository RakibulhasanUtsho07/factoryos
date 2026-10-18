BEGIN;

-- Durable idempotency receipts for commands that transition an existing row.
-- Immutable evidence stores the response produced at commit time, so a retry
-- returns the same result instead of re-applying a transition.
CREATE TABLE workforce_command_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id UUID NOT NULL,
  response_snapshot JSONB NOT NULL,
  recorded_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_workforce_command_receipt_key UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_workforce_command_receipt_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_command_receipt_actor FOREIGN KEY (recorded_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_workforce_command_receipt_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_workforce_command_receipt_type CHECK (
    entity_type IN ('WORKER','SHIFT_ASSIGNMENT','OVERTIME_REQUEST')
  ),
  CONSTRAINT chk_workforce_command_receipt_snapshot CHECK (jsonb_typeof(response_snapshot) = 'object'),
  CONSTRAINT chk_workforce_command_receipt_key CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255)
);
CREATE INDEX idx_workforce_command_receipts_entity
  ON workforce_command_receipts (tenant_id, factory_id, entity_type, entity_id, created_at DESC);

ALTER TABLE workforce_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workforce_command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY workforce_command_receipts_tenant_isolation
  ON workforce_command_receipts
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_workforce_command_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Workforce command idempotency receipts are immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.recorded_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Workforce command receipt actor must match authenticated database context' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_workforce_command_receipt_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON workforce_command_receipts
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_workforce_command_receipt();

INSERT INTO schema_migrations (version, checksum)
VALUES ('104_workforce_command_idempotency', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
