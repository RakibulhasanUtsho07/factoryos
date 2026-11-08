\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('app.tenant_id','faaab63d-c447-46ce-950d-deebdd7f5f30',true);
SELECT set_config('app.user_id','921382b8-e83f-43ab-a576-e3db6a06b70c',true);
DO $supplier_performance_contract$
DECLARE
  v_oid OID; v_secdef BOOLEAN; v_volatility "char"; v_public_execute BOOLEAN;
  v_permission_count INTEGER; v_role_count INTEGER; v_report JSONB;
BEGIN
  SELECT p.oid,p.prosecdef,p.provolatile INTO v_oid,v_secdef,v_volatility
  FROM pg_proc p WHERE p.oid='public.factoryos_supplier_performance_report(uuid,uuid,date,date,date)'::regprocedure;
  IF v_oid IS NULL OR v_secdef IS DISTINCT FROM FALSE OR v_volatility IS DISTINCT FROM 's' THEN
    RAISE EXCEPTION 'Supplier performance report must exist, be STABLE and SECURITY INVOKER';
  END IF;
  IF NOT has_function_privilege('factoryos_app','public.factoryos_supplier_performance_report(uuid,uuid,date,date,date)','EXECUTE') THEN
    RAISE EXCEPTION 'factoryos_app cannot execute supplier performance report';
  END IF;
  SELECT EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=v_oid AND a.grantee=0 AND a.privilege_type='EXECUTE') INTO v_public_execute;
  IF v_public_execute THEN RAISE EXCEPTION 'Supplier performance report must not be executable by PUBLIC'; END IF;
  SELECT count(*) INTO v_permission_count FROM permissions WHERE code='suppliers.performance.read';
  IF v_permission_count<>1 THEN RAISE EXCEPTION 'Supplier performance permission is missing'; END IF;
  SELECT count(DISTINCT r.id) INTO v_role_count FROM roles r
    JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id
    WHERE r.code IN ('ORG_ADMIN','FACTORY_MANAGER','QUALITY_MANAGER') AND p.code='suppliers.performance.read';
  IF v_role_count<>3 THEN RAISE EXCEPTION 'Supplier performance roles are incomplete'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_purchase_orders_supplier_expected_delivery')
    OR NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_quality_supplier_events_supplier_grn_line_date') THEN
    RAISE EXCEPTION 'Supplier performance indexes are missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.quality_supplier_quality_events'::regclass AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'Supplier quality evidence must retain forced tenant RLS';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='239_supplier_performance_evidence') THEN
    RAISE EXCEPTION 'Supplier performance migration marker is missing';
  END IF;
  v_report:=public.factoryos_supplier_performance_report(
    '24f17f4c-b34f-4d6b-8ebd-37fbf73e36e7','a0f10000-0000-4000-8000-000000000001',
    DATE '2026-09-01',DATE '2026-09-30',DATE '2026-10-15');
  IF v_report->'supplier' IS DISTINCT FROM 'null'::jsonb
     OR v_report#>>'{summary,due_line_count}'<>'0'
     OR v_report#>>'{summary,approved_purchase_order_count}'<>'0'
     OR v_report#>>'{quality,event_count}'<>'0'
     OR v_report->'quantities_by_unit' IS DISTINCT FROM '[]'::jsonb
     OR v_report->'delivery_exceptions' IS DISTINCT FROM '[]'::jsonb
     OR v_report#>'{quality,evidence}' IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'Empty supplier evidence result is not deterministic: %',v_report;
  END IF;
  BEGIN
    PERFORM public.factoryos_supplier_performance_report(
      '24f17f4c-b34f-4d6b-8ebd-37fbf73e36e7','a0f10000-0000-4000-8000-000000000001',
      DATE '2026-10-01',DATE '2026-09-01',DATE '2026-10-15');
    RAISE EXCEPTION 'Reversed date range must be rejected';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  RAISE NOTICE 'SUPPLIER_PERFORMANCE_EVIDENCE_CONTRACT=PASS';
END
$supplier_performance_contract$;
COMMIT;
