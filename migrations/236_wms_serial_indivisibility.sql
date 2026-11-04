BEGIN;

-- A serial is a physical one-piece identity, not a divisible lot quantity.
-- Serialize mutations on the identity row so two concurrent locations/reservations
-- cannot both claim the same serialized unit.
CREATE OR REPLACE FUNCTION factoryos_guard_serial_genealogy_indivisibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_type VARCHAR(24);
  v_target_type VARCHAR(24);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- Match the canonical genealogy guard's graph lock before taking unit locks;
  -- this preserves one lock order for direct SQL and API-originated writes.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || NEW.factory_id::text || ':product-genealogy-graph', 0
  ));

  SELECT unit_type INTO v_source_type
  FROM traceability_units
  WHERE id = NEW.source_unit_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
  FOR UPDATE;

  SELECT unit_type INTO v_target_type
  FROM traceability_units
  WHERE id = NEW.target_unit_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
  FOR UPDATE;

  -- The canonical genealogy guard reports missing/cross-scope endpoints.
  IF v_source_type IS NULL OR v_target_type IS NULL THEN
    RETURN NEW;
  END IF;

  IF (v_source_type = 'SERIAL' OR v_target_type = 'SERIAL')
     AND NEW.quantity <> 1 THEN
    RAISE EXCEPTION 'genealogy edges involving a serial must represent exactly one whole unit'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.relationship_type = 'SPLIT_INTO' AND v_source_type = 'SERIAL' THEN
    RAISE EXCEPTION 'a serial identity cannot be split; split a lot into one-unit serial identities instead'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.relationship_type = 'MERGED_INTO'
     AND (v_source_type = 'SERIAL' OR v_target_type = 'SERIAL') THEN
    RAISE EXCEPTION 'serial identities cannot be collapsed by a merge; preserve serial-level genealogy'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_product_genealogy_serial_indivisibility
  ON product_genealogy_events;
CREATE TRIGGER a_product_genealogy_serial_indivisibility
BEFORE INSERT ON product_genealogy_events
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_serial_genealogy_indivisibility();


CREATE OR REPLACE FUNCTION factoryos_guard_serial_location_balance_indivisibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit_type VARCHAR(24);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT unit_type INTO v_unit_type
  FROM traceability_units
  WHERE id = NEW.traceability_unit_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
    AND inventory_item_id = NEW.item_id
  FOR UPDATE;

  -- The existing location-balance guard reports missing/mismatched identity.
  IF v_unit_type IS DISTINCT FROM 'SERIAL' THEN
    RETURN NEW;
  END IF;

  IF NEW.quantity_on_hand NOT IN (0, 1)
     OR NEW.quantity_reserved NOT IN (0, 1) THEN
    RAISE EXCEPTION 'serial location balances must be zero or one whole unit'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_inventory_traceability_location_balance_serial_guard
  ON inventory_traceability_location_balances;
CREATE TRIGGER a_inventory_traceability_location_balance_serial_guard
BEFORE INSERT OR UPDATE ON inventory_traceability_location_balances
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_serial_location_balance_indivisibility();


CREATE OR REPLACE FUNCTION factoryos_guard_serial_reservation_allocation_indivisibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit_type VARCHAR(24);
  v_other_active_allocation BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT unit_type INTO v_unit_type
  FROM traceability_units
  WHERE id = NEW.traceability_unit_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
    AND inventory_item_id = NEW.item_id
  FOR UPDATE;

  -- The existing allocation guard reports missing/mismatched identity.
  IF v_unit_type IS DISTINCT FROM 'SERIAL' THEN
    RETURN NEW;
  END IF;

  IF NEW.allocated_quantity <> 1
     OR NEW.consumed_quantity NOT IN (0, 1)
     OR NEW.released_quantity NOT IN (0, 1)
     OR NEW.consumed_quantity + NEW.released_quantity NOT IN (0, 1) THEN
    RAISE EXCEPTION 'serial reservations must allocate, consume or release exactly one whole unit'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM inventory_reservation_traceability_allocations a
    WHERE a.tenant_id = NEW.tenant_id
      AND a.factory_id = NEW.factory_id
      AND a.traceability_unit_id = NEW.traceability_unit_id
      AND a.id IS DISTINCT FROM NEW.id
      AND a.allocated_quantity > a.consumed_quantity + a.released_quantity
  ) INTO v_other_active_allocation;

  IF v_other_active_allocation THEN
    RAISE EXCEPTION 'a serial may belong to only one active reservation allocation'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_inventory_reservation_traceability_serial_guard
  ON inventory_reservation_traceability_allocations;
CREATE TRIGGER a_inventory_reservation_traceability_serial_guard
BEFORE INSERT OR UPDATE ON inventory_reservation_traceability_allocations
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_serial_reservation_allocation_indivisibility();


CREATE OR REPLACE FUNCTION factoryos_guard_serial_consumption_allocation_indivisibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit_type VARCHAR(24);
  v_prior_consumption BOOLEAN;
BEGIN
  SELECT unit_type INTO v_unit_type
  FROM traceability_units
  WHERE id = NEW.traceability_unit_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
  FOR UPDATE;

  -- The foreign key reports a missing/cross-scope identity.
  IF v_unit_type IS DISTINCT FROM 'SERIAL' THEN
    RETURN NEW;
  END IF;

  IF NEW.quantity <> 1 THEN
    RAISE EXCEPTION 'serial consumption evidence must account for exactly one whole unit'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM inventory_reservation_consumption_traceability_allocations a
    WHERE a.tenant_id = NEW.tenant_id
      AND a.factory_id = NEW.factory_id
      AND a.traceability_unit_id = NEW.traceability_unit_id
      AND a.id IS DISTINCT FROM NEW.id
  ) INTO v_prior_consumption;

  IF v_prior_consumption THEN
    RAISE EXCEPTION 'a serial may be consumed only once as a whole unit'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_inventory_reservation_consumption_traceability_serial_guard
  ON inventory_reservation_consumption_traceability_allocations;
CREATE TRIGGER a_inventory_reservation_consumption_traceability_serial_guard
BEFORE INSERT ON inventory_reservation_consumption_traceability_allocations
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_serial_consumption_allocation_indivisibility();


CREATE OR REPLACE FUNCTION factoryos_guard_serial_location_transfer_indivisibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit_type VARCHAR(24);
BEGIN
  IF NEW.traceability_unit_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT unit_type INTO v_unit_type
  FROM traceability_units
  WHERE id = NEW.traceability_unit_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
    AND inventory_item_id = NEW.item_id
  FOR UPDATE;

  -- The existing transfer guard reports missing/mismatched identity.
  IF v_unit_type IS DISTINCT FROM 'SERIAL' THEN
    RETURN NEW;
  END IF;

  IF NEW.quantity <> 1 THEN
    RAISE EXCEPTION 'a serial location transfer must move exactly one whole unit'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_inventory_location_transfer_serial_guard
  ON inventory_location_transfers;
CREATE TRIGGER a_inventory_location_transfer_serial_guard
BEFORE INSERT ON inventory_location_transfers
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_serial_location_transfer_indivisibility();


COMMENT ON FUNCTION factoryos_guard_serial_genealogy_indivisibility() IS
  'Serial genealogy remains one-piece: no fractional edges, serial splits, or serial merges; lot-to-serial splits use unit quantity.';
COMMENT ON FUNCTION factoryos_guard_serial_location_balance_indivisibility() IS
  'Serial stock by location is strictly zero or one unit; row locking serializes cross-location balance mutations.';
COMMENT ON FUNCTION factoryos_guard_serial_reservation_allocation_indivisibility() IS
  'A serial has one outstanding reservation allocation at a time and can only be consumed or released as a whole unit.';
COMMENT ON FUNCTION factoryos_guard_serial_consumption_allocation_indivisibility() IS
  'Append-only serial consumption evidence records one complete unit once.';
COMMENT ON FUNCTION factoryos_guard_serial_location_transfer_indivisibility() IS
  'A serial can move between locations only as one complete unit.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('236_wms_serial_indivisibility', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
