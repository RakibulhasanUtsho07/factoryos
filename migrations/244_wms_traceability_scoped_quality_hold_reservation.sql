BEGIN;

-- Item-scoped quality holds block every reservation for an inventory item.
-- A traceability-unit-scoped hold blocks only the exact LOT/SERIAL; the allocator
-- and allocation guard enforce that identity boundary so independently accepted
-- sibling LOTs of the same SKU remain reservable.
CREATE OR REPLACE FUNCTION factoryos_quality_guard_inventory_reservation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM quality_holds h
    WHERE h.inventory_item_id = NEW.item_id
      AND h.tenant_id = NEW.tenant_id
      AND h.factory_id = NEW.factory_id
      AND h.traceability_unit_id IS NULL
      AND h.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'inventory item is on quality hold and cannot be newly reserved'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION factoryos_quality_guard_inventory_reservation() IS
  'Only item-scoped active quality holds (traceability_unit_id IS NULL) block all reservations; traceability-unit holds are enforced against the exact LOT/SERIAL allocation.';

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
      AND (qh.traceability_unit_id = NEW.traceability_unit_id OR (qh.traceability_unit_id IS NULL AND qh.inventory_item_id = v_inventory_item_id))
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

COMMENT ON FUNCTION factoryos_guard_inventory_reservation_traceability_allocation() IS
  'Rejects allocation of the exact quality-held LOT/SERIAL or any identity under an item-scoped quality hold.';

INSERT INTO schema_migrations(version, checksum)
VALUES ('244_wms_traceability_scoped_quality_hold_reservation', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
