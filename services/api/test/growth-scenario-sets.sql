-- PostgreSQL contract for versioned, immutable growth scenario sets.
DO $$
DECLARE
  table_name TEXT;
  required_trigger TEXT;
  definition TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'growth_scenario_sets',
    'growth_scenario_set_members'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NULL THEN
      RAISE EXCEPTION 'GROWTH_SCENARIO_SET_REQUIRED_TABLE_MISSING: %', table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
       WHERE oid = to_regclass('public.' || table_name)
         AND relrowsecurity AND relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'GROWTH_SCENARIO_SET_RLS_NOT_FORCED: %', table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = table_name
         AND policyname = table_name || '_tenant_isolation'
         AND qual LIKE '%factoryos_current_tenant_id%'
         AND with_check LIKE '%factoryos_current_tenant_id%'
    ) THEN
      RAISE EXCEPTION 'GROWTH_SCENARIO_SET_TENANT_POLICY_MISSING: %', table_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_growth_scenario_scope'
      AND conrelid = 'public.growth_scenarios'::regclass
  ) THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SCOPE_KEY_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_growth_scenario_set_version'
      AND conrelid = 'public.growth_scenario_sets'::regclass
  ) THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_VERSION_UNIQUENESS_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_growth_scenario_set_member_scenario'
      AND conrelid = 'public.growth_scenario_set_members'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_growth_scenario_set_member_set'
      AND conrelid = 'public.growth_scenario_set_members'::regclass
  ) THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_COMPOSITE_SCOPE_FK_MISSING';
  END IF;

  FOREACH required_trigger IN ARRAY ARRAY[
    'growth_scenario_set_version_guard',
    'growth_scenario_set_member_guard',
    'growth_scenario_sets_immutable',
    'growth_scenario_set_members_immutable'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname = required_trigger AND NOT tgisinternal
    ) THEN
      RAISE EXCEPTION 'GROWTH_SCENARIO_SET_REQUIRED_TRIGGER_MISSING: %', required_trigger;
    END IF;
  END LOOP;

  definition := pg_get_functiondef('public.factoryos_guard_growth_scenario_set_version()'::regprocedure);
  IF position('FOR UPDATE' IN definition) = 0
     OR position('MAX(s.set_version)' IN definition) = 0
     OR position('factoryos_current_user_id()' IN definition) = 0 THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_MONOTONIC_VERSION_GUARD_INCOMPLETE';
  END IF;

  definition := pg_get_functiondef('public.factoryos_guard_growth_scenario_set_member()'::regprocedure);
  IF position('scenario_set_id' IN definition) = 0
     OR position('input_hash' IN definition) = 0
     OR position('scenario_type' IN definition) = 0 THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_MEMBER_SNAPSHOT_BINDING_INCOMPLETE';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '144_growth_scenario_sets'
  ) THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_MIGRATION_NOT_REGISTERED';
  END IF;
END;
$$;
