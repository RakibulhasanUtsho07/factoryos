BEGIN;

-- Allow genuine make-to-order lines to be confirmed before finished-good stock exists.
-- Stock-fulfilled lines still use the exact reservation/consumption contract below.
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
      COUNT(r.id) FILTER (WHERE r.status = 'RESERVED' AND r.location_id IS NOT NULL) AS bin_reservation_count
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
    -- Never mix stock reservation fulfilment with a work order on the same line.
    -- A production-managed line may progress without a sellable stock reservation;
    -- work-order output completion/good-yield guards then own fulfillment evidence.
    IF NOT EXISTS (
      SELECT 1
      FROM inventory_reservations existing
      WHERE existing.tenant_id = v_tenant_id
        AND existing.factory_id = v_factory_id
        AND existing.reference_type = 'ORDER_LINE'
        AND existing.reference_id = v_line.line_id
    ) AND (
      EXISTS (
        SELECT 1
        FROM work_orders wo
        WHERE wo.source_order_id = v_order_id
          AND wo.source_order_line_id = v_line.line_id
          AND wo.tenant_id = v_tenant_id
          AND wo.factory_id = v_factory_id
      )
      OR EXISTS (
        SELECT 1
        FROM order_lines production_line
        JOIN product_definitions pd
          ON pd.inventory_item_id = production_line.inventory_item_id
         AND pd.tenant_id = production_line.tenant_id
         AND pd.factory_id = production_line.factory_id
         AND pd.status = 'ACTIVE'
        JOIN LATERAL (
          SELECT pv.id
          FROM product_versions pv
          WHERE pv.product_id = pd.id
            AND pv.tenant_id = pd.tenant_id
            AND pv.factory_id = pd.factory_id
            AND pv.state IN ('APPROVED', 'RETIRED')
            AND pv.effective_from <= CURRENT_DATE
            AND COALESCE(pv.effective_to_override, pv.effective_to, 'infinity'::date) >= CURRENT_DATE
          ORDER BY pv.effective_from DESC, pv.version_number DESC
          LIMIT 1
        ) effective_version ON TRUE
        WHERE production_line.id = v_line.line_id
          AND production_line.order_id = v_order_id
          AND production_line.tenant_id = v_tenant_id
          AND production_line.factory_id = v_factory_id
          AND EXISTS (
            SELECT 1 FROM product_bom_lines b
            WHERE b.product_id = pd.id
              AND b.product_version_id = effective_version.id
              AND b.tenant_id = v_tenant_id
              AND b.factory_id = v_factory_id
          )
          AND EXISTS (
            SELECT 1 FROM product_routing_steps route
            WHERE route.product_id = pd.id
              AND route.product_version_id = effective_version.id
              AND route.tenant_id = v_tenant_id
              AND route.factory_id = v_factory_id
          )
      )
    ) THEN
      CONTINUE;
    END IF;

    IF v_line.order_status = 'CONFIRMED' THEN
      IF v_line.reserved_quantity <> v_line.requested_quantity
         OR v_line.consumed_quantity <> 0 THEN
        RAISE EXCEPTION 'confirmed order line % must have exactly % reserved units (reserved %, consumed %)',
          v_line.line_id, v_line.requested_quantity, v_line.reserved_quantity, v_line.consumed_quantity
          USING ERRCODE = '23514';
      END IF;
      IF v_line.unallocated_reservation_count > 0 AND v_line.bin_reservation_count > 0 THEN
        RAISE EXCEPTION 'confirmed order line % cannot mix unallocated and bin-bound reservations',
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

-- A product with an approved BOM/routing cannot be completed as an unreserved
-- stock order by merely relying on the production eligibility exception above.
-- It must either finish a work order or demonstrate fully consumed ORDER_LINE stock.
CREATE OR REPLACE FUNCTION factoryos_require_manufacturing_or_stock_fulfillment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unfulfilled RECORD;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'COMPLETED' THEN
    SELECT ol.id::text AS order_line_id,
      ol.quantity::text AS ordered_quantity,
      COALESCE((
        SELECT SUM(ir.consumed_quantity)
        FROM inventory_reservations ir
        WHERE ir.tenant_id = ol.tenant_id
          AND ir.factory_id = ol.factory_id
          AND ir.item_id = ol.inventory_item_id
          AND ir.reference_type = 'ORDER_LINE'
          AND ir.reference_id = ol.id
      ), 0)::text AS stock_consumed_quantity
    INTO v_unfulfilled
    FROM order_lines ol
    JOIN product_definitions pd
      ON pd.inventory_item_id = ol.inventory_item_id
     AND pd.tenant_id = ol.tenant_id
     AND pd.factory_id = ol.factory_id
     AND pd.status = 'ACTIVE'
    JOIN LATERAL (
      SELECT pv.id
      FROM product_versions pv
      WHERE pv.product_id = pd.id
        AND pv.tenant_id = pd.tenant_id
        AND pv.factory_id = pd.factory_id
        AND pv.state IN ('APPROVED', 'RETIRED')
        AND pv.effective_from <= CURRENT_DATE
        AND COALESCE(pv.effective_to_override, pv.effective_to, 'infinity'::date) >= CURRENT_DATE
      ORDER BY pv.effective_from DESC, pv.version_number DESC
      LIMIT 1
    ) effective_version ON TRUE
    WHERE ol.order_id = NEW.id
      AND ol.tenant_id = NEW.tenant_id
      AND ol.factory_id = NEW.factory_id
      AND EXISTS (
        SELECT 1 FROM product_bom_lines b
        WHERE b.product_id = pd.id
          AND b.product_version_id = effective_version.id
          AND b.tenant_id = ol.tenant_id
          AND b.factory_id = ol.factory_id
      )
      AND EXISTS (
        SELECT 1 FROM product_routing_steps route
        WHERE route.product_id = pd.id
          AND route.product_version_id = effective_version.id
          AND route.tenant_id = ol.tenant_id
          AND route.factory_id = ol.factory_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM work_orders wo
        WHERE wo.source_order_id = ol.order_id
          AND wo.source_order_line_id = ol.id
          AND wo.tenant_id = ol.tenant_id
          AND wo.factory_id = ol.factory_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM order_production_reports r
        WHERE r.order_id = ol.order_id
          AND r.order_line_id = ol.id
          AND r.tenant_id = ol.tenant_id
          AND r.factory_id = ol.factory_id
      )
      AND COALESCE((
        SELECT SUM(ir.consumed_quantity)
        FROM inventory_reservations ir
        WHERE ir.tenant_id = ol.tenant_id
          AND ir.factory_id = ol.factory_id
          AND ir.item_id = ol.inventory_item_id
          AND ir.reference_type = 'ORDER_LINE'
          AND ir.reference_id = ol.id
      ), 0) < ol.quantity
    ORDER BY ol.id
    LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION
        'manufacturing-capable sales-order line % must complete a work order or consume its full stock reservation before order completion (ordered %, consumed stock %)',
        v_unfulfilled.order_line_id, v_unfulfilled.ordered_quantity, v_unfulfilled.stock_consumed_quantity
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_manufacturing_or_stock_fulfillment_guard ON orders;
CREATE TRIGGER trg_order_manufacturing_or_stock_fulfillment_guard
BEFORE UPDATE OF status ON orders
FOR EACH ROW
EXECUTE FUNCTION factoryos_require_manufacturing_or_stock_fulfillment();

INSERT INTO schema_migrations(version, checksum)
VALUES ('207_manufacturing_order_line_fulfillment', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
