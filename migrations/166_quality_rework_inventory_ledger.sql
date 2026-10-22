-- Rework input consumption, verified recovered-output receipt and cancel restoration
-- use the canonical inventory ledger in the same transaction as the quality state change.
BEGIN;

CREATE OR REPLACE FUNCTION factoryos_quality_guard_inventory_issue()
RETURNS trigger
LANGUAGE plpgsql
AS $factoryos_quality_issue_guard$
DECLARE
  v_disposition quality_dispositions%ROWTYPE;
  v_rework quality_rework_orders%ROWTYPE;
  v_balance NUMERIC(18,4);
  v_reserved NUMERIC(18,4);
  v_prior_quantity NUMERIC(18,4);
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.movement_type <> 'ISSUE' THEN RETURN NEW; END IF;

  IF NEW.reference_type = 'QUALITY_REWORK_INPUT' AND NEW.reference_id IS NOT NULL THEN
    SELECT * INTO v_rework FROM quality_rework_orders r
    WHERE r.id=NEW.reference_id AND r.tenant_id=NEW.tenant_id AND r.factory_id=NEW.factory_id
    FOR UPDATE;
    IF NOT FOUND OR v_rework.status<>'IN_PROGRESS'
      OR v_rework.source_inventory_item_id IS DISTINCT FROM NEW.item_id
      OR v_rework.started_by_user_id IS DISTINCT FROM NEW.created_by_user_id THEN
      RAISE EXCEPTION 'rework source issue requires an in-progress task and its source item/actor'
        USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM quality_holds h
      WHERE h.tenant_id=NEW.tenant_id AND h.factory_id=NEW.factory_id AND h.status='ACTIVE'
        AND (h.inspection_id=v_rework.inspection_id
          OR (v_rework.source_traceability_unit_id IS NOT NULL AND h.traceability_unit_id=v_rework.source_traceability_unit_id))
    ) THEN
      RAISE EXCEPTION 'rework source issue requires an active quality hold on the inspected source'
        USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(sum(im.quantity),0)::numeric(18,4) INTO v_prior_quantity
    FROM inventory_movements im
    WHERE im.tenant_id=NEW.tenant_id AND im.factory_id=NEW.factory_id
      AND im.reference_type='QUALITY_REWORK_INPUT' AND im.reference_id=v_rework.id
      AND im.movement_type='ISSUE';
    IF v_prior_quantity+NEW.quantity>v_rework.input_quantity THEN
      RAISE EXCEPTION 'rework source issues cannot exceed the approved input quantity'
        USING ERRCODE='23514';
    END IF;
    SELECT quantity_on_hand,quantity_reserved INTO v_balance,v_reserved
    FROM inventory_stock_balances
    WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND item_id=NEW.item_id
    FOR UPDATE;
    IF NOT FOUND OR v_reserved<>0 OR v_balance IS DISTINCT FROM NEW.quantity_after OR NEW.quantity_after<0 THEN
      RAISE EXCEPTION 'rework source issue must reconcile the unreserved post-issue aggregate balance'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM quality_holds h WHERE h.inventory_item_id=NEW.item_id
      AND h.tenant_id=NEW.tenant_id AND h.factory_id=NEW.factory_id AND h.status='ACTIVE'
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.reference_type <> 'QUALITY_DISPOSITION' OR NEW.reference_id IS NULL THEN
    RAISE EXCEPTION 'inventory item is on quality hold; issue is only allowed through an approved SCRAP/RETURN disposition or in-progress rework input'
      USING ERRCODE='23514';
  END IF;

  SELECT * INTO v_disposition FROM quality_dispositions d
  WHERE d.id=NEW.reference_id AND d.tenant_id=NEW.tenant_id AND d.factory_id=NEW.factory_id
    AND d.inventory_item_id=NEW.item_id FOR UPDATE;
  IF NOT FOUND OR v_disposition.status<>'PENDING_INVENTORY'
    OR v_disposition.action NOT IN ('SCRAP','RETURN_TO_SUPPLIER')
    OR NEW.quantity<>v_disposition.quantity THEN
    RAISE EXCEPTION 'quality disposition stock issue does not match a pending item-scoped disposal/return'
      USING ERRCODE='23514';
  END IF;

  SELECT quantity_on_hand,quantity_reserved INTO v_balance,v_reserved
  FROM inventory_stock_balances
  WHERE item_id=NEW.item_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND OR v_reserved<>0 OR v_balance IS DISTINCT FROM NEW.quantity_after OR NEW.quantity_after<>0 THEN
    RAISE EXCEPTION 'quality scrap/return must remove all on-hand stock with no active reservations before release'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$factoryos_quality_issue_guard$;

CREATE OR REPLACE FUNCTION factoryos_quality_guard_rework_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $factoryos_rework_receipt_guard$
DECLARE
  v_rework quality_rework_orders%ROWTYPE;
  v_balance NUMERIC(18,4);
  v_reserved NUMERIC(18,4);
  v_prior_at_location NUMERIC(18,4);
  v_prior_restore NUMERIC(18,4);
BEGIN
  IF TG_OP<>'INSERT' OR NEW.movement_type<>'RECEIPT'
    OR NEW.reference_type NOT IN ('QUALITY_REWORK_OUTPUT','QUALITY_REWORK_RESTORE')
    OR NEW.reference_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_rework FROM quality_rework_orders r
  WHERE r.id=NEW.reference_id AND r.tenant_id=NEW.tenant_id AND r.factory_id=NEW.factory_id FOR UPDATE;
  IF NOT FOUND OR v_rework.source_inventory_item_id IS DISTINCT FROM NEW.item_id
    OR NEW.location_id IS NULL THEN
    RAISE EXCEPTION 'rework receipt must reference a source-scoped rework task and a physical location'
      USING ERRCODE='23514';
  END IF;

  SELECT quantity_on_hand,quantity_reserved INTO v_balance,v_reserved
  FROM inventory_stock_balances
  WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND item_id=NEW.item_id
  FOR UPDATE;
  IF NOT FOUND OR v_balance IS DISTINCT FROM NEW.quantity_after THEN
    RAISE EXCEPTION 'rework receipt quantity-after must match the aggregate inventory ledger'
      USING ERRCODE='23514';
  END IF;

  IF NEW.reference_type='QUALITY_REWORK_OUTPUT' THEN
    IF v_rework.status<>'VERIFIED' OR v_rework.verified_by_user_id IS DISTINCT FROM NEW.created_by_user_id
      OR v_rework.recovered_quantity<=0 OR v_rework.recovered_quantity<>NEW.quantity
      OR v_rework.output_traceability_unit_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM quality_inspections qi
        WHERE qi.id=v_rework.follow_up_inspection_id AND qi.tenant_id=v_rework.tenant_id
          AND qi.factory_id=v_rework.factory_id AND qi.status='PASSED'
          AND qi.target_type='TRACEABILITY_UNIT' AND qi.target_id=v_rework.output_traceability_unit_id
      )
      OR EXISTS (
        SELECT 1 FROM inventory_movements im
        WHERE im.tenant_id=NEW.tenant_id AND im.factory_id=NEW.factory_id
          AND im.reference_type='QUALITY_REWORK_OUTPUT' AND im.reference_id=v_rework.id
      ) THEN
      RAISE EXCEPTION 'recovered output stock may post once only after independent verification and a PASSED follow-up inspection'
        USING ERRCODE='23514';
    END IF;
  ELSE
    IF v_rework.status<>'CANCELLED' OR NEW.created_by_user_id IS DISTINCT FROM v_rework.cancelled_by_user_id THEN
      RAISE EXCEPTION 'source stock can be restored only by the actor cancelling the rework task'
        USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(sum(quantity),0)::numeric(18,4) INTO v_prior_at_location
    FROM inventory_movements
    WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
      AND reference_type='QUALITY_REWORK_INPUT' AND reference_id=v_rework.id
      AND movement_type='ISSUE' AND location_id=NEW.location_id;
    SELECT COALESCE(sum(quantity),0)::numeric(18,4) INTO v_prior_restore
    FROM inventory_movements
    WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
      AND reference_type='QUALITY_REWORK_RESTORE' AND reference_id=v_rework.id
      AND movement_type='RECEIPT' AND location_id=NEW.location_id;
    IF v_prior_restore+NEW.quantity>v_prior_at_location THEN
      RAISE EXCEPTION 'rework cancellation cannot restore more stock to a bin than was originally issued from it'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$factoryos_rework_receipt_guard$;

DROP TRIGGER IF EXISTS trg_quality_rework_receipt_guard ON inventory_movements;
CREATE TRIGGER trg_quality_rework_receipt_guard
BEFORE INSERT ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION factoryos_quality_guard_rework_receipt();

CREATE OR REPLACE FUNCTION factoryos_assert_quality_rework_inventory_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $factoryos_rework_inventory_evidence$
DECLARE
  v_issued NUMERIC(18,4);
  v_restored NUMERIC(18,4);
  v_recovered NUMERIC(18,4);
  v_current_status VARCHAR(20);
  v_input_quantity NUMERIC(18,4);
  v_recovered_quantity NUMERIC(18,4);
  v_source_item UUID;
BEGIN
  -- Constraint triggers are deferred. A single API transaction may pass through
  -- COMPLETED and VERIFIED (or IN_PROGRESS and CANCELLED); reconcile against the
  -- committed current row state, not a transient NEW row image queued earlier.
  SELECT status,input_quantity,recovered_quantity,source_inventory_item_id
    INTO v_current_status,v_input_quantity,v_recovered_quantity,v_source_item
  FROM quality_rework_orders
  WHERE id=NEW.id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  IF NOT FOUND OR v_source_item IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(sum(quantity),0)::numeric(18,4) INTO v_issued
  FROM inventory_movements
  WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
    AND reference_type='QUALITY_REWORK_INPUT' AND reference_id=NEW.id AND movement_type='ISSUE';
  SELECT COALESCE(sum(quantity),0)::numeric(18,4) INTO v_restored
  FROM inventory_movements
  WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
    AND reference_type='QUALITY_REWORK_RESTORE' AND reference_id=NEW.id AND movement_type='RECEIPT';
  SELECT COALESCE(sum(quantity),0)::numeric(18,4) INTO v_recovered
  FROM inventory_movements
  WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
    AND reference_type='QUALITY_REWORK_OUTPUT' AND reference_id=NEW.id AND movement_type='RECEIPT';

  IF v_current_status IN ('DRAFT','APPROVED') THEN
    IF v_issued<>0 OR v_restored<>0 OR v_recovered<>0 THEN
      RAISE EXCEPTION 'draft/approved rework cannot have inventory postings' USING ERRCODE='23514';
    END IF;
  ELSIF v_current_status IN ('IN_PROGRESS','COMPLETED','REWORK_REQUIRED') THEN
    IF v_issued<>v_input_quantity OR v_restored<>0 OR v_recovered<>0 THEN
      RAISE EXCEPTION 'in-progress/completed rework must hold the full input outside stock and cannot post recovered output before verification'
        USING ERRCODE='23514';
    END IF;
  ELSIF v_current_status='VERIFIED' THEN
    IF v_issued<>v_input_quantity OR v_restored<>0 OR v_recovered<>v_recovered_quantity THEN
      RAISE EXCEPTION 'verified rework requires full source consumption and an exact recovered-output receipt'
        USING ERRCODE='23514';
    END IF;
  ELSIF v_current_status='CANCELLED' THEN
    IF (v_issued=0 AND (v_restored<>0 OR v_recovered<>0))
      OR (v_issued>0 AND (v_issued<>v_input_quantity OR v_restored<>v_issued OR v_recovered<>0)) THEN
      RAISE EXCEPTION 'cancelled rework must fully restore its input stock or have no stock postings'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$factoryos_rework_inventory_evidence$;

DROP TRIGGER IF EXISTS ctr_quality_rework_inventory_reconciliation ON quality_rework_orders;
CREATE CONSTRAINT TRIGGER ctr_quality_rework_inventory_reconciliation
AFTER INSERT OR UPDATE ON quality_rework_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_quality_rework_inventory_reconciliation();

INSERT INTO schema_migrations(version, checksum)
VALUES ('166_quality_rework_inventory_ledger', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
