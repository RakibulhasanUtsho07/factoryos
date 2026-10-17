BEGIN;

-- Composite source keys are required so a trace identity cannot borrow a receipt/order/report from another scope.
ALTER TABLE goods_receipts
  ADD CONSTRAINT uq_goods_receipts_trace_scope UNIQUE (id, tenant_id, factory_id);
ALTER TABLE goods_receipt_lines
  ADD CONSTRAINT uq_goods_receipt_lines_trace_scope UNIQUE (id, tenant_id, factory_id, goods_receipt_id);
ALTER TABLE order_production_reports
  ADD CONSTRAINT uq_order_production_reports_trace_scope
  UNIQUE (id, order_id, order_line_id, tenant_id, factory_id);

INSERT INTO permissions (code, description)
VALUES
  ('traceability.read', 'Read lot, serial and product genealogy evidence within the authorized factory'),
  ('traceability.write', 'Register traceable units, record genealogy, manage recall status and configure traceability within the authorized factory')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('traceability.read', 'traceability.write')
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER', 'QUALITY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE traceability_label_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  template_code VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  symbology VARCHAR(24) NOT NULL,
  supported_unit_types TEXT[] NOT NULL,
  label_layout JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_traceability_label_template_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_traceability_label_template_factory
    FOREIGN KEY (factory_id, tenant_id) REFERENCES factories (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_label_template_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_traceability_label_template_code CHECK (length(btrim(template_code)) > 0),
  CONSTRAINT chk_traceability_label_template_name CHECK (length(btrim(name)) > 0),
  CONSTRAINT chk_traceability_label_template_symbology
    CHECK (symbology IN ('QR', 'CODE128', 'DATAMATRIX', 'GS1_128')),
  CONSTRAINT chk_traceability_label_template_unit_types
    CHECK (
      cardinality(supported_unit_types) > 0
      AND supported_unit_types <@ ARRAY[
        'LOT', 'SERIAL', 'PALLET', 'CARTON', 'BUNDLE', 'FINISHED_GOOD', 'SHIPMENT'
      ]::text[]
    ),
  CONSTRAINT chk_traceability_label_template_layout CHECK (jsonb_typeof(label_layout) = 'object')
);
CREATE UNIQUE INDEX uq_traceability_label_template_code_ci
  ON traceability_label_templates (tenant_id, factory_id, lower(template_code));
CREATE INDEX idx_traceability_label_template_active
  ON traceability_label_templates (tenant_id, factory_id, is_active, template_code);

CREATE OR REPLACE FUNCTION factoryos_guard_traceability_label_template()
RETURNS trigger
LANGUAGE plpgsql
AS $trace_label_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'label template actor must match the authenticated user';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'label templates are immutable; create a new template code for a new version';
END;
$trace_label_guard$;

CREATE TRIGGER trg_traceability_label_template_immutable
BEFORE INSERT OR UPDATE OR DELETE ON traceability_label_templates
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_traceability_label_template();

CREATE OR REPLACE FUNCTION factoryos_assert_traceability_label_template_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $trace_label_evidence$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
      AND a.resource_type = 'TRACEABILITY_LABEL_TEMPLATE'
      AND a.resource_id = NEW.id AND a.action = 'CREATED'
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id = NEW.tenant_id AND o.factory_id = NEW.factory_id
      AND o.aggregate_type = 'TRACEABILITY_LABEL_TEMPLATE'
      AND o.aggregate_id = NEW.id
      AND o.event_type = 'TRACEABILITY.LABEL_TEMPLATE_CREATED'
  ) THEN
    RAISE EXCEPTION 'traceability label templates require transactional audit and outbox evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$trace_label_evidence$;
CREATE CONSTRAINT TRIGGER ctr_traceability_label_template_evidence
AFTER INSERT ON traceability_label_templates
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_traceability_label_template_evidence();

CREATE TABLE traceability_settings (
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  retention_years INTEGER NOT NULL DEFAULT 7,
  allocation_policy VARCHAR(12) NOT NULL DEFAULT 'FIFO',
  version BIGINT NOT NULL DEFAULT 1,
  updated_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT pk_traceability_settings PRIMARY KEY (tenant_id, factory_id),
  CONSTRAINT fk_traceability_settings_factory
    FOREIGN KEY (factory_id, tenant_id) REFERENCES factories (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT fk_traceability_settings_actor
    FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_traceability_settings_retention CHECK (retention_years BETWEEN 1 AND 100),
  CONSTRAINT chk_traceability_settings_allocation_policy
    CHECK (allocation_policy IN ('FIFO', 'FEFO', 'LOT', 'SERIAL')),
  CONSTRAINT chk_traceability_settings_version CHECK (version > 0)
);

INSERT INTO traceability_settings (tenant_id, factory_id)
SELECT f.tenant_id, f.id FROM factories f
ON CONFLICT (tenant_id, factory_id) DO NOTHING;

CREATE OR REPLACE FUNCTION factoryos_seed_traceability_settings()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO traceability_settings (tenant_id, factory_id)
  VALUES (NEW.tenant_id, NEW.id)
  ON CONFLICT (tenant_id, factory_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER factories_seed_traceability_settings
AFTER INSERT ON factories
FOR EACH ROW EXECUTE FUNCTION factoryos_seed_traceability_settings();

CREATE OR REPLACE FUNCTION factoryos_guard_traceability_settings()
RETURNS trigger
LANGUAGE plpgsql
AS $trace_settings_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Preserve settings during normal operation but allow parent-factory lifecycle cascade.
    IF EXISTS (
      SELECT 1 FROM factories f
      WHERE f.id = OLD.factory_id AND f.tenant_id = OLD.tenant_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'traceability settings cannot be deleted independently of their factory';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.version <> OLD.version + 1
     OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'traceability settings updates require the authenticated actor and the next version';
  END IF;
  RETURN NEW;
END;
$trace_settings_guard$;
CREATE TRIGGER trg_traceability_settings_guard
BEFORE UPDATE OR DELETE ON traceability_settings
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_traceability_settings();

CREATE TABLE traceability_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  unit_type VARCHAR(24) NOT NULL,
  product_role VARCHAR(20) NOT NULL,
  unit_code VARCHAR(160) NOT NULL,
  barcode_value VARCHAR(255) NOT NULL,
  inventory_item_id UUID,
  quantity NUMERIC(18,4) NOT NULL,
  unit VARCHAR(50) NOT NULL,
  supplier_id UUID,
  goods_receipt_id UUID,
  goods_receipt_line_id UUID,
  order_id UUID,
  order_line_id UUID,
  production_report_id UUID,
  label_template_id UUID,
  external_reference VARCHAR(255),
  manufactured_at TIMESTAMPTZ,
  expires_at DATE,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_traceability_unit_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_traceability_unit_id_item_scope UNIQUE (id, tenant_id, factory_id, inventory_item_id),
  CONSTRAINT uq_traceability_unit_id_role_scope UNIQUE (id, tenant_id, factory_id, unit_type, product_role),
  CONSTRAINT uq_traceability_unit_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_traceability_unit_factory
    FOREIGN KEY (factory_id, tenant_id) REFERENCES factories (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_unit_item
    FOREIGN KEY (inventory_item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_unit_supplier
    FOREIGN KEY (supplier_id, tenant_id)
    REFERENCES suppliers (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_unit_receipt
    FOREIGN KEY (goods_receipt_id, tenant_id, factory_id)
    REFERENCES goods_receipts (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_unit_receipt_line
    FOREIGN KEY (goods_receipt_line_id, tenant_id, factory_id, goods_receipt_id)
    REFERENCES goods_receipt_lines (id, tenant_id, factory_id, goods_receipt_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_unit_order
    FOREIGN KEY (order_id, tenant_id, factory_id)
    REFERENCES orders (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_unit_order_line
    FOREIGN KEY (order_line_id, order_id, tenant_id, factory_id)
    REFERENCES order_lines (id, order_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_unit_production_report
    FOREIGN KEY (production_report_id, order_id, order_line_id, tenant_id, factory_id)
    REFERENCES order_production_reports (id, order_id, order_line_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_unit_label_template
    FOREIGN KEY (label_template_id, tenant_id, factory_id)
    REFERENCES traceability_label_templates (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_unit_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_traceability_unit_type
    CHECK (unit_type IN ('LOT', 'SERIAL', 'PALLET', 'CARTON', 'BUNDLE', 'FINISHED_GOOD', 'SHIPMENT')),
  CONSTRAINT chk_traceability_unit_role
    CHECK (product_role IN ('MATERIAL', 'FINISHED_GOOD', 'PACKAGING', 'SHIPMENT', 'OTHER')),
  CONSTRAINT chk_traceability_unit_shipment_role
    CHECK ((unit_type = 'SHIPMENT') = (product_role = 'SHIPMENT')),
  CONSTRAINT chk_traceability_unit_code CHECK (length(btrim(unit_code)) > 0),
  CONSTRAINT chk_traceability_unit_barcode CHECK (length(btrim(barcode_value)) > 0),
  CONSTRAINT chk_traceability_unit_quantity CHECK (quantity > 0 AND (unit_type <> 'SERIAL' OR quantity = 1)),
  CONSTRAINT chk_traceability_unit_unit CHECK (length(btrim(unit)) > 0),
  CONSTRAINT chk_traceability_unit_receipt_pair CHECK (
    (goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL)
    OR (goods_receipt_id IS NOT NULL AND goods_receipt_line_id IS NOT NULL)
  ),
  CONSTRAINT chk_traceability_unit_order_line_pair CHECK (
    (order_id IS NULL AND order_line_id IS NULL)
    OR (order_id IS NOT NULL AND order_line_id IS NOT NULL)
  ),
  CONSTRAINT chk_traceability_unit_production_source CHECK (
    production_report_id IS NULL
    OR (order_id IS NOT NULL AND order_line_id IS NOT NULL AND product_role = 'FINISHED_GOOD')
  ),
  CONSTRAINT chk_traceability_unit_material_or_finished_source CHECK (
    product_role IN ('PACKAGING', 'SHIPMENT', 'OTHER')
    OR inventory_item_id IS NOT NULL
    OR goods_receipt_line_id IS NOT NULL
    OR production_report_id IS NOT NULL
    OR order_line_id IS NOT NULL
    OR external_reference IS NOT NULL
  ),
  CONSTRAINT chk_traceability_unit_status
    CHECK (status IN ('ACTIVE', 'QUARANTINED', 'RECALLED', 'DISPOSED', 'SHIPPED')),
  CONSTRAINT chk_traceability_unit_attributes CHECK (jsonb_typeof(attributes) = 'object'),
  CONSTRAINT chk_traceability_unit_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_traceability_unit_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_traceability_unit_version CHECK (version > 0),
  CONSTRAINT chk_traceability_unit_expiry CHECK (expires_at IS NULL OR manufactured_at IS NULL OR expires_at >= manufactured_at)
);
CREATE UNIQUE INDEX uq_traceability_unit_code_ci
  ON traceability_units (tenant_id, factory_id, lower(unit_code));
CREATE UNIQUE INDEX uq_traceability_unit_barcode_ci
  ON traceability_units (tenant_id, factory_id, lower(barcode_value));
CREATE INDEX idx_traceability_unit_item_role
  ON traceability_units (tenant_id, factory_id, inventory_item_id, product_role, status);
CREATE INDEX idx_traceability_unit_receipt
  ON traceability_units (tenant_id, factory_id, goods_receipt_id, goods_receipt_line_id)
  WHERE goods_receipt_id IS NOT NULL;
CREATE INDEX idx_traceability_unit_production
  ON traceability_units (tenant_id, factory_id, order_id, order_line_id, production_report_id)
  WHERE order_id IS NOT NULL;
CREATE INDEX idx_traceability_unit_expiry
  ON traceability_units (tenant_id, factory_id, expires_at, unit_code)
  WHERE expires_at IS NOT NULL;

CREATE TABLE product_genealogy_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  source_unit_id UUID NOT NULL,
  target_unit_id UUID NOT NULL,
  relationship_type VARCHAR(24) NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  unit VARCHAR(50) NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_product_genealogy_event_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_product_genealogy_event_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_product_genealogy_source
    FOREIGN KEY (source_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_genealogy_target
    FOREIGN KEY (target_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_genealogy_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_product_genealogy_distinct CHECK (source_unit_id <> target_unit_id),
  CONSTRAINT chk_product_genealogy_type
    CHECK (relationship_type IN ('CONSUMED_INTO', 'PROCESSED_INTO', 'SPLIT_INTO', 'MERGED_INTO', 'PACKED_INTO', 'SHIPPED_AS', 'REWORKED_INTO')),
  CONSTRAINT chk_product_genealogy_quantity CHECK (quantity > 0),
  CONSTRAINT chk_product_genealogy_unit CHECK (length(btrim(unit)) > 0),
  CONSTRAINT chk_product_genealogy_evidence CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT chk_product_genealogy_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_product_genealogy_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_product_genealogy_source_created
  ON product_genealogy_events (tenant_id, factory_id, source_unit_id, created_at, id);
CREATE INDEX idx_product_genealogy_target_created
  ON product_genealogy_events (tenant_id, factory_id, target_unit_id, created_at, id);

CREATE TABLE traceability_unit_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  unit_id UUID NOT NULL,
  version BIGINT NOT NULL,
  from_status VARCHAR(16) NOT NULL,
  to_status VARCHAR(16) NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  changed_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_traceability_status_unit_version UNIQUE (unit_id, version),
  CONSTRAINT uq_traceability_status_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_traceability_status_unit
    FOREIGN KEY (unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_status_actor
    FOREIGN KEY (changed_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_traceability_status_values CHECK (
    from_status IN ('ACTIVE', 'QUARANTINED', 'RECALLED', 'DISPOSED', 'SHIPPED')
    AND to_status IN ('ACTIVE', 'QUARANTINED', 'RECALLED', 'DISPOSED', 'SHIPPED')
    AND from_status <> to_status
  ),
  CONSTRAINT chk_traceability_status_reason CHECK (length(btrim(reason)) > 0),
  CONSTRAINT chk_traceability_status_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_traceability_status_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE OR REPLACE FUNCTION factoryos_guard_traceability_unit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_item UUID;
  v_receipt UUID;
  v_receipt_status VARCHAR(16);
  v_accepted NUMERIC(18,4);
  v_existing_quantity NUMERIC(18,4);
  v_supplier UUID;
  v_report_order UUID;
  v_report_line UUID;
  v_good_quantity NUMERIC(18,4);
  v_template_active BOOLEAN;
  v_template_types TEXT[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'traceability unit identity and evidence cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.status <> 'ACTIVE' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'traceability units must start ACTIVE under the authenticated actor'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.goods_receipt_line_id IS NOT NULL THEN
      SELECT gl.inventory_item_id, gl.goods_receipt_id, gr.status, gl.accepted_quantity, po.supplier_id
        INTO v_item, v_receipt, v_receipt_status, v_accepted, v_supplier
      FROM goods_receipt_lines gl
      JOIN goods_receipts gr
        ON gr.id = gl.goods_receipt_id AND gr.tenant_id = gl.tenant_id AND gr.factory_id = gl.factory_id
      JOIN purchase_orders po
        ON po.id = gr.purchase_order_id AND po.tenant_id = gr.tenant_id AND po.factory_id = gr.factory_id
      WHERE gl.id = NEW.goods_receipt_line_id
        AND gl.tenant_id = NEW.tenant_id AND gl.factory_id = NEW.factory_id
      FOR UPDATE OF gl;

      IF NOT FOUND OR v_receipt_status <> 'POSTED' OR v_accepted <= 0 THEN
        RAISE EXCEPTION 'material lot provenance must reference a posted GRN line with accepted quantity'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.quantity > v_accepted THEN
        RAISE EXCEPTION 'traceability quantity cannot exceed accepted quantity on the source GRN line'
          USING ERRCODE = '23514';
      END IF;
      SELECT COALESCE(sum(u.quantity), 0)::numeric(18,4)
        INTO v_existing_quantity
      FROM traceability_units u
      WHERE u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id
        AND u.goods_receipt_line_id = NEW.goods_receipt_line_id
        AND (
          (NEW.unit_type = 'SERIAL' AND u.unit_type = 'SERIAL')
          OR (NEW.unit_type <> 'SERIAL' AND u.unit_type <> 'SERIAL')
        );
      IF v_existing_quantity + NEW.quantity > v_accepted THEN
        RAISE EXCEPTION 'cumulative material lot/serial quantity cannot exceed accepted GRN quantity'
          USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        SELECT 1 FROM traceability_units u
        WHERE u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id
          AND u.goods_receipt_line_id = NEW.goods_receipt_line_id
          AND ((NEW.unit_type = 'SERIAL' AND u.unit_type <> 'SERIAL')
            OR (NEW.unit_type <> 'SERIAL' AND u.unit_type = 'SERIAL'))
      ) THEN
        RAISE EXCEPTION 'a GRN line must be represented as lots/bulk identities or serial identities, not both'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.inventory_item_id IS NOT NULL AND NEW.inventory_item_id IS DISTINCT FROM v_item THEN
        RAISE EXCEPTION 'traceability item does not match its GRN line inventory item'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.goods_receipt_id IS NOT NULL AND NEW.goods_receipt_id IS DISTINCT FROM v_receipt THEN
        RAISE EXCEPTION 'traceability unit receipt does not match its GRN line'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.supplier_id IS NOT NULL AND NEW.supplier_id IS DISTINCT FROM v_supplier THEN
        RAISE EXCEPTION 'supplier provenance must be derived from the GRN purchase order'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.product_role NOT IN ('MATERIAL', 'PACKAGING') THEN
        RAISE EXCEPTION 'GRN-linked traceability units must represent received materials or packaging'
          USING ERRCODE = '23514';
      END IF;
      NEW.inventory_item_id := v_item;
      NEW.goods_receipt_id := v_receipt;
      NEW.supplier_id := v_supplier;
    ELSIF NEW.supplier_id IS NOT NULL THEN
      RAISE EXCEPTION 'supplier provenance can only be assigned through a posted goods receipt line'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.production_report_id IS NOT NULL THEN
      SELECT r.order_id, r.order_line_id, r.good_quantity
        INTO v_report_order, v_report_line, v_good_quantity
      FROM order_production_reports r
      WHERE r.id = NEW.production_report_id AND r.tenant_id = NEW.tenant_id AND r.factory_id = NEW.factory_id
      FOR UPDATE OF r;

      IF NOT FOUND OR v_good_quantity <= 0 THEN
        RAISE EXCEPTION 'finished-good provenance must reference a production report with good output'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM v_report_order THEN
        RAISE EXCEPTION 'traceability order does not match production report'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.order_line_id IS NOT NULL AND NEW.order_line_id IS DISTINCT FROM v_report_line THEN
        RAISE EXCEPTION 'traceability order line does not match production report'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.product_role <> 'FINISHED_GOOD' OR NEW.quantity > v_good_quantity THEN
        RAISE EXCEPTION 'production-report trace must be a finished good within its reported good quantity'
          USING ERRCODE = '23514';
      END IF;
      SELECT COALESCE(sum(u.quantity), 0)::numeric(18,4)
        INTO v_existing_quantity
      FROM traceability_units u
      WHERE u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id
        AND u.production_report_id = NEW.production_report_id
        AND (
          (NEW.unit_type = 'SERIAL' AND u.unit_type = 'SERIAL')
          OR (NEW.unit_type <> 'SERIAL' AND u.unit_type <> 'SERIAL')
        );
      IF NEW.unit_type <> 'SERIAL' AND v_existing_quantity + NEW.quantity > v_good_quantity THEN
        RAISE EXCEPTION 'cumulative finished-good lot quantity cannot exceed production report good output'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.unit_type = 'SERIAL' THEN
        IF EXISTS (
          SELECT 1 FROM traceability_units u
          WHERE u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id
            AND u.production_report_id = NEW.production_report_id AND u.unit_type <> 'SERIAL'
        ) OR v_existing_quantity + NEW.quantity > v_good_quantity THEN
          RAISE EXCEPTION 'serialized finished goods must uniquely account for reported good output'
            USING ERRCODE = '23514';
        END IF;
      ELSIF EXISTS (
        SELECT 1 FROM traceability_units u
        WHERE u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id
          AND u.production_report_id = NEW.production_report_id
      ) THEN
        RAISE EXCEPTION 'a production report can be represented by one finished-good lot or a set of serial identities, not both'
          USING ERRCODE = '23514';
      END IF;
      NEW.order_id := v_report_order;
      NEW.order_line_id := v_report_line;
    END IF;

    IF NEW.order_line_id IS NOT NULL THEN
      IF NEW.order_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM order_lines ol
        WHERE ol.id = NEW.order_line_id AND ol.order_id = NEW.order_id
          AND ol.tenant_id = NEW.tenant_id AND ol.factory_id = NEW.factory_id
      ) THEN
        RAISE EXCEPTION 'traceability order line must belong to the same scoped order'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF NEW.label_template_id IS NOT NULL THEN
      SELECT lt.is_active, lt.supported_unit_types
        INTO v_template_active, v_template_types
      FROM traceability_label_templates lt
      WHERE lt.id = NEW.label_template_id AND lt.tenant_id = NEW.tenant_id AND lt.factory_id = NEW.factory_id;
      IF NOT FOUND OR NOT v_template_active OR NOT (NEW.unit_type = ANY(v_template_types)) THEN
        RAISE EXCEPTION 'label template must be active and support this traceability unit type'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.id, NEW.tenant_id, NEW.factory_id, NEW.unit_type, NEW.product_role, NEW.unit_code,
    NEW.barcode_value, NEW.inventory_item_id, NEW.quantity, NEW.unit, NEW.supplier_id,
    NEW.goods_receipt_id, NEW.goods_receipt_line_id, NEW.order_id, NEW.order_line_id,
    NEW.production_report_id, NEW.label_template_id, NEW.external_reference,
    NEW.manufactured_at, NEW.expires_at, NEW.attributes, NEW.idempotency_key,
    NEW.request_hash, NEW.created_by_user_id, NEW.correlation_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.factory_id, OLD.unit_type, OLD.product_role, OLD.unit_code,
    OLD.barcode_value, OLD.inventory_item_id, OLD.quantity, OLD.unit, OLD.supplier_id,
    OLD.goods_receipt_id, OLD.goods_receipt_line_id, OLD.order_id, OLD.order_line_id,
    OLD.production_report_id, OLD.label_template_id, OLD.external_reference,
    OLD.manufactured_at, OLD.expires_at, OLD.attributes, OLD.idempotency_key,
    OLD.request_hash, OLD.created_by_user_id, OLD.correlation_id, OLD.created_at
  ) OR NEW.version <> OLD.version + 1 OR NEW.status = OLD.status
     OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'traceability unit identity is immutable; use a valid status transition'
      USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.status = 'ACTIVE' AND NEW.status IN ('QUARANTINED', 'RECALLED', 'DISPOSED', 'SHIPPED'))
    OR (OLD.status = 'QUARANTINED' AND NEW.status IN ('ACTIVE', 'RECALLED', 'DISPOSED'))
  ) THEN
    RAISE EXCEPTION 'invalid traceability status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_traceability_unit_guard
BEFORE INSERT OR UPDATE OR DELETE ON traceability_units
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_traceability_unit();

CREATE OR REPLACE FUNCTION factoryos_guard_product_genealogy_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_quantity NUMERIC(18,4);
  v_source_unit VARCHAR(50);
  v_source_item UUID;
  v_source_type VARCHAR(24);
  v_source_role VARCHAR(20);
  v_source_status VARCHAR(16);
  v_source_expiry DATE;
  v_source_created TIMESTAMPTZ;
  v_target_status VARCHAR(16);
  v_policy VARCHAR(12);
  v_cycle BOOLEAN;
  v_prior_quantity NUMERIC(18,4);
  v_earlier_candidate BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'product genealogy evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'genealogy event actor must match the authenticated user'
      USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || NEW.factory_id::text || ':product-genealogy-graph', 0
  ));

  SELECT u.quantity, u.unit, u.inventory_item_id, u.unit_type, u.product_role, u.status, u.expires_at, u.created_at
    INTO v_source_quantity, v_source_unit, v_source_item, v_source_type, v_source_role, v_source_status, v_source_expiry, v_source_created
  FROM traceability_units u
  WHERE u.id = NEW.source_unit_id AND u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'genealogy source unit is missing from this factory'
      USING ERRCODE = '23503';
  END IF;
  SELECT u.status INTO v_target_status
  FROM traceability_units u
  WHERE u.id = NEW.target_unit_id AND u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'genealogy target unit is missing from this factory'
      USING ERRCODE = '23503';
  END IF;
  IF v_source_status IN ('QUARANTINED', 'RECALLED', 'DISPOSED', 'SHIPPED')
     OR v_target_status IN ('QUARANTINED', 'RECALLED', 'DISPOSED', 'SHIPPED') THEN
    RAISE EXCEPTION 'genealogy cannot be changed using quarantined, recalled, disposed or shipped identities'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.quantity > v_source_quantity THEN
    RAISE EXCEPTION 'genealogy quantity cannot exceed the source lot/serial quantity'
      USING ERRCODE = '23514';
  END IF;
  NEW.unit := v_source_unit;

  SELECT COALESCE(sum(e.quantity), 0)::numeric(18,4)
    INTO v_prior_quantity
  FROM product_genealogy_events e
  WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    AND e.source_unit_id = NEW.source_unit_id;
  IF v_prior_quantity + NEW.quantity > v_source_quantity THEN
    RAISE EXCEPTION 'cumulative genealogy relationship quantity cannot exceed source identity quantity'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.relationship_type IN ('CONSUMED_INTO', 'PROCESSED_INTO') THEN
    SELECT COALESCE(sum(e.quantity), 0)::numeric(18,4)
      INTO v_prior_quantity
    FROM product_genealogy_events e
    WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
      AND e.source_unit_id = NEW.source_unit_id
      AND e.relationship_type IN ('CONSUMED_INTO', 'PROCESSED_INTO');
    IF v_prior_quantity + NEW.quantity > v_source_quantity THEN
      RAISE EXCEPTION 'cumulative genealogy consumption cannot exceed source quantity'
        USING ERRCODE = '23514';
    END IF;

    IF v_source_role = 'MATERIAL' THEN
      SELECT allocation_policy INTO v_policy
      FROM traceability_settings
      WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
      FOR SHARE;
      IF v_policy = 'LOT' AND v_source_type <> 'LOT' THEN
        RAISE EXCEPTION 'factory allocation policy requires material lots'
          USING ERRCODE = '23514';
      ELSIF v_policy = 'SERIAL' AND v_source_type <> 'SERIAL' THEN
        RAISE EXCEPTION 'factory allocation policy requires material serial identities'
          USING ERRCODE = '23514';
      ELSIF v_policy = 'FEFO' AND v_source_expiry IS NOT NULL AND v_source_expiry < CURRENT_DATE THEN
        RAISE EXCEPTION 'expired material cannot be consumed under FEFO allocation policy'
          USING ERRCODE = '23514';
      ELSIF v_policy IN ('FIFO', 'FEFO') THEN
        IF v_source_item IS NULL THEN
          RAISE EXCEPTION 'FIFO/FEFO genealogy requires a source identity mapped to an inventory item'
            USING ERRCODE = '23514';
        END IF;
        SELECT EXISTS (
          SELECT 1
          FROM traceability_units c
          WHERE c.tenant_id = NEW.tenant_id AND c.factory_id = NEW.factory_id
            AND c.inventory_item_id = v_source_item
            AND c.product_role = 'MATERIAL'
            AND c.unit_type IN ('LOT', 'SERIAL')
            AND c.id <> NEW.source_unit_id
            AND c.status = 'ACTIVE'
            AND (c.expires_at IS NULL OR c.expires_at >= CURRENT_DATE)
            AND c.quantity > COALESCE((
              SELECT sum(e.quantity)
              FROM product_genealogy_events e
              WHERE e.tenant_id = c.tenant_id AND e.factory_id = c.factory_id
                AND e.source_unit_id = c.id
                AND e.relationship_type IN ('CONSUMED_INTO', 'PROCESSED_INTO')
            ), 0)
            AND (
              (v_policy = 'FIFO' AND (c.created_at, c.id) < (v_source_created, NEW.source_unit_id))
              OR
              (v_policy = 'FEFO' AND (
                (c.expires_at IS NOT NULL AND v_source_expiry IS NULL)
                OR c.expires_at < v_source_expiry
                OR (c.expires_at IS NOT DISTINCT FROM v_source_expiry
                    AND (c.created_at, c.id) < (v_source_created, NEW.source_unit_id))
              ))
            )
        ) INTO v_earlier_candidate;
        IF v_earlier_candidate THEN
          RAISE EXCEPTION 'an earlier eligible material identity must be consumed first under % policy', v_policy
            USING ERRCODE = '23514';
        END IF;
      END IF;
    END IF;
  END IF;

  WITH RECURSIVE descendants(unit_id, visited) AS (
    SELECT NEW.target_unit_id, ARRAY[NEW.target_unit_id]::uuid[]
    UNION ALL
    SELECT e.target_unit_id, d.visited || e.target_unit_id
    FROM descendants d
    JOIN product_genealogy_events e
      ON e.source_unit_id = d.unit_id AND e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    WHERE NOT e.target_unit_id = ANY(d.visited)
  )
  SELECT EXISTS (SELECT 1 FROM descendants WHERE unit_id = NEW.source_unit_id) INTO v_cycle;
  IF v_cycle THEN
    RAISE EXCEPTION 'genealogy relationship would create a traceability cycle'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_product_genealogy_guard
BEFORE INSERT OR UPDATE OR DELETE ON product_genealogy_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_product_genealogy_event();

CREATE OR REPLACE FUNCTION factoryos_guard_traceability_unit_status_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit traceability_units%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'traceability status history is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.changed_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'traceability status actor must match authenticated user'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_unit FROM traceability_units u
  WHERE u.id = NEW.unit_id AND u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id;
  IF NOT FOUND OR v_unit.version <> NEW.version OR v_unit.status <> NEW.to_status THEN
    RAISE EXCEPTION 'traceability status history must match the applied unit version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_traceability_status_event_guard
BEFORE INSERT OR UPDATE OR DELETE ON traceability_unit_status_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_traceability_unit_status_event();

CREATE OR REPLACE FUNCTION factoryos_assert_traceability_unit_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version = 1 THEN
    IF NOT EXISTS (
      SELECT 1 FROM audit_events a
      WHERE a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
        AND a.resource_type = 'TRACEABILITY_UNIT' AND a.resource_id = NEW.id AND a.action = 'REGISTERED'
    ) OR NOT EXISTS (
      SELECT 1 FROM outbox_events o
      WHERE o.tenant_id = NEW.tenant_id AND o.factory_id = NEW.factory_id
        AND o.aggregate_type = 'TRACEABILITY_UNIT' AND o.aggregate_id = NEW.id
        AND o.event_type = 'TRACEABILITY.UNIT_REGISTERED'
    ) THEN
      RAISE EXCEPTION 'traceability units require transactional audit and outbox evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM traceability_unit_status_events e
      WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
        AND e.unit_id = NEW.id AND e.version = NEW.version AND e.to_status = NEW.status
    ) OR NOT EXISTS (
      SELECT 1 FROM audit_events a
      WHERE a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
        AND a.resource_type = 'TRACEABILITY_UNIT' AND a.resource_id = NEW.id AND a.action = 'STATUS_CHANGED'
    ) OR NOT EXISTS (
      SELECT 1 FROM outbox_events o
      WHERE o.tenant_id = NEW.tenant_id AND o.factory_id = NEW.factory_id
        AND o.aggregate_type = 'TRACEABILITY_UNIT' AND o.aggregate_id = NEW.id
        AND o.event_type = 'TRACEABILITY.UNIT_STATUS_CHANGED'
    ) THEN
      RAISE EXCEPTION 'traceability status changes require status history, transactional audit and outbox evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ctr_traceability_unit_evidence
AFTER INSERT OR UPDATE ON traceability_units
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_traceability_unit_evidence();

CREATE OR REPLACE FUNCTION factoryos_assert_genealogy_event_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
      AND a.resource_type = 'PRODUCT_GENEALOGY_EVENT' AND a.resource_id = NEW.id AND a.action = 'RECORDED'
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id = NEW.tenant_id AND o.factory_id = NEW.factory_id
      AND o.aggregate_type = 'PRODUCT_GENEALOGY_EVENT' AND o.aggregate_id = NEW.id
      AND o.event_type = 'TRACEABILITY.GENEALOGY_RECORDED'
  ) THEN
    RAISE EXCEPTION 'genealogy events require transactional audit and outbox evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ctr_product_genealogy_event_evidence
AFTER INSERT ON product_genealogy_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_genealogy_event_evidence();

ALTER TABLE traceability_label_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE traceability_label_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY traceability_label_templates_tenant_isolation ON traceability_label_templates
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE traceability_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE traceability_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY traceability_settings_tenant_isolation ON traceability_settings
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE traceability_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE traceability_units FORCE ROW LEVEL SECURITY;
CREATE POLICY traceability_units_tenant_isolation ON traceability_units
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE product_genealogy_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_genealogy_events FORCE ROW LEVEL SECURITY;
CREATE POLICY product_genealogy_events_tenant_isolation ON product_genealogy_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE traceability_unit_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE traceability_unit_status_events FORCE ROW LEVEL SECURITY;
CREATE POLICY traceability_unit_status_events_tenant_isolation ON traceability_unit_status_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version, checksum)
VALUES ('074_lot_serial_product_genealogy', NULL)
ON CONFLICT (version) DO NOTHING;

COMMENT ON TABLE traceability_units IS
  'Factory-scoped immutable material/finished-good lot, serial, pallet, carton, bundle and shipment identities with GRN/production provenance.';
COMMENT ON TABLE product_genealogy_events IS
  'Append-only directed genealogy edges supporting forward/reverse trace, consumption, processing, packaging, splits, merges, rework and shipment.';
COMMENT ON TABLE traceability_label_templates IS
  'Tenant/factory-configurable barcode/QR label layouts; existing template evidence is versioned rather than edited in place.';
COMMENT ON TABLE traceability_settings IS
  'Factory-configurable genealogy retention and allocation policy. FIFO/FEFO/Lot/Serial choices are checked at material consumption.';

COMMIT;
