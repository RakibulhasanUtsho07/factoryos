BEGIN;

-- Persist the selected/default receiving location on the immutable receipt header.
ALTER TABLE goods_receipts ADD COLUMN location_id UUID;

-- The old header immutability trigger blocks any UPDATE of posted rows, so detach it
-- during this one-time historical backfill. The deferred evidence assertion remains.
DROP TRIGGER trg_goods_receipts_lifecycle_guard ON goods_receipts;

UPDATE goods_receipts gr
SET location_id = COALESCE(
  (
    SELECT im.location_id
    FROM inventory_movements im
    WHERE im.tenant_id = gr.tenant_id
      AND im.factory_id = gr.factory_id
      AND im.reference_type = 'GOODS_RECEIPT'
      AND im.reference_id = gr.id
      AND im.location_id IS NOT NULL
    ORDER BY im.created_at, im.id
    LIMIT 1
  ),
  (
    SELECT l.id
    FROM inventory_locations l
    WHERE l.tenant_id = gr.tenant_id
      AND l.factory_id = gr.factory_id
      AND l.is_default = TRUE
      AND l.status = 'ACTIVE'
    LIMIT 1
  )
);

ALTER TABLE goods_receipts ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE goods_receipts
  ADD CONSTRAINT fk_goods_receipts_location_scope
  FOREIGN KEY (location_id, tenant_id, factory_id)
  REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT;

CREATE INDEX idx_goods_receipts_scope_location_created
  ON goods_receipts (tenant_id, factory_id, location_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_goods_receipt_header()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_location_type VARCHAR(20);
  v_location_status VARCHAR(20);
  v_location_default BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'goods receipts are immutable evidence and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT l.location_type, l.status, l.is_default
      INTO v_location_type, v_location_status, v_location_default
    FROM inventory_locations l
    WHERE l.id = NEW.location_id
      AND l.tenant_id = NEW.tenant_id
      AND l.factory_id = NEW.factory_id;

    IF NOT FOUND OR v_location_status <> 'ACTIVE'
       OR NOT (
         v_location_type IN ('WAREHOUSE', 'STAGING', 'BIN')
         OR (v_location_type = 'VIRTUAL' AND v_location_default = TRUE)
       ) THEN
      RAISE EXCEPTION 'goods receipt requires an active receiving location in the same factory'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.status <> 'POSTING' OR NEW.posted_at IS NOT NULL
       OR NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'goods receipts must begin in POSTING state under the authenticated actor'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'POSTING'
     OR NEW.status <> 'POSTED'
     OR NEW.posted_at IS NULL
     OR ROW(
       NEW.id, NEW.tenant_id, NEW.factory_id, NEW.purchase_order_id, NEW.location_id,
       NEW.receipt_number, NEW.supplier_delivery_reference, NEW.received_at, NEW.notes,
       NEW.created_by_user_id, NEW.idempotency_key, NEW.request_hash, NEW.request_id,
       NEW.trace_id, NEW.correlation_id, NEW.created_at
     ) IS DISTINCT FROM ROW(
       OLD.id, OLD.tenant_id, OLD.factory_id, OLD.purchase_order_id, OLD.location_id,
       OLD.receipt_number, OLD.supplier_delivery_reference, OLD.received_at, OLD.notes,
       OLD.created_by_user_id, OLD.idempotency_key, OLD.request_hash, OLD.request_id,
       OLD.trace_id, OLD.correlation_id, OLD.created_at
     ) THEN
    RAISE EXCEPTION 'goods receipts may only transition once from POSTING to POSTED'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_goods_receipts_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON goods_receipts
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_goods_receipt_header();

-- A movement may reference a GRN only while that receipt is in POSTING. It must
-- correspond to exactly one accepted line and reflect the same location/quantity.
CREATE OR REPLACE FUNCTION factoryos_guard_goods_receipt_stock_movement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_receipt goods_receipts%ROWTYPE;
  v_line goods_receipt_lines%ROWTYPE;
  v_quantity_on_hand NUMERIC(18,4);
BEGIN
  IF NEW.reference_type IS DISTINCT FROM 'GOODS_RECEIPT' THEN
    RETURN NEW;
  END IF;

  IF NEW.reference_id IS NULL THEN
    RAISE EXCEPTION 'a goods-receipt stock movement requires a receipt id'
      USING ERRCODE = '23514';
  END IF;

  SELECT gr.* INTO v_receipt
  FROM goods_receipts gr
  WHERE gr.id = NEW.reference_id
    AND gr.tenant_id = NEW.tenant_id
    AND gr.factory_id = NEW.factory_id
  FOR UPDATE;

  IF NOT FOUND OR v_receipt.status <> 'POSTING' THEN
    RAISE EXCEPTION 'stock movements may only be added while their goods receipt is POSTING'
      USING ERRCODE = '23514';
  END IF;

  IF v_receipt.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'goods-receipt stock movement actor must match the posting receipt actor'
      USING ERRCODE = '23514';
  END IF;

  SELECT gl.* INTO v_line
  FROM goods_receipt_lines gl
  WHERE gl.tenant_id = NEW.tenant_id
    AND gl.factory_id = NEW.factory_id
    AND gl.goods_receipt_id = v_receipt.id
    AND gl.inventory_item_id = NEW.item_id
    AND gl.accepted_quantity > 0
    AND NEW.idempotency_key = 'GRN:' || v_receipt.id::text || ':' || gl.purchase_order_line_id::text
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'goods-receipt movement must map to one accepted receipt line'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.movement_type <> 'RECEIPT'
     OR NEW.quantity IS DISTINCT FROM v_line.accepted_quantity
     OR NEW.quantity_delta IS DISTINCT FROM v_line.accepted_quantity
     OR NEW.location_id IS DISTINCT FROM v_receipt.location_id
     OR NEW.created_by_user_id IS DISTINCT FROM v_receipt.created_by_user_id THEN
    RAISE EXCEPTION 'goods-receipt movement must match accepted quantity, actor, and persisted receiving location'
      USING ERRCODE = '23514';
  END IF;

  SELECT b.quantity_on_hand INTO v_quantity_on_hand
  FROM inventory_stock_balances b
  WHERE b.tenant_id = NEW.tenant_id
    AND b.factory_id = NEW.factory_id
    AND b.item_id = NEW.item_id
  FOR SHARE;

  IF NOT FOUND OR NEW.quantity_after IS DISTINCT FROM v_quantity_on_hand THEN
    RAISE EXCEPTION 'goods-receipt movement quantity_after must match the posted aggregate stock balance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_goods_receipt_stock_movement_guard
BEFORE INSERT ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_goods_receipt_stock_movement();

-- Exactly one matching movement per accepted line; no movement for rejected lines;
-- no unrelated movement may refer to a posted GRN.
CREATE OR REPLACE FUNCTION factoryos_assert_goods_receipt_posted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_receipt goods_receipts%ROWTYPE;
BEGIN
  SELECT * INTO v_receipt
  FROM goods_receipts
  WHERE id = NEW.id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
    AND purchase_order_id = NEW.purchase_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'goods receipt disappeared before commit'
      USING ERRCODE = '23503';
  END IF;
  IF v_receipt.status <> 'POSTED' OR v_receipt.posted_at IS NULL THEN
    RAISE EXCEPTION 'a goods receipt cannot commit unless it is fully posted'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM goods_receipt_lines
    WHERE goods_receipt_id = v_receipt.id
      AND tenant_id = v_receipt.tenant_id
      AND factory_id = v_receipt.factory_id
  ) THEN
    RAISE EXCEPTION 'a posted goods receipt must contain at least one line'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM goods_receipt_lines gl
    WHERE gl.goods_receipt_id = v_receipt.id
      AND gl.tenant_id = v_receipt.tenant_id
      AND gl.factory_id = v_receipt.factory_id
      AND gl.accepted_quantity > 0
      AND (
        (
          SELECT count(*)
          FROM inventory_movements im
          WHERE im.tenant_id = gl.tenant_id
            AND im.factory_id = gl.factory_id
            AND im.reference_type = 'GOODS_RECEIPT'
            AND im.reference_id = v_receipt.id
            AND im.idempotency_key = 'GRN:' || v_receipt.id::text || ':' || gl.purchase_order_line_id::text
        ) <> 1
        OR NOT EXISTS (
          SELECT 1
          FROM inventory_movements im
          WHERE im.tenant_id = gl.tenant_id
            AND im.factory_id = gl.factory_id
            AND im.item_id = gl.inventory_item_id
            AND im.movement_type = 'RECEIPT'
            AND im.quantity = gl.accepted_quantity
            AND im.quantity_delta = gl.accepted_quantity
            AND im.location_id = v_receipt.location_id
            AND im.reference_type = 'GOODS_RECEIPT'
            AND im.reference_id = v_receipt.id
            AND im.idempotency_key = 'GRN:' || v_receipt.id::text || ':' || gl.purchase_order_line_id::text
        )
      )
  ) THEN
    RAISE EXCEPTION 'each accepted line requires exactly one matching stock movement'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM goods_receipt_lines gl
    WHERE gl.goods_receipt_id = v_receipt.id
      AND gl.tenant_id = v_receipt.tenant_id
      AND gl.factory_id = v_receipt.factory_id
      AND gl.accepted_quantity = 0
      AND EXISTS (
        SELECT 1 FROM inventory_movements im
        WHERE im.tenant_id = gl.tenant_id
          AND im.factory_id = gl.factory_id
          AND im.reference_type = 'GOODS_RECEIPT'
          AND im.reference_id = v_receipt.id
          AND im.idempotency_key = 'GRN:' || v_receipt.id::text || ':' || gl.purchase_order_line_id::text
      )
  ) THEN
    RAISE EXCEPTION 'fully rejected goods receipt lines must not create stock movements'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM inventory_movements im
    WHERE im.tenant_id = v_receipt.tenant_id
      AND im.factory_id = v_receipt.factory_id
      AND im.reference_type = 'GOODS_RECEIPT'
      AND im.reference_id = v_receipt.id
      AND NOT EXISTS (
        SELECT 1
        FROM goods_receipt_lines gl
        WHERE gl.tenant_id = im.tenant_id
          AND gl.factory_id = im.factory_id
          AND gl.goods_receipt_id = v_receipt.id
          AND gl.inventory_item_id = im.item_id
          AND gl.accepted_quantity > 0
          AND gl.accepted_quantity = im.quantity
          AND im.quantity_delta = gl.accepted_quantity
          AND im.movement_type = 'RECEIPT'
          AND im.location_id = v_receipt.location_id
          AND im.idempotency_key = 'GRN:' || v_receipt.id::text || ':' || gl.purchase_order_line_id::text
      )
  ) THEN
    RAISE EXCEPTION 'a goods receipt cannot have extra or mismatched stock movements'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id = v_receipt.tenant_id
      AND a.factory_id = v_receipt.factory_id
      AND a.resource_type = 'GOODS_RECEIPT'
      AND a.resource_id = v_receipt.id
      AND a.action = 'POSTED'
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id = v_receipt.tenant_id
      AND o.factory_id = v_receipt.factory_id
      AND o.aggregate_type = 'GOODS_RECEIPT'
      AND o.aggregate_id = v_receipt.id
      AND o.event_type = 'PROCUREMENT.GOODS_RECEIPT_POSTED'
  ) THEN
    RAISE EXCEPTION 'posted goods receipts require matching audit and outbox records'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('073_grn_stock_posting_guard', NULL)
ON CONFLICT (version) DO NOTHING;

COMMENT ON COLUMN goods_receipts.location_id IS
  'Immutable receiving location selected for this GRN; every accepted stock movement must post to this location.';
COMMENT ON FUNCTION factoryos_guard_goods_receipt_stock_movement() IS
  'Rejects late, extra, cross-line, or mismatched stock movements that reference a goods receipt.';

COMMIT;
