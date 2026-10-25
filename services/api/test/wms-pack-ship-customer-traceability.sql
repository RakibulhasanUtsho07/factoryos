\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_pack_ship_function TEXT;
  v_shipment_function TEXT;
  v_pack_trigger_count INTEGER;
  v_lifecycle_trigger_count INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '201_wms_pack_ship_customer_traceability'
  ) THEN
    RAISE EXCEPTION 'pack/ship customer traceability migration marker is missing';
  END IF;

  SELECT pg_get_functiondef('factoryos_guard_pack_ship_genealogy_event()'::regprocedure)
    INTO v_pack_ship_function;
  IF v_pack_ship_function NOT ILIKE '%PACKED_INTO%'
    OR v_pack_ship_function NOT ILIKE '%FINISHED_GOOD%'
    OR v_pack_ship_function NOT ILIKE '%CARTON%'
    OR v_pack_ship_function NOT ILIKE '%PALLET%'
    OR v_pack_ship_function NOT ILIKE '%SHIPPED_AS%'
    OR v_pack_ship_function NOT ILIKE '%customer_order_reference%'
    OR v_pack_ship_function NOT ILIKE '%only a package with recorded contents%'
    OR v_pack_ship_function NOT ILIKE '%only one shipment%' THEN
    RAISE EXCEPTION 'pack/ship genealogy guard is missing type, content or customer-order restrictions';
  END IF;

  SELECT pg_get_functiondef('factoryos_guard_shipment_customer_lifecycle()'::regprocedure)
    INTO v_shipment_function;
  IF v_shipment_function NOT ILIKE '%customer_reference%'
    OR v_shipment_function NOT ILIKE '%customer_order_reference%'
    OR v_shipment_function NOT ILIKE '%shipment_reference%'
    OR v_shipment_function NOT ILIKE '%SHIPPED%'
    OR v_shipment_function NOT ILIKE '%SHIPPED_AS%' THEN
    RAISE EXCEPTION 'shipment lifecycle guard is missing reference or controlled-dispatch requirements';
  END IF;

  SELECT count(*)::INTEGER INTO v_pack_trigger_count
  FROM pg_trigger
  WHERE tgrelid = 'product_genealogy_events'::regclass
    AND tgname = 'trg_traceability_pack_ship_genealogy_guard'
    AND NOT tgisinternal AND tgenabled = 'O';
  SELECT count(*)::INTEGER INTO v_lifecycle_trigger_count
  FROM pg_trigger
  WHERE tgrelid = 'traceability_units'::regclass
    AND tgname = 'trg_traceability_shipment_lifecycle_guard'
    AND NOT tgisinternal AND tgenabled = 'O';
  IF v_pack_trigger_count <> 1 OR v_lifecycle_trigger_count <> 1 THEN
    RAISE EXCEPTION 'enabled pack/ship and shipment lifecycle guards must each be installed exactly once';
  END IF;
END;
$$;

ROLLBACK;
