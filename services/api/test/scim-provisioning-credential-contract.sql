-- PostgreSQL contract for the optional tenant-scoped SCIM provisioning
-- credential store. This validates the real schema, forced RLS and exact
-- per-column runtime/provisioner grants after the deployment grant script runs.
DO $$
DECLARE
  v_table oid := to_regclass('public.scim_provisioning_credentials');
  v_rls boolean;
  v_force_rls boolean;
  v_policy_count integer;
  v_has_public_privilege boolean;
  v_owner oid;
  v_app oid;
  v_provisioner oid;
  v_app_super boolean;
  v_app_bypass boolean;
  v_provisioner_super boolean;
  v_provisioner_bypass boolean;
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'SCIM provisioning credential table is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.schema_migrations
    WHERE version = '230_scim_tenant_deprovision_credentials'
  ) THEN
    RAISE EXCEPTION 'SCIM provisioning migration marker is missing';
  END IF;

  SELECT c.relrowsecurity, c.relforcerowsecurity, c.relowner
    INTO v_rls, v_force_rls, v_owner
  FROM pg_class c WHERE c.oid = v_table;
  IF v_rls IS DISTINCT FROM TRUE OR v_force_rls IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'SCIM credential storage must enable and FORCE ROW LEVEL SECURITY';
  END IF;

  SELECT count(*) INTO v_policy_count
  FROM pg_policy p
  WHERE p.polrelid = v_table
    AND p.polname IN (
      'scim_provisioning_credentials_tenant_allow',
      'scim_provisioning_credentials_tenant_enforce'
    )
    AND COALESCE(pg_get_expr(p.polqual, p.polrelid), '') ILIKE '%tenant_id%'
    AND COALESCE(pg_get_expr(p.polqual, p.polrelid), '') ILIKE '%factoryos_current_tenant_id%'
    AND COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') ILIKE '%tenant_id%'
    AND COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') ILIKE '%factoryos_current_tenant_id%';
  IF v_policy_count <> 2 THEN
    RAISE EXCEPTION 'both permissive and restrictive tenant-bound SCIM RLS policies are required';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    WHERE a.grantee = 0
      AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
  ) INTO v_has_public_privilege
  FROM pg_class c WHERE c.oid = v_table;
  IF v_has_public_privilege THEN
    RAISE EXCEPTION 'PUBLIC must have no privileges on SCIM credentials';
  END IF;

  SELECT oid, rolsuper, rolbypassrls
    INTO v_app, v_app_super, v_app_bypass
  FROM pg_roles WHERE rolname = 'factoryos_app';
  IF v_app IS NULL OR v_app_super OR v_app_bypass THEN
    RAISE EXCEPTION 'SCIM application role must exist without superuser or BYPASSRLS';
  END IF;

  SELECT oid, rolsuper, rolbypassrls
    INTO v_provisioner, v_provisioner_super, v_provisioner_bypass
  FROM pg_roles WHERE rolname = 'factoryos_scim_provisioner';
  IF v_provisioner IS NULL OR v_provisioner_super OR v_provisioner_bypass THEN
    RAISE EXCEPTION 'SCIM provisioning role must exist without superuser or BYPASSRLS';
  END IF;
  IF v_owner IN (v_app, v_provisioner) THEN
    RAISE EXCEPTION 'SCIM runtime/provisioning role must not own the credential table';
  END IF;
  IF pg_has_role(v_app, v_provisioner, 'MEMBER') OR pg_has_role(v_provisioner, v_app, 'MEMBER') THEN
    RAISE EXCEPTION 'SCIM runtime and provisioning roles must not inherit one another';
  END IF;

  -- Runtime: the authentication UPDATE may write last_used_at, while WHERE and
  -- RETURNING columns are SELECT-only. It must not create, rotate, revoke or
  -- delete credentials.
  IF NOT has_column_privilege(v_app, v_table, 'tenant_id', 'SELECT')
     OR NOT has_column_privilege(v_app, v_table, 'issuer', 'SELECT')
     OR NOT has_column_privilege(v_app, v_table, 'token_sha256', 'SELECT')
     OR NOT has_column_privilege(v_app, v_table, 'scopes', 'SELECT')
     OR NOT has_column_privilege(v_app, v_table, 'status', 'SELECT')
     OR NOT has_column_privilege(v_app, v_table, 'expires_at', 'SELECT')
     OR NOT has_column_privilege(v_app, v_table, 'last_used_at', 'UPDATE') THEN
    RAISE EXCEPTION 'SCIM runtime column grants are incomplete';
  END IF;
  IF has_table_privilege(v_app, v_table, 'SELECT')
     OR has_table_privilege(v_app, v_table, 'INSERT')
     OR has_table_privilege(v_app, v_table, 'UPDATE')
     OR has_table_privilege(v_app, v_table, 'DELETE')
     OR has_table_privilege(v_app, v_table, 'TRUNCATE')
     OR has_column_privilege(v_app, v_table, 'status', 'UPDATE')
     OR has_column_privilege(v_app, v_table, 'revoked_at', 'UPDATE')
     OR has_column_privilege(v_app, v_table, 'token_sha256', 'UPDATE')
     OR has_column_privilege(v_app, v_table, 'tenant_id', 'INSERT') THEN
    RAISE EXCEPTION 'SCIM runtime role has broad table/credential-management privileges';
  END IF;

  -- Provisioner: only the columns required to locate a tenant, create a hashed
  -- credential and rotate/revoke its status are writable.
  IF NOT has_column_privilege(v_provisioner, v_table, 'id', 'SELECT')
     OR NOT has_column_privilege(v_provisioner, v_table, 'tenant_id', 'SELECT')
     OR NOT has_column_privilege(v_provisioner, v_table, 'token_sha256', 'SELECT')
     OR NOT has_column_privilege(v_provisioner, v_table, 'status', 'SELECT')
     OR NOT has_column_privilege(v_provisioner, v_table, 'tenant_id', 'INSERT')
     OR NOT has_column_privilege(v_provisioner, v_table, 'issuer', 'INSERT')
     OR NOT has_column_privilege(v_provisioner, v_table, 'token_sha256', 'INSERT')
     OR NOT has_column_privilege(v_provisioner, v_table, 'scopes', 'INSERT')
     OR NOT has_column_privilege(v_provisioner, v_table, 'status', 'INSERT')
     OR NOT has_column_privilege(v_provisioner, v_table, 'expires_at', 'INSERT')
     OR NOT has_column_privilege(v_provisioner, v_table, 'status', 'UPDATE')
     OR NOT has_column_privilege(v_provisioner, v_table, 'revoked_at', 'UPDATE')
     OR NOT has_column_privilege(v_provisioner, 'public.tenants'::regclass, 'id', 'SELECT')
     OR NOT has_column_privilege(v_provisioner, 'public.tenants'::regclass, 'status', 'SELECT') THEN
    RAISE EXCEPTION 'SCIM provisioning role grants are incomplete';
  END IF;
  IF has_table_privilege(v_provisioner, v_table, 'SELECT')
     OR has_table_privilege(v_provisioner, v_table, 'INSERT')
     OR has_table_privilege(v_provisioner, v_table, 'UPDATE')
     OR has_table_privilege(v_provisioner, v_table, 'DELETE')
     OR has_table_privilege(v_provisioner, v_table, 'TRUNCATE')
     OR has_column_privilege(v_provisioner, v_table, 'last_used_at', 'UPDATE')
     OR has_column_privilege(v_provisioner, v_table, 'tenant_id', 'UPDATE')
     OR has_column_privilege(v_provisioner, v_table, 'token_sha256', 'UPDATE') THEN
    RAISE EXCEPTION 'SCIM provisioning role has privileges beyond its reviewed column allowlist';
  END IF;

  RAISE NOTICE 'SCIM migration, forced RLS, tenant policies, and least-privilege role grants verified';
END
$$;
