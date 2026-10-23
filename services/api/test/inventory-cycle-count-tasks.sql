-- Schema acceptance contract for scheduled WMS cycle-count tasks.
BEGIN;

DO $$
DECLARE
  v_rls_enabled BOOLEAN;
  v_rls_forced BOOLEAN;
  v_function_definition TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '187_inventory_cycle_count_tasks'
  ) THEN
    RAISE EXCEPTION 'scheduled cycle-count task migration marker is missing';
  END IF;

  IF to_regclass('public.inventory_cycle_count_tasks') IS NULL THEN
    RAISE EXCEPTION 'inventory_cycle_count_tasks table is missing';
  END IF;

  SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO v_rls_enabled, v_rls_forced
  FROM pg_class c
  WHERE c.oid = 'public.inventory_cycle_count_tasks'::regclass;

  IF v_rls_enabled IS DISTINCT FROM TRUE OR v_rls_forced IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'cycle-count tasks must enable and force row-level security';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'public.inventory_cycle_count_proposals'::regclass
      AND a.attname = 'task_id' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'cycle-count proposal task binding column is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.inventory_cycle_count_tasks'::regclass
      AND c.conname = 'uq_inventory_cycle_count_task_idempotency'
      AND c.contype = 'u'
  ) THEN
    RAISE EXCEPTION 'factory-scoped cycle-count task idempotency constraint is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.inventory_cycle_count_proposals'::regclass
      AND c.conname = 'fk_inventory_cycle_count_proposal_task_scope'
      AND c.contype = 'f'
  ) THEN
    RAISE EXCEPTION 'cycle-count proposal composite task scope FK is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.inventory_cycle_count_tasks'::regclass
      AND t.tgname = 'inventory_cycle_count_task_guard'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'cycle-count task lifecycle trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.inventory_cycle_count_tasks'::regclass
      AND t.tgname = 'inventory_cycle_count_task_insert_guard'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'cycle-count task insert guard is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.inventory_cycle_count_proposals'::regclass
      AND t.tgname = 'inventory_cycle_count_task_proposal_guard'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'cycle-count task/proposal binding trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    WHERE p.polrelid = 'public.inventory_cycle_count_tasks'::regclass
      AND p.polname = 'inventory_cycle_count_tasks_tenant_isolation'
  ) THEN
    RAISE EXCEPTION 'cycle-count task tenant isolation policy is missing';
  END IF;

  IF to_regclass('public.idx_inventory_cycle_count_tasks_due') IS NULL THEN
    RAISE EXCEPTION 'due-date task queue index is missing';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_guard_inventory_cycle_count_task()'::regprocedure)
    INTO v_function_definition;
  IF position('invalid cycle-count task lifecycle transition' IN v_function_definition) = 0
    OR position('awaiting-review task must reference its pending count proposal' IN v_function_definition) = 0
    OR position('completed task must reference an applied count proposal' IN v_function_definition) = 0
    OR position('task updates must advance the lifecycle' IN v_function_definition) = 0
  THEN
    RAISE EXCEPTION 'cycle-count task lifecycle guard is incomplete';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_validate_inventory_cycle_count_task_insert()'::regprocedure)
    INTO v_function_definition;
  IF position('cycle-count task assignee must be an active member of this tenant' IN v_function_definition) = 0
    OR position('active bin under an active warehouse or staging location' IN v_function_definition) = 0
  THEN
    RAISE EXCEPTION 'cycle-count task insert guard is incomplete';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_validate_inventory_cycle_count_task_proposal()'::regprocedure)
    INTO v_function_definition;
  IF position('proposal does not match the active assigned task' IN v_function_definition) = 0
    OR position('proposal task binding is immutable' IN v_function_definition) = 0
  THEN
    RAISE EXCEPTION 'cycle-count proposal/task binding guard is incomplete';
  END IF;
END $$;

ROLLBACK;
