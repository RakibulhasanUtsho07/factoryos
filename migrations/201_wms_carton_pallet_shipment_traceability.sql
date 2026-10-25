BEGIN;

-- WP02: physical carton/pallet packing and customer dispatch are stock-bound
-- workflows. Genealogy is necessary but is not by itself evidence of a stock issue.
CREATE TABLE IF NOT EXISTS wms_packing_containers (
  container_unit_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  location_id UUID NOT NULL,
  container_type VARCHAR(12) NOT NULL,
  unit VARCHAR(50) NOT NULL,
  capacity_quantity NUMERIC(18,4) NOT NULL,
  packed_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  seal_idempotency_key VARCHAR(255),
  seal_request_hash CHAR(64),
  sealed_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pk_wms_packing_containers PRIMARY KEY (container_unit_id),
  CONSTRAINT uq_wms_packing_container_scope UNIQUE (container_unit_id, tenant_id, factory_id, item_id),
  CONSTRAINT uq_wms_packing_container_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_wms_packing_container_unit
    FOREIGN KEY (container_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_packing_container_item
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_packing_container_location
    FOREIGN KEY (location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_packing_container_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_wms_packing_container_type CHECK (container_type IN ('CARTON', 'PALLET')),
  CONSTRAINT chk_wms_packing_container_capacity CHECK (capacity_quantity > 0 AND packed_quantity >= 0 AND packed_quantity <= capacity_quantity),
  CONSTRAINT chk_wms_packing_container_unit CHECK (length(btrim(unit)) > 0),
  CONSTRAINT chk_wms_packing_container_status CHECK (status IN ('OPEN', 'SEALED', 'DISPATCHED')),
  CONSTRAINT chk_wms_packing_container_hash CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_wms_packing_container_seal_binding CHECK (
    (status = 'OPEN' AND seal_idempotency_key IS NULL AND seal_request_hash IS NULL AND sealed_at IS NULL AND dispatched_at IS NULL)
    OR
    (status IN ('SEALED', 'DISPATCHED') AND seal_idempotency_key IS NOT NULL
     AND length(btrim(seal_idempotency_key)) > 0
     AND seal_request_hash IS NOT NULL AND seal_request_hash ~ '^[a-f0-9]{64}$' AND sealed_at IS NOT NULL
     AND ((status = 'SEALED' AND dispatched_at IS NULL) OR (status = 'DISPATCHED' AND dispatched_at IS NOT NULL)))
  )
);
CREATE INDEX IF NOT EXISTS idx_wms_packing_container_location
  ON wms_packing_containers (tenant_id, factory_id, location_id, status, container_type);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_packing_container_seal_idempotency
  ON wms_packing_containers (tenant_id, factory_id, seal_idempotency_key)
  WHERE seal_idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS wms_packing_contents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  container_unit_id UUID NOT NULL,
  source_unit_id UUID NOT NULL,
  source_container_unit_id UUID,
  location_id UUID NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  unit VARCHAR(50) NOT NULL,
  genealogy_event_id UUID NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_wms_packing_content_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_wms_packing_content_source UNIQUE (tenant_id, factory_id, container_unit_id, source_unit_id),
  CONSTRAINT uq_wms_packing_content_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_wms_packing_content_container
    FOREIGN KEY (container_unit_id, tenant_id, factory_id, item_id)
    REFERENCES wms_packing_containers (container_unit_id, tenant_id, factory_id, item_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_packing_content_source
    FOREIGN KEY (source_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_packing_content_source_container
    FOREIGN KEY (source_container_unit_id, tenant_id, factory_id, item_id)
    REFERENCES wms_packing_containers (container_unit_id, tenant_id, factory_id, item_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_packing_content_location
    FOREIGN KEY (location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_packing_content_genealogy
    FOREIGN KEY (genealogy_event_id, tenant_id, factory_id)
    REFERENCES product_genealogy_events (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_packing_content_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_wms_packing_content_quantity CHECK (quantity > 0),
  CONSTRAINT chk_wms_packing_content_unit CHECK (length(btrim(unit)) > 0),
  CONSTRAINT chk_wms_packing_content_hash CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_wms_packing_content_source_container CHECK (
    (source_container_unit_id IS NULL AND source_unit_id IS DISTINCT FROM container_unit_id)
    OR (source_container_unit_id IS NOT NULL AND source_container_unit_id = source_unit_id
        AND source_unit_id IS DISTINCT FROM container_unit_id)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_packing_carton_parent
  ON wms_packing_contents (tenant_id, factory_id, source_container_unit_id)
  WHERE source_container_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wms_packing_content_container
  ON wms_packing_contents (tenant_id, factory_id, container_unit_id, source_unit_id);

CREATE TABLE IF NOT EXISTS wms_shipments (
  shipment_unit_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  container_unit_id UUID NOT NULL,
  item_id UUID NOT NULL,
  source_location_id UUID NOT NULL,
  inventory_movement_id UUID NOT NULL,
  shipment_code VARCHAR(160) NOT NULL,
  customer_name VARCHAR(255) NOT NULL,
  customer_order_reference VARCHAR(160) NOT NULL,
  carrier_name VARCHAR(255),
  tracking_reference VARCHAR(255),
  quantity NUMERIC(18,4) NOT NULL,
  unit VARCHAR(50) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'DISPATCHED',
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  dispatched_by_user_id UUID NOT NULL,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pk_wms_shipments PRIMARY KEY (shipment_unit_id),
  CONSTRAINT uq_wms_shipment_scope UNIQUE (shipment_unit_id, tenant_id, factory_id),
  CONSTRAINT uq_wms_shipment_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT uq_wms_shipment_code UNIQUE (tenant_id, factory_id, shipment_code),
  CONSTRAINT uq_wms_shipment_container UNIQUE (container_unit_id),
  CONSTRAINT fk_wms_shipment_unit
    FOREIGN KEY (shipment_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_shipment_container
    FOREIGN KEY (container_unit_id, tenant_id, factory_id, item_id)
    REFERENCES wms_packing_containers (container_unit_id, tenant_id, factory_id, item_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_shipment_location
    FOREIGN KEY (source_location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_shipment_movement
    FOREIGN KEY (inventory_movement_id, tenant_id, factory_id)
    REFERENCES inventory_movements (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_shipment_actor
    FOREIGN KEY (dispatched_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_wms_shipment_customer CHECK (length(btrim(customer_name)) > 0 AND length(btrim(customer_order_reference)) > 0),
  CONSTRAINT chk_wms_shipment_quantity CHECK (quantity > 0),
  CONSTRAINT chk_wms_shipment_unit CHECK (length(btrim(unit)) > 0),
  CONSTRAINT chk_wms_shipment_status CHECK (status = 'DISPATCHED'),
  CONSTRAINT chk_wms_shipment_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_wms_shipments_customer_reference
  ON wms_shipments (tenant_id, factory_id, customer_order_reference, dispatched_at DESC);

ALTER TABLE wms_packing_containers ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_packing_containers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wms_packing_containers_tenant_isolation ON wms_packing_containers;
CREATE POLICY wms_packing_containers_tenant_isolation ON wms_packing_containers
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE wms_packing_contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_packing_contents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wms_packing_contents_tenant_isolation ON wms_packing_contents;
CREATE POLICY wms_packing_contents_tenant_isolation ON wms_packing_contents
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE wms_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_shipments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wms_shipments_tenant_isolation ON wms_shipments;
CREATE POLICY wms_shipments_tenant_isolation ON wms_shipments
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_wms_packing_container()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit_type VARCHAR(24);
  v_product_role VARCHAR(20);
  v_unit_quantity NUMERIC(18,4);
  v_unit VARCHAR(50);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'WMS packing container records are immutable evidence'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.status <> 'OPEN' OR NEW.packed_quantity <> 0
       OR NEW.seal_idempotency_key IS NOT NULL OR NEW.seal_request_hash IS NOT NULL
       OR NEW.sealed_at IS NOT NULL OR NEW.dispatched_at IS NOT NULL THEN
      RAISE EXCEPTION 'packing containers must start open and empty under the authenticated actor'
        USING ERRCODE = '23514';
    END IF;
    SELECT unit_type, product_role, quantity, unit
      INTO v_unit_type, v_product_role, v_unit_quantity, v_unit
    FROM traceability_units
    WHERE id = NEW.container_unit_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
    IF NOT FOUND OR v_unit_type <> NEW.container_type OR v_product_role <> 'PACKAGING'
       OR v_unit_quantity IS DISTINCT FROM NEW.capacity_quantity OR v_unit IS DISTINCT FROM NEW.unit THEN
      RAISE EXCEPTION 'packing container must match its registered carton/pallet identity and capacity'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.container_unit_id, NEW.tenant_id, NEW.factory_id, NEW.item_id, NEW.location_id,
    NEW.container_type, NEW.unit, NEW.capacity_quantity, NEW.idempotency_key,
    NEW.request_hash, NEW.created_by_user_id, NEW.correlation_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.container_unit_id, OLD.tenant_id, OLD.factory_id, OLD.item_id, OLD.location_id,
    OLD.container_type, OLD.unit, OLD.capacity_quantity, OLD.idempotency_key,
    OLD.request_hash, OLD.created_by_user_id, OLD.correlation_id, OLD.created_at
  ) OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'packing container identity and request binding are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.packed_quantity IS DISTINCT FROM OLD.packed_quantity THEN
    IF OLD.status <> 'OPEN' OR NEW.status <> 'OPEN'
       OR NEW.packed_quantity <= OLD.packed_quantity OR NEW.packed_quantity > NEW.capacity_quantity
       OR NEW.seal_idempotency_key IS DISTINCT FROM OLD.seal_idempotency_key
       OR NEW.seal_request_hash IS DISTINCT FROM OLD.seal_request_hash
       OR NEW.sealed_at IS DISTINCT FROM OLD.sealed_at
       OR NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at THEN
      RAISE EXCEPTION 'only open containers may add contents up to their declared capacity'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'OPEN' AND NEW.status = 'SEALED' THEN
    IF OLD.packed_quantity <= 0 OR NEW.seal_idempotency_key IS NULL
       OR NEW.seal_request_hash !~ '^[a-f0-9]{64}$' OR NEW.sealed_at IS NULL
       OR NEW.dispatched_at IS NOT NULL THEN
      RAISE EXCEPTION 'sealing requires non-empty contents and an idempotent seal record'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'SEALED' AND NEW.status = 'DISPATCHED' THEN
    IF NEW.dispatched_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM wms_shipments s
      WHERE s.tenant_id = NEW.tenant_id AND s.factory_id = NEW.factory_id
        AND (
          s.container_unit_id = NEW.container_unit_id
          OR EXISTS (
            SELECT 1 FROM wms_packing_contents parent_content
            WHERE parent_content.tenant_id = NEW.tenant_id AND parent_content.factory_id = NEW.factory_id
              AND parent_content.container_unit_id = s.container_unit_id
              AND parent_content.source_container_unit_id = NEW.container_unit_id
          )
        )
    ) THEN
      RAISE EXCEPTION 'a sealed container can be dispatched only with its own or parent shipment evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid WMS packing container lifecycle transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wms_packing_container_guard ON wms_packing_containers;
CREATE TRIGGER trg_wms_packing_container_guard
BEFORE INSERT OR UPDATE OR DELETE ON wms_packing_containers
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_wms_packing_container();

CREATE OR REPLACE FUNCTION factoryos_guard_wms_packing_content()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_container wms_packing_containers%ROWTYPE;
  v_source traceability_units%ROWTYPE;
  v_source_container wms_packing_containers%ROWTYPE;
  v_event product_genealogy_events%ROWTYPE;
  v_location_quantity NUMERIC(18,4);
  v_location_reserved NUMERIC(18,4);
  v_already_packed NUMERIC(18,4);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'WMS packing content evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'packing content actor must match the authenticated user'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_container
  FROM wms_packing_containers
  WHERE container_unit_id = NEW.container_unit_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND OR v_container.status <> 'OPEN' OR v_container.item_id <> NEW.item_id
     OR v_container.location_id <> NEW.location_id OR v_container.unit <> NEW.unit THEN
    RAISE EXCEPTION 'packing content must target an open same-item container at the same physical location'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_source
  FROM traceability_units
  WHERE id = NEW.source_unit_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND OR v_source.status <> 'ACTIVE' OR v_source.unit <> NEW.unit THEN
    RAISE EXCEPTION 'packing source must be an active same-UOM traceability identity'
      USING ERRCODE = '23514';
  END IF;

  IF v_container.container_type = 'CARTON' THEN
    IF v_source.unit_type <> 'LOT' OR v_source.product_role <> 'FINISHED_GOOD'
       OR v_source.inventory_item_id <> NEW.item_id OR NEW.source_container_unit_id IS NOT NULL THEN
      RAISE EXCEPTION 'cartons may only contain finished-good lot quantities'
        USING ERRCODE = '23514';
    END IF;
    SELECT quantity_on_hand, quantity_reserved INTO v_location_quantity, v_location_reserved
    FROM inventory_traceability_location_balances
    WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id AND item_id = NEW.item_id
      AND traceability_unit_id = NEW.source_unit_id AND location_id = NEW.location_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finished-good lot has no tracked stock at this location'
        USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(sum(pc.quantity),0)::numeric(18,4)
      INTO v_already_packed
    FROM wms_packing_contents pc
    JOIN wms_packing_containers existing_carton
      ON existing_carton.container_unit_id=pc.container_unit_id
     AND existing_carton.tenant_id=pc.tenant_id AND existing_carton.factory_id=pc.factory_id
    WHERE pc.tenant_id=NEW.tenant_id AND pc.factory_id=NEW.factory_id
      AND pc.item_id=NEW.item_id AND pc.source_unit_id=NEW.source_unit_id
      AND pc.source_container_unit_id IS NULL
      AND existing_carton.container_type='CARTON'
      AND existing_carton.status <> 'DISPATCHED';
    IF v_location_quantity - v_location_reserved - v_already_packed < NEW.quantity THEN
      RAISE EXCEPTION 'packing quantity exceeds finished-good lot quantity not already packed into live cartons'
        USING ERRCODE = '23514';
    END IF;
    IF (v_source.expires_at IS NOT NULL AND v_source.expires_at < CURRENT_DATE)
       OR COALESCE(v_source.attributes @> '{"damaged":true}'::jsonb, FALSE)
       OR COALESCE(v_source.attributes @> '{"held":true}'::jsonb, FALSE)
       OR COALESCE(v_source.attributes @> '{"quarantined":true}'::jsonb, FALSE)
       OR upper(COALESCE(v_source.attributes->>'condition','')) IN ('DAMAGED','HELD','QUARANTINED','EXPIRED')
       OR EXISTS (
         SELECT 1 FROM quality_holds qh WHERE qh.tenant_id=NEW.tenant_id AND qh.factory_id=NEW.factory_id
          AND qh.status='ACTIVE' AND (qh.inventory_item_id=NEW.item_id OR qh.traceability_unit_id=NEW.source_unit_id)
       ) THEN
      RAISE EXCEPTION 'held, expired, damaged or quarantined finished-good lots cannot be packed'
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_container.container_type = 'PALLET' THEN
    IF v_source.unit_type <> 'CARTON' OR v_source.product_role <> 'PACKAGING'
       OR NEW.source_container_unit_id IS DISTINCT FROM NEW.source_unit_id THEN
      RAISE EXCEPTION 'pallets may only contain sealed cartons'
        USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_source_container
    FROM wms_packing_containers
    WHERE container_unit_id = NEW.source_unit_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    FOR UPDATE;
    IF NOT FOUND OR v_source_container.container_type <> 'CARTON'
       OR v_source_container.status <> 'SEALED'
       OR v_source_container.item_id <> NEW.item_id OR v_source_container.location_id <> NEW.location_id
       OR v_source_container.packed_quantity IS DISTINCT FROM NEW.quantity THEN
      RAISE EXCEPTION 'pallet contents must be whole sealed same-item cartons at the same location'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported packing container type'
      USING ERRCODE = '23514';
  END IF;

  IF v_container.packed_quantity + NEW.quantity > v_container.capacity_quantity THEN
    RAISE EXCEPTION 'packing would exceed the container capacity'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_event
  FROM product_genealogy_events
  WHERE id = NEW.genealogy_event_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
  IF NOT FOUND OR v_event.source_unit_id <> NEW.source_unit_id
     OR v_event.target_unit_id <> NEW.container_unit_id
     OR v_event.relationship_type <> 'PACKED_INTO'
     OR v_event.quantity IS DISTINCT FROM NEW.quantity OR v_event.unit <> NEW.unit THEN
    RAISE EXCEPTION 'packing content must match its immutable PACKED_INTO genealogy event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wms_packing_content_guard ON wms_packing_contents;
CREATE TRIGGER trg_wms_packing_content_guard
BEFORE INSERT ON wms_packing_contents
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_wms_packing_content();

CREATE OR REPLACE FUNCTION factoryos_prevent_wms_packing_content_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WMS packing content evidence is append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS trg_wms_packing_content_immutable ON wms_packing_contents;
CREATE TRIGGER trg_wms_packing_content_immutable
BEFORE UPDATE OR DELETE ON wms_packing_contents
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_wms_packing_content_mutation();

CREATE OR REPLACE FUNCTION factoryos_assert_wms_packing_quantity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant UUID;
  v_factory UUID;
  v_container UUID;
  v_packed NUMERIC(18,4);
  v_contents NUMERIC(18,4);
BEGIN
  IF TG_TABLE_NAME = 'wms_packing_contents' THEN
    v_tenant := NEW.tenant_id;
    v_factory := NEW.factory_id;
    v_container := NEW.container_unit_id;
  ELSE
    v_tenant := NEW.tenant_id;
    v_factory := NEW.factory_id;
    v_container := NEW.container_unit_id;
  END IF;
  SELECT packed_quantity INTO v_packed FROM wms_packing_containers
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND container_unit_id=v_container;
  SELECT COALESCE(sum(quantity),0)::numeric(18,4) INTO v_contents FROM wms_packing_contents
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND container_unit_id=v_container;
  IF v_packed IS DISTINCT FROM v_contents THEN
    RAISE EXCEPTION 'container packed quantity must equal append-only packing content quantity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS ctr_wms_packing_quantity_container ON wms_packing_containers;
CREATE CONSTRAINT TRIGGER ctr_wms_packing_quantity_container
AFTER INSERT OR UPDATE ON wms_packing_containers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_wms_packing_quantity();
DROP TRIGGER IF EXISTS ctr_wms_packing_quantity_content ON wms_packing_contents;
CREATE CONSTRAINT TRIGGER ctr_wms_packing_quantity_content
AFTER INSERT ON wms_packing_contents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_wms_packing_quantity();

CREATE OR REPLACE FUNCTION factoryos_guard_wms_shipment_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_container wms_packing_containers%ROWTYPE;
  v_shipment traceability_units%ROWTYPE;
  v_movement inventory_movements%ROWTYPE;
  v_leaf_quantity NUMERIC(18,4);
  v_leaf_count INTEGER;
  v_valid_leaves BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'shipment dispatch evidence is append-only' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_container FROM wms_packing_containers
  WHERE container_unit_id=NEW.container_unit_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND OR v_container.status <> 'SEALED' OR v_container.item_id <> NEW.item_id
     OR v_container.location_id <> NEW.source_location_id
     OR v_container.packed_quantity IS DISTINCT FROM NEW.quantity OR v_container.unit <> NEW.unit THEN
    RAISE EXCEPTION 'only a fully packed sealed same-item container may be dispatched'
      USING ERRCODE = '23514';
  END IF;
  IF v_container.container_type = 'CARTON' AND EXISTS (
    SELECT 1 FROM wms_packing_contents parent_content
    WHERE parent_content.tenant_id=NEW.tenant_id AND parent_content.factory_id=NEW.factory_id
      AND parent_content.source_container_unit_id=NEW.container_unit_id
  ) THEN
    RAISE EXCEPTION 'a carton assigned to a pallet must be dispatched through the pallet shipment'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_shipment FROM traceability_units
  WHERE id=NEW.shipment_unit_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  IF NOT FOUND OR v_shipment.unit_type <> 'SHIPMENT' OR v_shipment.product_role <> 'SHIPMENT'
     OR v_shipment.status <> 'ACTIVE' OR v_shipment.quantity IS DISTINCT FROM NEW.quantity
     OR v_shipment.unit <> NEW.unit OR v_shipment.unit_code <> NEW.shipment_code THEN
    RAISE EXCEPTION 'dispatch must bind a matching active shipment traceability identity'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_movement FROM inventory_movements
  WHERE id=NEW.inventory_movement_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  IF NOT FOUND OR v_movement.movement_type <> 'ISSUE' OR v_movement.item_id <> NEW.item_id
     OR v_movement.location_id <> NEW.source_location_id OR v_movement.quantity IS DISTINCT FROM NEW.quantity
     OR v_movement.reference_type <> 'WMS_SHIPMENT' OR v_movement.reference_id <> NEW.shipment_unit_id THEN
    RAISE EXCEPTION 'shipment dispatch requires its exact inventory ISSUE movement'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM product_genealogy_events e
    WHERE e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
      AND e.source_unit_id=NEW.container_unit_id AND e.target_unit_id=NEW.shipment_unit_id
      AND e.relationship_type='SHIPPED_AS' AND e.quantity=NEW.quantity
  ) THEN
    RAISE EXCEPTION 'shipment dispatch requires a matching SHIPPED_AS genealogy edge'
      USING ERRCODE = '23514';
  END IF;
  WITH RECURSIVE tree(unit_id, edge_quantity, path) AS (
    SELECT pc.source_unit_id, pc.quantity, ARRAY[pc.container_unit_id, pc.source_unit_id]::uuid[]
    FROM wms_packing_contents pc
    WHERE pc.tenant_id=NEW.tenant_id AND pc.factory_id=NEW.factory_id AND pc.container_unit_id=NEW.container_unit_id
    UNION ALL
    SELECT pc.source_unit_id, pc.quantity, t.path || pc.source_unit_id
    FROM tree t JOIN wms_packing_contents pc ON pc.container_unit_id=t.unit_id
      AND pc.tenant_id=NEW.tenant_id AND pc.factory_id=NEW.factory_id
    WHERE NOT pc.source_unit_id = ANY(t.path)
  ), leaves AS (
    SELECT t.unit_id, sum(t.edge_quantity)::numeric(18,4) AS quantity
    FROM tree t
    WHERE NOT EXISTS (SELECT 1 FROM wms_packing_containers c
      WHERE c.tenant_id=NEW.tenant_id AND c.factory_id=NEW.factory_id AND c.container_unit_id=t.unit_id)
    GROUP BY t.unit_id
  )
  SELECT COALESCE(sum(l.quantity),0)::numeric(18,4), count(*)::integer,
    COALESCE(bool_and(u.unit_type='LOT' AND u.product_role='FINISHED_GOOD'
      AND u.inventory_item_id=NEW.item_id AND u.unit=NEW.unit AND u.status='ACTIVE'), FALSE)
  INTO v_leaf_quantity, v_leaf_count, v_valid_leaves
  FROM leaves l LEFT JOIN traceability_units u
    ON u.id=l.unit_id AND u.tenant_id=NEW.tenant_id AND u.factory_id=NEW.factory_id;
  IF v_leaf_count = 0 OR v_leaf_quantity IS DISTINCT FROM NEW.quantity OR NOT v_valid_leaves THEN
    RAISE EXCEPTION 'shipment quantity must equal its same-item finished-good lot genealogy leaves'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wms_shipment_dispatch_guard ON wms_shipments;
CREATE TRIGGER trg_wms_shipment_dispatch_guard
BEFORE INSERT ON wms_shipments
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_wms_shipment_insert();

CREATE OR REPLACE FUNCTION factoryos_prevent_wms_shipment_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shipment dispatch records are append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS trg_wms_shipment_immutable ON wms_shipments;
CREATE TRIGGER trg_wms_shipment_immutable
BEFORE UPDATE OR DELETE ON wms_shipments
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_wms_shipment_mutation();

CREATE OR REPLACE FUNCTION factoryos_assert_wms_shipment_dispatch_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM wms_packing_containers c
    WHERE c.tenant_id=NEW.tenant_id AND c.factory_id=NEW.factory_id
      AND c.container_unit_id=NEW.container_unit_id AND c.status='DISPATCHED'
  ) OR EXISTS (
    SELECT 1
    FROM wms_packing_contents pc
    JOIN wms_packing_containers nested
      ON nested.container_unit_id=pc.source_container_unit_id
     AND nested.tenant_id=pc.tenant_id AND nested.factory_id=pc.factory_id
    JOIN traceability_units nested_unit
      ON nested_unit.id=nested.container_unit_id
     AND nested_unit.tenant_id=nested.tenant_id AND nested_unit.factory_id=nested.factory_id
    WHERE pc.tenant_id=NEW.tenant_id AND pc.factory_id=NEW.factory_id
      AND pc.container_unit_id=NEW.container_unit_id
      AND pc.source_container_unit_id IS NOT NULL
      AND (
        nested.status <> 'DISPATCHED'
        OR nested_unit.status <> 'SHIPPED'
        OR NOT EXISTS (
          SELECT 1 FROM traceability_unit_status_events status_event
          WHERE status_event.tenant_id=NEW.tenant_id AND status_event.factory_id=NEW.factory_id
            AND status_event.unit_id=nested.container_unit_id AND status_event.to_status='SHIPPED'
        )
      )
  ) OR NOT EXISTS (
    SELECT 1 FROM traceability_units u
    WHERE u.tenant_id=NEW.tenant_id AND u.factory_id=NEW.factory_id
      AND u.id=NEW.shipment_unit_id AND u.status='SHIPPED'
  ) OR NOT EXISTS (
    SELECT 1 FROM traceability_unit_status_events e
    WHERE e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
      AND e.unit_id=NEW.shipment_unit_id AND e.to_status='SHIPPED'
  ) OR NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
      AND a.resource_type='WMS_SHIPMENT' AND a.resource_id=NEW.shipment_unit_id AND a.action='DISPATCHED'
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id=NEW.tenant_id AND o.factory_id=NEW.factory_id
      AND o.aggregate_type='WMS_SHIPMENT' AND o.aggregate_id=NEW.shipment_unit_id
      AND o.event_type='WMS.SHIPMENT_DISPATCHED'
  ) THEN
    RAISE EXCEPTION 'shipment must commit with container status, traceability status history, audit and outbox evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS ctr_wms_shipment_dispatch_evidence ON wms_shipments;
CREATE CONSTRAINT TRIGGER ctr_wms_shipment_dispatch_evidence
AFTER INSERT ON wms_shipments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_wms_shipment_dispatch_evidence();

INSERT INTO schema_migrations(version, checksum)
VALUES ('201_wms_carton_pallet_shipment_traceability', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
