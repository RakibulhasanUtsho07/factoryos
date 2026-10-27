\set ON_ERROR_STOP on

-- The application must call a narrow SECURITY DEFINER boolean guard, not read
-- governance ledgers directly. The function returns only whether the current
-- tenant has rows in excluded relations for a requested category.
DO $$
DECLARE
  function_oid oid := to_regprocedure('factoryos_governance.tenant_export_category_has_excluded_rows(text)');
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
        'factoryos_governance.tenant_export_category_has_excluded_rows(text)',
        'EXECUTE'
      ) THEN
      RAISE EXCEPTION 'Runtime role must have only the schema/function access needed for category completeness checks';
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

INSERT INTO factoryos_governance.tenant_relation_inventory (
  schema_name, relation_name, scope_model, data_category, export_disposition,
  erasure_disposition, audit_requirement, rationale
) VALUES (
  'public', 'tenant_export_completeness_probe', 'DIRECT_TENANT_ID', 'AI_CONTEXT',
  'EXCLUDED', 'BLOCKED_UNREVIEWED', 'REVIEW_REQUIRED',
  'Temporary SQL contract probe for omitted tenant export rows'
);

INSERT INTO public.tenant_export_completeness_probe (id, tenant_id)
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
);

SELECT set_config('app.tenant_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', true);
SELECT set_config('app.user_id', '', true);

DO $test$
DECLARE
  has_excluded_rows boolean;
BEGIN
  has_excluded_rows :=
    factoryos_governance.tenant_export_category_has_excluded_rows('AI_CONTEXT');
  IF NOT has_excluded_rows THEN
    RAISE EXCEPTION 'Excluded tenant rows must prevent a category completeness claim';
  END IF;

  PERFORM set_config('app.tenant_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', true);
  has_excluded_rows :=
    factoryos_governance.tenant_export_category_has_excluded_rows('AI_CONTEXT');
  IF has_excluded_rows THEN
    RAISE EXCEPTION 'Excluded rows belonging to another tenant must not affect the current tenant export';
  END IF;

  BEGIN
    PERFORM factoryos_governance.tenant_export_category_has_excluded_rows('UNREVIEWED');
    RAISE EXCEPTION 'Unsupported categories must be rejected';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
END
$test$;

ROLLBACK;
