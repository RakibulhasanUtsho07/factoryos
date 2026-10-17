-- Production work-order / operation lifecycle persistence, IAM and append-only evidence contract.
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
    WHERE version = '090_production_work_order_operation_lifecycle'
  ) THEN
    RAISE EXCEPTION 'Production work-order lifecycle migration marker is missing';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['work_orders', 'work_order_operations', 'work_order_events', 'work_order_material_requirements', 'work_order_material_reservations'] LOOP
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
      RAISE EXCEPTION 'Tenant policy % is missing', v_policy;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM permissions WHERE code IN (
    'production.workorders.read', 'production.workorders.write',
    'production.workorders.release', 'production.operations.operate',
    'production.output.report'
  )) <> 5 THEN
    RAISE EXCEPTION 'Production work-order permissions are incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'production.workorders.read', 'production.workorders.write',
      'production.workorders.release', 'production.operations.operate',
      'production.output.report'
    ]) AS expected(code)
    WHERE NOT EXISTS (
      SELECT 1 FROM roles r
      JOIN role_permissions rp ON rp.role_id = r.id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE r.code = 'ORG_ADMIN' AND p.code = expected.code
    )
  ) OR EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'production.workorders.read', 'production.workorders.write',
      'production.workorders.release', 'production.operations.operate',
      'production.output.report'
    ]) AS expected(code)
    WHERE NOT EXISTS (
      SELECT 1 FROM roles r
      JOIN role_permissions rp ON rp.role_id = r.id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE r.code = 'FACTORY_MANAGER' AND p.code = expected.code
    )
  ) THEN
    RAISE EXCEPTION 'Production work-order permissions are not granted to expected seeded roles';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'work_orders'::regclass
      AND tgname = 'trg_work_order_lifecycle' AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'work_order_operations'::regclass
      AND tgname = 'trg_work_order_operation_lifecycle' AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'work_order_events'::regclass
      AND tgname = 'trg_work_order_events_immutable' AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'work_order_events'::regclass
      AND tgname = 'trg_work_order_event_payload_guard' AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'work_order_operations'::regclass
      AND tgname = 'trg_work_order_wip_snapshot_event_evidence'
      AND NOT tgisinternal AND tgenabled <> 'D' AND tgdeferrable AND tginitdeferred
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'factoryos_require_wip_snapshot_event_evidence'
      AND p.prorettype = 'trigger'::regtype
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'factoryos_guard_work_order_event_payload'
      AND p.prorettype = 'trigger'::regtype
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'work_order_material_requirements'::regclass
      AND tgname = 'trg_work_order_material_requirements_immutable' AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'work_order_material_reservations'::regclass
      AND tgname = 'trg_work_order_material_reservations_immutable' AND NOT tgisinternal AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'orders'::regclass
      AND tgname = 'trg_order_terminal_work_order_guard' AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Work-order lifecycle, immutable event or sales-order terminal guards are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uq_work_order_single_in_progress_operation'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uq_work_order_idempotency'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uq_work_order_event_idempotency'
  ) THEN
    RAISE EXCEPTION 'Single-active-operation or lifecycle idempotency indexes are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'work_order_events'::regclass
      AND conname = 'chk_work_order_event_type'
      AND pg_get_constraintdef(oid) LIKE '%WIP_TRANSFERRED%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'work_order_operations'::regclass
      AND tgname = 'trg_work_order_wip_snapshot_event_evidence'
      AND NOT tgisinternal AND tgenabled <> 'D' AND tgdeferrable AND tginitdeferred
  ) THEN
    RAISE EXCEPTION 'WIP transfer event type or deferred WIP snapshot audit evidence is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'work_orders'::regclass
      AND conname = 'fk_work_order_source_line'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'work_order_operations'::regclass
      AND conname = 'fk_work_order_operation_routing_snapshot'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'work_order_events'::regclass
      AND conname = 'fk_work_order_event_operation'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'work_order_material_requirements'::regclass
      AND conname = 'fk_work_order_material_requirement_bom_line'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'work_order_material_reservations'::regclass
      AND conname = 'fk_work_order_material_reservation_inventory'
  ) THEN
    RAISE EXCEPTION 'Work-order to order-line, routing snapshot or operation-event scope constraints are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'order_production_reports' AND column_name = 'work_order_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'order_production_reports' AND column_name = 'work_order_operation_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'order_production_reports'::regclass
      AND tgname = 'trg_order_production_report_work_order_guard'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Canonical good/scrap reports are not bound to their work order and final operation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'work_order_operations'::regclass
      AND conname = 'chk_work_order_operation_active_timer'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'work_order_operations'::regclass
      AND conname = 'chk_work_order_operation_wip_quantity'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'work_order_operations' AND column_name = 'wip_quantity'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'work_orders'::regclass
      AND conname = 'chk_work_order_completion_evidence'
  ) THEN
    RAISE EXCEPTION 'Operation WIP snapshot, active/downtime timing or work-order completion evidence constraints are missing';
  END IF;

  RAISE NOTICE 'Production work-order lifecycle schema, IAM, tenant scope and output-link contracts passed';
END;
$$;

ROLLBACK;
