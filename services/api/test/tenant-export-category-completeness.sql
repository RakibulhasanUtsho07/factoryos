\set ON_ERROR_STOP on

-- Runtime may call only this narrow SECURITY DEFINER guard. It cannot read the
-- tenant privacy or ownership ledger directly.
DO $$
DECLARE
  function_oid oid := to_regprocedure('factoryos_governance.tenant_export_category_has_excluded_rows(text,text[])');
  function_is_security_definer boolean;
  function_config text[];
BEGIN
  IF function_oid IS NULL THEN
    RAISE EXCEPTION 'Tenant export category completeness guard is missing';
  END IF;

  SELECT p.prosecdef, p.proconfig
    INTO function_is_security_definer, function_config
  FROM pg_catalog.pg_proc p
  WHERE p.oid = function_oid;

  IF NOT function_is_security_definer
    OR function_config IS NULL
    OR NOT (function_config @> ARRAY['search_path=pg_catalog']) THEN
    RAISE EXCEPTION 'Tenant export completeness guard must be SECURITY DEFINER with a fixed pg_catalog search path';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'factoryos_app') THEN
    IF NOT has_schema_privilege('factoryos_app', 'factoryos_governance', 'USAGE')
      OR NOT has_function_privilege(
        'factoryos_app',
        'factoryos_governance.tenant_export_category_has_excluded_rows(text,text[])',
        'EXECUTE'
      ) THEN
      RAISE EXCEPTION 'Runtime role must have the schema/function access needed for category completeness checks';
    END IF;

    IF has_table_privilege('factoryos_app', 'factoryos_governance.tenant_relation_inventory', 'SELECT')
      OR has_table_privilege('factoryos_app', 'factoryos_governance.tenant_relation_inventory', 'INSERT')
      OR has_table_privilege('factoryos_app', 'factoryos_governance.tenant_relation_inventory', 'UPDATE')
      OR has_table_privilege('factoryos_app', 'factoryos_governance.tenant_relation_inventory', 'DELETE')
      OR has_table_privilege('factoryos_app', 'factoryos_governance.tenant_relation_ownership_reviews', 'SELECT')
      OR has_table_privilege('factoryos_app', 'factoryos_governance.tenant_relation_ownership_reviews', 'INSERT')
      OR has_table_privilege('factoryos_app', 'factoryos_governance.tenant_relation_ownership_reviews', 'UPDATE')
      OR has_table_privilege('factoryos_app', 'factoryos_governance.tenant_relation_ownership_reviews', 'DELETE')
      OR has_table_privilege('factoryos_app', 'factoryos_governance.tenant_export_adapter_relation_registry', 'SELECT')
      OR has_table_privilege('factoryos_app', 'factoryos_governance.tenant_export_adapter_relation_registry', 'INSERT')
      OR has_table_privilege('factoryos_app', 'factoryos_governance.tenant_export_adapter_relation_registry', 'UPDATE')
      OR has_table_privilege('factoryos_app', 'factoryos_governance.tenant_export_adapter_relation_registry', 'DELETE') THEN
      RAISE EXCEPTION 'Runtime role must not read governance ledgers directly';
    END IF;
  END IF;
END
$$;

BEGIN;

CREATE TABLE public.tenant_export_completeness_probe (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL
);
CREATE TABLE public.tenant_export_completeness_unmapped_probe (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL
);

CREATE TABLE public.tenant_export_completeness_unreviewed_probe (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL
);

CREATE TABLE public.tenant_export_completeness_parent_probe (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL
);
CREATE TABLE public.tenant_export_completeness_derived_probe (
  id uuid PRIMARY KEY,
  parent_id uuid NOT NULL REFERENCES public.tenant_export_completeness_parent_probe(id)
);

INSERT INTO factoryos_governance.tenant_relation_inventory (
  schema_name, relation_name, scope_model, data_category, export_disposition,
  erasure_disposition, audit_requirement, rationale
) VALUES
(
  'public', 'tenant_export_completeness_probe', 'DIRECT_TENANT_ID', 'AI_CONTEXT',
  'EXCLUDED', 'BLOCKED_UNREVIEWED', 'REVIEW_REQUIRED',
  'Temporary SQL contract probe for excluded tenant export rows'
),
(
  'public', 'tenant_export_completeness_unmapped_probe', 'DIRECT_TENANT_ID', 'AI_CONTEXT',
  'ALLOWLISTED', 'BOUNDED_ADAPTER', 'REVIEW_REQUIRED',
  'Temporary SQL contract probe for allowlisted relation missing from adapter map'
),
(
  'public', 'tenant_export_completeness_unreviewed_probe', 'DIRECT_TENANT_ID', 'UNREVIEWED',
  'EXCLUDED', 'BLOCKED_UNREVIEWED', 'REVIEW_REQUIRED',
  'Temporary direct-tenant row that has not been assigned a data category'
),
(
  'public', 'tenant_export_completeness_parent_probe', 'DIRECT_TENANT_ID', 'BUSINESS_DATA',
  'ALLOWLISTED', 'BOUNDED_ADAPTER', 'REVIEW_REQUIRED',
  'Temporary parent table for derived-scope completeness probe'
),
(
  'public', 'tenant_export_completeness_derived_probe', 'NO_DIRECT_TENANT_ID', 'UNREVIEWED',
  'EXCLUDED', 'BLOCKED_UNREVIEWED', 'REVIEW_REQUIRED',
  'Temporary derived-scope table omitted from generic tenant export'
);

INSERT INTO public.tenant_export_completeness_probe (id, tenant_id)
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
);
INSERT INTO public.tenant_export_completeness_unmapped_probe (id, tenant_id)
VALUES (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
);

INSERT INTO public.tenant_export_completeness_unreviewed_probe (id, tenant_id)
VALUES (
  'ffffffff-ffff-4fff-8fff-fffffffffff6',
  'ffffffff-ffff-4fff-8fff-fffffffffff6'
);

INSERT INTO public.tenant_export_completeness_parent_probe (id, tenant_id)
VALUES (
  'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
  'dddddddd-dddd-4ddd-8ddd-ddddddddddd4'
);
INSERT INTO public.tenant_export_completeness_derived_probe (id, parent_id)
VALUES (
  'dddddddd-dddd-4ddd-8ddd-ddddddddddd5',
  'dddddddd-dddd-4ddd-8ddd-ddddddddddd4'
);
INSERT INTO factoryos_governance.tenant_relation_ownership_reviews (
  schema_name, relation_name, ownership_class, evidence_type, evidence_detail,
  scope_predicate, export_disposition, erasure_disposition, review_status
) VALUES (
  'public', 'tenant_export_completeness_derived_probe', 'DERIVED_TENANT',
  'FOREIGN_KEY_LINEAGE',
  'Temporary FK scope probe for export completeness contract',
  'EXISTS (SELECT 1 FROM public.tenant_export_completeness_parent_probe AS fo_scope_probe WHERE fo_scope_probe.id = "public"."tenant_export_completeness_derived_probe".parent_id AND (fo_scope_probe.tenant_id::text = public.factoryos_current_tenant_id()::text))',
  'EXCLUDED', 'BLOCKED_UNREVIEWED', 'VERIFIED'
);

SELECT set_config('app.tenant_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', true);
SELECT set_config('app.user_id', '', true);

DO $test$
DECLARE
  has_incomplete_scope boolean;
  ai_context_adapter_relations text[] := ARRAY[
    'ai_decision_envelopes',
    'ai_context_packages',
    'ai_verification_runs',
    'research_sources',
    'research_claims',
    'research_claim_links',
    'research_knowledge_releases',
    'research_relevance_mappings'
  ]::text[];
  iam_adapter_relations text[] := ARRAY[
    'tenant_memberships', 'roles', 'user_roles', 'role_permissions'
  ]::text[];
  business_data_adapter_relations text[] := ARRAY[
    'legal_entities','factories','inventory_locations','orders','order_lines','order_event_projections',
    'inventory_items','inventory_stock_balances','inventory_movements','business_blueprints',
    'business_blueprint_versions','business_entities','business_relations','business_processes',
    'business_process_steps','business_rules','business_terms','business_exceptions',
    'business_change_proposals','business_conflicts','business_feedback','growth_opportunities',
    'growth_scenarios','growth_experiments','saas_usage_events','saas_usage_adjustments',
    'saas_usage_reconciliations','saas_budget_evaluations','saas_workload_control_events',
    'saas_budget_alerts','saas_budget_alert_acknowledgements','saas_provider_cost_events',
    'saas_provider_cost_reconciliations'
  ]::text[];
  evidence_adapter_relations text[] := ARRAY[
    'business_evidence','business_evidence_links','growth_opportunity_evidence'
  ]::text[];
  effective_master_adapter_relations text[] := ARRAY[
    'risk_classes','policies','saas_usage_rate_cards','saas_usage_budgets'
  ]::text[];
  learning_adapter_relations text[] := ARRAY[
    'research_release_evaluations','growth_experiment_results','growth_opportunity_outcomes'
  ]::text[];
BEGIN
  has_incomplete_scope :=
    factoryos_governance.tenant_export_category_has_excluded_rows('AI_CONTEXT', ai_context_adapter_relations);
  IF NOT has_incomplete_scope THEN
    RAISE EXCEPTION 'Excluded tenant rows must prevent a category completeness claim';
  END IF;

  PERFORM set_config('app.tenant_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', true);
  has_incomplete_scope :=
    factoryos_governance.tenant_export_category_has_excluded_rows('AI_CONTEXT', ai_context_adapter_relations);
  IF has_incomplete_scope THEN
    RAISE EXCEPTION 'Excluded rows belonging to another tenant must not affect the current tenant export';
  END IF;

  -- The requested relation list must match the actual reviewed allowlist for
  -- the selected category, including the logical IAM remapping adapter.
  has_incomplete_scope :=
    factoryos_governance.tenant_export_category_has_excluded_rows('IAM_ACCESS', iam_adapter_relations);
  IF has_incomplete_scope THEN
    RAISE EXCEPTION 'A complete, correctly mapped IAM logical adapter must pass when there are no excluded rows';
  END IF;

  -- The relation is inventory-classified as ALLOWLISTED but deliberately absent
  -- from the adapter relation list; rows from that tenant must still block export.
  PERFORM set_config('app.tenant_id', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3', true);
  has_incomplete_scope :=
    factoryos_governance.tenant_export_category_has_excluded_rows('AI_CONTEXT', ai_context_adapter_relations);
  IF NOT has_incomplete_scope THEN
    RAISE EXCEPTION 'Allowlisted tenant rows omitted from the source adapter must prevent a completeness claim';
  END IF;

  -- Direct-tenant rows without a reviewed data category cannot be silently
  -- omitted just because the caller did not request an UNREVIEWED category.
  PERFORM set_config('app.tenant_id', 'ffffffff-ffff-4fff-8fff-fffffffffff6', true);
  has_incomplete_scope :=
    factoryos_governance.tenant_export_category_has_excluded_rows('AI_CONTEXT', ai_context_adapter_relations);
  IF NOT has_incomplete_scope THEN
    RAISE EXCEPTION 'Unreviewed direct-tenant rows must block a category export';
  END IF;

  -- A different tenant with no unreviewed direct rows must not inherit that block.
  PERFORM set_config('app.tenant_id', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5', true);
  has_incomplete_scope :=
    factoryos_governance.tenant_export_category_has_excluded_rows('AI_CONTEXT', ai_context_adapter_relations);
  IF has_incomplete_scope THEN
    RAISE EXCEPTION 'An unrelated tenant must not inherit another tenant unreviewed-row block';
  END IF;

  -- This table has no tenant_id; the ownership ledger's FK predicate must still
  -- block an export for the tenant whose parent row owns this derived record.
  PERFORM set_config('app.tenant_id', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4', true);
  has_incomplete_scope :=
    factoryos_governance.tenant_export_category_has_excluded_rows('AI_CONTEXT', ai_context_adapter_relations);
  IF NOT has_incomplete_scope THEN
    RAISE EXCEPTION 'Rows in an unmapped FK-derived tenant relation must block generic export';
  END IF;

  -- The derived row belongs to tenant D only; a different tenant must not be
  -- blocked because of another tenant's hidden FK-derived records.
  PERFORM set_config('app.tenant_id', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5', true);
  has_incomplete_scope :=
    factoryos_governance.tenant_export_category_has_excluded_rows('AI_CONTEXT', ai_context_adapter_relations);
  IF has_incomplete_scope THEN
    RAISE EXCEPTION 'An unrelated tenant must not inherit another tenant derived-scope incompleteness';
  END IF;

  -- Verify the database adapter registry exactly matches every reviewed
  -- category map, not only AI_CONTEXT and IAM_ACCESS.
  PERFORM set_config('app.tenant_id', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5', true);
  IF factoryos_governance.tenant_export_category_has_excluded_rows('BUSINESS_DATA', business_data_adapter_relations)
    OR factoryos_governance.tenant_export_category_has_excluded_rows('AUDIT_LOG', ARRAY['audit_events']::text[])
    OR factoryos_governance.tenant_export_category_has_excluded_rows('EVIDENCE', evidence_adapter_relations)
    OR factoryos_governance.tenant_export_category_has_excluded_rows('APPROVALS', ARRAY['approvals']::text[])
    OR factoryos_governance.tenant_export_category_has_excluded_rows('EFFECTIVE_DATED_MASTER_DATA', effective_master_adapter_relations)
    OR factoryos_governance.tenant_export_category_has_excluded_rows('LEARNING_EVALUATION', learning_adapter_relations)
    OR factoryos_governance.tenant_export_category_has_excluded_rows('AI_CONTEXT', ai_context_adapter_relations)
    OR factoryos_governance.tenant_export_category_has_excluded_rows('IAM_ACCESS', iam_adapter_relations) THEN
    RAISE EXCEPTION 'A tenant with no scoped rows should pass all exactly mapped category completeness checks';
  END IF;

  BEGIN
    PERFORM factoryos_governance.tenant_export_category_has_excluded_rows('UNREVIEWED', ai_context_adapter_relations);
    RAISE EXCEPTION 'Unsupported categories must be rejected';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  BEGIN
    PERFORM factoryos_governance.tenant_export_category_has_excluded_rows(
      'AI_CONTEXT', ARRAY['tenant_export_completeness_probe']::text[]
    );
    RAISE EXCEPTION 'Adapter relations outside the category allowlist must be rejected';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
END
$test$;

ROLLBACK;
