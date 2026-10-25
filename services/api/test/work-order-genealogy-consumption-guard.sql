\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_migration_present BOOLEAN;
  v_before_trigger BOOLEAN;
  v_edge_constraint_trigger BOOLEAN;
  v_work_order_constraint_trigger BOOLEAN;
  v_before_function TEXT;
  v_edge_constraint_function TEXT;
  v_work_order_function TEXT;
  v_manifest TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '199_wms_work_order_genealogy_consumption_guard'
  ) INTO v_migration_present;
  IF NOT v_migration_present THEN
    RAISE EXCEPTION 'work-order genealogy consumption guard migration marker is missing';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'product_genealogy_events'::regclass
      AND t.tgname = 'trg_work_order_output_genealogy_evidence'
      AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  ) INTO v_before_trigger;
  IF NOT v_before_trigger THEN
    RAISE EXCEPTION 'work-order output genealogy must have an enabled evidence-binding BEFORE trigger';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'product_genealogy_events'::regclass
      AND t.tgname = 'ctr_work_order_output_genealogy_coverage'
      AND NOT t.tgisinternal AND t.tgenabled <> 'D'
      AND t.tgdeferrable AND t.tginitdeferred
  ) INTO v_edge_constraint_trigger;
  IF NOT v_edge_constraint_trigger THEN
    RAISE EXCEPTION 'genealogy output evidence must be checked at transaction commit';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'work_orders'::regclass
      AND t.tgname = 'ctr_work_order_completed_genealogy'
      AND NOT t.tgisinternal AND t.tgenabled <> 'D'
      AND t.tgdeferrable AND t.tginitdeferred
  ) INTO v_work_order_constraint_trigger;
  IF NOT v_work_order_constraint_trigger THEN
    RAISE EXCEPTION 'work-order completion must defer a check that consumed lot/serial allocations have genealogy coverage';
  END IF;

  SELECT pg_get_functiondef('factoryos_guard_work_order_output_genealogy_evidence()'::regprocedure)
    INTO v_before_function;
  IF position('WORK_ORDER_MATERIAL_CONSUMPTION' IN v_before_function) = 0
     OR position('inventory_reservation_consumption_traceability_allocations' IN v_before_function) = 0
     OR position('work_order_material_reservations' IN v_before_function) = 0
     OR position('production_output_postings' IN v_before_function) = 0
     OR position('consumption_traceability_allocation_id' IN v_before_function) = 0
     OR position('source_inventory_item_id' IN v_before_function) = 0
     OR position('output_quantity_weight' IN v_before_function) = 0
     OR position('v_event_total + NEW.quantity > v_binding.allocated_quantity' IN v_before_function) = 0
  THEN
    RAISE EXCEPTION 'genealogy edge guard must bind real WMS lot/serial consumption, the work order and the target output posting';
  END IF;

  SELECT pg_get_functiondef('factoryos_assert_work_order_output_genealogy_coverage()'::regprocedure)
    INTO v_edge_constraint_function;
  IF position('COMPLETED' IN v_edge_constraint_function) = 0
     OR position('v_event_total IS DISTINCT FROM v_binding.allocated_quantity' IN v_edge_constraint_function) = 0
  THEN
    RAISE EXCEPTION 'genealogy edge commit guard must require a completed work order and exact source allocation conservation';
  END IF;

  SELECT pg_get_functiondef('factoryos_assert_work_order_completed_genealogy()'::regprocedure)
    INTO v_work_order_function;
  IF position('inventory_reservation_consumption_traceability_allocations' IN v_work_order_function) = 0
     OR position('work_order_material_reservations' IN v_work_order_function) = 0
     OR position('ctr_work_order_completed_genealogy' IN v_work_order_function) = 0
     OR position('fully represented in output genealogy' IN v_work_order_function) = 0
  THEN
    RAISE EXCEPTION 'completion guard must reject any work order with consumed lot/serial quantity missing from genealogy';
  END IF;

  SELECT string_agg(line, E'\n' ORDER BY ordinal)
    INTO v_manifest
  FROM (
    SELECT line, row_number() OVER () AS ordinal
    FROM regexp_split_to_table(pg_read_file('scripts/audit/migration-manifest.txt'), E'\n') AS line
  ) manifest_lines;
  IF position('migrations/198_production_output_lot_genealogy.sql' IN v_manifest) = 0
     OR position('migrations/199_wms_work_order_genealogy_consumption_guard.sql' IN v_manifest) = 0
     OR position('migrations/198_production_output_lot_genealogy.sql' IN v_manifest)
        > position('migrations/199_wms_work_order_genealogy_consumption_guard.sql' IN v_manifest)
  THEN
    -- The normal CI runner validates and reads the manifest from its workspace;
    -- a database server may not have the repository mounted, so check only when it is.
    IF to_regprocedure('pg_read_file(text)') IS NOT NULL THEN
      RAISE EXCEPTION 'migration manifest must apply output genealogy before the WMS evidence guard';
    END IF;
  END IF;
END $$;

ROLLBACK;
