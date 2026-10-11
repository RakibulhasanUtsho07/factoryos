BEGIN;

-- Inventory is a factory-scoped stock ledger. Business writes are performed
-- through the owning API service; movements are append-only evidence.
INSERT INTO permissions (code, description)
VALUES
  ('inventory.read', 'Read inventory items and stock movements in the authorized factory'),
  ('inventory.write', 'Create inventory items and record stock receipts/issues in the authorized factory')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('inventory.read', 'inventory.write')
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  sku VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  unit VARCHAR(50) NOT NULL DEFAULT 'PCS',
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT uq_inventory_items_factory_sku UNIQUE (tenant_id, factory_id, sku),
  CONSTRAINT uq_inventory_items_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_inventory_items_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_items_factory_tenant FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_items_creator FOREIGN KEY (created_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_items_sku CHECK (length(btrim(sku)) > 0),
  CONSTRAINT chk_inventory_items_name CHECK (length(btrim(name)) > 0),
  CONSTRAINT chk_inventory_items_unit CHECK (length(btrim(unit)) > 0),
  CONSTRAINT chk_inventory_items_status CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT chk_inventory_items_version CHECK (version > 0)
);

CREATE INDEX idx_inventory_items_factory_status
  ON inventory_items (tenant_id, factory_id, status, sku);

CREATE TABLE inventory_stock_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  quantity_on_hand NUMERIC(18, 4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT uq_inventory_stock_balance_item UNIQUE (item_id),
  CONSTRAINT uq_inventory_stock_balance_scope UNIQUE (item_id, tenant_id, factory_id),
  CONSTRAINT fk_inventory_balance_item_scope FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_balance_nonnegative CHECK (quantity_on_hand >= 0),
  CONSTRAINT chk_inventory_balance_version CHECK (version > 0)
);

CREATE TABLE inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  movement_type VARCHAR(20) NOT NULL,
  quantity NUMERIC(18, 4) NOT NULL,
  quantity_delta NUMERIC(18, 4) NOT NULL,
  quantity_after NUMERIC(18, 4) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  reference_type VARCHAR(64),
  reference_id UUID,
  notes TEXT,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_inventory_movement_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_inventory_movement_item_scope FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_movement_creator FOREIGN KEY (created_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_movement_type CHECK (movement_type IN ('RECEIPT', 'ISSUE')),
  CONSTRAINT chk_inventory_movement_quantity CHECK (quantity > 0),
  CONSTRAINT chk_inventory_movement_delta CHECK (
    (movement_type = 'RECEIPT' AND quantity_delta = quantity)
    OR (movement_type = 'ISSUE' AND quantity_delta = -quantity)
  ),
  CONSTRAINT chk_inventory_movement_balance CHECK (quantity_after >= 0),
  CONSTRAINT chk_inventory_movement_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_inventory_movement_request_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_inventory_movements_item_created
  ON inventory_movements (tenant_id, factory_id, item_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION factoryos_prevent_inventory_movement_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'inventory_movements is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER inventory_movements_immutable
BEFORE UPDATE OR DELETE ON inventory_movements
FOR EACH ROW
EXECUTE FUNCTION factoryos_prevent_inventory_movement_mutation();

-- Tenant isolation is enforced in PostgreSQL and complemented by factory-
-- scoped authorization and factory predicates in the API.
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_items_tenant_isolation ON inventory_items
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE inventory_stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_stock_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_stock_balances_tenant_isolation ON inventory_stock_balances
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_movements_tenant_isolation ON inventory_movements
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version)
VALUES ('038_inventory_stock_ledger')
ON CONFLICT (version) DO NOTHING;

COMMIT;
