DO $$
DECLARE
  v_order_id_column BOOLEAN;
  v_order_line_id_column BOOLEAN;
BEGIN
  IF to_regclass('public.wms_shipments') IS NULL
     OR to_regclass('public.wms_shipment_delivery_events') IS NULL THEN
    RAISE EXCEPTION 'Shipment order binding and delivery event tables are missing';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='wms_shipments' AND column_name='order_id'
  ) INTO v_order_id_column;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='wms_shipments' AND column_name='order_line_id'
  ) INTO v_order_line_id_column;
  IF NOT v_order_id_column OR NOT v_order_line_id_column THEN
    RAISE EXCEPTION 'Shipment rows must expose internal order and order-line bindings';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid='public.wms_shipment_delivery_events'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Shipment delivery events must FORCE tenant RLS';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='wms_shipment_delivery_events'
      AND policyname='wms_shipment_delivery_tenant_isolation'
  ) THEN
    RAISE EXCEPTION 'Shipment delivery event tenant policy is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.wms_shipments'::regclass
      AND conname='fk_wms_shipment_order'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.wms_shipments'::regclass
      AND conname='fk_wms_shipment_order_line'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.wms_shipments'::regclass
      AND conname='chk_wms_shipment_order_binding_pair'
  ) THEN
    RAISE EXCEPTION 'Shipment internal-order foreign keys and paired-ID guard are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.wms_shipments'::regclass
      AND tgname='trg_wms_shipment_order_binding_guard' AND tgenabled='O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.wms_shipment_delivery_events'::regclass
      AND tgname='trg_wms_shipment_delivery_event_guard' AND tgenabled='O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.wms_shipment_delivery_events'::regclass
      AND tgname='ctr_wms_shipment_delivery_evidence' AND tgenabled='O'
  ) THEN
    RAISE EXCEPTION 'Shipment order or immutable delivery evidence trigger is missing or disabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.wms_shipment_delivery_events'::regclass
      AND conname='chk_wms_shipment_delivery_proof'
  ) THEN
    RAISE EXCEPTION 'Proof-of-delivery fields must have database constraints';
  END IF;

  IF to_regprocedure('public.factoryos_guard_wms_shipment_order_binding()') IS NULL
     OR to_regprocedure('public.factoryos_guard_wms_shipment_delivery_event()') IS NULL
     OR to_regprocedure('public.factoryos_assert_wms_shipment_delivery_evidence()') IS NULL THEN
    RAISE EXCEPTION 'Shipment order/delivery invariant functions are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version='202_wms_shipment_order_delivery_proof'
  ) THEN
    RAISE EXCEPTION 'Shipment order/delivery migration version is not registered';
  END IF;
END;
$$;
