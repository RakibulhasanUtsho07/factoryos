\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_function TEXT;
  v_trigger_count INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '200_wms_finished_good_putaway_traceability'
  ) THEN
    RAISE EXCEPTION 'finished-good put-away traceability migration marker is missing';
  END IF;

  SELECT pg_get_functiondef('factoryos_guard_inventory_location_transfer_traceability()'::regprocedure)
    INTO v_function;
  IF v_function NOT ILIKE '%FINISHED_GOOD%'
     OR v_function NOT ILIKE '%traceability_unit_id%'
     OR v_function NOT ILIKE '%inventory_traceability_location_balances%'
     OR v_function NOT ILIKE '%quality_holds%'
     OR v_function NOT ILIKE '%23514%' THEN
    RAISE EXCEPTION 'location-transfer traceability guard is missing its lot/scope/quality fail-closed rules';
  END IF;

  SELECT count(*)::INTEGER INTO v_trigger_count
  FROM pg_trigger
  WHERE tgrelid = 'inventory_location_transfers'::regclass
    AND tgname = 'inventory_location_transfer_traceability_guard'
    AND NOT tgisinternal
    AND tgenabled = 'O';
  IF v_trigger_count <> 1 THEN
    RAISE EXCEPTION 'enabled inventory location transfer traceability guard must be installed exactly once';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'inventory_location_transfers'
      AND column_name = 'traceability_unit_id'
  ) THEN
    RAISE EXCEPTION 'location transfer traceability identity column is missing';
  END IF;
END;
$$;

ROLLBACK;
