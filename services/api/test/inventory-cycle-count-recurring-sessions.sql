-- Schema contract for recurring multi-bin cycle-count session generation.
BEGIN;

DO $$
DECLARE
  v_definition TEXT;
  v_nullable TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '194_inventory_cycle_count_recurring_sessions'
  ) THEN
    RAISE EXCEPTION 'recurring multi-bin session migration marker is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inventory_cycle_count_recurring_policies'
      AND column_name = 'session_location_ids'
      AND data_type = 'ARRAY'
  ) THEN
    RAISE EXCEPTION 'recurring policy does not persist the session bin set';
  END IF;

  SELECT is_nullable INTO v_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'inventory_cycle_count_recurring_policy_occurrences'
    AND column_name = 'task_id';
  IF v_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'session-backed recurrence requires nullable occurrence task_id';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.inventory_cycle_count_recurring_policy_occurrences'::regclass
      AND conname = 'fk_inventory_cycle_count_recurring_occurrence_session'
      AND contype = 'f'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.inventory_cycle_count_recurring_policy_occurrences'::regclass
      AND conname = 'chk_inventory_cycle_count_recurring_occurrence_target'
      AND contype = 'c'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.inventory_cycle_count_recurring_policies'::regclass
      AND conname = 'chk_inventory_cycle_count_recurring_policy_session_bins'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'recurring session target constraints are missing';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_guard_inventory_cycle_count_recurring_policy()'::regprocedure)
    INTO v_definition;
  IF position('session_location_ids' IN v_definition) = 0
    OR position('policy definition is immutable' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'recurring policy multi-bin definition must be immutable';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_validate_cycle_count_recurring_policy_insert()'::regprocedure)
    INTO v_definition;
  IF position('every recurring session bin must be active in the policy factory' IN v_definition) = 0
    OR position('distinct bins' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'recurring session bins must be active, distinct and factory-scoped';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_cycle_count_recurring_policies'::regclass
      AND tgname = 'inventory_cycle_count_recurring_policy_insert_guard'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_cycle_count_recurring_policy_occurrences'::regclass
      AND tgname = 'inventory_cycle_count_recurring_occurrences_immutable'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'recurring policy insert or immutable occurrence guard is missing';
  END IF;
END $$;

ROLLBACK;
