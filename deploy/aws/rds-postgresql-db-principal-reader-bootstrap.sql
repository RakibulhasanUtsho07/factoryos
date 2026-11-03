-- FactoryOS database-native principal inventory bootstrap.
-- Run manually through the approved DBA change path; this file does not connect to AWS.
-- This role has no password and must authenticate only through RDS IAM DB authentication.
\set ON_ERROR_STOP on

DO $factoryos$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'factoryos_db_inventory_reader'
  ) THEN
    RAISE EXCEPTION 'factoryos_db_inventory_reader already exists; inspect and reconcile it manually';
  END IF;

  CREATE ROLE factoryos_db_inventory_reader
    LOGIN INHERIT
    NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS;
END
$factoryos$;

-- AWS RDS/Aurora provides rds_iam; pg_monitor grants bounded monitoring visibility.
GRANT rds_iam, pg_monitor TO factoryos_db_inventory_reader;

-- Allow catalog inspection to connect to each currently connectable non-template database.
-- Re-run through the DBA provisioning path for any database created after this bootstrap.
SELECT pg_catalog.format(
  'GRANT CONNECT ON DATABASE %I TO %I',
  datname,
  'factoryos_db_inventory_reader'
)
FROM pg_catalog.pg_database
WHERE NOT datistemplate
  AND datallowconn
ORDER BY datname
\gexec

-- Review the resulting login attributes before enabling the dedicated AWS role.
SELECT rolname, rolcanlogin, rolsuper, rolinherit, rolcreaterole,
       rolcreatedb, rolreplication, rolbypassrls
FROM pg_catalog.pg_roles
WHERE rolname = 'factoryos_db_inventory_reader';
