-- Schema contract for tenant-scoped multi-bin count sessions.
BEGIN;

DO $$
DECLARE
  v_rls_enabled BOOLEAN;
  v_rls_forced BOOLEAN;
  v_definition TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '189_inventory_cycle_count_sessions'
  ) THEN
    RAISE EXCEPTION 'multi-bin cycle-count session migration marker is missing';
  END IF;

  IF to_regclass('public.inventory_cycle_count_sessions') IS NULL THEN
    RAISE EXCEPTION 'cycle-count session header table is missing';
  END IF;

  SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO v_rls_enabled, v_rls_forced
  FROM pg_class c
  WHERE c.oid = 'public.inventory_cycle_count_sessions'::regclass;
  IF v_rls_enabled IS DISTINCT FROM TRUE OR v_rls_forced IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'cycle-count sessions must enable and force RLS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.inventory_cycle_count_sessions'::regclass
      AND polname = 'inventory_cycle_count_sessions_tenant_isolation'
  ) THEN
    RAISE EXCEPTION 'cycle-count session tenant policy is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.inventory_cycle_count_tasks'::regclass
      AND attname = 'session_id' AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.inventory_cycle_count_tasks'::regclass
      AND conname = 'fk_inventory_cycle_count_task_session_scope' AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'cycle-count task composite session binding is missing';
  END IF;

  IF to_regclass('public.uq_inventory_cycle_count_session_task_bin') IS NULL THEN
    RAISE EXCEPTION 'a session cannot contain duplicate tasks for the same bin';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_cycle_count_sessions'::regclass
      AND tgname = 'inventory_cycle_count_session_immutable_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_cycle_count_sessions'::regclass
      AND tgname = 'inventory_cycle_count_session_task_count_guard' AND NOT tgisinternal
      AND tgdeferrable AND tginitdeferred
  ) THEN
    RAISE EXCEPTION 'session immutability or deferred exact-bin-count guard is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_cycle_count_tasks'::regclass
      AND tgname = 'inventory_cycle_count_session_task_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_cycle_count_tasks'::regclass
      AND tgname = 'inventory_cycle_count_session_task_cancel_guard' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'session task binding or group cancellation guard is missing';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_validate_inventory_cycle_count_session_task_count()'::regprocedure)
    INTO v_definition;
  IF position('requires exactly its expected number of bin tasks' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'session exact-bin-count validation is incomplete';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_guard_inventory_cycle_count_session_task()'::regprocedure)
    INTO v_definition;
  IF position('must match its immutable session policy and bin scope' IN v_definition) = 0
    OR position('cannot contain more tasks than its scheduled bin count' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'session task policy-binding validation is incomplete';
  END IF;
END $$;

ROLLBACK;
