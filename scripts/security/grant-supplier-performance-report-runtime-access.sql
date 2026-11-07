\set ON_ERROR_STOP on
DO $supplier_performance_runtime_grant$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='factoryos_app') THEN
    RAISE EXCEPTION 'factoryos_app runtime role must exist before granting report access';
  END IF;
  IF to_regprocedure('public.factoryos_supplier_performance_report(uuid,uuid,date,date,date)') IS NULL THEN
    RAISE EXCEPTION 'supplier performance report function must be migrated first';
  END IF;
END
$supplier_performance_runtime_grant$;
GRANT EXECUTE ON FUNCTION public.factoryos_supplier_performance_report(UUID,UUID,DATE,DATE,DATE) TO factoryos_app;
