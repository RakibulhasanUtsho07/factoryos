BEGIN;

-- WP02: bind order lines to inventory items without forcing legacy orders
-- to migrate immediately. A line can remain unbound until a SKU is mapped.
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_id_tenant_factory
  ON orders (id, tenant_id, factory_id);

ALTER TABLE order_lines
  ADD COLUMN IF NOT EXISTS factory_id UUID;

ALTER TABLE order_lines
  ADD COLUMN IF NOT EXISTS inventory_item_id UUID;

-- Backfill factory scope for legacy order lines before enforcing it.
UPDATE order_lines ol
SET factory_id = o.factory_id
FROM orders o
WHERE o.id = ol.order_id
  AND o.tenant_id = ol.tenant_id
  AND ol.factory_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM order_lines
    WHERE factory_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot backfill factory scope for every order line';
  END IF;
END;
$$;

ALTER TABLE order_lines
  ALTER COLUMN factory_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_order_lines_order_tenant_factory'
      AND conrelid = 'order_lines'::regclass
  ) THEN
    ALTER TABLE order_lines
      ADD CONSTRAINT fk_order_lines_order_tenant_factory
      FOREIGN KEY (order_id, tenant_id, factory_id)
      REFERENCES orders (id, tenant_id, factory_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_order_lines_inventory_item_scope'
      AND conrelid = 'order_lines'::regclass
  ) THEN
    ALTER TABLE order_lines
      ADD CONSTRAINT fk_order_lines_inventory_item_scope
      FOREIGN KEY (inventory_item_id, tenant_id, factory_id)
      REFERENCES inventory_items (id, tenant_id, factory_id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_order_lines_inventory_binding
  ON order_lines (tenant_id, factory_id, inventory_item_id, order_id)
  WHERE inventory_item_id IS NOT NULL;

-- Preserve compatibility with direct legacy inserts that omit factory_id,
-- but never permit an order line or inventory binding to cross factory scope.
CREATE OR REPLACE FUNCTION factoryos_validate_order_line_inventory_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_order_factory_id UUID;
  v_item_unit VARCHAR(50);
BEGIN
  SELECT o.factory_id
    INTO v_order_factory_id
  FROM orders o
  WHERE o.id = NEW.order_id
    AND o.tenant_id = NEW.tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order line must reference an order in the same tenant'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.factory_id IS NULL THEN
    NEW.factory_id := v_order_factory_id;
  ELSIF NEW.factory_id <> v_order_factory_id THEN
    RAISE EXCEPTION 'order line factory must match its parent order'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.inventory_item_id IS NOT NULL THEN
    SELECT i.unit
      INTO v_item_unit
    FROM inventory_items i
    WHERE i.id = NEW.inventory_item_id
      AND i.tenant_id = NEW.tenant_id
      AND i.factory_id = NEW.factory_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'order line inventory item must belong to the same tenant and factory'
        USING ERRCODE = '23503';
    END IF;

    IF upper(btrim(v_item_unit)) <> upper(btrim(NEW.unit)) THEN
      RAISE EXCEPTION 'order line unit must match its inventory item unit'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_line_inventory_binding
  ON order_lines;

CREATE TRIGGER trg_order_line_inventory_binding
BEFORE INSERT OR UPDATE ON order_lines
FOR EACH ROW
EXECUTE FUNCTION factoryos_validate_order_line_inventory_binding();

COMMENT ON COLUMN order_lines.inventory_item_id IS
  'Optional authoritative factory-scoped inventory item binding; stock allocation is a separate lifecycle operation.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('059_order_line_inventory_binding', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
