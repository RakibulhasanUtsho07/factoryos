-- Schema-level isolation acceptance matrix for tenant export, retention, usage and audit.
-- The API integration tests exercise denied foreign-tenant IDs; this contract proves
-- PostgreSQL itself enforces tenant context for the critical persistence surfaces.
DO $$
DECLARE
  table_name text;
  relation_oid oid;
  policy_count integer;
  policy_definition text;
  protected_tables text[] := ARRAY[
    'audit_events',
    'saas_schema_compatibility_rules',
    'saas_tenant_data_transfers',
    'saas_tenant_data_retention_policies',
    'saas_tenant_data_legal_holds',
    'saas_tenant_data_erasure_requests',
    'saas_tenant_data_export_preservation_attestations',
    'saas_tenant_data_retention_runs',
    'saas_tenant_data_erasure_runs',
    'saas_usage_rate_cards',
    'saas_usage_events',
    'saas_usage_adjustments',
    'saas_usage_reconciliations',
    'saas_usage_budgets',
    'saas_budget_evaluations',
    'saas_budget_alerts',
    'saas_budget_alert_acknowledgements',
    'saas_provider_cost_events',
    'saas_provider_cost_reconciliations',
    'saas_entitlement_enforcement_modes'
  ];
BEGIN
  FOREACH table_name IN ARRAY protected_tables LOOP
    relation_oid := to_regclass(format('public.%I', table_name));
    IF relation_oid IS NULL THEN
      RAISE EXCEPTION 'isolation matrix references missing relation %', table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid=relation_oid AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'cross-tenant isolation requires ENABLE and FORCE RLS on %', table_name;
    END IF;

    SELECT COUNT(*), string_agg(
      COALESCE(pg_get_expr(p.polqual,p.polrelid),'') || ' ' ||
      COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),''),
      ' '
    )
    INTO policy_count, policy_definition
    FROM pg_policy p
    WHERE p.polrelid=relation_oid
      AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
      AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%tenant_id%'
      AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
      AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%tenant_id%';
    IF policy_count=0 THEN
      RAISE EXCEPTION 'no USING and WITH CHECK tenant policy tied to factoryos_current_tenant_id() for %', table_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.saas_tenant_data_transfers'::regclass
      AND conname='uq_saas_tenant_data_transfer_scope_version'
  ) THEN
    -- Name variants are allowed; require an equivalent tenant-bound unique key
    -- by checking any unique index containing tenant_id, transfer_id and version.
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid='public.saas_tenant_data_transfers'::regclass AND i.indisunique
        AND (
          SELECT COUNT(*) FROM unnest(i.indkey) k(attnum)
          JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
          WHERE a.attname IN ('tenant_id','transfer_id','version')
        )=3
    ) THEN
      RAISE EXCEPTION 'data-transfer IDs and versions must be tenant-bound';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.saas_tenant_data_erasure_requests'::regclass
      AND contype='f' AND conname='fk_saas_tenant_erasure_export'
  ) THEN
    RAISE EXCEPTION 'erasure requests must reference an export in the same tenant';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.saas_tenant_data_erasure_runs'::regclass
      AND contype='f' AND conname='fk_saas_erasure_run_request'
  ) THEN
    RAISE EXCEPTION 'erasure receipts must be linked to the exact tenant request';
  END IF;
END $$;
