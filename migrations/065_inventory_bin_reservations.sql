BEGIN;

-- WP02: bind an explicitly selected stock reservation to a physical BIN.
-- Legacy/order reservations may remain unallocated (location_id NULL); their aggregate
-- reservation semantics and idempotency contracts do not change.
ALTER TABLE inventory_location_balances
  ADD COLUMN quantity_reserved NUMERIC(18, 4) NOT NULL DEFAULT 0;

ALTER TABLE inventory_location_balances
  ADD CONSTRAINT chk_inventory_location_balance_reserved
  CHECK (quantity_reserved >= 0 AND quantity_reserved <= quantity_on_hand);

ALTER TABLE inventory_reservations
  ADD COLUMN location_id UUID;

ALTER TABLE inventory_reservations
  ADD CONSTRAINT fk_inventory_reservation_location_scope
  FOREIGN KEY (location_id, tenant_id, factory_id)
  REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT;

CREATE INDEX idx_inventory_reservations_location_active
  ON inventory_reservations (tenant_id, factory_id, item_id, location_id, created_at DESC)
  WHERE status = 'RESERVED' AND location_id IS NOT NULL;

-- The location is part of the immutable request identity, not a mutable reservation attribute.
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
    NEW.id, NEW.tenant_id, NEW.factory_id, NEW.item_id, NEW.location_id, NEW.quantity,
    NEW.idempotency_key, NEW.request_hash, NEW.reference_type, NEW.reference_id,
    NEW.notes, NEW.created_by_user_id, NEW.correlation_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.factory_id, OLD.item_id, OLD.location_id, OLD.quantity,
    OLD.idempotency_key, OLD.request_hash, OLD.reference_type, OLD.reference_id,
    OLD.notes, OLD.created_by_user_id, OLD.correlation_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'inventory reservation request binding is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.transition_idempotency_key IS NULL
     OR length(btrim(NEW.transition_idempotency_key)) = 0
     OR NEW.transition_request_hash IS NULL
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

-- For reservations pinned to a BIN, the per-location reserved amount must equal
-- the sum of active reservations for that BIN. The deferred check observes the
-- final stock + reservation state at transaction commit.
CREATE OR REPLACE FUNCTION factoryos_assert_inventory_location_reservation_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance NUMERIC(18, 4);
  v_active_reservations NUMERIC(18, 4);
BEGIN
  IF NEW.location_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT quantity_reserved
    INTO v_balance
  FROM inventory_location_balances
  WHERE tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
    AND item_id = NEW.item_id
    AND location_id = NEW.location_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'location-bound reservation requires a location balance'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(quantity), 0)
    INTO v_active_reservations
  FROM inventory_reservations
  WHERE tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
    AND item_id = NEW.item_id
    AND location_id = NEW.location_id
    AND status = 'RESERVED';

  IF v_balance IS DISTINCT FROM v_active_reservations THEN
    RAISE EXCEPTION 'inventory location reserved quantity must equal active bin reservations'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_inventory_location_reservation_balance_consistency
  ON inventory_reservations;

CREATE CONSTRAINT TRIGGER ctr_inventory_location_reservation_balance_consistency
AFTER INSERT OR UPDATE ON inventory_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION factoryos_assert_inventory_location_reservation_balance();

-- Legacy issue flows do not specify a bin. They may only drain unreserved local
-- stock, while an explicitly selected bin issue must leave that bin's reserves intact.
CREATE OR REPLACE FUNCTION factoryos_sync_inventory_location_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_delta NUMERIC(18, 4);
  v_default_location_id UUID;
  v_requested_location_id UUID;
  v_remaining NUMERIC(18, 4);
  v_take NUMERIC(18, 4);
  v_balance RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_delta := NEW.quantity_on_hand;
  ELSE
    v_delta := NEW.quantity_on_hand - OLD.quantity_on_hand;
  END IF;

  IF v_delta = 0 THEN
    RETURN NEW;
  END IF;

  SELECT l.id INTO v_default_location_id
  FROM inventory_locations l
  WHERE l.tenant_id = NEW.tenant_id
    AND l.factory_id = NEW.factory_id
    AND l.is_default = TRUE
    AND l.status = 'ACTIVE';

  IF v_default_location_id IS NULL THEN
    RAISE EXCEPTION 'default inventory location is missing for this factory'
      USING ERRCODE = '23514';
  END IF;

  v_requested_location_id := NULLIF(current_setting('app.inventory_location_id', TRUE), '')::UUID;

  IF v_requested_location_id IS NOT NULL THEN
    IF v_delta > 0 THEN
      INSERT INTO inventory_location_balances (
        tenant_id, factory_id, item_id, location_id, quantity_on_hand
      )
      VALUES (
        NEW.tenant_id, NEW.factory_id, NEW.item_id, v_requested_location_id, v_delta
      )
      ON CONFLICT (tenant_id, factory_id, item_id, location_id)
      DO UPDATE SET
        quantity_on_hand = inventory_location_balances.quantity_on_hand + EXCLUDED.quantity_on_hand,
        version = inventory_location_balances.version + 1,
        updated_at = clock_timestamp();
    ELSE
      UPDATE inventory_location_balances
      SET quantity_on_hand = quantity_on_hand + v_delta,
          version = version + 1,
          updated_at = clock_timestamp()
      WHERE tenant_id = NEW.tenant_id
        AND factory_id = NEW.factory_id
        AND item_id = NEW.item_id
        AND location_id = v_requested_location_id
        AND quantity_on_hand + v_delta >= quantity_reserved;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'insufficient unreserved stock at the selected inventory location'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF v_delta > 0 THEN
    INSERT INTO inventory_location_balances (
      tenant_id, factory_id, item_id, location_id, quantity_on_hand
    )
    VALUES (
      NEW.tenant_id, NEW.factory_id, NEW.item_id, v_default_location_id, v_delta
    )
    ON CONFLICT (tenant_id, factory_id, item_id, location_id)
    DO UPDATE SET
      quantity_on_hand = inventory_location_balances.quantity_on_hand + EXCLUDED.quantity_on_hand,
      version = inventory_location_balances.version + 1,
      updated_at = clock_timestamp();
    RETURN NEW;
  END IF;

  -- Aggregate-only issues may drain only stock that is not reserved against a bin.
  v_remaining := -v_delta;
  FOR v_balance IN
    SELECT lb.location_id, (lb.quantity_on_hand - lb.quantity_reserved) AS available_quantity
    FROM inventory_location_balances lb
    JOIN inventory_locations l
      ON l.id = lb.location_id
     AND l.tenant_id = lb.tenant_id
     AND l.factory_id = lb.factory_id
    WHERE lb.tenant_id = NEW.tenant_id
      AND lb.factory_id = NEW.factory_id
      AND lb.item_id = NEW.item_id
      AND lb.quantity_on_hand > lb.quantity_reserved
    ORDER BY l.is_default DESC, lb.location_id
    FOR UPDATE OF lb
  LOOP
    EXIT WHEN v_remaining = 0;
    v_take := LEAST(v_balance.available_quantity, v_remaining);
    IF v_take > 0 THEN
      UPDATE inventory_location_balances
      SET quantity_on_hand = quantity_on_hand - v_take,
          version = version + 1,
          updated_at = clock_timestamp()
      WHERE tenant_id = NEW.tenant_id
        AND factory_id = NEW.factory_id
        AND item_id = NEW.item_id
        AND location_id = v_balance.location_id
        AND quantity_on_hand - quantity_reserved >= v_take;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'location availability changed during aggregate stock adjustment'
          USING ERRCODE = '23514';
      END IF;
      v_remaining := v_remaining - v_take;
    END IF;
  END LOOP;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'unreserved location stock is lower than the aggregate stock adjustment'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON COLUMN inventory_reservations.location_id IS
  'Optional immutable BIN allocation for a stock reservation. NULL means the reservation remains unallocated across locations.';
COMMENT ON COLUMN inventory_location_balances.quantity_reserved IS
  'Quantity explicitly reserved from this location; must equal active reservations pinned to the location.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('065_inventory_bin_reservations', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
