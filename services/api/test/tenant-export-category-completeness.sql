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
      OR has_table_privilege('factoryos_app', 'factoryos_governance.tenant_relation_ownership_reviews', 'SELECT') THEN
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

CREATE TABLE public.tenant_export_completeness_parent_probe (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL
);
CREATE TABLE public.tenant_export_completeness_derived_probe (
  id uuid PRIMARY KEY,
  parent_id uuid NOT NULL
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
  'public', 'tenant_export_completeness_parent_probe', 'DIRECT_TENANT_ID', 'AI_CONTEXT',
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
    'research_relevance_mappings',
    'tenant_export_completeness_parent_probe'
  ]::text[];
  iam_adapter_relations text[] := ARRAY[
    'tenant_memberships', 'roles', 'user_roles', 'role_permissions'
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
