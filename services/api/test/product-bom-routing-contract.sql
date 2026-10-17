-- Product/BOM/routing/version contract smoke tests. Run after migration 082.
BEGIN;

DO $$
DECLARE
  v_table TEXT;
  v_policy_name TEXT;
  v_rls_enabled BOOLEAN;
  v_rls_forced BOOLEAN;
  v_tables TEXT[] := ARRAY[
    'product_definitions',
    'product_versions',
    'manufacturing_work_centres',
    'product_bom_lines',
    'product_bom_alternates',
    'product_routing_steps'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '082_product_bom_routing_version_contracts')
     OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '083_product_definition_idempotency_hardening') THEN
    RAISE EXCEPTION 'Product/BOM/routing migration marker is missing';
  END IF;

  FOREACH v_table IN ARRAY v_tables LOOP
    SELECT c.relrowsecurity, c.relforcerowsecurity
      INTO v_rls_enabled, v_rls_forced
      FROM pg_class c
     WHERE c.oid = to_regclass(v_table);
    IF COALESCE(v_rls_enabled, FALSE) IS NOT TRUE
       OR COALESCE(v_rls_forced, FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'RLS must be enabled and forced for %', v_table;
    END IF;
    v_policy_name := v_table || '_tenant_isolation';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = to_regclass(v_table) AND p.polname = v_policy_name
    ) THEN
      RAISE EXCEPTION 'Tenant isolation policy % is missing', v_policy_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'product_versions'::regclass
      AND tgname = 'trg_product_version_guard'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Product version lifecycle/effective-date guard is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'product_bom_lines'::regclass
      AND tgname = 'trg_product_bom_line_guard'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Draft-only BOM edit guard is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'product_bom_alternates'::regclass
      AND tgname = 'trg_product_bom_alternate_guard'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Alternate material contract guard is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'product_routing_steps'::regclass
      AND tgname = 'trg_product_routing_step_guard'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Draft-only routing edit guard is missing';
  END IF;

  IF (SELECT count(*) FROM permissions WHERE code IN (
    'products.master.read','products.master.write',
    'products.version.approve','products.alternate.approve'
  )) <> 4 THEN
    RAISE EXCEPTION 'Product engineering permissions are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'product_bom_lines'::regclass
      AND conname = 'fk_product_bom_line_component'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'product_routing_steps'::regclass
      AND conname = 'fk_product_routing_step_work_centre'
  ) THEN
    RAISE EXCEPTION 'BOM component and route work-centre scope constraints are missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='product_bom_alternates' AND column_name='retired_by_user_id')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='product_bom_alternates'::regclass AND conname='chk_product_bom_alternate_lifecycle_metadata') THEN
    RAISE EXCEPTION 'Alternate retirement lifecycle columns/constraint are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='product_versions'::regclass AND conname='chk_product_version_independent_approval')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='product_bom_alternates'::regclass AND conname='chk_product_bom_alternate_independent_approval') THEN
    RAISE EXCEPTION 'Independent product/alternate approval controls are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='uq_product_version_approval_idempotency')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='uq_product_alternate_approval_idempotency') THEN
    RAISE EXCEPTION 'Approval idempotency guards are missing';
  END IF;

  RAISE NOTICE 'Product/BOM/routing/version contract checks passed';
END;
$$;

ROLLBACK;
