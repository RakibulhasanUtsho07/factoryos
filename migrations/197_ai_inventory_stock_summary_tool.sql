BEGIN;

-- WP06 first domain executor: read-only, tenant/factory-scoped inventory snapshot.
-- The executor remains subject to the normal tool registry, IAM, subscription,
-- usage-metering and production artifact-admission gates.
INSERT INTO ai_tool_registry (
  tenant_id, factory_id, tool_id, version, input_schema, output_schema,
  risk_class, required_scopes, approval_mode, write_capable,
  idempotency_required, timeout_ms, audit_mode, rollback, status, metadata
)
VALUES (
  NULL,
  NULL,
  'INVENTORY.STOCK.SUMMARY',
  '1.0.0',
  '{
    "type": "object",
    "properties": {
      "item_id": {
        "type": "string",
        "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
      }
    },
    "required": ["item_id"],
    "additionalProperties": false
  }'::JSONB,
  '{
    "type": "object",
    "required": [
      "item_id", "sku", "name", "unit", "status",
      "quantity_on_hand", "quantity_reserved", "quantity_available",
      "balance_version"
    ],
    "properties": {
      "item_id": { "type": "string" },
      "sku": { "type": "string" },
      "name": { "type": "string" },
      "unit": { "type": "string" },
      "status": { "type": "string", "enum": ["ACTIVE", "DISABLED"] },
      "quantity_on_hand": { "type": "string" },
      "quantity_reserved": { "type": "string" },
      "quantity_available": { "type": "string" },
      "balance_version": { "type": "string" }
    },
    "additionalProperties": false
  }'::JSONB,
  'L1',
  ARRAY['inventory.read']::TEXT[],
  'none',
  false,
  false,
  1500,
  'REDACTED',
  '{"type":"NONE"}'::JSONB,
  'ACTIVE',
  '{
    "purpose": "Read the authoritative aggregate inventory balance for one item",
    "domainExecutor": "INVENTORY_STOCK_SUMMARY",
    "workloadClass": "NON_AI"
  }'::JSONB
)
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version, checksum)
VALUES ('197_ai_inventory_stock_summary_tool', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
