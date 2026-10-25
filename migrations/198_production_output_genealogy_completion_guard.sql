-- Require completed work orders to retain their output lot/scrap identities and source-material genealogy.
-- The application writes these facts in the same transaction as material consumption and completion.
BEGIN;

CREATE OR REPLACE FUNCTION factoryos_assert_work_order_output_genealogy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_bad_report UUID;
  v_bad_reservation UUID;
  v_bad_source UUID;
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.status <> 'COMPLETED' OR OLD.status = 'COMPLETED' THEN
    RETURN NULL;
  END IF;

  SELECT r.id
    INTO v_bad_report
  FROM order_production_reports r
  LEFT JOIN traceability_units tu
    ON tu.tenant_id = r.tenant_id AND tu.factory_id = r.factory_id
   AND tu.production_report_id = r.id AND tu.product_role = 'FINISHED_GOOD'
  WHERE r.tenant_id = NEW.tenant_id AND r.factory_id = NEW.factory_id AND r.work_order_id = NEW.id
    AND r.good_quantity > 0
  GROUP BY r.id, r.good_quantity, r.order_id, r.order_line_id
  HAVING count(tu.id) <> 1
    OR COALESCE(sum(tu.quantity), 0) <> r.good_quantity
    OR bool_and(
      tu.unit_type = 'LOT'
      AND tu.inventory_item_id = NEW.finished_item_id
      AND tu.order_id = r.order_id
      AND tu.order_line_id = r.order_line_id
      AND tu.attributes->>'record_kind' = 'PRODUCTION_OUTPUT'
    ) IS NOT TRUE
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'completed work order requires one exact finished-good lot identity for every positive-good production report (%)', v_bad_report
      USING ERRCODE = '23514';
  END IF;

  SELECT r.id
    INTO v_bad_report
  FROM order_production_reports r
  LEFT JOIN traceability_units tu
    ON tu.tenant_id = r.tenant_id AND tu.factory_id = r.factory_id
   AND tu.external_reference = 'production-report:' || r.id::text
   AND tu.product_role = 'OTHER'
   AND tu.attributes->>'record_kind' = 'PRODUCTION_SCRAP'
   AND tu.attributes->>'work_order_id' = NEW.id::text
  WHERE r.tenant_id = NEW.tenant_id AND r.factory_id = NEW.factory_id AND r.work_order_id = NEW.id
    AND r.scrap_quantity > 0
  GROUP BY r.id, r.scrap_quantity, r.order_id, r.order_line_id
  HAVING count(tu.id) <> 1
    OR COALESCE(sum(tu.quantity), 0) <> r.scrap_quantity
    OR bool_and(
      tu.unit_type = 'LOT'
      AND tu.order_id = r.order_id
      AND tu.order_line_id = r.order_line_id
    ) IS NOT TRUE
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'completed work order requires one exact scrap trace identity for every positive-scrap production report (%)', v_bad_report
      USING ERRCODE = '23514';
  END IF;

  -- A tracked item must retain a one-for-one match between consumed quantity and
  -- immutable material-lot/serial issue evidence. Never silently downgrade it.
  SELECT ir.id
    INTO v_bad_reservation
  FROM work_order_material_reservations mr
  JOIN inventory_reservations ir
    ON ir.id = mr.reservation_id AND ir.tenant_id = mr.tenant_id AND ir.factory_id = mr.factory_id
  WHERE mr.tenant_id = NEW.tenant_id AND mr.factory_id = NEW.factory_id
    AND mr.work_order_id = NEW.id AND ir.status = 'CONSUMED'
    AND EXISTS (
      SELECT 1 FROM traceability_units tu
      WHERE tu.tenant_id = ir.tenant_id AND tu.factory_id = ir.factory_id
        AND tu.inventory_item_id = ir.item_id AND tu.product_role = 'MATERIAL'
        AND tu.unit_type IN ('LOT', 'SERIAL')
    )
    AND COALESCE((
      SELECT SUM(c.quantity) FROM inventory_reservation_consumptions c
      WHERE c.tenant_id = ir.tenant_id AND c.factory_id = ir.factory_id AND c.reservation_id = ir.id
    ), 0) <> COALESCE((
      SELECT SUM(a.quantity)
      FROM inventory_reservation_consumptions c
      JOIN inventory_reservation_consumption_traceability_allocations a
        ON a.consumption_id = c.id AND a.tenant_id = c.tenant_id AND a.factory_id = c.factory_id
      WHERE c.tenant_id = ir.tenant_id AND c.factory_id = ir.factory_id AND c.reservation_id = ir.id
    ), 0)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'completed work order has a tracked material reservation without complete lot/serial issue evidence (%)', v_bad_reservation
      USING ERRCODE = '23514';
  END IF;

  -- Every traceable source quantity consumed by this work order must reconcile to
  -- edges ending in its output or scrap targets, and no extra edge may be invented.
  WITH expected AS (
    SELECT a.traceability_unit_id AS source_unit_id, SUM(a.quantity)::numeric(18,4) AS quantity
    FROM inventory_reservation_consumption_traceability_allocations a
    JOIN inventory_reservation_consumptions c
      ON c.id = a.consumption_id AND c.tenant_id = a.tenant_id AND c.factory_id = a.factory_id
    JOIN work_order_material_reservations mr
      ON mr.reservation_id = c.reservation_id AND mr.tenant_id = c.tenant_id AND mr.factory_id = c.factory_id
    WHERE mr.work_order_id = NEW.id AND mr.tenant_id = NEW.tenant_id AND mr.factory_id = NEW.factory_id
    GROUP BY a.traceability_unit_id
  ),
  actual AS (
    SELECT e.source_unit_id, SUM(e.quantity)::numeric(18,4) AS quantity
    FROM product_genealogy_events e
    JOIN traceability_units target
      ON target.id = e.target_unit_id AND target.tenant_id = e.tenant_id AND target.factory_id = e.factory_id
    WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
      AND e.relationship_type IN ('CONSUMED_INTO', 'PROCESSED_INTO')
      AND (
        target.production_report_id IN (
          SELECT r.id FROM order_production_reports r
          WHERE r.tenant_id = NEW.tenant_id AND r.factory_id = NEW.factory_id AND r.work_order_id = NEW.id
        )
        OR (
          target.product_role = 'OTHER'
          AND target.attributes->>'record_kind' = 'PRODUCTION_SCRAP'
          AND target.attributes->>'work_order_id' = NEW.id::text
        )
      )
    GROUP BY e.source_unit_id
  )
  SELECT expected.source_unit_id
    INTO v_bad_source
  FROM expected
  LEFT JOIN actual USING (source_unit_id)
  WHERE expected.quantity <> COALESCE(actual.quantity, 0)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'completed work order material genealogy quantity does not reconcile to consumed lot/serial quantity (%)', v_bad_source
      USING ERRCODE = '23514';
  END IF;

  WITH expected AS (
    SELECT a.traceability_unit_id AS source_unit_id, SUM(a.quantity)::numeric(18,4) AS quantity
    FROM inventory_reservation_consumption_traceability_allocations a
    JOIN inventory_reservation_consumptions c
      ON c.id = a.consumption_id AND c.tenant_id = a.tenant_id AND c.factory_id = a.factory_id
    JOIN work_order_material_reservations mr
      ON mr.reservation_id = c.reservation_id AND mr.tenant_id = c.tenant_id AND mr.factory_id = c.factory_id
    WHERE mr.work_order_id = NEW.id AND mr.tenant_id = NEW.tenant_id AND mr.factory_id = NEW.factory_id
    GROUP BY a.traceability_unit_id
  ),
  actual AS (
    SELECT e.source_unit_id, SUM(e.quantity)::numeric(18,4) AS quantity
    FROM product_genealogy_events e
    JOIN traceability_units target
      ON target.id = e.target_unit_id AND target.tenant_id = e.tenant_id AND target.factory_id = e.factory_id
    WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
      AND e.relationship_type IN ('CONSUMED_INTO', 'PROCESSED_INTO')
      AND (
        target.production_report_id IN (
          SELECT r.id FROM order_production_reports r
          WHERE r.tenant_id = NEW.tenant_id AND r.factory_id = NEW.factory_id AND r.work_order_id = NEW.id
        )
        OR (
          target.product_role = 'OTHER'
          AND target.attributes->>'record_kind' = 'PRODUCTION_SCRAP'
          AND target.attributes->>'work_order_id' = NEW.id::text
        )
      )
    GROUP BY e.source_unit_id
  )
  SELECT actual.source_unit_id
    INTO v_bad_source
  FROM actual
  LEFT JOIN expected USING (source_unit_id)
  WHERE actual.quantity <> COALESCE(expected.quantity, 0)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'completed work order has genealogy evidence without matching consumed material issue quantity (%)', v_bad_source
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_work_order_output_genealogy_completion_guard ON work_orders;
CREATE CONSTRAINT TRIGGER ctr_work_order_output_genealogy_completion_guard
AFTER UPDATE OF status ON work_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION factoryos_assert_work_order_output_genealogy();

INSERT INTO schema_migrations (version, checksum)
VALUES ('198_production_output_genealogy_completion_guard', NULL)
ON CONFLICT (version) DO NOTHING;

COMMENT ON FUNCTION factoryos_assert_work_order_output_genealogy() IS
  'Deferred WP02 acceptance guard: a completed work order must retain exact per-report finished-good and scrap trace identities and a quantity-conserving genealogy from all lot/serial material issues.';

COMMIT;
