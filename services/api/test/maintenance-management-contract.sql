-- Maintenance registry, preventive-plan and work-order security contracts.
BEGIN;

DO $$
DECLARE
  t TEXT;
  enabled BOOLEAN;
  forced BOOLEAN;
  required_tables TEXT[] := ARRAY[
    'maintenance_assets',
    'maintenance_pm_plans',
    'maintenance_work_orders',
    'maintenance_work_order_tasks',
    'maintenance_work_order_parts',
    'maintenance_events'
  ];
  required_triggers TEXT[] := ARRAY[
    'trg_maintenance_asset_hierarchy_guard',
    'trg_maintenance_asset_update_guard',
    'trg_maintenance_asset_retirement_guard',
    'trg_maintenance_pm_plan_update_guard',
    'trg_maintenance_work_order_guard',
    'trg_maintenance_event_guard',
    'trg_maintenance_events_immutable',
    'trg_maintenance_task_update_guard',
    'trg_maintenance_part_update_guard',
    'trg_maintenance_assets_event_required',
    'trg_maintenance_pm_plans_event_required',
    'trg_maintenance_work_orders_event_required',
    'trg_maintenance_work_order_tasks_event_required',
    'trg_maintenance_work_order_parts_event_required',
    'trg_maintenance_asset_delete_guard',
    'trg_maintenance_pm_plan_delete_guard',
    'trg_maintenance_work_order_delete_guard',
    'trg_maintenance_asset_initial_state_guard',
    'trg_maintenance_pm_plan_initial_state_guard',
    'trg_maintenance_work_order_initial_state_guard',
    'trg_maintenance_task_initial_state_guard',
    'trg_maintenance_part_initial_state_guard',
    'trg_maintenance_work_order_asset_active_guard',
    'trg_maintenance_work_order_immutability_guard'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='099_maintenance_assets_and_pm_plans')
    OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='100_maintenance_work_orders_and_spares')
    OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='101_maintenance_lifecycle_audit_guards') THEN
    RAISE EXCEPTION 'Maintenance registry, work-order and lifecycle guard migrations must all be applied';
  END IF;

  FOREACH t IN ARRAY required_tables LOOP
    SELECT c.relrowsecurity,c.relforcerowsecurity INTO enabled,forced
    FROM pg_class c WHERE c.oid=to_regclass(t);
    IF COALESCE(enabled,FALSE) IS NOT TRUE OR COALESCE(forced,FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'Maintenance table % must force tenant row-level security',t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass(t)
      AND p.polname=t||'_tenant_isolation') THEN
      RAISE EXCEPTION 'Maintenance tenant isolation policy is missing for %',t;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM permissions WHERE code IN (
    'maintenance.assets.read','maintenance.assets.manage',
    'maintenance.pm.read','maintenance.pm.manage',
    'maintenance.workorders.read','maintenance.workorders.manage','maintenance.workorders.execute',
    'maintenance.parts.manage'
  )) <> 8 THEN
    RAISE EXCEPTION 'Maintenance permissions are incomplete';
  END IF;

  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'D'
      AND tgname=ANY(required_triggers)) <> cardinality(required_triggers) THEN
    RAISE EXCEPTION 'A maintenance hierarchy, lifecycle, stock or audit trigger is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_maintenance_pm_independent_approval')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='uq_maintenance_pm_active_revision')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='uq_maintenance_pm_occurrence') THEN
    RAISE EXCEPTION 'Preventive-plan maker-checker or duplicate schedule protection is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM roles r
    WHERE r.code IN ('ORG_ADMIN','FACTORY_MANAGER')
      AND (SELECT count(*) FROM permissions p
           JOIN role_permissions rp ON rp.permission_id=p.id
           WHERE rp.role_id=r.id AND p.code LIKE 'maintenance.%') <> 8
  ) THEN
    RAISE EXCEPTION 'Seeded administrator/factory-manager roles must receive the full maintenance permission set';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_maintenance_wo_part_item')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_maintenance_wo_part_quantities') THEN
    RAISE EXCEPTION 'Spare parts must be factory-scoped inventory items with bounded quantities';
  END IF;
END;
$$;

ROLLBACK;
