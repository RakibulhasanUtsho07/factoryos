-- Finite-capacity scenario schema, frozen-horizon and non-committing planning contract.
BEGIN;

DO $$
DECLARE
  v_table TEXT;
  v_policy TEXT;
  v_enabled BOOLEAN;
  v_forced BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '163_mrp_finite_capacity_planning'
  ) THEN
    RAISE EXCEPTION 'Finite-capacity migration marker is missing';
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'mrp_capacity_calendar',
    'mrp_capacity_plans',
    'mrp_capacity_plan_operations',
    'mrp_capacity_plan_allocations'
  ] LOOP
    SELECT c.relrowsecurity, c.relforcerowsecurity
      INTO v_enabled, v_forced
    FROM pg_class c WHERE c.oid = to_regclass(v_table);
    IF COALESCE(v_enabled, FALSE) IS NOT TRUE OR COALESCE(v_forced, FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'Forced tenant RLS is required for %', v_table;
    END IF;
    v_policy := v_table || '_tenant_isolation';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = to_regclass(v_table) AND p.polname = v_policy
    ) THEN
      RAISE EXCEPTION 'Tenant isolation policy % is missing', v_policy;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM permissions WHERE code IN (
    'mrp.capacity.read', 'mrp.capacity.write', 'mrp.capacity.plan'
  )) <> 3 THEN
    RAISE EXCEPTION 'Finite-capacity permissions are incomplete';
  END IF;

  IF (SELECT count(DISTINCT p.code)
      FROM roles r
      JOIN role_permissions rp ON rp.role_id = r.id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
        AND p.code IN ('mrp.capacity.read', 'mrp.capacity.write', 'mrp.capacity.plan')) <> 3 THEN
    RAISE EXCEPTION 'Finite-capacity manager role grants are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'mrp_capacity_calendar'::regclass
      AND tgname = 'trg_mrp_capacity_calendar_guard'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'mrp_capacity_plans'::regclass
      AND tgname = 'mrp_capacity_plans_immutable'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'mrp_capacity_plan_operations'::regclass
      AND tgname = 'mrp_capacity_plan_operations_immutable'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'mrp_capacity_plan_allocations'::regclass
      AND tgname = 'mrp_capacity_plan_allocations_immutable'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Capacity calendar lifecycle or immutable scenario guards are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uq_mrp_capacity_calendar_business_slot'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uq_mrp_capacity_plan_version'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uq_mrp_capacity_plan_idempotency'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uq_mrp_capacity_allocation_operation_slot'
  ) THEN
    RAISE EXCEPTION 'Capacity calendar uniqueness, plan version, idempotency, or allocation uniqueness is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'mrp_capacity_calendar'::regclass
      AND conname = 'fk_mrp_capacity_calendar_work_centre'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'mrp_capacity_calendar'::regclass
      AND conname = 'fk_mrp_capacity_calendar_shift'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'mrp_capacity_plan_operations'::regclass
      AND conname = 'fk_mrp_capacity_operation_version'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'mrp_capacity_plan_allocations'::regclass
      AND conname = 'fk_mrp_capacity_allocation_calendar'
  ) THEN
    RAISE EXCEPTION 'Finite-capacity rows lack required factory-scoped engineering/calendar references';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mrp_capacity_plans' AND column_name = 'frozen_horizon_diff'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mrp_capacity_plan_operations' AND column_name = 'product_version_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mrp_capacity_plan_allocations' AND column_name = 'worker_allocations'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mrp_capacity_calendar' AND column_name = 'shift_template_id'
  ) THEN
    RAISE EXCEPTION 'Frozen diff, pinned product revision, qualified worker or shift calendar snapshot schema is incomplete';
  END IF;

  RAISE NOTICE 'Finite-capacity calendar, scenario, worker and immutability contract checks passed';
END;
$$;

ROLLBACK;
