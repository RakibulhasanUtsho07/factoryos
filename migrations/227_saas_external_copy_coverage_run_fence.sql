BEGIN;

CREATE OR REPLACE FUNCTION public.factoryos_guard_saas_external_copy_coverage_run_fence()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  scope_tenant uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    scope_tenant := OLD.tenant_id;
  ELSE
    scope_tenant := NEW.tenant_id;
  END IF;

  IF TG_OP='UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'external copy inventory cannot change tenant ownership' USING ERRCODE='55000';
  END IF;

  PERFORM 1 FROM public.tenants WHERE id=scope_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'external copy inventory tenant does not exist' USING ERRCODE='23503';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.saas_tenant_external_propagation_runs r
    WHERE r.tenant_id=scope_tenant AND r.status='RUNNING'
  ) THEN
    RAISE EXCEPTION 'external copy inventory is frozen while a propagation run is RUNNING' USING ERRCODE='55000';
  END IF;

  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS saas_tenant_external_copy_coverage_run_fence
 ON public.saas_tenant_external_copy_coverage_decisions;
CREATE TRIGGER saas_tenant_external_copy_coverage_run_fence
 BEFORE INSERT OR UPDATE OR DELETE ON public.saas_tenant_external_copy_coverage_decisions
 FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_external_copy_coverage_run_fence();

DROP TRIGGER IF EXISTS saas_tenant_external_data_targets_run_fence
 ON public.saas_tenant_external_data_targets;
CREATE TRIGGER saas_tenant_external_data_targets_run_fence
 BEFORE INSERT OR UPDATE OR DELETE ON public.saas_tenant_external_data_targets
 FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_external_copy_coverage_run_fence();

INSERT INTO schema_migrations(version,checksum)
VALUES ('227_saas_external_copy_coverage_run_fence',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
