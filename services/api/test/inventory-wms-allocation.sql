-- WMS FEFO/FIFO, lot/serial allocation and partial issue schema contract.
BEGIN;

DO $$
DECLARE
  v_table TEXT;
  v_column_count INTEGER;
  v_function_definition TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '160_wms_fefo_lot_serial_partial_issue'
  ) THEN
    RAISE EXCEPTION 'WMS FEFO/lot/serial allocation migration marker is missing';
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'inventory_material_allocation_policies',
    'inventory_reservation_consumptions',
    'inventory_traceability_location_balances',
    'inventory_reservation_traceability_allocations',
    'inventory_reservation_consumption_traceability_allocations'
  ] LOOP
    IF to_regclass(v_table) IS NULL THEN
      RAISE EXCEPTION 'WMS allocation contract table % is missing', v_table;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_column_count
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'inventory_reservations'
    AND column_name IN ('remaining_quantity', 'consumed_quantity', 'released_quantity');
  IF v_column_count <> 3 THEN
    RAISE EXCEPTION 'Reservations must persist remaining, consumed and released quantity';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'inventory_location_transfers'
      AND column_name = 'traceability_unit_id'
  ) THEN
    RAISE EXCEPTION 'Directed put-away/picking must preserve the selected lot/serial identity';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'inventory_items' AND column_name = 'sector_code'
  ) THEN
    RAISE EXCEPTION 'Inventory items must persist the sector used for allocation-policy resolution';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'uq_inventory_reservation_traceability_sequence'
  ) THEN
    RAISE EXCEPTION 'Lot/serial allocation policy order must survive partial issue retries';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'uq_inventory_material_allocation_policy_sector'
  ) THEN
    RAISE EXCEPTION 'Sector allocation policies must be unique within tenant/factory';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_function_definition
  FROM pg_proc p
  WHERE p.proname = 'factoryos_guard_inventory_reservation_lifecycle'
  LIMIT 1;
  IF v_function_definition IS NULL
    OR position('remaining_quantity' IN v_function_definition) = 0
    OR position('consumed_quantity' IN v_function_definition) = 0
    OR position('released_quantity' IN v_function_definition) = 0 THEN
    RAISE EXCEPTION 'Reservation lifecycle must enforce monotonic partial issue and quantity conservation';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_function_definition
  FROM pg_proc p
  WHERE p.proname = 'factoryos_guard_inventory_reservation_traceability_allocation'
  LIMIT 1;
  IF v_function_definition IS NULL
    OR position('expires_at' IN v_function_definition) = 0
    OR position('quality_holds' IN v_function_definition) = 0
    OR position('QUARANTINED' IN v_function_definition) = 0
    OR position('DAMAGED' IN v_function_definition) = 0 THEN
    RAISE EXCEPTION 'Lot/serial allocation must exclude expired, quarantined, damaged and quality-held stock';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'inventory_reservation_consumptions'
      AND t.tgname = 'inventory_reservation_consumption_append_only'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Partial issue evidence must be append-only';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'inventory_traceability_location_balances'
      AND t.tgname = 'ctr_inventory_traceability_location_capacity'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Lot/serial stock must remain within physical bin capacity';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'inventory_location_transfers'
      AND t.tgname = 'inventory_location_transfer_traceability_guard'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Directed stock transfer must enforce material identity policy';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_function_definition
  FROM pg_proc p
  WHERE p.proname = 'factoryos_guard_inventory_location_transfer_traceability'
  LIMIT 1;
  IF v_function_definition IS NULL
    OR position('inventory_material_allocation_policies' IN v_function_definition) = 0
    OR position('require_traceability' IN v_function_definition) = 0
    OR position('traceability_unit_id IS NULL' IN v_function_definition) = 0 THEN
    RAISE EXCEPTION 'Directed transfer must resolve material/sector policy and reject unlabelled tracked stock';
  END IF;
END;
$$;

ROLLBACK;
