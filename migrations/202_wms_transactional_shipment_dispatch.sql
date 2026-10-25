BEGIN;

-- A shipment dispatch is the atomic boundary tying package genealogy to actual
-- inventory ISSUE movements. Only inventory that is already in outbound STAGING
-- and represented by finished-good lot/serial identities may leave stock.
CREATE TABLE traceability_shipment_dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  shipment_unit_id UUID NOT NULL,
  source_location_id UUID NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'DISPATCHED',
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  notes TEXT,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_traceability_shipment_dispatch_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_traceability_shipment_dispatch_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT uq_traceability_shipment_dispatch_shipment UNIQUE (tenant_id, factory_id, shipment_unit_id),
  CONSTRAINT fk_traceability_shipment_dispatch_unit
    FOREIGN KEY (shipment_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_shipment_dispatch_location
    FOREIGN KEY (source_location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_shipment_dispatch_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_traceability_shipment_dispatch_status CHECK (status = 'DISPATCHED'),
  CONSTRAINT chk_traceability_shipment_dispatch_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_traceability_shipment_dispatch_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_traceability_shipment_dispatch_created
  ON traceability_shipment_dispatches (tenant_id, factory_id, dispatched_at DESC, id DESC);

CREATE TABLE traceability_shipment_dispatch_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  dispatch_id UUID NOT NULL,
  item_id UUID NOT NULL,
  traceability_unit_id UUID NOT NULL,
  source_location_id UUID NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  unit VARCHAR(50) NOT NULL,
  inventory_movement_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_traceability_shipment_dispatch_line_identity
    UNIQUE (tenant_id, factory_id, dispatch_id, traceability_unit_id),
  CONSTRAINT fk_traceability_shipment_dispatch_line_dispatch
    FOREIGN KEY (dispatch_id, tenant_id, factory_id)
    REFERENCES traceability_shipment_dispatches (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_shipment_dispatch_line_item
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_shipment_dispatch_line_unit
    FOREIGN KEY (traceability_unit_id, tenant_id, factory_id, item_id)
    REFERENCES traceability_units (id, tenant_id, factory_id, inventory_item_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_shipment_dispatch_line_location
    FOREIGN KEY (source_location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_shipment_dispatch_line_movement
    FOREIGN KEY (inventory_movement_id) REFERENCES inventory_movements (id) ON DELETE RESTRICT,
  CONSTRAINT chk_traceability_shipment_dispatch_line_quantity CHECK (quantity > 0),
  CONSTRAINT chk_traceability_shipment_dispatch_line_unit CHECK (length(btrim(unit)) > 0)
);

CREATE INDEX idx_traceability_shipment_dispatch_line_item
  ON traceability_shipment_dispatch_lines (tenant_id, factory_id, item_id, source_location_id);

ALTER TABLE traceability_shipment_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE traceability_shipment_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY traceability_shipment_dispatch_tenant_isolation
  ON traceability_shipment_dispatches
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE traceability_shipment_dispatch_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE traceability_shipment_dispatch_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY traceability_shipment_dispatch_line_tenant_isolation
  ON traceability_shipment_dispatch_lines
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_reject_traceability_dispatch_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'shipment dispatch evidence is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER traceability_shipment_dispatch_immutable
BEFORE UPDATE OR DELETE ON traceability_shipment_dispatches
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_traceability_dispatch_mutation();

CREATE TRIGGER traceability_shipment_dispatch_line_immutable
BEFORE UPDATE OR DELETE ON traceability_shipment_dispatch_lines
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_traceability_dispatch_mutation();

CREATE OR REPLACE FUNCTION factoryos_guard_traceability_shipment_dispatch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit_type VARCHAR(24);
  v_product_role VARCHAR(20);
  v_status VARCHAR(16);
  v_attributes JSONB;
  v_location_type VARCHAR(20);
  v_location_status VARCHAR(20);
  v_picking_enabled BOOLEAN;
BEGIN
  SELECT unit_type, product_role, status, attributes
    INTO v_unit_type, v_product_role, v_status, v_attributes
  FROM traceability_units
  WHERE id = NEW.shipment_unit_id
    AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  FOR UPDATE;

  IF NOT FOUND OR v_unit_type <> 'SHIPMENT' OR v_product_role <> 'SHIPMENT' OR v_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'dispatch requires an active shipment identity in the same factory'
      USING ERRCODE = '23514';
  END IF;

  IF btrim(COALESCE(v_attributes->>'customer_reference', '')) = ''
    OR btrim(COALESCE(v_attributes->>'customer_order_reference', '')) = ''
    OR btrim(COALESCE(v_attributes->>'shipment_reference', '')) = '' THEN
    RAISE EXCEPTION 'shipment dispatch requires customer, customer-order and shipment references'
      USING ERRCODE = '23514';
  END IF;

  SELECT location_type, status, picking_enabled
    INTO v_location_type, v_location_status, v_picking_enabled
  FROM inventory_locations
  WHERE id = NEW.source_location_id
    AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  FOR SHARE;

  IF NOT FOUND OR v_location_type <> 'STAGING' OR v_location_status <> 'ACTIVE' OR v_picking_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'shipment dispatch must issue from an active pick-enabled STAGING location'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM product_genealogy_events e
    JOIN traceability_units p
      ON p.id = e.source_unit_id AND p.tenant_id = e.tenant_id AND p.factory_id = e.factory_id
    WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
      AND e.target_unit_id = NEW.shipment_unit_id AND e.relationship_type = 'SHIPPED_AS'
      AND p.product_role = 'PACKAGING' AND p.unit_type IN ('CARTON', 'PALLET')
  ) THEN
    RAISE EXCEPTION 'shipment cannot dispatch until a carton or pallet has been linked to it'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER traceability_shipment_dispatch_guard
BEFORE INSERT ON traceability_shipment_dispatches
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_traceability_shipment_dispatch();

CREATE OR REPLACE FUNCTION factoryos_guard_traceability_shipment_dispatch_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_dispatch_location UUID;
  v_source_type VARCHAR(24);
  v_source_role VARCHAR(20);
  v_source_status VARCHAR(16);
  v_source_expiry DATE;
  v_move_item UUID;
  v_move_location UUID;
  v_move_type VARCHAR(20);
  v_move_reference_type VARCHAR(64);
  v_move_reference_id UUID;
BEGIN
  SELECT source_location_id INTO v_dispatch_location
  FROM traceability_shipment_dispatches
  WHERE id = NEW.dispatch_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  FOR SHARE;

  IF NOT FOUND OR v_dispatch_location <> NEW.source_location_id THEN
    RAISE EXCEPTION 'dispatch line must use the dispatch outbound staging location'
      USING ERRCODE = '23514';
  END IF;

  SELECT unit_type, product_role, status, expires_at
    INTO v_source_type, v_source_role, v_source_status, v_source_expiry
  FROM traceability_units
  WHERE id = NEW.traceability_unit_id
    AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND inventory_item_id = NEW.item_id
  FOR SHARE;

  IF NOT FOUND
    OR v_source_role <> 'FINISHED_GOOD'
    OR v_source_type NOT IN ('LOT', 'SERIAL', 'FINISHED_GOOD')
    OR v_source_status <> 'ACTIVE'
    OR (v_source_expiry IS NOT NULL AND v_source_expiry < CURRENT_DATE) THEN
    RAISE EXCEPTION 'dispatch line must bind an eligible active finished-good lot/serial to its inventory item'
      USING ERRCODE = '23514';
  END IF;

  SELECT item_id, location_id, movement_type, reference_type, reference_id
    INTO v_move_item, v_move_location, v_move_type, v_move_reference_type, v_move_reference_id
  FROM inventory_movements
  WHERE id = NEW.inventory_movement_id
    AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  FOR SHARE;

  IF NOT FOUND OR v_move_item <> NEW.item_id OR v_move_location <> NEW.source_location_id
    OR v_move_type <> 'ISSUE' OR v_move_reference_type <> 'SHIPMENT_DISPATCH'
    OR v_move_reference_id <> NEW.dispatch_id THEN
    RAISE EXCEPTION 'dispatch line must reference its matching item/location shipment issue movement'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER traceability_shipment_dispatch_line_guard
BEFORE INSERT ON traceability_shipment_dispatch_lines
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_traceability_shipment_dispatch_line();

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_shipment_dispatch_movement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_location_id UUID;
BEGIN
  IF NEW.reference_type <> 'SHIPMENT_DISPATCH' THEN
    RETURN NEW;
  END IF;

  SELECT source_location_id INTO v_location_id
  FROM traceability_shipment_dispatches
  WHERE id = NEW.reference_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  FOR SHARE;

  IF NOT FOUND OR NEW.movement_type <> 'ISSUE' OR NEW.location_id IS DISTINCT FROM v_location_id THEN
    RAISE EXCEPTION 'shipment dispatch movement must be a scoped ISSUE from the dispatch outbound staging location'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_shipment_dispatch_movement_guard
BEFORE INSERT ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_shipment_dispatch_movement();

CREATE OR REPLACE FUNCTION factoryos_assert_traceability_shipment_dispatch_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status VARCHAR(16);
  v_line_count INTEGER;
BEGIN
  SELECT status INTO v_status
  FROM traceability_units
  WHERE id = NEW.shipment_unit_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;

  IF v_status IS DISTINCT FROM 'SHIPPED' THEN
    RAISE EXCEPTION 'dispatch evidence requires the linked shipment identity to be SHIPPED'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::INTEGER INTO v_line_count
  FROM traceability_shipment_dispatch_lines l
  WHERE l.dispatch_id = NEW.id AND l.tenant_id = NEW.tenant_id AND l.factory_id = NEW.factory_id;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'shipment dispatch requires at least one finished-good lot/serial issue line'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT item_id, SUM(quantity) AS line_quantity, COUNT(DISTINCT inventory_movement_id) AS movement_count,
        (ARRAY_AGG(DISTINCT inventory_movement_id))[1] AS movement_id
      FROM traceability_shipment_dispatch_lines
      WHERE dispatch_id = NEW.id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
      GROUP BY item_id
    ) totals
    LEFT JOIN inventory_movements m
      ON m.id = totals.movement_id AND m.tenant_id = NEW.tenant_id AND m.factory_id = NEW.factory_id
    WHERE totals.movement_count <> 1
      OR m.id IS NULL OR m.item_id <> totals.item_id
      OR m.movement_type <> 'ISSUE' OR m.reference_type <> 'SHIPMENT_DISPATCH'
      OR m.reference_id <> NEW.id OR m.location_id <> NEW.source_location_id
      OR m.quantity IS DISTINCT FROM totals.line_quantity
  ) THEN
    RAISE EXCEPTION 'each dispatch item must reconcile exactly to one matching issue movement'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
      AND a.resource_type = 'TRACEABILITY_SHIPMENT_DISPATCH' AND a.resource_id = NEW.id
      AND a.action = 'DISPATCHED'
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id = NEW.tenant_id AND o.factory_id = NEW.factory_id
      AND o.aggregate_type = 'TRACEABILITY_SHIPMENT_DISPATCH' AND o.aggregate_id = NEW.id
      AND o.event_type = 'TRACEABILITY.SHIPMENT_DISPATCHED'
  ) THEN
    RAISE EXCEPTION 'shipment dispatch requires transactional audit and outbox evidence'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ctr_traceability_shipment_dispatch_evidence
AFTER INSERT ON traceability_shipment_dispatches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_traceability_shipment_dispatch_evidence();

-- A generic status endpoint may not bypass inventory issue/dispatch posting.
CREATE OR REPLACE FUNCTION factoryos_guard_shipment_customer_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.unit_type = 'SHIPMENT' THEN
    IF NEW.product_role <> 'SHIPMENT'
      OR btrim(COALESCE(NEW.attributes->>'customer_reference', '')) = ''
      OR btrim(COALESCE(NEW.attributes->>'customer_order_reference', '')) = ''
      OR btrim(COALESCE(NEW.attributes->>'shipment_reference', '')) = '' THEN
      RAISE EXCEPTION 'shipment identity requires customer_reference, customer_order_reference and shipment_reference'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.status = 'SHIPPED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'SHIPPED') THEN
      IF NOT EXISTS (
        SELECT 1 FROM traceability_shipment_dispatches d
        WHERE d.shipment_unit_id = NEW.id AND d.tenant_id = NEW.tenant_id AND d.factory_id = NEW.factory_id
      ) THEN
        RAISE EXCEPTION 'shipment cannot become SHIPPED until its stock issue and dispatch evidence are recorded'
          USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM product_genealogy_events e
        JOIN traceability_units p
          ON p.id = e.source_unit_id AND p.tenant_id = e.tenant_id AND p.factory_id = e.factory_id
        WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
          AND e.target_unit_id = NEW.id AND e.relationship_type = 'SHIPPED_AS'
          AND p.product_role = 'PACKAGING' AND p.unit_type IN ('CARTON', 'PALLET')
      ) THEN
        RAISE EXCEPTION 'shipment cannot transition to SHIPPED before a package genealogy edge exists'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE COMMENT ON FUNCTION factoryos_guard_inventory_shipment_dispatch_movement() IS
  'Allows shipment-dispatch inventory issues only when they are bound to a scoped dispatch and its outbound staging location.';
CREATE COMMENT ON FUNCTION factoryos_assert_traceability_shipment_dispatch_evidence() IS
  'Requires immutable shipment dispatch evidence, issue movements reconciled by item, shipment status, audit and outbox before commit.';

INSERT INTO schema_migrations(version, checksum)
VALUES ('202_wms_transactional_shipment_dispatch', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
