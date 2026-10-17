-- MRP-lite planning persistence and tenant-isolation contract checks.
BEGIN;

DO $$
DECLARE
  v_table TEXT;
  v_policy TEXT;
  v_rls_enabled BOOLEAN;
  v_rls_forced BOOLEAN;
  v_tables TEXT[] := ARRAY['mrp_plans', 'mrp_plan_requirements'];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '089_mrp_lite_material_planning'
  ) THEN
    RAISE EXCEPTION 'MRP-lite migration marker is missing';
  END IF;

  FOREACH v_table IN ARRAY v_tables LOOP
    SELECT c.relrowsecurity, c.relforcerowsecurity
      INTO v_rls_enabled, v_rls_forced
    FROM pg_class c WHERE c.oid = to_regclass(v_table);

    IF COALESCE(v_rls_enabled, FALSE) IS NOT TRUE
      OR COALESCE(v_rls_forced, FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'RLS must be enabled and forced for %', v_table;
    END IF;

    v_policy := v_table || '_tenant_isolation';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = to_regclass(v_table) AND p.polname = v_policy
    ) THEN
      RAISE EXCEPTION 'Tenant isolation policy % is missing', v_policy;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM permissions WHERE code IN ('mrp.read', 'mrp.write')) <> 2 THEN
    RAISE EXCEPTION 'MRP-lite read/write permissions are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'mrp_plans'::regclass
      AND tgname = 'mrp_plans_immutable'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'mrp_plan_requirements'::regclass
      AND tgname = 'mrp_plan_requirements_immutable'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Immutable MRP-lite snapshot guards are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uq_mrp_plan_idempotency'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uq_mrp_requirement_plan_order_bom'
  ) THEN
    RAISE EXCEPTION 'MRP-lite idempotency or duplicate-demand guard is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mrp_plan_requirements'::regclass
      AND conname = 'fk_mrp_requirement_order_line_scope'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mrp_plan_requirements'::regclass
      AND conname = 'fk_mrp_requirement_version_scope'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mrp_plan_requirements'::regclass
      AND conname = 'fk_mrp_requirement_component_scope'
  ) THEN
    RAISE EXCEPTION 'Factory-scoped order, product-version or inventory foreign keys are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mrp_plan_requirements' AND column_name = 'shortage_date'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mrp_plan_requirements' AND column_name = 'projected_available_date'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mrp_plan_requirements' AND column_name = 'substitute_scenarios'
  ) THEN
    RAISE EXCEPTION 'MRP-lite shortage/projection/substitute outputs are incomplete';
  END IF;

  RAISE NOTICE 'MRP-lite material planning contract checks passed';
END;
$$;

ROLLBACK;
