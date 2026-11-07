\\set ON_ERROR_STOP on
BEGIN;

DO $supplier_performance_runtime_grant$
DECLARE
  v_role_count INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='factoryos_app') THEN
    RAISE EXCEPTION 'factoryos_app runtime role must exist before granting report access';
  END IF;
  IF to_regprocedure('public.factoryos_supplier_performance_report(uuid,uuid,date,date,date)') IS NULL THEN
    RAISE EXCEPTION 'supplier performance report function must be migrated first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.permissions WHERE code='suppliers.performance.read') THEN
    RAISE EXCEPTION 'supplier performance application permission must be migrated first';
  END IF;

  SELECT count(*) INTO v_role_count
  FROM public.roles
  WHERE code IN ('ORG_ADMIN','FACTORY_MANAGER','QUALITY_MANAGER');
  IF v_role_count <> 3 THEN
    RAISE EXCEPTION 'ORG_ADMIN, FACTORY_MANAGER and QUALITY_MANAGER roles must be seeded before provisioning supplier performance access';
  END IF;
END
$supplier_performance_runtime_grant$;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.code='suppliers.performance.read'
WHERE r.code IN ('ORG_ADMIN','FACTORY_MANAGER','QUALITY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

GRANT EXECUTE ON FUNCTION public.factoryos_supplier_performance_report(UUID,UUID,DATE,DATE,DATE) TO factoryos_app;

COMMIT;
