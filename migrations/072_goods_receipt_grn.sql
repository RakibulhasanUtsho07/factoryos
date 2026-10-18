BEGIN;

-- A receipt line must link to a PO line in the same tenant, factory and PO.
ALTER TABLE purchase_order_lines
  ADD CONSTRAINT uq_purchase_order_lines_receipt_scope
  UNIQUE (id, tenant_id, factory_id, purchase_order_id);

INSERT INTO permissions (code, description)
VALUES
  ('goods_receipts.read', 'Read posted goods receipts within the authorized factory'),
  ('goods_receipts.write', 'Post goods receipts and accepted stock against approved purchase orders')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('goods_receipts.read', 'goods_receipts.write')
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE goods_receipts (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  purchase_order_id UUID NOT NULL,
  receipt_number VARCHAR(100) NOT NULL,
  status VARCHAR(16) NOT NULL,
  supplier_delivery_reference VARCHAR(150),
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  notes TEXT,
  created_by_user_id UUID NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  request_id UUID,
  trace_id UUID,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  posted_at TIMESTAMPTZ,
  CONSTRAINT uq_goods_receipts_id_scope_po
    UNIQUE (id, tenant_id, factory_id, purchase_order_id),
  CONSTRAINT uq_goods_receipts_scope_number
    UNIQUE (tenant_id, factory_id, receipt_number),
  CONSTRAINT uq_goods_receipts_idempotency
    UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_goods_receipts_po_scope
    FOREIGN KEY (purchase_order_id, tenant_id, factory_id)
    REFERENCES purchase_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_goods_receipts_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_goods_receipts_status CHECK (status IN ('POSTING', 'POSTED')),
  CONSTRAINT chk_goods_receipts_posted_at CHECK (
    (status = 'POSTING' AND posted_at IS NULL)
    OR (status = 'POSTED' AND posted_at IS NOT NULL)
  ),
  CONSTRAINT chk_goods_receipts_number CHECK (length(btrim(receipt_number)) > 0),
  CONSTRAINT chk_goods_receipts_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_goods_receipts_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_goods_receipts_po_created
  ON goods_receipts (tenant_id, factory_id, purchase_order_id, created_at DESC, id DESC);

CREATE TABLE goods_receipt_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  goods_receipt_id UUID NOT NULL,
  purchase_order_id UUID NOT NULL,
  purchase_order_line_id UUID NOT NULL,
  inventory_item_id UUID,
  received_quantity NUMERIC(18,4) NOT NULL,
  rejected_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  accepted_quantity NUMERIC(18,4)
    GENERATED ALWAYS AS (received_quantity - rejected_quantity) STORED,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_goods_receipt_line_per_po_line
    UNIQUE (goods_receipt_id, purchase_order_line_id),
  CONSTRAINT fk_goods_receipt_lines_receipt_scope
    FOREIGN KEY (goods_receipt_id, tenant_id, factory_id, purchase_order_id)
    REFERENCES goods_receipts(id, tenant_id, factory_id, purchase_order_id) ON DELETE RESTRICT,
  CONSTRAINT fk_goods_receipt_lines_po_line_scope
    FOREIGN KEY (purchase_order_line_id, tenant_id, factory_id, purchase_order_id)
    REFERENCES purchase_order_lines(id, tenant_id, factory_id, purchase_order_id) ON DELETE RESTRICT,
  CONSTRAINT fk_goods_receipt_lines_item_scope
    FOREIGN KEY (inventory_item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_goods_receipt_line_received CHECK (received_quantity > 0),
  CONSTRAINT chk_goods_receipt_line_rejected CHECK (
    rejected_quantity >= 0 AND rejected_quantity <= received_quantity
  ),
  CONSTRAINT chk_goods_receipt_line_rejection_reason CHECK (
    rejected_quantity = 0 OR length(btrim(COALESCE(rejection_reason, ''))) > 0
  )
);

CREATE INDEX idx_goods_receipt_lines_po_line
  ON goods_receipt_lines (tenant_id, factory_id, purchase_order_line_id);

CREATE OR REPLACE FUNCTION factoryos_guard_goods_receipt_header()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'goods receipts are immutable evidence and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
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
       NEW.id, NEW.tenant_id, NEW.factory_id, NEW.purchase_order_id, NEW.receipt_number,
       NEW.supplier_delivery_reference, NEW.received_at, NEW.notes, NEW.created_by_user_id,
       NEW.idempotency_key, NEW.request_hash, NEW.request_id, NEW.trace_id,
       NEW.correlation_id, NEW.created_at
     ) IS DISTINCT FROM ROW(
       OLD.id, OLD.tenant_id, OLD.factory_id, OLD.purchase_order_id, OLD.receipt_number,
       OLD.supplier_delivery_reference, OLD.received_at, OLD.notes, OLD.created_by_user_id,
       OLD.idempotency_key, OLD.request_hash, OLD.request_id, OLD.trace_id,
       OLD.correlation_id, OLD.created_at
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

CREATE OR REPLACE FUNCTION factoryos_guard_goods_receipt_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_receipt goods_receipts%ROWTYPE;
  v_po_line purchase_order_lines%ROWTYPE;
  v_po_status VARCHAR(24);
  v_item_status VARCHAR(20);
  v_item_unit VARCHAR(50);
  v_already_received NUMERIC(18,4);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'goods receipt lines are immutable after posting'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_receipt
  FROM goods_receipts
  WHERE id = NEW.goods_receipt_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
    AND purchase_order_id = NEW.purchase_order_id
  FOR UPDATE;

  IF NOT FOUND OR v_receipt.status <> 'POSTING'
     OR v_receipt.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'goods receipt lines can only be added to the current actor''s posting receipt'
      USING ERRCODE = '23514';
  END IF;

  SELECT po.status INTO v_po_status
  FROM purchase_orders po
  WHERE po.id = v_receipt.purchase_order_id
    AND po.tenant_id = v_receipt.tenant_id
    AND po.factory_id = v_receipt.factory_id
  FOR UPDATE;

  IF NOT FOUND OR v_po_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'goods can only be received against an approved purchase order'
      USING ERRCODE = '23514';
  END IF;

  SELECT pol.* INTO v_po_line
  FROM purchase_order_lines pol
  WHERE pol.id = NEW.purchase_order_line_id
    AND pol.tenant_id = NEW.tenant_id
    AND pol.factory_id = NEW.factory_id
    AND pol.purchase_order_id = v_receipt.purchase_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase-order line not found within this receipt''s purchase order'
      USING ERRCODE = '23503';
  END IF;

  NEW.inventory_item_id := v_po_line.inventory_item_id;

  IF NEW.rejected_quantity > 0 AND length(btrim(COALESCE(NEW.rejection_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'a rejection reason is required when any received quantity is rejected'
      USING ERRCODE = '23514';
  END IF;

  IF (NEW.received_quantity - NEW.rejected_quantity) > 0 THEN
    IF v_po_line.inventory_item_id IS NULL THEN
      RAISE EXCEPTION 'an inventory item must be mapped before accepted quantity can be posted to stock'
        USING ERRCODE = '23514';
    END IF;

    SELECT i.status, i.unit INTO v_item_status, v_item_unit
    FROM inventory_items i
    WHERE i.id = v_po_line.inventory_item_id
      AND i.tenant_id = NEW.tenant_id
      AND i.factory_id = NEW.factory_id
    FOR UPDATE;

    IF NOT FOUND OR v_item_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'accepted receipt quantity requires an active inventory item in this factory'
        USING ERRCODE = '23514';
    END IF;
    IF upper(btrim(v_item_unit)) <> upper(btrim(v_po_line.unit)) THEN
      RAISE EXCEPTION 'purchase-order unit must match the inventory item unit before stock posting'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT COALESCE(SUM(gl.received_quantity), 0)::numeric(18,4)
    INTO v_already_received
  FROM goods_receipt_lines gl
  JOIN goods_receipts gr
    ON gr.id = gl.goods_receipt_id
   AND gr.tenant_id = gl.tenant_id
   AND gr.factory_id = gl.factory_id
  WHERE gl.tenant_id = NEW.tenant_id
    AND gl.factory_id = NEW.factory_id
    AND gl.purchase_order_line_id = NEW.purchase_order_line_id
    AND gr.status = 'POSTED';

  IF v_already_received + NEW.received_quantity > v_po_line.quantity THEN
    RAISE EXCEPTION 'received quantity exceeds the remaining purchase-order line quantity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_goods_receipt_line_guard
BEFORE INSERT OR UPDATE OR DELETE ON goods_receipt_lines
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_goods_receipt_line();

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
      AND gl.accepted_quantity > 0
      AND NOT EXISTS (
        SELECT 1
        FROM inventory_movements im
        WHERE im.tenant_id = gl.tenant_id
          AND im.factory_id = gl.factory_id
          AND im.item_id = gl.inventory_item_id
          AND im.movement_type = 'RECEIPT'
          AND im.quantity = gl.accepted_quantity
          AND im.quantity_delta = gl.accepted_quantity
          AND im.reference_type = 'GOODS_RECEIPT'
          AND im.reference_id = v_receipt.id
          AND im.idempotency_key = 'GRN:' || v_receipt.id::text || ':' || gl.purchase_order_line_id::text
      )
  ) THEN
    RAISE EXCEPTION 'every accepted goods receipt quantity must have exactly one stock movement'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM goods_receipt_lines gl
    WHERE gl.goods_receipt_id = v_receipt.id
      AND gl.accepted_quantity = 0
      AND EXISTS (
        SELECT 1 FROM inventory_movements im
        WHERE im.tenant_id = gl.tenant_id AND im.factory_id = gl.factory_id
          AND im.reference_type = 'GOODS_RECEIPT'
          AND im.reference_id = v_receipt.id
          AND im.idempotency_key = 'GRN:' || v_receipt.id::text || ':' || gl.purchase_order_line_id::text
      )
  ) THEN
    RAISE EXCEPTION 'fully rejected goods receipt lines must not create stock movements'
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

CREATE CONSTRAINT TRIGGER ctr_goods_receipt_posted_integrity
AFTER INSERT OR UPDATE ON goods_receipts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_goods_receipt_posted();

ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY goods_receipts_tenant_isolation ON goods_receipts
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE goods_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY goods_receipt_lines_tenant_isolation ON goods_receipt_lines
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version, checksum)
VALUES ('072_goods_receipt_grn', NULL)
ON CONFLICT (version) DO NOTHING;

COMMENT ON TABLE goods_receipts IS
  'Posted GRN evidence for partial goods receipt against approved purchase orders; accepted goods are posted to stock in the same transaction.';
COMMENT ON TABLE goods_receipt_lines IS
  'Immutable PO-line quantities physically received, rejected, and accepted; accepted_quantity is generated and linked to stock ledger movements.';

COMMIT;
