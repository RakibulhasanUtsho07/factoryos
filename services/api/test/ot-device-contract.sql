-- Structural checks for the bounded OT/edge registry schema. This is run after all
-- numbered migrations in the disposable PostgreSQL CI database.
DO $$
DECLARE
  table_name text;
  policy_ok boolean;
  trigger_ok boolean;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ot_devices', 'ot_device_history', 'ot_device_stream_cursors', 'ot_telemetry_events'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid = format('public.%I', table_name)::regclass
        AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'RLS must be enabled and forced for %', table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = format('public.%I', table_name)::regclass
        AND p.polname = table_name || '_tenant_scope'
    ) THEN
      RAISE EXCEPTION 'tenant RLS policy is missing for %', table_name;
    END IF;
  END LOOP;

  SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ot_device_update_guard' AND NOT tgisinternal)
    INTO trigger_ok;
  IF NOT trigger_ok THEN RAISE EXCEPTION 'OT device lifecycle trigger is missing'; END IF;

  SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ot_telemetry_events_append_only' AND NOT tgisinternal)
    INTO trigger_ok;
  IF NOT trigger_ok THEN RAISE EXCEPTION 'OT telemetry append-only trigger is missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE code = 'ot.telemetry.ingest'
  ) THEN RAISE EXCEPTION 'OT telemetry ingest permission is missing'; END IF;
END;
$$;
