BEGIN;

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS sector_code VARCHAR(64);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_items_sector_code'
      AND conrelid = 'inventory_items'::regclass
  ) THEN
    ALTER TABLE inventory_items
      ADD CONSTRAINT chk_inventory_items_sector_code
      CHECK (sector_code IS NULL OR (length(btrim(sector_code)) > 0 AND length(sector_code) <= 64));
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS inventory_material_allocation_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  policy_scope VARCHAR(12) NOT NULL,
  sector_code VARCHAR(64),
  inventory_item_id UUID,
  allocation_policy VARCHAR(12) NOT NULL,
  require_traceability BOOLEAN NOT NULL DEFAULT TRUE,
  version BIGINT NOT NULL DEFAULT 1,
  created_by_user_id UUID,
  updated_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_inventory_material_allocation_policy_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_inventory_material_allocation_policy_factory
    FOREIGN KEY (factory_id, tenant_id) REFERENCES factories (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_material_allocation_policy_item
    FOREIGN KEY (inventory_item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_material_allocation_policy_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_material_allocation_policy_updater
    FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_material_allocation_policy_scope
    CHECK (
      (policy_scope = 'FACTORY' AND sector_code IS NULL AND inventory_item_id IS NULL)
      OR (policy_scope = 'SECTOR' AND sector_code IS NOT NULL AND length(btrim(sector_code)) > 0 AND inventory_item_id IS NULL)
      OR (policy_scope = 'MATERIAL' AND inventory_item_id IS NOT NULL AND sector_code IS NULL)
    ),
  CONSTRAINT chk_inventory_material_allocation_policy_name
    CHECK (allocation_policy IN ('FIFO', 'FEFO', 'LOT', 'SERIAL')),
  CONSTRAINT chk_inventory_material_allocation_policy_version CHECK (version > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_material_allocation_policy_factory
  ON inventory_material_allocation_policies (tenant_id, factory_id)
  WHERE policy_scope = 'FACTORY';
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_material_allocation_policy_sector
  ON inventory_material_allocation_policies (tenant_id, factory_id, lower(sector_code))
  WHERE policy_scope = 'SECTOR';
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_material_allocation_policy_material
  ON inventory_material_allocation_policies (tenant_id, factory_id, inventory_item_id)
  WHERE policy_scope = 'MATERIAL';
CREATE INDEX IF NOT EXISTS idx_inventory_material_allocation_policy_lookup
  ON inventory_material_allocation_policies (tenant_id, factory_id, policy_scope, allocation_policy);
ALTER TABLE inventory_material_allocation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_material_allocation_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_material_allocation_policies_tenant_isolation ON inventory_material_allocation_policies;
CREATE POLICY inventory_material_allocation_policies_tenant_isolation
  ON inventory_material_allocation_policies
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

-- WMS allocation enforcement: reservation conservation, physical lot/bin balances,
-- immutable lot consumption evidence, and FEFO/FIFO/LOT/SERIAL policy enforcement.
ALTER TABLE inventory_reservations
  ADD COLUMN IF NOT EXISTS remaining_quantity NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS consumed_quantity NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS released_quantity NUMERIC(18,4);

UPDATE inventory_reservations
SET remaining_quantity = CASE WHEN status = 'RESERVED' THEN quantity ELSE 0 END,
    consumed_quantity = CASE WHEN status = 'CONSUMED' THEN quantity ELSE 0 END,
    released_quantity = CASE WHEN status = 'RELEASED' THEN quantity ELSE 0 END
WHERE remaining_quantity IS NULL OR consumed_quantity IS NULL OR released_quantity IS NULL;

ALTER TABLE inventory_reservations
  ALTER COLUMN remaining_quantity SET DEFAULT 0,
  ALTER COLUMN remaining_quantity SET NOT NULL,
  ALTER COLUMN consumed_quantity SET DEFAULT 0,
  ALTER COLUMN consumed_quantity SET NOT NULL,
  ALTER COLUMN released_quantity SET DEFAULT 0,
  ALTER COLUMN released_quantity SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_reservation_id_item_scope
  ON inventory_reservations (id, tenant_id, factory_id, item_id);

ALTER TABLE inventory_reservations
  DROP CONSTRAINT IF EXISTS chk_inventory_reservation_transition,
  DROP CONSTRAINT IF EXISTS chk_inventory_reservation_quantity_conservation;

ALTER TABLE inventory_reservations
  ADD CONSTRAINT chk_inventory_reservation_quantity_conservation
    CHECK (
      remaining_quantity >= 0
      AND consumed_quantity >= 0
      AND released_quantity >= 0
      AND remaining_quantity + consumed_quantity + released_quantity = quantity
    ),
  ADD CONSTRAINT chk_inventory_reservation_transition
    CHECK (
      (
        status = 'RESERVED'
        AND remaining_quantity > 0
        AND consumed_movement_id IS NULL
        AND (
          (transition_idempotency_key IS NULL AND transition_request_hash IS NULL)
          OR
          (length(btrim(transition_idempotency_key)) > 0
            AND transition_request_hash ~ '^[a-f0-9]{64}$')
        )
      )
      OR
      (
        status = 'RELEASED'
        AND remaining_quantity = 0
        AND consumed_quantity + released_quantity = quantity
        AND released_quantity > 0
        AND transition_idempotency_key IS NOT NULL
        AND length(btrim(transition_idempotency_key)) > 0
        AND transition_request_hash ~ '^[a-f0-9]{64}$'
        AND consumed_movement_id IS NULL
      )
      OR
      (
        status = 'CONSUMED'
        AND remaining_quantity = 0
        AND consumed_quantity = quantity
        AND released_quantity = 0
        AND transition_idempotency_key IS NOT NULL
        AND length(btrim(transition_idempotency_key)) > 0
        AND transition_request_hash ~ '^[a-f0-9]{64}$'
        AND consumed_movement_id IS NOT NULL
      )
    );

-- Factory, sector and material overrides are stored in inventory_material_allocation_policies above.
CREATE TABLE IF NOT EXISTS inventory_reservation_consumptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  item_id UUID NOT NULL,
  location_id UUID,
  quantity NUMERIC(18,4) NOT NULL,
  movement_id UUID NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_inventory_reservation_consumption_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_inventory_reservation_consumption_idempotency
    UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_inventory_reservation_consumption_reservation
    FOREIGN KEY (reservation_id, tenant_id, factory_id, item_id)
    REFERENCES inventory_reservations (id, tenant_id, factory_id, item_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumption_movement
    FOREIGN KEY (movement_id, tenant_id, factory_id)
    REFERENCES inventory_movements (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumption_location
    FOREIGN KEY (location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumption_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_reservation_consumption_quantity CHECK (quantity > 0),
  CONSTRAINT chk_inventory_reservation_consumption_hash CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_inventory_reservation_consumption_key CHECK (length(btrim(idempotency_key)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_inventory_reservation_consumption_reservation
  ON inventory_reservation_consumptions (tenant_id, factory_id, reservation_id, created_at, id);

-- The physical stock assigned to a material identity is now location-aware. The
-- existing item/location ledger remains authoritative for total stock.
CREATE TABLE IF NOT EXISTS inventory_traceability_location_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  traceability_unit_id UUID NOT NULL,
  location_id UUID NOT NULL,
  quantity_on_hand NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_reserved NUMERIC(18,4) NOT NULL DEFAULT 0,
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_inventory_traceability_location_balance
    UNIQUE (tenant_id, factory_id, item_id, traceability_unit_id, location_id),
  CONSTRAINT fk_inventory_traceability_location_balance_item
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_traceability_location_balance_unit
    FOREIGN KEY (traceability_unit_id, tenant_id, factory_id, item_id)
    REFERENCES traceability_units (id, tenant_id, factory_id, inventory_item_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_traceability_location_balance_location
    FOREIGN KEY (location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_traceability_location_balance_quantities
    CHECK (quantity_on_hand >= 0 AND quantity_reserved >= 0 AND quantity_reserved <= quantity_on_hand),
  CONSTRAINT chk_inventory_traceability_location_balance_version CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS idx_inventory_traceability_location_candidates
  ON inventory_traceability_location_balances (tenant_id, factory_id, item_id, location_id, traceability_unit_id);

CREATE TABLE IF NOT EXISTS inventory_reservation_traceability_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  item_id UUID NOT NULL,
  traceability_unit_id UUID NOT NULL,
  location_id UUID NOT NULL,
  allocation_sequence INTEGER NOT NULL DEFAULT 1,
  allocated_quantity NUMERIC(18,4) NOT NULL,
  consumed_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  released_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_inventory_reservation_traceability_allocation
    UNIQUE (tenant_id, factory_id, reservation_id, traceability_unit_id, location_id),
  CONSTRAINT fk_inventory_reservation_traceability_allocation_reservation
    FOREIGN KEY (reservation_id, tenant_id, factory_id, item_id)
    REFERENCES inventory_reservations (id, tenant_id, factory_id, item_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_traceability_allocation_unit
    FOREIGN KEY (traceability_unit_id, tenant_id, factory_id, item_id)
    REFERENCES traceability_units (id, tenant_id, factory_id, inventory_item_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_traceability_allocation_location
    FOREIGN KEY (location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_reservation_traceability_allocation_sequence CHECK (allocation_sequence > 0),
  CONSTRAINT chk_inventory_reservation_traceability_allocation_quantities
    CHECK (
      allocated_quantity > 0
      AND consumed_quantity >= 0
      AND released_quantity >= 0
      AND consumed_quantity + released_quantity <= allocated_quantity
    )
);

-- Keep policy order stable through issue/release; this is also safe on migration re-apply.
ALTER TABLE inventory_reservation_traceability_allocations
  ADD COLUMN IF NOT EXISTS allocation_sequence INTEGER;
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY tenant_id, factory_id, reservation_id ORDER BY created_at, id
  )::integer AS sequence_number
  FROM inventory_reservation_traceability_allocations
  WHERE allocation_sequence IS NULL
)
UPDATE inventory_reservation_traceability_allocations a
SET allocation_sequence = ranked.sequence_number
FROM ranked
WHERE a.id = ranked.id;
ALTER TABLE inventory_reservation_traceability_allocations
  ALTER COLUMN allocation_sequence SET DEFAULT 1,
  ALTER COLUMN allocation_sequence SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_reservation_traceability_sequence
  ON inventory_reservation_traceability_allocations (tenant_id, factory_id, reservation_id, allocation_sequence);

CREATE INDEX IF NOT EXISTS idx_inventory_reservation_traceability_remaining
  ON inventory_reservation_traceability_allocations (tenant_id, factory_id, reservation_id, traceability_unit_id);

CREATE TABLE IF NOT EXISTS inventory_reservation_consumption_traceability_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  consumption_id UUID NOT NULL,
  traceability_unit_id UUID NOT NULL,
  location_id UUID NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_inventory_reservation_consumption_traceability_consumption
    FOREIGN KEY (consumption_id, tenant_id, factory_id)
    REFERENCES inventory_reservation_consumptions (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumption_traceability_unit
    FOREIGN KEY (traceability_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_reservation_consumption_traceability_location
    FOREIGN KEY (location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_reservation_consumption_traceability_quantity CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_inventory_reservation_consumption_traceability
  ON inventory_reservation_consumption_traceability_allocations (tenant_id, factory_id, consumption_id, traceability_unit_id);

ALTER TABLE inventory_location_transfers
  ADD COLUMN IF NOT EXISTS traceability_unit_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_inventory_location_transfer_traceability_unit'
      AND conrelid = 'inventory_location_transfers'::regclass
  ) THEN
    ALTER TABLE inventory_location_transfers
      ADD CONSTRAINT fk_inventory_location_transfer_traceability_unit
      FOREIGN KEY (traceability_unit_id, tenant_id, factory_id, item_id)
      REFERENCES traceability_units (id, tenant_id, factory_id, inventory_item_id) ON DELETE RESTRICT;
  END IF;
END;
$$;

-- Seed traceable material units into the factory's UNASSIGNED bucket. The seed is
-- bounded by actual posted stock and never fabricates inventory to satisfy a lot.
CREATE OR REPLACE FUNCTION factoryos_seed_inventory_traceability_location_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_location_id UUID;
  v_location_quantity NUMERIC(18,4);
  v_tracked_quantity NUMERIC(18,4);
  v_bind_quantity NUMERIC(18,4);
BEGIN
  IF NEW.inventory_item_id IS NULL
     OR NEW.product_role <> 'MATERIAL'
     OR NEW.unit_type NOT IN ('LOT', 'SERIAL')
     OR NEW.status IN ('SHIPPED', 'DISPOSED') THEN
    RETURN NEW;
  END IF;

  SELECT l.id INTO v_location_id
  FROM inventory_locations l
  WHERE l.tenant_id = NEW.tenant_id
    AND l.factory_id = NEW.factory_id
    AND l.is_default = TRUE
    AND l.location_type = 'VIRTUAL'
    AND l.status = 'ACTIVE'
  FOR UPDATE;

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'material lot/serial registration requires the factory UNASSIGNED stock bucket'
      USING ERRCODE = '23514';
  END IF;

  SELECT lb.quantity_on_hand INTO v_location_quantity
  FROM inventory_location_balances lb
  WHERE lb.tenant_id = NEW.tenant_id
    AND lb.factory_id = NEW.factory_id
    AND lb.item_id = NEW.inventory_item_id
    AND lb.location_id = v_location_id
  FOR UPDATE;

  SELECT COALESCE(SUM(tlb.quantity_on_hand), 0)
    INTO v_tracked_quantity
  FROM inventory_traceability_location_balances tlb
  WHERE tlb.tenant_id = NEW.tenant_id
    AND tlb.factory_id = NEW.factory_id
    AND tlb.item_id = NEW.inventory_item_id
    AND tlb.location_id = v_location_id;

  -- Registering genealogy identity must not invent stock or fail merely because
  -- the identity is not currently bound to available physical quantity. Bind only
  -- the quantity actually available in UNASSIGNED; the remainder cannot be reserved
  -- until a receipt/transfer establishes traceable physical stock.
  v_bind_quantity := LEAST(
    NEW.quantity,
    GREATEST(COALESCE(v_location_quantity, 0) - COALESCE(v_tracked_quantity, 0), 0)
  );

  INSERT INTO inventory_traceability_location_balances (
    tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand
  )
  VALUES (
    NEW.tenant_id, NEW.factory_id, NEW.inventory_item_id, NEW.id, v_location_id, v_bind_quantity
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS traceability_unit_seed_inventory_location_balance ON traceability_units;
CREATE TRIGGER traceability_unit_seed_inventory_location_balance
AFTER INSERT ON traceability_units
FOR EACH ROW EXECUTE FUNCTION factoryos_seed_inventory_traceability_location_balance();

-- Backfill already-registered, unsold material identities to UNASSIGNED. If older
-- untracked issues consumed some stock, never assign more identities than stock left.
WITH candidates AS (
  SELECT
    tu.id AS unit_id,
    tu.tenant_id,
    tu.factory_id,
    tu.inventory_item_id AS item_id,
    l.id AS location_id,
    GREATEST(
      tu.quantity - COALESCE((
        SELECT SUM(g.quantity)
        FROM product_genealogy_events g
        WHERE g.tenant_id = tu.tenant_id
          AND g.factory_id = tu.factory_id
          AND g.source_unit_id = tu.id
          AND g.relationship_type IN ('CONSUMED_INTO', 'PROCESSED_INTO')
      ), 0),
      0
    )::numeric(18,4) AS requested_quantity,
    lb.quantity_on_hand
      - COALESCE((
        SELECT SUM(tlb.quantity_on_hand)
        FROM inventory_traceability_location_balances tlb
        WHERE tlb.tenant_id = tu.tenant_id
          AND tlb.factory_id = tu.factory_id
          AND tlb.item_id = tu.inventory_item_id
          AND tlb.location_id = l.id
      ), 0) AS location_capacity,
    SUM(GREATEST(
      tu.quantity - COALESCE((
        SELECT SUM(g.quantity)
        FROM product_genealogy_events g
        WHERE g.tenant_id = tu.tenant_id
          AND g.factory_id = tu.factory_id
          AND g.source_unit_id = tu.id
          AND g.relationship_type IN ('CONSUMED_INTO', 'PROCESSED_INTO')
      ), 0),
      0
    )) OVER (
      PARTITION BY tu.tenant_id, tu.factory_id, tu.inventory_item_id
      ORDER BY tu.created_at, tu.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS prior_requested_quantity
  FROM traceability_units tu
  JOIN inventory_locations l
    ON l.tenant_id = tu.tenant_id AND l.factory_id = tu.factory_id
   AND l.is_default = TRUE AND l.location_type = 'VIRTUAL' AND l.status = 'ACTIVE'
  JOIN inventory_location_balances lb
    ON lb.tenant_id = tu.tenant_id AND lb.factory_id = tu.factory_id
   AND lb.item_id = tu.inventory_item_id AND lb.location_id = l.id
  WHERE tu.inventory_item_id IS NOT NULL
    AND tu.product_role = 'MATERIAL'
    AND tu.unit_type IN ('LOT', 'SERIAL')
    AND tu.status NOT IN ('SHIPPED', 'DISPOSED')
    AND NOT EXISTS (
      SELECT 1 FROM inventory_traceability_location_balances present
      WHERE present.tenant_id = tu.tenant_id AND present.factory_id = tu.factory_id
        AND present.traceability_unit_id = tu.id
    )
), bounded AS (
  SELECT *,
    LEAST(
      requested_quantity,
      GREATEST(location_capacity - COALESCE(prior_requested_quantity, 0), 0)
    )::numeric(18,4) AS initial_quantity
  FROM candidates
)
INSERT INTO inventory_traceability_location_balances (
  tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand
)
SELECT tenant_id, factory_id, item_id, unit_id, location_id, initial_quantity
FROM bounded
WHERE initial_quantity > 0
ON CONFLICT (tenant_id, factory_id, item_id, traceability_unit_id, location_id) DO NOTHING;

-- Every stock consumer shares the same reservation/stock invariant. A partial
-- issue keeps the reservation RESERVED but reserves only its remaining quantity.
CREATE OR REPLACE FUNCTION factoryos_initialize_inventory_reservation_quantities()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'RESERVED'
     AND NEW.remaining_quantity = 0
     AND NEW.consumed_quantity = 0
     AND NEW.released_quantity = 0 THEN
    NEW.remaining_quantity := NEW.quantity;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_reservation_initialize_quantities ON inventory_reservations;
CREATE TRIGGER inventory_reservation_initialize_quantities
BEFORE INSERT ON inventory_reservations
FOR EACH ROW EXECUTE FUNCTION factoryos_initialize_inventory_reservation_quantities();

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_reservation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory reservations cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'RESERVED'
     OR NEW.status NOT IN ('RESERVED', 'RELEASED', 'CONSUMED') THEN
    RAISE EXCEPTION 'inventory reservation only supports partial issue while reserved and terminal release/consume transitions'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW.id, NEW.tenant_id, NEW.factory_id, NEW.item_id, NEW.quantity,
    NEW.idempotency_key, NEW.request_hash, NEW.reference_type, NEW.reference_id,
    NEW.notes, NEW.created_by_user_id, NEW.correlation_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.factory_id, OLD.item_id, OLD.quantity,
    OLD.idempotency_key, OLD.request_hash, OLD.reference_type, OLD.reference_id,
    OLD.notes, OLD.created_by_user_id, OLD.correlation_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'inventory reservation request binding is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.consumed_quantity < OLD.consumed_quantity
     OR NEW.released_quantity < OLD.released_quantity
     OR NEW.remaining_quantity > OLD.remaining_quantity
     OR NEW.remaining_quantity + NEW.consumed_quantity + NEW.released_quantity <> NEW.quantity
     OR NEW.remaining_quantity < 0
     OR NEW.consumed_quantity < 0
     OR NEW.released_quantity < 0 THEN
    RAISE EXCEPTION 'reservation issue/release quantities must be monotonic and conserve the original quantity'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.transition_idempotency_key IS NULL
     OR length(btrim(NEW.transition_idempotency_key)) = 0
     OR NEW.transition_request_hash IS NULL
     OR NEW.transition_request_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'inventory reservation transition requires an idempotency key and request hash'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'RESERVED' THEN
    IF NEW.remaining_quantity <= 0 OR NEW.consumed_movement_id IS NOT NULL THEN
      RAISE EXCEPTION 'an active reservation must retain reserved quantity and cannot claim a terminal movement'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'CONSUMED' THEN
    IF NEW.remaining_quantity <> 0
       OR NEW.consumed_quantity <> NEW.quantity
       OR NEW.released_quantity <> 0
       OR NEW.consumed_movement_id IS NULL THEN
      RAISE EXCEPTION 'a consumed reservation must be fully consumed with a matching issue movement'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'RELEASED' THEN
    IF NEW.remaining_quantity <> 0
       OR NEW.consumed_quantity + NEW.released_quantity <> NEW.quantity
       OR NEW.released_quantity <= 0
       OR NEW.consumed_movement_id IS NOT NULL THEN
      RAISE EXCEPTION 'a released reservation must account for all remaining quantity without a terminal movement reference'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Partial/full issues are recorded separately, so a repeated old idempotency key
-- remains replayable after later issues update the reservation row.
CREATE OR REPLACE FUNCTION factoryos_prevent_inventory_reservation_consumption_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'inventory reservation consumption evidence is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS inventory_reservation_consumption_append_only ON inventory_reservation_consumptions;
CREATE TRIGGER inventory_reservation_consumption_append_only
BEFORE UPDATE OR DELETE ON inventory_reservation_consumptions
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_inventory_reservation_consumption_mutation();

DROP TRIGGER IF EXISTS inventory_reservation_consumption_traceability_append_only ON inventory_reservation_consumption_traceability_allocations;
CREATE TRIGGER inventory_reservation_consumption_traceability_append_only
BEFORE UPDATE OR DELETE ON inventory_reservation_consumption_traceability_allocations
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_inventory_reservation_consumption_mutation();

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_reservation_traceability_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit_status VARCHAR(16);
  v_expires_at DATE;
  v_attributes JSONB;
  v_inventory_item_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reservation traceability allocations cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.id, NEW.tenant_id, NEW.factory_id, NEW.reservation_id, NEW.item_id,
      NEW.traceability_unit_id, NEW.location_id, NEW.allocation_sequence,
      NEW.allocated_quantity, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.tenant_id, OLD.factory_id, OLD.reservation_id, OLD.item_id,
      OLD.traceability_unit_id, OLD.location_id, OLD.allocation_sequence,
      OLD.allocated_quantity, OLD.created_at
    ) OR NEW.consumed_quantity < OLD.consumed_quantity
      OR NEW.released_quantity < OLD.released_quantity
      OR NEW.consumed_quantity + NEW.released_quantity > NEW.allocated_quantity THEN
      RAISE EXCEPTION 'traceability allocation identity and quantity are immutable; consumption/release only moves forward'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status, expires_at, attributes, inventory_item_id
    INTO v_unit_status, v_expires_at, v_attributes, v_inventory_item_id
  FROM traceability_units
  WHERE id = NEW.traceability_unit_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
    AND inventory_item_id = NEW.item_id
    AND product_role = 'MATERIAL'
    AND unit_type IN ('LOT', 'SERIAL')
  FOR SHARE;

  IF NOT FOUND OR v_unit_status <> 'ACTIVE'
     OR (v_expires_at IS NOT NULL AND v_expires_at < CURRENT_DATE)
     OR v_attributes @> '{"damaged":true}'::jsonb
     OR v_attributes @> '{"held":true}'::jsonb
     OR v_attributes @> '{"quarantined":true}'::jsonb
     OR upper(COALESCE(v_attributes->>'condition', '')) IN ('DAMAGED', 'HELD', 'QUARANTINED', 'EXPIRED') THEN
    RAISE EXCEPTION 'reservation allocation requires an active, unexpired, undamaged and unheld material lot/serial'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM quality_holds qh
    WHERE qh.tenant_id = NEW.tenant_id AND qh.factory_id = NEW.factory_id
      AND qh.status = 'ACTIVE'
      AND (qh.inventory_item_id = v_inventory_item_id OR qh.traceability_unit_id = NEW.traceability_unit_id)
  ) THEN
    RAISE EXCEPTION 'quality-held inventory cannot be reserved'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM inventory_traceability_location_balances tlb
    WHERE tlb.tenant_id = NEW.tenant_id AND tlb.factory_id = NEW.factory_id
      AND tlb.item_id = NEW.item_id AND tlb.traceability_unit_id = NEW.traceability_unit_id
      AND tlb.location_id = NEW.location_id
  ) THEN
    RAISE EXCEPTION 'traceability lot/serial does not have stock at the allocated bin'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_reservation_traceability_allocation_guard ON inventory_reservation_traceability_allocations;
CREATE TRIGGER inventory_reservation_traceability_allocation_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory_reservation_traceability_allocations
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_reservation_traceability_allocation();

-- The tracked-unit quantity may never exceed the item's actual bin on-hand or
-- reserved stock. Deferred evaluation permits a transfer/issue to update both
-- representations in one transaction.
CREATE OR REPLACE FUNCTION factoryos_assert_inventory_traceability_location_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id UUID;
  v_factory_id UUID;
  v_item_id UUID;
  v_location_id UUID;
  v_location_quantity NUMERIC(18,4);
  v_location_reserved NUMERIC(18,4);
  v_tracked_quantity NUMERIC(18,4);
  v_tracked_reserved NUMERIC(18,4);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant_id := OLD.tenant_id;
    v_factory_id := OLD.factory_id;
    v_item_id := OLD.item_id;
    v_location_id := OLD.location_id;
  ELSE
    v_tenant_id := NEW.tenant_id;
    v_factory_id := NEW.factory_id;
    v_item_id := NEW.item_id;
    v_location_id := NEW.location_id;
  END IF;

  SELECT quantity_on_hand, quantity_reserved
    INTO v_location_quantity, v_location_reserved
  FROM inventory_location_balances
  WHERE tenant_id = v_tenant_id AND factory_id = v_factory_id
    AND item_id = v_item_id AND location_id = v_location_id;

  SELECT COALESCE(SUM(quantity_on_hand), 0), COALESCE(SUM(quantity_reserved), 0)
    INTO v_tracked_quantity, v_tracked_reserved
  FROM inventory_traceability_location_balances
  WHERE tenant_id = v_tenant_id AND factory_id = v_factory_id
    AND item_id = v_item_id AND location_id = v_location_id;

  IF NOT FOUND THEN
    v_tracked_quantity := COALESCE(v_tracked_quantity, 0);
    v_tracked_reserved := COALESCE(v_tracked_reserved, 0);
  END IF;

  IF v_location_quantity IS NULL THEN
    IF v_tracked_quantity > 0 OR v_tracked_reserved > 0 THEN
      RAISE EXCEPTION 'traceable stock requires a matching item/location balance'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF v_tracked_quantity > v_location_quantity OR v_tracked_reserved > v_location_reserved THEN
    RAISE EXCEPTION
      'tracked lot/serial stock (%, reserved %) cannot exceed the location balance (%, reserved %)',
      v_tracked_quantity, v_tracked_reserved, v_location_quantity, v_location_reserved
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_inventory_traceability_location_capacity ON inventory_traceability_location_balances;
CREATE CONSTRAINT TRIGGER ctr_inventory_traceability_location_capacity
AFTER INSERT OR UPDATE OR DELETE ON inventory_traceability_location_balances
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_inventory_traceability_location_capacity();

DROP TRIGGER IF EXISTS ctr_inventory_location_traceability_capacity ON inventory_location_balances;
CREATE CONSTRAINT TRIGGER ctr_inventory_location_traceability_capacity
AFTER INSERT OR UPDATE OR DELETE ON inventory_location_balances
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_inventory_traceability_location_capacity();

CREATE OR REPLACE FUNCTION factoryos_assert_inventory_traceability_reserved_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id UUID;
  v_factory_id UUID;
  v_item_id UUID;
  v_traceability_unit_id UUID;
  v_location_id UUID;
  v_balance_reserved NUMERIC(18,4);
  v_allocation_reserved NUMERIC(18,4);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant_id := OLD.tenant_id;
    v_factory_id := OLD.factory_id;
    v_item_id := OLD.item_id;
    v_traceability_unit_id := OLD.traceability_unit_id;
    v_location_id := OLD.location_id;
  ELSE
    v_tenant_id := NEW.tenant_id;
    v_factory_id := NEW.factory_id;
    v_item_id := NEW.item_id;
    v_traceability_unit_id := NEW.traceability_unit_id;
    v_location_id := NEW.location_id;
  END IF;

  SELECT quantity_reserved INTO v_balance_reserved
  FROM inventory_traceability_location_balances
  WHERE tenant_id = v_tenant_id AND factory_id = v_factory_id AND item_id = v_item_id
    AND traceability_unit_id = v_traceability_unit_id AND location_id = v_location_id;

  SELECT COALESCE(SUM(allocated_quantity - consumed_quantity - released_quantity), 0)
    INTO v_allocation_reserved
  FROM inventory_reservation_traceability_allocations
  WHERE tenant_id = v_tenant_id AND factory_id = v_factory_id AND item_id = v_item_id
    AND traceability_unit_id = v_traceability_unit_id AND location_id = v_location_id;

  IF v_balance_reserved IS DISTINCT FROM v_allocation_reserved THEN
    RAISE EXCEPTION 'traceability location reserved quantity must equal its active reservation allocations'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_inventory_traceability_reserved_allocation_balance ON inventory_traceability_location_balances;
CREATE CONSTRAINT TRIGGER ctr_inventory_traceability_reserved_allocation_balance
AFTER INSERT OR UPDATE OR DELETE ON inventory_traceability_location_balances
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_inventory_traceability_reserved_allocation();

DROP TRIGGER IF EXISTS ctr_inventory_reservation_traceability_reserved_allocation_balance ON inventory_reservation_traceability_allocations;
CREATE CONSTRAINT TRIGGER ctr_inventory_reservation_traceability_reserved_allocation_balance
AFTER INSERT OR UPDATE OR DELETE ON inventory_reservation_traceability_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_inventory_traceability_reserved_allocation();

-- Reconcile tracked quantity against available unit quantities and current quality
-- status whenever the trace stock map is first installed or changed.
CREATE OR REPLACE FUNCTION factoryos_guard_inventory_traceability_location_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit_status VARCHAR(16);
  v_expiry DATE;
  v_unit_quantity NUMERIC(18,4);
  v_consumed_quantity NUMERIC(18,4);
  v_existing_total NUMERIC(18,4);
  v_item_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'traceability location balances cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  SELECT status, expires_at, quantity, inventory_item_id
    INTO v_unit_status, v_expiry, v_unit_quantity, v_item_id
  FROM traceability_units
  WHERE id = NEW.traceability_unit_id
    AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND inventory_item_id = NEW.item_id
  FOR SHARE;

  IF NOT FOUND OR v_item_id IS NULL OR NEW.quantity_on_hand < 0
     OR NEW.quantity_on_hand > v_unit_quantity THEN
    RAISE EXCEPTION 'traceability location balance exceeds or mismatches its registered material identity'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
     AND ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.item_id, NEW.traceability_unit_id, NEW.location_id)
         IS DISTINCT FROM
         ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.item_id, OLD.traceability_unit_id, OLD.location_id) THEN
    RAISE EXCEPTION 'traceability location balance identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(SUM(g.quantity), 0)
    INTO v_consumed_quantity
  FROM product_genealogy_events g
  WHERE g.tenant_id = NEW.tenant_id AND g.factory_id = NEW.factory_id
    AND g.source_unit_id = NEW.traceability_unit_id
    AND g.relationship_type IN ('CONSUMED_INTO', 'PROCESSED_INTO');

  SELECT COALESCE(SUM(tlb.quantity_on_hand), 0)
    INTO v_existing_total
  FROM inventory_traceability_location_balances tlb
  WHERE tlb.tenant_id = NEW.tenant_id AND tlb.factory_id = NEW.factory_id
    AND tlb.item_id = NEW.item_id AND tlb.traceability_unit_id = NEW.traceability_unit_id
    AND tlb.id <> NEW.id;

  IF v_existing_total + NEW.quantity_on_hand > GREATEST(v_unit_quantity - v_consumed_quantity, 0) THEN
    RAISE EXCEPTION
      'total tracked lot/serial quantity (%) cannot exceed registered unconsumed quantity (%)',
      v_existing_total + NEW.quantity_on_hand, GREATEST(v_unit_quantity - v_consumed_quantity, 0)
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_traceability_location_balance_guard ON inventory_traceability_location_balances;
CREATE TRIGGER inventory_traceability_location_balance_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory_traceability_location_balances
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_traceability_location_balance();

-- The order-line guard now counts remaining reservation quantity and cumulative
-- partial issues rather than treating an entire reservation as untouched until terminal.
CREATE OR REPLACE FUNCTION factoryos_assert_inventory_reservation_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance NUMERIC(18,4);
  v_active_reservations NUMERIC(18,4);
BEGIN
  SELECT quantity_reserved INTO v_balance
  FROM inventory_stock_balances
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id AND item_id = NEW.item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory reservation requires an inventory stock balance'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(remaining_quantity), 0) INTO v_active_reservations
  FROM inventory_reservations
  WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND item_id = NEW.item_id AND status = 'RESERVED';
  IF v_balance IS DISTINCT FROM v_active_reservations THEN
    RAISE EXCEPTION 'inventory stock reserved quantity must equal active reservation remaining total'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_assert_inventory_location_reserved_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id UUID;
  v_factory_id UUID;
  v_item_id UUID;
  v_location_id UUID;
  v_current_reserved NUMERIC(18,4);
  v_active_reservations NUMERIC(18,4);
  v_old_active_reservations NUMERIC(18,4);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant_id := OLD.tenant_id;
    v_factory_id := OLD.factory_id;
    v_item_id := OLD.item_id;
    v_location_id := OLD.location_id;
  ELSE
    v_tenant_id := NEW.tenant_id;
    v_factory_id := NEW.factory_id;
    v_item_id := NEW.item_id;
    v_location_id := NEW.location_id;
  END IF;

  SELECT COALESCE(SUM(r.remaining_quantity), 0)
    INTO v_active_reservations
  FROM inventory_reservations r
  WHERE r.tenant_id = v_tenant_id AND r.factory_id = v_factory_id
    AND r.item_id = v_item_id AND r.location_id = v_location_id
    AND r.status = 'RESERVED';

  IF TG_OP = 'DELETE' THEN
    IF v_active_reservations > 0 THEN
      RAISE EXCEPTION 'cannot delete a location balance with active bin reservations'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND ROW(NEW.tenant_id, NEW.factory_id, NEW.item_id, NEW.location_id)
         IS DISTINCT FROM
         ROW(OLD.tenant_id, OLD.factory_id, OLD.item_id, OLD.location_id) THEN
    SELECT COALESCE(SUM(r.remaining_quantity), 0)
      INTO v_old_active_reservations
    FROM inventory_reservations r
    WHERE r.tenant_id = OLD.tenant_id AND r.factory_id = OLD.factory_id
      AND r.item_id = OLD.item_id AND r.location_id = OLD.location_id
      AND r.status = 'RESERVED';
    IF v_old_active_reservations > 0 THEN
      RAISE EXCEPTION 'cannot rebind a location balance with active bin reservations'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT lb.quantity_reserved INTO v_current_reserved
  FROM inventory_location_balances lb
  WHERE lb.tenant_id = v_tenant_id AND lb.factory_id = v_factory_id
    AND lb.item_id = v_item_id AND lb.location_id = v_location_id;

  IF NOT FOUND THEN
    IF v_active_reservations > 0 THEN
      RAISE EXCEPTION 'active bin reservations require a persisted location balance'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF v_current_reserved IS DISTINCT FROM v_active_reservations THEN
    RAISE EXCEPTION 'location reserved quantity (%) must equal reservation remaining total (%)',
      v_current_reserved, v_active_reservations USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

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
    v_order_id := NEW.id; v_tenant_id := NEW.tenant_id; v_factory_id := NEW.factory_id;
  ELSE
    IF NEW.reference_type IS DISTINCT FROM 'ORDER_LINE' OR NEW.reference_id IS NULL THEN RETURN NULL; END IF;
    v_tenant_id := NEW.tenant_id; v_factory_id := NEW.factory_id;
    SELECT ol.order_id INTO v_order_id
    FROM order_lines ol
    WHERE ol.id = NEW.reference_id AND ol.tenant_id = NEW.tenant_id
      AND ol.factory_id = NEW.factory_id AND ol.inventory_item_id = NEW.item_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'order-line reservation must reference a line bound to the same item and factory'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  FOR v_line IN
    SELECT ol.id AS line_id, ol.quantity AS requested_quantity, o.status AS order_status,
      COALESCE(SUM(r.remaining_quantity) FILTER (WHERE r.status = 'RESERVED'), 0) AS reserved_quantity,
      COALESCE(SUM(r.consumed_quantity), 0) AS consumed_quantity,
      COUNT(r.id) FILTER (WHERE r.status = 'RESERVED' AND r.location_id IS NULL) AS unallocated_reservation_count,
      COUNT(r.id) FILTER (WHERE r.status = 'RESERVED' AND r.location_id IS NOT NULL) AS bin_reservation_count
    FROM orders o
    JOIN order_lines ol ON ol.order_id = o.id AND ol.tenant_id = o.tenant_id AND ol.factory_id = o.factory_id
    LEFT JOIN inventory_reservations r
      ON r.tenant_id = ol.tenant_id AND r.factory_id = ol.factory_id
     AND r.item_id = ol.inventory_item_id AND r.reference_type = 'ORDER_LINE' AND r.reference_id = ol.id
    WHERE o.id = v_order_id AND o.tenant_id = v_tenant_id AND o.factory_id = v_factory_id
      AND ol.inventory_item_id IS NOT NULL
    GROUP BY ol.id, ol.quantity, o.status
  LOOP
    IF v_line.order_status = 'CONFIRMED' THEN
      IF v_line.reserved_quantity <> v_line.requested_quantity OR v_line.consumed_quantity <> 0 THEN
        RAISE EXCEPTION 'confirmed order line % must have exactly % reserved units (reserved %, consumed %)',
          v_line.line_id, v_line.requested_quantity, v_line.reserved_quantity, v_line.consumed_quantity
          USING ERRCODE = '23514';
      END IF;
      IF v_line.unallocated_reservation_count > 0 AND v_line.bin_reservation_count > 0 THEN
        RAISE EXCEPTION 'confirmed order line % cannot mix unallocated and bin-bound reservations', v_line.line_id
          USING ERRCODE = '23514';
      END IF;
    ELSIF v_line.order_status IN ('IN_PROGRESS', 'COMPLETED') THEN
      IF v_line.consumed_quantity <> v_line.requested_quantity OR v_line.reserved_quantity <> 0 THEN
        RAISE EXCEPTION 'in-progress/completed order line % must have exactly % consumed units (consumed %, reserved %)',
          v_line.line_id, v_line.requested_quantity, v_line.consumed_quantity, v_line.reserved_quantity
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- A location transfer carries an explicit lot/serial identity when tracked stock
-- moves. Deferred capacity guards prevent unlabelled stock movements from stealing
-- quantity already assigned to known material identities.
CREATE OR REPLACE FUNCTION factoryos_guard_inventory_location_transfer_traceability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status VARCHAR(16);
  v_expiry DATE;
  v_attributes JSONB;
  v_item_id UUID;
  v_policy VARCHAR(12);
  v_require_traceability BOOLEAN;
  v_has_material_identity BOOLEAN;
BEGIN
  SELECT COALESCE(
      (SELECT p.allocation_policy FROM inventory_material_allocation_policies p
       WHERE p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id
         AND p.policy_scope='MATERIAL' AND p.inventory_item_id=NEW.item_id),
      (SELECT p.allocation_policy FROM inventory_material_allocation_policies p
       JOIN inventory_items i ON i.id=NEW.item_id AND i.tenant_id=p.tenant_id AND i.factory_id=p.factory_id
       WHERE p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id
         AND p.policy_scope='SECTOR' AND lower(p.sector_code)=lower(i.sector_code)),
      (SELECT p.allocation_policy FROM inventory_material_allocation_policies p
       WHERE p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id AND p.policy_scope='FACTORY'),
      (SELECT ts.allocation_policy FROM traceability_settings ts
       WHERE ts.tenant_id=NEW.tenant_id AND ts.factory_id=NEW.factory_id),
      'FIFO'
    ),
    COALESCE(
      (SELECT p.require_traceability FROM inventory_material_allocation_policies p
       WHERE p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id
         AND p.policy_scope='MATERIAL' AND p.inventory_item_id=NEW.item_id),
      (SELECT p.require_traceability FROM inventory_material_allocation_policies p
       JOIN inventory_items i ON i.id=NEW.item_id AND i.tenant_id=p.tenant_id AND i.factory_id=p.factory_id
       WHERE p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id
         AND p.policy_scope='SECTOR' AND lower(p.sector_code)=lower(i.sector_code)),
      (SELECT p.require_traceability FROM inventory_material_allocation_policies p
       WHERE p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id AND p.policy_scope='FACTORY'),
      FALSE
    ),
    EXISTS (
      SELECT 1 FROM traceability_units existing
      WHERE existing.tenant_id=NEW.tenant_id AND existing.factory_id=NEW.factory_id
        AND existing.inventory_item_id=NEW.item_id
        AND existing.product_role='MATERIAL' AND existing.unit_type IN ('LOT','SERIAL')
    )
  INTO v_policy, v_require_traceability, v_has_material_identity;

  IF NEW.traceability_unit_id IS NULL THEN
    IF v_require_traceability OR v_policy IN ('LOT','SERIAL') OR v_has_material_identity THEN
      RAISE EXCEPTION 'material policy requires an explicit lot/serial identity for directed stock transfer'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status, expires_at, attributes, inventory_item_id
    INTO v_status, v_expiry, v_attributes, v_item_id
  FROM traceability_units
  WHERE id = NEW.traceability_unit_id
    AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND inventory_item_id = NEW.item_id
    AND product_role = 'MATERIAL' AND unit_type IN ('LOT','SERIAL')
  FOR SHARE;

  IF NOT FOUND OR v_status <> 'ACTIVE'
     OR (v_expiry IS NOT NULL AND v_expiry < CURRENT_DATE)
     OR v_attributes @> '{"damaged":true}'::jsonb
     OR v_attributes @> '{"held":true}'::jsonb
     OR v_attributes @> '{"quarantined":true}'::jsonb
     OR upper(COALESCE(v_attributes->>'condition', '')) IN ('DAMAGED','HELD','QUARANTINED','EXPIRED')
     OR EXISTS (
       SELECT 1 FROM quality_holds qh
       WHERE qh.tenant_id = NEW.tenant_id AND qh.factory_id = NEW.factory_id AND qh.status = 'ACTIVE'
         AND (qh.inventory_item_id = v_item_id OR qh.traceability_unit_id = NEW.traceability_unit_id)
     ) THEN
    RAISE EXCEPTION 'put-away/picking cannot move expired, damaged, quarantined, recalled or held material'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_location_transfer_traceability_guard ON inventory_location_transfers;
CREATE TRIGGER inventory_location_transfer_traceability_guard
BEFORE INSERT ON inventory_location_transfers
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_location_transfer_traceability();

-- All new tables inherit the existing factory-only row-level tenant boundary.
DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'inventory_reservation_consumptions',
    'inventory_traceability_location_balances',
    'inventory_reservation_traceability_allocations',
    'inventory_reservation_consumption_traceability_allocations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', v_table || '_tenant_isolation', v_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id())',
      v_table || '_tenant_isolation', v_table
    );
  END LOOP;
END;
$$;

COMMENT ON TABLE inventory_traceability_location_balances IS
  'On-hand and reserved stock by active material lot/serial and physical location; bounded by the item/location ledger.';
COMMENT ON TABLE inventory_reservation_traceability_allocations IS
  'Immutable identity/location binding for reservation quantities; consumed and released quantities advance monotonically.';
COMMENT ON TABLE inventory_reservation_consumptions IS
  'Idempotent partial or full issue records for reservation consumption, preserving every retry key and movement link.';
COMMENT ON COLUMN inventory_reservations.remaining_quantity IS
  'Quantity still reserved; aggregate and bin reserved balances equal the sum of this field for RESERVED rows.';
COMMENT ON COLUMN inventory_location_transfers.traceability_unit_id IS
  'Optional material lot/serial moved by this transfer; traceable stock cannot be moved beyond its assigned location balance.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('160_wms_fefo_lot_serial_partial_issue', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
