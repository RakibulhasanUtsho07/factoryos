BEGIN;

ALTER TABLE inventory_locations
  ADD COLUMN putaway_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN picking_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN putaway_priority INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN picking_priority INTEGER NOT NULL DEFAULT 100;

-- A warehouse is a hierarchy node, never a stock posting endpoint.
UPDATE inventory_locations
SET putaway_enabled = FALSE, picking_enabled = FALSE
WHERE location_type = 'WAREHOUSE';

ALTER TABLE inventory_locations
  ADD CONSTRAINT chk_inventory_location_policy_priority
    CHECK (putaway_priority BETWEEN 0 AND 10000 AND picking_priority BETWEEN 0 AND 10000),
  ADD CONSTRAINT chk_inventory_warehouse_policy
    CHECK (location_type <> 'WAREHOUSE' OR (NOT putaway_enabled AND NOT picking_enabled));

ALTER TABLE inventory_location_transfers
  ADD COLUMN movement_purpose VARCHAR(20) NOT NULL DEFAULT 'TRANSFER',
  ADD CONSTRAINT chk_inventory_location_transfer_purpose
    CHECK (movement_purpose IN ('TRANSFER', 'PUT_AWAY', 'PICK'));

CREATE INDEX idx_inventory_location_putaway_candidates
  ON inventory_locations (tenant_id, factory_id, putaway_enabled, putaway_priority, lower(location_code))
  WHERE status = 'ACTIVE';

CREATE INDEX idx_inventory_location_pick_candidates
  ON inventory_locations (tenant_id, factory_id, picking_enabled, picking_priority, lower(location_code))
  WHERE status = 'ACTIVE';

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_location_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.location_type = 'WAREHOUSE' AND (NEW.putaway_enabled OR NEW.picking_enabled) THEN
    RAISE EXCEPTION 'WAREHOUSE locations cannot receive or pick stock directly'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.picking_enabled
     AND NOT NEW.picking_enabled
     AND EXISTS (
       SELECT 1 FROM inventory_reservations r
       WHERE r.tenant_id = OLD.tenant_id
         AND r.factory_id = OLD.factory_id
         AND r.location_id = OLD.id
         AND r.status = 'RESERVED'
     ) THEN
    RAISE EXCEPTION 'picking cannot be disabled while active reservations are allocated to this location'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_location_policy_guard
BEFORE INSERT OR UPDATE OF location_type, putaway_enabled, picking_enabled
ON inventory_locations
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_inventory_location_policy();

-- The database validates selected-location stock movements even when a writer
-- bypasses the Nest service. NULL-location legacy movements remain compatible.
CREATE OR REPLACE FUNCTION factoryos_validate_inventory_movement_location_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status VARCHAR(20);
  v_putaway_enabled BOOLEAN;
  v_picking_enabled BOOLEAN;
BEGIN
  IF NEW.location_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT l.status, l.putaway_enabled, l.picking_enabled
    INTO v_status, v_putaway_enabled, v_picking_enabled
  FROM inventory_locations l
  WHERE l.id = NEW.location_id
    AND l.tenant_id = NEW.tenant_id
    AND l.factory_id = NEW.factory_id
  FOR KEY SHARE;

  IF NOT FOUND OR v_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'stock movement location must be active and within the same tenant and factory'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.movement_type = 'RECEIPT' AND NOT v_putaway_enabled THEN
    RAISE EXCEPTION 'stock receipt location policy does not allow put-away/receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.movement_type = 'ISSUE' AND NOT v_picking_enabled THEN
    RAISE EXCEPTION 'stock issue location policy does not allow picking'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_movement_location_policy_guard
BEFORE INSERT ON inventory_movements
FOR EACH ROW
EXECUTE FUNCTION factoryos_validate_inventory_movement_location_policy();

CREATE OR REPLACE FUNCTION factoryos_validate_inventory_location_transfer_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_type VARCHAR(20);
  v_source_default BOOLEAN;
  v_source_enabled BOOLEAN;
  v_destination_type VARCHAR(20);
  v_destination_enabled BOOLEAN;
  v_source_status VARCHAR(20);
  v_destination_status VARCHAR(20);
BEGIN
  SELECT location_type, is_default, picking_enabled, status
    INTO v_source_type, v_source_default, v_source_enabled, v_source_status
  FROM inventory_locations
  WHERE id = NEW.source_location_id
    AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;

  SELECT location_type, putaway_enabled, status
    INTO v_destination_type, v_destination_enabled, v_destination_status
  FROM inventory_locations
  WHERE id = NEW.destination_location_id
    AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;

  IF v_source_type IS NULL OR v_destination_type IS NULL
     OR v_source_status <> 'ACTIVE' OR v_destination_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'directed movement source and destination must be active locations in this factory'
      USING ERRCODE = '23503';
  END IF;
  IF NOT v_source_enabled THEN
    RAISE EXCEPTION 'source location policy does not allow picking/transfer'
      USING ERRCODE = '23514';
  END IF;
  IF NOT v_destination_enabled THEN
    RAISE EXCEPTION 'destination location policy does not allow put-away/receipt'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.movement_purpose = 'PUT_AWAY' THEN
    IF NOT (v_source_type = 'STAGING' OR (v_source_type = 'VIRTUAL' AND v_source_default))
       OR v_destination_type <> 'BIN' THEN
      RAISE EXCEPTION 'put-away must move stock from staging/unassigned into an enabled BIN'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.movement_purpose = 'PICK' THEN
    IF v_source_type <> 'BIN' OR v_destination_type <> 'STAGING' THEN
      RAISE EXCEPTION 'directed picking must move stock from an enabled BIN into STAGING'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.movement_purpose <> 'TRANSFER' THEN
    RAISE EXCEPTION 'unsupported inventory location movement purpose'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_location_transfer_policy_guard
BEFORE INSERT ON inventory_location_transfers
FOR EACH ROW
EXECUTE FUNCTION factoryos_validate_inventory_location_transfer_policy();

COMMENT ON COLUMN inventory_locations.putaway_enabled IS
  'Whether direct stock receipts and directed put-away may target this location.';
COMMENT ON COLUMN inventory_locations.picking_enabled IS
  'Whether stock issues, reservations and directed transfer sources may use this location.';
COMMENT ON COLUMN inventory_locations.putaway_priority IS
  'Lower values are preferred first by the directed put-away suggestion API.';
COMMENT ON COLUMN inventory_locations.picking_priority IS
  'Lower values are preferred first by the directed picking suggestion API.';
COMMENT ON COLUMN inventory_location_transfers.movement_purpose IS
  'TRANSFER preserves general directed movement; PUT_AWAY and PICK enforce specific source/destination type policies.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('080_inventory_location_directed_policy', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
