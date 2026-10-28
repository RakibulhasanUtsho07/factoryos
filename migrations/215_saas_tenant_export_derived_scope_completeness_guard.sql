BEGIN;

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
