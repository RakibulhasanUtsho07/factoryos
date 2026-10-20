-- Schema-wide tenant privacy contract; intentionally fails when a new relation
-- with tenant_id is not inventoried, RLS-protected, or explicitly classified.
DO $$
DECLARE
  relation record;
  missing_count integer;
  allowlist_count integer;
BEGIN
  IF to_regclass('factoryos_governance.tenant_relation_inventory') IS NULL THEN
    RAISE EXCEPTION 'tenant relation inventory is missing; migration 156 must run first';
  END IF;

  SELECT count(*) INTO missing_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN factoryos_governance.tenant_relation_inventory i
    ON i.schema_name = n.nspname AND i.relation_name = c.relname
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
    AND i.relation_name IS NULL;
  IF missing_count <> 0 THEN
    RAISE EXCEPTION '% public base/partition relation(s) are missing from the privacy inventory', missing_count;
  END IF;

  SELECT count(*) INTO missing_count
  FROM factoryos_governance.tenant_relation_inventory i
  LEFT JOIN pg_namespace n ON n.nspname = i.schema_name
  LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = i.relation_name
  WHERE i.schema_name = 'public'
    AND (
      c.oid IS NULL
      OR (i.scope_model = 'DIRECT_TENANT_ID' AND NOT EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
          AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
      ))
      OR (i.scope_model = 'DERIVED_TENANT_RELATIONSHIP'
          AND i.relation_name NOT IN ('user_roles','role_permissions'))
      OR (i.scope_model = 'NO_DIRECT_TENANT_ID' AND EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
          AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
      ))
      OR (i.scope_model = 'NO_DIRECT_TENANT_ID' AND (
        i.export_disposition <> 'EXCLUDED'
        OR i.erasure_disposition <> 'BLOCKED_UNREVIEWED'
        OR i.data_category <> 'UNREVIEWED'
      ))
    );
  IF missing_count <> 0 THEN
    RAISE EXCEPTION '% stale or invalid public relations exist in the tenant privacy inventory', missing_count;
  END IF;

  FOR relation IN
    SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
      AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
    ORDER BY c.relname
  LOOP
    IF NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity THEN
      RAISE EXCEPTION 'ENABLE and FORCE RLS are required for public.%', relation.relname;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = relation.oid AND p.polpermissive
    ) THEN
      RAISE EXCEPTION 'No permissive policy exists for public.%', relation.relname;
    END IF;

    IF relation.relname = 'ai_tool_registry' THEN
      -- Preserve the explicit SELECT-only global visibility and tenant-only
      -- INSERT contract; no generic FOR ALL policy may enable UPDATE/DELETE.
      IF NOT EXISTS (
        SELECT 1 FROM pg_policy p
        WHERE p.polrelid = relation.oid AND p.polname = 'ai_tool_registry_select_scope'
          AND p.polcmd = 'r' AND p.polpermissive
          AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%tenant_id IS NULL%'
          AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy p
        WHERE p.polrelid = relation.oid AND p.polname = 'ai_tool_registry_insert_tenant_scope'
          AND p.polcmd = 'a' AND p.polpermissive
          AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
          AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%tenant_id%'
      ) THEN
        RAISE EXCEPTION 'AI tool registry must preserve global SELECT and tenant-only INSERT policies';
      END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = relation.oid AND p.polname = 'fo_privacy_scope_enforce'
        AND NOT p.polpermissive
        AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
        AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
        AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%tenant_id%'
        AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%tenant_id%'
    ) THEN
      RAISE EXCEPTION 'Tenant-bound restrictive isolation fence missing for public.%', relation.relname;
    END IF;
  END LOOP;

  -- Generic export may never grow by naming convention alone. Each direct table
  -- must match the reviewed data-source adapter allowlist.
  SELECT count(*) INTO allowlist_count
  FROM factoryos_governance.tenant_relation_inventory i
  WHERE i.schema_name = 'public'
    AND i.scope_model = 'DIRECT_TENANT_ID'
    AND i.export_disposition = 'ALLOWLISTED'
    AND i.relation_name <> ALL(ARRAY[
      'legal_entities','factories','orders','order_lines','order_event_projections',
      'inventory_items','inventory_stock_balances','inventory_movements',
      'business_blueprints','business_blueprint_versions','business_entities','business_relations',
      'business_processes','business_process_steps','business_rules','business_terms','business_exceptions',
      'business_change_proposals','business_conflicts','business_feedback','growth_opportunities',
      'growth_scenarios','growth_experiments','saas_usage_events','saas_usage_adjustments',
      'saas_usage_reconciliations','saas_budget_evaluations','saas_workload_control_events',
      'saas_budget_alerts','saas_budget_alert_acknowledgements','saas_provider_cost_events',
      'saas_provider_cost_reconciliations','audit_events','business_evidence','business_evidence_links',
      'growth_opportunity_evidence','approvals','risk_classes','policies','saas_usage_rate_cards',
      'saas_usage_budgets','ai_decision_envelopes','ai_context_packages','ai_verification_runs',
      'research_sources','research_claims','research_claim_links','research_knowledge_releases',
      'research_relevance_mappings','research_release_evaluations','growth_experiment_results',
      'growth_opportunity_outcomes','tenant_memberships','roles'
    ]::text[]);
  IF allowlist_count <> 0 THEN
    RAISE EXCEPTION '% direct tenant table(s) were allowlisted without a reviewed export adapter', allowlist_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM factoryos_governance.tenant_relation_inventory
    WHERE export_disposition = 'EXCLUDED'
      AND (length(btrim(rationale)) < 12 OR erasure_disposition NOT IN
        ('BLOCKED_FINANCE_REVIEW','BLOCKED_UNREVIEWED','PROTECTED'))
  ) THEN
    RAISE EXCEPTION 'Excluded tenant data must have a rationale and fail-closed erasure disposition';
  END IF;

  IF EXISTS (
    SELECT 1 FROM (VALUES ('user_roles'),('role_permissions')) x(relation_name)
    LEFT JOIN factoryos_governance.tenant_relation_inventory i
      ON i.schema_name='public' AND i.relation_name=x.relation_name
     AND i.scope_model='DERIVED_TENANT_RELATIONSHIP'
    LEFT JOIN pg_class c ON c.oid=to_regclass('public.' || x.relation_name)
    WHERE i.relation_name IS NULL OR c.oid IS NULL
      OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity
      OR NOT EXISTS (
        SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid
          AND p.polpermissive
      )
      OR NOT EXISTS (
        SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid
          AND p.polname='fo_privacy_scope_enforce' AND NOT p.polpermissive
          AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
          AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
          AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%tenant_id%'
          AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%tenant_id%'
          AND CASE WHEN x.relation_name='user_roles'
            THEN COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%tenant_memberships%'
              AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%roles%'
              AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%factories%'
              AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%tenant_memberships%'
              AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%roles%'
              AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%factories%'
            ELSE COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%roles%'
              AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%roles%'
          END
      )
  ) THEN
    RAISE EXCEPTION 'IAM relationship tables require derived tenant scope, forced RLS and restrictive tenant fences';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM factoryos_governance.tenant_relation_inventory
    WHERE schema_name='public' AND relation_name='audit_events'
      AND scope_model='DIRECT_TENANT_ID' AND data_category='AUDIT_LOG'
      AND export_disposition='ALLOWLISTED'
      AND audit_requirement='APPEND_ONLY_AUDIT' AND erasure_disposition='PROTECTED'
  ) THEN
    RAISE EXCEPTION 'Audit events must remain tenant-scoped, exportable as evidence and protected from generic erasure';
  END IF;

  IF EXISTS (
    SELECT 1 FROM factoryos_governance.tenant_relation_inventory
    WHERE relation_name IN (
      'saas_usage_events','saas_usage_adjustments','saas_usage_reconciliations',
      'saas_usage_rate_cards','saas_usage_budgets','saas_budget_evaluations',
      'saas_workload_control_events','saas_budget_alerts','saas_budget_alert_acknowledgements',
      'saas_provider_cost_events','saas_provider_cost_reconciliations'
    ) AND erasure_disposition <> 'BLOCKED_FINANCE_REVIEW'
  ) THEN
    RAISE EXCEPTION 'Finance and SaaS metering ledgers must require a separately approved retention workflow';
  END IF;
END
$$;
