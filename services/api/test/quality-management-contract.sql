-- Quality inspection, hold/disposition, NCR/CAPA persistence and security contract.
BEGIN;

DO $$
DECLARE
  t TEXT;
  enabled BOOLEAN;
  forced BOOLEAN;
  required_tables TEXT[] := ARRAY[
    'quality_inspections',
    'quality_inspection_events',
    'quality_defects',
    'quality_defect_events',
    'quality_holds',
    'quality_dispositions',
    'quality_ncrs',
    'quality_ncr_actions',
    'quality_audit_events',
    'quality_inspection_plans',
    'quality_inspection_plan_criteria',
    'quality_inspection_results',
    'quality_ncr_action_events',
    'quality_defect_links',
    'quality_rework_orders',
    'quality_rework_events'
  ];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '093_quality_inspection_ncr_holds_disposition'
  ) THEN
    RAISE EXCEPTION 'Quality management migration marker is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '094_quality_inspection_plans_and_results'
  ) THEN
    RAISE EXCEPTION 'Versioned inspection-plan and measurement migration marker is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '095_quality_ncr_resolution_gate'
  ) THEN
    RAISE EXCEPTION 'NCR resolution gate migration marker is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '096_quality_capa_action_lifecycle')
    OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '097_quality_defect_order_traceability')
    OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '098_quality_rework_execution_and_verification') THEN
    RAISE EXCEPTION 'CAPA lifecycle, defect genealogy or rework migration marker is missing';
  END IF;

  FOREACH t IN ARRAY required_tables LOOP
    SELECT c.relrowsecurity, c.relforcerowsecurity INTO enabled, forced
    FROM pg_class c WHERE c.oid = to_regclass(t);
    IF COALESCE(enabled, FALSE) IS NOT TRUE OR COALESCE(forced, FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'Quality table % must force row-level tenant isolation', t;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = to_regclass(t)
        AND p.polname = t || '_tenant_isolation'
    ) THEN
      RAISE EXCEPTION 'Tenant isolation policy is missing for quality table %', t;
    END IF;
  END LOOP;

  IF (
    SELECT count(*) FROM permissions
    WHERE code IN (
      'quality.inspections.read', 'quality.inspections.write',
      'quality.defects.write', 'quality.disposition.decide', 'quality.ncr.manage'
    )
  ) <> 5 THEN
    RAISE EXCEPTION 'Quality permission set is incomplete';
  END IF;

  IF (
    SELECT count(*) FROM permissions
    WHERE code IN ('quality.capa.verify','quality.rework.manage','quality.defects.trace')
  ) <> 3 THEN
    RAISE EXCEPTION 'CAPA verification, rework or defect-traceability permissions are missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_inspections'::regclass
      AND tgname='trg_quality_inspection_target_guard' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_inspection_events'::regclass
      AND tgname='trg_quality_inspection_event_guard' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_defects'::regclass
      AND tgname='trg_quality_defect_guard' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_holds'::regclass
      AND tgname='trg_quality_hold_guard' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='inventory_movements'::regclass
      AND tgname='trg_quality_guard_inventory_issue' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='inventory_reservations'::regclass
      AND tgname='trg_quality_guard_inventory_reservation' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='work_orders'::regclass
      AND tgname='trg_quality_guard_work_order_hold' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='order_production_reports'::regclass
      AND tgname='trg_quality_guard_work_order_report' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_ncrs'::regclass
      AND tgname='trg_quality_ncr_close_guard' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_ncr_actions'::regclass
      AND tgname='trg_quality_ncr_action_lifecycle' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_defect_links'::regclass
      AND tgname='trg_quality_defect_link_guard' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_defect_links'::regclass
      AND tgname='trg_quality_defect_links_immutable' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_rework_orders'::regclass
      AND tgname='trg_quality_rework_order_lifecycle' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_rework_events'::regclass
      AND tgname='trg_quality_rework_event_guard' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_ncr_action_events'::regclass
      AND tgname='trg_quality_ncr_action_event_guard' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_defect_links'::regclass
      AND tgname='trg_quality_rework_output_link_guard' AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'Quality target, event, defect, hold, stock, production or CAPA lifecycle trigger is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_inspection_plans'::regclass
      AND tgname='trg_quality_inspection_plan_lifecycle' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_inspection_plan_criteria'::regclass
      AND tgname='trg_quality_plan_criterion_guard' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_inspections'::regclass
      AND tgname='trg_quality_bind_inspection_plan' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_inspection_results'::regclass
      AND tgname='trg_quality_inspection_result_guard' AND NOT tgisinternal AND tgenabled <> 'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_inspections'::regclass
      AND tgname='trg_quality_result_completeness' AND NOT tgisinternal AND tgenabled <> 'D')
    OR to_regprocedure('factoryos_evaluate_quality_criterion(jsonb,text)') IS NULL
    OR to_regprocedure('factoryos_guard_quality_inspection_result()') IS NULL THEN
    RAISE EXCEPTION 'Versioned inspection-plan, criterion and result guards are missing';
  END IF;

  IF factoryos_evaluate_quality_criterion(
      '{"value_type":"NUMERIC","comparison_operator":"BETWEEN","lower_limit":10,"upper_limit":12}'::jsonb,
      '11.5') <> 'PASS'
    OR factoryos_evaluate_quality_criterion(
      '{"value_type":"NUMERIC","comparison_operator":"BETWEEN","lower_limit":10,"upper_limit":12}'::jsonb,
      '12.5') <> 'FAIL'
    OR factoryos_evaluate_quality_criterion(
      '{"value_type":"ENUM","comparison_operator":"IN","allowed_values":["A","B"]}'::jsonb,
      'B') <> 'PASS'
    OR factoryos_evaluate_quality_criterion(
      '{"value_type":"BOOLEAN","comparison_operator":"EQ","target_value":"true"}'::jsonb,
      'false') <> 'FAIL' THEN
    RAISE EXCEPTION 'Inspection-criterion evaluator returned an incorrect acceptance result';
  END IF;

  IF to_regprocedure('factoryos_guard_quality_ncr_action_lifecycle()') IS NULL
    OR to_regprocedure('factoryos_guard_quality_defect_link()') IS NULL
    OR to_regprocedure('factoryos_guard_quality_rework_order()') IS NULL
    OR to_regprocedure('factoryos_guard_quality_rework_event()') IS NULL
    OR position('action_status = ''VERIFIED''' IN pg_get_functiondef('factoryos_quality_guard_ncr_close()'::regprocedure)) = 0
    OR to_regprocedure('factoryos_quality_sync_traceability_hold()') IS NULL
    OR to_regprocedure('factoryos_quality_guard_inventory_issue()') IS NULL
    OR to_regprocedure('factoryos_quality_guard_inventory_reservation()') IS NULL
    OR to_regprocedure('factoryos_quality_guard_work_order_hold()') IS NULL
    OR to_regprocedure('factoryos_quality_guard_work_order_report()') IS NULL
    OR position('NCR closure requires CAPA evidence'
      IN pg_get_functiondef('factoryos_quality_guard_ncr_close()'::regprocedure)) = 0
    OR position('a resolved inspection and no active quality hold'
      IN pg_get_functiondef('factoryos_quality_guard_ncr_close()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Quality-to-traceability, inventory, work-order or CAPA enforcement is incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='quality_dispositions'::regclass
      AND conname='chk_quality_disposition_inventory_evidence'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='quality_holds'::regclass
      AND conname='chk_quality_hold_release_evidence'
  ) THEN
    RAISE EXCEPTION 'Disposition/hold release evidence constraints are missing';
  END IF;

  RAISE NOTICE 'Quality inspection, defect, quarantine, disposition and NCR/CAPA contract passed';
END;
$$;

ROLLBACK;
