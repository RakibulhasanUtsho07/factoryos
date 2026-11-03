-- Verify that the reviewed tenant-export relation set admits a safe parent-first insert order.
-- The importer reads pg_constraint at runtime; this checks the real PostgreSQL catalog.
DO $$
DECLARE
  cycle_path text;
  blueprint_pointer_count integer;
  research_evaluation_pointer_count integer;
  evidence_predecessor_count integer;
  inventory_location_parent_count integer;
BEGIN
  IF to_regclass('factoryos_governance.tenant_relation_inventory') IS NULL THEN
    RAISE EXCEPTION 'Tenant export dependency contract requires the migration 156 relation inventory';
  END IF;

  SELECT count(*) INTO blueprint_pointer_count
  FROM pg_constraint con
  JOIN pg_class child ON child.oid = con.conrelid
  JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
  JOIN pg_class parent ON parent.oid = con.confrelid
  JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS child_key(attnum, ordinality) ON TRUE
  JOIN pg_attribute child_column ON child_column.attrelid = con.conrelid
    AND child_column.attnum = child_key.attnum AND NOT child_column.attisdropped
  WHERE con.contype = 'f' AND con.conname = 'fk_business_blueprints_current_version'
    AND child_namespace.nspname = 'public' AND parent_namespace.nspname = 'public'
    AND child.relname = 'business_blueprints' AND parent.relname = 'business_blueprint_versions'
    AND child_column.attname = 'current_version_id' AND NOT con.condeferrable
    AND (
      SELECT array_agg(child_attribute.attname::text ORDER BY child_key_check.ordinality)
      FROM unnest(con.conkey) WITH ORDINALITY AS child_key_check(attnum, ordinality)
      JOIN pg_attribute child_attribute ON child_attribute.attrelid = con.conrelid
        AND child_attribute.attnum = child_key_check.attnum AND NOT child_attribute.attisdropped
    ) = ARRAY['current_version_id', 'tenant_id', 'factory_id']::text[]
    AND (
      SELECT array_agg(parent_attribute.attname::text ORDER BY parent_key_check.ordinality)
      FROM unnest(con.confkey) WITH ORDINALITY AS parent_key_check(attnum, ordinality)
      JOIN pg_attribute parent_attribute ON parent_attribute.attrelid = con.confrelid
        AND parent_attribute.attnum = parent_key_check.attnum AND NOT parent_attribute.attisdropped
    ) = ARRAY['id', 'tenant_id', 'factory_id']::text[];
  IF blueprint_pointer_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one immediate business_blueprints.current_version_id FK to business_blueprint_versions';
  END IF;

  SELECT count(*) INTO research_evaluation_pointer_count
  FROM pg_constraint con
  JOIN pg_class child ON child.oid = con.conrelid
  JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
  JOIN pg_class parent ON parent.oid = con.confrelid
  JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS child_key(attnum, ordinality) ON TRUE
  JOIN pg_attribute child_column ON child_column.attrelid = con.conrelid
    AND child_column.attnum = child_key.attnum AND NOT child_column.attisdropped
  WHERE con.contype = 'f' AND con.conname = 'fk_research_release_evaluation_owner'
    AND child_namespace.nspname = 'public' AND parent_namespace.nspname = 'public'
    AND child.relname = 'research_knowledge_releases' AND parent.relname = 'research_release_evaluations'
    AND child_column.attname = 'evaluation_id' AND NOT con.condeferrable
    AND (
      SELECT array_agg(child_attribute.attname::text ORDER BY child_key_check.ordinality)
      FROM unnest(con.conkey) WITH ORDINALITY AS child_key_check(attnum, ordinality)
      JOIN pg_attribute child_attribute ON child_attribute.attrelid = con.conrelid
        AND child_attribute.attnum = child_key_check.attnum AND NOT child_attribute.attisdropped
    ) = ARRAY['evaluation_id', 'id']::text[]
    AND (
      SELECT array_agg(parent_attribute.attname::text ORDER BY parent_key_check.ordinality)
      FROM unnest(con.confkey) WITH ORDINALITY AS parent_key_check(attnum, ordinality)
      JOIN pg_attribute parent_attribute ON parent_attribute.attrelid = con.confrelid
        AND parent_attribute.attnum = parent_key_check.attnum AND NOT parent_attribute.attisdropped
    ) = ARRAY['id', 'release_id']::text[];
  IF research_evaluation_pointer_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one immediate research release evaluation pointer FK';
  END IF;

  SELECT count(*) INTO evidence_predecessor_count
  FROM pg_constraint con
  JOIN pg_class child ON child.oid = con.conrelid
  JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
  JOIN pg_class parent ON parent.oid = con.confrelid
  JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS child_key(attnum, ordinality) ON TRUE
  JOIN pg_attribute child_column ON child_column.attrelid = con.conrelid
    AND child_column.attnum = child_key.attnum AND NOT child_column.attisdropped
  WHERE con.contype = 'f' AND con.conname = 'fk_business_evidence_supersedes_scope'
    AND child_namespace.nspname = 'public' AND parent_namespace.nspname = 'public'
    AND child.relname = 'business_evidence' AND parent.relname = 'business_evidence'
    AND child_column.attname = 'supersedes_evidence_id' AND NOT con.condeferrable
    AND (
      SELECT array_agg(child_attribute.attname::text ORDER BY child_key_check.ordinality)
      FROM unnest(con.conkey) WITH ORDINALITY AS child_key_check(attnum, ordinality)
      JOIN pg_attribute child_attribute ON child_attribute.attrelid = con.conrelid
        AND child_attribute.attnum = child_key_check.attnum AND NOT child_attribute.attisdropped
    ) = ARRAY['supersedes_evidence_id', 'tenant_id', 'factory_id']::text[]
    AND (
      SELECT array_agg(parent_attribute.attname::text ORDER BY parent_key_check.ordinality)
      FROM unnest(con.confkey) WITH ORDINALITY AS parent_key_check(attnum, ordinality)
      JOIN pg_attribute parent_attribute ON parent_attribute.attrelid = con.confrelid
        AND parent_attribute.attnum = parent_key_check.attnum AND NOT parent_attribute.attisdropped
    ) = ARRAY['id', 'tenant_id', 'factory_id']::text[];
  IF evidence_predecessor_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one immediate business-evidence predecessor self-FK';
  END IF;

  SELECT count(*) INTO inventory_location_parent_count
  FROM pg_constraint con
  JOIN pg_class child ON child.oid = con.conrelid
  JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
  JOIN pg_class parent ON parent.oid = con.confrelid
  JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
  WHERE con.contype = 'f' AND con.conname = 'fk_inventory_location_parent_scope'
    AND child_namespace.nspname = 'public' AND parent_namespace.nspname = 'public'
    AND child.relname = 'inventory_locations' AND parent.relname = 'inventory_locations'
    AND NOT con.condeferrable
    AND (
      SELECT array_agg(child_attribute.attname::text ORDER BY child_key_check.ordinality)
      FROM unnest(con.conkey) WITH ORDINALITY AS child_key_check(attnum, ordinality)
      JOIN pg_attribute child_attribute ON child_attribute.attrelid = con.conrelid
        AND child_attribute.attnum = child_key_check.attnum AND NOT child_attribute.attisdropped
    ) = ARRAY['parent_location_id', 'tenant_id', 'factory_id']::text[]
    AND (
      SELECT array_agg(parent_attribute.attname::text ORDER BY parent_key_check.ordinality)
      FROM unnest(con.confkey) WITH ORDINALITY AS parent_key_check(attnum, ordinality)
      JOIN pg_attribute parent_attribute ON parent_attribute.attrelid = con.confrelid
        AND parent_attribute.attnum = parent_key_check.attnum AND NOT parent_attribute.attisdropped
    ) = ARRAY['id', 'tenant_id', 'factory_id']::text[];
  IF inventory_location_parent_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one immediate inventory-location parent hierarchy self-FK';
  END IF;

  WITH RECURSIVE adapter_tables AS (
    SELECT relation_name
    FROM factoryos_governance.tenant_relation_inventory
    WHERE schema_name = 'public'
      AND scope_model = 'DIRECT_TENANT_ID'
      AND export_disposition = 'ALLOWLISTED'
      AND relation_name NOT IN ('tenant_memberships', 'roles')
  ),
  raw_edges AS (
    SELECT child.relname AS child_table,
           parent.relname AS parent_table,
           con.conname AS constraint_name,
           con.condeferrable AS is_deferrable,
           array_agg(child_column.attname::text ORDER BY child_key.ordinality) AS child_columns,
           array_agg(parent_column.attname::text ORDER BY parent_key.ordinality) AS parent_columns
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS child_key(attnum, ordinality) ON TRUE
    JOIN pg_attribute child_column ON child_column.attrelid = con.conrelid
      AND child_column.attnum = child_key.attnum AND NOT child_column.attisdropped
    JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS parent_key(attnum, ordinality)
      ON parent_key.ordinality = child_key.ordinality
    JOIN pg_attribute parent_column ON parent_column.attrelid = con.confrelid
      AND parent_column.attnum = parent_key.attnum AND NOT parent_column.attisdropped
    WHERE con.contype = 'f'
      AND child_namespace.nspname = 'public'
      AND parent_namespace.nspname = 'public'
      AND child.relname IN (SELECT relation_name FROM adapter_tables)
      AND parent.relname IN (SELECT relation_name FROM adapter_tables)
    GROUP BY con.oid, child.relname, parent.relname, con.conname, con.condeferrable
  ),
  insert_edges AS (
    SELECT parent_table, child_table
    FROM raw_edges
    WHERE NOT is_deferrable
      AND NOT (
        constraint_name = 'fk_business_blueprints_current_version'
        AND child_table = 'business_blueprints'
        AND parent_table = 'business_blueprint_versions'
        AND child_columns = ARRAY['current_version_id', 'tenant_id', 'factory_id']::text[]
        AND parent_columns = ARRAY['id', 'tenant_id', 'factory_id']::text[]
      )
      AND NOT (
        constraint_name = 'fk_research_release_evaluation_owner'
        AND child_table = 'research_knowledge_releases'
        AND parent_table = 'research_release_evaluations'
        AND child_columns = ARRAY['evaluation_id', 'id']::text[]
        AND parent_columns = ARRAY['id', 'release_id']::text[]
      )
      AND NOT (
        constraint_name = 'fk_business_evidence_supersedes_scope'
        AND child_table = 'business_evidence'
        AND parent_table = 'business_evidence'
        AND child_columns = ARRAY['supersedes_evidence_id', 'tenant_id', 'factory_id']::text[]
        AND parent_columns = ARRAY['id', 'tenant_id', 'factory_id']::text[]
      )
      AND NOT (
        constraint_name = 'fk_inventory_location_parent_scope'
        AND child_table = 'inventory_locations'
        AND parent_table = 'inventory_locations'
        AND child_columns = ARRAY['parent_location_id', 'tenant_id', 'factory_id']::text[]
        AND parent_columns = ARRAY['id', 'tenant_id', 'factory_id']::text[]
      )
  ),
  walk(start_table, current_table, path, has_cycle) AS (
    SELECT parent_table, child_table, ARRAY[parent_table, child_table]::text[], parent_table = child_table
    FROM insert_edges
    UNION ALL
    SELECT walk.start_table, edge.child_table, walk.path || edge.child_table, edge.child_table = ANY(walk.path)
    FROM walk
    INNER JOIN insert_edges edge ON edge.parent_table = walk.current_table
    WHERE NOT walk.has_cycle
      AND cardinality(walk.path) <= (SELECT count(*) + 1 FROM adapter_tables)
  )
  SELECT string_agg(start_table || ': ' || array_to_string(path, ' -> '), E'\\n' ORDER BY start_table, path::text)
  INTO cycle_path
  FROM walk
  WHERE has_cycle;

  IF cycle_path IS NOT NULL THEN
    RAISE EXCEPTION 'Unreviewed non-deferrable FK cycles remain after the four reviewed importer strategies:%s%s', E'\\n', cycle_path;
  END IF;
END
$$;