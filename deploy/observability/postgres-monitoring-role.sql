-- FactoryOS monitoring-role grants; run as an approved DBA in a reviewed change window.
-- Create the NOLOGIN group and separate LOGIN principal through the approved DBA/secret workflow
-- before applying. Set these three values for the target environment; never put a password here.
\set database_name 'factoryos'
\set monitor_group 'factoryos_observability_reader'
\set monitor_login 'factoryos_exporter_login'

-- PostgreSQL system statistics/lock visibility only. No superuser or BYPASSRLS is granted.
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database_name', :'monitor_group') \gexec
SELECT format('GRANT pg_monitor TO %I', :'monitor_group') \gexec
SELECT format('GRANT %I TO %I', :'monitor_group', :'monitor_login') \gexec

-- Deliberately absent:
--   SELECT on tenant/business tables (including outbox_events)
--   BYPASSRLS, SUPERUSER, CREATE, UPDATE, DELETE or other business-data grants
