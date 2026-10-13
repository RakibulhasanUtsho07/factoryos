BEGIN;

-- WP02-B: reservation lifecycle over the immutable inventory movement ledger.
ALTER TABLE inventory_stock_balances
  ADD COLUMN IF NOT EXISTS reserved_quantity NUMERIC(24,6) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_balance_reserved_quantity'
      AND conrelid = 'inventory_stock_balances'::regclass
  ) THEN
    ALTER TABLE inventory_stock_balances
      ADD CONSTRAINT chk_inventory_balance_reserved_quantity
      CHECK (reserved_quantity >= 0 AND reserved_quantity <= on_hand_quantity);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS inventory_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  location_code VARCHAR(80) NOT NULL,
  quantity NUMERIC(24,6) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  reason VARCHAR(300) NOT NULL,
  reference_ref VARCHAR(255),
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT fk_inventory_reservation_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_factory_scope FOREIGN KEY (factory_id, tenant_id) REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_item_scope FOREIGN KEY (item_id, tenant_id, factory_id) REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_reservation_location CHECK (location_code ~ '^[A-Z0-9][A-Z0-9._:-]{0,79}$'),
  CONSTRAINT chk_inventory_reservation_quantity CHECK (quantity > 0 AND quantity <= 1000000000000),
  CONSTRAINT chk_inventory_reservation_status CHECK (status IN ('ACTIVE', 'RELEASED', 'CONSUMED')),
  CONSTRAINT chk_inventory_reservation_reason CHECK (length(btrim(reason)) BETWEEN 8 AND 300),
  CONSTRAINT chk_inventory_reservation_reference CHECK (reference_ref IS NULL OR length(btrim(reference_ref)) BETWEEN 1 AND 255),
  CONSTRAINT chk_inventory_reservation_idempotency CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_inventory_reservation_hash CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_inventory_reservation_version CHECK (version >= 1),
  CONSTRAINT uq_inventory_reservation_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT uq_inventory_reservation_scope_id UNIQUE (id, tenant_id, factory_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_reservations_active
  ON inventory_reservations (tenant_id, factory_id, item_id, location_code, status, created_at DESC);
ALTER TABLE inventory_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_reservations_tenant_isolation ON inventory_reservations;
CREATE POLICY inventory_reservations_tenant_isolation ON inventory_reservations
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS inventory_reservation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  event_type VARCHAR(12) NOT NULL,
  quantity NUMERIC(24,6) NOT NULL,
  on_hand_after NUMERIC(24,6) NOT NULL,
  reserved_quantity_after NUMERIC(24,6) NOT NULL,
  reason VARCHAR(300) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  recorded_by_user_id UUID NOT NULL,
  correlation_id UUID,
  request_id UUID,
  movement_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_inventory_reservation_event_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_event_factory_scope FOREIGN KEY (factory_id, tenant_id) REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_event_reservation_scope FOREIGN KEY (reservation_id, tenant_id, factory_id) REFERENCES inventory_reservations(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_event_actor FOREIGN KEY (recorded_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_event_movement_scope FOREIGN KEY (movement_id, tenant_id, factory_id) REFERENCES inventory_movements(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_reservation_event_type CHECK (event_type IN ('RESERVED', 'RELEASED', 'CONSUMED')),
  CONSTRAINT chk_inventory_reservation_event_quantity CHECK (quantity > 0 AND quantity <= 1000000000000),
  CONSTRAINT chk_inventory_reservation_event_balance CHECK (
    on_hand_after >= 0 AND reserved_quantity_after >= 0 AND reserved_quantity_after <= on_hand_after
  ),
  CONSTRAINT chk_inventory_reservation_event_reason CHECK (length(btrim(reason)) BETWEEN 8 AND 300),
  CONSTRAINT chk_inventory_reservation_event_idempotency CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_inventory_reservation_event_hash CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT uq_inventory_reservation_event_idempotency UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_inventory_reservation_events_history
  ON inventory_reservation_events (tenant_id, factory_id, reservation_id, created_at DESC, id DESC);
ALTER TABLE inventory_reservation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reservation_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_reservation_events_tenant_isolation ON inventory_reservation_events;
CREATE POLICY inventory_reservation_events_tenant_isolation ON inventory_reservation_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION reject_inventory_reservation_event_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Inventory reservation event ledger is append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$;
DROP TRIGGER IF EXISTS trg_inventory_reservation_events_immutable ON inventory_reservation_events;
CREATE TRIGGER trg_inventory_reservation_events_immutable
  BEFORE UPDATE OR DELETE ON inventory_reservation_events
  FOR EACH ROW EXECUTE FUNCTION reject_inventory_reservation_event_mutation();

CREATE OR REPLACE FUNCTION guard_inventory_reservation_transition() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Inventory reservations cannot be deleted';
  END IF;
  IF OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Terminal inventory reservations cannot be changed';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.factory_id, NEW.item_id, NEW.location_code, NEW.quantity,
      NEW.reason, NEW.reference_ref, NEW.idempotency_key, NEW.request_hash,
      NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.factory_id, OLD.item_id, OLD.location_code, OLD.quantity,
      OLD.reason, OLD.reference_ref, OLD.idempotency_key, OLD.request_hash,
      OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Inventory reservation identity and quantity are immutable';
  END IF;
  IF NEW.status NOT IN ('RELEASED', 'CONSUMED') OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Inventory reservation may only transition once from ACTIVE to a terminal state';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_inventory_reservation_transition ON inventory_reservations;
CREATE TRIGGER trg_inventory_reservation_transition
  BEFORE UPDATE OR DELETE ON inventory_reservations
  FOR EACH ROW EXECUTE FUNCTION guard_inventory_reservation_transition();

INSERT INTO schema_migrations(version, checksum) VALUES ('045_inventory_reservations', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
