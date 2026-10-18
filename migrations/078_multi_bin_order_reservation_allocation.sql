BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_order_line_bin_active
  ON inventory_reservations (tenant_id, factory_id, reference_id, location_id)
  WHERE reference_type = 'ORDER_LINE' AND status = 'RESERVED'
    AND reference_id IS NOT NULL AND location_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_order_line_reservation_status
  ON inventory_reservations (tenant_id, factory_id, reference_id, status, item_id)
  WHERE reference_type = 'ORDER_LINE' AND reference_id IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_assert_order_line_inventory_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_order_id UUID;
  v_tenant_id UUID;
  v_factory_id UUID;
  v_line RECORD;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    v_order_id := NEW.id;
    v_tenant_id := NEW.tenant_id;
    v_factory_id := NEW.factory_id;
  ELSE
    IF NEW.reference_type IS DISTINCT FROM 'ORDER_LINE' OR NEW.reference_id IS NULL THEN
      RETURN NULL;
    END IF;
    v_tenant_id := NEW.tenant_id;
    v_factory_id := NEW.factory_id;
    SELECT ol.order_id INTO v_order_id
    FROM order_lines ol
    WHERE ol.id = NEW.reference_id AND ol.tenant_id = NEW.tenant_id
      AND ol.factory_id = NEW.factory_id AND ol.inventory_item_id = NEW.item_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'order-line reservation must reference a line bound to the same inventory item and factory'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  FOR v_line IN
    SELECT ol.id AS line_id, ol.quantity AS requested_quantity, o.status AS order_status,
      COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'RESERVED'), 0) AS reserved_quantity,
      COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'CONSUMED'), 0) AS consumed_quantity,
      COUNT(r.id) FILTER (WHERE r.status = 'RESERVED' AND r.location_id IS NULL) AS unallocated_reservation_count,
      COUNT(r.id) FILTER (WHERE r.status = 'RESERVED' AND r.location_id IS NOT NULL) AS bin_reservation_count
    FROM orders o
    JOIN order_lines ol ON ol.order_id = o.id AND ol.tenant_id = o.tenant_id AND ol.factory_id = o.factory_id
    LEFT JOIN inventory_reservations r
      ON r.tenant_id = ol.tenant_id AND r.factory_id = ol.factory_id
     AND r.item_id = ol.inventory_item_id
     AND r.reference_type = 'ORDER_LINE' AND r.reference_id = ol.id
    WHERE o.id = v_order_id AND o.tenant_id = v_tenant_id AND o.factory_id = v_factory_id
      AND ol.inventory_item_id IS NOT NULL
    GROUP BY ol.id, ol.quantity, o.status
  LOOP
    IF v_line.order_status = 'CONFIRMED' THEN
      IF v_line.reserved_quantity <> v_line.requested_quantity OR v_line.consumed_quantity <> 0 THEN
        RAISE EXCEPTION
          'confirmed order line % must have exactly % reserved units (current reserved %, consumed %)',
          v_line.line_id, v_line.requested_quantity, v_line.reserved_quantity, v_line.consumed_quantity
          USING ERRCODE = '23514';
      END IF;
      IF v_line.unallocated_reservation_count > 0 AND v_line.bin_reservation_count > 0 THEN
        RAISE EXCEPTION 'confirmed order line % cannot mix legacy unallocated and bin-bound active reservations',
          v_line.line_id USING ERRCODE = '23514';
      END IF;
    ELSIF v_line.order_status IN ('IN_PROGRESS', 'COMPLETED') THEN
      IF v_line.consumed_quantity <> v_line.requested_quantity OR v_line.reserved_quantity <> 0 THEN
        RAISE EXCEPTION
          'in-progress/completed order line % must have exactly % consumed units (current consumed %, reserved %)',
          v_line.line_id, v_line.requested_quantity, v_line.consumed_quantity, v_line.reserved_quantity
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_inventory_order_reservation_allocation_guard ON inventory_reservations;
CREATE CONSTRAINT TRIGGER ctr_inventory_order_reservation_allocation_guard
AFTER INSERT OR UPDATE ON inventory_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_order_line_inventory_allocation();

DROP TRIGGER IF EXISTS ctr_order_inventory_reservation_allocation_guard ON orders;
CREATE CONSTRAINT TRIGGER ctr_order_inventory_reservation_allocation_guard
AFTER UPDATE ON orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_order_line_inventory_allocation();

COMMENT ON FUNCTION factoryos_assert_order_line_inventory_allocation() IS
  'Deferred guard for exact order-line inventory reservation/consumption quantities and mixed bin/unallocated allocation prevention.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('078_multi_bin_order_reservation_allocation', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
