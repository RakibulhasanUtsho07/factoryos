BEGIN;

-- Reorder thresholds are factory/item scoped; recommendations remain advisory
-- and never create or approve a purchase order automatically.
INSERT INTO permissions (code, description)
VALUES
  ('inventory.reorder.read', 'Read inventory reorder policies, shortages and replenishment recommendations in the authorized factory'),
  ('inventory.reorder.write', 'Configure item-level minimum/maximum replenishment policies in the authorized factory')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('inventory.reorder.read', 'inventory.reorder.write')
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE inventory_reorder_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  minimum_quantity NUMERIC(18,4) NOT NULL,
  maximum_quantity NUMERIC(18,4) NOT NULL,
  lead_time_days INTEGER NOT NULL DEFAULT 0,
  preferred_supplier_id UUID,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT uq_inventory_reorder_policy_item UNIQUE (tenant_id, factory_id, item_id),
  CONSTRAINT uq_inventory_reorder_policy_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_inventory_reorder_policy_item_scope
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reorder_policy_supplier_scope
    FOREIGN KEY (preferred_supplier_id, tenant_id)
    REFERENCES suppliers(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reorder_policy_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reorder_policy_updater
    FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_reorder_policy_quantities
    CHECK (minimum_quantity >= 0 AND maximum_quantity > minimum_quantity),
  CONSTRAINT chk_inventory_reorder_policy_lead_time
    CHECK (lead_time_days BETWEEN 0 AND 3650),
  CONSTRAINT chk_inventory_reorder_policy_version CHECK (version > 0)
);

CREATE INDEX idx_inventory_reorder_policy_enabled
  ON inventory_reorder_policies (tenant_id, factory_id, enabled, item_id);

CREATE INDEX idx_purchase_order_lines_replenishment
  ON purchase_order_lines (tenant_id, factory_id, inventory_item_id, purchase_order_id)
  WHERE inventory_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_reorder_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_status VARCHAR(20);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory reorder policies cannot be deleted; disable the policy instead'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'inventory reorder policies must start at version one'
        USING ERRCODE = '23514';
    END IF;
    SELECT status INTO v_item_status
    FROM inventory_items
    WHERE id = NEW.item_id
      AND tenant_id = NEW.tenant_id
      AND factory_id = NEW.factory_id;
    IF NOT FOUND OR v_item_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'reorder policy requires an active inventory item in the same factory'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.item_id,
         NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.item_id,
         OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'inventory reorder policy identity and creation provenance are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'inventory reorder policy updates must increment version by exactly one'
      USING ERRCODE = '23514';
  END IF;

  SELECT status INTO v_item_status
  FROM inventory_items
  WHERE id = NEW.item_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id;
  IF NOT FOUND OR v_item_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'reorder policy requires an active inventory item in the same factory'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_reorder_policy_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory_reorder_policies
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_reorder_policy();

ALTER TABLE inventory_reorder_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reorder_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_reorder_policies_tenant_isolation
  ON inventory_reorder_policies
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE inventory_reorder_policies IS
  'Factory/item-level min-max controls for advisory reorder recommendations. Purchase orders remain behind the existing procurement approval lifecycle.';
COMMENT ON COLUMN inventory_reorder_policies.minimum_quantity IS
  'Reorder trigger threshold applied to available stock plus approved outstanding purchase-order quantities.';
COMMENT ON COLUMN inventory_reorder_policies.maximum_quantity IS
  'Target stock position used to calculate the recommended replenishment quantity.';
COMMENT ON COLUMN inventory_reorder_policies.lead_time_days IS
  'Planning lead time used for an estimated replenishment date when no committed supplier ETA is available.';
COMMENT ON COLUMN inventory_reorder_policies.preferred_supplier_id IS
  'Optional tenant-scoped preferred supplier; the recommendation never bypasses purchase-order approval.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('081_inventory_reorder_replenishment', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
