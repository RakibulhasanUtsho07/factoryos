BEGIN;

-- Pin the API source adapter's exact table sets in a migration-owned ledger.
-- Runtime roles receive no SELECT/INSERT/UPDATE/DELETE grants on this table;
-- the SECURITY DEFINER guard compares the submitted source map to this ledger.
CREATE TABLE IF NOT EXISTS factoryos_governance.tenant_export_adapter_relation_registry (
  data_category varchar(40) NOT NULL,
  relation_name text NOT NULL,
  PRIMARY KEY (data_category, relation_name),
  CONSTRAINT chk_tenant_export_adapter_registry_category CHECK (
    data_category IN (
      'BUSINESS_DATA', 'AUDIT_LOG', 'EVIDENCE', 'APPROVALS',
      'EFFECTIVE_DATED_MASTER_DATA', 'AI_CONTEXT', 'LEARNING_EVALUATION',
      'IAM_ACCESS'
    )
  ),
  CONSTRAINT chk_tenant_export_adapter_registry_relation CHECK (
    length(btrim(relation_name)) > 0
  )
);
REVOKE ALL ON TABLE factoryos_governance.tenant_export_adapter_relation_registry FROM PUBLIC;
DO $revoke_runtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'factoryos_app') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE factoryos_governance.tenant_export_adapter_relation_registry FROM factoryos_app';
  END IF;
END
$revoke_runtime$;

INSERT INTO factoryos_governance.tenant_export_adapter_relation_registry (data_category, relation_name) VALUES
  ('BUSINESS_DATA','legal_entities'),
  ('BUSINESS_DATA','factories'),
  ('BUSINESS_DATA','inventory_locations'),
  ('BUSINESS_DATA','traceability_settings'),
  ('BUSINESS_DATA','orders'),
  ('BUSINESS_DATA','order_lines'),
  ('BUSINESS_DATA','order_event_projections'),
  ('BUSINESS_DATA','inventory_items'),
  ('BUSINESS_DATA','inventory_stock_balances'),
  ('BUSINESS_DATA','inventory_movements'),
  ('BUSINESS_DATA','business_blueprints'),
  ('BUSINESS_DATA','business_blueprint_versions'),
  ('BUSINESS_DATA','business_entities'),
  ('BUSINESS_DATA','business_relations'),
  ('BUSINESS_DATA','business_processes'),
  ('BUSINESS_DATA','business_process_steps'),
  ('BUSINESS_DATA','business_rules'),
  ('BUSINESS_DATA','business_terms'),
  ('BUSINESS_DATA','business_exceptions'),
  ('BUSINESS_DATA','business_change_proposals'),
  ('BUSINESS_DATA','business_conflicts'),
  ('BUSINESS_DATA','business_feedback'),
  ('BUSINESS_DATA','growth_opportunities'),
  ('BUSINESS_DATA','growth_scenarios'),
  ('BUSINESS_DATA','growth_experiments'),
  ('BUSINESS_DATA','saas_usage_events'),
  ('BUSINESS_DATA','saas_usage_adjustments'),
  ('BUSINESS_DATA','saas_usage_reconciliations'),
  ('BUSINESS_DATA','saas_budget_evaluations'),
  ('BUSINESS_DATA','saas_workload_control_events'),
  ('BUSINESS_DATA','saas_budget_alerts'),
  ('BUSINESS_DATA','saas_budget_alert_acknowledgements'),
  ('BUSINESS_DATA','saas_provider_cost_events'),
  ('BUSINESS_DATA','saas_provider_cost_reconciliations'),
  ('AUDIT_LOG','audit_events'),
  ('EVIDENCE','business_evidence'),
  ('EVIDENCE','business_evidence_links'),
  ('EVIDENCE','growth_opportunity_evidence'),
  ('APPROVALS','approvals'),
  ('EFFECTIVE_DATED_MASTER_DATA','risk_classes'),
  ('EFFECTIVE_DATED_MASTER_DATA','policies'),
  ('EFFECTIVE_DATED_MASTER_DATA','saas_usage_rate_cards'),
  ('EFFECTIVE_DATED_MASTER_DATA','saas_usage_budgets'),
  ('AI_CONTEXT','ai_decision_envelopes'),
  ('AI_CONTEXT','ai_context_packages'),
  ('AI_CONTEXT','ai_verification_runs'),
  ('AI_CONTEXT','research_sources'),
  ('AI_CONTEXT','research_claims'),
  ('AI_CONTEXT','research_claim_links'),
  ('AI_CONTEXT','research_knowledge_releases'),
  ('AI_CONTEXT','research_relevance_mappings'),
  ('LEARNING_EVALUATION','research_release_evaluations'),
  ('LEARNING_EVALUATION','growth_experiment_results'),
  ('LEARNING_EVALUATION','growth_opportunity_outcomes'),
  ('IAM_ACCESS','tenant_memberships'),
  ('IAM_ACCESS','roles'),
  ('IAM_ACCESS','user_roles'),
  ('IAM_ACCESS','role_permissions')
ON CONFLICT (data_category, relation_name) DO NOTHING;

-- inventory_locations is a direct, tenant-owned business relation. Factories
-- create one default virtual location automatically; it is part of exportable
-- BUSINESS_DATA. Generic erasure remains blocked until the retention/delete
-- adapter has an explicit dependency-safe location mapping.
DO $inventory_location_export$
DECLARE
  changed integer;
BEGIN
  IF to_regclass('public.inventory_locations') IS NULL THEN
    RAISE EXCEPTION 'Expected inventory_locations relation is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.inventory_locations'::regclass
      AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.inventory_locations'::regclass
      AND a.attname = 'id' AND a.atttypid = 'uuid'::regtype
      AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'inventory_locations does not satisfy the direct-tenant UUID source contract';
  END IF;

  UPDATE factoryos_governance.tenant_relation_inventory
  SET data_category = 'BUSINESS_DATA',
      export_disposition = 'ALLOWLISTED',
      erasure_disposition = 'BLOCKED_UNREVIEWED',
      audit_requirement = 'DOMAIN_LEDGER_OR_AUDIT_REVIEW',
      rationale = 'Direct tenant UUID relation explicitly included in the BUSINESS_DATA source/target transfer adapter; erasure remains blocked until its dependency-safe retention adapter is reviewed.'
  WHERE schema_name = 'public' AND relation_name = 'inventory_locations'
    AND scope_model = 'DIRECT_TENANT_ID';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'inventory_locations privacy inventory classification could not be reviewed';
  END IF;

  UPDATE factoryos_governance.tenant_relation_ownership_reviews
  SET export_disposition = 'ALLOWLISTED',
      erasure_disposition = 'BLOCKED_UNREVIEWED',
      evidence_detail = 'Direct tenant_id and UUID id verified. Included in the reviewed BUSINESS_DATA export/import adapter; generic erasure remains blocked pending dependency-safe location/balance/transfer retention review.',
      review_status = 'VERIFIED',
      reviewed_at = clock_timestamp()
  WHERE schema_name = 'public' AND relation_name = 'inventory_locations'
    AND ownership_class = 'DIRECT_TENANT';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'inventory_locations ownership review could not be verified';
  END IF;
END
$inventory_location_export$;

-- traceability_settings is a direct tenant/factory composite-key configuration
-- row auto-created with each factory. It is required to preserve the tenant's
-- traceability-retention and FIFO/FEFO/LOT/SERIAL behavior during migration.
-- It is exportable through a dedicated composite-key adapter; generic erasure
-- remains blocked until a retention/dependency policy for traceability history
-- is approved.
DO $traceability_settings_export$
DECLARE
  changed integer;
  primary_key_columns text[];
BEGIN
  IF to_regclass('public.traceability_settings') IS NULL THEN
    RAISE EXCEPTION 'Expected traceability_settings relation is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.traceability_settings'::regclass
      AND a.attname = 'tenant_id' AND a.atttypid = 'uuid'::regtype
      AND a.attnum > 0 AND NOT a.attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.traceability_settings'::regclass
      AND a.attname = 'factory_id' AND a.atttypid = 'uuid'::regtype
      AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'traceability_settings does not satisfy the reviewed composite tenant/factory contract';
  END IF;

  SELECT array_agg(a.attname ORDER BY keys.ordinality)
    INTO primary_key_columns
  FROM pg_catalog.pg_constraint c
  JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS keys(attnum, ordinality) ON TRUE
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid = c.conrelid AND a.attnum = keys.attnum
  WHERE c.conrelid = 'public.traceability_settings'::regclass
    AND c.contype = 'p';
  IF primary_key_columns IS DISTINCT FROM ARRAY['tenant_id','factory_id']::text[] THEN
    RAISE EXCEPTION 'traceability_settings composite key is not the reviewed (tenant_id,factory_id) key';
  END IF;

  UPDATE factoryos_governance.tenant_relation_inventory
  SET data_category = 'BUSINESS_DATA',
      export_disposition = 'ALLOWLISTED',
      erasure_disposition = 'BLOCKED_UNREVIEWED',
      audit_requirement = 'DOMAIN_LEDGER_OR_AUDIT_REVIEW',
      rationale = 'Factory-scoped traceability retention/allocation configuration is transferred through the reviewed composite-key adapter; generic erasure remains blocked pending traceability-history retention review.'
  WHERE schema_name = 'public' AND relation_name = 'traceability_settings'
    AND scope_model = 'DIRECT_TENANT_ID';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'traceability_settings privacy inventory classification could not be reviewed';
  END IF;

  UPDATE factoryos_governance.tenant_relation_ownership_reviews
  SET export_disposition = 'ALLOWLISTED',
      erasure_disposition = 'BLOCKED_UNREVIEWED',
      evidence_detail = 'Composite tenant_id/factory_id key, FIFO/FEFO/LOT/SERIAL allocation policy and retention-years configuration verified. Exact-schema transfer uses a separate composite-key adapter; generic erasure remains blocked.',
      review_status = 'VERIFIED',
      reviewed_at = clock_timestamp()
  WHERE schema_name = 'public' AND relation_name = 'traceability_settings'
    AND ownership_class = 'DIRECT_TENANT';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'traceability_settings ownership review could not be verified';
  END IF;
END
$traceability_settings_export$;

-- Extend the category-completeness guard to include tenant-owned relations
-- whose tenant scope is derived by reviewed foreign-key lineage. Such rows
-- have not yet been assigned a supported export adapter/category, so a generic
-- export must fail closed rather than silently omit them.
CREATE OR REPLACE FUNCTION factoryos_governance.tenant_export_category_has_excluded_rows(
  p_category text,
  p_adapter_relations text[]
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  current_tenant_id uuid;
  relation record;
  relation_has_rows boolean;
BEGIN
  current_tenant_id := public.factoryos_current_tenant_id();
  IF current_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant export completeness check requires transaction-local tenant scope'
      USING ERRCODE = '42501';
  END IF;

  IF p_category IS NULL OR p_category NOT IN (
    'BUSINESS_DATA', 'AUDIT_LOG', 'EVIDENCE', 'APPROVALS',
    'EFFECTIVE_DATED_MASTER_DATA', 'AI_CONTEXT', 'LEARNING_EVALUATION',
    'INTEGRATION_METADATA', 'FILE_REFERENCES', 'IAM_ACCESS'
  ) THEN
    RAISE EXCEPTION 'Unsupported tenant export category'
      USING ERRCODE = '22023';
  END IF;

  IF p_adapter_relations IS NULL OR cardinality(p_adapter_relations) = 0 THEN
    RAISE EXCEPTION 'Tenant export category must provide its reviewed adapter relation set'
      USING ERRCODE = '22023';
  END IF;

  IF cardinality(p_adapter_relations) <> (
    SELECT COUNT(DISTINCT supplied.relation_name)
    FROM pg_catalog.unnest(p_adapter_relations) AS supplied(relation_name)
  ) THEN
    RAISE EXCEPTION 'Tenant export category adapter relation set contains duplicates'
      USING ERRCODE = '22023';
  END IF;

  -- The submitted application mapping must equal the migration-owned adapter
  -- registry exactly; an arbitrary array cannot claim omitted rows were covered.
  IF EXISTS (
    SELECT supplied.relation_name
    FROM pg_catalog.unnest(p_adapter_relations) AS supplied(relation_name)
    EXCEPT
    SELECT r.relation_name
    FROM factoryos_governance.tenant_export_adapter_relation_registry r
    WHERE r.data_category = p_category
  ) OR EXISTS (
    SELECT r.relation_name
    FROM factoryos_governance.tenant_export_adapter_relation_registry r
    WHERE r.data_category = p_category
    EXCEPT
    SELECT supplied.relation_name
    FROM pg_catalog.unnest(p_adapter_relations) AS supplied(relation_name)
  ) THEN
    RAISE EXCEPTION 'Tenant export source adapter map differs from the reviewed database registry'
      USING ERRCODE = '22023';
  END IF;

  -- A caller may not claim arbitrary tables as part of a reviewed adapter.
  -- IAM_ACCESS is a logical remap across its direct and FK-derived relations.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(p_adapter_relations) AS supplied(relation_name)
    LEFT JOIN factoryos_governance.tenant_relation_inventory i
      ON i.schema_name = 'public' AND i.relation_name = supplied.relation_name
    WHERE i.relation_name IS NULL
      OR i.data_category IS DISTINCT FROM p_category
      OR i.export_disposition <> 'ALLOWLISTED'
      OR (
        p_category = 'IAM_ACCESS'
        AND i.scope_model NOT IN ('DIRECT_TENANT_ID', 'DERIVED_TENANT_RELATIONSHIP')
      )
      OR (
        p_category <> 'IAM_ACCESS'
        AND i.scope_model <> 'DIRECT_TENANT_ID'
      )
  ) THEN
    RAISE EXCEPTION 'Tenant export adapter relation set is not a reviewed allowlist'
      USING ERRCODE = '22023';
  END IF;

  FOR relation IN
    SELECT i.relation_name,
           c.oid AS relation_oid,
           c.relkind,
           a.attnum AS tenant_id_attnum
    FROM factoryos_governance.tenant_relation_inventory i
    LEFT JOIN pg_catalog.pg_namespace n
      ON n.nspname = i.schema_name
    LEFT JOIN pg_catalog.pg_class c
      ON c.relnamespace = n.oid AND c.relname = i.relation_name
    LEFT JOIN pg_catalog.pg_attribute a
      ON a.attrelid = c.oid
     AND a.attname = 'tenant_id'
     AND a.attnum > 0
     AND NOT a.attisdropped
    WHERE i.schema_name = 'public'
      AND i.data_category = p_category
      AND i.scope_model = 'DIRECT_TENANT_ID'
      AND (
        i.export_disposition = 'EXCLUDED'
        OR (
          i.export_disposition = 'ALLOWLISTED'
          AND NOT (i.relation_name = ANY(p_adapter_relations))
        )
      )
    ORDER BY i.relation_name
  LOOP
    -- An incomplete/stale inventory is itself a blocker; never skip it silently.
    IF relation.relation_oid IS NULL
      OR relation.relkind NOT IN ('r', 'p')
      OR relation.tenant_id_attnum IS NULL THEN
      RAISE EXCEPTION 'Tenant export category inventory is stale or invalid'
        USING ERRCODE = '55000';
    END IF;

    EXECUTE pg_catalog.format(
      'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE tenant_id::text = $1::text)',
      'public',
      relation.relation_name
    )
    INTO relation_has_rows
    USING current_tenant_id;

    IF relation_has_rows THEN
      RAISE LOG 'Tenant export completeness blocked category % by direct relation % outside its reviewed adapter',
        p_category, relation.relation_name;
      RETURN TRUE;
    END IF;
  END LOOP;

  -- Direct tenant data assigned to UNREVIEWED is not an intentional policy
  -- exclusion. Any current-tenant rows in that bucket block category exports,
  -- even when the caller did not request a category name for the unknown data.
  FOR relation IN
    SELECT i.relation_name,
           c.oid AS relation_oid,
           c.relkind,
           a.attnum AS tenant_id_attnum
    FROM factoryos_governance.tenant_relation_inventory i
    LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = i.schema_name
    LEFT JOIN pg_catalog.pg_class c
      ON c.relnamespace = n.oid AND c.relname = i.relation_name
    LEFT JOIN pg_catalog.pg_attribute a
      ON a.attrelid = c.oid
     AND a.attname = 'tenant_id'
     AND a.attnum > 0
     AND NOT a.attisdropped
    WHERE i.schema_name = 'public'
      AND i.scope_model = 'DIRECT_TENANT_ID'
      AND i.data_category = 'UNREVIEWED'
      AND i.export_disposition = 'EXCLUDED'
    ORDER BY i.relation_name
  LOOP
    IF relation.relation_oid IS NULL
      OR relation.relkind NOT IN ('r', 'p')
      OR relation.tenant_id_attnum IS NULL THEN
      RAISE EXCEPTION 'Unreviewed direct-tenant inventory is stale or invalid'
        USING ERRCODE = '55000';
    END IF;

    EXECUTE pg_catalog.format(
      'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE tenant_id::text = $1::text)',
      'public',
      relation.relation_name
    )
    INTO relation_has_rows
    USING current_tenant_id;

    IF relation_has_rows THEN
      RAISE LOG 'Tenant export completeness blocked category % by unreviewed direct relation %',
        p_category, relation.relation_name;
      RETURN TRUE;
    END IF;
  END LOOP;

  -- Relations with tenant ownership derived through foreign keys have no
  -- direct tenant_id/category column in migration 156. Until a category-specific
  -- adapter explicitly covers them, any current-tenant rows in these excluded
  -- relations block every generic category export rather than silently vanishing.
  FOR relation IN
    SELECT r.relation_name, r.scope_predicate,
           c.oid AS relation_oid, c.relkind
    FROM factoryos_governance.tenant_relation_ownership_reviews r
    LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = r.schema_name
    LEFT JOIN pg_catalog.pg_class c
      ON c.relnamespace = n.oid AND c.relname = r.relation_name
    WHERE r.schema_name = 'public'
      AND r.ownership_class = 'DERIVED_TENANT'
      AND r.export_disposition = 'EXCLUDED'
      AND r.erasure_disposition = 'BLOCKED_UNREVIEWED'
      -- A derived relation already covered by an exact reviewed adapter (for
      -- example user_roles/role_permissions in IAM_ACCESS) is not unmapped
      -- export data. Its category-specific adapter guard remains authoritative.
      AND NOT EXISTS (
        SELECT 1
        FROM factoryos_governance.tenant_export_adapter_relation_registry mapped
        WHERE mapped.relation_name = r.relation_name
      )
    ORDER BY r.relation_name
  LOOP
    IF relation.relation_oid IS NULL
      OR relation.relkind NOT IN ('r', 'p')
      OR relation.scope_predicate IS NULL
      OR relation.scope_predicate = 'FALSE'
      OR position('public.factoryos_current_tenant_id()' IN relation.scope_predicate) = 0
      OR position(';' IN relation.scope_predicate) > 0
      OR position('--' IN relation.scope_predicate) > 0
      OR position('/*' IN relation.scope_predicate) > 0 THEN
      RAISE EXCEPTION 'Derived tenant ownership review is stale or unsafe for export completeness'
        USING ERRCODE = '55000';
    END IF;

    EXECUTE pg_catalog.format(
      'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE (%s))',
      'public',
      relation.relation_name,
      relation.scope_predicate
    )
    INTO relation_has_rows;

    IF relation_has_rows THEN
      RAISE LOG 'Tenant export completeness blocked category % by unmapped derived relation %',
        p_category, relation.relation_name;
      RETURN TRUE;
    END IF;
  END LOOP;

  RETURN FALSE;
END;
$function$;

INSERT INTO schema_migrations(version, checksum)
VALUES ('215_saas_tenant_export_derived_scope_completeness_guard', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
