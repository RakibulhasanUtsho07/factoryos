BEGIN;

-- Lot/serial sub-ledger. Aggregate and bin balances remain the physical stock
-- source of truth; this layer attributes that stock to GRN-backed identities.
CREATE TABLE inventory_lot_stock_balances (
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
  CONSTRAINT uq_inventory_lot_balance_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_inventory_lot_balance_identity_location
    UNIQUE (tenant_id, factory_id, item_id, traceability_unit_id, location_id),
  CONSTRAINT fk_inventory_lot_balance_item
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_lot_balance_unit_item
    FOREIGN KEY (traceability_unit_id, tenant_id, factory_id, item_id)
    REFERENCES traceability_units(id, tenant_id, factory_id, inventory_item_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_lot_balance_location
    FOREIGN KEY (location_id, tenant_id, factory_id)
    REFERENCES inventory_locations(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_lot_balance_nonnegative
    CHECK (quantity_on_hand >= 0 AND quantity_reserved >= 0 AND quantity_reserved <= quantity_on_hand),
  CONSTRAINT chk_inventory_lot_balance_version CHECK (version > 0)
);

CREATE INDEX idx_inventory_lot_balance_pick
  ON inventory_lot_stock_balances (tenant_id, factory_id, item_id, location_id, traceability_unit_id)
  WHERE quantity_on_hand > 0;

CREATE TABLE inventory_reservation_lot_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  traceability_unit_id UUID NOT NULL,
  location_id UUID NOT NULL,
  allocation_sequence INTEGER NOT NULL,
  quantity_allocated NUMERIC(18,4) NOT NULL,
  quantity_remaining NUMERIC(18,4) NOT NULL,
  quantity_consumed NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_released NUMERIC(18,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_inventory_reservation_lot_allocation_id_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_inventory_reservation_lot_allocation_sequence
    UNIQUE (reservation_id, allocation_sequence),
  CONSTRAINT uq_inventory_reservation_lot_allocation_binding
    UNIQUE (reservation_id, tenant_id, factory_id, item_id, traceability_unit_id, location_id),
  CONSTRAINT fk_inventory_reservation_lot_allocation_reservation
    FOREIGN KEY (reservation_id, tenant_id, factory_id)
    REFERENCES inventory_reservations(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_lot_allocation_item
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_lot_allocation_balance
    FOREIGN KEY (tenant_id, factory_id, item_id, traceability_unit_id, location_id)
    REFERENCES inventory_lot_stock_balances(tenant_id, factory_id, item_id, traceability_unit_id, location_id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_reservation_lot_allocation_sequence CHECK (allocation_sequence > 0),
  CONSTRAINT chk_inventory_reservation_lot_allocation_quantity
    CHECK (quantity_allocated > 0 AND quantity_remaining >= 0
      AND quantity_consumed >= 0 AND quantity_released >= 0
      AND quantity_allocated = quantity_remaining + quantity_consumed + quantity_released)
);

CREATE INDEX idx_inventory_reservation_lot_allocation_active
  ON inventory_reservation_lot_allocations
    (tenant_id, factory_id, reservation_id, allocation_sequence);

ALTER TABLE inventory_reservations
  ADD COLUMN quantity_remaining NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN quantity_consumed NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN quantity_released NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN lot_policy_enforced BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing reservations are historical facts. Backfill new counters without
-- invoking the prior terminal-state immutability trigger.
ALTER TABLE inventory_reservations DISABLE TRIGGER USER;
UPDATE inventory_reservations
SET quantity_remaining = CASE WHEN status = 'RESERVED' THEN quantity ELSE 0 END,
    quantity_consumed = CASE WHEN status = 'CONSUMED' THEN quantity ELSE 0 END,
    quantity_released = CASE WHEN status = 'RELEASED' THEN quantity ELSE 0 END;
ALTER TABLE inventory_reservations ENABLE TRIGGER USER;

ALTER TABLE inventory_reservations
  ADD CONSTRAINT chk_inventory_reservation_quantity_conservation
    CHECK (quantity = quantity_remaining + quantity_consumed + quantity_released),
  ADD CONSTRAINT chk_inventory_reservation_quantity_status
    CHECK (
      (status = 'RESERVED' AND quantity_remaining > 0
        AND transition_idempotency_key IS NULL
        AND transition_request_hash IS NULL
        AND consumed_movement_id IS NULL)
      OR (status = 'CONSUMED' AND quantity_remaining = 0
        AND quantity_consumed = quantity AND quantity_released = 0
        AND transition_idempotency_key IS NOT NULL
        AND transition_request_hash IS NOT NULL AND consumed_movement_id IS NOT NULL)
      OR (status = 'RELEASED' AND quantity_remaining = 0
        AND quantity_consumed + quantity_released = quantity AND quantity_released > 0
        AND transition_idempotency_key IS NOT NULL
        AND transition_request_hash IS NOT NULL AND consumed_movement_id IS NULL)
    );

CREATE TABLE inventory_reservation_consumptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  movement_id UUID NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_inventory_reservation_consumption_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_inventory_reservation_consumption_idempotency
    UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_inventory_reservation_consumption_reservation
    FOREIGN KEY (reservation_id, tenant_id, factory_id)
    REFERENCES inventory_reservations(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumption_item
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumption_movement
    FOREIGN KEY (movement_id, tenant_id, factory_id)
    REFERENCES inventory_movements(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumption_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_reservation_consumption_quantity CHECK (quantity > 0),
  CONSTRAINT chk_inventory_reservation_consumption_key CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_inventory_reservation_consumption_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE inventory_reservation_consumption_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  consumption_id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  traceability_unit_id UUID NOT NULL,
  location_id UUID NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_inventory_reservation_consumption_lot_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_inventory_reservation_consumption_lot_binding
    UNIQUE (consumption_id, traceability_unit_id, location_id),
  CONSTRAINT fk_inventory_reservation_consumption_lot_consumption
    FOREIGN KEY (consumption_id, tenant_id, factory_id)
    REFERENCES inventory_reservation_consumptions(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumption_lot_allocation
    FOREIGN KEY (reservation_id, tenant_id, factory_id, item_id, traceability_unit_id, location_id)
    REFERENCES inventory_reservation_lot_allocations
      (reservation_id, tenant_id, factory_id, item_id, traceability_unit_id, location_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumption_lot_unit
    FOREIGN KEY (traceability_unit_id, tenant_id, factory_id, item_id)
    REFERENCES traceability_units(id, tenant_id, factory_id, inventory_item_id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_reservation_consumption_lot_quantity CHECK (quantity > 0)
);

CREATE INDEX idx_inventory_reservation_consumption_lots_reservation
  ON inventory_reservation_consumption_lots (tenant_id, factory_id, reservation_id, created_at);

ALTER TABLE inventory_location_transfers
  ADD COLUMN traceability_unit_id UUID,
  ADD CONSTRAINT fk_inventory_location_transfer_lot
    FOREIGN KEY (traceability_unit_id, tenant_id, factory_id, item_id)
    REFERENCES traceability_units(id, tenant_id, factory_id, inventory_item_id) ON DELETE RESTRICT;

-- New reservations are initialized with their full remaining quantity. Once a
-- material/packaging lot exists, every new reservation for that item must name
-- one physical location and be allocated through the lot sub-ledger.
CREATE OR REPLACE FUNCTION factoryos_prepare_inventory_reservation_lot_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.quantity_remaining := NEW.quantity;
    NEW.quantity_consumed := 0;
    NEW.quantity_released := 0;
    NEW.lot_policy_enforced := EXISTS (
      SELECT 1 FROM traceability_units u
      WHERE u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id
        AND u.inventory_item_id = NEW.item_id
        AND u.product_role IN ('MATERIAL', 'PACKAGING')
    );

    IF NEW.lot_policy_enforced THEN
      IF NEW.location_id IS NULL THEN
        RAISE EXCEPTION 'lot-tracked inventory must be reserved against an explicit physical BIN'
          USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM inventory_locations l
        WHERE l.id = NEW.location_id AND l.tenant_id = NEW.tenant_id AND l.factory_id = NEW.factory_id
          AND l.location_type = 'BIN' AND l.status = 'ACTIVE' AND l.picking_enabled
      ) THEN
        RAISE EXCEPTION 'lot-tracked reservations require an active picking BIN'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_reservation_lot_policy
BEFORE INSERT ON inventory_reservations
FOR EACH ROW EXECUTE FUNCTION factoryos_prepare_inventory_reservation_lot_policy();

-- Ensure traceable quantity is claimed only from unreserved physical stock at
-- its receipt location. A GRN line and item locks serialize concurrent lot intake.
CREATE OR REPLACE FUNCTION factoryos_seed_inventory_lot_stock_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_location_id UUID;
  v_on_hand NUMERIC(18,4);
  v_reserved NUMERIC(18,4);
  v_tracked NUMERIC(18,4);
BEGIN
  IF NEW.inventory_item_id IS NULL OR NEW.product_role NOT IN ('MATERIAL', 'PACKAGING')
     OR NEW.goods_receipt_line_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT gr.location_id INTO v_location_id
  FROM goods_receipt_lines gl
  JOIN goods_receipts gr
    ON gr.id = gl.goods_receipt_id AND gr.tenant_id = gl.tenant_id AND gr.factory_id = gl.factory_id
  WHERE gl.id = NEW.goods_receipt_line_id
    AND gl.tenant_id = NEW.tenant_id AND gl.factory_id = NEW.factory_id
    AND gr.status = 'POSTED';

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'lot stock requires a posted GRN with a physical receipt location'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM inventory_items
  WHERE id = NEW.inventory_item_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  FOR UPDATE;

  SELECT quantity_on_hand, quantity_reserved
    INTO v_on_hand, v_reserved
  FROM inventory_location_balances
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND item_id = NEW.inventory_item_id AND location_id = v_location_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lot stock requires a matching physical location balance'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(quantity_on_hand), 0)
    INTO v_tracked
  FROM inventory_lot_stock_balances
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND item_id = NEW.inventory_item_id AND location_id = v_location_id;

  IF v_on_hand - v_reserved - v_tracked < NEW.quantity THEN
    RAISE EXCEPTION 'accepted GRN quantity is already reserved or assigned to other tracked lots at this location'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO inventory_lot_stock_balances (
    tenant_id, factory_id, item_id, traceability_unit_id, location_id,
    quantity_on_hand, quantity_reserved
  ) VALUES (
    NEW.tenant_id, NEW.factory_id, NEW.inventory_item_id, NEW.id, v_location_id,
    NEW.quantity, 0
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_lot_stock_seed
AFTER INSERT ON traceability_units
FOR EACH ROW EXECUTE FUNCTION factoryos_seed_inventory_lot_stock_balance();

-- Reservation request payload remains immutable. RESERVED->RESERVED is now
-- permitted only for an audited, idempotent partial consumption record.
CREATE OR REPLACE FUNCTION factoryos_guard_inventory_reservation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_consumed_delta NUMERIC(18,4);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory reservations cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW.id, NEW.tenant_id, NEW.factory_id, NEW.item_id, NEW.location_id, NEW.quantity,
    NEW.idempotency_key, NEW.request_hash, NEW.reference_type, NEW.reference_id,
    NEW.notes, NEW.created_by_user_id, NEW.correlation_id, NEW.created_at, NEW.lot_policy_enforced
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.factory_id, OLD.item_id, OLD.location_id, OLD.quantity,
    OLD.idempotency_key, OLD.request_hash, OLD.reference_type, OLD.reference_id,
    OLD.notes, OLD.created_by_user_id, OLD.correlation_id, OLD.created_at, OLD.lot_policy_enforced
  ) THEN
    RAISE EXCEPTION 'inventory reservation request binding is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'RESERVED' AND OLD.status = 'RESERVED' THEN
    v_consumed_delta := OLD.quantity_remaining - NEW.quantity_remaining;
    IF v_consumed_delta <= 0
       OR NEW.quantity_consumed - OLD.quantity_consumed <> v_consumed_delta
       OR NEW.quantity_released <> OLD.quantity_released
       OR NEW.transition_idempotency_key IS NOT NULL
       OR NEW.transition_request_hash IS NOT NULL
       OR NEW.consumed_movement_id IS NOT NULL THEN
      RAISE EXCEPTION 'partial reservation consumption must reduce remaining and increase consumed quantity equally'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM inventory_reservation_consumptions c
      WHERE c.reservation_id = OLD.id AND c.tenant_id = OLD.tenant_id AND c.factory_id = OLD.factory_id
        AND c.quantity = v_consumed_delta
    ) THEN
      RAISE EXCEPTION 'partial reservation consumption requires an immutable idempotent consumption receipt'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'RESERVED' OR NEW.status NOT IN ('RELEASED', 'CONSUMED') THEN
    RAISE EXCEPTION 'inventory reservation lifecycle permits only active consumption or RESERVED to RELEASED/CONSUMED'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.transition_idempotency_key IS NULL
     OR length(btrim(NEW.transition_idempotency_key)) = 0
     OR NEW.transition_request_hash IS NULL
     OR NEW.transition_request_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'inventory reservation transition requires an idempotency key and request hash'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'CONSUMED' AND (
    NEW.quantity_remaining <> 0 OR NEW.quantity_consumed <> NEW.quantity
    OR NEW.quantity_released <> 0 OR NEW.consumed_movement_id IS NULL
  ) THEN
    RAISE EXCEPTION 'consumed reservation must account for the full reserved quantity and issue movement'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'RELEASED' AND (
    NEW.quantity_remaining <> 0 OR NEW.quantity_consumed + NEW.quantity_released <> NEW.quantity
    OR NEW.quantity_released <= 0 OR NEW.consumed_movement_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'released reservation must account for all remaining stock and cannot claim a final issue movement'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

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

  SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_active_reservations
  FROM inventory_reservations
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND item_id = NEW.item_id AND status = 'RESERVED';

  IF v_balance IS DISTINCT FROM v_active_reservations THEN
    RAISE EXCEPTION 'inventory stock reserved quantity must equal active reservation remaining quantity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_assert_inventory_location_reservation_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $
DECLARE
  v_balance NUMERIC(18,4);
  v_active_reservations NUMERIC(18,4);
BEGIN
  IF NEW.location_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT quantity_reserved INTO v_balance
  FROM inventory_location_balances
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND item_id = NEW.item_id AND location_id = NEW.location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'location-bound reservation requires a location balance'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_active_reservations
  FROM inventory_reservations
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND item_id = NEW.item_id AND location_id = NEW.location_id AND status = 'RESERVED';
  IF v_balance IS DISTINCT FROM v_active_reservations THEN
    RAISE EXCEPTION 'inventory location reserved quantity must equal active bin reservation remaining quantity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$;

CREATE OR REPLACE FUNCTION factoryos_assert_inventory_location_reserved_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $
DECLARE
  v_tenant_id UUID;
  v_factory_id UUID;
  v_item_id UUID;
  v_location_id UUID;
  v_current_reserved NUMERIC(18,4);
  v_active_reservations NUMERIC(18,4);
  v_lot_on_hand NUMERIC(18,4);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant_id := OLD.tenant_id; v_factory_id := OLD.factory_id;
    v_item_id := OLD.item_id; v_location_id := OLD.location_id;
  ELSE
    v_tenant_id := NEW.tenant_id; v_factory_id := NEW.factory_id;
    v_item_id := NEW.item_id; v_location_id := NEW.location_id;
  END IF;

  SELECT COALESCE(SUM(r.quantity_remaining), 0) INTO v_active_reservations
  FROM inventory_reservations r
  WHERE r.tenant_id = v_tenant_id AND r.factory_id = v_factory_id
    AND r.item_id = v_item_id AND r.location_id = v_location_id AND r.status = 'RESERVED';

  SELECT COALESCE(SUM(lb.quantity_on_hand), 0) INTO v_lot_on_hand
  FROM inventory_lot_stock_balances lb
  WHERE lb.tenant_id = v_tenant_id AND lb.factory_id = v_factory_id
    AND lb.item_id = v_item_id AND lb.location_id = v_location_id;

  IF TG_OP = 'DELETE' THEN
    IF v_active_reservations > 0 OR v_lot_on_hand > 0 THEN
      RAISE EXCEPTION 'cannot delete a location balance with active reservations or tracked lot stock'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  SELECT quantity_reserved INTO v_current_reserved
  FROM inventory_location_balances
  WHERE tenant_id = v_tenant_id AND factory_id = v_factory_id
    AND item_id = v_item_id AND location_id = v_location_id;

  IF FOUND AND (
    v_current_reserved IS DISTINCT FROM v_active_reservations
    OR v_lot_on_hand > (SELECT quantity_on_hand FROM inventory_location_balances
      WHERE tenant_id = v_tenant_id AND factory_id = v_factory_id AND item_id = v_item_id AND location_id = v_location_id)
  ) THEN
    RAISE EXCEPTION 'location reserved balance must match active reservations and tracked lots must fit physical stock'
      USING ERRCODE = '23514';
  END IF;
  IF NOT FOUND AND (v_active_reservations > 0 OR v_lot_on_hand > 0) THEN
    RAISE EXCEPTION 'tracked lot stock or reservations require a physical location balance'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_assert_inventory_lot_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id UUID;
  v_factory_id UUID;
  v_item_id UUID;
  v_unit_id UUID;
  v_location_id UUID;
  v_unit_quantity NUMERIC(18,4);
  v_lot_reserved NUMERIC(18,4);
  v_allocation_reserved NUMERIC(18,4);
  v_total_on_hand NUMERIC(18,4);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant_id := OLD.tenant_id; v_factory_id := OLD.factory_id;
    v_item_id := OLD.item_id; v_unit_id := OLD.traceability_unit_id; v_location_id := OLD.location_id;
  ELSE
    v_tenant_id := NEW.tenant_id; v_factory_id := NEW.factory_id;
    v_item_id := NEW.item_id; v_unit_id := NEW.traceability_unit_id; v_location_id := NEW.location_id;
  END IF;

  SELECT COALESCE(SUM(a.quantity_remaining), 0) INTO v_allocation_reserved
  FROM inventory_reservation_lot_allocations a
  WHERE a.tenant_id = v_tenant_id AND a.factory_id = v_factory_id
    AND a.item_id = v_item_id AND a.traceability_unit_id = v_unit_id
    AND a.location_id = v_location_id;
  IF TG_OP <> 'DELETE' AND NEW.quantity_reserved IS DISTINCT FROM v_allocation_reserved THEN
    RAISE EXCEPTION 'lot reserved balance must equal outstanding reservation lot allocations'
      USING ERRCODE = '23514';
  END IF;

  SELECT quantity INTO v_unit_quantity
  FROM traceability_units
  WHERE id = v_unit_id AND tenant_id = v_tenant_id AND factory_id = v_factory_id
    AND inventory_item_id = v_item_id;
  SELECT COALESCE(SUM(quantity_on_hand), 0) INTO v_total_on_hand
  FROM inventory_lot_stock_balances
  WHERE tenant_id = v_tenant_id AND factory_id = v_factory_id
    AND item_id = v_item_id AND traceability_unit_id = v_unit_id;
  IF v_unit_quantity IS NULL OR v_total_on_hand > v_unit_quantity THEN
    RAISE EXCEPTION 'lot on-hand quantity cannot exceed its immutable traceability identity quantity'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.quantity_on_hand > 0 OR OLD.quantity_reserved > 0 THEN
      RAISE EXCEPTION 'a non-empty or reserved lot balance cannot be deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ctr_inventory_reservation_balance_consistency
AFTER INSERT OR UPDATE ON inventory_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_inventory_reservation_balance();

CREATE OR REPLACE FUNCTION factoryos_assert_inventory_location_reservation_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $
DECLARE
  v_balance NUMERIC(18,4);
  v_active_reservations NUMERIC(18,4);
BEGIN
  IF NEW.location_id IS NULL THEN RETURN NULL; END IF;
  SELECT quantity_reserved INTO v_balance
  FROM inventory_location_balances
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND item_id = NEW.item_id AND location_id = NEW.location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'location-bound reservation requires a location balance'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_active_reservations
  FROM inventory_reservations
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND item_id = NEW.item_id AND location_id = NEW.location_id AND status = 'RESERVED';
  IF v_balance IS DISTINCT FROM v_active_reservations THEN
    RAISE EXCEPTION 'inventory location reserved quantity must equal active bin reservation remaining quantity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$;

CREATE CONSTRAINT TRIGGER ctr_inventory_location_balance_final_state
AFTER INSERT OR UPDATE OR DELETE ON inventory_location_balances
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_inventory_location_reserved_balance();

CREATE CONSTRAINT TRIGGER ctr_inventory_lot_balance_final_state
AFTER INSERT OR UPDATE OR DELETE ON inventory_lot_stock_balances
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_inventory_lot_balance();

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_reservation_lot_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status VARCHAR(16);
  v_expires DATE;
  v_product_role VARCHAR(20);
  v_unit_status VARCHAR(16);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reservation lot allocations are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status, expires_at, product_role INTO v_unit_status, v_expires, v_product_role
    FROM traceability_units
    WHERE id = NEW.traceability_unit_id AND tenant_id = NEW.tenant_id
      AND factory_id = NEW.factory_id AND inventory_item_id = NEW.item_id
    FOR UPDATE;
    IF NOT FOUND OR v_unit_status <> 'ACTIVE' OR v_product_role NOT IN ('MATERIAL','PACKAGING')
       OR (v_expires IS NOT NULL AND v_expires < CURRENT_DATE) THEN
      RAISE EXCEPTION 'reservation lot must be active, unexpired, material/packaging stock'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM quality_holds h
      WHERE h.tenant_id = NEW.tenant_id AND h.factory_id = NEW.factory_id
        AND h.status = 'ACTIVE'
        AND (h.traceability_unit_id = NEW.traceability_unit_id OR h.inventory_item_id = NEW.item_id)
    ) THEN
      RAISE EXCEPTION 'quality-held lot or item cannot be reserved'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM inventory_reservations r
      WHERE r.id = NEW.reservation_id AND r.tenant_id = NEW.tenant_id
        AND r.factory_id = NEW.factory_id AND r.item_id = NEW.item_id
        AND r.location_id = NEW.location_id AND r.status = 'RESERVED'
        AND r.lot_policy_enforced
    ) THEN
      RAISE EXCEPTION 'lot allocation must match an active lot-tracked reservation and physical location'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.item_id, NEW.reservation_id,
      NEW.traceability_unit_id, NEW.location_id, NEW.allocation_sequence, NEW.quantity_allocated, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.item_id, OLD.reservation_id,
      OLD.traceability_unit_id, OLD.location_id, OLD.allocation_sequence, OLD.quantity_allocated, OLD.created_at)
  THEN
    RAISE EXCEPTION 'lot allocation identity and initial quantity are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.quantity_remaining > OLD.quantity_remaining
     OR NEW.quantity_consumed < OLD.quantity_consumed
     OR NEW.quantity_released < OLD.quantity_released
     OR NEW.quantity_remaining - OLD.quantity_remaining
       <> -((NEW.quantity_consumed - OLD.quantity_consumed) + (NEW.quantity_released - OLD.quantity_released)) THEN
    RAISE EXCEPTION 'lot allocation transitions may only consume or release its remaining quantity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_reservation_lot_allocation_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory_reservation_lot_allocations
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_reservation_lot_allocation();

CREATE OR REPLACE FUNCTION factoryos_assert_inventory_reservation_lot_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_reservation inventory_reservations%ROWTYPE;
  v_allocated NUMERIC(18,4);
  v_remaining NUMERIC(18,4);
  v_consumed NUMERIC(18,4);
  v_released NUMERIC(18,4);
BEGIN
  SELECT * INTO v_reservation FROM inventory_reservations
  WHERE id = NEW.reservation_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation lot allocation parent is missing'
      USING ERRCODE = '23503';
  END IF;
  SELECT COALESCE(SUM(quantity_allocated), 0), COALESCE(SUM(quantity_remaining), 0),
         COALESCE(SUM(quantity_consumed), 0), COALESCE(SUM(quantity_released), 0)
  INTO v_allocated, v_remaining, v_consumed, v_released
  FROM inventory_reservation_lot_allocations
  WHERE reservation_id = NEW.reservation_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;

  IF NOT v_reservation.lot_policy_enforced THEN
    IF v_allocated <> 0 OR v_remaining <> 0 OR v_consumed <> 0 OR v_released <> 0 THEN
      RAISE EXCEPTION 'non-lot-tracked reservations cannot carry lot allocations'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF v_allocated IS DISTINCT FROM v_reservation.quantity
     OR v_remaining IS DISTINCT FROM v_reservation.quantity_remaining
     OR v_consumed IS DISTINCT FROM v_reservation.quantity_consumed
     OR v_released IS DISTINCT FROM v_reservation.quantity_released THEN
    RAISE EXCEPTION 'lot allocations must reconcile with reservation requested, remaining, consumed and released quantities'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ctr_inventory_reservation_lot_allocation_consistency
AFTER INSERT OR UPDATE ON inventory_reservation_lot_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_inventory_reservation_lot_allocation();

CREATE CONSTRAINT TRIGGER ctr_inventory_reservation_lot_policy_consistency
AFTER INSERT OR UPDATE ON inventory_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION factoryos_assert_inventory_reservation_lot_allocation();

CREATE OR REPLACE FUNCTION factoryos_seed_inventory_lot_stock_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_location_id UUID;
  v_on_hand NUMERIC(18,4);
  v_reserved NUMERIC(18,4);
  v_tracked NUMERIC(18,4);
BEGIN
  IF NEW.inventory_item_id IS NULL OR NEW.product_role NOT IN ('MATERIAL', 'PACKAGING')
     OR NEW.goods_receipt_line_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT gr.location_id INTO v_location_id
  FROM goods_receipt_lines gl
  JOIN goods_receipts gr
    ON gr.id = gl.goods_receipt_id AND gr.tenant_id = gl.tenant_id AND gr.factory_id = gl.factory_id
  WHERE gl.id = NEW.goods_receipt_line_id
    AND gl.tenant_id = NEW.tenant_id AND gl.factory_id = NEW.factory_id
    AND gr.status = 'POSTED';

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'lot stock requires a posted GRN with a physical receipt location'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM inventory_items
  WHERE id = NEW.inventory_item_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  FOR UPDATE;

  SELECT quantity_on_hand, quantity_reserved
    INTO v_on_hand, v_reserved
  FROM inventory_location_balances
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND item_id = NEW.inventory_item_id AND location_id = v_location_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lot stock requires a matching physical location balance'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(quantity_on_hand), 0)
    INTO v_tracked
  FROM inventory_lot_stock_balances
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND item_id = NEW.inventory_item_id AND location_id = v_location_id;

  IF v_on_hand - v_reserved - v_tracked < NEW.quantity THEN
    RAISE EXCEPTION 'accepted GRN quantity is already reserved or assigned to other tracked lots at this location'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO inventory_lot_stock_balances (
    tenant_id, factory_id, item_id, traceability_unit_id, location_id,
    quantity_on_hand, quantity_reserved
  ) VALUES (
    NEW.tenant_id, NEW.factory_id, NEW.inventory_item_id, NEW.id, v_location_id,
    NEW.quantity, 0
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_lot_stock_seed ON traceability_units;
CREATE TRIGGER trg_inventory_lot_stock_seed
AFTER INSERT ON traceability_units
FOR EACH ROW EXECUTE FUNCTION factoryos_seed_inventory_lot_stock_balance();

-- Picking and put-away must name the tracked lot when the source bin contains it;
-- otherwise a location transfer could silently orphan the lot sub-ledger.
CREATE OR REPLACE FUNCTION factoryos_guard_inventory_location_transfer_lot_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit_status VARCHAR(16);
  v_expires DATE;
  v_source_lot_balance NUMERIC(18,4);
  v_source_lot_reserved NUMERIC(18,4);
BEGIN
  SELECT COALESCE(SUM(quantity_on_hand), 0) INTO v_source_lot_balance
  FROM inventory_lot_stock_balances
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND item_id = NEW.item_id AND location_id = NEW.source_location_id;

  IF NEW.traceability_unit_id IS NULL THEN
    IF v_source_lot_balance > 0 THEN
      RAISE EXCEPTION 'lot-tracked stock transfers must specify traceability_unit_id'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status, expires_at INTO v_unit_status, v_expires
  FROM traceability_units
  WHERE id = NEW.traceability_unit_id AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id AND inventory_item_id = NEW.item_id
    AND product_role IN ('MATERIAL','PACKAGING')
  FOR UPDATE;
  IF NOT FOUND OR v_unit_status <> 'ACTIVE'
     OR (v_expires IS NOT NULL AND v_expires < CURRENT_DATE) THEN
    RAISE EXCEPTION 'put-away/picking cannot transfer an expired or unavailable lot'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM quality_holds h
    WHERE h.tenant_id = NEW.tenant_id AND h.factory_id = NEW.factory_id AND h.status = 'ACTIVE'
      AND (h.traceability_unit_id = NEW.traceability_unit_id OR h.inventory_item_id = NEW.item_id)
  ) THEN
    RAISE EXCEPTION 'quality-held stock cannot be transferred for picking or put-away'
      USING ERRCODE = '23514';
  END IF;

  SELECT quantity_on_hand, quantity_reserved
    INTO v_source_lot_balance, v_source_lot_reserved
  FROM inventory_lot_stock_balances
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND item_id = NEW.item_id AND traceability_unit_id = NEW.traceability_unit_id
    AND location_id = NEW.source_location_id
  FOR UPDATE;

  IF NOT FOUND OR v_source_lot_balance - v_source_lot_reserved < NEW.quantity THEN
    RAISE EXCEPTION 'transfer quantity exceeds unreserved quantity in the selected lot and source bin'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_location_transfer_lot_binding
BEFORE INSERT ON inventory_location_transfers
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_location_transfer_lot_binding();

-- Any quality hold blocks new picks at reservation time and blocks consumption
-- through the lot allocation guard. Quarantine/expiry changes cannot strand active
-- reservations silently: release them through the normal reservation lifecycle first.
CREATE OR REPLACE FUNCTION factoryos_guard_traceability_lot_inventory_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'ACTIVE')
     OR (NEW.expires_at IS DISTINCT FROM OLD.expires_at AND NEW.expires_at < CURRENT_DATE) THEN
    IF EXISTS (
      SELECT 1 FROM inventory_lot_stock_balances lb
      WHERE lb.traceability_unit_id = OLD.id AND lb.tenant_id = OLD.tenant_id
        AND lb.factory_id = OLD.factory_id AND lb.quantity_reserved > 0
    ) THEN
      RAISE EXCEPTION 'release active reservations before quarantining, recalling or expiring a lot'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_traceability_lot_inventory_status
BEFORE UPDATE OF status, expires_at ON traceability_units
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_traceability_lot_inventory_status();

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_reservation_consumption()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'reservation consumption receipts are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM inventory_reservations r
    WHERE r.id = NEW.reservation_id AND r.tenant_id = NEW.tenant_id
      AND r.factory_id = NEW.factory_id AND r.item_id = NEW.item_id
  ) THEN
    RAISE EXCEPTION 'reservation consumption receipt must match its parent reservation'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_reservation_consumption_immutable
BEFORE UPDATE OR DELETE ON inventory_reservation_consumptions
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_reservation_consumption();

CREATE OR REPLACE FUNCTION factoryos_assert_inventory_reservation_consumption_lots()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_quantity NUMERIC(18,4);
  v_enforced BOOLEAN;
  v_lot_quantity NUMERIC(18,4);
  v_consumption_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'inventory_reservation_consumptions' THEN
    v_consumption_id := NEW.id;
  ELSE
    v_consumption_id := NEW.consumption_id;
  END IF;

  SELECT c.quantity, r.lot_policy_enforced INTO v_quantity, v_enforced
  FROM inventory_reservation_consumptions c
  JOIN inventory_reservations r
    ON r.id = c.reservation_id AND r.tenant_id = c.tenant_id AND r.factory_id = c.factory_id
  WHERE c.id = v_consumption_id AND c.tenant_id = NEW.tenant_id AND c.factory_id = NEW.factory_id;

  IF v_quantity IS NULL THEN
    RAISE EXCEPTION 'reservation consumption lot allocation references a missing receipt'
      USING ERRCODE = '23503';
  END IF;

  SELECT COALESCE(SUM(quantity), 0) INTO v_lot_quantity
  FROM inventory_reservation_consumption_lots
  WHERE consumption_id = v_consumption_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;

  IF v_enforced AND v_lot_quantity IS DISTINCT FROM v_quantity THEN
    RAISE EXCEPTION 'lot-tracked consumption must account for the complete consumed quantity by lot'
      USING ERRCODE = '23514';
  END IF;
  IF NOT v_enforced AND v_lot_quantity <> 0 THEN
    RAISE EXCEPTION 'untracked reservation consumption cannot claim lot quantities'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_reject_inventory_consumption_lot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'reservation consumption lot records are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_inventory_reservation_consumption_lot_immutable
BEFORE UPDATE OR DELETE ON inventory_reservation_consumption_lots
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_inventory_consumption_lot_mutation();

CREATE CONSTRAINT TRIGGER ctr_inventory_reservation_consumption_lot_total
AFTER INSERT ON inventory_reservation_consumption_lots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_inventory_reservation_consumption_lots();

-- Extend prior deferred checks to the new rows so a reservation/lot pair must
-- reconcile exactly at COMMIT, never midway through a transaction.
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
  v_lot_on_hand NUMERIC(18,4);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant_id := OLD.tenant_id; v_factory_id := OLD.factory_id;
    v_item_id := OLD.item_id; v_location_id := OLD.location_id;
  ELSE
    v_tenant_id := NEW.tenant_id; v_factory_id := NEW.factory_id;
    v_item_id := NEW.item_id; v_location_id := NEW.location_id;
  END IF;

  SELECT COALESCE(SUM(r.quantity_remaining), 0) INTO v_active_reservations
  FROM inventory_reservations r
  WHERE r.tenant_id = v_tenant_id AND r.factory_id = v_factory_id
    AND r.item_id = v_item_id AND r.location_id = v_location_id AND r.status = 'RESERVED';
  SELECT COALESCE(SUM(lb.quantity_on_hand), 0) INTO v_lot_on_hand
  FROM inventory_lot_stock_balances lb
  WHERE lb.tenant_id = v_tenant_id AND lb.factory_id = v_factory_id
    AND lb.item_id = v_item_id AND lb.location_id = v_location_id;

  IF TG_OP = 'DELETE' THEN
    IF v_active_reservations > 0 OR v_lot_on_hand > 0 THEN
      RAISE EXCEPTION 'cannot delete a location balance with active reservations or tracked lot stock'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  SELECT quantity_reserved INTO v_current_reserved
  FROM inventory_location_balances
  WHERE tenant_id = v_tenant_id AND factory_id = v_factory_id
    AND item_id = v_item_id AND location_id = v_location_id;

  IF NOT FOUND AND (v_active_reservations > 0 OR v_lot_on_hand > 0) THEN
    RAISE EXCEPTION 'tracked lot stock or reservations require a physical location balance'
      USING ERRCODE = '23514';
  END IF;
  IF FOUND AND (
    v_current_reserved IS DISTINCT FROM v_active_reservations
    OR v_lot_on_hand > (SELECT quantity_on_hand FROM inventory_location_balances
      WHERE tenant_id = v_tenant_id AND factory_id = v_factory_id AND item_id = v_item_id AND location_id = v_location_id)
  ) THEN
    RAISE EXCEPTION 'location reserved balance must match active reservations and tracked lots must fit physical stock'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ctr_inventory_reservation_consumption_record_lots
AFTER INSERT ON inventory_reservation_consumptions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION factoryos_assert_inventory_reservation_consumption_lots();

-- Enable tenant RLS on all new reservation/lot evidence.
ALTER TABLE inventory_lot_stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_lot_stock_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_lot_stock_balances_tenant_isolation ON inventory_lot_stock_balances
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE inventory_reservation_lot_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reservation_lot_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_reservation_lot_allocations_tenant_isolation ON inventory_reservation_lot_allocations
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE inventory_reservation_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reservation_consumptions FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_reservation_consumptions_tenant_isolation ON inventory_reservation_consumptions
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE inventory_reservation_consumption_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reservation_consumption_lots FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_reservation_consumption_lots_tenant_isolation ON inventory_reservation_consumption_lots
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version, checksum)
VALUES ('160_inventory_lot_aware_reservations', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
