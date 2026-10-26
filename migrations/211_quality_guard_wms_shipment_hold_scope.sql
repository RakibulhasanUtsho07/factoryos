BEGIN;

-- Correct the scoped quality-hold check for WMS shipments. The exact SHIPPED_AS
-- edge and same-item container binding are authoritative; physical movement
-- location is validated by dispatch before the ledger insert. Permit SEALED or
-- DISPATCHED container state to keep the DB guard robust to trigger ordering,
-- while item-wide holds and holds on any recursively resolved packed leaf still block.
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

  -- A movement row is item-aggregate, not lot-specific. A held source lot
  -- must still block ordinary issues, but a WMS shipment may issue a separately
  -- accepted sibling lot after proving the exact packed leaves from SHIPPED_AS
  -- genealogy. Item-level holds always block; a hold on any shipped leaf blocks.
  IF NOT EXISTS (
    SELECT 1
    FROM quality_holds h
    WHERE h.inventory_item_id=NEW.item_id
      AND h.tenant_id=NEW.tenant_id AND h.factory_id=NEW.factory_id AND h.status='ACTIVE'
      AND (
        h.traceability_unit_id IS NULL
        OR NEW.reference_type IS DISTINCT FROM 'WMS_SHIPMENT'
        OR NOT EXISTS (
          SELECT 1
          FROM product_genealogy_events shipment_edge
          JOIN traceability_units shipment_unit
            ON shipment_unit.id=shipment_edge.target_unit_id
           AND shipment_unit.tenant_id=shipment_edge.tenant_id
           AND shipment_unit.factory_id=shipment_edge.factory_id
          JOIN wms_packing_containers shipment_container
            ON shipment_container.container_unit_id=shipment_edge.source_unit_id
           AND shipment_container.tenant_id=shipment_edge.tenant_id
           AND shipment_container.factory_id=shipment_edge.factory_id
          WHERE shipment_edge.tenant_id=NEW.tenant_id
            AND shipment_edge.factory_id=NEW.factory_id
            AND shipment_edge.relationship_type='SHIPPED_AS'
            AND shipment_edge.target_unit_id=NEW.reference_id
            AND shipment_unit.unit_type='SHIPMENT'
            AND shipment_unit.product_role='SHIPMENT'
            AND shipment_container.item_id=NEW.item_id
                        AND shipment_container.status IN ('SEALED','DISPATCHED')
        )
        OR EXISTS (
          WITH RECURSIVE shipment_units(unit_id) AS (
            SELECT shipment_edge.source_unit_id
            FROM product_genealogy_events shipment_edge
            JOIN traceability_units shipment_unit
              ON shipment_unit.id=shipment_edge.target_unit_id
             AND shipment_unit.tenant_id=shipment_edge.tenant_id
             AND shipment_unit.factory_id=shipment_edge.factory_id
            JOIN wms_packing_containers shipment_container
              ON shipment_container.container_unit_id=shipment_edge.source_unit_id
             AND shipment_container.tenant_id=shipment_edge.tenant_id
             AND shipment_container.factory_id=shipment_edge.factory_id
            WHERE shipment_edge.tenant_id=NEW.tenant_id
              AND shipment_edge.factory_id=NEW.factory_id
              AND shipment_edge.relationship_type='SHIPPED_AS'
              AND shipment_edge.target_unit_id=NEW.reference_id
              AND shipment_unit.unit_type='SHIPMENT'
              AND shipment_unit.product_role='SHIPMENT'
              AND shipment_container.item_id=NEW.item_id
                            AND shipment_container.status IN ('SEALED','DISPATCHED')
            UNION
            SELECT packed.source_unit_id
            FROM shipment_units current_unit
            JOIN wms_packing_contents packed
              ON packed.container_unit_id=current_unit.unit_id
             AND packed.tenant_id=NEW.tenant_id
             AND packed.factory_id=NEW.factory_id
          )
          SELECT 1 FROM shipment_units WHERE unit_id=h.traceability_unit_id
        )
      )
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

INSERT INTO schema_migrations(version, checksum)
VALUES ('211_quality_guard_wms_shipment_hold_scope', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
