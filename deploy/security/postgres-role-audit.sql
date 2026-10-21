-- Read-only production privilege evidence. Run as an approved DBA.
-- Supply names from the deployment inventory; this script does not create or alter roles.
-- Example: psql "$ADMIN_DSN" -v application_role=factoryos_runtime -v migration_role=factoryos_migrator -f deploy/security/postgres-role-audit.sql

\echo 'FactoryOS role attributes (runtime and migration identities)'
SELECT
  rolname,
  rolcanlogin,
  rolsuper,
  rolcreatedb,
  rolcreaterole,
  rolreplication,
  rolbypassrls,
  rolinherit,
  rolvaliduntil
FROM pg_roles
WHERE rolname IN (:'application_role', :'migration_role')
ORDER BY rolname;

\echo 'Role membership edges (inspect inherited privileged roles)'
SELECT
  member.rolname AS member_role,
  granted.rolname AS granted_role,
  membership.admin_option,
  granted.rolsuper AS granted_role_is_superuser,
  granted.rolbypassrls AS granted_role_bypasses_rls
FROM pg_auth_members AS membership
JOIN pg_roles AS member ON member.oid = membership.member
JOIN pg_roles AS granted ON granted.oid = membership.roleid
WHERE member.rolname IN (:'application_role', :'migration_role')
ORDER BY member.rolname, granted.rolname;

\echo 'Direct object privileges granted to the runtime role'
SELECT
  table_schema,
  table_name,
  privilege_type,
  is_grantable
FROM information_schema.role_table_grants
WHERE grantee = :'application_role'
ORDER BY table_schema, table_name, privilege_type;

\echo 'Schema privileges granted to the runtime role'
SELECT
  schema_name,
  privilege_type,
  is_grantable
FROM information_schema.schema_privileges
WHERE grantee = :'application_role'
ORDER BY schema_name, privilege_type;

\echo 'Sequence privileges granted to the runtime role'
SELECT
  object_schema,
  object_name,
  privilege_type,
  is_grantable
FROM information_schema.role_usage_grants
WHERE grantee = :'application_role'
  AND object_type = 'SEQUENCE'
ORDER BY object_schema, object_name, privilege_type;

\echo 'Default privileges that can grant new objects to runtime role'
SELECT
  owner.rolname AS owner_role,
  namespace.nspname AS schema_name,
  defaults.defaclobjtype AS object_type,
  defaults.defaclacl AS default_acl
FROM pg_default_acl AS defaults
JOIN pg_roles AS owner ON owner.oid = defaults.defaclrole
LEFT JOIN pg_namespace AS namespace ON namespace.oid = defaults.defaclnamespace
WHERE defaults.defaclacl::text LIKE '%' || :'application_role' || '%'
ORDER BY owner.rolname, namespace.nspname, defaults.defaclobjtype;
