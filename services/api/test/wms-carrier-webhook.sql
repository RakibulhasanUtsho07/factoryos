DO $$
DECLARE
  v_actor_nullable BOOLEAN;
  v_guard_definition TEXT;
BEGIN
  IF to_regclass('public.wms_shipment_delivery_events') IS NULL THEN
    RAISE EXCEPTION 'WMS delivery event table is missing';
  END IF;

  SELECT is_nullable='YES' INTO v_actor_nullable
  FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name='wms_shipment_delivery_events'
    AND column_name='recorded_by_user_id';
  IF v_actor_nullable IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Webhook delivery events must represent a non-human/system actor without impersonation';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_guard_wms_shipment_delivery_event()'::regprocedure)
  INTO v_guard_definition;
  IF position('NEW.source_system = ''MANUAL''' IN v_guard_definition)=0
     OR position('NEW.source_system = ''CARRIER_WEBHOOK''' IN v_guard_definition)=0
     OR position('system and carrier delivery events must not assert a human actor' IN v_guard_definition)=0 THEN
    RAISE EXCEPTION 'Delivery guard must distinguish authenticated human events from signed carrier events';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.wms_shipment_delivery_events'::regclass
      AND tgname='trg_wms_shipment_delivery_event_guard' AND tgenabled='O'
  ) THEN
    RAISE EXCEPTION 'WMS shipment delivery lifecycle guard is missing or disabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version='203_wms_signed_carrier_delivery_webhook'
  ) THEN
    RAISE EXCEPTION 'Signed carrier delivery migration version is not registered';
  END IF;
END;
$$;
