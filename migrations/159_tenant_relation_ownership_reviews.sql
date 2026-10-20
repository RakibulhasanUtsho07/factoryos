BEGIN;

-- Durable scope-review evidence for every public base/partition relation.
-- This is separate from migration 156's direct-column inventory: absence of
-- tenant_id does not mean a relation is global, and absence of an FK path is
-- never treated as proof of global ownership.
CREATE TABLE IF NOT EXISTS factoryos_governance.tenant_relation_ownership_reviews (
  schema_name text NOT NULL,
  relation_name text NOT NULL,
  ownership_class varchar(32) NOT NULL,
  evidence_type varchar(40) NOT NULL,
  evidence_detail text NOT NULL,
  scope_predicate text,
  export_disposition varchar(20) NOT NULL,
  erasure_disposition varchar(32) NOT NULL,
  review_status varchar(30) NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (schema_name, relation_name),
  CONSTRAINT chk_tenant_ownership_class CHECK (
    ownership_class IN ('DIRECT_TENANT', 'DERIVED_TENANT', 'GLOBAL_SHARED', 'UNRESOLVED')
  ),
  CONSTRAINT chk_tenant_ownership_export CHECK (
    export_disposition IN ('ALLOWLISTED', 'EXCLUDED')
  ),
  CONSTRAINT chk_tenant_ownership_erasure CHECK (
    erasure_disposition IN ('BOUNDED_ADAPTER', 'PROTECTED', 'BLOCKED_FINANCE_REVIEW', 'BLOCKED_UNREVIEWED')
  ),
  CONSTRAINT chk_tenant_ownership_review_status CHECK (
    review_status IN ('VERIFIED', 'REVIEWED_POLICY', 'REVIEW_REQUIRED')
  ),
  CONSTRAINT chk_tenant_ownership_evidence CHECK (length(btrim(evidence_detail)) >= 12)
);
REVOKE ALL ON TABLE factoryos_governance.tenant_relation_ownership_reviews FROM PUBLIC;

-- Construct a restrictive policy predicate by traversing declared foreign keys
-- until tenant_id-bearing rows are reached. All ownership-bearing FK paths are
-- ANDed: a join row referencing tenant-A membership and tenant-B role must not
-- become visible to either tenant. Nullable FK groups may be absent, but any
-- populated group must resolve within the current tenant.
CREATE OR REPLACE FUNCTION factoryos_governance.build_tenant_scope_predicate(
  p_relation oid,
  p_row_reference text,
  p_visited oid[] DEFAULT ARRAY[]::oid[],
  p_depth integer DEFAULT 0
) RETURNS text
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  direct_column text;
  fk record;
  parent_alias text;
  join_predicate text;
  all_null_predicate text;
  parent_predicate text;
  one_predicate text;
  predicates text[] := ARRAY[]::text[];
BEGIN
  IF p_relation IS NULL OR p_depth > 16 OR p_relation = ANY(p_visited) THEN
    RETURN 'FALSE';
  END IF;

  SELECT a.attname
    INTO direct_column
  FROM pg_attribute a
  WHERE a.attrelid = p_relation
    AND a.attname = 'tenant_id'
    AND a.attnum > 0
    AND NOT a.attisdropped
  LIMIT 1;

  IF FOUND THEN
    RETURN format('(%s.%I::text = public.factoryos_current_tenant_id()::text)',
      p_row_reference, direct_column);
  END IF;

  FOR fk IN
    SELECT con.oid AS constraint_oid,
           con.confrelid AS parent_oid,
           pn.nspname AS parent_schema,
           pc.relname AS parent_table
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_namespace cn ON cn.oid = child.relnamespace
    JOIN pg_class pc ON pc.oid = con.confrelid
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace
    WHERE con.contype = 'f'
      AND con.conrelid = p_relation
      AND cn.nspname = 'public'
    ORDER BY con.conname, con.oid
  LOOP
    parent_alias := format('fo_scope_%s_%s', p_depth, fk.constraint_oid);

    SELECT string_agg(
             format('%I.%I = %s.%I', parent_alias, parent_att.attname,
                    p_row_reference, child_att.attname),
             ' AND ' ORDER BY child_key.ordinality
           ),
           string_agg(
             format('%s.%I IS NULL', p_row_reference, child_att.attname),
             ' AND ' ORDER BY child_key.ordinality
           )
      INTO join_predicate, all_null_predicate
    FROM pg_constraint con
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS child_key(attnum, ordinality) ON TRUE
    JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS parent_key(attnum, ordinality)
      ON parent_key.ordinality = child_key.ordinality
    JOIN pg_attribute child_att
      ON child_att.attrelid = con.conrelid AND child_att.attnum = child_key.attnum
    JOIN pg_attribute parent_att
      ON parent_att.attrelid = con.confrelid AND parent_att.attnum = parent_key.attnum
    WHERE con.oid = fk.constraint_oid;

    parent_predicate := factoryos_governance.build_tenant_scope_predicate(
      fk.parent_oid, quote_ident(parent_alias), p_visited || p_relation, p_depth + 1
    );
    IF parent_predicate <> 'FALSE' THEN
      one_predicate := format(
        'EXISTS (SELECT 1 FROM %I.%I AS %I WHERE (%s) AND (%s))',
        fk.parent_schema, fk.parent_table, parent_alias, join_predicate, parent_predicate
      );
      IF all_null_predicate IS NOT NULL THEN
        one_predicate := format('((%s) OR %s)', all_null_predicate, one_predicate);
      END IF;
      predicates := array_append(predicates, one_predicate);
    END IF;
  END LOOP;

  IF cardinality(predicates) = 0 THEN
    RETURN 'FALSE';
  END IF;
  RETURN '(' || array_to_string(predicates, ' AND ') || ')';
END;
$function$;
REVOKE ALL ON FUNCTION factoryos_governance.build_tenant_scope_predicate(oid, text, oid[], integer) FROM PUBLIC;

DO $$
DECLARE
  item record;
  predicate text;
  global_reason text;
  previous_permissive boolean;
BEGIN
  FOR item IN
    SELECT c.oid, n.nspname AS schema_name, c.relname AS relation_name,
           EXISTS (
             SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
               AND a.attnum > 0 AND NOT a.attisdropped
           ) AS has_direct_tenant_id
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname
  LOOP
    IF item.has_direct_tenant_id THEN
      INSERT INTO factoryos_governance.tenant_relation_ownership_reviews (
        schema_name, relation_name, ownership_class, evidence_type, evidence_detail,
        scope_predicate, export_disposition, erasure_disposition, review_status
      )
      SELECT item.schema_name, item.relation_name, 'DIRECT_TENANT',
             'DIRECT_TENANT_COLUMN_AND_RLS',
             'Direct tenant_id column; migration 156 inventory and PostgreSQL contract require ENABLE/FORCE RLS plus a restrictive current-tenant fence (the AI tool registry retains its bespoke global-read/tenant-write policy).',
             'tenant_id = public.factoryos_current_tenant_id()',
             i.export_disposition, i.erasure_disposition, 'VERIFIED'
      FROM factoryos_governance.tenant_relation_inventory i
      WHERE i.schema_name = item.schema_name AND i.relation_name = item.relation_name
      ON CONFLICT (schema_name, relation_name) DO UPDATE SET
        ownership_class = EXCLUDED.ownership_class,
        evidence_type = EXCLUDED.evidence_type,
        evidence_detail = EXCLUDED.evidence_detail,
        scope_predicate = EXCLUDED.scope_predicate,
        export_disposition = EXCLUDED.export_disposition,
        erasure_disposition = EXCLUDED.erasure_disposition,
        review_status = EXCLUDED.review_status,
        reviewed_at = clock_timestamp();
      CONTINUE;
    END IF;

    -- These registries are explicitly global/shared, not implicitly global just
    -- because they lack a tenant_id or an FK path. Generic tenant export/erasure
    -- cannot transfer/delete them; tenant access is mediated by scoped services.
    global_reason := CASE item.relation_name
      WHEN 'tenants' THEN 'Global tenant registry/control plane; it is not a tenant-owned dataset and is excluded from generic export and erasure.'
      WHEN 'users' THEN 'Shared identity principals may have memberships in several tenants; profile access must be membership-authorized and generic tenant export/erasure is excluded.'
      WHEN 'permissions' THEN 'Global permission-code catalogue referenced by tenant roles; it is excluded from tenant dataset export and generic erasure.'
      WHEN 'auth_identities' THEN 'Global OIDC issuer/subject-to-user mapping is resolved before tenant context exists; access is limited to the authentication boundary, and export/erasure is handled only by a dedicated identity-governance workflow.'
      WHEN 'schema_migrations' THEN 'Internal schema migration ledger; operational metadata is outside tenant export and erasure.'
      ELSE NULL
    END;

    IF global_reason IS NOT NULL THEN
      INSERT INTO factoryos_governance.tenant_relation_ownership_reviews (
        schema_name, relation_name, ownership_class, evidence_type, evidence_detail,
        scope_predicate, export_disposition, erasure_disposition, review_status
      ) VALUES (
        item.schema_name, item.relation_name, 'GLOBAL_SHARED', 'EXPLICIT_GLOBAL_REGISTRY',
        global_reason, NULL, 'EXCLUDED', 'PROTECTED', 'REVIEWED_POLICY'
      )
      ON CONFLICT (schema_name, relation_name) DO UPDATE SET
        ownership_class = EXCLUDED.ownership_class,
        evidence_type = EXCLUDED.evidence_type,
        evidence_detail = EXCLUDED.evidence_detail,
        scope_predicate = NULL,
        export_disposition = EXCLUDED.export_disposition,
        erasure_disposition = EXCLUDED.erasure_disposition,
        review_status = EXCLUDED.review_status,
        reviewed_at = clock_timestamp();

      EXECUTE format('DROP POLICY IF EXISTS fo_tenant_ownership_scope_allow ON %I.%I',
        item.schema_name, item.relation_name);
      EXECUTE format('DROP POLICY IF EXISTS fo_tenant_ownership_scope_enforce ON %I.%I',
        item.schema_name, item.relation_name);
      EXECUTE format('DROP POLICY IF EXISTS fo_tenant_ownership_unresolved_deny ON %I.%I',
        item.schema_name, item.relation_name);
      CONTINUE;
    END IF;

    predicate := factoryos_governance.build_tenant_scope_predicate(
      item.oid, format('%I.%I', item.schema_name, item.relation_name)
    );

    IF predicate <> 'FALSE' THEN
      -- FK-chain ownership is safe for RLS but does not automatically approve
      -- export or erasure adapters. Keep those dispositions fail-closed.
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', item.schema_name, item.relation_name);
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', item.schema_name, item.relation_name);
      EXECUTE format('DROP POLICY IF EXISTS fo_tenant_ownership_scope_allow ON %I.%I',
        item.schema_name, item.relation_name);
      EXECUTE format('DROP POLICY IF EXISTS fo_tenant_ownership_scope_enforce ON %I.%I',
        item.schema_name, item.relation_name);
      EXECUTE format('DROP POLICY IF EXISTS fo_tenant_ownership_unresolved_deny ON %I.%I',
        item.schema_name, item.relation_name);

      SELECT EXISTS (
        SELECT 1 FROM pg_policy p WHERE p.polrelid = item.oid AND p.polpermissive
      ) INTO previous_permissive;
      IF NOT previous_permissive THEN
        EXECUTE format(
          'CREATE POLICY fo_tenant_ownership_scope_allow ON %I.%I AS PERMISSIVE FOR ALL USING (%s) WITH CHECK (%s)',
          item.schema_name, item.relation_name, predicate, predicate
        );
      END IF;
      EXECUTE format(
        'CREATE POLICY fo_tenant_ownership_scope_enforce ON %I.%I AS RESTRICTIVE FOR ALL USING (%s) WITH CHECK (%s)',
        item.schema_name, item.relation_name, predicate, predicate
      );

      INSERT INTO factoryos_governance.tenant_relation_ownership_reviews (
        schema_name, relation_name, ownership_class, evidence_type, evidence_detail,
        scope_predicate, export_disposition, erasure_disposition, review_status
      ) VALUES (
        item.schema_name, item.relation_name, 'DERIVED_TENANT', 'FOREIGN_KEY_LINEAGE',
        'Automated PostgreSQL FK-lineage review produced a fail-closed tenant predicate. The relation remains excluded from generic export and blocked from generic erasure until a reviewed adapter is registered.',
        predicate, 'EXCLUDED', 'BLOCKED_UNREVIEWED', 'VERIFIED'
      )
      ON CONFLICT (schema_name, relation_name) DO UPDATE SET
        ownership_class = EXCLUDED.ownership_class,
        evidence_type = EXCLUDED.evidence_type,
        evidence_detail = EXCLUDED.evidence_detail,
        scope_predicate = EXCLUDED.scope_predicate,
        export_disposition = EXCLUDED.export_disposition,
        erasure_disposition = EXCLUDED.erasure_disposition,
        review_status = EXCLUDED.review_status,
        reviewed_at = clock_timestamp();
    ELSE
      -- Unknown no-direct-scope relations are explicitly unresolved, never
      -- assumed global. Block runtime access until a reviewer adds a justified
      -- FK path or an explicit shared/global decision to this migration.
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', item.schema_name, item.relation_name);
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', item.schema_name, item.relation_name);
      EXECUTE format('DROP POLICY IF EXISTS fo_tenant_ownership_scope_allow ON %I.%I',
        item.schema_name, item.relation_name);
      EXECUTE format('DROP POLICY IF EXISTS fo_tenant_ownership_scope_enforce ON %I.%I',
        item.schema_name, item.relation_name);
      EXECUTE format('DROP POLICY IF EXISTS fo_tenant_ownership_unresolved_deny ON %I.%I',
        item.schema_name, item.relation_name);
      EXECUTE format(
        'CREATE POLICY fo_tenant_ownership_unresolved_deny ON %I.%I AS RESTRICTIVE FOR ALL USING (FALSE) WITH CHECK (FALSE)',
        item.schema_name, item.relation_name
      );

      INSERT INTO factoryos_governance.tenant_relation_ownership_reviews (
        schema_name, relation_name, ownership_class, evidence_type, evidence_detail,
        scope_predicate, export_disposition, erasure_disposition, review_status
      ) VALUES (
        item.schema_name, item.relation_name, 'UNRESOLVED', 'NO_TENANT_FK_PATH',
        'No direct tenant_id, no declared FK path to a tenant-owned relation, and no explicit global/shared review; access is denied and export/erasure are blocked pending review.',
        'FALSE', 'EXCLUDED', 'BLOCKED_UNREVIEWED', 'REVIEW_REQUIRED'
      )
      ON CONFLICT (schema_name, relation_name) DO UPDATE SET
        ownership_class = EXCLUDED.ownership_class,
        evidence_type = EXCLUDED.evidence_type,
        evidence_detail = EXCLUDED.evidence_detail,
        scope_predicate = EXCLUDED.scope_predicate,
        export_disposition = EXCLUDED.export_disposition,
        erasure_disposition = EXCLUDED.erasure_disposition,
        review_status = EXCLUDED.review_status,
        reviewed_at = clock_timestamp();
    END IF;
  END LOOP;
END;
$$;

INSERT INTO schema_migrations(version, checksum)
VALUES ('159_tenant_relation_ownership_reviews', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
