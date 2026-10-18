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
    'quality_audit_events'
  ];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '093_quality_inspection_ncr_holds_disposition'
  ) THEN
    RAISE EXCEPTION 'Quality management migration marker is missing';
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
      AND tgname='trg_quality_ncr_close_guard' AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'Quality target, event, defect, hold, stock, production or CAPA lifecycle trigger is missing';
  END IF;

  IF to_regprocedure('factoryos_quality_sync_traceability_hold()') IS NULL
    OR to_regprocedure('factoryos_quality_guard_inventory_issue()') IS NULL
    OR to_regprocedure('factoryos_quality_guard_inventory_reservation()') IS NULL
    OR to_regprocedure('factoryos_quality_guard_work_order_hold()') IS NULL
    OR to_regprocedure('factoryos_quality_guard_work_order_report()') IS NULL
    OR position('containment, corrective and preventive action evidence'
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
