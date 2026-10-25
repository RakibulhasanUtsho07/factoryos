BEGIN;

-- Finished goods created by work-order output are inventory-bound lots, not raw
-- material lots. Every move must keep that identity tied to the same item/scope.
-- Fail closed if tracked material or finished-good stock is moved without an ID.
CREATE OR REPLACE FUNCTION factoryos_guard_inventory_location_transfer_traceability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_product_role VARCHAR(20);
  v_unit_type VARCHAR(24);
  v_status VARCHAR(16);
  v_expires_at DATE;
  v_attributes JSONB;
BEGIN
  IF NEW.traceability_unit_id IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM inventory_traceability_location_balances tlb
      JOIN traceability_units tu
        ON tu.id = tlb.traceability_unit_id
       AND tu.tenant_id = tlb.tenant_id
       AND tu.factory_id = tlb.factory_id
       AND tu.inventory_item_id = tlb.item_id
      WHERE tlb.tenant_id = NEW.tenant_id
        AND tlb.factory_id = NEW.factory_id
        AND tlb.item_id = NEW.item_id
        AND tlb.location_id = NEW.source_location_id
        AND tlb.quantity_on_hand > 0
        AND (
          (tu.product_role = 'MATERIAL' AND tu.unit_type IN ('LOT', 'SERIAL'))
          OR (tu.product_role = 'FINISHED_GOOD' AND tu.unit_type = 'LOT')
        )
    ) THEN
      RAISE EXCEPTION 'tracked material/finished-good stock requires an explicit traceability identity'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT tu.product_role, tu.unit_type, tu.status, tu.expires_at, tu.attributes
    INTO v_product_role, v_unit_type, v_status, v_expires_at, v_attributes
  FROM traceability_units tu
  WHERE tu.id = NEW.traceability_unit_id
    AND tu.tenant_id = NEW.tenant_id
    AND tu.factory_id = NEW.factory_id
    AND tu.inventory_item_id = NEW.item_id
  FOR SHARE;

  IF NOT FOUND
    OR NOT (
      (v_product_role = 'MATERIAL' AND v_unit_type IN ('LOT', 'SERIAL'))
      OR (v_product_role = 'FINISHED_GOOD' AND v_unit_type = 'LOT')
    )
    OR v_status <> 'ACTIVE'
    OR (v_expires_at IS NOT NULL AND v_expires_at < CURRENT_DATE)
    OR COALESCE((v_attributes->>'damaged')::BOOLEAN, FALSE)
    OR COALESCE((v_attributes->>'held')::BOOLEAN, FALSE)
    OR COALESCE((v_attributes->>'quarantined')::BOOLEAN, FALSE)
    OR upper(COALESCE(v_attributes->>'condition', '')) IN ('DAMAGED', 'HELD', 'QUARANTINED', 'EXPIRED')
  THEN
    RAISE EXCEPTION 'location transfer traceability identity must be an eligible active material lot/serial or finished-good lot'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM quality_holds qh
    WHERE qh.tenant_id = NEW.tenant_id AND qh.factory_id = NEW.factory_id
      AND qh.status = 'ACTIVE'
      AND (qh.inventory_item_id = NEW.item_id OR qh.traceability_unit_id = NEW.traceability_unit_id)
  ) THEN
    RAISE EXCEPTION 'quality-held inventory cannot be transferred, picked or put away'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_location_transfer_traceability_guard ON inventory_location_transfers;
CREATE TRIGGER inventory_location_transfer_traceability_guard
BEFORE INSERT ON inventory_location_transfers
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_location_transfer_traceability();

COMMENT ON FUNCTION factoryos_guard_inventory_location_transfer_traceability() IS
  'Requires a scoped eligible material lot/serial or finished-good lot for tracked stock transfers and rejects tracked moves without identity.';

INSERT INTO schema_migrations(version, checksum)
VALUES ('200_wms_finished_good_putaway_traceability', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
