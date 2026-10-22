-- PLM/ECO effective-dated revision, maker-checker, and production snapshot contract.
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
    WHERE version = '162_plm_eco_effective_dated_revision_integration'
  ) THEN
    RAISE EXCEPTION 'PLM/ECO migration marker is missing';
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'product_change_orders',
    'product_change_order_affected_orders',
    'product_change_order_events'
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
    'products.eco.read', 'products.eco.write', 'products.eco.approve'
  )) <> 3 THEN
    RAISE EXCEPTION 'PLM/ECO IAM permissions are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'product_change_orders'::regclass
      AND tgname = 'trg_product_change_order_lifecycle' AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'product_change_order_events'::regclass
      AND tgname = 'trg_product_change_order_events_immutable' AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'product_change_order_affected_orders'::regclass
      AND tgname = 'trg_product_change_order_affected_orders_immutable'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'ECO lifecycle, immutable impact snapshot, or append-only history trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'product_bom_lines'::regclass
      AND tgname = 'trg_product_change_order_freezes_bom' AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'product_bom_alternates'::regclass
      AND tgname = 'trg_product_change_order_freezes_alternates' AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'product_routing_steps'::regclass
      AND tgname = 'trg_product_change_order_freezes_routing' AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'product_versions'::regclass
      AND tgname = 'trg_product_change_order_freezes_version_metadata'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'product_versions'::regclass
      AND tgname = 'trg_product_version_eco_release_gate'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Submitted ECO engineering-input freeze or maker-checker release gate is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'work_orders'::regclass
      AND tgname = 'trg_work_order_effective_product_revision'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Work-order planned-start effective-revision guard is missing';
  END IF;

  IF position('FOR UPDATE' IN pg_get_functiondef(
    'factoryos_guard_submitted_product_revision_inputs()'::regprocedure
  )) = 0 OR position('IN (OLD.product_version_id, NEW.product_version_id)' IN pg_get_functiondef(
    'factoryos_guard_submitted_product_revision_inputs()'::regprocedure
  )) = 0 THEN
    RAISE EXCEPTION 'Submitted ECO revision-input guard must serialize child edits and reject revision reassignment bypasses';
  END IF;

  IF position('proposed revision author' IN pg_get_functiondef(
    'factoryos_guard_product_change_order_lifecycle()'::regprocedure
  )) = 0 THEN
    RAISE EXCEPTION 'Database-level ECO maker-checker protection is missing';
  END IF;

  -- A new ECO may report impact but must not mutate a pinned production definition.
  -- These guards already protect the work-order revision identity and copied operation/material snapshots.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'work_orders'::regclass
      AND tgname = 'trg_work_order_lifecycle' AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'work_order_operations'::regclass
      AND tgname = 'trg_work_order_operation_lifecycle' AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'work_order_material_requirements'::regclass
      AND tgname = 'trg_work_order_material_requirements_immutable' AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'work_order_material_reservations'::regclass
      AND tgname = 'trg_work_order_material_reservations_immutable' AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Existing released work-order or pinned operation/material snapshot immutability is not guarded';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_product_change_order_active_proposed_revision')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_product_change_order_event_idempotency')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_product_change_order_affected_history') THEN
    RAISE EXCEPTION 'ECO uniqueness, idempotency, or affected-order query index is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product_change_order_affected_orders' AND column_name = 'pinned_product_version_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product_change_orders' AND column_name = 'diff_snapshot'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product_change_order_events' AND column_name = 'idempotency_key'
  ) THEN
    RAISE EXCEPTION 'ECO version-diff, affected-order, or lifecycle-history snapshot schema is incomplete';
  END IF;

  RAISE NOTICE 'PLM/ECO lifecycle and immutable work-order snapshot contract checks passed';
END;
$$;

ROLLBACK;
