-- FactoryOS PostgreSQL principal inventory login bootstrap.
-- Run as the approved database administrator in each RDS/Aurora PostgreSQL cluster.
-- This creates only a monitoring login; it does not grant table-data access.
-- Set psql variables before execution:
--   \set database_username 'factoryos_pitr_inventory'
--   \set database_name 'postgres'

SELECT format(
  'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'database_username'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'database_username'
)
\gexec

SELECT format('GRANT rds_iam, pg_read_all_stats TO %I', :'database_username')
\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database_name', :'database_username')
\gexec

-- Deliberately do not grant SELECT on application tables, pg_read_all_data,
-- rds_superuser, pg_read_server_files, pg_write_server_files, or replication.
-- The reader queries only pg_catalog/pg_stat metadata in BEGIN READ ONLY.
