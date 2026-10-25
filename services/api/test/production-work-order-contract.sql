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
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'orders'::regclass
      AND tgname = 'trg_order_production_output_fulfillment_guard' AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Work-order lifecycle, immutable event or production-linked sales-order completion guards are missing';
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
  ) OR position('aggregate WIP across all operations' IN pg_get_functiondef('factoryos_guard_work_order_operation_lifecycle()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Operation WIP snapshot, aggregate WIP, active/downtime timing or work-order completion evidence constraints are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '091_production_output_inventory_posting'
  ) OR to_regclass('production_output_postings') IS NULL THEN
    RAISE EXCEPTION 'Production output/inventory posting migration or table is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '198_production_output_genealogy_completion_guard'
  ) OR to_regprocedure('factoryos_assert_work_order_output_genealogy()') IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'work_orders'::regclass
        AND tgname = 'ctr_work_order_output_genealogy_completion_guard'
        AND NOT tgisinternal AND tgenabled <> 'D' AND tgdeferrable AND tginitdeferred
    ) THEN
    RAISE EXCEPTION 'Completed work orders must enforce output trace identities and lot/serial genealogy';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '092_order_production_report_work_order_routing_guard'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = to_regclass('order_production_reports')
      AND t.tgname = 'trg_order_production_report_work_order_path_guard'
      AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  ) OR to_regprocedure('factoryos_guard_unlinked_production_report_route()') IS NULL
     OR position(
       'must be recorded against the active final operation'
       IN pg_get_functiondef('factoryos_guard_unlinked_production_report_route()'::regprocedure)
     ) = 0 THEN
    RAISE EXCEPTION 'Work-order-managed output must not bypass the final routing operation';
  END IF;

  SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO v_enabled, v_forced
  FROM pg_class c WHERE c.oid = to_regclass('production_output_postings');
  IF COALESCE(v_enabled, FALSE) IS NOT TRUE OR COALESCE(v_forced, FALSE) IS NOT TRUE
     OR NOT EXISTS (
       SELECT 1 FROM pg_policy p
       WHERE p.polrelid = to_regclass('production_output_postings')
         AND p.polname = 'production_output_postings_tenant_isolation'
     ) THEN
    RAISE EXCEPTION 'Production output posting requires forced tenant RLS and its isolation policy';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = to_regclass('production_output_postings')
      AND a.attname = 'yield_percentage' AND NOT a.attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = to_regclass('production_output_postings')
      AND a.attname = 'cumulative_yield_percentage' AND NOT a.attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('production_output_postings')
      AND c.conname = 'chk_production_output_posting_work_order_pair'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('production_output_postings')
      AND c.conname = 'fk_production_output_posting_report'
      AND pg_get_constraintdef(c.oid) LIKE '%production_report_id, tenant_id, factory_id%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'inventory_movements'
      AND indexname = 'uq_inventory_movements_id_scope'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%'
  ) THEN
    RAISE EXCEPTION 'Production posting yield columns or tenant/factory scoped report/movement links are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = to_regclass('production_output_postings')
      AND t.tgname = 'trg_production_output_posting_guard'
      AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = to_regclass('production_output_postings')
      AND t.tgname = 'trg_production_output_postings_immutable'
      AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = to_regclass('order_production_reports')
      AND t.tgname = 'trg_order_production_report_inventory_posting_required'
      AND NOT t.tgisinternal AND t.tgenabled <> 'D'
      AND t.tgdeferrable AND t.tginitdeferred
  ) THEN
    RAISE EXCEPTION 'Output posting integrity, append-only or deferred report-to-inventory guards are missing';
  END IF;

  IF to_regprocedure('factoryos_guard_production_output_posting()') IS NULL
     OR to_regprocedure('factoryos_require_production_output_posting()') IS NULL
     OR to_regprocedure('factoryos_require_production_output_before_order_completion()') IS NULL
     OR position('finished-good inventory movement must receipt exactly'
       IN pg_get_functiondef('factoryos_guard_production_output_posting()'::regprocedure)) = 0
     OR position('aggregate inventory balance'
       IN pg_get_functiondef('factoryos_guard_production_output_posting()'::regprocedure)) = 0
     OR position('matching yield/scrap and inventory posting before commit'
       IN pg_get_functiondef('factoryos_require_production_output_posting()'::regprocedure)) = 0
     OR position('accepted good output'
       IN pg_get_functiondef('factoryos_require_production_output_before_order_completion()'::regprocedure)) = 0
     OR position('wo.status = ''COMPLETED'''
       IN pg_get_functiondef('factoryos_require_production_output_before_order_completion()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'Output posting and sales-order completion functions do not enforce inventory/yield/fulfillment consistency';
  END IF;

  RAISE NOTICE 'Production work-order lifecycle, yield/scrap, finished-goods inventory linkage, IAM and tenant contracts passed';
END;
$$;

ROLLBACK;
