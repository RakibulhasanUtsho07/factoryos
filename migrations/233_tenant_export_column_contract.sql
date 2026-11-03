BEGIN;

-- The table-level export allowlist is not a column-level allowlist. Capture a
-- reviewed catalog baseline for each generic direct-table export adapter so a
-- later column addition cannot silently become part of SELECT * exports.
CREATE TABLE IF NOT EXISTS factoryos_governance.tenant_export_column_contracts (
  schema_name text NOT NULL CHECK (schema_name = 'public'),
  relation_name text NOT NULL,
  contract_version integer NOT NULL CHECK (contract_version > 0),
  data_category varchar(40) NOT NULL CHECK (
    data_category IN (
      'BUSINESS_DATA', 'AUDIT_LOG', 'EVIDENCE', 'APPROVALS',
      'EFFECTIVE_DATED_MASTER_DATA', 'AI_CONTEXT', 'LEARNING_EVALUATION'
    )
  ),
  column_manifest jsonb NOT NULL CHECK (
    jsonb_typeof(column_manifest) = 'object'
    AND jsonb_typeof(column_manifest -> 'columns') = 'array'
    AND jsonb_array_length(column_manifest -> 'columns') > 0
  ),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (schema_name, relation_name, contract_version)
);
REVOKE ALL ON TABLE factoryos_governance.tenant_export_column_contracts FROM PUBLIC;

CREATE INDEX IF NOT EXISTS idx_tenant_export_column_contracts_latest
  ON factoryos_governance.tenant_export_column_contracts
    (schema_name, relation_name, contract_version DESC);

CREATE OR REPLACE FUNCTION factoryos_governance.prevent_tenant_export_column_contract_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION
    'Tenant export column contracts are append-only; publish a reviewed new version instead'
    USING ERRCODE = '55000';
END;
$function$;
REVOKE ALL ON FUNCTION factoryos_governance.prevent_tenant_export_column_contract_mutation() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_tenant_export_column_contracts_append_only
  ON factoryos_governance.tenant_export_column_contracts;
CREATE TRIGGER trg_tenant_export_column_contracts_append_only
BEFORE UPDATE OR DELETE ON factoryos_governance.tenant_export_column_contracts
FOR EACH ROW
EXECUTE FUNCTION factoryos_governance.prevent_tenant_export_column_contract_mutation();

DO $$
DECLARE
  expected_count integer;
  baseline_count integer;
BEGIN
  IF to_regclass('factoryos_governance.tenant_relation_inventory') IS NULL THEN
    RAISE EXCEPTION 'Tenant export column contract requires migration 156 inventory';
  END IF;

  SELECT count(*) INTO expected_count
  FROM factoryos_governance.tenant_relation_inventory inventory
  WHERE inventory.schema_name = 'public'
    AND inventory.scope_model = 'DIRECT_TENANT_ID'
    AND inventory.export_disposition = 'ALLOWLISTED'
    AND inventory.data_category IN (
      'BUSINESS_DATA', 'AUDIT_LOG', 'EVIDENCE', 'APPROVALS',
      'EFFECTIVE_DATED_MASTER_DATA', 'AI_CONTEXT', 'LEARNING_EVALUATION'
    );

  IF expected_count < 1 THEN
    RAISE EXCEPTION 'No reviewed generic tenant export relations are available for column-contract capture';
  END IF;

  WITH live_columns AS (
    SELECT
      relation.relname AS relation_name,
      jsonb_agg(
        jsonb_build_object(
          'ordinal', column_meta.attnum,
          'name', column_meta.attname,
          'type', format_type(column_meta.atttypid, column_meta.atttypmod),
          'notNull', column_meta.attnotnull,
          'identity', column_meta.attidentity,
          'generated', column_meta.attgenerated,
          'default', pg_get_expr(default_value.adbin, default_value.adrelid),
          'collation', CASE
            WHEN column_meta.attcollation = 0 THEN NULL
            ELSE collation_schema.nspname || '.' || collation_row.collname
          END
        )
        ORDER BY column_meta.attnum
      ) AS columns
    FROM pg_catalog.pg_class relation
    INNER JOIN pg_catalog.pg_namespace relation_schema
      ON relation_schema.oid = relation.relnamespace
    INNER JOIN pg_catalog.pg_attribute column_meta
      ON column_meta.attrelid = relation.oid
      AND column_meta.attnum > 0
      AND NOT column_meta.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef default_value
      ON default_value.adrelid = relation.oid
      AND default_value.adnum = column_meta.attnum
    LEFT JOIN pg_catalog.pg_collation collation_row
      ON collation_row.oid = column_meta.attcollation
      AND column_meta.attcollation <> 0
    LEFT JOIN pg_catalog.pg_namespace collation_schema
      ON collation_schema.oid = collation_row.collnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND relation.relname IN (
        SELECT inventory.relation_name
        FROM factoryos_governance.tenant_relation_inventory inventory
        WHERE inventory.schema_name = 'public'
          AND inventory.scope_model = 'DIRECT_TENANT_ID'
          AND inventory.export_disposition = 'ALLOWLISTED'
          AND inventory.data_category IN (
            'BUSINESS_DATA', 'AUDIT_LOG', 'EVIDENCE', 'APPROVALS',
            'EFFECTIVE_DATED_MASTER_DATA', 'AI_CONTEXT', 'LEARNING_EVALUATION'
          )
      )
    GROUP BY relation.relname
  )
  INSERT INTO factoryos_governance.tenant_export_column_contracts (
    schema_name, relation_name, contract_version, data_category, column_manifest
  )
  SELECT
    'public',
    inventory.relation_name,
    1,
    inventory.data_category,
    jsonb_build_object('category', inventory.data_category, 'columns', live_columns.columns)
  FROM factoryos_governance.tenant_relation_inventory inventory
  INNER JOIN live_columns ON live_columns.relation_name = inventory.relation_name
  WHERE inventory.schema_name = 'public'
    AND inventory.scope_model = 'DIRECT_TENANT_ID'
    AND inventory.export_disposition = 'ALLOWLISTED'
    AND inventory.data_category IN (
      'BUSINESS_DATA', 'AUDIT_LOG', 'EVIDENCE', 'APPROVALS',
      'EFFECTIVE_DATED_MASTER_DATA', 'AI_CONTEXT', 'LEARNING_EVALUATION'
    )
  ON CONFLICT (schema_name, relation_name, contract_version) DO NOTHING;

  SELECT count(*) INTO baseline_count
  FROM factoryos_governance.tenant_export_column_contracts
  WHERE schema_name = 'public' AND contract_version = 1;

  IF baseline_count <> expected_count THEN
    RAISE EXCEPTION
      'Tenant export column baseline is incomplete: expected %, found %',
      expected_count, baseline_count;
  END IF;
END;
$$;

-- The application may compare the catalog with the sealed manifest but cannot
-- author or mutate the approval baseline.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'factoryos_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA factoryos_governance TO factoryos_app';
    EXECUTE 'GRANT SELECT ON factoryos_governance.tenant_export_column_contracts TO factoryos_app';
  END IF;
END;
$$;

INSERT INTO schema_migrations(version, checksum)
VALUES ('233_tenant_export_column_contract', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
