BEGIN;

-- Do not silently bless legacy fractional or duplicated serial state. If a live
-- database already contains any such rows, stop the migration and reconcile them
-- with an audited stock-count/ledger correction before installing the guards.
DO $serial_preflight$
DECLARE
  v_bad_count BIGINT;
BEGIN
  SELECT count(*) INTO v_bad_count
  FROM product_genealogy_events e
  JOIN traceability_units s
    ON s.id=e.source_unit_id AND s.tenant_id=e.tenant_id AND s.factory_id=e.factory_id
  JOIN traceability_units t
    ON t.id=e.target_unit_id AND t.tenant_id=e.tenant_id AND t.factory_id=e.factory_id
  WHERE ((s.unit_type='SERIAL' OR t.unit_type='SERIAL') AND e.quantity <> 1)
     OR (e.relationship_type='SPLIT_INTO' AND s.unit_type='SERIAL')
     OR (e.relationship_type='MERGED_INTO' AND (s.unit_type='SERIAL' OR t.unit_type='SERIAL'));
  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'serial indivisibility migration blocked: % legacy genealogy edges require audited reconciliation', v_bad_count;
  END IF;

  SELECT count(*) INTO v_bad_count
  FROM inventory_traceability_location_balances b
  JOIN traceability_units u
    ON u.id=b.traceability_unit_id AND u.tenant_id=b.tenant_id
   AND u.factory_id=b.factory_id AND u.inventory_item_id=b.item_id
  WHERE u.unit_type='SERIAL'
    AND (b.quantity_on_hand NOT IN (0,1) OR b.quantity_reserved NOT IN (0,1));
  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'serial indivisibility migration blocked: % legacy fractional serial location balances require audited reconciliation', v_bad_count;
  END IF;

  SELECT count(*) INTO v_bad_count
  FROM (
    SELECT b.tenant_id, b.factory_id, b.traceability_unit_id
    FROM inventory_traceability_location_balances b
    JOIN traceability_units u
      ON u.id=b.traceability_unit_id AND u.tenant_id=b.tenant_id
     AND u.factory_id=b.factory_id AND u.inventory_item_id=b.item_id
    WHERE u.unit_type='SERIAL'
    GROUP BY b.tenant_id, b.factory_id, b.traceability_unit_id
    HAVING COALESCE(SUM(b.quantity_on_hand), 0) > 1
        OR COALESCE(SUM(b.quantity_reserved), 0) > 1
  ) duplicated_serial_locations;
  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'serial indivisibility migration blocked: % serials exceed one unit across location balances and require audited reconciliation', v_bad_count;
  END IF;

  SELECT count(*) INTO v_bad_count
  FROM inventory_reservation_traceability_allocations a
  JOIN traceability_units u
    ON u.id=a.traceability_unit_id AND u.tenant_id=a.tenant_id
   AND u.factory_id=a.factory_id AND u.inventory_item_id=a.item_id
  WHERE u.unit_type='SERIAL'
    AND (a.allocated_quantity <> 1
      OR a.consumed_quantity NOT IN (0,1)
      OR a.released_quantity NOT IN (0,1)
      OR a.consumed_quantity + a.released_quantity NOT IN (0,1));
  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'serial indivisibility migration blocked: % legacy partial serial reservation allocations require audited reconciliation', v_bad_count;
  END IF;

  SELECT count(*) INTO v_bad_count
  FROM (
    SELECT a.tenant_id, a.factory_id, a.traceability_unit_id
    FROM inventory_reservation_traceability_allocations a
    JOIN traceability_units u
      ON u.id=a.traceability_unit_id AND u.tenant_id=a.tenant_id
     AND u.factory_id=a.factory_id AND u.inventory_item_id=a.item_id
    WHERE u.unit_type='SERIAL'
      AND a.allocated_quantity > a.consumed_quantity + a.released_quantity
    GROUP BY a.tenant_id, a.factory_id, a.traceability_unit_id
    HAVING count(*) > 1
  ) active_serial_allocations;
  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'serial indivisibility migration blocked: % serials have multiple active reservation allocations', v_bad_count;
  END IF;

  SELECT count(*) INTO v_bad_count
  FROM inventory_reservation_consumption_traceability_allocations a
  JOIN traceability_units u
    ON u.id=a.traceability_unit_id AND u.tenant_id=a.tenant_id
   AND u.factory_id=a.factory_id
  WHERE u.unit_type='SERIAL' AND a.quantity <> 1;
  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'serial indivisibility migration blocked: % legacy fractional serial consumption rows require audited reconciliation', v_bad_count;
  END IF;

  SELECT count(*) INTO v_bad_count
  FROM (
    SELECT a.tenant_id, a.factory_id, a.traceability_unit_id
    FROM inventory_reservation_consumption_traceability_allocations a
    JOIN traceability_units u
      ON u.id=a.traceability_unit_id AND u.tenant_id=a.tenant_id
     AND u.factory_id=a.factory_id
    WHERE u.unit_type='SERIAL'
    GROUP BY a.tenant_id, a.factory_id, a.traceability_unit_id
    HAVING count(*) > 1
  ) serial_consumptions;
  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'serial indivisibility migration blocked: % serials have duplicate consumption evidence', v_bad_count;
  END IF;

  SELECT count(*) INTO v_bad_count
  FROM inventory_location_transfers x
  JOIN traceability_units u
    ON u.id=x.traceability_unit_id AND u.tenant_id=x.tenant_id
   AND u.factory_id=x.factory_id AND u.inventory_item_id=x.item_id
  WHERE u.unit_type='SERIAL' AND x.quantity <> 1;
  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'serial indivisibility migration blocked: % legacy fractional serial transfers require audited reconciliation', v_bad_count;
  END IF;
END;
$serial_preflight$;

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
AS $
DECLARE
  v_unit_type VARCHAR(24);
  v_other_location_quantity NUMERIC(18,4);
  v_other_location_reserved NUMERIC(18,4);
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

  SELECT COALESCE(SUM(b.quantity_on_hand), 0),
         COALESCE(SUM(b.quantity_reserved), 0)
    INTO v_other_location_quantity, v_other_location_reserved
  FROM inventory_traceability_location_balances b
  WHERE b.tenant_id = NEW.tenant_id
    AND b.factory_id = NEW.factory_id
    AND b.item_id = NEW.item_id
    AND b.traceability_unit_id = NEW.traceability_unit_id
    AND b.id IS DISTINCT FROM NEW.id;

  IF v_other_location_quantity + NEW.quantity_on_hand > 1
     OR v_other_location_reserved + NEW.quantity_reserved > 1 THEN
    RAISE EXCEPTION 'a serial identity cannot exist in more than one on-hand or reserved unit across locations'
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
  v_prior_consumption BOOLEAN;
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

  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
      FROM inventory_reservation_traceability_allocations a
      WHERE a.tenant_id = NEW.tenant_id
        AND a.factory_id = NEW.factory_id
        AND a.traceability_unit_id = NEW.traceability_unit_id
        AND a.consumed_quantity > 0
    ) OR EXISTS (
      SELECT 1
      FROM inventory_reservation_consumption_traceability_allocations a
      WHERE a.tenant_id = NEW.tenant_id
        AND a.factory_id = NEW.factory_id
        AND a.traceability_unit_id = NEW.traceability_unit_id
    ) INTO v_prior_consumption;

    IF v_prior_consumption THEN
      RAISE EXCEPTION 'a consumed serial identity cannot be reserved again'
        USING ERRCODE = '23514';
    END IF;
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
