DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'integration_reconciliation_events',
    'integration_reconciliation_cases',
    'integration_reconciliation_attempts',
    'integration_reconciliation_case_history'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid=('public.'||v_table)::regclass AND relrowsecurity AND relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'operational reconciliation table % must force tenant RLS',v_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename=v_table AND policyname=v_table||'_tenant_isolation'
    ) THEN
      RAISE EXCEPTION 'tenant policy missing for operational reconciliation table %',v_table;
    END IF;
  END LOOP;

  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.integration_reconciliation_events'::regclass AND tgname='trg_integration_reconciliation_event_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'external operational event evidence must be immutable';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.integration_reconciliation_cases'::regclass AND tgname='trg_integration_reconciliation_case_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'reconciliation case disposition guard is missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.integration_reconciliation_cases'::regclass AND tgname='trg_integration_reconciliation_case_history' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'reconciliation case history trigger is missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.integration_reconciliation_attempts'::regclass AND tgname='trg_integration_reconciliation_attempt_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'duplicate and conflicting delivery attempts must be immutable';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='130_integration_operational_reconciliation') THEN
    RAISE EXCEPTION 'operational reconciliation migration is not registered';
  END IF;
  IF NOT has_table_privilege('factoryos_app','public.integration_reconciliation_events','SELECT')
     OR NOT has_table_privilege('factoryos_app','public.integration_reconciliation_cases','SELECT')
     OR NOT has_table_privilege('factoryos_app','public.integration_reconciliation_attempts','SELECT') THEN
    RAISE EXCEPTION 'application role must be able to read scoped reconciliation evidence';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.integration_reconciliation_cases'::regclass AND conname='chk_integration_reconciliation_case_resolution') THEN
    RAISE EXCEPTION 'reconciliation case resolution state constraints are missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uq_integration_reconciliation_open_case_key') THEN
    RAISE EXCEPTION 'open reconciliation cases must be idempotently keyed';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM permissions WHERE code='integrations.reconciliation.read')
     OR NOT EXISTS(SELECT 1 FROM permissions WHERE code='integrations.reconciliation.review') THEN
    RAISE EXCEPTION 'reconciliation read/review permissions are missing';
  END IF;
END $$;
SELECT 'operational event reconciliation schema verification passed' AS result;
