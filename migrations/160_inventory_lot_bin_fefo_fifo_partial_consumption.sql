BEGIN;

-- Strict mode is opt-in until the warehouse has identified and reconciled every
-- legacy/untracked stock balance. Any item already carrying live lot stock is
-- nevertheless reserved from eligible lot/bin balances only.
ALTER TABLE traceability_settings
  ADD COLUMN require_lot_tracking BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE inventory_reservations
  ADD COLUMN traceability_unit_id UUID,
  ADD COLUMN quantity_consumed NUMERIC(18, 4) NOT NULL DEFAULT 0,
  ADD CONSTRAINT chk_inventory_reservation_quantity_consumed
    CHECK (quantity_consumed >= 0 AND quantity_consumed <= quantity),
  ADD CONSTRAINT chk_inventory_reservation_lot_requires_location
    CHECK (traceability_unit_id IS NULL OR location_id IS NOT NULL),
  ADD CONSTRAINT fk_inventory_reservation_lot_scope
    FOREIGN KEY (traceability_unit_id, tenant_id, factory_id, item_id)
    REFERENCES traceability_units (id, tenant_id, factory_id, inventory_item_id)
    ON DELETE RESTRICT;

ALTER TABLE inventory_movements
  ADD COLUMN traceability_unit_id UUID,
  ADD CONSTRAINT chk_inventory_movement_lot_requires_location
    CHECK (traceability_unit_id IS NULL OR location_id IS NOT NULL),
  ADD CONSTRAINT fk_inventory_movement_lot_scope
    FOREIGN KEY (traceability_unit_id, tenant_id, factory_id, item_id)
    REFERENCES traceability_units (id, tenant_id, factory_id, inventory_item_id)
    ON DELETE RESTRICT;

ALTER TABLE goods_receipt_lines
  ADD COLUMN traceability_unit_id UUID,
  ADD CONSTRAINT fk_goods_receipt_line_lot_scope
    FOREIGN KEY (traceability_unit_id, tenant_id, factory_id, inventory_item_id)
    REFERENCES traceability_units (id, tenant_id, factory_id, inventory_item_id)
    ON DELETE RESTRICT;

CREATE TABLE inventory_lot_location_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  traceability_unit_id UUID NOT NULL,
  location_id UUID NOT NULL,
  quantity_on_hand NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_reserved NUMERIC(18,4) NOT NULL DEFAULT 0,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_inventory_lot_location_balance_scope
    UNIQUE (tenant_id, factory_id, item_id, traceability_unit_id, location_id),
  CONSTRAINT fk_inventory_lot_balance_item
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_lot_balance_trace_unit
    FOREIGN KEY (traceability_unit_id, tenant_id, factory_id, item_id)
    REFERENCES traceability_units (id, tenant_id, factory_id, inventory_item_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_lot_balance_location
    FOREIGN KEY (location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_lot_balance_quantities
    CHECK (quantity_on_hand >= 0 AND quantity_reserved >= 0 AND quantity_reserved <= quantity_on_hand),
  CONSTRAINT chk_inventory_lot_balance_version CHECK (version > 0)
);

CREATE INDEX idx_inventory_lot_balance_fifo
  ON inventory_lot_location_balances
    (tenant_id, factory_id, item_id, traceability_unit_id, location_id);

CREATE INDEX idx_inventory_lot_balance_available
  ON inventory_lot_location_balances
    (tenant_id, factory_id, item_id, location_id)
  WHERE quantity_on_hand > quantity_reserved;

ALTER TABLE inventory_lot_location_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_lot_location_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_lot_location_balances_tenant_isolation
  ON inventory_lot_location_balances
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE TABLE inventory_reservation_consumptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  item_id UUID NOT NULL,
  traceability_unit_id UUID,
  location_id UUID,
  quantity NUMERIC(18,4) NOT NULL,
  movement_id UUID NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_inventory_reservation_consumption_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_inventory_reservation_consumption_idempotency
    UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_inventory_reservation_consumption_reservation
    FOREIGN KEY (reservation_id, tenant_id, factory_id)
    REFERENCES inventory_reservations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumption_item
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumption_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumption_movement
    FOREIGN KEY (movement_id, tenant_id, factory_id)
    REFERENCES inventory_movements (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumption_lot
    FOREIGN KEY (traceability_unit_id, tenant_id, factory_id, item_id)
    REFERENCES traceability_units (id, tenant_id, factory_id, inventory_item_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumption_location
    FOREIGN KEY (location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_reservation_consumption_quantity CHECK (quantity > 0),
  CONSTRAINT chk_inventory_reservation_consumption_lot_location
    CHECK ((traceability_unit_id IS NULL) OR location_id IS NOT NULL),
  CONSTRAINT chk_inventory_reservation_consumption_hash
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_inventory_reservation_consumption_key
    CHECK (length(btrim(idempotency_key)) > 0)
);

CREATE INDEX idx_inventory_reservation_consumptions_reservation
  ON inventory_reservation_consumptions (tenant_id, factory_id, reservation_id, created_at, id);

-- A single physical bin may legitimately hold multiple separately tracked lots.
-- The uniqueness key is therefore bin + lot identity; NULL is one legacy allocation.
DROP INDEX IF EXISTS uq_inventory_order_line_bin_active;
CREATE UNIQUE INDEX uq_inventory_order_line_bin_lot_active
  ON inventory_reservations (
    tenant_id, factory_id, reference_id, location_id,
    COALESCE(traceability_unit_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE reference_type = 'ORDER_LINE' AND status = 'RESERVED'
    AND reference_id IS NOT NULL AND location_id IS NOT NULL;

ALTER TABLE inventory_location_transfers
  ADD COLUMN traceability_unit_id UUID,
  ADD CONSTRAINT fk_inventory_location_transfer_lot_scope
    FOREIGN KEY (traceability_unit_id, tenant_id, factory_id, item_id)
    REFERENCES traceability_units (id, tenant_id, factory_id, inventory_item_id)
    ON DELETE RESTRICT;

ALTER TABLE inventory_reservation_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reservation_consumptions FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_reservation_consumptions_tenant_isolation
  ON inventory_reservation_consumptions
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

-- Existing consumed reservations predate partial-consumption evidence. Record the
-- already committed issue movement instead of pretending those movements did not occur.
UPDATE inventory_reservations
SET quantity_consumed = quantity
WHERE status = 'CONSUMED';

INSERT INTO inventory_reservation_consumptions (
  tenant_id, factory_id, reservation_id, item_id, traceability_unit_id, location_id,
  quantity, movement_id, idempotency_key, request_hash, created_by_user_id, created_at
)
SELECT
  r.tenant_id, r.factory_id, r.id, r.item_id, r.traceability_unit_id, r.location_id,
  r.quantity, r.consumed_movement_id,
  'legacy-reservation-consumption:' || r.id::text,
  repeat('0', 64),
  r.created_by_user_id,
  COALESCE(r.updated_at, r.created_at)
FROM inventory_reservations r
WHERE r.status = 'CONSUMED'
  AND r.consumed_movement_id IS NOT NULL
ON CONFLICT (tenant_id, factory_id, idempotency_key) DO NOTHING;

-- Enforce immutable reservation identity, but allow an idempotent sequence of
-- partial consumptions while RESERVED. Only the remaining quantity is reserved.
CREATE OR REPLACE FUNCTION factoryos_guard_inventory_reservation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_consumption_delta NUMERIC(18,4);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory reservations cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW.id, NEW.tenant_id, NEW.factory_id, NEW.item_id, NEW.location_id,
    NEW.traceability_unit_id, NEW.quantity, NEW.idempotency_key, NEW.request_hash,
    NEW.reference_type, NEW.reference_id, NEW.notes, NEW.created_by_user_id,
    NEW.correlation_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.factory_id, OLD.item_id, OLD.location_id,
    OLD.traceability_unit_id, OLD.quantity, OLD.idempotency_key, OLD.request_hash,
    OLD.reference_type, OLD.reference_id, OLD.notes, OLD.created_by_user_id,
    OLD.correlation_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'inventory reservation request binding is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.quantity_consumed < OLD.quantity_consumed OR NEW.quantity_consumed > NEW.quantity THEN
    RAISE EXCEPTION 'reservation consumed quantity must be monotonic and cannot exceed the original quantity'
      USING ERRCODE = '23514';
  END IF;

  v_consumption_delta := NEW.quantity_consumed - OLD.quantity_consumed;
  IF v_consumption_delta > 0
     AND NEW.reference_type IN ('ORDER_LINE', 'WORK_ORDER_MATERIAL')
     AND NEW.quantity_consumed < NEW.quantity THEN
    RAISE EXCEPTION 'order and work-order material reservations must be consumed atomically as a complete allocation'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'RESERVED'
     AND NEW.status = 'RESERVED'
     AND v_consumption_delta > 0 THEN
    IF NEW.transition_idempotency_key IS NOT NULL
       OR NEW.transition_request_hash IS NOT NULL
       OR NEW.consumed_movement_id IS NOT NULL THEN
      RAISE EXCEPTION 'partial reservation consumption does not set a terminal transition'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM inventory_reservation_consumptions c
      WHERE c.reservation_id = NEW.id
        AND c.tenant_id = NEW.tenant_id
        AND c.factory_id = NEW.factory_id
        AND c.quantity = v_consumption_delta
    ) THEN
      RAISE EXCEPTION 'partial reservation consumption requires immutable issue evidence'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'RESERVED'
     OR NEW.status NOT IN ('RELEASED', 'CONSUMED') THEN
    RAISE EXCEPTION 'inventory reservation lifecycle only permits RESERVED partial consumption, RELEASED or CONSUMED'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.transition_idempotency_key IS NULL
     OR length(btrim(NEW.transition_idempotency_key)) = 0
     OR NEW.transition_request_hash IS NULL
     OR NEW.transition_request_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'inventory reservation transition requires an idempotency key and request hash'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'CONSUMED' THEN
    IF NEW.quantity_consumed <> NEW.quantity OR NEW.consumed_movement_id IS NULL THEN
      RAISE EXCEPTION 'consumed reservation must have consumed its full quantity and reference the final issue movement'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'RELEASED' AND NEW.consumed_movement_id IS NOT NULL THEN
    RAISE EXCEPTION 'released inventory reservations cannot reference a final consumed movement'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- The aggregate reserve balance always equals the remaining quantity of live reservations.
CREATE OR REPLACE FUNCTION factoryos_assert_inventory_reservation_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance NUMERIC(18,4);
  v_active_reservations NUMERIC(18,4);
BEGIN
  SELECT quantity_reserved INTO v_balance
  FROM inventory_stock_balances
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id AND item_id = NEW.item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory reservation requires an inventory stock balance'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(quantity - quantity_consumed), 0)
    INTO v_active_reservations
  FROM inventory_reservations
  WHERE tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
    AND item_id = NEW.item_id
    AND status = 'RESERVED';

  IF v_balance IS DISTINCT FROM v_active_reservations THEN
    RAISE EXCEPTION 'inventory stock reserved quantity must equal active reservation remaining quantity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

-- Update the existing final-state BIN consistency function to compare remaining
-- reserved quantities instead of original reservation quantities.
CREATE OR REPLACE FUNCTION factoryos_assert_inventory_location_reserved_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id UUID;
  v_factory_id UUID;
  v_item_id UUID;
  v_location_id UUID;
  v_current_reserved NUMERIC(18,4);
  v_active_reservations NUMERIC(18,4);
  v_old_active_reservations NUMERIC(18,4);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant_id := OLD.tenant_id;
    v_factory_id := OLD.factory_id;
    v_item_id := OLD.item_id;
    v_location_id := OLD.location_id;
  ELSE
    v_tenant_id := NEW.tenant_id;
    v_factory_id := NEW.factory_id;
    v_item_id := NEW.item_id;
    v_location_id := NEW.location_id;
  END IF;

  SELECT COALESCE(SUM(r.quantity - r.quantity_consumed), 0)
    INTO v_active_reservations
  FROM inventory_reservations r
  WHERE r.tenant_id = v_tenant_id AND r.factory_id = v_factory_id
    AND r.item_id = v_item_id AND r.location_id = v_location_id
    AND r.status = 'RESERVED';

  IF TG_OP = 'DELETE' THEN
    IF v_active_reservations > 0 THEN
      RAISE EXCEPTION 'cannot delete a location balance with active bin reservations'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND ROW(NEW.tenant_id, NEW.factory_id, NEW.item_id, NEW.location_id)
         IS DISTINCT FROM
         ROW(OLD.tenant_id, OLD.factory_id, OLD.item_id, OLD.location_id) THEN
    SELECT COALESCE(SUM(r.quantity - r.quantity_consumed), 0)
      INTO v_old_active_reservations
    FROM inventory_reservations r
    WHERE r.tenant_id = OLD.tenant_id AND r.factory_id = OLD.factory_id
      AND r.item_id = OLD.item_id AND r.location_id = OLD.location_id
      AND r.status = 'RESERVED';
    IF v_old_active_reservations > 0 THEN
      RAISE EXCEPTION 'cannot rebind a location balance with active bin reservations'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT quantity_reserved INTO v_current_reserved
  FROM inventory_location_balances
  WHERE tenant_id = v_tenant_id AND factory_id = v_factory_id
    AND item_id = v_item_id AND location_id = v_location_id;

  IF NOT FOUND THEN
    IF v_active_reservations > 0 THEN
      RAISE EXCEPTION 'active bin reservations require a persisted location balance'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF v_current_reserved IS DISTINCT FROM v_active_reservations THEN
    RAISE EXCEPTION
      'location reserved quantity (%) must equal active reservation remaining quantity (%)',
      v_current_reserved, v_active_reservations
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- A lot's RESERVED balance is derived from active reservations. Service code may
-- change a reservation, but cannot silently desynchronise the lot's reserved total.
CREATE OR REPLACE FUNCTION factoryos_sync_inventory_lot_reservation_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_remaining NUMERIC(18,4) := 0;
  v_new_remaining NUMERIC(18,4) := 0;
  v_lot UUID;
  v_location UUID;
  v_delta NUMERIC(18,4);
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.traceability_unit_id IS NOT NULL
     AND OLD.status = 'RESERVED' THEN
    v_old_remaining := OLD.quantity - OLD.quantity_consumed;
  END IF;
  IF NEW.traceability_unit_id IS NOT NULL AND NEW.status = 'RESERVED' THEN
    v_new_remaining := NEW.quantity - NEW.quantity_consumed;
  END IF;

  IF TG_OP <> 'INSERT' AND OLD.traceability_unit_id IS NOT NULL THEN
    v_lot := OLD.traceability_unit_id;
    v_location := OLD.location_id;
  END IF;
  IF NEW.traceability_unit_id IS NOT NULL THEN
    v_lot := NEW.traceability_unit_id;
    v_location := NEW.location_id;
  END IF;
  IF v_lot IS NULL THEN
    RETURN NEW;
  END IF;

  v_delta := v_new_remaining - v_old_remaining;
  IF v_delta = 0 THEN
    RETURN NEW;
  END IF;

  UPDATE inventory_lot_location_balances
  SET quantity_reserved = quantity_reserved + v_delta,
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
    AND item_id = NEW.item_id
    AND traceability_unit_id = v_lot
    AND location_id = v_location
    AND quantity_reserved + v_delta >= 0
    AND quantity_reserved + v_delta <= quantity_on_hand;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lot/bin balance cannot cover this reservation change'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_lot_reservation_balance
AFTER INSERT OR UPDATE ON inventory_reservations
FOR EACH ROW EXECUTE FUNCTION factoryos_sync_inventory_lot_reservation_balance();

CREATE OR REPLACE FUNCTION factoryos_validate_inventory_movement_lot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit_type VARCHAR(24);
  v_product_role VARCHAR(20);
  v_status VARCHAR(16);
  v_expires_at DATE;
  v_unit_quantity NUMERIC(18,4);
  v_available NUMERIC(18,4);
  v_reserved_issue NUMERIC(18,4) := 0;
BEGIN
  -- An item-level stock reconciliation has no lot/bin count detail. Do not let
  -- its aggregate receipt/issue mutate the physical total behind live lot balances.
  IF NEW.reference_type = 'STOCK_RECONCILIATION'
     AND (
       EXISTS (
         SELECT 1 FROM inventory_lot_location_balances lb
         WHERE lb.tenant_id = NEW.tenant_id AND lb.factory_id = NEW.factory_id
           AND lb.item_id = NEW.item_id AND lb.quantity_on_hand > 0
       )
       OR EXISTS (
         SELECT 1 FROM traceability_settings ts
         WHERE ts.tenant_id = NEW.tenant_id AND ts.factory_id = NEW.factory_id
           AND ts.require_lot_tracking = TRUE
       )
     ) THEN
    RAISE EXCEPTION 'aggregate stock reconciliation is not permitted for lot-tracked items; a lot/bin count is required'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.traceability_unit_id IS NULL THEN
    -- Once an item has tracked lot balances, an unlabelled issue could drain
    -- stock that is physically held in an identified lot. Fail closed.
    IF NEW.movement_type IN ('ISSUE', 'RECEIPT') AND (
      EXISTS (
        SELECT 1 FROM inventory_lot_location_balances lb
        WHERE lb.tenant_id = NEW.tenant_id AND lb.factory_id = NEW.factory_id
          AND lb.item_id = NEW.item_id AND lb.quantity_on_hand > 0
      )
      OR EXISTS (
        SELECT 1 FROM traceability_settings ts
        WHERE ts.tenant_id = NEW.tenant_id AND ts.factory_id = NEW.factory_id
          AND ts.require_lot_tracking = TRUE
      )
    ) THEN
      RAISE EXCEPTION 'unlabelled stock receipt or issue is not permitted while this item is lot-tracked'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT unit_type, product_role, status, expires_at, quantity
    INTO v_unit_type, v_product_role, v_status, v_expires_at, v_unit_quantity
  FROM traceability_units
  WHERE id = NEW.traceability_unit_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
    AND inventory_item_id = NEW.item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'traceability unit is not bound to this inventory item/factory'
      USING ERRCODE = '23503';
  END IF;
  IF v_unit_type NOT IN ('LOT', 'SERIAL')
     OR v_product_role NOT IN ('MATERIAL', 'FINISHED_GOOD', 'PACKAGING') THEN
    RAISE EXCEPTION 'stock movement trace identity must be a material/finished-good LOT or SERIAL'
      USING ERRCODE = '23514';
  END IF;
  IF v_status <> 'ACTIVE' OR (v_expires_at IS NOT NULL AND v_expires_at < CURRENT_DATE) THEN
    RAISE EXCEPTION 'quarantined, recalled, disposed, shipped or expired lot stock cannot move'
      USING ERRCODE = '23514';
  END IF;
  IF v_unit_type = 'SERIAL' AND NEW.quantity <> 1 THEN
    RAISE EXCEPTION 'serial stock movements must be exactly one unit per serial'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM quality_holds h
    WHERE h.tenant_id = NEW.tenant_id AND h.factory_id = NEW.factory_id
      AND h.status = 'ACTIVE'
      AND (h.inventory_item_id = NEW.item_id OR h.traceability_unit_id = NEW.traceability_unit_id)
  ) THEN
    RAISE EXCEPTION 'quality-held item/lot stock cannot move'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.movement_type = 'ISSUE' THEN
    -- Reservation consumption may draw on the quantity already reserved by this
    -- exact reservation, but only when the service explicitly sets the transaction-
    -- local consumption binding after checking ownership, state and remaining amount.
    IF NEW.reference_type = 'RESERVATION'
       AND NEW.reference_id IS NOT NULL
       AND current_setting('app.inventory_reservation_consumption_id', TRUE) = NEW.reference_id::text THEN
      SELECT quantity - quantity_consumed INTO v_reserved_issue
      FROM inventory_reservations
      WHERE id = NEW.reference_id
        AND tenant_id = NEW.tenant_id
        AND factory_id = NEW.factory_id
        AND item_id = NEW.item_id
        AND traceability_unit_id = NEW.traceability_unit_id
        AND location_id = NEW.location_id
        AND status = 'RESERVED'
      FOR UPDATE;
      IF NOT FOUND OR v_reserved_issue < NEW.quantity THEN
        RAISE EXCEPTION 'reservation does not cover this lot/bin issue'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    SELECT quantity_on_hand - quantity_reserved + v_reserved_issue INTO v_available
    FROM inventory_lot_location_balances
    WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
      AND item_id = NEW.item_id AND traceability_unit_id = NEW.traceability_unit_id
      AND location_id = NEW.location_id
    FOR UPDATE;
    IF NOT FOUND OR v_available < NEW.quantity THEN
      RAISE EXCEPTION 'insufficient available quantity in the selected lot/bin'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_movement_lot_policy_guard
BEFORE INSERT ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION factoryos_validate_inventory_movement_lot();

CREATE OR REPLACE FUNCTION factoryos_apply_inventory_lot_movement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_lot_quantity NUMERIC(18,4);
  v_total_lot_quantity NUMERIC(18,4);
  v_reserved_issue NUMERIC(18,4) := 0;
BEGIN
  IF NEW.traceability_unit_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.movement_type = 'RECEIPT' THEN
    INSERT INTO inventory_lot_location_balances (
      tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand
    ) VALUES (
      NEW.tenant_id, NEW.factory_id, NEW.item_id, NEW.traceability_unit_id, NEW.location_id, NEW.quantity
    )
    ON CONFLICT (tenant_id, factory_id, item_id, traceability_unit_id, location_id)
    DO UPDATE SET quantity_on_hand = inventory_lot_location_balances.quantity_on_hand + EXCLUDED.quantity_on_hand,
                  version = inventory_lot_location_balances.version + 1,
                  updated_at = clock_timestamp();
  ELSE
    IF NEW.reference_type = 'RESERVATION'
       AND NEW.reference_id IS NOT NULL
       AND current_setting('app.inventory_reservation_consumption_id', TRUE) = NEW.reference_id::text THEN
      SELECT quantity - quantity_consumed INTO v_reserved_issue
      FROM inventory_reservations
      WHERE id = NEW.reference_id
        AND tenant_id = NEW.tenant_id
        AND factory_id = NEW.factory_id
        AND item_id = NEW.item_id
        AND traceability_unit_id = NEW.traceability_unit_id
        AND location_id = NEW.location_id
        AND status = 'RESERVED'
      FOR UPDATE;
      IF NOT FOUND OR v_reserved_issue < NEW.quantity THEN
        RAISE EXCEPTION 'reservation does not cover this lot/bin issue'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    UPDATE inventory_lot_location_balances
    SET quantity_on_hand = quantity_on_hand - NEW.quantity,
        version = version + 1,
        updated_at = clock_timestamp()
    WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
      AND item_id = NEW.item_id AND traceability_unit_id = NEW.traceability_unit_id
      AND location_id = NEW.location_id
      AND quantity_on_hand - quantity_reserved + v_reserved_issue >= NEW.quantity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'lot/bin stock changed concurrently; issue rolled back'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT quantity INTO v_lot_quantity
  FROM traceability_units
  WHERE id = NEW.traceability_unit_id AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id AND inventory_item_id = NEW.item_id;

  SELECT COALESCE(SUM(quantity_on_hand), 0) INTO v_total_lot_quantity
  FROM inventory_lot_location_balances
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND item_id = NEW.item_id AND traceability_unit_id = NEW.traceability_unit_id;

  IF v_total_lot_quantity > v_lot_quantity THEN
    RAISE EXCEPTION 'lot-bin stock cannot exceed the registered traceability quantity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_movement_apply_lot_balance
AFTER INSERT ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION factoryos_apply_inventory_lot_movement();

CREATE OR REPLACE FUNCTION factoryos_guard_traceability_unit_reserved_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'ACTIVE'
     AND EXISTS (
       SELECT 1 FROM inventory_reservations r
       WHERE r.tenant_id = OLD.tenant_id AND r.factory_id = OLD.factory_id
         AND r.traceability_unit_id = OLD.id AND r.status = 'RESERVED'
     ) THEN
    RAISE EXCEPTION 'release active reservations before quarantining, recalling or disposing this lot'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER traceability_unit_reserved_stock_guard
BEFORE UPDATE OF status ON traceability_units
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_traceability_unit_reserved_stock();

CREATE OR REPLACE FUNCTION factoryos_assert_inventory_lot_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant UUID;
  v_factory UUID;
  v_item UUID;
  v_lot UUID;
  v_location UUID;
  v_qty NUMERIC(18,4);
  v_reserved NUMERIC(18,4);
  v_expected_reserved NUMERIC(18,4);
  v_item_location_qty NUMERIC(18,4);
BEGIN
  IF TG_TABLE_NAME = 'inventory_reservations' THEN
    v_tenant := NEW.tenant_id;
    v_factory := NEW.factory_id;
    v_item := NEW.item_id;
    v_lot := NEW.traceability_unit_id;
    v_location := NEW.location_id;
  ELSIF TG_OP = 'DELETE' THEN
    v_tenant := OLD.tenant_id;
    v_factory := OLD.factory_id;
    v_item := OLD.item_id;
    v_lot := OLD.traceability_unit_id;
    v_location := OLD.location_id;
  ELSE
    v_tenant := NEW.tenant_id;
    v_factory := NEW.factory_id;
    v_item := NEW.item_id;
    v_lot := NEW.traceability_unit_id;
    v_location := NEW.location_id;
  END IF;
  IF v_lot IS NULL THEN RETURN NULL; END IF;

  SELECT quantity_on_hand, quantity_reserved INTO v_qty, v_reserved
  FROM inventory_lot_location_balances
  WHERE tenant_id = v_tenant AND factory_id = v_factory AND item_id = v_item
    AND traceability_unit_id = v_lot AND location_id = v_location;

  IF NOT FOUND THEN
    SELECT COALESCE(SUM(r.quantity - r.quantity_consumed), 0)
      INTO v_expected_reserved
    FROM inventory_reservations r
    WHERE r.tenant_id = v_tenant AND r.factory_id = v_factory
      AND r.item_id = v_item AND r.traceability_unit_id = v_lot
      AND r.location_id = v_location AND r.status = 'RESERVED';
    IF v_expected_reserved > 0 THEN
      RAISE EXCEPTION 'active lot reservations require a persisted lot/bin balance'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(r.quantity - r.quantity_consumed), 0)
    INTO v_expected_reserved
  FROM inventory_reservations r
  WHERE r.tenant_id = v_tenant AND r.factory_id = v_factory
    AND r.item_id = v_item AND r.traceability_unit_id = v_lot
    AND r.location_id = v_location AND r.status = 'RESERVED';

  IF v_reserved IS DISTINCT FROM v_expected_reserved THEN
    RAISE EXCEPTION 'lot/bin reserved quantity must equal active reservation remaining quantity'
      USING ERRCODE = '23514';
  END IF;

  SELECT lb.quantity_on_hand INTO v_item_location_qty
  FROM inventory_location_balances lb
  WHERE lb.tenant_id = v_tenant AND lb.factory_id = v_factory
    AND lb.item_id = v_item AND lb.location_id = v_location;
  IF NOT FOUND OR v_qty > v_item_location_qty THEN
    RAISE EXCEPTION 'lot/bin on-hand quantity cannot exceed its physical inventory location balance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ctr_inventory_lot_balance_consistency
AFTER INSERT OR UPDATE ON inventory_lot_location_balances
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_inventory_lot_balance();

CREATE CONSTRAINT TRIGGER ctr_inventory_reservation_lot_consistency
AFTER INSERT OR UPDATE ON inventory_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_inventory_lot_balance();

CREATE OR REPLACE FUNCTION factoryos_assert_reservation_consumption_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_total NUMERIC(18,4);
  v_consumed NUMERIC(18,4);
  v_status VARCHAR(20);
BEGIN
  SELECT quantity, quantity_consumed, status
    INTO v_total, v_consumed, v_status
  FROM inventory_reservations
  WHERE id = NEW.reservation_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation consumption is not attached to an inventory reservation'
      USING ERRCODE = '23503';
  END IF;

  SELECT COALESCE(SUM(quantity), 0) INTO v_consumed
  FROM inventory_reservation_consumptions
  WHERE reservation_id = NEW.reservation_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;

  IF v_consumed > v_total THEN
    RAISE EXCEPTION 'reservation consumption evidence exceeds the original reservation quantity'
      USING ERRCODE = '23514';
  END IF;

  IF v_consumed <> (
    SELECT quantity_consumed FROM inventory_reservations
    WHERE id = NEW.reservation_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  ) THEN
    RAISE EXCEPTION 'reservation consumed quantity must equal immutable consumption evidence'
      USING ERRCODE = '23514';
  END IF;

  IF v_status = 'CONSUMED' AND v_consumed <> v_total THEN
    RAISE EXCEPTION 'consumed reservations require complete consumption evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ctr_inventory_reservation_consumption_evidence
AFTER INSERT ON inventory_reservation_consumptions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_reservation_consumption_evidence();

CREATE OR REPLACE FUNCTION factoryos_prevent_reservation_consumption_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'reservation consumption evidence is immutable'
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER inventory_reservation_consumptions_immutable
BEFORE UPDATE OR DELETE ON inventory_reservation_consumptions
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_reservation_consumption_mutation();

COMMENT ON TABLE inventory_lot_location_balances IS
  'Live stock and reservations by traceability LOT/SERIAL and physical location. Stock movements are the only on-hand writer; reservations derive lot reserved quantities.';
COMMENT ON TABLE inventory_reservation_consumptions IS
  'Immutable idempotent partial/full reservation issue evidence. Sum of this ledger must equal inventory_reservations.quantity_consumed.';

CREATE OR REPLACE FUNCTION factoryos_validate_inventory_location_transfer_lot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status VARCHAR(16);
  v_unit_type VARCHAR(24);
  v_expires_at DATE;
  v_unit_quantity NUMERIC(18,4);
  v_available NUMERIC(18,4);
BEGIN
  IF NEW.traceability_unit_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM inventory_lot_location_balances lb
      WHERE lb.tenant_id = NEW.tenant_id AND lb.factory_id = NEW.factory_id
        AND lb.item_id = NEW.item_id AND lb.quantity_on_hand > 0
    ) OR EXISTS (
      SELECT 1 FROM traceability_settings ts
      WHERE ts.tenant_id = NEW.tenant_id AND ts.factory_id = NEW.factory_id
        AND ts.require_lot_tracking = TRUE
    ) THEN
      RAISE EXCEPTION 'lot-tracked items require a lot identity for stock transfer, pick or put-away'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status, unit_type, expires_at, quantity
    INTO v_status, v_unit_type, v_expires_at, v_unit_quantity
  FROM traceability_units
  WHERE id = NEW.traceability_unit_id
    AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND inventory_item_id = NEW.item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer lot must be bound to the selected item and factory'
      USING ERRCODE = '23503';
  END IF;
  IF v_status <> 'ACTIVE' OR v_unit_type NOT IN ('LOT', 'SERIAL')
     OR (v_expires_at IS NOT NULL AND v_expires_at < CURRENT_DATE) THEN
    RAISE EXCEPTION 'quarantined, recalled, disposed, shipped or expired lots cannot be transferred'
      USING ERRCODE = '23514';
  END IF;
  IF v_unit_type = 'SERIAL' AND NEW.quantity <> 1 THEN
    RAISE EXCEPTION 'serial transfer quantity must be exactly one'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM quality_holds h
    WHERE h.tenant_id = NEW.tenant_id AND h.factory_id = NEW.factory_id
      AND h.status = 'ACTIVE'
      AND (h.inventory_item_id = NEW.item_id OR h.traceability_unit_id = NEW.traceability_unit_id)
  ) THEN
    RAISE EXCEPTION 'quality-held stock cannot be transferred, picked or put away'
      USING ERRCODE = '23514';
  END IF;

  SELECT quantity_on_hand - quantity_reserved INTO v_available
  FROM inventory_lot_location_balances
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND item_id = NEW.item_id AND traceability_unit_id = NEW.traceability_unit_id
    AND location_id = NEW.source_location_id
  FOR UPDATE;
  IF NOT FOUND OR v_available < NEW.quantity THEN
    RAISE EXCEPTION 'insufficient available stock in the source lot/bin'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_location_transfer_lot_policy_guard
BEFORE INSERT ON inventory_location_transfers
FOR EACH ROW EXECUTE FUNCTION factoryos_validate_inventory_location_transfer_lot();

CREATE OR REPLACE FUNCTION factoryos_apply_inventory_location_transfer_lot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.traceability_unit_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE inventory_lot_location_balances
  SET quantity_on_hand = quantity_on_hand - NEW.quantity,
      version = version + 1, updated_at = clock_timestamp()
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND item_id = NEW.item_id AND traceability_unit_id = NEW.traceability_unit_id
    AND location_id = NEW.source_location_id
    AND quantity_on_hand - quantity_reserved >= NEW.quantity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source lot/bin availability changed during transfer'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO inventory_lot_location_balances (
    tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand
  ) VALUES (
    NEW.tenant_id, NEW.factory_id, NEW.item_id, NEW.traceability_unit_id,
    NEW.destination_location_id, NEW.quantity
  )
  ON CONFLICT (tenant_id, factory_id, item_id, traceability_unit_id, location_id)
  DO UPDATE SET
    quantity_on_hand = inventory_lot_location_balances.quantity_on_hand + EXCLUDED.quantity_on_hand,
    version = inventory_lot_location_balances.version + 1,
    updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_location_transfer_apply_lot_balance
AFTER INSERT ON inventory_location_transfers
FOR EACH ROW EXECUTE FUNCTION factoryos_apply_inventory_location_transfer_lot();

INSERT INTO schema_migrations (version, checksum)
VALUES ('160_inventory_lot_bin_fefo_fifo_partial_consumption', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
