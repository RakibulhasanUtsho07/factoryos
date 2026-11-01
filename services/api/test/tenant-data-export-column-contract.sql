-- Live PostgreSQL acceptance for the versioned tenant-export column manifest.
DO $$
DECLARE
  expected_count integer;
  baseline_count integer;
  mismatch_count integer;
  append_only_trigger_count integer;
  matched boolean;
BEGIN
  IF to_regclass('factoryos_governance.tenant_export_column_contracts') IS NULL THEN
    RAISE EXCEPTION 'Tenant export column contract table is missing; migration 233 must run first';
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

  SELECT count(*) INTO baseline_count
  FROM factoryos_governance.tenant_export_column_contracts
  WHERE schema_name = 'public' AND contract_version = 1;

  IF baseline_count <> expected_count THEN
    RAISE EXCEPTION 'Expected % baseline manifests, found %', expected_count, baseline_count;
  END IF;

  WITH latest_contracts AS (
    SELECT DISTINCT ON (schema_name, relation_name)
      schema_name, relation_name, data_category, column_manifest
    FROM factoryos_governance.tenant_export_column_contracts
    WHERE schema_name = 'public'
    ORDER BY schema_name, relation_name, contract_version DESC
  ),
  live_columns AS (
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
    INNER JOIN pg_catalog.pg_namespace relation_schema ON relation_schema.oid = relation.relnamespace
    INNER JOIN pg_catalog.pg_attribute column_meta
      ON column_meta.attrelid = relation.oid
      AND column_meta.attnum > 0
      AND NOT column_meta.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef default_value
      ON default_value.adrelid = relation.oid AND default_value.adnum = column_meta.attnum
    LEFT JOIN pg_catalog.pg_collation collation_row
      ON collation_row.oid = column_meta.attcollation AND column_meta.attcollation <> 0
    LEFT JOIN pg_catalog.pg_namespace collation_schema ON collation_schema.oid = collation_row.collnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND relation.relname IN (SELECT relation_name FROM latest_contracts)
    GROUP BY relation.relname
  ),
  live_manifests AS (
    SELECT
      inventory.relation_name,
      inventory.data_category,
      jsonb_build_object('category', inventory.data_category, 'columns', live_columns.columns) AS column_manifest
    FROM factoryos_governance.tenant_relation_inventory inventory
    INNER JOIN live_columns ON live_columns.relation_name = inventory.relation_name
    WHERE inventory.schema_name = 'public'
      AND inventory.scope_model = 'DIRECT_TENANT_ID'
      AND inventory.export_disposition = 'ALLOWLISTED'
      AND inventory.data_category IN (
        'BUSINESS_DATA', 'AUDIT_LOG', 'EVIDENCE', 'APPROVALS',
        'EFFECTIVE_DATED_MASTER_DATA', 'AI_CONTEXT', 'LEARNING_EVALUATION'
      )
  )
  SELECT count(*) INTO mismatch_count
  FROM factoryos_governance.tenant_relation_inventory inventory
  LEFT JOIN latest_contracts contracts
    ON contracts.schema_name = 'public' AND contracts.relation_name = inventory.relation_name
  LEFT JOIN live_manifests live ON live.relation_name = inventory.relation_name
  WHERE inventory.schema_name = 'public'
    AND inventory.scope_model = 'DIRECT_TENANT_ID'
    AND inventory.export_disposition = 'ALLOWLISTED'
    AND inventory.data_category IN (
      'BUSINESS_DATA', 'AUDIT_LOG', 'EVIDENCE', 'APPROVALS',
      'EFFECTIVE_DATED_MASTER_DATA', 'AI_CONTEXT', 'LEARNING_EVALUATION'
    )
    AND (
      contracts.relation_name IS NULL
      OR live.relation_name IS NULL
      OR contracts.data_category <> live.data_category
      OR contracts.column_manifest <> live.column_manifest
    );

  IF mismatch_count <> 0 THEN
    RAISE EXCEPTION '% generic export relation(s) have a missing or stale column manifest', mismatch_count;
  END IF;

  SELECT count(*) INTO append_only_trigger_count
  FROM pg_catalog.pg_trigger trigger_meta
  JOIN pg_catalog.pg_class relation ON relation.oid = trigger_meta.tgrelid
  JOIN pg_catalog.pg_namespace relation_schema ON relation_schema.oid = relation.relnamespace
  WHERE relation_schema.nspname = 'factoryos_governance'
    AND relation.relname = 'tenant_export_column_contracts'
    AND trigger_meta.tgname = 'trg_tenant_export_column_contracts_append_only'
    AND trigger_meta.tgenabled = 'O'
    AND NOT trigger_meta.tgisinternal;

  IF append_only_trigger_count <> 1 THEN
    RAISE EXCEPTION 'Tenant export column manifest must have one enabled append-only trigger';
  END IF;

  -- The append-only trigger must reject both UPDATE and DELETE, even for the
  -- database migration owner. The test catches only the dedicated SQLSTATE.
  BEGIN
    UPDATE factoryos_governance.tenant_export_column_contracts
    SET captured_at = captured_at
    WHERE schema_name = 'public' AND relation_name = 'orders' AND contract_version = 1;
    RAISE EXCEPTION 'Expected column-contract UPDATE to be rejected';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  BEGIN
    DELETE FROM factoryos_governance.tenant_export_column_contracts
    WHERE schema_name = 'public' AND relation_name = 'orders' AND contract_version = 1;
    RAISE EXCEPTION 'Expected column-contract DELETE to be rejected';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  -- Add a synthetic field inside a PL/pgSQL subtransaction. The catalog digest
  -- must differ, then the exception rolls back the DDL before leaving this test.
  BEGIN
    ALTER TABLE public.orders ADD COLUMN factoryos_ci_unreviewed_export_probe text;

    WITH live_columns AS (
      SELECT jsonb_agg(
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
      JOIN pg_catalog.pg_namespace relation_schema ON relation_schema.oid = relation.relnamespace
      JOIN pg_catalog.pg_attribute column_meta
        ON column_meta.attrelid = relation.oid
        AND column_meta.attnum > 0
        AND NOT column_meta.attisdropped
      LEFT JOIN pg_catalog.pg_attrdef default_value
        ON default_value.adrelid = relation.oid AND default_value.adnum = column_meta.attnum
      LEFT JOIN pg_catalog.pg_collation collation_row
        ON collation_row.oid = column_meta.attcollation AND column_meta.attcollation <> 0
      LEFT JOIN pg_catalog.pg_namespace collation_schema ON collation_schema.oid = collation_row.collnamespace
      WHERE relation_schema.nspname = 'public' AND relation.relname = 'orders'
      GROUP BY relation.relname
    )
    SELECT contracts.column_manifest =
      jsonb_build_object('category', contracts.data_category, 'columns', live_columns.columns)
    INTO matched
    FROM factoryos_governance.tenant_export_column_contracts contracts
    CROSS JOIN live_columns
    WHERE contracts.schema_name = 'public'
      AND contracts.relation_name = 'orders'
      AND contracts.contract_version = 1;

    IF matched IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'Unreviewed added column did not invalidate the export manifest';
    END IF;

    RAISE EXCEPTION 'ROLLBACK_EXPORT_SCHEMA_DRIFT_PROBE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ROLLBACK_EXPORT_SCHEMA_DRIFT_PROBE' THEN
      RAISE;
    END IF;
  END;
END
$$;
