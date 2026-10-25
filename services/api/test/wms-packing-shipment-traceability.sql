DO $$
DECLARE
  v_function TEXT;
BEGIN
  IF to_regclass('public.wms_packing_containers') IS NULL
     OR to_regclass('public.wms_packing_contents') IS NULL
     OR to_regclass('public.wms_shipments') IS NULL THEN
    RAISE EXCEPTION 'WMS packing/shipment tables are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.wms_packing_containers'::regclass AND relrowsecurity AND relforcerowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.wms_packing_contents'::regclass AND relrowsecurity AND relforcerowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.wms_shipments'::regclass AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'WMS packing/shipment tables must force tenant row-level security';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.wms_packing_containers'::regclass AND tgname='trg_wms_packing_container_guard' AND tgenabled='O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.wms_packing_contents'::regclass AND tgname='trg_wms_packing_content_guard' AND tgenabled='O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.wms_shipments'::regclass AND tgname='trg_wms_shipment_dispatch_guard' AND tgenabled='O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.wms_shipments'::regclass AND tgname='ctr_wms_shipment_dispatch_evidence' AND tgenabled='O') THEN
    RAISE EXCEPTION 'WMS packing/shipment database guards are missing or disabled';
  END IF;
  v_function := pg_get_functiondef('public.factoryos_guard_wms_packing_content()'::regprocedure);
  IF position('PACKED_INTO' IN v_function) = 0 OR position('capacity' IN lower(v_function)) = 0
     OR position('quality_holds' IN v_function) = 0 THEN
    RAISE EXCEPTION 'Packing guard must bind genealogy, capacity and quality eligibility';
  END IF;
  v_function := pg_get_functiondef('public.factoryos_guard_wms_shipment_insert()'::regprocedure);
  IF position('SHIPPED_AS' IN v_function) = 0 OR position('inventory_movements' IN v_function) = 0
     OR position('finished-good lot genealogy leaves' IN v_function) = 0 THEN
    RAISE EXCEPTION 'Shipment guard must bind dispatch stock movement and exact lot genealogy quantity';
  END IF;

  v_function := pg_get_functiondef('public.factoryos_guard_wms_packing_container()'::regprocedure);
  IF position('source_container_unit_id' IN v_function) = 0
     OR position('own or parent shipment evidence' IN v_function) = 0 THEN
    RAISE EXCEPTION 'Packing container lifecycle must bind nested cartons to parent shipment evidence';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='201_wms_carton_pallet_shipment_traceability') THEN
    RAISE EXCEPTION 'WMS packing/shipment migration marker is missing';
  END IF;
END $$;
