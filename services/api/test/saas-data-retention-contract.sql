DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'saas_tenant_data_retention_policies',
    'saas_tenant_data_legal_holds',
    'saas_tenant_data_erasure_requests',
    'saas_tenant_data_export_preservation_attestations',
    'saas_tenant_data_retention_runs',
    'saas_tenant_data_erasure_runs'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid = format('public.%I', table_name)::regclass
        AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN RAISE EXCEPTION 'RLS must be enabled and forced for %', table_name; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = format('public.%I', table_name)::regclass
        AND p.polname = table_name || '_tenant_isolation'
    ) THEN RAISE EXCEPTION 'tenant isolation policy is missing for %', table_name; END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='saas_retention_policy_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'retention policy immutability trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_data_legal_hold_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'legal hold lifecycle trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_data_erasure_request_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'erasure request governance trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='saas_export_preservation_attestation_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'independent export preservation attestation guard is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_saas_tenant_erasure_export') THEN
    RAISE EXCEPTION 'erasure request must reference an export manifest in the same tenant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_saas_export_preservation_transfer') THEN
    RAISE EXCEPTION 'export preservation evidence must bind to an exact tenant export version';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE code='saas.data_retention.approve') THEN
    RAISE EXCEPTION 'retention approval permission is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE code='saas.data_retention.execute') THEN
    RAISE EXCEPTION 'retention execution permission is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_saas_tenant_erasure_execution_run') THEN
    RAISE EXCEPTION 'verified erasure must reference a tenant-scoped immutable execution receipt';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_saas_retention_run_policy') THEN
    RAISE EXCEPTION 'retention runs must snapshot an exact versioned retention policy';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_data_retention_runs_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'retention run evidence must be immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_data_erasure_runs_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'erasure execution receipts must be immutable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='chk_saas_retention_run_mode'
      AND pg_get_constraintdef(oid) NOT LIKE '%DRY_RUN%'
  ) THEN
    RAISE EXCEPTION 'retention run mode contract is incomplete';
  END IF;

END;
$$;
