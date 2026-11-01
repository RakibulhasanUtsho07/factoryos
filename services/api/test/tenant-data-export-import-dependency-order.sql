-- Verify that the reviewed tenant-export relation set admits a safe parent-first insert order.
-- The importer reads pg_constraint at runtime; this checks the real PostgreSQL catalog.
DO $$
DECLARE
  cycle_path text;
  blueprint_pointer_count integer;
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
  WHERE con.contype = 'f'
    AND child_namespace.nspname = 'public'
    AND parent_namespace.nspname = 'public'
    AND child.relname = 'business_blueprints'
    AND parent.relname = 'business_blueprint_versions'
    AND child_column.attname = 'current_version_id'
    AND NOT con.condeferrable;
  IF blueprint_pointer_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one immediate business_blueprints.current_version_id FK to business_blueprint_versions; review the explicit cycle-break contract';
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
           con.condeferrable AS deferrable,
           array_agg(child_column.attname::text ORDER BY child_key.ordinality) AS child_columns
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS child_key(attnum, ordinality) ON TRUE
    JOIN pg_attribute child_column ON child_column.attrelid = con.conrelid
      AND child_column.attnum = child_key.attnum AND NOT child_column.attisdropped
    WHERE con.contype = 'f'
      AND child_namespace.nspname = 'public'
      AND parent_namespace.nspname = 'public'
      AND child.relname IN (SELECT relation_name FROM adapter_tables)
      AND parent.relname IN (SELECT relation_name FROM adapter_tables)
    GROUP BY con.oid, child.relname, parent.relname, con.condeferrable
  ),
  insert_edges AS (
    SELECT parent_table, child_table
    FROM raw_edges
    WHERE NOT deferrable
      AND NOT (
        child_table = 'business_blueprints'
        AND parent_table = 'business_blueprint_versions'
        AND child_columns = ARRAY['current_version_id']::text[]
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
    RAISE EXCEPTION 'Non-deferrable FK cycles remain after the reviewed blueprint pointer break:%s%s', E'\\n', cycle_path;
  END IF;
END
$$;