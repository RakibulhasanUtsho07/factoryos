BEGIN;

-- Production-linked sales-order lines are make-to-order. Their finished-good
-- balance is created by production output, so the sales-order inventory guard
-- must not require the finished item to be reserved/consumed before that output
-- exists. Raw material remains guarded by work-order BOM reservations.
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
    WHERE ol.id = NEW.reference_id
      AND ol.tenant_id = NEW.tenant_id
      AND ol.factory_id = NEW.factory_id
      AND ol.inventory_item_id = NEW.item_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'order-line reservation must reference a line bound to the same item and factory'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  FOR v_line IN
    SELECT ol.id AS line_id,
      ol.quantity AS requested_quantity,
      o.status AS order_status,
      COALESCE(SUM(r.remaining_quantity) FILTER (WHERE r.status = 'RESERVED'), 0) AS reserved_quantity,
      COALESCE(SUM(r.consumed_quantity), 0) AS consumed_quantity,
      COUNT(r.id) FILTER (WHERE r.status = 'RESERVED' AND r.location_id IS NULL) AS unallocated_reservation_count,
      COUNT(r.id) FILTER (WHERE r.status = 'RESERVED' AND r.location_id IS NOT NULL) AS bin_reservation_count,
      EXISTS (
        SELECT 1
        FROM work_orders wo
        WHERE wo.source_order_id = ol.order_id
          AND wo.source_order_line_id = ol.id
          AND wo.tenant_id = ol.tenant_id
          AND wo.factory_id = ol.factory_id
      ) AS production_managed
    FROM orders o
    JOIN order_lines ol
      ON ol.order_id = o.id
     AND ol.tenant_id = o.tenant_id
     AND ol.factory_id = o.factory_id
    LEFT JOIN inventory_reservations r
      ON r.tenant_id = ol.tenant_id
     AND r.factory_id = ol.factory_id
     AND r.item_id = ol.inventory_item_id
     AND r.reference_type = 'ORDER_LINE'
     AND r.reference_id = ol.id
    WHERE o.id = v_order_id
      AND o.tenant_id = v_tenant_id
      AND o.factory_id = v_factory_id
      AND ol.inventory_item_id IS NOT NULL
    GROUP BY ol.id, ol.quantity, o.status
  LOOP
    -- The production service owns material availability for this line. Its
    -- output creates the finished stock later, so do not apply the stock-led
    -- shipment rule to a planned production order.
    IF v_line.production_managed THEN
      IF v_line.reserved_quantity <> 0 OR v_line.consumed_quantity <> 0 THEN
        RAISE EXCEPTION
          'production-managed order line % cannot reserve finished-good stock against ORDER_LINE; use the work-order BOM material reservation lifecycle',
          v_line.line_id
          USING ERRCODE = '23514';
      END IF;
      CONTINUE;
    END IF;

    IF v_line.order_status = 'CONFIRMED' THEN
      IF v_line.reserved_quantity <> v_line.requested_quantity
         OR v_line.consumed_quantity <> 0 THEN
        RAISE EXCEPTION 'confirmed order line % must have exactly % reserved units (reserved %, consumed %)',
          v_line.line_id, v_line.requested_quantity, v_line.reserved_quantity, v_line.consumed_quantity
          USING ERRCODE = '23514';
      END IF;
      IF v_line.unallocated_reservation_count > 0
         AND v_line.bin_reservation_count > 0 THEN
        RAISE EXCEPTION 'confirmed order line % cannot mix unallocated and bin-bound active reservations',
          v_line.line_id USING ERRCODE = '23514';
      END IF;
    ELSIF v_line.order_status IN ('IN_PROGRESS', 'COMPLETED') THEN
      IF v_line.consumed_quantity <> v_line.requested_quantity
         OR v_line.reserved_quantity <> 0 THEN
        RAISE EXCEPTION 'in-progress/completed order line % must have exactly % consumed units (consumed %, reserved %)',
          v_line.line_id, v_line.requested_quantity, v_line.consumed_quantity, v_line.reserved_quantity
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION factoryos_assert_order_line_inventory_allocation() IS
  'Deferred order inventory-allocation guard. Stock-led order lines must be exactly reserved/consumed; a production-managed line must not reserve finished-good stock at ORDER_LINE scope and is fulfilled through BOM reservation, raw-material consumption and posted output genealogy instead.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('207_production_order_finished_good_reservation_boundary', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
