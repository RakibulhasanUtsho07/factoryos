BEGIN;

-- One work-order output posting may represent several one-piece finished-good
-- SERIAL identities. The posting's legacy traceability_unit_id remains the
-- first SERIAL identity (unit_sequence=1) for backwards-compatible readers.
LOCK TABLE production_output_postings, traceability_units, product_genealogy_events
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS production_output_posting_serial_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  factory_id uuid NOT NULL,
  production_output_posting_id uuid NOT NULL
    REFERENCES production_output_postings(id) ON DELETE RESTRICT,
  production_report_id uuid NOT NULL
    REFERENCES order_production_reports(id) ON DELETE RESTRICT,
  finished_item_id uuid NOT NULL,
  traceability_unit_id uuid NOT NULL,
  unit_sequence integer NOT NULL CHECK (unit_sequence BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_production_output_posting_serial_unit_identity
    FOREIGN KEY (traceability_unit_id, tenant_id, factory_id, finished_item_id)
    REFERENCES traceability_units (id, tenant_id, factory_id, inventory_item_id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_production_output_posting_serial_sequence
    UNIQUE (production_output_posting_id, unit_sequence),
  CONSTRAINT uq_production_output_posting_serial_identity
    UNIQUE (traceability_unit_id)
);

CREATE INDEX IF NOT EXISTS ix_production_output_posting_serial_units_scope
  ON production_output_posting_serial_units
    (tenant_id, factory_id, production_output_posting_id, unit_sequence);

ALTER TABLE production_output_posting_serial_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_output_posting_serial_units FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS production_output_posting_serial_units_tenant_allow
  ON production_output_posting_serial_units;
DROP POLICY IF EXISTS production_output_posting_serial_units_tenant_enforce
  ON production_output_posting_serial_units;
CREATE POLICY production_output_posting_serial_units_tenant_allow
  ON production_output_posting_serial_units AS PERMISSIVE FOR ALL
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
CREATE POLICY production_output_posting_serial_units_tenant_enforce
  ON production_output_posting_serial_units AS RESTRICTIVE FOR ALL
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

-- Historical single-SERIAL postings are represented in the new authoritative
-- serial membership ledger before the stricter deferred completeness guard lands.
INSERT INTO production_output_posting_serial_units (
  tenant_id, factory_id, production_output_posting_id, production_report_id,
  finished_item_id, traceability_unit_id, unit_sequence
)
SELECT p.tenant_id, p.factory_id, p.id, p.production_report_id,
       p.finished_item_id, p.traceability_unit_id, 1
FROM production_output_postings p
JOIN traceability_units u
  ON u.id = p.traceability_unit_id
 AND u.tenant_id = p.tenant_id AND u.factory_id = p.factory_id
WHERE u.unit_type = 'SERIAL'
ON CONFLICT (traceability_unit_id) DO NOTHING;

CREATE OR REPLACE FUNCTION factoryos_guard_production_output_traceability_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_report_order_id uuid;
  v_report_order_line_id uuid;
  v_trace record;
BEGIN
  SELECT r.order_id, r.order_line_id
    INTO v_report_order_id, v_report_order_line_id
  FROM order_production_reports r
  WHERE r.id = NEW.production_report_id
    AND r.tenant_id = NEW.tenant_id
    AND r.factory_id = NEW.factory_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'production traceability requires a report in the same tenant/factory'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.good_quantity > 0 THEN
    IF NEW.traceability_unit_id IS NULL THEN
      RAISE EXCEPTION 'positive accepted good output requires a finished-good LOT or SERIAL identity'
        USING ERRCODE = '23514';
    END IF;

    SELECT u.unit_type, u.product_role, u.inventory_item_id, u.quantity,
           u.unit, u.status, u.production_report_id, u.order_id, u.order_line_id
      INTO v_trace
    FROM traceability_units u
    WHERE u.id = NEW.traceability_unit_id
      AND u.tenant_id = NEW.tenant_id
      AND u.factory_id = NEW.factory_id
    FOR SHARE;

    IF NOT FOUND
      OR v_trace.unit_type NOT IN ('LOT', 'SERIAL')
      OR v_trace.product_role <> 'FINISHED_GOOD'
      OR v_trace.inventory_item_id IS DISTINCT FROM NEW.finished_item_id
      OR v_trace.unit IS NULL
      OR v_trace.status <> 'ACTIVE'
      OR v_trace.production_report_id IS DISTINCT FROM NEW.production_report_id
      OR v_trace.order_id IS DISTINCT FROM v_report_order_id
      OR v_trace.order_line_id IS DISTINCT FROM v_report_order_line_id
      OR (v_trace.unit_type = 'SERIAL' AND (
        v_trace.quantity IS DISTINCT FROM 1.0000::numeric
        OR NEW.good_quantity < 1
        OR NEW.good_quantity <> trunc(NEW.good_quantity)
        OR NEW.good_quantity > 100
      ))
      OR (v_trace.unit_type = 'LOT' AND v_trace.quantity IS DISTINCT FROM NEW.good_quantity)
    THEN
      RAISE EXCEPTION 'finished-good LOT/SERIAL identity must match report, item, order line and accepted quantity; every SERIAL identity represents exactly one whole good unit'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.traceability_unit_id IS NOT NULL THEN
    RAISE EXCEPTION 'scrap-only output cannot have a sellable finished-good identity'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.scrap_quantity > 0 THEN
    IF NEW.scrap_traceability_unit_id IS NULL THEN
      RAISE EXCEPTION 'positive scrap quantity requires a non-sellable scrap traceability identity'
        USING ERRCODE = '23514';
    END IF;

    SELECT u.unit_type, u.product_role, u.inventory_item_id, u.quantity,
           u.unit, u.status, u.attributes
      INTO v_trace
    FROM traceability_units u
    WHERE u.id = NEW.scrap_traceability_unit_id
      AND u.tenant_id = NEW.tenant_id
      AND u.factory_id = NEW.factory_id
    FOR SHARE;

    IF NOT FOUND
      OR v_trace.unit_type <> 'LOT'
      OR v_trace.product_role <> 'OTHER'
      OR v_trace.inventory_item_id IS NOT NULL
      OR v_trace.quantity IS DISTINCT FROM NEW.scrap_quantity
      OR v_trace.status <> 'ACTIVE'
      OR v_trace.attributes->>'kind' <> 'PRODUCTION_SCRAP'
      OR v_trace.attributes->>'production_report_id' <> NEW.production_report_id::text
      OR v_trace.attributes->>'finished_item_id' <> NEW.finished_item_id::text
    THEN
      RAISE EXCEPTION 'scrap traceability identity must match this report and remain outside sellable inventory'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.scrap_traceability_unit_id IS NOT NULL THEN
    RAISE EXCEPTION 'zero scrap quantity cannot have a scrap traceability identity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_production_output_serial_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_posting record;
  v_report record;
  v_unit record;
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'finished-good SERIAL posting membership is append-only'
      USING ERRCODE = '55000';
  END IF;

  SELECT p.id, p.tenant_id, p.factory_id, p.production_report_id,
         p.finished_item_id, p.traceability_unit_id, p.good_quantity,
         r.order_id, r.order_line_id
    INTO v_posting
  FROM production_output_postings p
  JOIN order_production_reports r
    ON r.id=p.production_report_id AND r.tenant_id=p.tenant_id AND r.factory_id=p.factory_id
  WHERE p.id=NEW.production_output_posting_id
    AND p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id
  FOR SHARE OF p,r;

  SELECT u.unit_type, u.product_role, u.inventory_item_id, u.quantity,
         u.unit, u.status, u.production_report_id, u.order_id, u.order_line_id
    INTO v_unit
  FROM traceability_units u
  WHERE u.id=NEW.traceability_unit_id
    AND u.tenant_id=NEW.tenant_id AND u.factory_id=NEW.factory_id
  FOR SHARE;

  IF NOT FOUND
    OR v_posting.id IS NULL
    OR v_posting.traceability_unit_id IS NULL
    OR v_posting.good_quantity < 1
    OR v_posting.good_quantity <> trunc(v_posting.good_quantity)
    OR v_posting.good_quantity > 100
    OR v_posting.production_report_id IS DISTINCT FROM NEW.production_report_id
    OR v_posting.finished_item_id IS DISTINCT FROM NEW.finished_item_id
    OR v_unit.unit_type <> 'SERIAL'
    OR v_unit.product_role <> 'FINISHED_GOOD'
    OR v_unit.inventory_item_id IS DISTINCT FROM NEW.finished_item_id
    OR v_unit.quantity IS DISTINCT FROM 1.0000::numeric
    OR v_unit.status <> 'ACTIVE'
    OR v_unit.production_report_id IS DISTINCT FROM NEW.production_report_id
    OR v_unit.order_id IS DISTINCT FROM v_posting.order_id
    OR v_unit.order_line_id IS DISTINCT FROM v_posting.order_line_id
    OR (NEW.unit_sequence = 1 AND NEW.traceability_unit_id IS DISTINCT FROM v_posting.traceability_unit_id)
    OR NEW.unit_sequence > v_posting.good_quantity
  THEN
    RAISE EXCEPTION 'serial membership must bind one active one-unit finished-good SERIAL to the exact output posting/report/item/order line and canonical sequence'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_production_output_serial_membership_guard
  ON production_output_posting_serial_units;
CREATE TRIGGER trg_production_output_serial_membership_guard
BEFORE INSERT OR UPDATE OR DELETE ON production_output_posting_serial_units
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_production_output_serial_membership();

CREATE OR REPLACE FUNCTION factoryos_assert_production_output_serial_set()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_posting_id uuid;
  v_posting record;
  v_primary_type varchar(24);
  v_count bigint;
  v_min_sequence integer;
  v_max_sequence integer;
  v_invalid boolean;
BEGIN
  IF TG_TABLE_NAME = 'production_output_postings' THEN
    v_posting_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    v_posting_id := CASE WHEN TG_OP = 'DELETE'
      THEN OLD.production_output_posting_id ELSE NEW.production_output_posting_id END;
  END IF;

  SELECT p.id, p.tenant_id, p.factory_id, p.production_report_id,
         p.finished_item_id, p.traceability_unit_id, p.good_quantity
    INTO v_posting
  FROM production_output_postings p
  WHERE p.id = v_posting_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT u.unit_type INTO v_primary_type
  FROM traceability_units u
  WHERE u.id=v_posting.traceability_unit_id
    AND u.tenant_id=v_posting.tenant_id AND u.factory_id=v_posting.factory_id;

  SELECT count(*), min(s.unit_sequence), max(s.unit_sequence)
    INTO v_count, v_min_sequence, v_max_sequence
  FROM production_output_posting_serial_units s
  WHERE s.production_output_posting_id=v_posting.id
    AND s.tenant_id=v_posting.tenant_id AND s.factory_id=v_posting.factory_id;

  IF v_posting.good_quantity = 0 THEN
    IF v_posting.traceability_unit_id IS NOT NULL OR v_count <> 0 THEN
      RAISE EXCEPTION 'zero-good output cannot have a finished-good LOT or SERIAL identity'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF v_primary_type = 'SERIAL' THEN
    IF v_posting.good_quantity < 1
      OR v_posting.good_quantity <> trunc(v_posting.good_quantity)
      OR v_posting.good_quantity > 100
      OR v_count::numeric IS DISTINCT FROM v_posting.good_quantity
      OR v_min_sequence IS DISTINCT FROM 1
      OR v_max_sequence IS DISTINCT FROM v_count::integer
      OR NOT EXISTS (
        SELECT 1 FROM production_output_posting_serial_units s
        WHERE s.production_output_posting_id=v_posting.id
          AND s.tenant_id=v_posting.tenant_id AND s.factory_id=v_posting.factory_id
          AND s.unit_sequence=1 AND s.traceability_unit_id=v_posting.traceability_unit_id
      )
    THEN
      RAISE EXCEPTION 'finished-good SERIAL set must contain exactly one contiguous one-unit identity for every accepted good unit'
        USING ERRCODE = '23514';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM production_output_posting_serial_units s
      JOIN traceability_units u
        ON u.id=s.traceability_unit_id AND u.tenant_id=s.tenant_id
       AND u.factory_id=s.factory_id AND u.inventory_item_id=s.finished_item_id
      JOIN order_production_reports r
        ON r.id=s.production_report_id AND r.tenant_id=s.tenant_id AND r.factory_id=s.factory_id
      WHERE s.production_output_posting_id=v_posting.id
        AND s.tenant_id=v_posting.tenant_id AND s.factory_id=v_posting.factory_id
        AND (
          s.production_report_id IS DISTINCT FROM v_posting.production_report_id
          OR s.finished_item_id IS DISTINCT FROM v_posting.finished_item_id
          OR u.unit_type <> 'SERIAL'
          OR u.product_role <> 'FINISHED_GOOD'
          OR u.quantity IS DISTINCT FROM 1.0000::numeric
          OR u.status <> 'ACTIVE'
          OR u.production_report_id IS DISTINCT FROM r.id
          OR u.order_id IS DISTINCT FROM r.order_id
          OR u.order_line_id IS DISTINCT FROM r.order_line_id
        )
    ) INTO v_invalid;

    IF v_invalid THEN
      RAISE EXCEPTION 'finished-good SERIAL membership contains an identity outside the exact report/item/order binding'
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_primary_type = 'LOT' THEN
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'finished-good LOT output cannot have SERIAL membership rows'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'finished-good output must be represented by one LOT or a complete one-unit SERIAL set'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_production_output_serial_set_posting
  ON production_output_postings;
CREATE CONSTRAINT TRIGGER ctr_production_output_serial_set_posting
AFTER INSERT OR UPDATE ON production_output_postings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_production_output_serial_set();

DROP TRIGGER IF EXISTS ctr_production_output_serial_set_membership
  ON production_output_posting_serial_units;
CREATE CONSTRAINT TRIGGER ctr_production_output_serial_set_membership
AFTER INSERT OR UPDATE OR DELETE ON production_output_posting_serial_units
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_production_output_serial_set();

-- Extend the canonical genealogy guard so every member of a SERIAL set is a
-- valid output target and every one-unit serial edge carries a one-unit weight.
CREATE OR REPLACE FUNCTION factoryos_guard_work_order_output_genealogy_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_output record;
  v_binding record;
  v_event_total numeric(18,4);
  v_is_serial_output boolean;
BEGIN
  SELECT p.id AS posting_id, p.production_report_id, p.work_order_id,
         p.finished_item_id, p.good_quantity, p.scrap_quantity,
         r.work_order_id AS report_work_order_id,
         CASE WHEN p.traceability_unit_id = NEW.target_unit_id
                   OR EXISTS (
                     SELECT 1 FROM production_output_posting_serial_units s
                     WHERE s.production_output_posting_id=p.id
                       AND s.tenant_id=p.tenant_id AND s.factory_id=p.factory_id
                       AND s.traceability_unit_id=NEW.target_unit_id
                   )
           THEN 'FINISHED_GOOD' ELSE 'SCRAP' END AS target_kind,
         EXISTS (
           SELECT 1 FROM production_output_posting_serial_units s
           WHERE s.production_output_posting_id=p.id
             AND s.tenant_id=p.tenant_id AND s.factory_id=p.factory_id
             AND s.traceability_unit_id=NEW.target_unit_id
         ) AS is_serial_output
    INTO v_output
  FROM production_output_postings p
  JOIN order_production_reports r
    ON r.id = p.production_report_id AND r.tenant_id = p.tenant_id AND r.factory_id = p.factory_id
  WHERE p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
    AND (p.traceability_unit_id = NEW.target_unit_id
      OR p.scrap_traceability_unit_id = NEW.target_unit_id
      OR EXISTS (
        SELECT 1 FROM production_output_posting_serial_units s
        WHERE s.production_output_posting_id=p.id
          AND s.tenant_id=p.tenant_id AND s.factory_id=p.factory_id
          AND s.traceability_unit_id=NEW.target_unit_id
      ))
  FOR SHARE OF p, r;

  IF NOT FOUND OR v_output.work_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.evidence->>'output_quantity_weight', '') !~ '^[0-9]+(\.[0-9]{1,4})?$' THEN
    RAISE EXCEPTION 'work-order genealogy must include a valid four-decimal output quantity weight'
      USING ERRCODE = '23514';
  END IF;

  IF v_output.target_kind = 'FINISHED_GOOD' THEN
    IF NEW.relationship_type <> 'CONSUMED_INTO'
       OR (NEW.evidence->>'output_quantity_weight')::numeric
         IS DISTINCT FROM (CASE WHEN v_output.is_serial_output
           THEN 1.0000::numeric ELSE v_output.good_quantity END) THEN
      RAISE EXCEPTION 'finished-good output genealogy must use CONSUMED_INTO and the canonical target identity quantity'
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
    RAISE EXCEPTION 'work-order output genealogy evidence does not match its immutable report, posting, work order and output target'
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

CREATE OR REPLACE FUNCTION factoryos_assert_work_order_output_genealogy_coverage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_output record;
  v_binding record;
  v_event_total numeric(18,4);
BEGIN
  SELECT p.work_order_id
    INTO v_output
  FROM production_output_postings p
  WHERE p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
    AND (p.traceability_unit_id = NEW.target_unit_id
      OR p.scrap_traceability_unit_id = NEW.target_unit_id
      OR EXISTS (
        SELECT 1 FROM production_output_posting_serial_units s
        WHERE s.production_output_posting_id=p.id
          AND s.tenant_id=p.tenant_id AND s.factory_id=p.factory_id
          AND s.traceability_unit_id=NEW.target_unit_id
      ));

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

-- The posting membership ledger is operational lineage, not a generic export or
-- erasure source. Keep it excluded and blocked until a category-specific adapter
-- and owner-approved deletion policy are implemented.
INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,
   erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','production_output_posting_serial_units','DIRECT_TENANT_ID','BUSINESS_DATA',
   'EXCLUDED','BLOCKED_UNREVIEWED','APPEND_ONLY_AUDIT',
   'Immutable finished-good SERIAL membership binds each one-unit identity to its production report and posting; generic export and erasure remain blocked pending a domain adapter.')
ON CONFLICT (schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,
  classified_at=clock_timestamp();

INSERT INTO factoryos_governance.tenant_relation_ownership_reviews
  (schema_name,relation_name,ownership_class,evidence_type,evidence_detail,scope_predicate,
   export_disposition,erasure_disposition,review_status)
VALUES
  ('public','production_output_posting_serial_units','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
   'Direct tenant_id scope with forced RLS; rows bind immutable output posting, finished item, report and SERIAL identity. Technical scope is verified; generic export is excluded and erasure remains blocked.',
   'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','BLOCKED_UNREVIEWED','VERIFIED')
ON CONFLICT (schema_name,relation_name) DO UPDATE SET
  ownership_class=EXCLUDED.ownership_class,evidence_type=EXCLUDED.evidence_type,
  evidence_detail=EXCLUDED.evidence_detail,scope_predicate=EXCLUDED.scope_predicate,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  review_status=EXCLUDED.review_status,reviewed_at=clock_timestamp();

INSERT INTO schema_migrations(version, checksum)
VALUES ('238_production_multi_serial_output', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
