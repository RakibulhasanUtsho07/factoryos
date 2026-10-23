-- Task 23: physical provider operation receipts must remain tenant-isolated and immutable.
DO $physical_contract$
DECLARE
  v_relation_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version='186_saas_physical_infrastructure_execution'
  ) THEN
    RAISE EXCEPTION 'SAAS_PHYSICAL_INFRASTRUCTURE_MIGRATION_MARKER_MISSING';
  END IF;

  FOREACH v_relation_name IN ARRAY ARRAY[
    'saas_physical_provisioning_runs',
    'saas_physical_provisioning_events'
  ] LOOP
    IF to_regclass('public.' || quote_ident(v_relation_name)) IS NULL THEN
      RAISE EXCEPTION 'SAAS_PHYSICAL_INFRASTRUCTURE_TABLE_MISSING: %', v_relation_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid=to_regclass('public.' || quote_ident(v_relation_name))
        AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'SAAS_PHYSICAL_INFRASTRUCTURE_RLS_NOT_FORCED: %', v_relation_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname='public' AND p.tablename=relation_name
        AND p.policyname=relation_name || '_tenant_isolation'
        AND COALESCE(p.qual,'') ILIKE '%factoryos_current_tenant_id%'
        AND COALESCE(p.with_check,'') ILIKE '%factoryos_current_tenant_id%'
    ) THEN
      RAISE EXCEPTION 'SAAS_PHYSICAL_INFRASTRUCTURE_TENANT_POLICY_MISSING: %', v_relation_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname='public' AND p.tablename=relation_name
        AND p.policyname='fo_privacy_scope_enforce' AND p.permissive='RESTRICTIVE'
        AND COALESCE(p.qual,'') ILIKE '%factoryos_current_tenant_id%'
        AND COALESCE(p.with_check,'') ILIKE '%factoryos_current_tenant_id%'
    ) THEN
      RAISE EXCEPTION 'SAAS_PHYSICAL_INFRASTRUCTURE_RESTRICTIVE_FENCE_MISSING: %', v_relation_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM factoryos_governance.tenant_relation_inventory i
      WHERE i.schema_name='public' AND i.relation_name=v_relation_name
        AND i.scope_model='DIRECT_TENANT_ID' AND i.export_disposition='EXCLUDED'
        AND i.erasure_disposition='BLOCKED_FINANCE_REVIEW'
    ) THEN
      RAISE EXCEPTION 'SAAS_PHYSICAL_INFRASTRUCTURE_PRIVACY_INVENTORY_MISSING: %', v_relation_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM factoryos_governance.tenant_relation_ownership_reviews r
      WHERE r.schema_name='public' AND r.relation_name=v_relation_name
        AND r.ownership_class='DIRECT_TENANT' AND r.review_status='VERIFIED'
        AND r.erasure_disposition='BLOCKED_FINANCE_REVIEW'
    ) THEN
      RAISE EXCEPTION 'SAAS_PHYSICAL_INFRASTRUCTURE_OWNERSHIP_REVIEW_MISSING: %', v_relation_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgname='saas_physical_provisioning_runs_immutable' AND NOT t.tgisinternal
      AND t.tgrelid='public.saas_physical_provisioning_runs'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgname='saas_physical_provisioning_events_immutable' AND NOT t.tgisinternal
      AND t.tgrelid='public.saas_physical_provisioning_events'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgname='saas_physical_event_state_guard' AND NOT t.tgisinternal
      AND t.tgrelid='public.saas_physical_provisioning_events'::regclass
  ) THEN
    RAISE EXCEPTION 'SAAS_PHYSICAL_INFRASTRUCTURE_IMMUTABILITY_OR_STATE_GUARD_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='uq_saas_physical_run_idempotency'
      AND conrelid='public.saas_physical_provisioning_runs'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='uq_saas_physical_event_version'
      AND conrelid='public.saas_physical_provisioning_events'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM permissions WHERE code='saas.physical_provisioning.read'
  ) THEN
    RAISE EXCEPTION 'SAAS_PHYSICAL_INFRASTRUCTURE_IDEMPOTENCY_OR_PERMISSION_MISSING';
  END IF;
END $physical_contract$;

SELECT 'SaaS physical provisioning tenant isolation, immutable receipts and guarded lifecycle passed' AS result;
