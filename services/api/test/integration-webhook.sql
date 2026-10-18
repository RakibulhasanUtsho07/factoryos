DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['integration_connectors','integration_connector_history','integration_webhook_receipts','integration_webhook_rate_limits'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=('public.'||v_table)::regclass AND relrowsecurity AND relforcerowsecurity) THEN
      RAISE EXCEPTION 'integration table % must enable and force RLS',v_table;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=v_table AND policyname=v_table||'_tenant_isolation') THEN
      RAISE EXCEPTION 'tenant policy missing for %',v_table;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.integration_connectors'::regclass AND tgname='trg_integration_connector_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'integration connector lifecycle guard is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.integration_connector_history'::regclass AND tgname='trg_integration_connector_history_append_only' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'integration connector append-only history guard is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.integration_webhook_receipts'::regclass AND tgname='trg_integration_webhook_receipt_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'webhook receipt immutability guard is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.factoryos_resolve_integration_webhook(uuid)'::regprocedure AND prosecdef) THEN
    RAISE EXCEPTION 'scoped webhook resolution function must be SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('factoryos_app','public.factoryos_resolve_integration_webhook(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'application role cannot resolve incoming webhook scope';
  END IF;
  IF has_schema_privilege('factoryos_app','integration_internal','USAGE') OR has_table_privilege('factoryos_app','integration_internal.webhook_routes','SELECT') THEN
    RAISE EXCEPTION 'application role must not read internal webhook route table directly';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='119_integration_connector_registry') THEN
    RAISE EXCEPTION 'integration registry migration is not registered';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='120_integration_connector_event_allowlist') THEN
    RAISE EXCEPTION 'integration connector event allowlist migration is not registered';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='121_integration_webhook_rate_limits') THEN
    RAISE EXCEPTION 'integration webhook rate-limit migration is not registered';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.integration_webhook_rate_limits'::regclass AND conname='chk_integration_webhook_rate_window_count') THEN
    RAISE EXCEPTION 'integration webhook rate-limit counter guard is missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='integration_connectors' AND column_name='allowed_event_types') THEN
    RAISE EXCEPTION 'integration connector event allowlist column is missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.integration_connectors'::regclass AND conname='chk_integration_connector_allowed_event_types') THEN
    RAISE EXCEPTION 'integration connector event allowlist constraint is missing';
  END IF;
  IF NOT public.factoryos_integration_event_types_valid(ARRAY['ORDER.CREATED','MES.PRODUCTION.COUNTED']::varchar[]) OR public.factoryos_integration_event_types_valid(ARRAY['ORDER.CREATED','ORDER.CREATED']::varchar[]) OR public.factoryos_integration_event_types_valid(ARRAY['lower.case']::varchar[]) THEN
    RAISE EXCEPTION 'integration connector event allowlist validator is not enforcing strict unique canonical identifiers';
  END IF;
END $$;
SELECT 'signed webhook connector registry schema verification passed' AS result;
