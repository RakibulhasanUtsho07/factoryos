-- Tenant ownership review gate for every public base/partition relation.
-- An absent tenant_id is not evidence of global ownership. Migration 159 either
-- records a justified shared/global policy, builds a restrictive FK-derived
-- tenant predicate, or marks the relation unresolved and denies access.
DO $$
DECLARE
  missing_count integer;
  unresolved text;
  item record;
  relation_oid oid;
  policy_count integer;
BEGIN
  IF to_regclass('factoryos_governance.tenant_relation_ownership_reviews') IS NULL THEN
    RAISE EXCEPTION 'tenant ownership review ledger is missing; migration 159 must run first';
  END IF;

  SELECT count(*) INTO missing_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN factoryos_governance.tenant_relation_ownership_reviews r
    ON r.schema_name = n.nspname AND r.relation_name = c.relname
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
    AND r.relation_name IS NULL;
  IF missing_count <> 0 THEN
    RAISE EXCEPTION '% public base/partition relation(s) have no ownership review record', missing_count;
  END IF;

  -- Fail closed if an old review survives after its relation was dropped/renamed.
  SELECT count(*) INTO missing_count
  FROM factoryos_governance.tenant_relation_ownership_reviews r
  LEFT JOIN pg_namespace n ON n.nspname = r.schema_name
  LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = r.relation_name
  WHERE r.schema_name = 'public'
    AND (c.oid IS NULL OR c.relkind NOT IN ('r', 'p'));
  IF missing_count <> 0 THEN
    RAISE EXCEPTION '% stale public relation ownership review record(s) remain', missing_count;
  END IF;

  -- The ownership ledger and the migration-156 inventory are a single governance
  -- crosswalk. Direct and derived ownership may be reviewed differently, but
  -- export/erasure dispositions must never drift between the two records.
  SELECT count(*) INTO missing_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN factoryos_governance.tenant_relation_ownership_reviews r
    ON r.schema_name = n.nspname AND r.relation_name = c.relname
  LEFT JOIN factoryos_governance.tenant_relation_inventory i
    ON i.schema_name = n.nspname AND i.relation_name = c.relname
  WHERE c.relkind IN ('r', 'p')
    AND (
      (r.ownership_class = 'DIRECT_TENANT' AND (
        i.relation_name IS NULL
        OR i.scope_model <> 'DIRECT_TENANT_ID'
        OR r.export_disposition IS DISTINCT FROM i.export_disposition
        OR r.erasure_disposition IS DISTINCT FROM i.erasure_disposition
      ))
      OR (r.ownership_class = 'DERIVED_TENANT' AND (
        i.relation_name IS NULL
        OR r.export_disposition IS DISTINCT FROM i.export_disposition
        OR r.erasure_disposition IS DISTINCT FROM i.erasure_disposition
      ))
    );
  IF missing_count <> 0 THEN
    RAISE EXCEPTION '% tenant relation(s) have missing or conflicting ownership/export/erasure crosswalk entries', missing_count;
  END IF;

  -- Integration metadata and file-reference rows are not allowed to appear
  -- covered merely because a tenant_id column exists. Until category-specific
  -- source/retention adapters are reviewed, these classes remain explicit
  -- export exclusions and fail-closed for generic erasure.
  SELECT count(*) INTO missing_count
  FROM factoryos_governance.tenant_relation_inventory i
  JOIN factoryos_governance.tenant_relation_ownership_reviews r
    ON r.schema_name = i.schema_name AND r.relation_name = i.relation_name
  WHERE i.schema_name = 'public'
    AND i.data_category IN ('INTEGRATION_METADATA', 'FILE_REFERENCES')
    AND (
      i.export_disposition <> 'EXCLUDED'
      OR i.erasure_disposition <> 'BLOCKED_UNREVIEWED'
      OR r.export_disposition <> 'EXCLUDED'
      OR r.erasure_disposition <> 'BLOCKED_UNREVIEWED'
    );
  IF missing_count <> 0 THEN
    RAISE EXCEPTION '% integration metadata/file-reference relation(s) bypass the unconfigured-adapter fail-closed boundary', missing_count;
  END IF;

  SELECT string_agg(format('%I.%I: %s', schema_name, relation_name, evidence_detail), E'\n' ORDER BY relation_name)
    INTO unresolved
  FROM factoryos_governance.tenant_relation_ownership_reviews
  WHERE schema_name = 'public'
    AND (ownership_class = 'UNRESOLVED' OR review_status = 'REVIEW_REQUIRED');
  IF unresolved IS NOT NULL THEN
    RAISE EXCEPTION 'Unresolved tenant ownership relation(s) remain; add a justified shared-scope review or FK-derived policy before release:%s%s',
      E'\n', unresolved;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM factoryos_governance.tenant_relation_ownership_reviews r
    JOIN pg_class c ON c.relname = r.relation_name
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = r.schema_name
    WHERE r.schema_name = 'public'
      AND (
        (r.ownership_class = 'DIRECT_TENANT' AND NOT EXISTS (
          SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
            AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
        ))
        OR (r.ownership_class IN ('DERIVED_TENANT','GLOBAL_SHARED') AND EXISTS (
          SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
            AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
        ))
        OR (r.ownership_class = 'GLOBAL_SHARED' AND (
          r.export_disposition <> 'EXCLUDED'
          OR r.erasure_disposition NOT IN ('PROTECTED','BLOCKED_UNREVIEWED')
          OR r.review_status <> 'REVIEWED_POLICY'
        ))
        OR (r.ownership_class = 'UNRESOLVED' AND (
          r.export_disposition <> 'EXCLUDED' OR r.erasure_disposition <> 'BLOCKED_UNREVIEWED'
        ))
      )
  ) THEN
    RAISE EXCEPTION 'Ownership review ledger contains a stale scope or unsafe export/erasure disposition';
  END IF;

  FOR item IN
    SELECT r.relation_name, r.ownership_class, r.evidence_type, r.scope_predicate,
           r.export_disposition, r.erasure_disposition, c.oid,
           c.relrowsecurity, c.relforcerowsecurity
    FROM factoryos_governance.tenant_relation_ownership_reviews r
    JOIN pg_class c ON c.relname = r.relation_name
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = r.schema_name
    WHERE r.schema_name = 'public'
      AND r.ownership_class IN ('DIRECT_TENANT','DERIVED_TENANT')
    ORDER BY r.relation_name
  LOOP
    IF NOT item.relrowsecurity OR NOT item.relforcerowsecurity THEN
      RAISE EXCEPTION 'Ownership isolation requires ENABLE/FORCE RLS for public.%', item.relation_name;
    END IF;

    IF item.ownership_class = 'DERIVED_TENANT' THEN
      IF item.scope_predicate IS NULL
         OR item.scope_predicate = 'FALSE'
         OR item.scope_predicate NOT ILIKE '%factoryos_current_tenant_id%' THEN
        RAISE EXCEPTION 'Derived relation public.% has no tenant-bound FK predicate', item.relation_name;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_policy p WHERE p.polrelid = item.oid AND NOT p.polpermissive
          AND p.polname IN ('fo_tenant_ownership_scope_enforce','fo_privacy_scope_enforce')
          AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
          AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
      ) THEN
        RAISE EXCEPTION 'Derived relation public.% lacks a restrictive tenant USING/WITH CHECK policy', item.relation_name;
      END IF;
      IF item.export_disposition <> 'EXCLUDED'
         AND item.relation_name NOT IN ('user_roles','role_permissions') THEN
        RAISE EXCEPTION 'FK-derived relation public.% cannot enter generic export without a reviewed adapter', item.relation_name;
      END IF;
      IF item.erasure_disposition NOT IN ('PROTECTED','BLOCKED_UNREVIEWED','BLOCKED_FINANCE_REVIEW') THEN
        RAISE EXCEPTION 'FK-derived relation public.% cannot be generic-erasure enabled by linkage detection alone', item.relation_name;
      END IF;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM factoryos_governance.tenant_relation_ownership_reviews
    WHERE schema_name = 'public'
      AND ownership_class = 'GLOBAL_SHARED'
      AND evidence_type <> 'EXPLICIT_GLOBAL_REGISTRY'
  ) THEN
    RAISE EXCEPTION 'Global/shared ownership requires an explicit reviewed registry entry';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM factoryos_governance.tenant_relation_ownership_reviews
    WHERE schema_name = 'public'
      AND ownership_class = 'DERIVED_TENANT'
      AND (scope_predicate IS NULL OR evidence_type <> 'FOREIGN_KEY_LINEAGE')
  ) THEN
    RAISE EXCEPTION 'Derived tenant scope must be backed by a stored PostgreSQL FK-lineage predicate';
  END IF;
END
$$;

-- Adversarial two-tenant test for the important no-direct-tenant_id IAM join
-- tables. The deliberately inconsistent assignment simulates legacy/bad data
-- (only user triggers are disabled while seeding); RLS must still hide it from
-- both tenants. INSERT checks prove cross-tenant writes fail at PostgreSQL.
BEGIN;
INSERT INTO tenants (id, slug, name, status, timezone, default_locale) VALUES
  ('15900000-0000-4000-8000-000000000001', 'ownership-a-159', 'Ownership Scope A', 'ACTIVE', 'Asia/Dhaka', 'en-BD'),
  ('15900000-0000-4000-8000-000000000002', 'ownership-b-159', 'Ownership Scope B', 'ACTIVE', 'Asia/Dhaka', 'en-BD');
INSERT INTO users (id, external_subject, email, display_name, status) VALUES
  ('15910000-0000-4000-8000-000000000001', 'ownership-user-a-159', 'ownership-a-159@factoryos.test', 'Ownership User A', 'ACTIVE'),
  ('15910000-0000-4000-8000-000000000002', 'ownership-user-b-159', 'ownership-b-159@factoryos.test', 'Ownership User B', 'ACTIVE');
INSERT INTO tenant_memberships (id, tenant_id, user_id, status) VALUES
  ('15920000-0000-4000-8000-000000000001', '15900000-0000-4000-8000-000000000001', '15910000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('15920000-0000-4000-8000-000000000002', '15900000-0000-4000-8000-000000000002', '15910000-0000-4000-8000-000000000002', 'ACTIVE');
INSERT INTO factories (id, tenant_id, code, name, status, timezone) VALUES
  ('15930000-0000-4000-8000-000000000001', '15900000-0000-4000-8000-000000000001', 'OWNERSHIP-A', 'Ownership Factory A', 'ACTIVE', 'Asia/Dhaka'),
  ('15930000-0000-4000-8000-000000000002', '15900000-0000-4000-8000-000000000002', 'OWNERSHIP-B', 'Ownership Factory B', 'ACTIVE', 'Asia/Dhaka');
INSERT INTO roles (id, tenant_id, code, name, description, is_system) VALUES
  ('15940000-0000-4000-8000-000000000001', '15900000-0000-4000-8000-000000000001', 'OWNERSHIP_PROBE_A', 'Ownership Probe A', 'Tenant A RLS fixture', false),
  ('15940000-0000-4000-8000-000000000002', '15900000-0000-4000-8000-000000000002', 'OWNERSHIP_PROBE_B', 'Ownership Probe B', 'Tenant B RLS fixture', false);
INSERT INTO permissions (code, description)
VALUES ('test.tenant_ownership_probe_a', 'Tenant ownership RLS fixture A'),
       ('test.tenant_ownership_probe_b', 'Tenant ownership RLS fixture B')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT '15940000-0000-4000-8000-000000000001', id FROM permissions WHERE code = 'test.tenant_ownership_probe_a'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT '15940000-0000-4000-8000-000000000002', id FROM permissions WHERE code = 'test.tenant_ownership_probe_b'
ON CONFLICT DO NOTHING;
INSERT INTO user_roles (id, membership_id, role_id, factory_id) VALUES
  ('15950000-0000-4000-8000-000000000001', '15920000-0000-4000-8000-000000000001', '15940000-0000-4000-8000-000000000001', '15930000-0000-4000-8000-000000000001'),
  ('15950000-0000-4000-8000-000000000002', '15920000-0000-4000-8000-000000000002', '15940000-0000-4000-8000-000000000002', '15930000-0000-4000-8000-000000000002');
ALTER TABLE user_roles DISABLE TRIGGER USER;
INSERT INTO user_roles (id, membership_id, role_id, factory_id)
VALUES ('15950000-0000-4000-8000-000000000003',
        '15920000-0000-4000-8000-000000000001',
        '15940000-0000-4000-8000-000000000002',
        '15930000-0000-4000-8000-000000000002');
ALTER TABLE user_roles ENABLE TRIGGER USER;

SET LOCAL ROLE factoryos_app;
SELECT set_config('app.tenant_id', '15900000-0000-4000-8000-000000000001', true);
DO $$
DECLARE
  visible_count integer;
  foreign_count integer;
  permission_id uuid;
BEGIN
  SELECT count(*) INTO visible_count FROM user_roles
  WHERE id IN (
    '15950000-0000-4000-8000-000000000001',
    '15950000-0000-4000-8000-000000000002',
    '15950000-0000-4000-8000-000000000003'
  );
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'Tenant A must see exactly its own IAM assignment; observed % rows', visible_count;
  END IF;

  SELECT count(*) INTO foreign_count FROM role_permissions
  WHERE role_id = '15940000-0000-4000-8000-000000000002';
  IF foreign_count <> 0 THEN
    RAISE EXCEPTION 'Tenant A can read tenant B role_permissions rows';
  END IF;

  SELECT id INTO permission_id FROM permissions WHERE code = 'test.tenant_ownership_probe_a';
  BEGIN
    INSERT INTO user_roles (id, membership_id, role_id, factory_id)
    VALUES ('15950000-0000-4000-8000-000000000004',
      '15920000-0000-4000-8000-000000000002',
      '15940000-0000-4000-8000-000000000002',
      '15930000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'Tenant A unexpectedly inserted a tenant B user_roles assignment';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO role_permissions (role_id, permission_id)
    VALUES ('15940000-0000-4000-8000-000000000002', permission_id);
    RAISE EXCEPTION 'Tenant A unexpectedly granted a permission to tenant B role';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$$;

SELECT set_config('app.tenant_id', '15900000-0000-4000-8000-000000000002', true);
DO $$
DECLARE
  visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM user_roles
  WHERE id IN (
    '15950000-0000-4000-8000-000000000001',
    '15950000-0000-4000-8000-000000000002',
    '15950000-0000-4000-8000-000000000003'
  );
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'Tenant B must see exactly its own IAM assignment; the mixed-tenant legacy row must remain hidden';
  END IF;
  IF EXISTS (SELECT 1 FROM role_permissions WHERE role_id = '15940000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'Tenant B can read tenant A role_permissions rows';
  END IF;
END
$$;
RESET ROLE;
ROLLBACK;

DO $$
BEGIN
  RAISE NOTICE 'Tenant ownership review and derived-scope cross-tenant read/write checks passed';
END
$$;
