-- Run after migration 233 and after the application login is provisioned.
-- Keep the runtime privilege limited to reading the sealed column-contract table.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'factoryos_app') THEN
    RAISE EXCEPTION 'factoryos_app role is missing; provision the runtime login before granting export contract access';
  END IF;

  IF to_regclass('factoryos_governance.tenant_export_column_contracts') IS NULL THEN
    RAISE EXCEPTION 'tenant export column contract table is missing; apply migration 233 first';
  END IF;

  EXECUTE 'GRANT USAGE ON SCHEMA factoryos_governance TO factoryos_app';
  EXECUTE 'GRANT SELECT ON TABLE factoryos_governance.tenant_export_column_contracts TO factoryos_app';
END;
$$;
