BEGIN;

-- Build a schema-wide privacy inventory. Only explicitly allowlisted relations
-- may participate in generic tenant export; all other tenant-owned relations
-- remain explicitly excluded until their category adapters and evidence are reviewed.
CREATE SCHEMA IF NOT EXISTS factoryos_governance;
REVOKE ALL ON SCHEMA factoryos_governance FROM PUBLIC;

CREATE TABLE IF NOT EXISTS factoryos_governance.tenant_relation_inventory (
  schema_name text NOT NULL,
  relation_name text NOT NULL,
  scope_model varchar(40) NOT NULL,
  data_category varchar(40) NOT NULL,
  export_disposition varchar(20) NOT NULL,
  erasure_disposition varchar(32) NOT NULL,
  audit_requirement varchar(40) NOT NULL,
  rationale text NOT NULL,
  classified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (schema_name, relation_name),
  CONSTRAINT chk_factoryos_privacy_inventory_scope CHECK (
    scope_model IN ('DIRECT_TENANT_ID', 'DERIVED_TENANT_RELATIONSHIP')
  ),
  CONSTRAINT chk_factoryos_privacy_inventory_category CHECK (
    data_category IN (
      'BUSINESS_DATA', 'AUDIT_LOG', 'EVIDENCE', 'APPROVALS',
      'EFFECTIVE_DATED_MASTER_DATA', 'AI_CONTEXT', 'LEARNING_EVALUATION',
      'IAM_ACCESS', 'INTEGRATION_METADATA', 'FILE_REFERENCES',
      'SAAS_CONTROL_PLANE', 'UNREVIEWED'
    )
  ),
  CONSTRAINT chk_factoryos_privacy_inventory_export CHECK (
    export_disposition IN ('ALLOWLISTED', 'EXCLUDED')
  ),
  CONSTRAINT chk_factoryos_privacy_inventory_erasure CHECK (
    erasure_disposition IN (
      'BOUNDED_ADAPTER', 'PROTECTED', 'BLOCKED_FINANCE_REVIEW', 'BLOCKED_UNREVIEWED'
    )
  ),
  CONSTRAINT chk_factoryos_privacy_inventory_audit CHECK (
    audit_requirement IN (
      'APPEND_ONLY_AUDIT', 'TRANSACTIONAL_AUDIT', 'DOMAIN_LEDGER_OR_AUDIT_REVIEW',
      'REVIEW_REQUIRED'
    )
  ),
  CONSTRAINT chk_factoryos_privacy_inventory_rationale CHECK (length(btrim(rationale)) >= 12)
);
REVOKE ALL ON TABLE factoryos_governance.tenant_relation_inventory FROM PUBLIC;

DO $$
DECLARE
  item record;
  tenant_predicate text;
  category text;
  is_export_allowlisted boolean;
  erasure_policy text;
  audit_policy text;
  inventory_reason text;
BEGIN
  IF to_regprocedure('public.factoryos_current_tenant_id()') IS NULL THEN
    RAISE EXCEPTION 'tenant privacy guard requires factoryos_current_tenant_id()';
  END IF;

  -- A restrictive policy ANDs the tenant predicate with any existing permissive
  -- policy. This protects against an accidentally broad USING (true) policy.
  FOR item IN
    SELECT n.nspname AS schema_name, c.relname AS relation_name,
           a.atttypid = 'uuid'::regtype AS tenant_id_is_uuid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
      AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
    ORDER BY c.relname
  LOOP
    tenant_predicate := CASE
      WHEN item.tenant_id_is_uuid
        THEN 'tenant_id = public.factoryos_current_tenant_id()'
      ELSE 'tenant_id::text = public.factoryos_current_tenant_id()::text'
    END;

    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', item.schema_name, item.relation_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', item.schema_name, item.relation_name);

    -- Preserve any existing permissive policy: adding another permissive rule
    -- would OR with it and could weaken a narrower in-tenant access policy.
    EXECUTE format('DROP POLICY IF EXISTS fo_privacy_scope_allow ON %I.%I', item.schema_name, item.relation_name);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = to_regclass(format('%I.%I', item.schema_name, item.relation_name))
        AND p.polpermissive
    ) THEN
      EXECUTE format(
        'CREATE POLICY fo_privacy_scope_allow ON %I.%I AS PERMISSIVE FOR ALL USING (%s) WITH CHECK (%s)',
        item.schema_name, item.relation_name, tenant_predicate, tenant_predicate
      );
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS fo_privacy_scope_enforce ON %I.%I', item.schema_name, item.relation_name);
    EXECUTE format(
      'CREATE POLICY fo_privacy_scope_enforce ON %I.%I AS RESTRICTIVE FOR ALL USING (%s) WITH CHECK (%s)',
      item.schema_name, item.relation_name, tenant_predicate, tenant_predicate
    );

    is_export_allowlisted := item.relation_name IN (
      'legal_entities', 'factories', 'orders', 'order_lines', 'order_event_projections',
      'inventory_items', 'inventory_stock_balances', 'inventory_movements',
      'business_blueprints', 'business_blueprint_versions', 'business_entities',
      'business_relations', 'business_processes', 'business_process_steps', 'business_rules',
      'business_terms', 'business_exceptions', 'business_change_proposals', 'business_conflicts',
      'business_feedback', 'growth_opportunities', 'growth_scenarios', 'growth_experiments',
      'saas_usage_events', 'saas_usage_adjustments', 'saas_usage_reconciliations',
      'saas_budget_evaluations', 'saas_workload_control_events', 'saas_budget_alerts',
      'saas_budget_alert_acknowledgements', 'saas_provider_cost_events',
      'saas_provider_cost_reconciliations', 'audit_events', 'business_evidence',
      'business_evidence_links', 'growth_opportunity_evidence', 'approvals',
      'risk_classes', 'policies', 'saas_usage_rate_cards', 'saas_usage_budgets',
      'ai_decision_envelopes', 'ai_context_packages', 'ai_verification_runs',
      'research_sources', 'research_claims', 'research_claim_links',
      'research_knowledge_releases', 'research_relevance_mappings',
      'research_release_evaluations', 'growth_experiment_results',
      'growth_opportunity_outcomes', 'tenant_memberships', 'roles'
    );

    category := CASE
      WHEN item.relation_name IN (
        'legal_entities', 'factories', 'orders', 'order_lines', 'order_event_projections',
        'inventory_items', 'inventory_stock_balances', 'inventory_movements',
        'business_blueprints', 'business_blueprint_versions', 'business_entities',
        'business_relations', 'business_processes', 'business_process_steps', 'business_rules',
        'business_terms', 'business_exceptions', 'business_change_proposals', 'business_conflicts',
        'business_feedback', 'growth_opportunities', 'growth_scenarios', 'growth_experiments',
        'saas_usage_events', 'saas_usage_adjustments', 'saas_usage_reconciliations',
        'saas_budget_evaluations', 'saas_workload_control_events', 'saas_budget_alerts',
        'saas_budget_alert_acknowledgements', 'saas_provider_cost_events',
        'saas_provider_cost_reconciliations'
      ) THEN 'BUSINESS_DATA'
      WHEN item.relation_name = 'audit_events' THEN 'AUDIT_LOG'
      WHEN item.relation_name IN ('business_evidence', 'business_evidence_links', 'growth_opportunity_evidence')
        THEN 'EVIDENCE'
      WHEN item.relation_name = 'approvals' THEN 'APPROVALS'
      WHEN item.relation_name IN ('risk_classes', 'policies', 'saas_usage_rate_cards', 'saas_usage_budgets')
        THEN 'EFFECTIVE_DATED_MASTER_DATA'
      WHEN item.relation_name IN (
        'ai_decision_envelopes', 'ai_context_packages', 'ai_verification_runs',
        'research_sources', 'research_claims', 'research_claim_links',
        'research_knowledge_releases', 'research_relevance_mappings'
      ) THEN 'AI_CONTEXT'
      WHEN item.relation_name IN (
        'research_release_evaluations', 'growth_experiment_results', 'growth_opportunity_outcomes'
      ) THEN 'LEARNING_EVALUATION'
      WHEN item.relation_name IN ('tenant_memberships', 'roles') THEN 'IAM_ACCESS'
      WHEN item.relation_name ~* '(integration|connector|webhook)' THEN 'INTEGRATION_METADATA'
      WHEN item.relation_name ~* '(file|attachment|blob|object_reference)' THEN 'FILE_REFERENCES'
      WHEN item.relation_name LIKE 'saas_%' OR item.relation_name LIKE '%tenant_data_%'
        OR item.relation_name LIKE '%tenant_import_%' THEN 'SAAS_CONTROL_PLANE'
      WHEN item.relation_name LIKE 'ai_%' OR item.relation_name LIKE 'research_%'
        OR item.relation_name LIKE 'growth_%' THEN 'AI_CONTEXT'
      WHEN item.relation_name LIKE '%evidence%' THEN 'EVIDENCE'
      WHEN item.relation_name LIKE '%approval%' THEN 'APPROVALS'
      ELSE 'UNREVIEWED'
    END;

    erasure_policy := CASE
      WHEN item.relation_name IN (
        'saas_usage_events', 'saas_usage_adjustments', 'saas_usage_reconciliations',
        'saas_usage_rate_cards', 'saas_usage_budgets', 'saas_budget_evaluations',
        'saas_workload_control_events', 'saas_budget_alerts', 'saas_budget_alert_acknowledgements',
        'saas_provider_cost_events', 'saas_provider_cost_reconciliations'
      ) THEN 'BLOCKED_FINANCE_REVIEW'
      WHEN category IN ('AUDIT_LOG', 'APPROVALS', 'EFFECTIVE_DATED_MASTER_DATA', 'IAM_ACCESS')
        THEN 'PROTECTED'
      WHEN is_export_allowlisted AND category <> 'UNREVIEWED' THEN 'BOUNDED_ADAPTER'
      ELSE 'BLOCKED_UNREVIEWED'
    END;

    audit_policy := CASE
      WHEN item.relation_name = 'audit_events' THEN 'APPEND_ONLY_AUDIT'
      WHEN item.relation_name LIKE 'saas_tenant_data_%'
        OR item.relation_name IN ('saas_schema_compatibility_rules', 'saas_tenant_data_transfers')
        THEN 'TRANSACTIONAL_AUDIT'
      WHEN is_export_allowlisted THEN 'DOMAIN_LEDGER_OR_AUDIT_REVIEW'
      ELSE 'REVIEW_REQUIRED'
    END;

    inventory_reason := CASE
      WHEN is_export_allowlisted THEN
        'Explicit source/target adapter allowlist; runtime still verifies tenant, RLS, manifest and dependency constraints.'
      WHEN category = 'UNREVIEWED' THEN
        'Fail-closed exclusion: no reviewed category adapter or audit/deletion evidence is registered for this relation.'
      ELSE
        'Classified for inventory only; excluded from generic export and deletion until a category-specific adapter is reviewed.'
    END;

    INSERT INTO factoryos_governance.tenant_relation_inventory (
      schema_name, relation_name, scope_model, data_category, export_disposition,
      erasure_disposition, audit_requirement, rationale
    ) VALUES (
      item.schema_name, item.relation_name, 'DIRECT_TENANT_ID', category,
      CASE WHEN is_export_allowlisted THEN 'ALLOWLISTED' ELSE 'EXCLUDED' END,
      erasure_policy, audit_policy, inventory_reason
    )
    ON CONFLICT (schema_name, relation_name) DO UPDATE SET
      scope_model = EXCLUDED.scope_model,
      data_category = EXCLUDED.data_category,
      export_disposition = EXCLUDED.export_disposition,
      erasure_disposition = EXCLUDED.erasure_disposition,
      audit_requirement = EXCLUDED.audit_requirement,
      rationale = EXCLUDED.rationale,
      classified_at = clock_timestamp();
  END LOOP;
END;
$$;

-- These relationship tables have no tenant_id column. Their scope is derived
-- from the tenant-owned membership, role and factory relations.
DO $$
DECLARE
  item record;
  tenant_predicate text;
BEGIN
  FOR item IN
    SELECT relation_name
    FROM (VALUES ('role_permissions'), ('user_roles')) AS names(relation_name)
    WHERE to_regclass('public.' || relation_name) IS NOT NULL
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', item.relation_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', item.relation_name);

    IF item.relation_name = 'role_permissions' THEN
      tenant_predicate := 'EXISTS (SELECT 1 FROM public.roles r WHERE r.id = public.role_permissions.role_id AND r.tenant_id = public.factoryos_current_tenant_id())';
    ELSE
      tenant_predicate := 'public.factoryos_current_tenant_id() IS NOT NULL'
        || ' AND EXISTS (SELECT 1 FROM public.tenant_memberships tm WHERE tm.id = public.user_roles.membership_id AND tm.tenant_id = public.factoryos_current_tenant_id())'
        || ' AND EXISTS (SELECT 1 FROM public.roles r WHERE r.id = public.user_roles.role_id AND r.tenant_id = public.factoryos_current_tenant_id())'
        || ' AND (public.user_roles.factory_id IS NULL OR EXISTS (SELECT 1 FROM public.factories f WHERE f.id = public.user_roles.factory_id AND f.tenant_id = public.factoryos_current_tenant_id()))';
    END IF;

    -- Keep the pre-existing membership/role policy if present; only seed a
    -- tenant-scoped permissive fallback when the table otherwise has no access policy.
    EXECUTE format('DROP POLICY IF EXISTS fo_privacy_scope_allow ON public.%I', item.relation_name);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = to_regclass('public.' || item.relation_name)
        AND p.polpermissive
    ) THEN
      EXECUTE format(
        'CREATE POLICY fo_privacy_scope_allow ON public.%I AS PERMISSIVE FOR ALL USING (%s) WITH CHECK (%s)',
        item.relation_name, tenant_predicate, tenant_predicate
      );
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS fo_privacy_scope_enforce ON public.%I', item.relation_name);
    EXECUTE format(
      'CREATE POLICY fo_privacy_scope_enforce ON public.%I AS RESTRICTIVE FOR ALL USING (%s) WITH CHECK (%s)',
      item.relation_name, tenant_predicate, tenant_predicate
    );

    INSERT INTO factoryos_governance.tenant_relation_inventory (
      schema_name, relation_name, scope_model, data_category, export_disposition,
      erasure_disposition, audit_requirement, rationale
    ) VALUES (
      'public', item.relation_name, 'DERIVED_TENANT_RELATIONSHIP', 'IAM_ACCESS',
      'ALLOWLISTED', 'PROTECTED', 'DOMAIN_LEDGER_OR_AUDIT_REVIEW',
      'Tenant scope is derived from tenant_memberships, roles and optional factories; IAM transfer uses logical remapping rather than raw row copies.'
    )
    ON CONFLICT (schema_name, relation_name) DO UPDATE SET
      scope_model = EXCLUDED.scope_model,
      data_category = EXCLUDED.data_category,
      export_disposition = EXCLUDED.export_disposition,
      erasure_disposition = EXCLUDED.erasure_disposition,
      audit_requirement = EXCLUDED.audit_requirement,
      rationale = EXCLUDED.rationale,
      classified_at = clock_timestamp();
  END LOOP;
END;
$$;

INSERT INTO schema_migrations(version, checksum)
VALUES ('156_tenant_privacy_inventory_and_rls_guardrails', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
