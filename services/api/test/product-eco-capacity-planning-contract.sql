-- PLM/ECO and finite-capacity planning schema contract assertions.
BEGIN;
DO $$
DECLARE
  v_table TEXT;
  v_policy TEXT;
  v_rls BOOLEAN;
  v_forced BOOLEAN;
  v_tables TEXT[] := ARRAY[
    'product_engineering_changes','product_eco_order_impacts','product_eco_events',
    'mrp_work_centre_capacity_calendar','mrp_capacity_plans','mrp_capacity_plan_operations'
  ];
  v_trigger TEXT;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='162_product_eco_effective_date_change_orders')
     OR NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='163_mrp_finite_capacity_scenarios') THEN
    RAISE EXCEPTION 'PLM/ECO or finite-capacity migration marker is missing';
  END IF;
  FOREACH v_table IN ARRAY v_tables LOOP
    SELECT c.relrowsecurity,c.relforcerowsecurity INTO v_rls,v_forced FROM pg_class c WHERE c.oid=to_regclass(v_table);
    IF COALESCE(v_rls,FALSE) IS NOT TRUE OR COALESCE(v_forced,FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'Tenant RLS must be enabled and forced for %',v_table;
    END IF;
    v_policy:=CASE v_table
      WHEN 'product_engineering_changes' THEN 'product_engineering_changes_tenant_isolation'
      WHEN 'product_eco_order_impacts' THEN 'product_eco_order_impacts_tenant_isolation'
      WHEN 'product_eco_events' THEN 'product_eco_events_tenant_isolation'
      WHEN 'mrp_work_centre_capacity_calendar' THEN 'mrp_capacity_calendar_tenant_isolation'
      WHEN 'mrp_capacity_plans' THEN 'mrp_capacity_plans_tenant_isolation'
      ELSE 'mrp_capacity_plan_operations_tenant_isolation' END;
    IF NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass(v_table) AND p.polname=v_policy) THEN
      RAISE EXCEPTION 'Expected tenant policy % missing for %',v_policy,v_table;
    END IF;
  END LOOP;
  FOREACH v_trigger IN ARRAY ARRAY[
    'trg_product_engineering_change_guard','trg_product_eco_impact_immutable','trg_product_eco_event_immutable',
    'trg_product_version_effective_override_guard','trg_work_order_operation_lifecycle',
    'trg_work_order_material_requirements_immutable','trg_work_order_material_reservations_immutable',
    'trg_mrp_capacity_calendar_guard','trg_mrp_capacity_plan_immutable','trg_mrp_capacity_plan_operations_immutable'
  ] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgname=v_trigger AND NOT t.tgisinternal AND t.tgenabled<>'D') THEN
      RAISE EXCEPTION 'Required PLM/production/capacity guard trigger % is missing or disabled',v_trigger;
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='product_engineering_changes'::regclass AND conname='fk_product_eco_source')
     OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='product_engineering_changes'::regclass AND conname='fk_product_eco_target')
     OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='product_eco_order_impacts'::regclass AND conname='fk_product_eco_impact_order_line')
     OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='product_eco_order_impacts'::regclass AND conname='fk_product_eco_impact_version')
     OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='mrp_capacity_plan_operations'::regclass AND conname='fk_mrp_capacity_op_routing')
     OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='mrp_capacity_plan_operations'::regclass AND conname='fk_mrp_capacity_op_work_centre') THEN
    RAISE EXCEPTION 'Factory-scoped ECO or planning revision/routing foreign keys are incomplete';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uq_product_eco_number')
     OR NOT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uq_product_eco_event_key')
     OR NOT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uq_mrp_capacity_plan_idempotency')
     OR NOT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uq_mrp_capacity_calendar_slot') THEN
    RAISE EXCEPTION 'ECO event/idempotency or capacity-calendar slot uniqueness contract is missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='product_eco_order_impacts' AND column_name='pinned_product_version_id')
     OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='product_eco_order_impacts' AND column_name='order_snapshot')
     OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='mrp_capacity_plan_operations' AND column_name='frozen_revision_snapshot')
     OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='mrp_capacity_plan_operations' AND column_name='sam_smv_minutes_per_unit')
     OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='mrp_capacity_plan_operations' AND column_name='alternate_material_scenarios') THEN
    RAISE EXCEPTION 'Order snapshot, frozen-horizon or SAM/SMV capacity evidence is missing';
  END IF;
  IF EXISTS(
    SELECT 1 FROM product_eco_order_impacts i JOIN work_orders w ON w.id=i.work_order_id AND w.tenant_id=i.tenant_id AND w.factory_id=i.factory_id
    WHERE i.pinned_product_version_id<>w.product_version_id
  ) THEN
    RAISE EXCEPTION 'ECO impact snapshots must preserve the pinned production revision';
  END IF;
END $$;
ROLLBACK;
