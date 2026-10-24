\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  tool_row ai_tool_registry%ROWTYPE;
  row_count INTEGER;
  rls_enabled BOOLEAN;
  rls_forced BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '197_ai_inventory_stock_summary_tool'
  ) THEN
    RAISE EXCEPTION 'inventory stock-summary tool migration marker is missing';
  END IF;

  SELECT COUNT(*) INTO row_count
  FROM ai_tool_registry
  WHERE tenant_id IS NULL
    AND factory_id IS NULL
    AND tool_id = 'INVENTORY.STOCK.SUMMARY'
    AND version = '1.0.0'
    AND status = 'ACTIVE';

  IF row_count <> 1 THEN
    RAISE EXCEPTION 'exactly one active global inventory stock-summary tool must be registered';
  END IF;

  SELECT * INTO tool_row
  FROM ai_tool_registry
  WHERE tenant_id IS NULL
    AND factory_id IS NULL
    AND tool_id = 'INVENTORY.STOCK.SUMMARY'
    AND version = '1.0.0'
    AND status = 'ACTIVE';

  IF tool_row.risk_class <> 'L1'
    OR tool_row.required_scopes <> ARRAY['inventory.read']::TEXT[]
    OR tool_row.write_capable IS DISTINCT FROM FALSE
    OR tool_row.idempotency_required IS DISTINCT FROM FALSE
    OR tool_row.rollback->>'type' <> 'NONE'
    OR tool_row.timeout_ms <> 1500
    OR tool_row.metadata->>'domainExecutor' <> 'INVENTORY_STOCK_SUMMARY'
    OR tool_row.metadata->>'workloadClass' <> 'NON_AI'
  THEN
    RAISE EXCEPTION 'inventory stock-summary tool must remain read-only and scoped to inventory.read';
  END IF;

  IF tool_row.input_schema->>'type' <> 'object'
    OR tool_row.input_schema->'required' IS DISTINCT FROM '["item_id"]'::JSONB
    OR tool_row.input_schema->>'additionalProperties' <> 'false'
    OR tool_row.input_schema->'properties'->'item_id'->>'type' <> 'string'
    OR tool_row.input_schema->'properties'->'item_id'->>'pattern' IS NULL
  THEN
    RAISE EXCEPTION 'inventory stock-summary input schema must require one strict item UUID';
  END IF;

  IF tool_row.output_schema->>'type' <> 'object'
    OR tool_row.output_schema->>'additionalProperties' <> 'false'
    OR NOT (tool_row.output_schema->'required' ? 'quantity_on_hand')
    OR NOT (tool_row.output_schema->'required' ? 'quantity_reserved')
    OR NOT (tool_row.output_schema->'required' ? 'quantity_available')
    OR NOT (tool_row.output_schema->'required' ? 'balance_version')
  THEN
    RAISE EXCEPTION 'inventory stock-summary output must include bounded balance values and the snapshot version';
  END IF;

  SELECT c.relrowsecurity, c.relforcerowsecurity
  INTO rls_enabled, rls_forced
  FROM pg_class c
  WHERE c.oid = 'public.ai_tool_registry'::regclass;

  IF rls_enabled IS DISTINCT FROM TRUE OR rls_forced IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'AI tool registry tenant RLS must remain enabled and forced';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM permissions WHERE code = 'inventory.read') THEN
    RAISE EXCEPTION 'inventory.read permission required by the registered tool is missing';
  END IF;
END $$;

ROLLBACK;
