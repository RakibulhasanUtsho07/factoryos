-- Align quality disposal validation with the inventory ledger transaction order.
-- InventoryService applies the guarded stock delta before inserting the immutable movement row.
BEGIN;

CREATE OR REPLACE FUNCTION factoryos_quality_guard_inventory_issue()
RETURNS trigger
LANGUAGE plpgsql
AS $factoryos_quality_issue_guard$
DECLARE
  v_disposition quality_dispositions%ROWTYPE;
  v_balance NUMERIC(18,4);
  v_reserved NUMERIC(18,4);
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.movement_type <> 'ISSUE' THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM quality_holds h WHERE h.inventory_item_id = NEW.item_id
      AND h.tenant_id = NEW.tenant_id AND h.factory_id = NEW.factory_id AND h.status = 'ACTIVE'
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.reference_type <> 'QUALITY_DISPOSITION' OR NEW.reference_id IS NULL THEN
    RAISE EXCEPTION 'inventory item is on quality hold; issue is only allowed through an approved SCRAP or RETURN_TO_SUPPLIER disposition'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_disposition FROM quality_dispositions d
  WHERE d.id = NEW.reference_id AND d.tenant_id = NEW.tenant_id AND d.factory_id = NEW.factory_id
    AND d.inventory_item_id = NEW.item_id
  FOR UPDATE;
  IF NOT FOUND OR v_disposition.status <> 'PENDING_INVENTORY'
    OR v_disposition.action NOT IN ('SCRAP', 'RETURN_TO_SUPPLIER')
    OR NEW.quantity <> v_disposition.quantity THEN
    RAISE EXCEPTION 'quality disposition stock issue does not match a pending item-scoped disposal/return'
      USING ERRCODE = '23514';
  END IF;

  SELECT quantity_on_hand, quantity_reserved INTO v_balance, v_reserved
  FROM inventory_stock_balances
  WHERE item_id = NEW.item_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  FOR UPDATE;
  -- The public inventory movement service decrements the balance before inserting the
  -- movement. Require the movement's reported after-balance to equal that ledger row,
  -- and zero after-balance so only a full, unreserved item-level disposal can pass.
  IF NOT FOUND OR v_reserved <> 0 OR v_balance IS DISTINCT FROM NEW.quantity_after
    OR NEW.quantity_after <> 0 THEN
    RAISE EXCEPTION 'quality scrap/return must remove all on-hand stock with no active reservations before release'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$factoryos_quality_issue_guard$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('165_quality_disposition_inventory_balance_guard', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
