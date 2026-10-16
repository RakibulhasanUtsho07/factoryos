BEGIN;

-- WP02 / Inventory reservation lifecycle.
-- Reserved quantities remain on hand but cannot be issued to another consumer.
ALTER TABLE inventory_stock_balances
  ADD COLUMN IF NOT EXISTS quantity_reserved NUMERIC(18, 4) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_balance_reserved_within_on_hand'
      AND conrelid = 'inventory_stock_balances'::regclass
  ) THEN
    ALTER TABLE inventory_stock_balances
      ADD CONSTRAINT chk_inventory_balance_reserved_within_on_hand
      CHECK (quantity_reserved >= 0 AND quantity_reserved <= quantity_on_hand)
      NOT VALID;
  END IF;
END;
$;

ALTER TABLE inventory_stock_balances
  VALIDATE CONSTRAINT chk_inventory_balance_reserved_within_on_hand;

-- Composite reference target for a consumed stock movement, preserving scope.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_movements_id_scope
  ON inventory_movements (id, tenant_id, factory_id);

CREATE TABLE IF NOT EXISTS inventory_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  quantity NUMERIC(18, 4) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'RESERVED',
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  reference_type VARCHAR(64),
  reference_id UUID,
  notes TEXT,
  transition_idempotency_key VARCHAR(255),
  transition_request_hash VARCHAR(64),
  consumed_movement_id UUID,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_inventory_reservation_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_inventory_reservation_item_scope
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumed_movement
    FOREIGN KEY (consumed_movement_id, tenant_id, factory_id)
    REFERENCES inventory_movements (id, tenant_id, factory_id) ON DELETE RESTRICT,

  CONSTRAINT chk_inventory_reservation_quantity
    CHECK (quantity > 0),
  CONSTRAINT chk_inventory_reservation_status
    CHECK (status IN ('RESERVED', 'RELEASED', 'CONSUMED')),
  CONSTRAINT chk_inventory_reservation_hash
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_inventory_reservation_transition
    CHECK (
      (
        status = 'RESERVED'
        AND transition_idempotency_key IS NULL
        AND transition_request_hash IS NULL
        AND consumed_movement_id IS NULL
      )
      OR
      (
        status = 'RELEASED'
        AND transition_idempotency_key IS NOT NULL
        AND length(btrim(transition_idempotency_key)) > 0
        AND transition_request_hash IS NOT NULL
        AND transition_request_hash ~ '^[a-f0-9]{64}
        AND consumed_movement_id IS NULL
      )
      OR
      (
        status = 'CONSUMED'
        AND length(btrim(transition_idempotency_key)) > 0
        AND transition_request_hash ~ '^[a-f0-9]{64}$'
        AND consumed_movement_id IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_reservation_idempotency
  ON inventory_reservations (tenant_id, factory_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_reservation_transition_idempotency
  ON inventory_reservations (tenant_id, factory_id, transition_idempotency_key)
  WHERE transition_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_reservations_item_status_created
  ON inventory_reservations (tenant_id, factory_id, item_id, status, created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_reservation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory reservations cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'RESERVED'
     OR NEW.status NOT IN ('RELEASED', 'CONSUMED') THEN
    RAISE EXCEPTION 'inventory reservation lifecycle only permits RESERVED to RELEASED or CONSUMED'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW.id, NEW.tenant_id, NEW.factory_id, NEW.item_id, NEW.quantity,
    NEW.idempotency_key, NEW.request_hash, NEW.reference_type, NEW.reference_id,
    NEW.notes, NEW.created_by_user_id, NEW.correlation_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.factory_id, OLD.item_id, OLD.quantity,
    OLD.idempotency_key, OLD.request_hash, OLD.reference_type, OLD.reference_id,
    OLD.notes, OLD.created_by_user_id, OLD.correlation_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'inventory reservation request binding is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF length(btrim(NEW.transition_idempotency_key)) = 0
     OR NEW.transition_request_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'inventory reservation transition requires an idempotency key and request hash'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'CONSUMED' AND NEW.consumed_movement_id IS NULL THEN
    RAISE EXCEPTION 'consumed inventory reservations must reference the issue movement'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'RELEASED' AND NEW.consumed_movement_id IS NOT NULL THEN
    RAISE EXCEPTION 'released inventory reservations cannot reference a consumed movement'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_reservation_lifecycle
  ON inventory_reservations;

CREATE TRIGGER trg_inventory_reservation_lifecycle
BEFORE UPDATE OR DELETE ON inventory_reservations
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_inventory_reservation_lifecycle();

ALTER TABLE inventory_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reservations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_reservations_tenant_isolation
  ON inventory_reservations;

CREATE POLICY inventory_reservations_tenant_isolation
ON inventory_reservations
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE inventory_reservations IS
  'Factory-scoped idempotent inventory reservations. Reservation payload is immutable; only RESERVED -> RELEASED/CONSUMED is permitted.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('058_inventory_reservations', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;

        AND consumed_movement_id IS NULL
      )
      OR
      (
        status = 'CONSUMED'
        AND length(btrim(transition_idempotency_key)) > 0
        AND transition_request_hash ~ '^[a-f0-9]{64}$'
        AND consumed_movement_id IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_reservation_idempotency
  ON inventory_reservations (tenant_id, factory_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_reservation_transition_idempotency
  ON inventory_reservations (tenant_id, factory_id, transition_idempotency_key)
  WHERE transition_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_reservations_item_status_created
  ON inventory_reservations (tenant_id, factory_id, item_id, status, created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_reservation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory reservations cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'RESERVED'
     OR NEW.status NOT IN ('RELEASED', 'CONSUMED') THEN
    RAISE EXCEPTION 'inventory reservation lifecycle only permits RESERVED to RELEASED or CONSUMED'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW.id, NEW.tenant_id, NEW.factory_id, NEW.item_id, NEW.quantity,
    NEW.idempotency_key, NEW.request_hash, NEW.reference_type, NEW.reference_id,
    NEW.notes, NEW.created_by_user_id, NEW.correlation_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.factory_id, OLD.item_id, OLD.quantity,
    OLD.idempotency_key, OLD.request_hash, OLD.reference_type, OLD.reference_id,
    OLD.notes, OLD.created_by_user_id, OLD.correlation_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'inventory reservation request binding is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF length(btrim(NEW.transition_idempotency_key)) = 0
     OR NEW.transition_request_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'inventory reservation transition requires an idempotency key and request hash'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'CONSUMED' AND NEW.consumed_movement_id IS NULL THEN
    RAISE EXCEPTION 'consumed inventory reservations must reference the issue movement'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'RELEASED' AND NEW.consumed_movement_id IS NOT NULL THEN
    RAISE EXCEPTION 'released inventory reservations cannot reference a consumed movement'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_reservation_lifecycle
  ON inventory_reservations;

CREATE TRIGGER trg_inventory_reservation_lifecycle
BEFORE UPDATE OR DELETE ON inventory_reservations
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_inventory_reservation_lifecycle();

ALTER TABLE inventory_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reservations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_reservations_tenant_isolation
  ON inventory_reservations;

CREATE POLICY inventory_reservations_tenant_isolation
ON inventory_reservations
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE inventory_reservations IS
  'Factory-scoped idempotent inventory reservations. Reservation payload is immutable; only RESERVED -> RELEASED/CONSUMED is permitted.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('058_inventory_reservations', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
