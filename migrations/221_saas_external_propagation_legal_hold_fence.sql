BEGIN;

-- Direct run creation and retry paths must not enter RUNNING while an
-- overlapping active legal hold exists. The application also checks holds
-- inside its tenant-locked transaction; this trigger protects direct SQL and
-- future execution paths.
CREATE OR REPLACE FUNCTION factoryos_guard_saas_external_propagation_active_legal_hold()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status <> 'RUNNING' THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM public.tenants t
  WHERE t.id = NEW.tenant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'external propagation requires an existing tenant'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.saas_tenant_data_legal_holds h
    WHERE h.tenant_id = NEW.tenant_id
      AND h.status = 'ACTIVE'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(NEW.categories) AS run_category(category)
        WHERE h.categories ? run_category.category
      )
  ) THEN
    RAISE EXCEPTION
      'external erasure propagation cannot enter RUNNING while an overlapping active legal hold exists'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS saas_tenant_external_propagation_active_legal_hold_fence
  ON public.saas_tenant_external_propagation_runs;
CREATE TRIGGER saas_tenant_external_propagation_active_legal_hold_fence
  BEFORE INSERT OR UPDATE ON public.saas_tenant_external_propagation_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.factoryos_guard_saas_external_propagation_active_legal_hold();

INSERT INTO schema_migrations(version, checksum)
VALUES ('221_saas_external_propagation_legal_hold_fence', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
