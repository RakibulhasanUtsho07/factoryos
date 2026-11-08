-- Schema, tenant scope, immutable audit, reversal and finance resolver contract.
BEGIN;
DO $$
DECLARE v_rls BOOLEAN; v_forced BOOLEAN; v_definition TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='243_utility_work_order_cost_allocations')
    THEN RAISE EXCEPTION 'Utility work-order allocation migration marker is missing'; END IF;

  SELECT c.relrowsecurity,c.relforcerowsecurity INTO v_rls,v_forced
    FROM pg_class c WHERE c.oid=to_regclass('utility_reading_work_order_cost_allocations');
  IF COALESCE(v_rls,FALSE) IS NOT TRUE OR COALESCE(v_forced,FALSE) IS NOT TRUE
    THEN RAISE EXCEPTION 'Utility work-order allocation table must force tenant RLS'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy p
    WHERE p.polrelid=to_regclass('utility_reading_work_order_cost_allocations')
      AND p.polname='utility_reading_work_order_cost_allocations_tenant_isolation') THEN
    RAISE EXCEPTION 'Utility work-order allocation tenant isolation policy is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('utility_meter_readings')
       AND attname='currency_code_snapshot' AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('utility_meter_readings')
       AND attname='cost_center_code_snapshot' AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('utility_meter_readings')
       AND tgname='trg_utility_reading_source_cost_snapshot' AND NOT tgisinternal AND tgenabled<>'D') THEN
    RAISE EXCEPTION 'New utility readings must freeze currency and cost-centre provenance';
  END IF;

  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass('utility_reading_work_order_cost_allocations')
      AND NOT tgisinternal AND tgenabled<>'D' AND tgname=ANY(ARRAY[
        'trg_utility_work_order_cost_allocation_guard',
        'trg_utility_work_order_cost_allocation_immutable',
        'trg_utility_work_order_cost_allocation_audit']))<>3 THEN
    RAISE EXCEPTION 'Utility work-order allocation guard, append-only or audit trigger is missing';
  END IF;
  IF to_regprocedure('factoryos_guard_utility_reading_work_order_cost_allocation()') IS NULL
     OR to_regprocedure('factoryos_prevent_utility_reading_work_order_cost_allocation_mutation()') IS NULL
     OR to_regprocedure('factoryos_audit_utility_reading_work_order_cost_allocation()') IS NULL THEN
    RAISE EXCEPTION 'Utility work-order allocation trigger functions are missing';
  END IF;
  SELECT pg_get_functiondef('factoryos_guard_utility_reading_work_order_cost_allocation()'::regprocedure)
    INTO v_definition;
  IF position('Total net work-order allocations cannot exceed source meter consumption' IN v_definition)=0
     OR position('IN_PROGRESS' IN v_definition)=0
     OR position('REVERSAL' IN v_definition)=0
     OR position('currency_code_snapshot' IN v_definition)=0
     OR position('factoryos_current_user_id()' IN v_definition)=0 THEN
    RAISE EXCEPTION 'Allocation trigger omits capacity, work-order window, source snapshot, reversal or actor enforcement';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM factoryos_governance.tenant_relation_inventory
    WHERE schema_name='public'
      AND relation_name='utility_reading_work_order_cost_allocations'
      AND scope_model='DIRECT_TENANT_ID'
      AND data_category='UNREVIEWED'
      AND export_disposition='EXCLUDED'
      AND erasure_disposition='BLOCKED_UNREVIEWED'
  ) OR NOT EXISTS (
    SELECT 1 FROM factoryos_governance.tenant_relation_ownership_reviews
    WHERE schema_name='public'
      AND relation_name='utility_reading_work_order_cost_allocations'
      AND ownership_class='DIRECT_TENANT'
      AND export_disposition='EXCLUDED'
      AND erasure_disposition='BLOCKED_UNREVIEWED'
      AND review_status='VERIFIED'
  ) THEN
    RAISE EXCEPTION 'Utility cost allocation table must remain inventoried and excluded from generic export/erasure';
  END IF;
  IF EXISTS (
    SELECT 1 FROM factoryos_governance.tenant_export_adapter_relation_registry
    WHERE relation_name='utility_reading_work_order_cost_allocations'
  ) THEN
    RAISE EXCEPTION 'Utility cost allocation table must not enter a generic export adapter without a reviewed category adapter';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='uq_utility_reading_work_order_cost_allocation_reversal')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_utility_reading_work_order_cost_allocation_reading')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('utility_reading_work_order_cost_allocations')
       AND conname='fk_utility_reading_work_order_cost_allocation_work_order')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('utility_audit_events')
       AND conname='chk_utility_audit_entity'
       AND pg_get_constraintdef(oid) LIKE '%METER_SOURCE_BINDING%'
       AND pg_get_constraintdef(oid) LIKE '%THRESHOLD_POLICY%'
       AND pg_get_constraintdef(oid) LIKE '%WO_COST_ALLOCATION%') THEN
    RAISE EXCEPTION 'Allocation scope, reverse uniqueness or audit entity contract is incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('utility_reading_work_order_cost_allocations')
       AND tgname='trg_utility_work_order_cost_allocation_immutable'
       AND NOT tgisinternal AND tgenabled<>'D') THEN
    RAISE EXCEPTION 'Allocation UPDATE/DELETE must be blocked';
  END IF;
END;
$$;
ROLLBACK;
