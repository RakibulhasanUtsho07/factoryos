-- Read-only production privilege evidence. Run as an approved DBA.
-- Supply names from the deployment inventory; this script does not create or alter roles.
-- Example: psql "$ADMIN_DSN" -v application_role=factoryos_runtime -v migration_role=factoryos_migrator -v monitoring_role=factoryos_metrics -f deploy/security/postgres-role-audit.sql

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
WHERE rolname IN (:'application_role', :'migration_role', :'monitoring_role')
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
  namespace.nspname AS schema_name,
  has_schema_privilege(:'application_role', namespace.oid, 'USAGE') AS has_usage,
  has_schema_privilege(:'application_role', namespace.oid, 'CREATE') AS has_create
FROM pg_namespace AS namespace
WHERE has_schema_privilege(:'application_role', namespace.oid, 'USAGE')
   OR has_schema_privilege(:'application_role', namespace.oid, 'CREATE')
ORDER BY namespace.nspname;

\echo 'Sequence privileges available to the runtime role'
SELECT
  namespace.nspname AS object_schema,
  sequence.relname AS object_name,
  has_sequence_privilege(:'application_role', sequence.oid, 'USAGE') AS has_usage,
  has_sequence_privilege(:'application_role', sequence.oid, 'SELECT') AS has_select,
  has_sequence_privilege(:'application_role', sequence.oid, 'UPDATE') AS has_update
FROM pg_class AS sequence
JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
WHERE sequence.relkind = 'S'
  AND (
    has_sequence_privilege(:'application_role', sequence.oid, 'USAGE')
    OR has_sequence_privilege(:'application_role', sequence.oid, 'SELECT')
    OR has_sequence_privilege(:'application_role', sequence.oid, 'UPDATE')
  )
ORDER BY namespace.nspname, sequence.relname;

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


\echo 'Effective role memberships including inherited grants'
SELECT
  subject.rolname AS subject_role,
  inherited.rolname AS effective_member_of,
  inherited.rolsuper AS inherited_superuser,
  inherited.rolcreatedb AS inherited_createdb,
  inherited.rolcreaterole AS inherited_createrole,
  inherited.rolreplication AS inherited_replication,
  inherited.rolbypassrls AS inherited_bypassrls
FROM pg_roles AS subject
JOIN pg_roles AS inherited
  ON inherited.oid <> subject.oid
 AND pg_has_role(subject.oid, inherited.oid, 'MEMBER')
WHERE subject.rolname IN (:'application_role', :'migration_role', :'monitoring_role')
ORDER BY subject.rolname, inherited.rolname;

\echo 'Effective relation privileges and ownership for runtime and monitoring identities'
SELECT
  namespace.nspname AS object_schema,
  relation.relname AS object_name,
  relation.relkind AS object_kind,
  owner.rolname AS owner_role,
  (owner.oid = runtime.oid) AS runtime_owns_object,
  has_table_privilege(runtime.oid, relation.oid, 'SELECT') AS runtime_select,
  has_table_privilege(runtime.oid, relation.oid, 'INSERT') AS runtime_insert,
  has_table_privilege(runtime.oid, relation.oid, 'UPDATE') AS runtime_update,
  has_table_privilege(runtime.oid, relation.oid, 'DELETE') AS runtime_delete,
  has_table_privilege(monitor.oid, relation.oid, 'SELECT') AS monitoring_select,
  has_table_privilege(monitor.oid, relation.oid, 'INSERT') AS monitoring_insert,
  has_table_privilege(monitor.oid, relation.oid, 'UPDATE') AS monitoring_update,
  has_table_privilege(monitor.oid, relation.oid, 'DELETE') AS monitoring_delete
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_roles AS owner ON owner.oid = relation.relowner
JOIN pg_roles AS runtime ON runtime.rolname = :'application_role'
JOIN pg_roles AS monitor ON monitor.rolname = :'monitoring_role'
WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
  AND namespace.nspname NOT LIKE 'pg_toast%'
  AND (
    has_table_privilege(runtime.oid, relation.oid, 'SELECT')
    OR has_table_privilege(runtime.oid, relation.oid, 'INSERT')
    OR has_table_privilege(runtime.oid, relation.oid, 'UPDATE')
    OR has_table_privilege(runtime.oid, relation.oid, 'DELETE')
    OR has_table_privilege(monitor.oid, relation.oid, 'SELECT')
    OR has_table_privilege(monitor.oid, relation.oid, 'INSERT')
    OR has_table_privilege(monitor.oid, relation.oid, 'UPDATE')
    OR has_table_privilege(monitor.oid, relation.oid, 'DELETE')
    OR owner.oid IN (runtime.oid, monitor.oid)
  )
ORDER BY namespace.nspname, relation.relname;

\echo 'Effective function execution and ownership'
SELECT
  namespace.nspname AS function_schema,
  procedure.proname AS function_name,
  pg_get_function_identity_arguments(procedure.oid) AS function_arguments,
  owner.rolname AS owner_role,
  (owner.oid = runtime.oid) AS runtime_owns_function,
  has_function_privilege(runtime.oid, procedure.oid, 'EXECUTE') AS runtime_execute,
  has_function_privilege(monitor.oid, procedure.oid, 'EXECUTE') AS monitoring_execute
FROM pg_proc AS procedure
JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
JOIN pg_roles AS owner ON owner.oid = procedure.proowner
JOIN pg_roles AS runtime ON runtime.rolname = :'application_role'
JOIN pg_roles AS monitor ON monitor.rolname = :'monitoring_role'
WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY namespace.nspname, procedure.proname;

\echo 'SCIM deprovision credential-table privilege boundary'
SELECT
  has_table_privilege(:'application_role', 'public.scim_provisioning_credentials', 'SELECT') AS runtime_select,
  has_table_privilege(:'application_role', 'public.scim_provisioning_credentials', 'INSERT') AS runtime_insert,
  has_table_privilege(:'application_role', 'public.scim_provisioning_credentials', 'UPDATE') AS runtime_update,
  has_table_privilege(:'application_role', 'public.scim_provisioning_credentials', 'DELETE') AS runtime_delete,
  has_table_privilege(:'monitoring_role', 'public.scim_provisioning_credentials', 'SELECT') AS monitoring_select,
  has_table_privilege(:'monitoring_role', 'public.scim_provisioning_credentials', 'UPDATE') AS monitoring_update,
  has_table_privilege(:'monitoring_role', 'public.scim_provisioning_credentials', 'DELETE') AS monitoring_delete;

\echo 'Current database owner and runtime/migration creation permissions'
SELECT
  current_database() AS database_name,
  database_owner.rolname AS database_owner,
  database_owner.oid = runtime.oid AS runtime_is_database_owner,
  has_database_privilege(runtime.oid, current_database(), 'CREATE') AS runtime_database_create,
  has_database_privilege(runtime.oid, current_database(), 'TEMP') AS runtime_database_temp,
  has_database_privilege(migrator.oid, current_database(), 'CREATE') AS migration_database_create
FROM pg_database AS database
JOIN pg_roles AS database_owner ON database_owner.oid = database.datdba
JOIN pg_roles AS runtime ON runtime.rolname = :'application_role'
JOIN pg_roles AS migrator ON migrator.rolname = :'migration_role'
WHERE database.datname = current_database();
