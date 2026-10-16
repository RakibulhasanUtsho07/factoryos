BEGIN;

-- WP02 / Inventory stock reconciliation.
-- A count is recorded as immutable evidence; non-zero variance is balanced
-- by a matching append-only inventory movement in the same transaction.
INSERT INTO permissions (code, description)
VALUES (
  'inventory.reconcile',
  'Record physical inventory counts and reconcile stock in the authorized factory'
)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'inventory.reconcile'
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE inventory_stock_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  quantity_before NUMERIC(18, 4) NOT NULL,
  counted_quantity NUMERIC(18, 4) NOT NULL,
  quantity_delta NUMERIC(18, 4) NOT NULL,
  quantity_after NUMERIC(18, 4) NOT NULL,
  reason_code VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  adjustment_movement_id UUID,
  notes TEXT,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_inventory_stock_reconciliation_id_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_inventory_stock_reconciliation_idempotency
    UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_inventory_stock_reconciliation_item_scope
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_reconciliation_movement_scope
    FOREIGN KEY (adjustment_movement_id, tenant_id, factory_id)
    REFERENCES inventory_movements (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_reconciliation_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_stock_reconciliation_before
    CHECK (quantity_before >= 0),
  CONSTRAINT chk_inventory_stock_reconciliation_count
    CHECK (counted_quantity >= 0),
  CONSTRAINT chk_inventory_stock_reconciliation_delta
    CHECK (quantity_delta = counted_quantity - quantity_before),
  CONSTRAINT chk_inventory_stock_reconciliation_after
    CHECK (quantity_after = counted_quantity),
  CONSTRAINT chk_inventory_stock_reconciliation_reason
    CHECK (reason_code IN ('CYCLE_COUNT', 'DAMAGE', 'LOSS', 'FOUND_STOCK', 'OPENING_BALANCE', 'OTHER')),
  CONSTRAINT chk_inventory_stock_reconciliation_movement
    CHECK (
      (quantity_delta = 0 AND adjustment_movement_id IS NULL)
      OR (quantity_delta <> 0 AND adjustment_movement_id IS NOT NULL)
    ),
  CONSTRAINT chk_inventory_stock_reconciliation_key
    CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_inventory_stock_reconciliation_hash
    CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_inventory_stock_reconciliations_item_created
  ON inventory_stock_reconciliations
  (tenant_id, factory_id, item_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION factoryos_validate_inventory_stock_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  movement inventory_movements%ROWTYPE;
BEGIN
  IF NEW.quantity_delta = 0 THEN
    IF NEW.adjustment_movement_id IS NOT NULL THEN
      RAISE EXCEPTION 'zero-variance reconciliation must not create a stock movement'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT *
  INTO movement
  FROM inventory_movements
  WHERE id = NEW.adjustment_movement_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id;

  IF NOT FOUND
    OR movement.item_id <> NEW.item_id
    OR movement.reference_type IS DISTINCT FROM 'STOCK_RECONCILIATION'
    OR movement.reference_id IS DISTINCT FROM NEW.id
    OR movement.quantity_delta <> NEW.quantity_delta
    OR movement.quantity_after <> NEW.quantity_after
    OR movement.quantity <> ABS(NEW.quantity_delta)
    OR movement.movement_type <> CASE
      WHEN NEW.quantity_delta > 0 THEN 'RECEIPT'
      ELSE 'ISSUE'
    END
  THEN
    RAISE EXCEPTION 'stock reconciliation must reference its matching immutable adjustment movement'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_stock_reconciliation_validate
BEFORE INSERT ON inventory_stock_reconciliations
FOR EACH ROW
EXECUTE FUNCTION factoryos_validate_inventory_stock_reconciliation();

CREATE OR REPLACE FUNCTION factoryos_prevent_inventory_stock_reconciliation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'inventory_stock_reconciliations is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER inventory_stock_reconciliations_immutable
BEFORE UPDATE OR DELETE ON inventory_stock_reconciliations
FOR EACH ROW
EXECUTE FUNCTION factoryos_prevent_inventory_stock_reconciliation_mutation();

ALTER TABLE inventory_stock_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_stock_reconciliations FORCE ROW LEVEL SECURITY;

CREATE POLICY inventory_stock_reconciliations_tenant_isolation
ON inventory_stock_reconciliations
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE inventory_stock_reconciliations IS
  'Immutable physical stock count evidence. Any non-zero variance must be paired with a matching append-only receipt/issue movement; the balance update, reconciliation row and outbox event are transactional.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('061_inventory_stock_reconciliation', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
