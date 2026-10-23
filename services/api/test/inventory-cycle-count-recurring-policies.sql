-- Schema contract for tenant-scoped recurring cycle-count policy and occurrence materialization.
BEGIN;

DO $$
DECLARE
  v_enabled BOOLEAN;
  v_forced BOOLEAN;
  v_definition TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '190_inventory_cycle_count_recurring_policies'
  ) THEN
    RAISE EXCEPTION 'recurring cycle-count policy migration marker is missing';
  END IF;

  IF to_regclass('public.inventory_cycle_count_recurring_policies') IS NULL
    OR to_regclass('public.inventory_cycle_count_recurring_policy_occurrences') IS NULL
    OR to_regclass('public.inventory_cycle_count_recurring_policy_events') IS NULL
  THEN
    RAISE EXCEPTION 'recurring cycle-count policy, occurrence or event table is missing';
  END IF;

  SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO v_enabled, v_forced
  FROM pg_class c
  WHERE c.oid = 'public.inventory_cycle_count_recurring_policies'::regclass;
  IF v_enabled IS DISTINCT FROM TRUE OR v_forced IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'recurring cycle-count policies must enable and force RLS';
  END IF;

  SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO v_enabled, v_forced
  FROM pg_class c
  WHERE c.oid = 'public.inventory_cycle_count_recurring_policy_occurrences'::regclass;
  IF v_enabled IS DISTINCT FROM TRUE OR v_forced IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'recurring policy occurrences must enable and force RLS';
  END IF;

  SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO v_enabled, v_forced
  FROM pg_class c
  WHERE c.oid = 'public.inventory_cycle_count_recurring_policy_events'::regclass;
  IF v_enabled IS DISTINCT FROM TRUE OR v_forced IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'recurring policy events must enable and force RLS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.inventory_cycle_count_recurring_policies'::regclass
      AND polname = 'inventory_cycle_count_recurring_policies_tenant_isolation'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.inventory_cycle_count_recurring_policy_occurrences'::regclass
      AND polname = 'inventory_cycle_count_recurring_occurrences_tenant_isolation'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.inventory_cycle_count_recurring_policy_events'::regclass
      AND polname = 'inventory_cycle_count_recurring_policy_events_tenant_isolation'
  ) THEN
    RAISE EXCEPTION 'recurring cycle-count tenant isolation policy is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.inventory_cycle_count_recurring_policy_occurrences'::regclass
      AND conname = 'uq_inventory_cycle_count_recurring_occurrence_number' AND contype = 'u'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.inventory_cycle_count_recurring_policy_occurrences'::regclass
      AND conname = 'uq_inventory_cycle_count_recurring_occurrence_task' AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'recurring count occurrences must be unique per policy slot and task';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_cycle_count_recurring_policies'::regclass
      AND tgname = 'inventory_cycle_count_recurring_policy_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_cycle_count_recurring_policies'::regclass
      AND tgname = 'inventory_cycle_count_recurring_policy_event_insert' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_cycle_count_recurring_policy_events'::regclass
      AND tgname = 'inventory_cycle_count_recurring_policy_events_immutable' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'recurring policy guard or append-only event trigger is missing';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_guard_inventory_cycle_count_recurring_policy()'::regprocedure)
    INTO v_definition;
  IF position('policy definition is immutable' IN v_definition) = 0
    OR position('cursor must advance from the immutable anchor' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'recurring policy definition or cursor guard is incomplete';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_cycle_count_recurring_expected_run(timestamp with time zone,character varying,smallint,bigint)'::regprocedure)
    INTO v_definition;
  IF position('MONTHLY' IN v_definition) = 0
    OR position('WEEKLY' IN v_definition) = 0
    OR position('DAILY' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'recurring calendar arithmetic must support daily, weekly and monthly periods';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_guard_inventory_cycle_count_recurring_policy_events()'::regprocedure)
    INTO v_definition;
  IF position('append-only' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'recurring policy event ledger is not append-only';
  END IF;
END $$;

ROLLBACK;
