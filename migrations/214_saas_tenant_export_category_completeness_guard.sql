BEGIN;

-- A category digest covers only the reviewed source adapter allowlist. Before
-- reporting that category as exported, check whether this tenant actually has
-- rows in any direct-tenant relation that inventory classifies as EXCLUDED.
-- If so, the worker must fail closed instead of attesting a partial category.
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
      RETURN TRUE;
    END IF;
  END LOOP;

  RETURN FALSE;
END;
$function$;

REVOKE ALL ON FUNCTION factoryos_governance.tenant_export_category_has_excluded_rows(text, text[]) FROM PUBLIC;

-- The application receives only the schema visibility needed to call this
-- single boolean guard. It is not granted SELECT access to governance ledgers.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'factoryos_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA factoryos_governance TO factoryos_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION factoryos_governance.tenant_export_category_has_excluded_rows(text, text[]) TO factoryos_app';
  END IF;
END
$grant$;

INSERT INTO schema_migrations(version, checksum)
VALUES ('214_saas_tenant_export_category_completeness_guard', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
