-- Atomically connect accepted production output, yield/scrap evidence and finished-goods stock.
BEGIN;

-- Composite identity is needed so a posting cannot reference a movement from another scope.
ALTER TABLE inventory_movements
  ADD CONSTRAINT uq_inventory_movement_identity_scope
  UNIQUE (id, tenant_id, factory_id);

CREATE TABLE production_output_postings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  work_order_id UUID NOT NULL,
  work_order_operation_id UUID NOT NULL,
  production_report_id UUID NOT NULL,
  finished_item_id UUID NOT NULL,
  inventory_movement_id UUID,
  good_quantity NUMERIC(18,4) NOT NULL,
  scrap_quantity NUMERIC(18,4) NOT NULL,
  yield_percentage NUMERIC(7,4) NOT NULL,
  cumulative_yield_percentage NUMERIC(7,4) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_production_output_posting_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_production_output_posting_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT uq_production_output_posting_report UNIQUE (production_report_id),
  CONSTRAINT fk_production_output_posting_work_order
    FOREIGN KEY (work_order_id, tenant_id, factory_id)
    REFERENCES work_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_output_posting_operation
    FOREIGN KEY (work_order_operation_id, work_order_id, tenant_id, factory_id)
    REFERENCES work_order_operations(id, work_order_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_output_posting_report
    FOREIGN KEY (production_report_id, tenant_id, factory_id)
    REFERENCES order_production_reports(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_output_posting_item
    FOREIGN KEY (finished_item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_output_posting_movement
    FOREIGN KEY (inventory_movement_id, tenant_id, factory_id)
    REFERENCES inventory_movements(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_output_posting_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_production_output_posting_quantity
    CHECK (good_quantity >= 0 AND scrap_quantity >= 0 AND good_quantity + scrap_quantity > 0),
  CONSTRAINT chk_production_output_posting_yield
    CHECK (yield_percentage BETWEEN 0 AND 100 AND cumulative_yield_percentage BETWEEN 0 AND 100),
  CONSTRAINT chk_production_output_posting_stock_link
    CHECK (
      (good_quantity = 0 AND inventory_movement_id IS NULL)
      OR (good_quantity > 0 AND inventory_movement_id IS NOT NULL)
    ),
  CONSTRAINT chk_production_output_posting_key
    CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_production_output_posting_hash
    CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX uq_production_output_posting_movement
  ON production_output_postings (inventory_movement_id)
  WHERE inventory_movement_id IS NOT NULL;
CREATE INDEX idx_production_output_posting_work_order
  ON production_output_postings (tenant_id, factory_id, work_order_id, created_at, id);
CREATE INDEX idx_production_output_posting_item
  ON production_output_postings (tenant_id, factory_id, finished_item_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_production_output_posting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_report RECORD;
  v_work_order RECORD;
  v_movement RECORD;
  v_totals RECORD;
  v_balance_quantity NUMERIC(18,4);
  v_report_yield NUMERIC(7,4);
  v_cumulative_yield NUMERIC(7,4);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'production output postings are append-only'
      USING ERRCODE = '55000';
  END IF;

  SELECT r.id, r.tenant_id, r.factory_id, r.order_id, r.order_line_id,
         r.work_order_id, r.work_order_operation_id, r.good_quantity, r.scrap_quantity
  INTO v_report
  FROM order_production_reports r
  WHERE r.id = NEW.production_report_id
    AND r.tenant_id = NEW.tenant_id
    AND r.factory_id = NEW.factory_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'production output report was not found in this tenant/factory'
      USING ERRCODE = '23503';
  END IF;
  IF v_report.work_order_id IS NULL
     OR v_report.work_order_id <> NEW.work_order_id
     OR v_report.work_order_operation_id <> NEW.work_order_operation_id
     OR v_report.good_quantity <> NEW.good_quantity
     OR v_report.scrap_quantity <> NEW.scrap_quantity THEN
    RAISE EXCEPTION 'production output posting must exactly match its scoped canonical report'
      USING ERRCODE = '23514';
  END IF;

  SELECT wo.id, wo.finished_item_id
  INTO v_work_order
  FROM work_orders wo
  WHERE wo.id = NEW.work_order_id
    AND wo.tenant_id = NEW.tenant_id
    AND wo.factory_id = NEW.factory_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'production work order was not found in this tenant/factory'
      USING ERRCODE = '23503';
  END IF;
  IF v_work_order.finished_item_id <> NEW.finished_item_id THEN
    RAISE EXCEPTION 'production output must post the work order finished-good item'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.good_quantity + NEW.scrap_quantity <= 0 THEN
    RAISE EXCEPTION 'production output total must be greater than zero'
      USING ERRCODE = '23514';
  END IF;

  v_report_yield := ROUND(NEW.good_quantity * 100 / (NEW.good_quantity + NEW.scrap_quantity), 4);
  IF NEW.yield_percentage <> v_report_yield THEN
    RAISE EXCEPTION 'reported output yield must equal good output divided by total processed output'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(r.good_quantity), 0)::numeric(18,4) AS good_quantity,
         COALESCE(SUM(r.scrap_quantity), 0)::numeric(18,4) AS scrap_quantity
  INTO v_totals
  FROM order_production_reports r
  WHERE r.order_id = v_report.order_id
    AND r.order_line_id = v_report.order_line_id
    AND r.tenant_id = NEW.tenant_id
    AND r.factory_id = NEW.factory_id;

  v_cumulative_yield := ROUND(
    v_totals.good_quantity * 100 / NULLIF(v_totals.good_quantity + v_totals.scrap_quantity, 0),
    4
  );
  IF NEW.cumulative_yield_percentage <> v_cumulative_yield THEN
    RAISE EXCEPTION 'cumulative output yield must match the source order-line production ledger'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.good_quantity = 0 THEN
    IF NEW.inventory_movement_id IS NOT NULL THEN
      RAISE EXCEPTION 'scrap-only production output cannot create a finished-good stock receipt'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT m.id, m.item_id, m.movement_type, m.quantity, m.quantity_delta,
           m.quantity_after, m.location_id, m.reference_type, m.reference_id
    INTO v_movement
    FROM inventory_movements m
    WHERE m.id = NEW.inventory_movement_id
      AND m.tenant_id = NEW.tenant_id
      AND m.factory_id = NEW.factory_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'finished-good inventory movement was not found in this tenant/factory'
        USING ERRCODE = '23503';
    END IF;
    IF v_movement.item_id <> NEW.finished_item_id
       OR v_movement.movement_type <> 'RECEIPT'
       OR v_movement.quantity <> NEW.good_quantity
       OR v_movement.quantity_delta <> NEW.good_quantity
       OR v_movement.location_id IS NOT NULL
       OR v_movement.reference_type <> 'PRODUCTION_OUTPUT'
       OR v_movement.reference_id <> NEW.production_report_id THEN
      RAISE EXCEPTION 'finished-good inventory movement must receipt exactly the accepted output from this report'
        USING ERRCODE = '23514';
    END IF;

    SELECT b.quantity_on_hand INTO v_balance_quantity
    FROM inventory_stock_balances b
    WHERE b.item_id = NEW.finished_item_id
      AND b.tenant_id = NEW.tenant_id
      AND b.factory_id = NEW.factory_id
    FOR SHARE;
    IF NOT FOUND OR v_movement.quantity_after IS DISTINCT FROM v_balance_quantity THEN
      RAISE EXCEPTION 'finished-good receipt quantity_after must match the aggregate inventory balance'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_production_output_posting_guard
BEFORE INSERT ON production_output_postings
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_production_output_posting();

CREATE OR REPLACE FUNCTION factoryos_require_production_output_posting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_posting RECORD;
BEGIN
  IF NEW.work_order_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.work_order_id, p.work_order_operation_id, p.good_quantity, p.scrap_quantity
  INTO v_posting
  FROM production_output_postings p
  WHERE p.production_report_id = NEW.id
    AND p.tenant_id = NEW.tenant_id
    AND p.factory_id = NEW.factory_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'every work-order output report requires a matching yield/scrap and inventory posting before commit'
      USING ERRCODE = '23514';
  END IF;
  IF v_posting.work_order_id <> NEW.work_order_id
     OR v_posting.work_order_operation_id <> NEW.work_order_operation_id
     OR v_posting.good_quantity <> NEW.good_quantity
     OR v_posting.scrap_quantity <> NEW.scrap_quantity THEN
    RAISE EXCEPTION 'every work-order output report requires a matching yield/scrap and inventory posting before commit'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_order_production_report_inventory_posting_required
AFTER INSERT ON order_production_reports
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_require_production_output_posting();

CREATE OR REPLACE FUNCTION factoryos_prevent_production_output_posting_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'production_output_postings are immutable; record a separate correction/disposition'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_production_output_postings_immutable
BEFORE UPDATE OR DELETE ON production_output_postings
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_production_output_posting_mutation();

-- Production-linked demand is fulfilled by accepted good units, never by scrap.
-- Keep ordinary stock-fulfilled orders valid when no production work order was completed.
CREATE OR REPLACE FUNCTION factoryos_require_production_output_before_order_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unfulfilled_line RECORD;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'COMPLETED' THEN
    SELECT ol.id::text AS order_line_id,
      ol.quantity::text AS ordered_quantity,
      COALESCE((
        SELECT SUM(r.good_quantity)
        FROM order_production_reports r
        WHERE r.order_id = ol.order_id
          AND r.order_line_id = ol.id
          AND r.tenant_id = ol.tenant_id
          AND r.factory_id = ol.factory_id
      ), 0)::text AS accepted_good_quantity
    INTO v_unfulfilled_line
    FROM order_lines ol
    WHERE ol.order_id = NEW.id
      AND ol.tenant_id = NEW.tenant_id
      AND ol.factory_id = NEW.factory_id
      AND EXISTS (
        SELECT 1 FROM work_orders wo
        WHERE wo.source_order_id = ol.order_id
          AND wo.source_order_line_id = ol.id
          AND wo.tenant_id = ol.tenant_id
          AND wo.factory_id = ol.factory_id
      )
      AND COALESCE((
        SELECT SUM(r.good_quantity)
        FROM order_production_reports r
        WHERE r.order_id = ol.order_id
          AND r.order_line_id = ol.id
          AND r.tenant_id = ol.tenant_id
          AND r.factory_id = ol.factory_id
      ), 0) < ol.quantity
    ORDER BY ol.id
    LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION
        'sales order cannot complete: production-linked line % has accepted good output % against ordered quantity %',
        v_unfulfilled_line.order_line_id,
        v_unfulfilled_line.accepted_good_quantity,
        v_unfulfilled_line.ordered_quantity
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_order_production_output_fulfillment_guard
BEFORE UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION factoryos_require_production_output_before_order_completion();

ALTER TABLE production_output_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_output_postings FORCE ROW LEVEL SECURITY;
CREATE POLICY production_output_postings_tenant_isolation ON production_output_postings
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE production_output_postings IS
  'Append-only bridge between canonical work-order output reports, per-report and cumulative yield/scrap, and accepted finished-good inventory receipts. Scrap is evidence only and never increases sellable stock.';
COMMENT ON COLUMN production_output_postings.yield_percentage IS
  'Per-report first-pass yield: good_quantity / (good_quantity + scrap_quantity) * 100.';
COMMENT ON COLUMN production_output_postings.cumulative_yield_percentage IS
  'Cumulative source sales-order-line yield after this report, recalculated from the canonical production-report ledger.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('091_production_output_inventory_posting', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
