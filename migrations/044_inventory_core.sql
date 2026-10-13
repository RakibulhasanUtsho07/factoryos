BEGIN;

-- WP02 Core Domain Kernel: first inventory/WMS vertical slice.
INSERT INTO permissions(code, description) VALUES
  ('inventory.read', 'Read factory-scoped inventory items, balances and movement history'),
  ('inventory.write', 'Create inventory items and record stock movements')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = TRUE
  AND p.code IN ('inventory.read', 'inventory.write')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_code VARCHAR(80) NOT NULL,
  item_name VARCHAR(240) NOT NULL,
  base_unit VARCHAR(24) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT fk_inventory_item_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_item_factory_scope FOREIGN KEY (factory_id, tenant_id) REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_item_actor FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_item_code CHECK (item_code ~ '^[A-Z0-9][A-Z0-9._-]{0,79}$'),
  CONSTRAINT chk_inventory_item_name CHECK (length(btrim(item_name)) BETWEEN 1 AND 240),
  CONSTRAINT chk_inventory_item_unit CHECK (base_unit ~ '^[A-Za-z][A-Za-z0-9._-]{0,23}$'),
  CONSTRAINT chk_inventory_item_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT chk_inventory_item_version CHECK (version >= 1),
  CONSTRAINT uq_inventory_item_scope_code UNIQUE (tenant_id, factory_id, item_code),
  CONSTRAINT uq_inventory_item_scope_id UNIQUE (id, tenant_id, factory_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_items_factory_status ON inventory_items (tenant_id, factory_id, status, item_code);
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_items_tenant_isolation ON inventory_items;
CREATE POLICY inventory_items_tenant_isolation ON inventory_items
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS inventory_stock_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  location_code VARCHAR(80) NOT NULL,
  on_hand_quantity NUMERIC(24,6) NOT NULL DEFAULT 0,
  version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_inventory_balance_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_balance_factory_scope FOREIGN KEY (factory_id, tenant_id) REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_balance_item_scope FOREIGN KEY (item_id, tenant_id, factory_id) REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_balance_location CHECK (location_code ~ '^[A-Z0-9][A-Z0-9._:-]{0,79}$'),
  CONSTRAINT chk_inventory_balance_quantity CHECK (on_hand_quantity >= 0 AND on_hand_quantity <= 1000000000000),
  CONSTRAINT chk_inventory_balance_version CHECK (version >= 0),
  CONSTRAINT uq_inventory_balance_scope UNIQUE (tenant_id, factory_id, item_id, location_code),
  CONSTRAINT uq_inventory_balance_scope_id UNIQUE (id, tenant_id, factory_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_balance_lookup ON inventory_stock_balances (tenant_id, factory_id, item_id, location_code);
ALTER TABLE inventory_stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_stock_balances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_stock_balances_tenant_isolation ON inventory_stock_balances;
CREATE POLICY inventory_stock_balances_tenant_isolation ON inventory_stock_balances
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  location_code VARCHAR(80) NOT NULL,
  movement_type VARCHAR(12) NOT NULL,
  quantity_delta NUMERIC(24,6) NOT NULL,
  on_hand_after NUMERIC(24,6) NOT NULL,
  reason VARCHAR(300) NOT NULL,
  reference_ref VARCHAR(255),
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  recorded_by UUID NOT NULL,
  correlation_id UUID,
  request_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_inventory_movement_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_movement_factory_scope FOREIGN KEY (factory_id, tenant_id) REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_movement_item_scope FOREIGN KEY (item_id, tenant_id, factory_id) REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_movement_actor FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_movement_location CHECK (location_code ~ '^[A-Z0-9][A-Z0-9._:-]{0,79}$'),
  CONSTRAINT chk_inventory_movement_type CHECK (movement_type IN ('RECEIPT', 'ISSUE', 'ADJUSTMENT')),
  CONSTRAINT chk_inventory_movement_delta CHECK (
    quantity_delta <> 0 AND abs(quantity_delta) <= 1000000000000
    AND (movement_type <> 'RECEIPT' OR quantity_delta > 0)
    AND (movement_type <> 'ISSUE' OR quantity_delta < 0)
  ),
  CONSTRAINT chk_inventory_movement_balance CHECK (on_hand_after >= 0 AND on_hand_after <= 1000000000000),
  CONSTRAINT chk_inventory_movement_reason CHECK (length(btrim(reason)) BETWEEN 8 AND 300),
  CONSTRAINT chk_inventory_movement_reference CHECK (reference_ref IS NULL OR length(btrim(reference_ref)) BETWEEN 1 AND 255),
  CONSTRAINT chk_inventory_movement_idempotency CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_inventory_movement_hash CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT uq_inventory_movement_scope_id UNIQUE (id, tenant_id, factory_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_movement_idempotency ON inventory_movements (tenant_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_inventory_movement_item_history ON inventory_movements (tenant_id, factory_id, item_id, location_code, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movement_factory_history ON inventory_movements (tenant_id, factory_id, created_at DESC, id DESC);
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_movements_tenant_isolation ON inventory_movements;
CREATE POLICY inventory_movements_tenant_isolation ON inventory_movements
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION reject_inventory_movement_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Inventory movement ledger is append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$;
DROP TRIGGER IF EXISTS trg_inventory_movements_immutable ON inventory_movements;
CREATE TRIGGER trg_inventory_movements_immutable BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION reject_inventory_movement_mutation();

INSERT INTO schema_migrations(version, checksum) VALUES ('044_inventory_core', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
