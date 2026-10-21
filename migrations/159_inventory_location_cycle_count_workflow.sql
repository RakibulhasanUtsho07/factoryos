BEGIN;

-- WP02 / WMS bin-level cycle-count review and stock-variance evidence.
-- The existing item-level proposal remains backward compatible. A proposal with
-- location_id snapshots one active BIN as well as the aggregate item balance.
ALTER TABLE inventory_cycle_count_proposals
  ADD COLUMN IF NOT EXISTS location_id UUID,
  ADD COLUMN IF NOT EXISTS location_quantity_at_count NUMERIC(18, 4),
  ADD COLUMN IF NOT EXISTS location_version_at_count BIGINT,
  ADD COLUMN IF NOT EXISTS variance_reason_code VARCHAR(32);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_inventory_cycle_count_location_scope'
      AND conrelid = 'inventory_cycle_count_proposals'::regclass
  ) THEN
    ALTER TABLE inventory_cycle_count_proposals
      ADD CONSTRAINT fk_inventory_cycle_count_location_scope
      FOREIGN KEY (location_id, tenant_id, factory_id)
      REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_cycle_count_location_snapshot'
      AND conrelid = 'inventory_cycle_count_proposals'::regclass
  ) THEN
    ALTER TABLE inventory_cycle_count_proposals
      ADD CONSTRAINT chk_inventory_cycle_count_location_snapshot
      CHECK (
        (
          location_id IS NULL
          AND location_quantity_at_count IS NULL
          AND location_version_at_count IS NULL
        )
        OR
        (
          location_id IS NOT NULL
          AND location_quantity_at_count IS NOT NULL
          AND location_quantity_at_count >= 0
          AND location_version_at_count IS NOT NULL
          AND location_version_at_count > 0
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_cycle_count_variance_reason'
      AND conrelid = 'inventory_cycle_count_proposals'::regclass
  ) THEN
    ALTER TABLE inventory_cycle_count_proposals
      ADD CONSTRAINT chk_inventory_cycle_count_variance_reason
      CHECK (
        variance_reason_code IS NULL
        OR variance_reason_code IN ('DAMAGE', 'LOSS', 'FOUND_STOCK', 'OTHER')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_cycle_count_variance_requires_reason'
      AND conrelid = 'inventory_cycle_count_proposals'::regclass
  ) THEN
    ALTER TABLE inventory_cycle_count_proposals
      ADD CONSTRAINT chk_inventory_cycle_count_variance_requires_reason
      CHECK (
        location_id IS NULL
        OR counted_quantity = location_quantity_at_count
        OR variance_reason_code IS NOT NULL
      );
  END IF;
END;
$$;

-- A reviewed bin adjustment is also an aggregate adjustment by the same delta.
-- Store the physical bin quantities alongside the aggregate ledger snapshot so
-- an operator can audit both views without conflating them.
ALTER TABLE inventory_stock_reconciliations
  ADD COLUMN IF NOT EXISTS location_id UUID,
  ADD COLUMN IF NOT EXISTS location_quantity_before NUMERIC(18, 4),
  ADD COLUMN IF NOT EXISTS location_counted_quantity NUMERIC(18, 4),
  ADD COLUMN IF NOT EXISTS location_quantity_after NUMERIC(18, 4);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_inventory_stock_reconciliation_location_scope'
      AND conrelid = 'inventory_stock_reconciliations'::regclass
  ) THEN
    ALTER TABLE inventory_stock_reconciliations
      ADD CONSTRAINT fk_inventory_stock_reconciliation_location_scope
      FOREIGN KEY (location_id, tenant_id, factory_id)
      REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_stock_reconciliation_location_snapshot'
      AND conrelid = 'inventory_stock_reconciliations'::regclass
  ) THEN
    ALTER TABLE inventory_stock_reconciliations
      ADD CONSTRAINT chk_inventory_stock_reconciliation_location_snapshot
      CHECK (
        (
          location_id IS NULL
          AND location_quantity_before IS NULL
          AND location_counted_quantity IS NULL
          AND location_quantity_after IS NULL
        )
        OR
        (
          location_id IS NOT NULL
          AND location_quantity_before IS NOT NULL
          AND location_quantity_before >= 0
          AND location_counted_quantity IS NOT NULL
          AND location_counted_quantity >= 0
          AND location_quantity_after IS NOT NULL
          AND location_quantity_after = location_counted_quantity
          AND location_counted_quantity - location_quantity_before = quantity_delta
        )
      );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_validate_inventory_cycle_count_location()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_location_type VARCHAR(20);
  v_location_status VARCHAR(20);
  v_parent_type VARCHAR(20);
  v_parent_status VARCHAR(20);
BEGIN
  IF NEW.location_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT l.location_type, l.status, p.location_type, p.status
    INTO v_location_type, v_location_status, v_parent_type, v_parent_status
  FROM inventory_locations l
  LEFT JOIN inventory_locations p
    ON p.id = l.parent_location_id
   AND p.tenant_id = l.tenant_id
   AND p.factory_id = l.factory_id
  WHERE l.id = NEW.location_id
    AND l.tenant_id = NEW.tenant_id
    AND l.factory_id = NEW.factory_id;

  IF NOT FOUND
    OR v_location_type <> 'BIN'
    OR v_location_status <> 'ACTIVE'
    OR v_parent_status <> 'ACTIVE'
    OR v_parent_type NOT IN ('WAREHOUSE', 'STAGING')
  THEN
    RAISE EXCEPTION 'cycle counts require an active bin under an active warehouse or staging location'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_cycle_count_location_scope_guard
  ON inventory_cycle_count_proposals;
CREATE TRIGGER inventory_cycle_count_location_scope_guard
BEFORE INSERT ON inventory_cycle_count_proposals
FOR EACH ROW
EXECUTE FUNCTION factoryos_validate_inventory_cycle_count_location();

-- The bin identity, counted quantity and both version snapshots are immutable
-- submission facts. Only the existing terminal review fields may change.
CREATE OR REPLACE FUNCTION factoryos_guard_inventory_cycle_count_location_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.location_id IS DISTINCT FROM OLD.location_id
    OR NEW.location_quantity_at_count IS DISTINCT FROM OLD.location_quantity_at_count
    OR NEW.location_version_at_count IS DISTINCT FROM OLD.location_version_at_count
    OR NEW.variance_reason_code IS DISTINCT FROM OLD.variance_reason_code
  THEN
    RAISE EXCEPTION 'cycle-count location snapshot and variance reason are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_cycle_count_location_snapshot_guard
  ON inventory_cycle_count_proposals;
CREATE TRIGGER inventory_cycle_count_location_snapshot_guard
BEFORE UPDATE ON inventory_cycle_count_proposals
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_inventory_cycle_count_location_snapshot();

-- Preserve the existing aggregate invariants while verifying that any optional
-- location evidence describes the exact same delta and is bound to the movement.
CREATE OR REPLACE FUNCTION factoryos_validate_inventory_stock_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  movement inventory_movements%ROWTYPE;
BEGIN
  IF NEW.location_id IS NULL THEN
    IF NEW.location_quantity_before IS NOT NULL
      OR NEW.location_counted_quantity IS NOT NULL
      OR NEW.location_quantity_after IS NOT NULL
    THEN
      RAISE EXCEPTION 'location quantities require a location-scoped reconciliation'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.location_quantity_before IS NULL
      OR NEW.location_counted_quantity IS NULL
      OR NEW.location_quantity_after IS NULL
      OR NEW.location_quantity_after <> NEW.location_counted_quantity
      OR NEW.location_counted_quantity - NEW.location_quantity_before <> NEW.quantity_delta
    THEN
      RAISE EXCEPTION 'location reconciliation quantities must record the same stock delta'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.quantity_delta = 0 THEN
    IF NEW.adjustment_movement_id IS NOT NULL THEN
      RAISE EXCEPTION 'zero-variance reconciliation must not create a stock movement'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT *
  INTO movement
  FROM inventory_movements
  WHERE id = NEW.adjustment_movement_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id;

  IF NOT FOUND
    OR movement.item_id <> NEW.item_id
    OR movement.reference_type IS DISTINCT FROM 'STOCK_RECONCILIATION'
    OR movement.reference_id IS DISTINCT FROM NEW.id
    OR movement.quantity_delta <> NEW.quantity_delta
    OR movement.quantity_after <> NEW.quantity_after
    OR movement.quantity <> ABS(NEW.quantity_delta)
    OR movement.location_id IS DISTINCT FROM NEW.location_id
    OR (NEW.quantity_delta > 0 AND movement.movement_type <> 'RECEIPT')
    OR (NEW.quantity_delta < 0 AND movement.movement_type <> 'ISSUE')
  THEN
    RAISE EXCEPTION 'stock reconciliation must reference its matching immutable adjustment movement'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON COLUMN inventory_cycle_count_proposals.location_id IS
  'Optional physical BIN scope for a WMS cycle count; null preserves aggregate item counting.';
COMMENT ON COLUMN inventory_cycle_count_proposals.location_version_at_count IS
  'Immutable version of the selected bin balance captured at submission.';
COMMENT ON COLUMN inventory_cycle_count_proposals.variance_reason_code IS
  'Required reason when the submitted physical bin count differs from its snapshot: DAMAGE, LOSS, FOUND_STOCK or OTHER.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('159_inventory_location_cycle_count_workflow', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
