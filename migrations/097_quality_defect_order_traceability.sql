BEGIN;

CREATE TABLE quality_defect_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  defect_id UUID NOT NULL,
  link_type VARCHAR(28) NOT NULL,
  inventory_item_id UUID,
  traceability_unit_id UUID,
  order_id UUID,
  order_line_id UUID,
  work_order_id UUID,
  work_order_operation_id UUID,
  production_report_id UUID,
  goods_receipt_id UUID,
  goods_receipt_line_id UUID,
  affected_quantity NUMERIC(18,4),
  link_source VARCHAR(20) NOT NULL DEFAULT 'OPERATOR',
  notes TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_quality_defect_link_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_defect_link_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_defect_link_defect FOREIGN KEY (defect_id, tenant_id, factory_id)
    REFERENCES quality_defects(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_defect_link_item FOREIGN KEY (inventory_item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_defect_link_unit FOREIGN KEY (traceability_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_defect_link_order FOREIGN KEY (order_id, tenant_id, factory_id)
    REFERENCES orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_defect_link_order_line FOREIGN KEY (order_line_id, order_id, tenant_id, factory_id)
    REFERENCES order_lines(id, order_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_defect_link_work_order FOREIGN KEY (work_order_id, tenant_id, factory_id)
    REFERENCES work_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_defect_link_operation FOREIGN KEY (work_order_operation_id, work_order_id, tenant_id, factory_id)
    REFERENCES work_order_operations(id, work_order_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_defect_link_report FOREIGN KEY (production_report_id, tenant_id, factory_id)
    REFERENCES order_production_reports(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_defect_link_receipt FOREIGN KEY (goods_receipt_id, tenant_id, factory_id)
    REFERENCES goods_receipts(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_defect_link_receipt_line FOREIGN KEY (goods_receipt_line_id, tenant_id, factory_id, goods_receipt_id)
    REFERENCES goods_receipt_lines(id, tenant_id, factory_id, goods_receipt_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_defect_link_actor FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_defect_link_type CHECK (link_type IN (
    'INVENTORY_ITEM','TRACEABILITY_UNIT','ORDER','ORDER_LINE','WORK_ORDER',
    'WORK_ORDER_OPERATION','PRODUCTION_REPORT','GOODS_RECEIPT_LINE'
  )),
  CONSTRAINT chk_quality_defect_link_target CHECK (
    (link_type = 'INVENTORY_ITEM' AND inventory_item_id IS NOT NULL
      AND traceability_unit_id IS NULL AND order_id IS NULL AND order_line_id IS NULL
      AND work_order_id IS NULL AND work_order_operation_id IS NULL AND production_report_id IS NULL
      AND goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL)
    OR (link_type = 'TRACEABILITY_UNIT' AND traceability_unit_id IS NOT NULL
      AND inventory_item_id IS NULL AND order_id IS NULL AND order_line_id IS NULL
      AND work_order_id IS NULL AND work_order_operation_id IS NULL AND production_report_id IS NULL
      AND goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL)
    OR (link_type = 'ORDER' AND order_id IS NOT NULL AND order_line_id IS NULL
      AND inventory_item_id IS NULL AND traceability_unit_id IS NULL
      AND work_order_id IS NULL AND work_order_operation_id IS NULL AND production_report_id IS NULL
      AND goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL)
    OR (link_type = 'ORDER_LINE' AND order_id IS NOT NULL AND order_line_id IS NOT NULL
      AND inventory_item_id IS NULL AND traceability_unit_id IS NULL
      AND work_order_id IS NULL AND work_order_operation_id IS NULL AND production_report_id IS NULL
      AND goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL)
    OR (link_type = 'WORK_ORDER' AND work_order_id IS NOT NULL AND work_order_operation_id IS NULL
      AND inventory_item_id IS NULL AND traceability_unit_id IS NULL AND order_id IS NULL AND order_line_id IS NULL
      AND production_report_id IS NULL AND goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL)
    OR (link_type = 'WORK_ORDER_OPERATION' AND work_order_id IS NOT NULL AND work_order_operation_id IS NOT NULL
      AND inventory_item_id IS NULL AND traceability_unit_id IS NULL AND order_id IS NULL AND order_line_id IS NULL
      AND production_report_id IS NULL AND goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL)
    OR (link_type = 'PRODUCTION_REPORT' AND production_report_id IS NOT NULL
      AND inventory_item_id IS NULL AND traceability_unit_id IS NULL AND order_id IS NULL AND order_line_id IS NULL
      AND work_order_id IS NULL AND work_order_operation_id IS NULL
      AND goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL)
    OR (link_type = 'GOODS_RECEIPT_LINE' AND goods_receipt_id IS NOT NULL AND goods_receipt_line_id IS NOT NULL
      AND inventory_item_id IS NULL AND traceability_unit_id IS NULL AND order_id IS NULL AND order_line_id IS NULL
      AND work_order_id IS NULL AND work_order_operation_id IS NULL AND production_report_id IS NULL)
  ),
  CONSTRAINT chk_quality_defect_link_quantity CHECK (affected_quantity IS NULL OR affected_quantity > 0),
  CONSTRAINT chk_quality_defect_link_source CHECK (link_source IN ('INSPECTION_TARGET','OPERATOR')),
  CONSTRAINT chk_quality_defect_link_notes CHECK (notes IS NULL OR length(btrim(notes)) > 0),
  CONSTRAINT chk_quality_defect_link_evidence CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT chk_quality_defect_link_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_quality_defect_link_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_quality_defect_links_defect
  ON quality_defect_links(tenant_id, factory_id, defect_id, link_type, created_at, id);
CREATE INDEX idx_quality_defect_links_unit
  ON quality_defect_links(tenant_id, factory_id, traceability_unit_id, created_at, id)
  WHERE traceability_unit_id IS NOT NULL;
CREATE INDEX idx_quality_defect_links_order_line
  ON quality_defect_links(tenant_id, factory_id, order_id, order_line_id, created_at, id)
  WHERE order_id IS NOT NULL;
CREATE INDEX idx_quality_defect_links_work_order
  ON quality_defect_links(tenant_id, factory_id, work_order_id, created_at, id)
  WHERE work_order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_guard_quality_defect_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_defect quality_defects%ROWTYPE;
  v_inspection quality_inspections%ROWTYPE;
  v_related BOOLEAN := FALSE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'defect-to-traceability links are immutable evidence' USING ERRCODE = '55000';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'defect link actor must match the authenticated user' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_defect FROM quality_defects d
  WHERE d.id = NEW.defect_id AND d.tenant_id = NEW.tenant_id AND d.factory_id = NEW.factory_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'quality defect must exist in the same factory' USING ERRCODE = '23503'; END IF;
  SELECT * INTO v_inspection FROM quality_inspections qi
  WHERE qi.id = v_defect.inspection_id AND qi.tenant_id = NEW.tenant_id AND qi.factory_id = NEW.factory_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'defect inspection must exist in the same factory' USING ERRCODE = '23503'; END IF;

  CASE NEW.link_type
    WHEN 'INVENTORY_ITEM' THEN
      SELECT EXISTS (
        SELECT 1 FROM inventory_items i WHERE i.id = NEW.inventory_item_id
          AND i.tenant_id = NEW.tenant_id AND i.factory_id = NEW.factory_id
          AND (i.id = v_inspection.inventory_item_id
            OR EXISTS (SELECT 1 FROM traceability_units u WHERE u.inventory_item_id=i.id
              AND u.tenant_id=i.tenant_id AND u.factory_id=i.factory_id AND u.id=v_inspection.traceability_unit_id)
            OR EXISTS (SELECT 1 FROM work_orders wo WHERE wo.finished_item_id=i.id
              AND wo.tenant_id=i.tenant_id AND wo.factory_id=i.factory_id
              AND ((v_inspection.target_type='WORK_ORDER' AND wo.id=v_inspection.target_id)
                OR (v_inspection.target_type='PRODUCTION_REPORT' AND EXISTS (
                  SELECT 1 FROM order_production_reports r WHERE r.id=v_inspection.target_id
                    AND r.work_order_id=wo.id AND r.tenant_id=wo.tenant_id AND r.factory_id=wo.factory_id))))
            OR EXISTS (SELECT 1 FROM goods_receipt_lines gl WHERE gl.inventory_item_id=i.id
              AND gl.tenant_id=i.tenant_id AND gl.factory_id=i.factory_id
              AND v_inspection.target_type='GOODS_RECEIPT_LINE' AND gl.id=v_inspection.target_id))
      ) INTO v_related;
    WHEN 'TRACEABILITY_UNIT' THEN
      SELECT EXISTS (
        SELECT 1 FROM traceability_units u
        WHERE u.id=NEW.traceability_unit_id AND u.tenant_id=NEW.tenant_id AND u.factory_id=NEW.factory_id
          AND (u.id=v_inspection.traceability_unit_id
            OR u.inventory_item_id=v_inspection.inventory_item_id
            OR (v_inspection.target_type='GOODS_RECEIPT_LINE' AND u.goods_receipt_line_id=v_inspection.target_id)
            OR (v_inspection.target_type='PRODUCTION_REPORT' AND u.production_report_id=v_inspection.target_id)
            OR (v_inspection.target_type='WORK_ORDER' AND EXISTS (
              SELECT 1 FROM order_production_reports r
              WHERE r.id=u.production_report_id AND r.work_order_id=v_inspection.target_id
                AND r.tenant_id=NEW.tenant_id AND r.factory_id=NEW.factory_id))
            OR (v_inspection.target_type='TRACEABILITY_UNIT' AND EXISTS (
              WITH RECURSIVE related(unit_id) AS (
                SELECT v_inspection.traceability_unit_id
                UNION
                SELECT CASE WHEN e.source_unit_id=related.unit_id THEN e.target_unit_id ELSE e.source_unit_id END
                FROM related JOIN product_genealogy_events e
                  ON e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
                  AND (e.source_unit_id=related.unit_id OR e.target_unit_id=related.unit_id)
              ) SELECT 1 FROM related WHERE unit_id=u.id))
        )
      ) INTO v_related;
    WHEN 'ORDER' THEN
      SELECT EXISTS (
        SELECT 1 FROM orders o WHERE o.id=NEW.order_id AND o.tenant_id=NEW.tenant_id AND o.factory_id=NEW.factory_id
          AND ( (v_inspection.target_type='WORK_ORDER' AND EXISTS (
                SELECT 1 FROM work_orders wo WHERE wo.id=v_inspection.target_id AND wo.source_order_id=o.id
                  AND wo.tenant_id=o.tenant_id AND wo.factory_id=o.factory_id))
            OR (v_inspection.target_type='PRODUCTION_REPORT' AND EXISTS (
                SELECT 1 FROM order_production_reports r WHERE r.id=v_inspection.target_id AND r.order_id=o.id
                  AND r.tenant_id=o.tenant_id AND r.factory_id=o.factory_id))
            OR (v_inspection.target_type='TRACEABILITY_UNIT' AND EXISTS (
                SELECT 1 FROM traceability_units u WHERE u.id=v_inspection.target_id AND u.order_id=o.id
                  AND u.tenant_id=o.tenant_id AND u.factory_id=o.factory_id))
            OR (v_inspection.target_type='INVENTORY_ITEM' AND EXISTS (
                SELECT 1 FROM order_lines l WHERE l.order_id=o.id AND l.inventory_item_id=v_inspection.inventory_item_id
                  AND l.tenant_id=o.tenant_id AND l.factory_id=o.factory_id)))
      ) INTO v_related;
    WHEN 'ORDER_LINE' THEN
      SELECT EXISTS (
        SELECT 1 FROM order_lines l WHERE l.id=NEW.order_line_id AND l.order_id=NEW.order_id
          AND l.tenant_id=NEW.tenant_id AND l.factory_id=NEW.factory_id
          AND ( (v_inspection.target_type='WORK_ORDER' AND EXISTS (
                SELECT 1 FROM work_orders wo WHERE wo.id=v_inspection.target_id AND wo.source_order_line_id=l.id
                  AND wo.tenant_id=l.tenant_id AND wo.factory_id=l.factory_id))
            OR (v_inspection.target_type='PRODUCTION_REPORT' AND EXISTS (
                SELECT 1 FROM order_production_reports r WHERE r.id=v_inspection.target_id AND r.order_line_id=l.id
                  AND r.tenant_id=l.tenant_id AND r.factory_id=l.factory_id))
            OR (v_inspection.target_type='TRACEABILITY_UNIT' AND EXISTS (
                SELECT 1 FROM traceability_units u WHERE u.id=v_inspection.target_id AND u.order_line_id=l.id
                  AND u.tenant_id=l.tenant_id AND u.factory_id=l.factory_id))
            OR (v_inspection.target_type='INVENTORY_ITEM' AND l.inventory_item_id=v_inspection.inventory_item_id))
      ) INTO v_related;
    WHEN 'WORK_ORDER' THEN
      SELECT EXISTS (
        SELECT 1 FROM work_orders wo WHERE wo.id=NEW.work_order_id
          AND wo.tenant_id=NEW.tenant_id AND wo.factory_id=NEW.factory_id
          AND ((v_inspection.target_type='WORK_ORDER' AND wo.id=v_inspection.target_id)
            OR (v_inspection.target_type='PRODUCTION_REPORT' AND EXISTS (
              SELECT 1 FROM order_production_reports r WHERE r.id=v_inspection.target_id AND r.work_order_id=wo.id
                AND r.tenant_id=wo.tenant_id AND r.factory_id=wo.factory_id))
            OR (v_inspection.target_type='TRACEABILITY_UNIT' AND EXISTS (
              SELECT 1 FROM traceability_units u JOIN order_production_reports r ON r.id=u.production_report_id
                AND r.tenant_id=u.tenant_id AND r.factory_id=u.factory_id
              WHERE u.id=v_inspection.target_id AND r.work_order_id=wo.id
                AND u.tenant_id=wo.tenant_id AND u.factory_id=wo.factory_id))
            OR (v_inspection.target_type='ORDER_LINE' AND wo.source_order_line_id=v_inspection.target_id))
      ) INTO v_related;
    WHEN 'WORK_ORDER_OPERATION' THEN
      SELECT EXISTS (
        SELECT 1 FROM work_order_operations op JOIN work_orders wo ON wo.id=op.work_order_id
          AND wo.tenant_id=op.tenant_id AND wo.factory_id=op.factory_id
        WHERE op.id=NEW.work_order_operation_id AND op.work_order_id=NEW.work_order_id
          AND op.tenant_id=NEW.tenant_id AND op.factory_id=NEW.factory_id
          AND ((v_inspection.target_type='WORK_ORDER' AND wo.id=v_inspection.target_id)
            OR (v_inspection.target_type='PRODUCTION_REPORT' AND EXISTS (
              SELECT 1 FROM order_production_reports r WHERE r.id=v_inspection.target_id AND r.work_order_id=wo.id
                AND r.tenant_id=wo.tenant_id AND r.factory_id=wo.factory_id))
            OR (v_inspection.target_type='TRACEABILITY_UNIT' AND EXISTS (
              SELECT 1 FROM traceability_units u JOIN order_production_reports r ON r.id=u.production_report_id
                AND r.tenant_id=u.tenant_id AND r.factory_id=u.factory_id
              WHERE u.id=v_inspection.target_id AND r.work_order_id=wo.id
                AND u.tenant_id=wo.tenant_id AND u.factory_id=wo.factory_id))
      ) INTO v_related;
    WHEN 'PRODUCTION_REPORT' THEN
      SELECT EXISTS (
        SELECT 1 FROM order_production_reports r WHERE r.id=NEW.production_report_id
          AND r.tenant_id=NEW.tenant_id AND r.factory_id=NEW.factory_id
          AND ((v_inspection.target_type='PRODUCTION_REPORT' AND r.id=v_inspection.target_id)
            OR (v_inspection.target_type='WORK_ORDER' AND r.work_order_id=v_inspection.target_id)
            OR (v_inspection.target_type='ORDER_LINE' AND r.order_line_id=v_inspection.target_id)
            OR (v_inspection.target_type='TRACEABILITY_UNIT' AND EXISTS (
              SELECT 1 FROM traceability_units u WHERE u.id=v_inspection.target_id
                AND u.production_report_id=r.id AND u.tenant_id=r.tenant_id AND u.factory_id=r.factory_id)))
      ) INTO v_related;
    WHEN 'GOODS_RECEIPT_LINE' THEN
      SELECT EXISTS (
        SELECT 1 FROM goods_receipt_lines gl WHERE gl.id=NEW.goods_receipt_line_id
          AND gl.goods_receipt_id=NEW.goods_receipt_id AND gl.tenant_id=NEW.tenant_id AND gl.factory_id=NEW.factory_id
          AND ((v_inspection.target_type='GOODS_RECEIPT_LINE' AND gl.id=v_inspection.target_id)
            OR (v_inspection.target_type='TRACEABILITY_UNIT' AND EXISTS (
              SELECT 1 FROM traceability_units u WHERE u.id=v_inspection.target_id AND u.goods_receipt_line_id=gl.id
                AND u.tenant_id=gl.tenant_id AND u.factory_id=gl.factory_id)))
      ) INTO v_related;
    ELSE v_related := FALSE;
  END CASE;

  IF NEW.link_source <> 'REWORK_OUTPUT' AND NOT v_related THEN
    RAISE EXCEPTION 'inspection-target defect links must match the inspected lot, order or production aggregate'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_defect_link_guard
BEFORE INSERT OR UPDATE OR DELETE ON quality_defect_links
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_defect_link();

CREATE OR REPLACE FUNCTION factoryos_assert_quality_defect_traceability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM quality_defect_links l WHERE l.defect_id=NEW.id
      AND l.tenant_id=NEW.tenant_id AND l.factory_id=NEW.factory_id) THEN
    RAISE EXCEPTION 'each quality defect must have at least one traceability/order source link'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ctr_quality_defect_traceability
AFTER INSERT ON quality_defects
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_quality_defect_traceability();

CREATE OR REPLACE FUNCTION factoryos_assert_quality_defect_link_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM quality_audit_events a
      WHERE a.defect_id=NEW.defect_id AND a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
        AND a.action_type='DEFECT_TRACEABILITY_LINKED' AND a.payload->>'link_id'=NEW.id::text)
    OR NOT EXISTS (SELECT 1 FROM outbox_events o
      WHERE o.tenant_id=NEW.tenant_id AND o.factory_id=NEW.factory_id
        AND o.aggregate_type='QUALITY_DEFECT' AND o.aggregate_id=NEW.defect_id
        AND o.event_type='QUALITY.DEFECT_TRACEABILITY_LINKED' AND o.payload->>'link_id'=NEW.id::text) THEN
    RAISE EXCEPTION 'defect traceability links require transactional audit and outbox evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ctr_quality_defect_link_audit
AFTER INSERT ON quality_defect_links
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_quality_defect_link_audit();

CREATE OR REPLACE FUNCTION factoryos_prevent_quality_defect_link_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'defect-to-lot/order traceability links are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_quality_defect_links_immutable
BEFORE UPDATE OR DELETE ON quality_defect_links
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_quality_defect_link_mutation();

ALTER TABLE quality_defect_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_defect_links FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_defect_links_tenant_isolation ON quality_defect_links
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

INSERT INTO schema_migrations(version, checksum)
VALUES ('097_quality_defect_order_traceability', NULL)
ON CONFLICT (version) DO NOTHING;

COMMENT ON TABLE quality_defect_links IS
  'Immutable factory-scoped defect links to source lots/serials, inventory items, customer orders/lines, work orders/operations, production reports and GRN lines.';

COMMIT;
