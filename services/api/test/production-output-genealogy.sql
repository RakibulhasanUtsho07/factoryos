-- WP02 production output / consumed lot genealogy integration contract.
BEGIN;

DO $$
DECLARE
  v_guard TEXT;
  v_enabled BOOLEAN;
  v_forced BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '198_wp02_production_output_genealogy'
  ) THEN
    RAISE EXCEPTION 'Production output genealogy migration marker is missing';
  END IF;

  SELECT pg_get_functiondef('factoryos_guard_product_genealogy_event()'::regprocedure)
  INTO v_guard;
  IF v_guard IS NULL
     OR position('inventory_material_allocation_policies' IN v_guard) = 0
     OR position('policy_scope = ''MATERIAL''' IN v_guard) = 0
     OR position('policy_scope = ''SECTOR''' IN v_guard) = 0
     OR position('policy_scope = ''FACTORY''' IN v_guard) = 0
     OR position('inventory_traceability_location_balances' IN v_guard) = 0
     OR position('tlb.quantity_on_hand > tlb.quantity_reserved' IN v_guard) = 0
     OR position('quality_holds' IN v_guard) = 0
     OR position('FEFO' IN v_guard) = 0
     OR position('FIFO' IN v_guard) = 0 THEN
    RAISE EXCEPTION 'Genealogy guard must resolve material/sector/factory policy and require eligible unreserved stock for FIFO/FEFO ordering';
  END IF;

  SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO v_enabled, v_forced
  FROM pg_class c
  WHERE c.oid = 'product_genealogy_events'::regclass;
  IF v_enabled IS DISTINCT FROM TRUE OR v_forced IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Product genealogy events must continue to force tenant RLS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'product_genealogy_events'::regclass
      AND t.tgname = 'trg_product_genealogy_guard'
      AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Append-only genealogy guard trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'product_genealogy_events'::regclass
      AND t.tgname = 'ctr_product_genealogy_event_evidence'
      AND NOT t.tgisinternal AND t.tgenabled <> 'D'
      AND t.tgdeferrable AND t.tginitdeferred
  ) THEN
    RAISE EXCEPTION 'Genealogy event must require transactional audit and outbox evidence';
  END IF;

  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'inventory_reservation_consumption_traceability_allocations'
      AND column_name IN ('consumption_id', 'traceability_unit_id', 'location_id', 'quantity')
  ) <> 4 THEN
    RAISE EXCEPTION 'Consumed tracked-material allocations must preserve source identity, location and issued quantity';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.conrelid = 'traceability_units'::regclass
      AND c.confrelid = 'order_production_reports'::regclass
  ) THEN
    RAISE EXCEPTION 'Finished-good identity must be bound to an exact production report';
  END IF;

  RAISE NOTICE 'WP02 production output genealogy, policy resolution, eligible-stock ordering, RLS and audit/outbox contract passed';
END;
$$;

ROLLBACK;
