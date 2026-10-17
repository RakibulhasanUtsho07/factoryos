BEGIN;

-- WP02 follow-up: disposed materials must be explicitly returned or scrapped
-- before an in-progress order can be cancelled.
CREATE TABLE order_material_dispositions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  order_id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  item_id UUID NOT NULL,
  disposition_type VARCHAR(24) NOT NULL,
  quantity NUMERIC(18, 4) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  movement_id UUID,
  notes TEXT,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_order_material_disposition_id_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_order_material_disposition_idempotency
    UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_order_material_disposition_order_scope
    FOREIGN KEY (order_id, tenant_id, factory_id)
    REFERENCES orders (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_material_disposition_reservation_scope
    FOREIGN KEY (reservation_id, tenant_id, factory_id)
    REFERENCES inventory_reservations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_material_disposition_item_scope
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_material_disposition_movement_scope
    FOREIGN KEY (movement_id, tenant_id, factory_id)
    REFERENCES inventory_movements (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_material_disposition_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_order_material_disposition_type
    CHECK (disposition_type IN ('RETURN_TO_STOCK', 'SCRAPPED')),
  CONSTRAINT chk_order_material_disposition_quantity
    CHECK (quantity > 0),
  CONSTRAINT chk_order_material_disposition_idempotency_key
    CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_order_material_disposition_hash
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_order_material_disposition_movement
    CHECK (
      (disposition_type = 'RETURN_TO_STOCK' AND movement_id IS NOT NULL)
      OR (disposition_type = 'SCRAPPED' AND movement_id IS NULL)
    )
);

CREATE INDEX idx_order_material_dispositions_order_reservation
  ON order_material_dispositions (tenant_id, factory_id, order_id, reservation_id, created_at);

CREATE OR REPLACE FUNCTION factoryos_guard_order_material_disposition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_order_status VARCHAR(30);
  v_reservation_quantity NUMERIC(18, 4);
  v_reservation_item_id UUID;
  v_reservation_status VARCHAR(20);
  v_reference_type VARCHAR(64);
  v_prior_disposed NUMERIC(18, 4);
  v_movement_item_id UUID;
  v_movement_type VARCHAR(20);
  v_movement_quantity NUMERIC(18, 4);
  v_movement_reference_type VARCHAR(64);
  v_movement_reference_id UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'order material dispositions are immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT o.status
    INTO v_order_status
  FROM orders o
  WHERE o.id = NEW.order_id
    AND o.tenant_id = NEW.tenant_id
    AND o.factory_id = NEW.factory_id
  FOR UPDATE;

  IF NOT FOUND OR v_order_status <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'material disposition requires an in-progress order'
      USING ERRCODE = '23514';
  END IF;

  SELECT r.quantity, r.item_id, r.status, r.reference_type
    INTO v_reservation_quantity, v_reservation_item_id, v_reservation_status, v_reference_type
  FROM inventory_reservations r
  JOIN order_lines ol
    ON ol.id = r.reference_id
    AND ol.tenant_id = r.tenant_id
    AND ol.factory_id = r.factory_id
    AND ol.inventory_item_id = r.item_id
  WHERE r.id = NEW.reservation_id
    AND r.tenant_id = NEW.tenant_id
    AND r.factory_id = NEW.factory_id
    AND ol.order_id = NEW.order_id
  FOR UPDATE OF r;

  IF NOT FOUND
     OR v_reservation_status <> 'CONSUMED'
     OR v_reference_type <> 'ORDER_LINE'
     OR v_reservation_item_id <> NEW.item_id THEN
    RAISE EXCEPTION 'material disposition must reference a consumed reservation for this order and item'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(d.quantity), 0)
    INTO v_prior_disposed
  FROM order_material_dispositions d
  WHERE d.tenant_id = NEW.tenant_id
    AND d.factory_id = NEW.factory_id
    AND d.reservation_id = NEW.reservation_id;

  IF v_prior_disposed + NEW.quantity > v_reservation_quantity THEN
    RAISE EXCEPTION 'material disposition quantity exceeds the consumed reservation quantity'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.disposition_type = 'RETURN_TO_STOCK' THEN
    SELECT m.item_id, m.movement_type, m.quantity, m.reference_type, m.reference_id
      INTO v_movement_item_id, v_movement_type, v_movement_quantity,
           v_movement_reference_type, v_movement_reference_id
    FROM inventory_movements m
    WHERE m.id = NEW.movement_id
      AND m.tenant_id = NEW.tenant_id
      AND m.factory_id = NEW.factory_id;

    IF NOT FOUND
       OR v_movement_item_id <> NEW.item_id
       OR v_movement_type <> 'RECEIPT'
       OR v_movement_quantity <> NEW.quantity
       OR v_movement_reference_type <> 'ORDER_MATERIAL_RETURN'
       OR v_movement_reference_id <> NEW.id THEN
      RAISE EXCEPTION 'returned material must reference its matching stock receipt movement'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.movement_id IS NOT NULL THEN
    RAISE EXCEPTION 'scrapped material must not change stock'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_order_material_disposition_immutable
BEFORE INSERT OR UPDATE OR DELETE ON order_material_dispositions
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_order_material_disposition();

-- Even SQL callers cannot cancel a started order while consumed materials
-- are left without a complete return/scrap decision.
CREATE OR REPLACE FUNCTION factoryos_require_order_material_disposition_before_cancel()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'IN_PROGRESS' AND NEW.status = 'CANCELLED' AND EXISTS (
    SELECT 1
    FROM inventory_reservations r
    JOIN order_lines ol
      ON ol.id = r.reference_id
      AND ol.tenant_id = r.tenant_id
      AND ol.factory_id = r.factory_id
      AND ol.inventory_item_id = r.item_id
    LEFT JOIN order_material_dispositions d
      ON d.tenant_id = r.tenant_id
      AND d.factory_id = r.factory_id
      AND d.reservation_id = r.id
    WHERE r.tenant_id = OLD.tenant_id
      AND r.factory_id = OLD.factory_id
      AND ol.order_id = OLD.id
      AND r.reference_type = 'ORDER_LINE'
      AND r.status = 'CONSUMED'
    GROUP BY r.id, r.quantity
    HAVING COALESCE(SUM(d.quantity), 0) <> r.quantity
  ) THEN
    RAISE EXCEPTION 'every consumed order material must be fully returned to stock or marked as scrapped before cancellation'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_orders_require_material_disposition_before_cancel
BEFORE UPDATE OF status ON orders
FOR EACH ROW
EXECUTE FUNCTION factoryos_require_order_material_disposition_before_cancel();

ALTER TABLE order_material_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_material_dispositions FORCE ROW LEVEL SECURITY;

CREATE POLICY order_material_dispositions_tenant_isolation
ON order_material_dispositions
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE order_material_dispositions IS
  'Immutable, idempotent return-to-stock or scrap evidence for material already issued to an order. In-progress orders cannot be cancelled until every consumed reservation is fully dispositioned.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('060_order_material_dispositions', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
