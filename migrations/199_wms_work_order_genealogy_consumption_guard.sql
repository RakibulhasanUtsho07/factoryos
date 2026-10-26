BEGIN;

-- WP02: a work-order output genealogy edge is not free-form evidence. It must
-- reference the actual immutable WMS consumption allocation and a posted output
-- lot/scrap identity for the same work order. Deferred guards require the entire
-- consumed lot/serial quantity to be allocated and the work order to complete in
-- the same transaction.
CREATE OR REPLACE FUNCTION factoryos_guard_work_order_output_genealogy_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_output RECORD;
  v_source RECORD;
  v_binding RECORD;
  v_event_total NUMERIC(18,4);
BEGIN
  SELECT p.id AS posting_id, p.production_report_id, p.work_order_id,
         p.finished_item_id, p.good_quantity, p.scrap_quantity,
         r.work_order_id AS report_work_order_id,
         CASE WHEN p.traceability_unit_id = NEW.target_unit_id
           THEN 'FINISHED_GOOD' ELSE 'SCRAP' END AS target_kind
    INTO v_output
  FROM production_output_postings p
  JOIN order_production_reports r
    ON r.id = p.production_report_id AND r.tenant_id = p.tenant_id AND r.factory_id = p.factory_id
  WHERE p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
    AND (p.traceability_unit_id = NEW.target_unit_id OR p.scrap_traceability_unit_id = NEW.target_unit_id)
  FOR SHARE OF p, r;

  -- Legacy/order-level outputs have no work-order material reservations. The
  -- stricter WMS evidence contract applies to output identities for work orders.
  IF NOT FOUND OR v_output.work_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.evidence->>'output_quantity_weight', '') !~ '^[0-9]+(\.[0-9]{1,4})?$' THEN
    RAISE EXCEPTION 'work-order genealogy must include a valid four-decimal output quantity weight'
      USING ERRCODE = '23514';
  END IF;

  IF v_output.target_kind = 'FINISHED_GOOD' THEN
    IF NEW.relationship_type <> 'CONSUMED_INTO'
       OR (NEW.evidence->>'output_quantity_weight')::numeric IS DISTINCT FROM v_output.good_quantity THEN
      RAISE EXCEPTION 'finished-good output genealogy must use CONSUMED_INTO and the canonical accepted output quantity'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.relationship_type <> 'PROCESSED_INTO'
       OR (NEW.evidence->>'output_quantity_weight')::numeric IS DISTINCT FROM v_output.scrap_quantity THEN
      RAISE EXCEPTION 'scrap genealogy must use PROCESSED_INTO and the canonical scrap quantity'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_output.report_work_order_id IS DISTINCT FROM v_output.work_order_id
     OR NEW.evidence->>'source' IS DISTINCT FROM 'WORK_ORDER_MATERIAL_CONSUMPTION'
     OR NEW.evidence->>'work_order_id' IS DISTINCT FROM v_output.work_order_id::text
     OR NEW.evidence->>'production_report_id' IS DISTINCT FROM v_output.production_report_id::text
     OR NEW.evidence->>'production_output_posting_id' IS DISTINCT FROM v_output.posting_id::text
     OR NEW.evidence->>'finished_item_id' IS DISTINCT FROM v_output.finished_item_id::text
     OR NEW.evidence->>'output_identity_kind' IS DISTINCT FROM v_output.target_kind
     OR NEW.evidence->>'source_quantity' IS DISTINCT FROM NEW.quantity::text
     OR NEW.evidence->>'source_unit' IS DISTINCT FROM NEW.unit
     OR COALESCE(NEW.evidence->>'reservation_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(NEW.evidence->>'consumption_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(NEW.evidence->>'consumption_traceability_allocation_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(NEW.evidence->>'source_inventory_item_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION
      'work-order output genealogy must bind canonical report and WMS evidence (report_work_order_match=%, source_match=%, work_order_match=%, report_match=%, posting_match=%, finished_item_match=%, output_kind_match=%, source_quantity_match=%, source_unit_match=%, reservation_uuid=%, consumption_uuid=%, allocation_uuid=%, source_item_uuid=%)',
      v_output.report_work_order_id IS NOT DISTINCT FROM v_output.work_order_id,
      NEW.evidence->>'source' IS NOT DISTINCT FROM 'WORK_ORDER_MATERIAL_CONSUMPTION',
      NEW.evidence->>'work_order_id' IS NOT DISTINCT FROM v_output.work_order_id::text,
      NEW.evidence->>'production_report_id' IS NOT DISTINCT FROM v_output.production_report_id::text,
      NEW.evidence->>'production_output_posting_id' IS NOT DISTINCT FROM v_output.posting_id::text,
      NEW.evidence->>'finished_item_id' IS NOT DISTINCT FROM v_output.finished_item_id::text,
      NEW.evidence->>'output_identity_kind' IS NOT DISTINCT FROM v_output.target_kind,
      NEW.evidence->>'source_quantity' IS NOT DISTINCT FROM NEW.quantity::text,
      NEW.evidence->>'source_unit' IS NOT DISTINCT FROM NEW.unit,
      COALESCE(NEW.evidence->>'reservation_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}
  END IF;
  SELECT ca.id AS allocation_id, ca.quantity AS allocated_quantity,
         ca.traceability_unit_id, c.id AS consumption_id,
         c.reservation_id, c.item_id, tu.unit AS source_unit,
         mr.work_order_id
    INTO v_binding
  FROM inventory_reservation_consumption_traceability_allocations ca
  JOIN inventory_reservation_consumptions c
    ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
  JOIN work_order_material_reservations mr
    ON mr.reservation_id = c.reservation_id
   AND mr.tenant_id = c.tenant_id AND mr.factory_id = c.factory_id
   AND mr.item_id = c.item_id
  JOIN traceability_units tu
    ON tu.id = ca.traceability_unit_id
   AND tu.tenant_id = ca.tenant_id AND tu.factory_id = ca.factory_id
  WHERE ca.id = (NEW.evidence->>'consumption_traceability_allocation_id')::uuid
    AND c.id = (NEW.evidence->>'consumption_id')::uuid
    AND c.reservation_id = (NEW.evidence->>'reservation_id')::uuid
    AND c.item_id = (NEW.evidence->>'source_inventory_item_id')::uuid
    AND ca.traceability_unit_id = NEW.source_unit_id
    AND tu.product_role = 'MATERIAL'
    AND tu.unit_type IN ('LOT', 'SERIAL')
    AND mr.work_order_id = v_output.work_order_id
    AND mr.work_order_id = (NEW.evidence->>'work_order_id')::uuid
  FOR SHARE OF ca, c, mr, tu;

  IF NOT FOUND
     OR NEW.unit IS DISTINCT FROM v_binding.source_unit
     OR NEW.evidence->>'source_inventory_item_id' IS DISTINCT FROM v_binding.item_id::text
     OR NEW.evidence->>'reservation_id' IS DISTINCT FROM v_binding.reservation_id::text
     OR NEW.evidence->>'consumption_id' IS DISTINCT FROM v_binding.consumption_id::text
     OR NEW.evidence->>'consumption_traceability_allocation_id' IS DISTINCT FROM v_binding.allocation_id::text
     OR NEW.quantity <= 0
     OR NEW.quantity > v_binding.allocated_quantity
  THEN
    RAISE EXCEPTION 'work-order genealogy source must be the material lot/serial in the referenced immutable WMS consumption allocation'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
    INTO v_event_total
  FROM product_genealogy_events e
  WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    AND e.evidence->>'source' = 'WORK_ORDER_MATERIAL_CONSUMPTION'
    AND e.evidence->>'consumption_traceability_allocation_id' = v_binding.allocation_id::text;

  IF v_event_total + NEW.quantity > v_binding.allocated_quantity THEN
    RAISE EXCEPTION 'work-order genealogy cannot account for more material than the consumed allocation quantity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_order_output_genealogy_evidence ON product_genealogy_events;
CREATE TRIGGER trg_work_order_output_genealogy_evidence
BEFORE INSERT ON product_genealogy_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_work_order_output_genealogy_evidence();

CREATE OR REPLACE FUNCTION factoryos_assert_work_order_output_genealogy_coverage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_output RECORD;
  v_binding RECORD;
  v_event_total NUMERIC(18,4);
BEGIN
  SELECT p.work_order_id
    INTO v_output
  FROM production_output_postings p
  WHERE p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
    AND (p.traceability_unit_id = NEW.target_unit_id OR p.scrap_traceability_unit_id = NEW.target_unit_id);

  IF NOT FOUND OR v_output.work_order_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT ca.id AS allocation_id, ca.quantity AS allocated_quantity,
         ca.traceability_unit_id, mr.work_order_id
    INTO v_binding
  FROM inventory_reservation_consumption_traceability_allocations ca
  JOIN inventory_reservation_consumptions c
    ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
  JOIN work_order_material_reservations mr
    ON mr.reservation_id = c.reservation_id AND mr.tenant_id = c.tenant_id
   AND mr.factory_id = c.factory_id AND mr.item_id = c.item_id
  WHERE ca.id = (NEW.evidence->>'consumption_traceability_allocation_id')::uuid
    AND ca.tenant_id = NEW.tenant_id AND ca.factory_id = NEW.factory_id
    AND mr.work_order_id = v_output.work_order_id;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM work_orders wo
    WHERE wo.id = v_output.work_order_id
      AND wo.tenant_id = NEW.tenant_id AND wo.factory_id = NEW.factory_id
      AND wo.status = 'COMPLETED'
  ) THEN
    RAISE EXCEPTION 'work-order genealogy requires its canonical completed work order in the same transaction'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
    INTO v_event_total
  FROM product_genealogy_events e
  WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    AND e.source_unit_id = v_binding.traceability_unit_id
    AND e.evidence->>'source' = 'WORK_ORDER_MATERIAL_CONSUMPTION'
    AND e.evidence->>'consumption_traceability_allocation_id' = v_binding.allocation_id::text;

  IF v_event_total IS DISTINCT FROM v_binding.allocated_quantity THEN
    RAISE EXCEPTION 'completed work-order genealogy must conserve the full consumed lot/serial allocation quantity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_work_order_output_genealogy_coverage ON product_genealogy_events;
CREATE CONSTRAINT TRIGGER ctr_work_order_output_genealogy_coverage
AFTER INSERT ON product_genealogy_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_work_order_output_genealogy_coverage();

CREATE OR REPLACE FUNCTION factoryos_assert_work_order_completed_genealogy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_allocation RECORD;
  v_event_total NUMERIC(18,4);
BEGIN
  IF NEW.status IS DISTINCT FROM 'COMPLETED' OR OLD.status = 'COMPLETED' THEN
    RETURN NULL;
  END IF;

  FOR v_allocation IN
    SELECT ca.id AS allocation_id, ca.quantity AS allocated_quantity,
           ca.traceability_unit_id
    FROM inventory_reservation_consumption_traceability_allocations ca
    JOIN inventory_reservation_consumptions c
      ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
    JOIN work_order_material_reservations mr
      ON mr.reservation_id = c.reservation_id AND mr.tenant_id = c.tenant_id
     AND mr.factory_id = c.factory_id AND mr.item_id = c.item_id
    WHERE ca.tenant_id = NEW.tenant_id AND ca.factory_id = NEW.factory_id
      AND mr.work_order_id = NEW.id
  LOOP
    SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
      INTO v_event_total
    FROM product_genealogy_events e
    WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
      AND e.source_unit_id = v_allocation.traceability_unit_id
      AND e.evidence->>'source' = 'WORK_ORDER_MATERIAL_CONSUMPTION'
      AND e.evidence->>'consumption_traceability_allocation_id' = v_allocation.allocation_id::text;

    IF v_event_total IS DISTINCT FROM v_allocation.allocated_quantity THEN
      RAISE EXCEPTION 'work order cannot complete until every consumed lot/serial allocation is fully represented in output genealogy'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_work_order_completed_genealogy ON work_orders;
CREATE CONSTRAINT TRIGGER ctr_work_order_completed_genealogy
AFTER UPDATE ON work_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_work_order_completed_genealogy();

INSERT INTO schema_migrations(version, checksum)
VALUES ('199_wms_work_order_genealogy_consumption_guard', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
,
      COALESCE(NEW.evidence->>'consumption_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}
  END IF;
  SELECT ca.id AS allocation_id, ca.quantity AS allocated_quantity,
         ca.traceability_unit_id, c.id AS consumption_id,
         c.reservation_id, c.item_id, tu.unit AS source_unit,
         mr.work_order_id
    INTO v_binding
  FROM inventory_reservation_consumption_traceability_allocations ca
  JOIN inventory_reservation_consumptions c
    ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
  JOIN work_order_material_reservations mr
    ON mr.reservation_id = c.reservation_id
   AND mr.tenant_id = c.tenant_id AND mr.factory_id = c.factory_id
   AND mr.item_id = c.item_id
  JOIN traceability_units tu
    ON tu.id = ca.traceability_unit_id
   AND tu.tenant_id = ca.tenant_id AND tu.factory_id = ca.factory_id
  WHERE ca.id = (NEW.evidence->>'consumption_traceability_allocation_id')::uuid
    AND c.id = (NEW.evidence->>'consumption_id')::uuid
    AND c.reservation_id = (NEW.evidence->>'reservation_id')::uuid
    AND c.item_id = (NEW.evidence->>'source_inventory_item_id')::uuid
    AND ca.traceability_unit_id = NEW.source_unit_id
    AND tu.product_role = 'MATERIAL'
    AND tu.unit_type IN ('LOT', 'SERIAL')
    AND mr.work_order_id = v_output.work_order_id
    AND mr.work_order_id = (NEW.evidence->>'work_order_id')::uuid
  FOR SHARE OF ca, c, mr, tu;

  IF NOT FOUND
     OR NEW.unit IS DISTINCT FROM v_binding.source_unit
     OR NEW.evidence->>'source_inventory_item_id' IS DISTINCT FROM v_binding.item_id::text
     OR NEW.evidence->>'reservation_id' IS DISTINCT FROM v_binding.reservation_id::text
     OR NEW.evidence->>'consumption_id' IS DISTINCT FROM v_binding.consumption_id::text
     OR NEW.evidence->>'consumption_traceability_allocation_id' IS DISTINCT FROM v_binding.allocation_id::text
     OR NEW.quantity <= 0
     OR NEW.quantity > v_binding.allocated_quantity
  THEN
    RAISE EXCEPTION 'work-order genealogy source must be the material lot/serial in the referenced immutable WMS consumption allocation'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
    INTO v_event_total
  FROM product_genealogy_events e
  WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    AND e.evidence->>'source' = 'WORK_ORDER_MATERIAL_CONSUMPTION'
    AND e.evidence->>'consumption_traceability_allocation_id' = v_binding.allocation_id::text;

  IF v_event_total + NEW.quantity > v_binding.allocated_quantity THEN
    RAISE EXCEPTION 'work-order genealogy cannot account for more material than the consumed allocation quantity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_order_output_genealogy_evidence ON product_genealogy_events;
CREATE TRIGGER trg_work_order_output_genealogy_evidence
BEFORE INSERT ON product_genealogy_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_work_order_output_genealogy_evidence();

CREATE OR REPLACE FUNCTION factoryos_assert_work_order_output_genealogy_coverage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_output RECORD;
  v_binding RECORD;
  v_event_total NUMERIC(18,4);
BEGIN
  SELECT p.work_order_id
    INTO v_output
  FROM production_output_postings p
  WHERE p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
    AND (p.traceability_unit_id = NEW.target_unit_id OR p.scrap_traceability_unit_id = NEW.target_unit_id);

  IF NOT FOUND OR v_output.work_order_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT ca.id AS allocation_id, ca.quantity AS allocated_quantity,
         ca.traceability_unit_id, mr.work_order_id
    INTO v_binding
  FROM inventory_reservation_consumption_traceability_allocations ca
  JOIN inventory_reservation_consumptions c
    ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
  JOIN work_order_material_reservations mr
    ON mr.reservation_id = c.reservation_id AND mr.tenant_id = c.tenant_id
   AND mr.factory_id = c.factory_id AND mr.item_id = c.item_id
  WHERE ca.id = (NEW.evidence->>'consumption_traceability_allocation_id')::uuid
    AND ca.tenant_id = NEW.tenant_id AND ca.factory_id = NEW.factory_id
    AND mr.work_order_id = v_output.work_order_id;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM work_orders wo
    WHERE wo.id = v_output.work_order_id
      AND wo.tenant_id = NEW.tenant_id AND wo.factory_id = NEW.factory_id
      AND wo.status = 'COMPLETED'
  ) THEN
    RAISE EXCEPTION 'work-order genealogy requires its canonical completed work order in the same transaction'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
    INTO v_event_total
  FROM product_genealogy_events e
  WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    AND e.source_unit_id = v_binding.traceability_unit_id
    AND e.evidence->>'source' = 'WORK_ORDER_MATERIAL_CONSUMPTION'
    AND e.evidence->>'consumption_traceability_allocation_id' = v_binding.allocation_id::text;

  IF v_event_total IS DISTINCT FROM v_binding.allocated_quantity THEN
    RAISE EXCEPTION 'completed work-order genealogy must conserve the full consumed lot/serial allocation quantity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_work_order_output_genealogy_coverage ON product_genealogy_events;
CREATE CONSTRAINT TRIGGER ctr_work_order_output_genealogy_coverage
AFTER INSERT ON product_genealogy_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_work_order_output_genealogy_coverage();

CREATE OR REPLACE FUNCTION factoryos_assert_work_order_completed_genealogy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_allocation RECORD;
  v_event_total NUMERIC(18,4);
BEGIN
  IF NEW.status IS DISTINCT FROM 'COMPLETED' OR OLD.status = 'COMPLETED' THEN
    RETURN NULL;
  END IF;

  FOR v_allocation IN
    SELECT ca.id AS allocation_id, ca.quantity AS allocated_quantity,
           ca.traceability_unit_id
    FROM inventory_reservation_consumption_traceability_allocations ca
    JOIN inventory_reservation_consumptions c
      ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
    JOIN work_order_material_reservations mr
      ON mr.reservation_id = c.reservation_id AND mr.tenant_id = c.tenant_id
     AND mr.factory_id = c.factory_id AND mr.item_id = c.item_id
    WHERE ca.tenant_id = NEW.tenant_id AND ca.factory_id = NEW.factory_id
      AND mr.work_order_id = NEW.id
  LOOP
    SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
      INTO v_event_total
    FROM product_genealogy_events e
    WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
      AND e.source_unit_id = v_allocation.traceability_unit_id
      AND e.evidence->>'source' = 'WORK_ORDER_MATERIAL_CONSUMPTION'
      AND e.evidence->>'consumption_traceability_allocation_id' = v_allocation.allocation_id::text;

    IF v_event_total IS DISTINCT FROM v_allocation.allocated_quantity THEN
      RAISE EXCEPTION 'work order cannot complete until every consumed lot/serial allocation is fully represented in output genealogy'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_work_order_completed_genealogy ON work_orders;
CREATE CONSTRAINT TRIGGER ctr_work_order_completed_genealogy
AFTER UPDATE ON work_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_work_order_completed_genealogy();

INSERT INTO schema_migrations(version, checksum)
VALUES ('199_wms_work_order_genealogy_consumption_guard', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
,
      COALESCE(NEW.evidence->>'consumption_traceability_allocation_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}
  END IF;
  SELECT ca.id AS allocation_id, ca.quantity AS allocated_quantity,
         ca.traceability_unit_id, c.id AS consumption_id,
         c.reservation_id, c.item_id, tu.unit AS source_unit,
         mr.work_order_id
    INTO v_binding
  FROM inventory_reservation_consumption_traceability_allocations ca
  JOIN inventory_reservation_consumptions c
    ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
  JOIN work_order_material_reservations mr
    ON mr.reservation_id = c.reservation_id
   AND mr.tenant_id = c.tenant_id AND mr.factory_id = c.factory_id
   AND mr.item_id = c.item_id
  JOIN traceability_units tu
    ON tu.id = ca.traceability_unit_id
   AND tu.tenant_id = ca.tenant_id AND tu.factory_id = ca.factory_id
  WHERE ca.id = (NEW.evidence->>'consumption_traceability_allocation_id')::uuid
    AND c.id = (NEW.evidence->>'consumption_id')::uuid
    AND c.reservation_id = (NEW.evidence->>'reservation_id')::uuid
    AND c.item_id = (NEW.evidence->>'source_inventory_item_id')::uuid
    AND ca.traceability_unit_id = NEW.source_unit_id
    AND tu.product_role = 'MATERIAL'
    AND tu.unit_type IN ('LOT', 'SERIAL')
    AND mr.work_order_id = v_output.work_order_id
    AND mr.work_order_id = (NEW.evidence->>'work_order_id')::uuid
  FOR SHARE OF ca, c, mr, tu;

  IF NOT FOUND
     OR NEW.unit IS DISTINCT FROM v_binding.source_unit
     OR NEW.evidence->>'source_inventory_item_id' IS DISTINCT FROM v_binding.item_id::text
     OR NEW.evidence->>'reservation_id' IS DISTINCT FROM v_binding.reservation_id::text
     OR NEW.evidence->>'consumption_id' IS DISTINCT FROM v_binding.consumption_id::text
     OR NEW.evidence->>'consumption_traceability_allocation_id' IS DISTINCT FROM v_binding.allocation_id::text
     OR NEW.quantity <= 0
     OR NEW.quantity > v_binding.allocated_quantity
  THEN
    RAISE EXCEPTION 'work-order genealogy source must be the material lot/serial in the referenced immutable WMS consumption allocation'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
    INTO v_event_total
  FROM product_genealogy_events e
  WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    AND e.evidence->>'source' = 'WORK_ORDER_MATERIAL_CONSUMPTION'
    AND e.evidence->>'consumption_traceability_allocation_id' = v_binding.allocation_id::text;

  IF v_event_total + NEW.quantity > v_binding.allocated_quantity THEN
    RAISE EXCEPTION 'work-order genealogy cannot account for more material than the consumed allocation quantity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_order_output_genealogy_evidence ON product_genealogy_events;
CREATE TRIGGER trg_work_order_output_genealogy_evidence
BEFORE INSERT ON product_genealogy_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_work_order_output_genealogy_evidence();

CREATE OR REPLACE FUNCTION factoryos_assert_work_order_output_genealogy_coverage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_output RECORD;
  v_binding RECORD;
  v_event_total NUMERIC(18,4);
BEGIN
  SELECT p.work_order_id
    INTO v_output
  FROM production_output_postings p
  WHERE p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
    AND (p.traceability_unit_id = NEW.target_unit_id OR p.scrap_traceability_unit_id = NEW.target_unit_id);

  IF NOT FOUND OR v_output.work_order_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT ca.id AS allocation_id, ca.quantity AS allocated_quantity,
         ca.traceability_unit_id, mr.work_order_id
    INTO v_binding
  FROM inventory_reservation_consumption_traceability_allocations ca
  JOIN inventory_reservation_consumptions c
    ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
  JOIN work_order_material_reservations mr
    ON mr.reservation_id = c.reservation_id AND mr.tenant_id = c.tenant_id
   AND mr.factory_id = c.factory_id AND mr.item_id = c.item_id
  WHERE ca.id = (NEW.evidence->>'consumption_traceability_allocation_id')::uuid
    AND ca.tenant_id = NEW.tenant_id AND ca.factory_id = NEW.factory_id
    AND mr.work_order_id = v_output.work_order_id;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM work_orders wo
    WHERE wo.id = v_output.work_order_id
      AND wo.tenant_id = NEW.tenant_id AND wo.factory_id = NEW.factory_id
      AND wo.status = 'COMPLETED'
  ) THEN
    RAISE EXCEPTION 'work-order genealogy requires its canonical completed work order in the same transaction'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
    INTO v_event_total
  FROM product_genealogy_events e
  WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    AND e.source_unit_id = v_binding.traceability_unit_id
    AND e.evidence->>'source' = 'WORK_ORDER_MATERIAL_CONSUMPTION'
    AND e.evidence->>'consumption_traceability_allocation_id' = v_binding.allocation_id::text;

  IF v_event_total IS DISTINCT FROM v_binding.allocated_quantity THEN
    RAISE EXCEPTION 'completed work-order genealogy must conserve the full consumed lot/serial allocation quantity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_work_order_output_genealogy_coverage ON product_genealogy_events;
CREATE CONSTRAINT TRIGGER ctr_work_order_output_genealogy_coverage
AFTER INSERT ON product_genealogy_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_work_order_output_genealogy_coverage();

CREATE OR REPLACE FUNCTION factoryos_assert_work_order_completed_genealogy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_allocation RECORD;
  v_event_total NUMERIC(18,4);
BEGIN
  IF NEW.status IS DISTINCT FROM 'COMPLETED' OR OLD.status = 'COMPLETED' THEN
    RETURN NULL;
  END IF;

  FOR v_allocation IN
    SELECT ca.id AS allocation_id, ca.quantity AS allocated_quantity,
           ca.traceability_unit_id
    FROM inventory_reservation_consumption_traceability_allocations ca
    JOIN inventory_reservation_consumptions c
      ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
    JOIN work_order_material_reservations mr
      ON mr.reservation_id = c.reservation_id AND mr.tenant_id = c.tenant_id
     AND mr.factory_id = c.factory_id AND mr.item_id = c.item_id
    WHERE ca.tenant_id = NEW.tenant_id AND ca.factory_id = NEW.factory_id
      AND mr.work_order_id = NEW.id
  LOOP
    SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
      INTO v_event_total
    FROM product_genealogy_events e
    WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
      AND e.source_unit_id = v_allocation.traceability_unit_id
      AND e.evidence->>'source' = 'WORK_ORDER_MATERIAL_CONSUMPTION'
      AND e.evidence->>'consumption_traceability_allocation_id' = v_allocation.allocation_id::text;

    IF v_event_total IS DISTINCT FROM v_allocation.allocated_quantity THEN
      RAISE EXCEPTION 'work order cannot complete until every consumed lot/serial allocation is fully represented in output genealogy'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_work_order_completed_genealogy ON work_orders;
CREATE CONSTRAINT TRIGGER ctr_work_order_completed_genealogy
AFTER UPDATE ON work_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_work_order_completed_genealogy();

INSERT INTO schema_migrations(version, checksum)
VALUES ('199_wms_work_order_genealogy_consumption_guard', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
,
      COALESCE(NEW.evidence->>'source_inventory_item_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}
  END IF;
  SELECT ca.id AS allocation_id, ca.quantity AS allocated_quantity,
         ca.traceability_unit_id, c.id AS consumption_id,
         c.reservation_id, c.item_id, tu.unit AS source_unit,
         mr.work_order_id
    INTO v_binding
  FROM inventory_reservation_consumption_traceability_allocations ca
  JOIN inventory_reservation_consumptions c
    ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
  JOIN work_order_material_reservations mr
    ON mr.reservation_id = c.reservation_id
   AND mr.tenant_id = c.tenant_id AND mr.factory_id = c.factory_id
   AND mr.item_id = c.item_id
  JOIN traceability_units tu
    ON tu.id = ca.traceability_unit_id
   AND tu.tenant_id = ca.tenant_id AND tu.factory_id = ca.factory_id
  WHERE ca.id = (NEW.evidence->>'consumption_traceability_allocation_id')::uuid
    AND c.id = (NEW.evidence->>'consumption_id')::uuid
    AND c.reservation_id = (NEW.evidence->>'reservation_id')::uuid
    AND c.item_id = (NEW.evidence->>'source_inventory_item_id')::uuid
    AND ca.traceability_unit_id = NEW.source_unit_id
    AND tu.product_role = 'MATERIAL'
    AND tu.unit_type IN ('LOT', 'SERIAL')
    AND mr.work_order_id = v_output.work_order_id
    AND mr.work_order_id = (NEW.evidence->>'work_order_id')::uuid
  FOR SHARE OF ca, c, mr, tu;

  IF NOT FOUND
     OR NEW.unit IS DISTINCT FROM v_binding.source_unit
     OR NEW.evidence->>'source_inventory_item_id' IS DISTINCT FROM v_binding.item_id::text
     OR NEW.evidence->>'reservation_id' IS DISTINCT FROM v_binding.reservation_id::text
     OR NEW.evidence->>'consumption_id' IS DISTINCT FROM v_binding.consumption_id::text
     OR NEW.evidence->>'consumption_traceability_allocation_id' IS DISTINCT FROM v_binding.allocation_id::text
     OR NEW.quantity <= 0
     OR NEW.quantity > v_binding.allocated_quantity
  THEN
    RAISE EXCEPTION 'work-order genealogy source must be the material lot/serial in the referenced immutable WMS consumption allocation'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
    INTO v_event_total
  FROM product_genealogy_events e
  WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    AND e.evidence->>'source' = 'WORK_ORDER_MATERIAL_CONSUMPTION'
    AND e.evidence->>'consumption_traceability_allocation_id' = v_binding.allocation_id::text;

  IF v_event_total + NEW.quantity > v_binding.allocated_quantity THEN
    RAISE EXCEPTION 'work-order genealogy cannot account for more material than the consumed allocation quantity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_order_output_genealogy_evidence ON product_genealogy_events;
CREATE TRIGGER trg_work_order_output_genealogy_evidence
BEFORE INSERT ON product_genealogy_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_work_order_output_genealogy_evidence();

CREATE OR REPLACE FUNCTION factoryos_assert_work_order_output_genealogy_coverage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_output RECORD;
  v_binding RECORD;
  v_event_total NUMERIC(18,4);
BEGIN
  SELECT p.work_order_id
    INTO v_output
  FROM production_output_postings p
  WHERE p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
    AND (p.traceability_unit_id = NEW.target_unit_id OR p.scrap_traceability_unit_id = NEW.target_unit_id);

  IF NOT FOUND OR v_output.work_order_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT ca.id AS allocation_id, ca.quantity AS allocated_quantity,
         ca.traceability_unit_id, mr.work_order_id
    INTO v_binding
  FROM inventory_reservation_consumption_traceability_allocations ca
  JOIN inventory_reservation_consumptions c
    ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
  JOIN work_order_material_reservations mr
    ON mr.reservation_id = c.reservation_id AND mr.tenant_id = c.tenant_id
   AND mr.factory_id = c.factory_id AND mr.item_id = c.item_id
  WHERE ca.id = (NEW.evidence->>'consumption_traceability_allocation_id')::uuid
    AND ca.tenant_id = NEW.tenant_id AND ca.factory_id = NEW.factory_id
    AND mr.work_order_id = v_output.work_order_id;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM work_orders wo
    WHERE wo.id = v_output.work_order_id
      AND wo.tenant_id = NEW.tenant_id AND wo.factory_id = NEW.factory_id
      AND wo.status = 'COMPLETED'
  ) THEN
    RAISE EXCEPTION 'work-order genealogy requires its canonical completed work order in the same transaction'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
    INTO v_event_total
  FROM product_genealogy_events e
  WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    AND e.source_unit_id = v_binding.traceability_unit_id
    AND e.evidence->>'source' = 'WORK_ORDER_MATERIAL_CONSUMPTION'
    AND e.evidence->>'consumption_traceability_allocation_id' = v_binding.allocation_id::text;

  IF v_event_total IS DISTINCT FROM v_binding.allocated_quantity THEN
    RAISE EXCEPTION 'completed work-order genealogy must conserve the full consumed lot/serial allocation quantity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_work_order_output_genealogy_coverage ON product_genealogy_events;
CREATE CONSTRAINT TRIGGER ctr_work_order_output_genealogy_coverage
AFTER INSERT ON product_genealogy_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_work_order_output_genealogy_coverage();

CREATE OR REPLACE FUNCTION factoryos_assert_work_order_completed_genealogy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_allocation RECORD;
  v_event_total NUMERIC(18,4);
BEGIN
  IF NEW.status IS DISTINCT FROM 'COMPLETED' OR OLD.status = 'COMPLETED' THEN
    RETURN NULL;
  END IF;

  FOR v_allocation IN
    SELECT ca.id AS allocation_id, ca.quantity AS allocated_quantity,
           ca.traceability_unit_id
    FROM inventory_reservation_consumption_traceability_allocations ca
    JOIN inventory_reservation_consumptions c
      ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
    JOIN work_order_material_reservations mr
      ON mr.reservation_id = c.reservation_id AND mr.tenant_id = c.tenant_id
     AND mr.factory_id = c.factory_id AND mr.item_id = c.item_id
    WHERE ca.tenant_id = NEW.tenant_id AND ca.factory_id = NEW.factory_id
      AND mr.work_order_id = NEW.id
  LOOP
    SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
      INTO v_event_total
    FROM product_genealogy_events e
    WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
      AND e.source_unit_id = v_allocation.traceability_unit_id
      AND e.evidence->>'source' = 'WORK_ORDER_MATERIAL_CONSUMPTION'
      AND e.evidence->>'consumption_traceability_allocation_id' = v_allocation.allocation_id::text;

    IF v_event_total IS DISTINCT FROM v_allocation.allocated_quantity THEN
      RAISE EXCEPTION 'work order cannot complete until every consumed lot/serial allocation is fully represented in output genealogy'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_work_order_completed_genealogy ON work_orders;
CREATE CONSTRAINT TRIGGER ctr_work_order_completed_genealogy
AFTER UPDATE ON work_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_work_order_completed_genealogy();

INSERT INTO schema_migrations(version, checksum)
VALUES ('199_wms_work_order_genealogy_consumption_guard', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;

      USING ERRCODE = '23514';
  END IF;
  SELECT ca.id AS allocation_id, ca.quantity AS allocated_quantity,
         ca.traceability_unit_id, c.id AS consumption_id,
         c.reservation_id, c.item_id, tu.unit AS source_unit,
         mr.work_order_id
    INTO v_binding
  FROM inventory_reservation_consumption_traceability_allocations ca
  JOIN inventory_reservation_consumptions c
    ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
  JOIN work_order_material_reservations mr
    ON mr.reservation_id = c.reservation_id
   AND mr.tenant_id = c.tenant_id AND mr.factory_id = c.factory_id
   AND mr.item_id = c.item_id
  JOIN traceability_units tu
    ON tu.id = ca.traceability_unit_id
   AND tu.tenant_id = ca.tenant_id AND tu.factory_id = ca.factory_id
  WHERE ca.id = (NEW.evidence->>'consumption_traceability_allocation_id')::uuid
    AND c.id = (NEW.evidence->>'consumption_id')::uuid
    AND c.reservation_id = (NEW.evidence->>'reservation_id')::uuid
    AND c.item_id = (NEW.evidence->>'source_inventory_item_id')::uuid
    AND ca.traceability_unit_id = NEW.source_unit_id
    AND tu.product_role = 'MATERIAL'
    AND tu.unit_type IN ('LOT', 'SERIAL')
    AND mr.work_order_id = v_output.work_order_id
    AND mr.work_order_id = (NEW.evidence->>'work_order_id')::uuid
  FOR SHARE OF ca, c, mr, tu;

  IF NOT FOUND
     OR NEW.unit IS DISTINCT FROM v_binding.source_unit
     OR NEW.evidence->>'source_inventory_item_id' IS DISTINCT FROM v_binding.item_id::text
     OR NEW.evidence->>'reservation_id' IS DISTINCT FROM v_binding.reservation_id::text
     OR NEW.evidence->>'consumption_id' IS DISTINCT FROM v_binding.consumption_id::text
     OR NEW.evidence->>'consumption_traceability_allocation_id' IS DISTINCT FROM v_binding.allocation_id::text
     OR NEW.quantity <= 0
     OR NEW.quantity > v_binding.allocated_quantity
  THEN
    RAISE EXCEPTION 'work-order genealogy source must be the material lot/serial in the referenced immutable WMS consumption allocation'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
    INTO v_event_total
  FROM product_genealogy_events e
  WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    AND e.evidence->>'source' = 'WORK_ORDER_MATERIAL_CONSUMPTION'
    AND e.evidence->>'consumption_traceability_allocation_id' = v_binding.allocation_id::text;

  IF v_event_total + NEW.quantity > v_binding.allocated_quantity THEN
    RAISE EXCEPTION 'work-order genealogy cannot account for more material than the consumed allocation quantity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_order_output_genealogy_evidence ON product_genealogy_events;
CREATE TRIGGER trg_work_order_output_genealogy_evidence
BEFORE INSERT ON product_genealogy_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_work_order_output_genealogy_evidence();

CREATE OR REPLACE FUNCTION factoryos_assert_work_order_output_genealogy_coverage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_output RECORD;
  v_binding RECORD;
  v_event_total NUMERIC(18,4);
BEGIN
  SELECT p.work_order_id
    INTO v_output
  FROM production_output_postings p
  WHERE p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
    AND (p.traceability_unit_id = NEW.target_unit_id OR p.scrap_traceability_unit_id = NEW.target_unit_id);

  IF NOT FOUND OR v_output.work_order_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT ca.id AS allocation_id, ca.quantity AS allocated_quantity,
         ca.traceability_unit_id, mr.work_order_id
    INTO v_binding
  FROM inventory_reservation_consumption_traceability_allocations ca
  JOIN inventory_reservation_consumptions c
    ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
  JOIN work_order_material_reservations mr
    ON mr.reservation_id = c.reservation_id AND mr.tenant_id = c.tenant_id
   AND mr.factory_id = c.factory_id AND mr.item_id = c.item_id
  WHERE ca.id = (NEW.evidence->>'consumption_traceability_allocation_id')::uuid
    AND ca.tenant_id = NEW.tenant_id AND ca.factory_id = NEW.factory_id
    AND mr.work_order_id = v_output.work_order_id;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM work_orders wo
    WHERE wo.id = v_output.work_order_id
      AND wo.tenant_id = NEW.tenant_id AND wo.factory_id = NEW.factory_id
      AND wo.status = 'COMPLETED'
  ) THEN
    RAISE EXCEPTION 'work-order genealogy requires its canonical completed work order in the same transaction'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
    INTO v_event_total
  FROM product_genealogy_events e
  WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    AND e.source_unit_id = v_binding.traceability_unit_id
    AND e.evidence->>'source' = 'WORK_ORDER_MATERIAL_CONSUMPTION'
    AND e.evidence->>'consumption_traceability_allocation_id' = v_binding.allocation_id::text;

  IF v_event_total IS DISTINCT FROM v_binding.allocated_quantity THEN
    RAISE EXCEPTION 'completed work-order genealogy must conserve the full consumed lot/serial allocation quantity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_work_order_output_genealogy_coverage ON product_genealogy_events;
CREATE CONSTRAINT TRIGGER ctr_work_order_output_genealogy_coverage
AFTER INSERT ON product_genealogy_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_work_order_output_genealogy_coverage();

CREATE OR REPLACE FUNCTION factoryos_assert_work_order_completed_genealogy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_allocation RECORD;
  v_event_total NUMERIC(18,4);
BEGIN
  IF NEW.status IS DISTINCT FROM 'COMPLETED' OR OLD.status = 'COMPLETED' THEN
    RETURN NULL;
  END IF;

  FOR v_allocation IN
    SELECT ca.id AS allocation_id, ca.quantity AS allocated_quantity,
           ca.traceability_unit_id
    FROM inventory_reservation_consumption_traceability_allocations ca
    JOIN inventory_reservation_consumptions c
      ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
    JOIN work_order_material_reservations mr
      ON mr.reservation_id = c.reservation_id AND mr.tenant_id = c.tenant_id
     AND mr.factory_id = c.factory_id AND mr.item_id = c.item_id
    WHERE ca.tenant_id = NEW.tenant_id AND ca.factory_id = NEW.factory_id
      AND mr.work_order_id = NEW.id
  LOOP
    SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
      INTO v_event_total
    FROM product_genealogy_events e
    WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
      AND e.source_unit_id = v_allocation.traceability_unit_id
      AND e.evidence->>'source' = 'WORK_ORDER_MATERIAL_CONSUMPTION'
      AND e.evidence->>'consumption_traceability_allocation_id' = v_allocation.allocation_id::text;

    IF v_event_total IS DISTINCT FROM v_allocation.allocated_quantity THEN
      RAISE EXCEPTION 'work order cannot complete until every consumed lot/serial allocation is fully represented in output genealogy'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_work_order_completed_genealogy ON work_orders;
CREATE CONSTRAINT TRIGGER ctr_work_order_completed_genealogy
AFTER UPDATE ON work_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_work_order_completed_genealogy();

INSERT INTO schema_migrations(version, checksum)
VALUES ('199_wms_work_order_genealogy_consumption_guard', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
