BEGIN;

-- WP02 production output evidence: record good output separately from rejected output.
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_lines_production_report_scope
  ON order_lines (id, order_id, tenant_id, factory_id);

CREATE TABLE order_production_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  order_id UUID NOT NULL,
  order_line_id UUID NOT NULL,
  good_quantity NUMERIC(18, 4) NOT NULL,
  scrap_quantity NUMERIC(18, 4) NOT NULL,
  cumulative_good_quantity NUMERIC(18, 4) NOT NULL,
  cumulative_scrap_quantity NUMERIC(18, 4) NOT NULL,
  scrap_reason TEXT,
  notes TEXT,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_order_production_report_id_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_order_production_report_idempotency
    UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_order_production_report_order_scope
    FOREIGN KEY (order_id, tenant_id, factory_id)
    REFERENCES orders (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_production_report_line_scope
    FOREIGN KEY (order_line_id, order_id, tenant_id, factory_id)
    REFERENCES order_lines (id, order_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_production_report_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_order_production_report_good_quantity
    CHECK (good_quantity >= 0),
  CONSTRAINT chk_order_production_report_scrap_quantity
    CHECK (scrap_quantity >= 0),
  CONSTRAINT chk_order_production_report_nonempty
    CHECK (good_quantity + scrap_quantity > 0),
  CONSTRAINT chk_order_production_report_cumulative_good
    CHECK (cumulative_good_quantity >= good_quantity),
  CONSTRAINT chk_order_production_report_cumulative_scrap
    CHECK (cumulative_scrap_quantity >= scrap_quantity),
  CONSTRAINT chk_order_production_report_cumulative_nonnegative
    CHECK (cumulative_good_quantity >= 0 AND cumulative_scrap_quantity >= 0),
  CONSTRAINT chk_order_production_report_scrap_reason
    CHECK (scrap_quantity = 0 OR length(btrim(COALESCE(scrap_reason, ''))) > 0),
  CONSTRAINT chk_order_production_report_key
    CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_order_production_report_hash
    CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_order_production_report_order_created
  ON order_production_reports
  (tenant_id, factory_id, order_id, created_at DESC, id DESC);

CREATE INDEX idx_order_production_report_line_created
  ON order_production_reports
  (tenant_id, factory_id, order_line_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_order_production_report_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_order_status VARCHAR(30);
  v_target_quantity NUMERIC(18, 4);
  v_prior_good NUMERIC(18, 4);
  v_prior_scrap NUMERIC(18, 4);
BEGIN
  -- Serialize reports for a given order even when inserted outside the API.
  SELECT o.status
    INTO v_order_status
  FROM orders o
  WHERE o.id = NEW.order_id
    AND o.tenant_id = NEW.tenant_id
    AND o.factory_id = NEW.factory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'production report order is missing from its factory scope'
      USING ERRCODE = '23503';
  END IF;

  IF v_order_status <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'production reports are only allowed for in-progress orders'
      USING ERRCODE = '23514';
  END IF;

  SELECT ol.quantity
    INTO v_target_quantity
  FROM order_lines ol
  WHERE ol.id = NEW.order_line_id
    AND ol.order_id = NEW.order_id
    AND ol.tenant_id = NEW.tenant_id
    AND ol.factory_id = NEW.factory_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'production report line does not belong to this order and factory'
      USING ERRCODE = '23503';
  END IF;

  SELECT
    COALESCE(SUM(r.good_quantity), 0),
    COALESCE(SUM(r.scrap_quantity), 0)
  INTO v_prior_good, v_prior_scrap
  FROM order_production_reports r
  WHERE r.tenant_id = NEW.tenant_id
    AND r.factory_id = NEW.factory_id
    AND r.order_line_id = NEW.order_line_id;

  IF v_prior_good + NEW.good_quantity + v_prior_scrap + NEW.scrap_quantity > v_target_quantity THEN
    RAISE EXCEPTION 'reported good plus scrap output exceeds the order-line target'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.cumulative_good_quantity <> v_prior_good + NEW.good_quantity
    OR NEW.cumulative_scrap_quantity <> v_prior_scrap + NEW.scrap_quantity
  THEN
    RAISE EXCEPTION 'production report cumulative quantities do not match prior immutable reports'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER order_production_reports_insert_guard
BEFORE INSERT ON order_production_reports
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_order_production_report_insert();

CREATE OR REPLACE FUNCTION factoryos_prevent_order_production_report_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'order_production_reports are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER order_production_reports_immutable
BEFORE UPDATE OR DELETE ON order_production_reports
FOR EACH ROW
EXECUTE FUNCTION factoryos_prevent_order_production_report_mutation();

ALTER TABLE order_production_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_production_reports FORCE ROW LEVEL SECURITY;

CREATE POLICY order_production_reports_tenant_isolation
ON order_production_reports
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE order_production_reports IS
  'Immutable, idempotent good-output and scrap-output reports for in-progress manufacturing order lines. Output scrap is quality evidence and does not restock raw materials.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('063_order_production_yield_scrap_tracking', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
