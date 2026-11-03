BEGIN;

-- Legal holds and propagation start must serialize on the tenant row. Every
-- application propagation attempt locks this row before checking holds and
-- committing a RUNNING run; this trigger obtains the same lock for direct SQL
-- writes, then checks the committed run inventory before an ACTIVE hold exists.
CREATE OR REPLACE FUNCTION factoryos_guard_saas_legal_hold_external_propagation_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM public.tenants t
  WHERE t.id = NEW.tenant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'legal hold requires an existing tenant'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.saas_tenant_external_propagation_runs r
    WHERE r.tenant_id = NEW.tenant_id
      AND r.status = 'RUNNING'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(r.categories) AS running_category(category)
        WHERE NEW.categories ? running_category.category
      )
  ) THEN
    RAISE EXCEPTION
      'an overlapping active legal hold cannot be created while external erasure propagation is RUNNING'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS saas_tenant_data_legal_hold_external_propagation_fence
  ON public.saas_tenant_data_legal_holds;
CREATE TRIGGER saas_tenant_data_legal_hold_external_propagation_fence
  BEFORE INSERT OR UPDATE ON public.saas_tenant_data_legal_holds
  FOR EACH ROW
  EXECUTE FUNCTION public.factoryos_guard_saas_legal_hold_external_propagation_fence();

INSERT INTO schema_migrations(version, checksum)
VALUES ('220_saas_legal_hold_propagation_fence', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
