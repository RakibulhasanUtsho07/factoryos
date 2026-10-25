BEGIN;

-- WP02: bind dispatch to the FactoryOS customer order/line where available,
-- then preserve delivery progress and proof-of-delivery metadata as immutable evidence.
ALTER TABLE wms_shipments ADD COLUMN IF NOT EXISTS order_id UUID;
ALTER TABLE wms_shipments ADD COLUMN IF NOT EXISTS order_line_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.wms_shipments'::regclass AND conname='fk_wms_shipment_order') THEN
    ALTER TABLE wms_shipments ADD CONSTRAINT fk_wms_shipment_order
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.wms_shipments'::regclass AND conname='fk_wms_shipment_order_line') THEN
    ALTER TABLE wms_shipments ADD CONSTRAINT fk_wms_shipment_order_line
      FOREIGN KEY (order_line_id) REFERENCES order_lines(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.wms_shipments'::regclass AND conname='chk_wms_shipment_order_binding_pair') THEN
    ALTER TABLE wms_shipments ADD CONSTRAINT chk_wms_shipment_order_binding_pair
      CHECK ((order_id IS NULL) = (order_line_id IS NULL));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_wms_shipments_order_line
  ON wms_shipments (tenant_id, factory_id, order_id, order_line_id, dispatched_at DESC)
  WHERE order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS wms_shipment_delivery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  shipment_unit_id UUID NOT NULL,
  event_type VARCHAR(24) NOT NULL,
  source_system VARCHAR(30) NOT NULL DEFAULT 'MANUAL',
  event_at TIMESTAMPTZ NOT NULL,
  recipient_name VARCHAR(255),
  proof_type VARCHAR(32),
  proof_reference VARCHAR(500),
  proof_sha256 CHAR(64),
  signed_at TIMESTAMPTZ,
  notes VARCHAR(2000),
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  recorded_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_wms_shipment_delivery_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_wms_shipment_delivery_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_wms_shipment_delivery_shipment
    FOREIGN KEY (shipment_unit_id, tenant_id, factory_id)
    REFERENCES wms_shipments (shipment_unit_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_shipment_delivery_actor
    FOREIGN KEY (recorded_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_wms_shipment_delivery_event_type
    CHECK (event_type IN ('IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'DELIVERED', 'RETURNED')),
  CONSTRAINT chk_wms_shipment_delivery_source
    CHECK (source_system IN ('MANUAL', 'CARRIER_WEBHOOK', 'SYSTEM')),
  CONSTRAINT chk_wms_shipment_delivery_event_time
    CHECK (event_at <= clock_timestamp() + INTERVAL '10 minutes'),
  CONSTRAINT chk_wms_shipment_delivery_hash
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_wms_shipment_delivery_idempotency_key
    CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255 AND idempotency_key !~ '[[:cntrl:]]'),
  CONSTRAINT chk_wms_shipment_delivery_proof
    CHECK (
      (event_type <> 'DELIVERED'
       AND recipient_name IS NULL AND proof_type IS NULL AND proof_reference IS NULL
       AND proof_sha256 IS NULL AND signed_at IS NULL)
      OR
      (event_type = 'DELIVERED'
       AND length(btrim(COALESCE(recipient_name, ''))) BETWEEN 1 AND 255
       AND proof_type IN ('SIGNATURE', 'PHOTO', 'DOCUMENT', 'OTP', 'CUSTOMER_ACKNOWLEDGEMENT')
       AND length(btrim(COALESCE(proof_reference, ''))) BETWEEN 1 AND 500
       AND proof_sha256 ~ '^[a-f0-9]{64}$'
       AND signed_at IS NOT NULL
       AND signed_at <= event_at)
    )
);
CREATE INDEX IF NOT EXISTS idx_wms_shipment_delivery_timeline
  ON wms_shipment_delivery_events (tenant_id, factory_id, shipment_unit_id, created_at DESC, id DESC);

ALTER TABLE wms_shipment_delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_shipment_delivery_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wms_shipment_delivery_tenant_isolation ON wms_shipment_delivery_events;
CREATE POLICY wms_shipment_delivery_tenant_isolation ON wms_shipment_delivery_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_wms_shipment_order_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_line order_lines%ROWTYPE;
  v_sku VARCHAR(100);
  v_item_unit VARCHAR(50);
  v_prior_shipped NUMERIC(18,4);
  v_expected_reference VARCHAR(255);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'shipment dispatch evidence is append-only' USING ERRCODE = '55000';
  END IF;
  IF NEW.order_id IS NULL AND NEW.order_line_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.order_id IS NULL OR NEW.order_line_id IS NULL THEN
    RAISE EXCEPTION 'internal order binding requires both order_id and order_line_id' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_order
  FROM orders
  WHERE id=NEW.order_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer order was not found in the shipment tenant/factory' USING ERRCODE = '23514';
  END IF;
  IF v_order.status NOT IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETED') THEN
    RAISE EXCEPTION 'only confirmed, in-progress or completed orders may be dispatched' USING ERRCODE = '23514';
  END IF;
  IF length(btrim(COALESCE(v_order.customer_name, ''))) = 0
     OR lower(btrim(v_order.customer_name)) <> lower(btrim(NEW.customer_name)) THEN
    RAISE EXCEPTION 'shipment customer must match the bound customer order' USING ERRCODE = '23514';
  END IF;
  v_expected_reference := COALESCE(NULLIF(btrim(v_order.customer_reference), ''), btrim(v_order.order_number));
  IF lower(btrim(NEW.customer_order_reference)) <> lower(v_expected_reference) THEN
    RAISE EXCEPTION 'shipment customer-order reference must match the bound order reference' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_line
  FROM order_lines
  WHERE id=NEW.order_line_id AND tenant_id=NEW.tenant_id AND order_id=NEW.order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order line does not belong to the bound customer order' USING ERRCODE = '23514';
  END IF;
  SELECT sku, unit INTO v_sku, v_item_unit
  FROM inventory_items
  WHERE id=NEW.item_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  IF NOT FOUND OR upper(btrim(v_line.product_code)) <> upper(btrim(v_sku))
     OR upper(btrim(v_line.unit)) <> upper(btrim(v_item_unit))
     OR upper(btrim(NEW.unit)) <> upper(btrim(v_line.unit)) THEN
    RAISE EXCEPTION 'shipment item and unit must match the bound order line SKU and UOM' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(quantity), 0)::numeric(18,4) INTO v_prior_shipped
  FROM wms_shipments
  WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND order_line_id=NEW.order_line_id;
  IF v_prior_shipped + NEW.quantity > v_line.quantity THEN
    RAISE EXCEPTION 'shipment quantity exceeds the unshipped quantity on the bound order line' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wms_shipment_order_binding_guard ON wms_shipments;
CREATE TRIGGER trg_wms_shipment_order_binding_guard
BEFORE INSERT ON wms_shipments
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_wms_shipment_order_binding();

CREATE OR REPLACE FUNCTION factoryos_guard_wms_shipment_delivery_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_previous_event VARCHAR(24);
  v_shipment_status VARCHAR(16);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'shipment delivery evidence is append-only' USING ERRCODE = '55000';
  END IF;
  IF NEW.recorded_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'delivery event actor must match the authenticated user' USING ERRCODE = '23514';
  END IF;
  SELECT status INTO v_shipment_status
  FROM wms_shipments
  WHERE shipment_unit_id=NEW.shipment_unit_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND OR v_shipment_status <> 'DISPATCHED' THEN
    RAISE EXCEPTION 'delivery event requires a dispatched shipment in the same tenant/factory' USING ERRCODE = '23514';
  END IF;

  SELECT event_type INTO v_previous_event
  FROM wms_shipment_delivery_events
  WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND shipment_unit_id=NEW.shipment_unit_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1
  FOR UPDATE;

  IF v_previous_event IS NULL THEN
    IF NEW.event_type NOT IN ('IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'DELIVERED') THEN
      RAISE EXCEPTION 'first delivery event cannot be RETURNED' USING ERRCODE = '23514';
    END IF;
  ELSIF v_previous_event = 'IN_TRANSIT' THEN
    IF NEW.event_type NOT IN ('OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'DELIVERED', 'RETURNED') THEN
      RAISE EXCEPTION 'invalid delivery transition from IN_TRANSIT' USING ERRCODE = '23514';
    END IF;
  ELSIF v_previous_event = 'OUT_FOR_DELIVERY' THEN
    IF NEW.event_type NOT IN ('DELIVERY_FAILED', 'DELIVERED', 'RETURNED') THEN
      RAISE EXCEPTION 'invalid delivery transition from OUT_FOR_DELIVERY' USING ERRCODE = '23514';
    END IF;
  ELSIF v_previous_event = 'DELIVERY_FAILED' THEN
    IF NEW.event_type NOT IN ('IN_TRANSIT', 'OUT_FOR_DELIVERY') THEN
      RAISE EXCEPTION 'failed delivery must be retried before another final delivery event' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'delivered or returned shipments are terminal for delivery events' USING ERRCODE = '23514';
  END IF;

  IF NEW.event_type='DELIVERED' THEN
    IF length(btrim(COALESCE(NEW.recipient_name, ''))) = 0
       OR NEW.proof_type IS NULL OR length(btrim(COALESCE(NEW.proof_reference, ''))) = 0
       OR NEW.proof_sha256 IS NULL OR NEW.proof_sha256 !~ '^[a-f0-9]{64}$'
       OR NEW.signed_at IS NULL OR NEW.signed_at > NEW.event_at THEN
      RAISE EXCEPTION 'DELIVERED requires recipient, proof type, proof reference, SHA-256 digest and signed timestamp' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.recipient_name IS NOT NULL OR NEW.proof_type IS NOT NULL
     OR NEW.proof_reference IS NOT NULL OR NEW.proof_sha256 IS NOT NULL OR NEW.signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'proof-of-delivery fields may only be attached to DELIVERED events' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wms_shipment_delivery_event_guard ON wms_shipment_delivery_events;
CREATE TRIGGER trg_wms_shipment_delivery_event_guard
BEFORE INSERT OR UPDATE OR DELETE ON wms_shipment_delivery_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_wms_shipment_delivery_event();

CREATE OR REPLACE FUNCTION factoryos_assert_wms_shipment_delivery_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
      AND a.resource_type='WMS_SHIPMENT_DELIVERY_EVENT' AND a.resource_id=NEW.id::text
      AND a.action='RECORDED'
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id=NEW.tenant_id AND o.factory_id=NEW.factory_id
      AND o.aggregate_type='WMS_SHIPMENT_DELIVERY_EVENT' AND o.aggregate_id=NEW.id
      AND o.event_type='WMS.SHIPMENT_DELIVERY_EVENT_RECORDED'
  ) THEN
    RAISE EXCEPTION 'shipment delivery event requires transactional audit and outbox evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS ctr_wms_shipment_delivery_evidence ON wms_shipment_delivery_events;
CREATE CONSTRAINT TRIGGER ctr_wms_shipment_delivery_evidence
AFTER INSERT ON wms_shipment_delivery_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_wms_shipment_delivery_evidence();

INSERT INTO schema_migrations(version, checksum)
VALUES ('202_wms_shipment_order_delivery_proof', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
