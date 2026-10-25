-- WP02 manufacturing output genealogy completion guard contract.
BEGIN;
DO $$
DECLARE
  v_function TEXT;
  v_enabled BOOLEAN;
  v_deferrable BOOLEAN;
  v_initially_deferred BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '198_production_output_genealogy_completion_guard'
  ) THEN
    RAISE EXCEPTION 'Production output genealogy migration marker is missing';
  END IF;

  v_function := pg_get_functiondef('factoryos_assert_work_order_output_genealogy()'::regprocedure);
  IF position('inventory_reservation_consumption_traceability_allocations' IN v_function) = 0
     OR position('product_genealogy_events' IN v_function) = 0
     OR position('PRODUCTION_SCRAP' IN v_function) = 0
     OR position('traceability_units' IN v_function) = 0 THEN
    RAISE EXCEPTION 'Completed work-order guard must reconcile consumed lot/serial allocations to output and scrap genealogy';
  END IF;

  SELECT t.tgenabled <> 'D', t.tgdeferrable, t.tginitdeferred
    INTO v_enabled, v_deferrable, v_initially_deferred
  FROM pg_trigger t
  WHERE t.tgrelid = 'work_orders'::regclass
    AND t.tgname = 'ctr_work_order_output_genealogy_completion_guard'
    AND NOT t.tgisinternal;

  IF NOT FOUND OR NOT v_enabled OR NOT v_deferrable OR NOT v_initially_deferred THEN
    RAISE EXCEPTION 'Completed work-order output genealogy must be enforced by an enabled deferred commit-time constraint trigger';
  END IF;

  RAISE NOTICE 'WP02 completed work-order output genealogy schema contract passed';
END;
$$;
ROLLBACK;
