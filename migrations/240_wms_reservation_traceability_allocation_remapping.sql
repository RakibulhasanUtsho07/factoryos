-- WP02 / SRS v2.1 FR-WMS-02, FR-WMS-04 and FR-WMS-09.
-- Preserve active reservation allocations during stock-conserving LOT/SERIAL identity changes.
BEGIN;


-- Active reservation quantities move with the traceability identity, not by releasing
-- and recreating the reservation. remapped_quantity is a separate monotonic disposition
-- so consumed/released history remains semantically accurate.
ALTER TABLE inventory_reservation_traceability_allocations
  ADD COLUMN IF NOT EXISTS remapped_quantity NUMERIC(18,4) NOT NULL DEFAULT 0;

ALTER TABLE inventory_reservation_traceability_allocations
  ALTER COLUMN allocation_sequence TYPE BIGINT;

ALTER TABLE inventory_reservation_traceability_allocations
  DROP CONSTRAINT IF EXISTS chk_inventory_reservation_traceability_allocation_quantities;

ALTER TABLE inventory_reservation_traceability_allocations
  ADD CONSTRAINT chk_inventory_reservation_traceability_allocation_quantities
  CHECK (
    allocated_quantity > 0
    AND consumed_quantity >= 0
    AND released_quantity >= 0
    AND remapped_quantity >= 0
    AND consumed_quantity + released_quantity + remapped_quantity <= allocated_quantity
  );

-- A single reservation may legitimately allocate two source LOTs to the same target
-- LOT after merge. allocation_sequence remains the unique order key.
ALTER TABLE inventory_reservation_traceability_allocations
  DROP CONSTRAINT IF EXISTS uq_inventory_reservation_traceability_allocation;
CREATE INDEX IF NOT EXISTS idx_inventory_reservation_traceability_allocation_identity
  ON inventory_reservation_traceability_allocations
    (tenant_id, factory_id, reservation_id, traceability_unit_id, location_id);

CREATE TABLE IF NOT EXISTS inventory_reservation_traceability_allocation_remaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  transformation_id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  source_allocation_id UUID NOT NULL,
  target_allocation_id UUID NOT NULL,
  source_unit_id UUID NOT NULL,
  target_unit_id UUID NOT NULL,
  location_id UUID NOT NULL,
  source_allocation_sequence BIGINT NOT NULL,
  target_allocation_sequence BIGINT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_wms_reservation_allocation_remap_transformation
    FOREIGN KEY (transformation_id, tenant_id, factory_id)
    REFERENCES inventory_traceability_transformations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_reservation_allocation_remap_reservation
    FOREIGN KEY (reservation_id, tenant_id, factory_id)
    REFERENCES inventory_reservations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_reservation_allocation_remap_source_allocation
    FOREIGN KEY (source_allocation_id)
    REFERENCES inventory_reservation_traceability_allocations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_reservation_allocation_remap_target_allocation
    FOREIGN KEY (target_allocation_id)
    REFERENCES inventory_reservation_traceability_allocations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_reservation_allocation_remap_source_unit
    FOREIGN KEY (source_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_reservation_allocation_remap_target_unit
    FOREIGN KEY (target_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_reservation_allocation_remap_location
    FOREIGN KEY (location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT uq_wms_reservation_allocation_remap
    UNIQUE (transformation_id, source_allocation_id, target_unit_id, location_id),
  CONSTRAINT chk_wms_reservation_allocation_remap_sequence
    CHECK (source_allocation_sequence > 0 AND target_allocation_sequence > 0),
  CONSTRAINT chk_wms_reservation_allocation_remap_quantity
    CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_wms_reservation_allocation_remaps_reservation
  ON inventory_reservation_traceability_allocation_remaps
    (tenant_id, factory_id, reservation_id, source_allocation_sequence, target_allocation_sequence);

-- Keep consumption history directly linked to the exact reservation allocation row
-- that was consumed. This makes post-merge duplicate target-unit rows unambiguous.
ALTER TABLE inventory_reservation_consumption_traceability_allocations
  ADD COLUMN IF NOT EXISTS reservation_allocation_id UUID,
  ADD COLUMN IF NOT EXISTS allocation_sequence BIGINT;

DO $remap$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_reservation_consumption_allocation_ref'
      AND conrelid = 'inventory_reservation_consumption_traceability_allocations'::regclass
  ) THEN
    ALTER TABLE inventory_reservation_consumption_traceability_allocations
      ADD CONSTRAINT fk_reservation_consumption_allocation_ref
      FOREIGN KEY (reservation_allocation_id)
      REFERENCES inventory_reservation_traceability_allocations (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_reservation_consumption_allocation_ref_pair'
      AND conrelid = 'inventory_reservation_consumption_traceability_allocations'::regclass
  ) THEN
    ALTER TABLE inventory_reservation_consumption_traceability_allocations
      ADD CONSTRAINT chk_reservation_consumption_allocation_ref_pair
      CHECK (
        (reservation_allocation_id IS NULL AND allocation_sequence IS NULL)
        OR (reservation_allocation_id IS NOT NULL AND allocation_sequence > 0)
      );
  END IF;
END;
$remap$;

CREATE OR REPLACE FUNCTION factoryos_guard_consumption_allocation_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $
BEGIN
  IF NEW.reservation_allocation_id IS NULL AND NEW.allocation_sequence IS NULL THEN
    -- Existing legacy evidence remains readable and append-only; all new API issue
    -- paths populate both lineage columns.
    RETURN NEW;
  END IF;
  IF NEW.reservation_allocation_id IS NULL OR NEW.allocation_sequence IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM inventory_reservation_consumptions c
       JOIN inventory_reservation_traceability_allocations a
         ON a.id = NEW.reservation_allocation_id
        AND a.tenant_id = c.tenant_id AND a.factory_id = c.factory_id
        AND a.reservation_id = c.reservation_id AND a.item_id = c.item_id
        AND a.traceability_unit_id = NEW.traceability_unit_id
        AND a.location_id = NEW.location_id
        AND a.allocation_sequence = NEW.allocation_sequence
        AND NEW.quantity <= c.quantity
        AND (
          SELECT COALESCE(SUM(prior.quantity), 0)
          FROM inventory_reservation_consumption_traceability_allocations prior
          WHERE prior.reservation_allocation_id = a.id
        ) + NEW.quantity <= a.consumed_quantity
       WHERE c.id = NEW.consumption_id
         AND c.tenant_id = NEW.tenant_id AND c.factory_id = NEW.factory_id
     ) THEN
    RAISE EXCEPTION 'consumption evidence must reference the exact reservation allocation row and allocation sequence used for issue'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$;

DROP TRIGGER IF EXISTS reservation_consumption_allocation_lineage_guard
  ON inventory_reservation_consumption_traceability_allocations;
CREATE TRIGGER reservation_consumption_allocation_lineage_guard
BEFORE INSERT ON inventory_reservation_consumption_traceability_allocations
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_consumption_allocation_lineage();

CREATE INDEX IF NOT EXISTS idx_reservation_consumption_allocation_lineage
  ON inventory_reservation_consumption_traceability_allocations
    (tenant_id, factory_id, reservation_allocation_id, allocation_sequence);

CREATE OR REPLACE FUNCTION factoryos_guard_reservation_allocation_remap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'reservation allocation remap evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM inventory_traceability_transformations h
    JOIN inventory_reservation_traceability_allocations source
      ON source.id = NEW.source_allocation_id
     AND source.tenant_id = NEW.tenant_id AND source.factory_id = NEW.factory_id
     AND source.reservation_id = NEW.reservation_id
    JOIN inventory_reservation_traceability_allocations target
      ON target.id = NEW.target_allocation_id
     AND target.tenant_id = NEW.tenant_id AND target.factory_id = NEW.factory_id
     AND target.reservation_id = NEW.reservation_id
    WHERE h.id = NEW.transformation_id
      AND h.tenant_id = NEW.tenant_id AND h.factory_id = NEW.factory_id
      AND source.traceability_unit_id = NEW.source_unit_id
      AND target.traceability_unit_id = NEW.target_unit_id
      AND source.location_id = NEW.location_id AND target.location_id = NEW.location_id
      AND source.item_id = h.inventory_item_id AND target.item_id = h.inventory_item_id
      AND current_setting('app.traceability_transformation', TRUE) = 'on'
  ) THEN
    RAISE EXCEPTION 'reservation allocation remap must be backed by the active scoped stock transformation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_reservation_traceability_allocation_remap_guard
  ON inventory_reservation_traceability_allocation_remaps;
CREATE TRIGGER inventory_reservation_traceability_allocation_remap_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory_reservation_traceability_allocation_remaps
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_reservation_allocation_remap();

-- Deferred consistency ties the remapped_quantity counter and every replacement
-- allocation to the append-only remap evidence. Neither side can be written alone.
CREATE OR REPLACE FUNCTION factoryos_assert_reservation_allocation_remap_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $remap$
DECLARE
  v_allocation_ids UUID[];
  v_allocation_id UUID;
  v_allocated NUMERIC(18,4);
  v_remapped NUMERIC(18,4);
  v_outgoing NUMERIC(18,4);
  v_incoming NUMERIC(18,4);
  v_has_incoming BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'inventory_reservation_traceability_allocation_remaps' THEN
    IF TG_OP = 'DELETE' THEN
      v_allocation_ids := ARRAY[OLD.source_allocation_id, OLD.target_allocation_id];
    ELSE
      v_allocation_ids := ARRAY[NEW.source_allocation_id, NEW.target_allocation_id];
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      v_allocation_ids := ARRAY[OLD.id];
    ELSE
      v_allocation_ids := ARRAY[NEW.id];
    END IF;
  END IF;

  FOREACH v_allocation_id IN ARRAY v_allocation_ids
  LOOP
    SELECT allocated_quantity, remapped_quantity
      INTO v_allocated, v_remapped
    FROM inventory_reservation_traceability_allocations
    WHERE id = v_allocation_id;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(SUM(quantity), 0)::numeric(18,4)
      INTO v_outgoing
    FROM inventory_reservation_traceability_allocation_remaps
    WHERE source_allocation_id = v_allocation_id;

    IF v_outgoing IS DISTINCT FROM v_remapped THEN
      RAISE EXCEPTION 'reservation allocation remapped_quantity must equal append-only outgoing remap evidence'
        USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(SUM(quantity), 0)::numeric(18,4),
           EXISTS (
             SELECT 1 FROM inventory_reservation_traceability_allocation_remaps
             WHERE target_allocation_id = v_allocation_id
           )
      INTO v_incoming, v_has_incoming
    FROM inventory_reservation_traceability_allocation_remaps
    WHERE target_allocation_id = v_allocation_id;

    IF v_has_incoming AND v_incoming IS DISTINCT FROM v_allocated THEN
      RAISE EXCEPTION 'replacement reservation allocation quantity must equal append-only incoming remap evidence'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$remap$;

DROP TRIGGER IF EXISTS ctr_reservation_allocation_remap_integrity
  ON inventory_reservation_traceability_allocations;
CREATE CONSTRAINT TRIGGER ctr_reservation_allocation_remap_integrity
AFTER INSERT OR UPDATE OR DELETE ON inventory_reservation_traceability_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_reservation_allocation_remap_integrity();

DROP TRIGGER IF EXISTS ctr_reservation_remap_evidence_integrity
  ON inventory_reservation_traceability_allocation_remaps;
CREATE CONSTRAINT TRIGGER ctr_reservation_remap_evidence_integrity
AFTER INSERT OR UPDATE OR DELETE ON inventory_reservation_traceability_allocation_remaps
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_reservation_allocation_remap_integrity();

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_reservation_traceability_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit_status VARCHAR(16);
  v_expires_at DATE;
  v_attributes JSONB;
  v_inventory_item_id UUID;
  v_transformation BOOLEAN := COALESCE(current_setting('app.traceability_transformation', TRUE) = 'on', FALSE);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reservation traceability allocations cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.id, NEW.tenant_id, NEW.factory_id, NEW.reservation_id, NEW.item_id,
      NEW.traceability_unit_id, NEW.location_id, NEW.allocated_quantity, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.tenant_id, OLD.factory_id, OLD.reservation_id, OLD.item_id,
      OLD.traceability_unit_id, OLD.location_id, OLD.allocated_quantity, OLD.created_at
    ) OR NEW.consumed_quantity < OLD.consumed_quantity
      OR NEW.released_quantity < OLD.released_quantity
      OR NEW.remapped_quantity < OLD.remapped_quantity
      OR NEW.consumed_quantity + NEW.released_quantity + NEW.remapped_quantity > NEW.allocated_quantity
      OR (NEW.allocation_sequence IS DISTINCT FROM OLD.allocation_sequence AND NOT v_transformation)
      OR (NEW.remapped_quantity IS DISTINCT FROM OLD.remapped_quantity AND NOT v_transformation) THEN
      RAISE EXCEPTION 'reservation allocation identity is immutable; consume, release and transformation remap quantities only move forward'
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

DROP TRIGGER IF EXISTS inventory_reservation_traceability_allocation_guard
  ON inventory_reservation_traceability_allocations;
CREATE TRIGGER inventory_reservation_traceability_allocation_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory_reservation_traceability_allocations
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_reservation_traceability_allocation();

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

  SELECT COALESCE(SUM(allocated_quantity - consumed_quantity - released_quantity - remapped_quantity), 0)
    INTO v_allocation_reserved
  FROM inventory_reservation_traceability_allocations
  WHERE tenant_id = v_tenant_id AND factory_id = v_factory_id AND item_id = v_item_id
    AND traceability_unit_id = v_traceability_unit_id AND location_id = v_location_id;

  IF v_balance_reserved IS DISTINCT FROM v_allocation_reserved THEN
    RAISE EXCEPTION 'traceability location reserved quantity must equal active reservation allocations after remapping'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_remap_inventory_reservation_traceability_allocations(
  p_tenant_id UUID,
  p_factory_id UUID,
  p_item_id UUID,
  p_transformation_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_allocation RECORD;
  v_target RECORD;
  v_reservation RECORD;
  v_existing RECORD;
  v_archive RECORD;
  v_remaining NUMERIC(18,4);
  v_take NUMERIC(18,4);
  v_offset BIGINT;
  v_next_sequence BIGINT;
  v_old_sequence BIGINT;
  v_target_allocation_id UUID;
  v_remap_count INTEGER := 0;
BEGIN
  DROP TABLE IF EXISTS pg_temp.factoryos_reservation_remap_capacity;
  DROP TABLE IF EXISTS pg_temp.factoryos_reservation_remap_plan;
  DROP TABLE IF EXISTS pg_temp.factoryos_reservation_remap_archive;
  DROP TABLE IF EXISTS pg_temp.factoryos_reservation_remap_order;

  CREATE TEMP TABLE factoryos_reservation_remap_capacity (
    target_unit_id UUID NOT NULL,
    location_id UUID NOT NULL,
    target_sequence INTEGER NOT NULL,
    remaining_quantity NUMERIC(18,4) NOT NULL,
    PRIMARY KEY (target_unit_id, location_id)
  ) ON COMMIT DROP;

  CREATE TEMP TABLE factoryos_reservation_remap_plan (
    source_allocation_id UUID NOT NULL,
    reservation_id UUID NOT NULL,
    source_unit_id UUID NOT NULL,
    source_allocation_sequence BIGINT NOT NULL,
    target_unit_id UUID NOT NULL,
    target_sequence INTEGER NOT NULL,
    location_id UUID NOT NULL,
    quantity NUMERIC(18,4) NOT NULL,
    PRIMARY KEY (source_allocation_id, target_unit_id, location_id)
  ) ON COMMIT DROP;

  CREATE TEMP TABLE factoryos_reservation_remap_archive (
    allocation_id UUID PRIMARY KEY,
    original_sequence BIGINT NOT NULL
  ) ON COMMIT DROP;

  CREATE TEMP TABLE factoryos_reservation_remap_order (
    allocation_id UUID PRIMARY KEY,
    original_sequence BIGINT NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO factoryos_reservation_remap_capacity (
    target_unit_id, location_id, target_sequence, remaining_quantity
  )
  SELECT l.target_unit_id, l.location_id, MIN(l.target_sequence),
         SUM(l.quantity)::numeric(18,4)
  FROM inventory_traceability_transformation_lines l
  WHERE l.tenant_id = p_tenant_id AND l.factory_id = p_factory_id
    AND l.transformation_id = p_transformation_id
  GROUP BY l.target_unit_id, l.location_id;

  FOR v_allocation IN
    SELECT a.id, a.reservation_id, a.traceability_unit_id, a.location_id,
           a.allocation_sequence,
           (a.allocated_quantity - a.consumed_quantity - a.released_quantity - a.remapped_quantity)::numeric(18,4) AS remaining_quantity
    FROM inventory_reservation_traceability_allocations a
    JOIN inventory_reservations r
      ON r.id = a.reservation_id AND r.tenant_id = a.tenant_id AND r.factory_id = a.factory_id
    WHERE a.tenant_id = p_tenant_id AND a.factory_id = p_factory_id
      AND a.item_id = p_item_id
      AND a.traceability_unit_id IN (
        SELECT DISTINCT l.source_unit_id
        FROM inventory_traceability_transformation_lines l
        WHERE l.tenant_id = p_tenant_id AND l.factory_id = p_factory_id
          AND l.transformation_id = p_transformation_id
      )
      AND a.allocated_quantity > a.consumed_quantity + a.released_quantity + a.remapped_quantity
    ORDER BY r.created_at, a.reservation_id, a.allocation_sequence, a.id
    FOR UPDATE OF a
  LOOP
    v_remaining := v_allocation.remaining_quantity;
    FOR v_target IN
      SELECT c.target_unit_id, c.target_sequence, c.location_id, c.remaining_quantity
      FROM factoryos_reservation_remap_capacity c
      WHERE c.location_id = v_allocation.location_id
        AND c.remaining_quantity > 0
      ORDER BY c.target_sequence, c.target_unit_id
      FOR UPDATE
    LOOP
      EXIT WHEN v_remaining = 0;
      v_take := LEAST(v_remaining, v_target.remaining_quantity);
      IF v_take <= 0 THEN CONTINUE; END IF;

      INSERT INTO factoryos_reservation_remap_plan (
        source_allocation_id, reservation_id, source_unit_id, source_allocation_sequence,
        target_unit_id, target_sequence, location_id, quantity
      ) VALUES (
        v_allocation.id, v_allocation.reservation_id, v_allocation.traceability_unit_id,
        v_allocation.allocation_sequence, v_target.target_unit_id, v_target.target_sequence,
        v_allocation.location_id, v_take
      );

      UPDATE factoryos_reservation_remap_capacity
      SET remaining_quantity = remaining_quantity - v_take
      WHERE target_unit_id = v_target.target_unit_id AND location_id = v_target.location_id;

      v_remaining := v_remaining - v_take;
    END LOOP;

    IF v_remaining <> 0 THEN
      RAISE EXCEPTION 'active reservation quantity cannot be fitted into the transformed target identity/location map'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  FOR v_reservation IN
    SELECT DISTINCT p.reservation_id
    FROM factoryos_reservation_remap_plan p
    ORDER BY p.reservation_id
  LOOP
    SELECT COALESCE(MAX(a.allocation_sequence), 0) + COUNT(*) + 100
      INTO v_offset
    FROM inventory_reservation_traceability_allocations a
    WHERE a.tenant_id = p_tenant_id AND a.factory_id = p_factory_id
      AND a.reservation_id = v_reservation.reservation_id;

    UPDATE inventory_reservation_traceability_allocations
    SET allocation_sequence = allocation_sequence + v_offset
    WHERE tenant_id = p_tenant_id AND factory_id = p_factory_id
      AND reservation_id = v_reservation.reservation_id;

    TRUNCATE factoryos_reservation_remap_archive;
    TRUNCATE factoryos_reservation_remap_order;
    INSERT INTO factoryos_reservation_remap_order (allocation_id, original_sequence)
    SELECT a.id, a.allocation_sequence - v_offset
    FROM inventory_reservation_traceability_allocations a
    WHERE a.tenant_id = p_tenant_id AND a.factory_id = p_factory_id
      AND a.reservation_id = v_reservation.reservation_id;

    v_next_sequence := 0;
    FOR v_existing IN
      SELECT o.allocation_id, o.original_sequence
      FROM factoryos_reservation_remap_order o
      ORDER BY o.original_sequence, o.allocation_id
    LOOP
      IF EXISTS (
        SELECT 1 FROM factoryos_reservation_remap_plan p
        WHERE p.source_allocation_id = v_existing.allocation_id
      ) THEN
        UPDATE inventory_reservation_traceability_allocations a
        SET remapped_quantity = remapped_quantity
              + (allocated_quantity - consumed_quantity - released_quantity - remapped_quantity),
            updated_at = clock_timestamp()
        WHERE a.id = v_existing.allocation_id
          AND a.tenant_id = p_tenant_id AND a.factory_id = p_factory_id;

        INSERT INTO factoryos_reservation_remap_archive (allocation_id, original_sequence)
        VALUES (v_existing.allocation_id, v_existing.original_sequence);

        FOR v_target IN
          SELECT p.target_unit_id, p.target_sequence, p.location_id, p.quantity,
                 p.source_unit_id, p.source_allocation_sequence
          FROM factoryos_reservation_remap_plan p
          WHERE p.source_allocation_id = v_existing.allocation_id
          ORDER BY p.target_sequence, p.target_unit_id
        LOOP
          v_next_sequence := v_next_sequence + 1;
          -- SERIAL allocation guards require the physical unit to be marked reserved
          -- before the allocation INSERT; keep this update in the same transaction.
          UPDATE inventory_traceability_location_balances
          SET quantity_reserved = quantity_reserved + v_target.quantity,
              version = version + 1,
              updated_at = clock_timestamp()
          WHERE tenant_id = p_tenant_id AND factory_id = p_factory_id
            AND item_id = p_item_id
            AND traceability_unit_id = v_target.target_unit_id
            AND location_id = v_target.location_id
            AND quantity_on_hand >= quantity_reserved + v_target.quantity;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'transformation target BIN does not have enough unreserved physical quantity for the reservation remap'
              USING ERRCODE = '23514';
          END IF;
          INSERT INTO inventory_reservation_traceability_allocations (
            tenant_id, factory_id, reservation_id, item_id, traceability_unit_id,
            location_id, allocation_sequence, allocated_quantity
          ) VALUES (
            p_tenant_id, p_factory_id, v_reservation.reservation_id, p_item_id,
            v_target.target_unit_id, v_target.location_id, v_next_sequence, v_target.quantity
          ) RETURNING id INTO v_target_allocation_id;

          INSERT INTO inventory_reservation_traceability_allocation_remaps (
            tenant_id, factory_id, transformation_id, reservation_id,
            source_allocation_id, target_allocation_id, source_unit_id, target_unit_id,
            location_id, source_allocation_sequence, target_allocation_sequence, quantity
          ) VALUES (
            p_tenant_id, p_factory_id, p_transformation_id, v_reservation.reservation_id,
            v_existing.allocation_id, v_target_allocation_id, v_target.source_unit_id,
            v_target.target_unit_id, v_target.location_id, v_existing.original_sequence,
            v_next_sequence, v_target.quantity
          );
          v_remap_count := v_remap_count + 1;
        END LOOP;
      ELSE
        v_next_sequence := v_next_sequence + 1;
        UPDATE inventory_reservation_traceability_allocations
        SET allocation_sequence = v_next_sequence
        WHERE id = v_existing.allocation_id
          AND tenant_id = p_tenant_id AND factory_id = p_factory_id;
      END IF;
    END LOOP;

    FOR v_archive IN
      SELECT a.allocation_id
      FROM factoryos_reservation_remap_archive a
      ORDER BY a.original_sequence, a.allocation_id
    LOOP
      v_next_sequence := v_next_sequence + 1;
      UPDATE inventory_reservation_traceability_allocations
      SET allocation_sequence = v_next_sequence
      WHERE id = v_archive.allocation_id
        AND tenant_id = p_tenant_id AND factory_id = p_factory_id;
    END LOOP;
  END LOOP;

  UPDATE inventory_traceability_location_balances b
  SET quantity_reserved = (
        SELECT COALESCE(SUM(a.allocated_quantity - a.consumed_quantity - a.released_quantity - a.remapped_quantity), 0)
        FROM inventory_reservation_traceability_allocations a
        WHERE a.tenant_id = b.tenant_id AND a.factory_id = b.factory_id
          AND a.item_id = b.item_id
          AND a.traceability_unit_id = b.traceability_unit_id
          AND a.location_id = b.location_id
      ),
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE b.tenant_id = p_tenant_id AND b.factory_id = p_factory_id
    AND b.item_id = p_item_id
    AND b.traceability_unit_id IN (
      SELECT DISTINCT l.target_unit_id
      FROM inventory_traceability_transformation_lines l
      WHERE l.tenant_id = p_tenant_id AND l.factory_id = p_factory_id
        AND l.transformation_id = p_transformation_id
    );

  RETURN v_remap_count;
END;
$$;

-- The reserved-allocation deferred invariant now includes the separately recorded
-- remapped amount. Historical source rows stay intact but no longer count as active.
DROP TRIGGER IF EXISTS ctr_inventory_reservation_traceability_reserved_allocation_balance
  ON inventory_reservation_traceability_allocations;
CREATE CONSTRAINT TRIGGER ctr_inventory_reservation_traceability_reserved_allocation_balance
AFTER INSERT OR UPDATE OR DELETE ON inventory_reservation_traceability_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_inventory_traceability_reserved_allocation();

ALTER TABLE inventory_reservation_traceability_allocation_remaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reservation_traceability_allocation_remaps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reservation_traceability_allocation_remaps_tenant_isolation
  ON inventory_reservation_traceability_allocation_remaps;
CREATE POLICY reservation_traceability_allocation_remaps_tenant_isolation
  ON inventory_reservation_traceability_allocation_remaps
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());



CREATE OR REPLACE FUNCTION factoryos_execute_lot_serial_transformation(
  p_operation TEXT,
  p_tenant_id UUID,
  p_factory_id UUID,
  p_actor_id UUID,
  p_source_unit_ids UUID[],
  p_target_unit_code TEXT,
  p_outputs JSONB,
  p_reason TEXT,
  p_idempotency_key TEXT,
  p_request_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_operation TEXT := upper(btrim(p_operation));
  v_actor UUID := factoryos_current_user_id();
  v_tenant UUID := factoryos_current_tenant_id();
  v_transformation_id UUID;
  v_correlation_id UUID;
  v_item_id UUID;
  v_item_count INTEGER;
  v_source_count INTEGER;
  v_first_source_set BOOLEAN := FALSE;
  v_unit TEXT;
  v_source_received_at TIMESTAMPTZ;
  v_first_source_received_at TIMESTAMPTZ;
  v_policy VARCHAR(12);
  v_output_unit_type TEXT;
  v_output_type_count INTEGER;
  v_total NUMERIC(18,4) := 0;
  v_consumed NUMERIC(18,4);
  v_tracked NUMERIC(18,4);
  v_reserved NUMERIC(18,4);
  v_source traceability_units%ROWTYPE;
  v_first_source traceability_units%ROWTYPE;
  v_output JSONB;
  v_output_location JSONB;
  v_output_sequence INTEGER := 0;
  v_target_id UUID;
  v_target_type TEXT;
  v_target_code TEXT;
  v_target_barcode TEXT;
  v_target_quantity NUMERIC(18,4);
  v_location RECORD;
  v_source_id UUID;
  v_source_quantity NUMERIC(18,4);
  v_source_locations JSONB;
  v_location_total NUMERIC(18,4);
  v_edge_quantity NUMERIC(18,4);
  v_target_ids JSONB := '[]'::jsonb;
  v_existing RECORD;
  v_status_version BIGINT;
  v_status_from TEXT;
  v_status_reason TEXT;
  v_event_id UUID;
BEGIN
  IF v_operation NOT IN ('SPLIT', 'MERGE') THEN
    RAISE EXCEPTION 'operation must be SPLIT or MERGE' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_id IS NULL OR p_factory_id IS NULL OR p_actor_id IS NULL
     OR p_source_unit_ids IS NULL OR cardinality(p_source_unit_ids) = 0
     OR p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) NOT BETWEEN 1 AND 255
     OR p_request_hash IS NULL OR p_request_hash !~ '^[a-f0-9]{64}$'
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'transformation scope, source identities, key, request hash and reason are required'
      USING ERRCODE = '22023';
  END IF;
  IF v_tenant IS DISTINCT FROM p_tenant_id OR v_actor IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION 'transformation scope must match authenticated tenant and actor context'
      USING ERRCODE = '42501';
  END IF;
  IF cardinality(p_source_unit_ids) <> (
    SELECT count(DISTINCT x) FROM unnest(p_source_unit_ids) AS t(x)
  ) THEN
    RAISE EXCEPTION 'source_unit_ids must not contain duplicates' USING ERRCODE = '22023';
  END IF;
  IF cardinality(p_source_unit_ids) > 100
     OR (v_operation = 'SPLIT' AND cardinality(p_source_unit_ids) <> 1)
     OR (v_operation = 'MERGE' AND cardinality(p_source_unit_ids) < 2) THEN
    RAISE EXCEPTION 'SPLIT requires one source LOT; MERGE requires between 2 and 100 source LOTs'
      USING ERRCODE = '22023';
  END IF;
  IF v_operation = 'SPLIT'
     AND (jsonb_typeof(p_outputs) IS DISTINCT FROM 'array'
       OR jsonb_array_length(CASE WHEN jsonb_typeof(p_outputs) = 'array' THEN p_outputs ELSE '[]'::jsonb END) NOT BETWEEN 2 AND 100) THEN
    RAISE EXCEPTION 'SPLIT requires between 2 and 100 output LOT/SERIAL identities'
      USING ERRCODE = '22023';
  END IF;
  IF v_operation = 'MERGE' AND (p_outputs IS NULL OR p_outputs <> '[]'::jsonb) THEN
    RAISE EXCEPTION 'MERGE does not accept a client-supplied output allocation array'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_factory_id::text || ':lot-serial-transformation:' || p_idempotency_key, 0
  ));

  SELECT id, request_hash
    INTO v_existing
  FROM inventory_traceability_transformations
  WHERE tenant_id = p_tenant_id AND factory_id = p_factory_id
    AND idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'Idempotency-Key was already used for a different LOT/SERIAL transformation'
        USING ERRCODE = '23505';
    END IF;
    SELECT COALESCE(jsonb_agg(t.target_unit_id ORDER BY t.target_sequence, t.target_unit_id), '[]'::jsonb)
      INTO v_target_ids
    FROM (
      SELECT l.target_unit_id, MIN(l.target_sequence) AS target_sequence
      FROM inventory_traceability_transformation_lines l
      WHERE l.tenant_id = p_tenant_id AND l.factory_id = p_factory_id
        AND l.transformation_id = v_existing.id
      GROUP BY l.target_unit_id
    ) t;
    RETURN jsonb_build_object(
      'transformation_id', v_existing.id,
      'operation_type', v_operation,
      'target_unit_ids', v_target_ids,
      'replayed', TRUE
    );
  END IF;

  SELECT count(*), count(DISTINCT u.inventory_item_id), (array_agg(DISTINCT u.inventory_item_id))[1]
    INTO v_source_count, v_item_count, v_item_id
  FROM traceability_units u
  WHERE u.id = ANY(p_source_unit_ids)
    AND u.tenant_id = p_tenant_id AND u.factory_id = p_factory_id;
  IF v_source_count <> cardinality(p_source_unit_ids) THEN
    RAISE EXCEPTION 'one or more source LOT identities do not exist in this factory'
      USING ERRCODE = '23503';
  END IF;
  IF v_item_count <> 1 OR v_item_id IS NULL THEN
    RAISE EXCEPTION 'all source LOT identities must belong to one inventory item in this factory'
      USING ERRCODE = '23514';
  END IF;

  -- Lock roots in the same item -> aggregate -> location -> identity order used
  -- by reservation/issue paths, avoiding a transformation-vs-reservation race.
  PERFORM 1 FROM inventory_items i
  WHERE i.id = v_item_id AND i.tenant_id = p_tenant_id AND i.factory_id = p_factory_id
    AND i.status = 'ACTIVE'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transformation inventory item is missing or inactive'
      USING ERRCODE = '23514';
  END IF;

  -- Canonical item -> genealogy lock order matches work-order consumption and stock issues.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_factory_id::text || ':product-genealogy-graph', 0
  ));
  PERFORM 1 FROM inventory_stock_balances b
  WHERE b.tenant_id = p_tenant_id AND b.factory_id = p_factory_id AND b.item_id = v_item_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transformation requires the aggregate inventory stock balance'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM inventory_location_balances b
  WHERE b.tenant_id = p_tenant_id AND b.factory_id = p_factory_id AND b.item_id = v_item_id
  FOR UPDATE;
  PERFORM 1 FROM inventory_traceability_location_balances b
  WHERE b.tenant_id = p_tenant_id AND b.factory_id = p_factory_id
    AND b.item_id = v_item_id AND b.traceability_unit_id = ANY(p_source_unit_ids)
  FOR UPDATE;

  -- Validate source identities only after the common lock roots have been taken.
  FOR v_source IN
    SELECT u.*
    FROM traceability_units u
    WHERE u.id = ANY(p_source_unit_ids)
      AND u.tenant_id = p_tenant_id AND u.factory_id = p_factory_id
    ORDER BY u.id
    FOR UPDATE
  LOOP
    IF v_source.unit_type <> 'LOT' OR v_source.product_role <> 'MATERIAL'
       OR v_source.status <> 'ACTIVE' OR v_source.inventory_item_id IS NULL THEN
      RAISE EXCEPTION 'only ACTIVE material LOT identities mapped to an inventory item can be transformed'
        USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(
      (SELECT COALESCE(gr.posted_at, gr.received_at)
       FROM goods_receipts gr
       WHERE gr.id = v_source.goods_receipt_id
         AND gr.tenant_id = v_source.tenant_id AND gr.factory_id = v_source.factory_id),
      v_source.allocation_received_at_override,
      v_source.created_at
    ) INTO v_source_received_at;
    IF v_source.attributes @> '{"damaged":true}'::jsonb
       OR v_source.attributes @> '{"held":true}'::jsonb
       OR v_source.attributes @> '{"quarantined":true}'::jsonb
       OR upper(COALESCE(v_source.attributes->>'condition', '')) IN ('DAMAGED','HELD','QUARANTINED','EXPIRED')
       OR (v_source.expires_at IS NOT NULL AND v_source.expires_at < CURRENT_DATE)
       OR EXISTS (
         SELECT 1 FROM quality_holds qh
         WHERE qh.tenant_id = p_tenant_id AND qh.factory_id = p_factory_id
           AND qh.status = 'ACTIVE'
           AND (qh.inventory_item_id = v_source.inventory_item_id OR qh.traceability_unit_id = v_source.id)
       ) THEN
      RAISE EXCEPTION 'expired, damaged, quarantined, recalled or quality-held LOT stock cannot be transformed'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM product_genealogy_events e
      WHERE e.tenant_id = p_tenant_id AND e.factory_id = p_factory_id
        AND e.source_unit_id = v_source.id
        AND e.relationship_type NOT IN ('CONSUMED_INTO', 'PROCESSED_INTO')
    ) THEN
      RAISE EXCEPTION 'LOT source has prior non-consumption genealogy; owner reconciliation is required before transformation'
        USING ERRCODE = '23514';
    END IF;

    -- Inventory issue evidence is authoritative for reservation-driven consumption.
    -- Work-order output genealogy can describe the same issue a second time, so use
    -- the greater complete representation rather than adding the two ledgers.
    SELECT GREATEST(
      COALESCE((
        SELECT SUM(e.quantity)
        FROM product_genealogy_events e
        WHERE e.tenant_id = p_tenant_id AND e.factory_id = p_factory_id
          AND e.source_unit_id = v_source.id
          AND e.relationship_type IN ('CONSUMED_INTO', 'PROCESSED_INTO')
      ), 0),
      COALESCE((
        SELECT SUM(ca.quantity)
        FROM inventory_reservation_consumption_traceability_allocations ca
        JOIN inventory_reservation_consumptions c
          ON c.id = ca.consumption_id
         AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
        WHERE ca.tenant_id = p_tenant_id AND ca.factory_id = p_factory_id
          AND ca.traceability_unit_id = v_source.id
      ), 0)
    )::numeric(18,4)
      INTO v_consumed;
    SELECT COALESCE(SUM(b.quantity_on_hand), 0)::numeric(18,4),
           COALESCE(SUM(b.quantity_reserved), 0)::numeric(18,4)
      INTO v_tracked, v_reserved
    FROM inventory_traceability_location_balances b
    WHERE b.tenant_id = p_tenant_id AND b.factory_id = p_factory_id
      AND b.item_id = v_source.inventory_item_id
      AND b.traceability_unit_id = v_source.id;

    IF EXISTS (
      SELECT 1
      FROM inventory_traceability_location_balances b
      LEFT JOIN (
        SELECT a.location_id,
               SUM(a.allocated_quantity - a.consumed_quantity - a.released_quantity - a.remapped_quantity)::numeric(18,4) AS reserved_quantity
        FROM inventory_reservation_traceability_allocations a
        WHERE a.tenant_id = p_tenant_id AND a.factory_id = p_factory_id
          AND a.item_id = v_source.inventory_item_id
          AND a.traceability_unit_id = v_source.id
        GROUP BY a.location_id
      ) allocations ON allocations.location_id = b.location_id
      WHERE b.tenant_id = p_tenant_id AND b.factory_id = p_factory_id
        AND b.item_id = v_source.inventory_item_id
        AND b.traceability_unit_id = v_source.id
        AND b.quantity_reserved <> COALESCE(allocations.reserved_quantity, 0)
    ) OR EXISTS (
      SELECT 1
      FROM inventory_reservation_traceability_allocations a
      WHERE a.tenant_id = p_tenant_id AND a.factory_id = p_factory_id
        AND a.item_id = v_source.inventory_item_id
        AND a.traceability_unit_id = v_source.id
        AND a.allocated_quantity > a.consumed_quantity + a.released_quantity + a.remapped_quantity
        AND NOT EXISTS (
          SELECT 1 FROM inventory_traceability_location_balances b
          WHERE b.tenant_id = a.tenant_id AND b.factory_id = a.factory_id
            AND b.item_id = a.item_id AND b.traceability_unit_id = a.traceability_unit_id
            AND b.location_id = a.location_id
        )
    ) THEN
      RAISE EXCEPTION 'LOT reserved quantity must reconcile exactly with per-reservation traceability allocations before transformation'
        USING ERRCODE = '23514';
    END IF;
    IF v_tracked <= 0 OR v_tracked <> v_source.quantity - v_consumed THEN
      RAISE EXCEPTION
        'LOT tracked on-hand (%) must exactly equal registered unconsumed quantity (%) before transformation',
        v_tracked, v_source.quantity - v_consumed
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM inventory_traceability_location_balances b
      JOIN inventory_locations l
        ON l.id = b.location_id AND l.tenant_id = b.tenant_id AND l.factory_id = b.factory_id
      WHERE b.tenant_id = p_tenant_id AND b.factory_id = p_factory_id
        AND b.traceability_unit_id = v_source.id AND b.quantity_on_hand > 0
        AND (l.status <> 'ACTIVE'
          OR NOT (l.location_type = 'BIN' OR (l.is_default AND l.location_type = 'VIRTUAL')))
    ) THEN
      RAISE EXCEPTION 'LOT stock must be in active BIN or UNASSIGNED locations before transformation'
        USING ERRCODE = '23514';
    END IF;

    IF NOT v_first_source_set THEN
      v_unit := v_source.unit;
      v_first_source := v_source;
      v_first_source_received_at := v_source_received_at;
      v_first_source_set := TRUE;
    ELSIF upper(v_source.unit) <> upper(v_unit) THEN
      RAISE EXCEPTION 'all merged source LOTs must use the same base unit'
        USING ERRCODE = '23514';
    END IF;
    IF v_total > 0 AND (
      v_source.manufactured_at IS DISTINCT FROM v_first_source.manufactured_at
      OR v_source.expires_at IS DISTINCT FROM v_first_source.expires_at
      OR v_source.attributes IS DISTINCT FROM v_first_source.attributes
      OR v_source_received_at IS DISTINCT FROM v_first_source_received_at
    ) THEN
      RAISE EXCEPTION 'LOTs with different manufacturing, expiry or condition metadata cannot be merged'
        USING ERRCODE = '23514';
    END IF;
    v_total := v_total + v_tracked;
  END LOOP;

  SELECT COALESCE(
    (SELECT p.allocation_policy
     FROM inventory_material_allocation_policies p
     WHERE p.tenant_id = p_tenant_id AND p.factory_id = p_factory_id
       AND p.policy_scope = 'MATERIAL' AND p.inventory_item_id = v_item_id),
    (SELECT p.allocation_policy
     FROM inventory_material_allocation_policies p
     JOIN inventory_items i ON i.id = v_item_id AND i.tenant_id = p.tenant_id AND i.factory_id = p.factory_id
     WHERE p.tenant_id = p_tenant_id AND p.factory_id = p_factory_id
       AND p.policy_scope = 'SECTOR' AND lower(p.sector_code) = lower(i.sector_code)),
    (SELECT p.allocation_policy
     FROM inventory_material_allocation_policies p
     WHERE p.tenant_id = p_tenant_id AND p.factory_id = p_factory_id AND p.policy_scope = 'FACTORY'),
    (SELECT ts.allocation_policy
     FROM traceability_settings ts
     WHERE ts.tenant_id = p_tenant_id AND ts.factory_id = p_factory_id),
    'FIFO'
  ) INTO v_policy;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'source_unit_id', b.traceability_unit_id,
           'location_id', b.location_id,
           'quantity', b.quantity_on_hand
         ) ORDER BY b.traceability_unit_id, b.location_id), '[]'::jsonb)
    INTO v_source_locations
  FROM inventory_traceability_location_balances b
  WHERE b.tenant_id = p_tenant_id AND b.factory_id = p_factory_id
    AND b.item_id = v_item_id AND b.traceability_unit_id = ANY(p_source_unit_ids);

  v_correlation_id := COALESCE(
    NULLIF(current_setting('app.trace_id', TRUE), '')::uuid,
    NULLIF(current_setting('app.request_id', TRUE), '')::uuid,
    gen_random_uuid()
  );
  v_transformation_id := gen_random_uuid();

  IF v_operation = 'SPLIT' THEN
    IF p_target_unit_code IS NOT NULL THEN
      RAISE EXCEPTION 'SPLIT uses each output unit_code; target_unit_code is not accepted'
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_outputs) o
      WHERE jsonb_typeof(o) <> 'object'
         OR upper(COALESCE(o->>'unit_type','')) NOT IN ('LOT','SERIAL')
         OR length(btrim(COALESCE(o->>'unit_code',''))) NOT BETWEEN 1 AND 160
         OR length(btrim(COALESCE(o->>'barcode_value', o->>'unit_code',''))) NOT BETWEEN 1 AND 255
         OR COALESCE(o->>'quantity','') !~ '^[0-9]+(\.[0-9]{1,4})?$'
         OR (o->>'quantity')::numeric <= 0
         OR jsonb_typeof(o->'locations') IS DISTINCT FROM 'array'
         OR jsonb_array_length(CASE WHEN jsonb_typeof(o->'locations') = 'array' THEN o->'locations' ELSE '[]'::jsonb END) = 0
         OR (upper(COALESCE(o->>'unit_type','')) = 'SERIAL' AND (
              (o->>'quantity')::numeric <> 1
              OR jsonb_array_length(CASE WHEN jsonb_typeof(o->'locations') = 'array' THEN o->'locations' ELSE '[]'::jsonb END) <> 1
              OR COALESCE(o->'locations'->0->>'quantity','') !~ '^1(\.0{1,4})?$'
            ))
    ) THEN
      RAISE EXCEPTION 'SPLIT outputs must be LOT/SERIAL identities with positive four-decimal BIN allocations; each SERIAL is exactly one unit in one location'
        USING ERRCODE = '22023';
    END IF;
    SELECT count(DISTINCT upper(o->>'unit_type')), min(upper(o->>'unit_type'))
      INTO v_output_type_count, v_output_unit_type
    FROM jsonb_array_elements(p_outputs) o;
    IF v_output_type_count <> 1 THEN
      RAISE EXCEPTION 'one split command must create either all LOT outputs or all SERIAL outputs; mixed identity types are not supported'
        USING ERRCODE = '23514';
    END IF;
    IF (v_policy = 'LOT' AND v_output_unit_type <> 'LOT')
       OR (v_policy = 'SERIAL' AND v_output_unit_type <> 'SERIAL') THEN
      RAISE EXCEPTION 'split output identity type must follow the effective material allocation policy %', v_policy
        USING ERRCODE = '23514';
    END IF;
    IF v_policy IN ('FIFO','FEFO') AND v_output_unit_type = 'SERIAL'
       AND EXISTS (
         SELECT 1
         FROM traceability_units u
         JOIN inventory_traceability_location_balances b
           ON b.traceability_unit_id = u.id AND b.tenant_id = u.tenant_id
          AND b.factory_id = u.factory_id AND b.item_id = u.inventory_item_id
         WHERE u.tenant_id = p_tenant_id AND u.factory_id = p_factory_id
           AND u.inventory_item_id = v_item_id AND u.id <> p_source_unit_ids[1]
           AND u.unit_type = 'LOT' AND u.product_role = 'MATERIAL'
           AND u.status = 'ACTIVE' AND b.quantity_on_hand > 0
       ) THEN
      RAISE EXCEPTION 'LOT-to-SERIAL split is not eligible while another active LOT identity still carries stock; transform the remaining LOT stock first'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT lower(o->>'unit_code')
      FROM jsonb_array_elements(p_outputs) o
      GROUP BY lower(o->>'unit_code')
      HAVING count(*) > 1
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_outputs) o
      CROSS JOIN LATERAL jsonb_array_elements(o->'locations') loc
      GROUP BY lower(o->>'unit_code'), (loc->>'location_id')
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'SPLIT output unit codes and per-output locations must be unique'
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_outputs) o
      CROSS JOIN LATERAL jsonb_array_elements(o->'locations') loc
      WHERE COALESCE(loc->>'location_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         OR COALESCE(loc->>'quantity','') !~ '^[0-9]+(\.[0-9]{1,4})?$'
         OR (loc->>'quantity')::numeric <= 0
    ) THEN
      RAISE EXCEPTION 'SPLIT output locations require valid UUIDs and positive four-decimal quantities'
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_outputs) o
      WHERE (SELECT COALESCE(SUM((loc->>'quantity')::numeric),0)
             FROM jsonb_array_elements(o->'locations') loc) <> (o->>'quantity')::numeric
    ) THEN
      RAISE EXCEPTION 'each SPLIT output quantity must exactly equal its location allocation total'
        USING ERRCODE = '23514';
    END IF;
    IF (SELECT COALESCE(SUM((o->>'quantity')::numeric),0) FROM jsonb_array_elements(p_outputs) o) <> v_total THEN
      RAISE EXCEPTION 'SPLIT output quantities must conserve the complete source LOT on-hand quantity'
        USING ERRCODE = '23514';
    END IF;
    FOR v_location IN
      SELECT (loc->>'location_id')::uuid AS location_id
      FROM jsonb_array_elements(p_outputs) o
      CROSS JOIN LATERAL jsonb_array_elements(o->'locations') loc
      GROUP BY (loc->>'location_id')::uuid
    LOOP
      SELECT COALESCE(SUM((loc->>'quantity')::numeric),0)::numeric(18,4)
        INTO v_location_total
      FROM jsonb_array_elements(p_outputs) o
      CROSS JOIN LATERAL jsonb_array_elements(o->'locations') loc
      WHERE (loc->>'location_id')::uuid = v_location.location_id;
      IF v_location_total IS DISTINCT FROM COALESCE((
        SELECT SUM((s->>'quantity')::numeric)::numeric(18,4)
        FROM jsonb_array_elements(v_source_locations) s
        WHERE (s->>'source_unit_id')::uuid = p_source_unit_ids[1]
          AND (s->>'location_id')::uuid = v_location.location_id
      ), 0::numeric(18,4)) THEN
        RAISE EXCEPTION 'SPLIT allocations must conserve source quantity in every existing BIN/UNASSIGNED location'
          USING ERRCODE = '23514';
      END IF;
    END LOOP;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_source_locations) s
      WHERE (s->>'source_unit_id')::uuid = p_source_unit_ids[1]
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_outputs) o
          CROSS JOIN LATERAL jsonb_array_elements(o->'locations') loc
          WHERE (loc->>'location_id')::uuid = (s->>'location_id')::uuid
        )
        AND (s->>'quantity')::numeric > 0
    ) THEN
      RAISE EXCEPTION 'SPLIT omitted a source location with on-hand stock'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    v_target_code := upper(btrim(COALESCE(p_target_unit_code,'')));
    IF length(v_target_code) NOT BETWEEN 1 AND 160 THEN
      RAISE EXCEPTION 'MERGE target_unit_code is required and must contain at most 160 characters'
        USING ERRCODE = '22023';
    END IF;
    IF p_outputs <> '[]'::jsonb THEN
      RAISE EXCEPTION 'MERGE output allocations are derived from source location balances'
        USING ERRCODE = '22023';
    END IF;
    IF v_policy = 'SERIAL' THEN
      RAISE EXCEPTION 'MERGE creates a LOT identity and is not allowed by the SERIAL material allocation policy'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO inventory_traceability_transformations (
    id, tenant_id, factory_id, inventory_item_id, operation_type, idempotency_key,
    request_hash, reason, total_quantity, unit, created_by_user_id, correlation_id
  ) VALUES (
    v_transformation_id, p_tenant_id, p_factory_id, v_item_id, v_operation, p_idempotency_key,
    p_request_hash, btrim(p_reason), v_total, v_unit, p_actor_id, v_correlation_id
  );

  PERFORM set_config('app.traceability_transformation', 'on', TRUE);

  IF v_operation = 'SPLIT' THEN
    UPDATE inventory_traceability_location_balances
    SET quantity_on_hand = 0, quantity_reserved = 0,
        version = version + 1, updated_at = clock_timestamp()
    WHERE tenant_id = p_tenant_id AND factory_id = p_factory_id
      AND traceability_unit_id = p_source_unit_ids[1];

    FOR v_output IN SELECT value FROM jsonb_array_elements(p_outputs)
    LOOP
      v_output_sequence := v_output_sequence + 1;
      v_target_id := gen_random_uuid();
      v_target_type := upper(v_output->>'unit_type');
      v_target_code := upper(btrim(v_output->>'unit_code'));
      v_target_barcode := upper(btrim(COALESCE(v_output->>'barcode_value', v_target_code)));
      v_target_quantity := (v_output->>'quantity')::numeric(18,4);

      INSERT INTO traceability_units (
        id, tenant_id, factory_id, unit_type, product_role, unit_code, barcode_value,
        inventory_item_id, quantity, unit, external_reference, manufactured_at, expires_at,
        allocation_received_at_override, attributes, idempotency_key, request_hash, created_by_user_id, correlation_id
      ) VALUES (
        v_target_id, p_tenant_id, p_factory_id, v_target_type, 'MATERIAL',
        v_target_code, v_target_barcode, v_item_id, v_target_quantity, v_unit,
        'LOT_SERIAL_TRANSFORMATION:' || v_transformation_id::text,
        v_first_source.manufactured_at, v_first_source.expires_at, v_first_source_received_at,
        v_first_source.attributes || jsonb_build_object('transformed_from_unit_id', p_source_unit_ids[1]),
        'transformation:' || v_transformation_id::text || ':unit:' || v_target_id::text,
        p_request_hash, p_actor_id, v_correlation_id
      );

      FOR v_output_location IN SELECT value FROM jsonb_array_elements(v_output->'locations')
      LOOP
        INSERT INTO inventory_traceability_transformation_lines (
          tenant_id, factory_id, transformation_id, source_unit_id, target_unit_id, target_sequence,
          location_id, relationship_type, quantity
        ) VALUES (
          p_tenant_id, p_factory_id, v_transformation_id, p_source_unit_ids[1], v_target_id, v_output_sequence,
          (v_output_location->>'location_id')::uuid, 'SPLIT_INTO',
          (v_output_location->>'quantity')::numeric(18,4)
        );
        INSERT INTO inventory_traceability_location_balances (
          tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand, quantity_reserved
        ) VALUES (
          p_tenant_id, p_factory_id, v_item_id, v_target_id,
          (v_output_location->>'location_id')::uuid,
          (v_output_location->>'quantity')::numeric(18,4), 0
        );
      END LOOP;

      INSERT INTO product_genealogy_events (
        tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type,
        transformation_id, quantity, unit, evidence, notes, idempotency_key,
        request_hash, created_by_user_id, correlation_id
      ) VALUES (
        p_tenant_id, p_factory_id, p_source_unit_ids[1], v_target_id, 'SPLIT_INTO',
        v_transformation_id, v_target_quantity, v_unit,
        jsonb_build_object('transformation_id', v_transformation_id, 'operation', 'SPLIT'),
        btrim(p_reason),
        'transformation:' || v_transformation_id::text || ':genealogy:' || v_target_id::text,
        p_request_hash, p_actor_id, v_correlation_id
      ) RETURNING id INTO v_event_id;

      INSERT INTO outbox_events (
        tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
      ) VALUES (
        p_tenant_id, p_factory_id, 'TRACEABILITY_UNIT', v_target_id,
        'TRACEABILITY.UNIT_REGISTERED',
        jsonb_build_object('unit_id', v_target_id, 'unit_type', v_target_type,
          'product_role', 'MATERIAL', 'unit_code', v_target_code,
          'quantity', v_target_quantity, 'unit', v_unit,
          'transformation_id', v_transformation_id)
      );
      INSERT INTO audit_events (
        tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
        correlation_id, request_id, data_class, payload
      ) VALUES (
        p_tenant_id, p_factory_id, p_actor_id, 'TRACEABILITY', 'REGISTERED',
        'TRACEABILITY_UNIT', v_target_id, v_correlation_id,
        NULLIF(current_setting('app.request_id', TRUE), '')::uuid, 'INTERNAL',
        jsonb_build_object('unit_type', v_target_type, 'product_role', 'MATERIAL',
          'unit_code', v_target_code, 'quantity', v_target_quantity,
          'transformation_id', v_transformation_id)
      );
      INSERT INTO outbox_events (
        tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
      ) VALUES (
        p_tenant_id, p_factory_id, 'PRODUCT_GENEALOGY_EVENT', v_event_id,
        'TRACEABILITY.GENEALOGY_RECORDED',
        jsonb_build_object('genealogy_event_id', v_event_id, 'source_unit_id', p_source_unit_ids[1],
          'target_unit_id', v_target_id, 'relationship_type', 'SPLIT_INTO',
          'quantity', v_target_quantity, 'unit', v_unit, 'transformation_id', v_transformation_id)
      );
      INSERT INTO audit_events (
        tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
        correlation_id, request_id, data_class, payload
      ) VALUES (
        p_tenant_id, p_factory_id, p_actor_id, 'TRACEABILITY', 'RECORDED',
        'PRODUCT_GENEALOGY_EVENT', v_event_id, v_correlation_id,
        NULLIF(current_setting('app.request_id', TRUE), '')::uuid, 'INTERNAL',
        jsonb_build_object('sourceUnitId', p_source_unit_ids[1], 'targetUnitId', v_target_id,
          'relationshipType', 'SPLIT_INTO', 'quantity', v_target_quantity,
          'unit', v_unit, 'transformationId', v_transformation_id)
      );
      v_target_ids := v_target_ids || jsonb_build_array(v_target_id);
    END LOOP;
  ELSE
    v_target_id := gen_random_uuid();
    INSERT INTO traceability_units (
      id, tenant_id, factory_id, unit_type, product_role, unit_code, barcode_value,
      inventory_item_id, quantity, unit, external_reference, manufactured_at, expires_at,
      allocation_received_at_override, attributes, idempotency_key, request_hash, created_by_user_id, correlation_id
    ) VALUES (
      v_target_id, p_tenant_id, p_factory_id, 'LOT', 'MATERIAL',
      v_target_code, v_target_code, v_item_id, v_total, v_unit,
      'LOT_SERIAL_TRANSFORMATION:' || v_transformation_id::text,
      v_first_source.manufactured_at, v_first_source.expires_at, v_first_source_received_at,
      v_first_source.attributes || jsonb_build_object('merged_from_unit_ids', to_jsonb(p_source_unit_ids)),
      'transformation:' || v_transformation_id::text || ':unit:' || v_target_id::text,
      p_request_hash, p_actor_id, v_correlation_id
    );

    FOR v_location IN
      SELECT (s->>'location_id')::uuid AS location_id,
             SUM((s->>'quantity')::numeric)::numeric(18,4) AS location_quantity
      FROM jsonb_array_elements(v_source_locations) s
      GROUP BY (s->>'location_id')::uuid
      ORDER BY (s->>'location_id')::uuid
    LOOP
      IF v_location.location_quantity > 0 THEN
        INSERT INTO inventory_traceability_location_balances (
          tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand, quantity_reserved
        ) VALUES (
          p_tenant_id, p_factory_id, v_item_id, v_target_id,
          v_location.location_id, v_location.location_quantity, 0
        );
      END IF;
    END LOOP;

    UPDATE inventory_traceability_location_balances
    SET quantity_on_hand = 0, quantity_reserved = 0,
        version = version + 1, updated_at = clock_timestamp()
    WHERE tenant_id = p_tenant_id AND factory_id = p_factory_id
      AND traceability_unit_id = ANY(p_source_unit_ids);

    FOREACH v_source_id IN ARRAY p_source_unit_ids
    LOOP
      SELECT COALESCE(SUM((s->>'quantity')::numeric),0)::numeric(18,4)
        INTO v_edge_quantity
      FROM jsonb_array_elements(v_source_locations) s
      WHERE (s->>'source_unit_id')::uuid = v_source_id;

      FOR v_location IN
        SELECT (s->>'location_id')::uuid AS location_id,
               SUM((s->>'quantity')::numeric)::numeric(18,4) AS quantity
        FROM jsonb_array_elements(v_source_locations) s
        WHERE (s->>'source_unit_id')::uuid = v_source_id
        GROUP BY (s->>'location_id')::uuid
        ORDER BY (s->>'location_id')::uuid
      LOOP
        IF v_location.quantity > 0 THEN
          INSERT INTO inventory_traceability_transformation_lines (
            tenant_id, factory_id, transformation_id, source_unit_id, target_unit_id, target_sequence,
            location_id, relationship_type, quantity
          ) VALUES (
            p_tenant_id, p_factory_id, v_transformation_id, v_source_id, v_target_id, 1,
            v_location.location_id, 'MERGED_INTO', v_location.quantity
          );
        END IF;
      END LOOP;

      INSERT INTO product_genealogy_events (
        tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type,
        transformation_id, quantity, unit, evidence, notes, idempotency_key,
        request_hash, created_by_user_id, correlation_id
      ) VALUES (
        p_tenant_id, p_factory_id, v_source_id, v_target_id, 'MERGED_INTO',
        v_transformation_id, v_edge_quantity, v_unit,
        jsonb_build_object('transformation_id', v_transformation_id, 'operation', 'MERGE'),
        btrim(p_reason),
        'transformation:' || v_transformation_id::text || ':genealogy:' || v_source_id::text,
        p_request_hash, p_actor_id, v_correlation_id
      ) RETURNING id INTO v_event_id;

      INSERT INTO outbox_events (
        tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
      ) VALUES (
        p_tenant_id, p_factory_id, 'PRODUCT_GENEALOGY_EVENT', v_event_id,
        'TRACEABILITY.GENEALOGY_RECORDED',
        jsonb_build_object('genealogy_event_id', v_event_id, 'source_unit_id', v_source_id,
          'target_unit_id', v_target_id, 'relationship_type', 'MERGED_INTO',
          'quantity', v_edge_quantity, 'unit', v_unit, 'transformation_id', v_transformation_id)
      );
      INSERT INTO audit_events (
        tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
        correlation_id, request_id, data_class, payload
      ) VALUES (
        p_tenant_id, p_factory_id, p_actor_id, 'TRACEABILITY', 'RECORDED',
        'PRODUCT_GENEALOGY_EVENT', v_event_id, v_correlation_id,
        NULLIF(current_setting('app.request_id', TRUE), '')::uuid, 'INTERNAL',
        jsonb_build_object('sourceUnitId', v_source_id, 'targetUnitId', v_target_id,
          'relationshipType', 'MERGED_INTO', 'quantity', v_edge_quantity,
          'unit', v_unit, 'transformationId', v_transformation_id)
      );
    END LOOP;

    INSERT INTO outbox_events (
      tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
    ) VALUES (
      p_tenant_id, p_factory_id, 'TRACEABILITY_UNIT', v_target_id,
      'TRACEABILITY.UNIT_REGISTERED',
      jsonb_build_object('unit_id', v_target_id, 'unit_type', 'LOT',
        'product_role', 'MATERIAL', 'unit_code', v_target_code,
        'quantity', v_total, 'unit', v_unit, 'transformation_id', v_transformation_id)
    );
    INSERT INTO audit_events (
      tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
      correlation_id, request_id, data_class, payload
    ) VALUES (
      p_tenant_id, p_factory_id, p_actor_id, 'TRACEABILITY', 'REGISTERED',
      'TRACEABILITY_UNIT', v_target_id, v_correlation_id,
      NULLIF(current_setting('app.request_id', TRUE), '')::uuid, 'INTERNAL',
      jsonb_build_object('unit_type', 'LOT', 'product_role', 'MATERIAL',
        'unit_code', v_target_code, 'quantity', v_total, 'transformation_id', v_transformation_id)
    );
    v_target_ids := jsonb_build_array(v_target_id);
  END IF;

  -- Rebind active reservation allocations to the exact target identities while
  -- retaining each reservation's original relative issue order. The helper archives
  -- the source allocation remainder and inserts replacement rows before source LOTs
  -- are disposed; aggregate reservation quantities do not change.
  PERFORM factoryos_remap_inventory_reservation_traceability_allocations(
    p_tenant_id, p_factory_id, v_item_id, v_transformation_id
  );

  -- A source identity with no remaining physical quantity is terminal. Status
  -- history, audit and outbox are committed with its transformation evidence.
  FOREACH v_source_id IN ARRAY p_source_unit_ids
  LOOP
    SELECT status, version INTO v_status_from, v_status_version
    FROM traceability_units
    WHERE id = v_source_id AND tenant_id = p_tenant_id AND factory_id = p_factory_id
    FOR UPDATE;
    UPDATE traceability_units
    SET status = 'DISPOSED',
        version = version + 1,
        updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
    WHERE id = v_source_id AND tenant_id = p_tenant_id AND factory_id = p_factory_id
    RETURNING version INTO v_status_version;
    v_status_reason := 'Consumed by stock-conserving ' || v_operation || ' transformation ' || v_transformation_id::text || ': ' || btrim(p_reason);

    INSERT INTO traceability_unit_status_events (
      tenant_id, factory_id, unit_id, version, from_status, to_status, reason,
      idempotency_key, request_hash, changed_by_user_id, correlation_id
    ) VALUES (
      p_tenant_id, p_factory_id, v_source_id, v_status_version, v_status_from, 'DISPOSED',
      v_status_reason, 'transformation:' || v_transformation_id::text || ':status:' || v_source_id::text,
      p_request_hash, p_actor_id, v_correlation_id
    );
    INSERT INTO outbox_events (
      tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
    ) VALUES (
      p_tenant_id, p_factory_id, 'TRACEABILITY_UNIT', v_source_id,
      'TRACEABILITY.UNIT_STATUS_CHANGED',
      jsonb_build_object('unit_id', v_source_id, 'from_status', v_status_from,
        'to_status', 'DISPOSED', 'version', v_status_version,
        'reason', v_status_reason, 'transformation_id', v_transformation_id)
    );
    INSERT INTO audit_events (
      tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
      correlation_id, request_id, data_class, payload
    ) VALUES (
      p_tenant_id, p_factory_id, p_actor_id, 'TRACEABILITY', 'STATUS_CHANGED',
      'TRACEABILITY_UNIT', v_source_id, v_correlation_id,
      NULLIF(current_setting('app.request_id', TRUE), '')::uuid, 'INTERNAL',
      jsonb_build_object('from_status', v_status_from, 'to_status', 'DISPOSED',
        'version', v_status_version, 'reason', v_status_reason,
        'transformation_id', v_transformation_id)
    );
  END LOOP;

  INSERT INTO outbox_events (
    tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
  ) VALUES (
    p_tenant_id, p_factory_id, 'WMS_LOT_SERIAL_TRANSFORMATION', v_transformation_id,
    'WMS.LOT_SERIAL_TRANSFORMATION_COMPLETED',
    jsonb_build_object('transformation_id', v_transformation_id, 'operation_type', v_operation,
      'source_unit_ids', to_jsonb(p_source_unit_ids), 'target_unit_ids', v_target_ids,
      'inventory_item_id', v_item_id, 'total_quantity', v_total, 'unit', v_unit, 'reason', btrim(p_reason))
  );
  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
    correlation_id, request_id, data_class, payload
  ) VALUES (
    p_tenant_id, p_factory_id, p_actor_id, 'WMS', 'COMPLETED',
    'WMS_LOT_SERIAL_TRANSFORMATION', v_transformation_id, v_correlation_id,
    NULLIF(current_setting('app.request_id', TRUE), '')::uuid, 'INTERNAL',
    jsonb_build_object('operation_type', v_operation, 'source_unit_ids', to_jsonb(p_source_unit_ids),
      'target_unit_ids', v_target_ids, 'inventory_item_id', v_item_id,
      'total_quantity', v_total, 'unit', v_unit, 'reason', btrim(p_reason))
  );

  PERFORM set_config('app.traceability_transformation', '', TRUE);
  RETURN jsonb_build_object(
    'transformation_id', v_transformation_id,
    'operation_type', v_operation,
    'target_unit_ids', v_target_ids,
    'replayed', FALSE
  );
END;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('240_wms_reservation_traceability_allocation_remapping', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
