BEGIN;

-- MRP-lite is a read-only planning snapshot. It never posts stock or releases a PO.
INSERT INTO permissions (code, description)
VALUES
  ('mrp.read', 'Read material requirement plans and factory-scoped material shortage projections'),
  ('mrp.write', 'Calculate and persist factory-scoped material requirement planning snapshots')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('mrp.read', 'mrp.write')
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE mrp_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  horizon_start DATE NOT NULL,
  horizon_end DATE NOT NULL,
  allocation_policy VARCHAR(32) NOT NULL DEFAULT 'DUE_DATE_FIFO',
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  request_id UUID,
  trace_id UUID,
  correlation_id UUID NOT NULL,
  created_by_user_id UUID NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  exceptions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_mrp_plan_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_mrp_plan_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_mrp_plan_factory_scope
    FOREIGN KEY (factory_id, tenant_id) REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_plan_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_mrp_plan_horizon CHECK (horizon_end >= horizon_start AND horizon_end - horizon_start <= 365),
  CONSTRAINT chk_mrp_plan_allocation_policy CHECK (allocation_policy = 'DUE_DATE_FIFO'),
  CONSTRAINT chk_mrp_plan_idempotency_key CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_mrp_plan_request_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_mrp_plan_summary CHECK (jsonb_typeof(summary) = 'object'),
  CONSTRAINT chk_mrp_plan_exceptions CHECK (jsonb_typeof(exceptions) = 'array')
);

CREATE INDEX idx_mrp_plans_scope_created
  ON mrp_plans (tenant_id, factory_id, created_at DESC, id DESC);

CREATE TABLE mrp_plan_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  plan_id UUID NOT NULL,
  order_id UUID NOT NULL,
  order_line_id UUID NOT NULL,
  product_id UUID NOT NULL,
  product_version_id UUID NOT NULL,
  bom_line_id UUID NOT NULL,
  component_item_id UUID NOT NULL,
  order_number VARCHAR(100) NOT NULL,
  order_status VARCHAR(30) NOT NULL,
  order_line_number INTEGER NOT NULL,
  need_by_date DATE NOT NULL,
  product_code VARCHAR(100) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  product_version_number INTEGER NOT NULL,
  bom_line_number INTEGER NOT NULL,
  component_sku VARCHAR(100) NOT NULL,
  component_name VARCHAR(255) NOT NULL,
  component_unit VARCHAR(50) NOT NULL,
  remaining_finished_quantity NUMERIC(18,4) NOT NULL,
  expected_yield_percent NUMERIC(7,4) NOT NULL,
  base_quantity_per NUMERIC(18,4) NOT NULL,
  wastage_percent NUMERIC(7,4) NOT NULL,
  required_quantity NUMERIC(18,4) NOT NULL,
  on_hand_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  allocated_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  available_on_hand_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  incoming_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  planned_on_hand_allocation_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  planned_incoming_allocation_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  available_by_need_date_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  shortage_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  shortage_date DATE,
  projected_available_date DATE,
  allocation_status VARCHAR(20) NOT NULL,
  substitute_scenarios JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_mrp_requirement_plan_order_bom
    UNIQUE (plan_id, order_line_id, bom_line_id),
  CONSTRAINT fk_mrp_requirement_plan_scope
    FOREIGN KEY (plan_id, tenant_id, factory_id)
    REFERENCES mrp_plans(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_requirement_order_line_scope
    FOREIGN KEY (order_line_id, order_id, tenant_id, factory_id)
    REFERENCES order_lines(id, order_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_requirement_product_scope
    FOREIGN KEY (product_id, tenant_id, factory_id)
    REFERENCES product_definitions(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_requirement_version_scope
    FOREIGN KEY (product_version_id, tenant_id, factory_id, product_id)
    REFERENCES product_versions(id, tenant_id, factory_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_requirement_bom_scope
    FOREIGN KEY (bom_line_id, product_version_id, tenant_id, factory_id)
    REFERENCES product_bom_lines(id, product_version_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_requirement_component_scope
    FOREIGN KEY (component_item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_mrp_requirement_order_status CHECK (order_status IN ('CONFIRMED', 'IN_PROGRESS')),
  CONSTRAINT chk_mrp_requirement_positive_line_numbers
    CHECK (order_line_number > 0 AND product_version_number > 0 AND bom_line_number > 0),
  CONSTRAINT chk_mrp_requirement_units CHECK (length(btrim(component_unit)) > 0),
  CONSTRAINT chk_mrp_requirement_yield CHECK (expected_yield_percent > 0 AND expected_yield_percent <= 100),
  CONSTRAINT chk_mrp_requirement_wastage CHECK (wastage_percent >= 0 AND wastage_percent <= 100),
  CONSTRAINT chk_mrp_requirement_quantities CHECK (
    remaining_finished_quantity > 0 AND base_quantity_per > 0 AND required_quantity > 0
    AND on_hand_quantity >= 0 AND allocated_quantity >= 0 AND available_on_hand_quantity >= 0
    AND incoming_quantity >= 0 AND planned_on_hand_allocation_quantity >= 0
    AND planned_incoming_allocation_quantity >= 0 AND available_by_need_date_quantity >= 0
    AND shortage_quantity >= 0
  ),
  CONSTRAINT chk_mrp_requirement_shortage_pair CHECK (
    (shortage_quantity = 0 AND shortage_date IS NULL)
    OR (shortage_quantity > 0 AND shortage_date = need_by_date)
  ),
  CONSTRAINT chk_mrp_requirement_allocation_status
    CHECK (allocation_status IN ('COVERED', 'LATE_SUPPLY', 'UNSUPPLIED')),
  CONSTRAINT chk_mrp_requirement_late_supply CHECK (
    (allocation_status = 'COVERED' AND shortage_quantity = 0 AND projected_available_date IS NULL)
    OR (allocation_status = 'LATE_SUPPLY' AND shortage_quantity > 0 AND projected_available_date > need_by_date)
    OR (allocation_status = 'UNSUPPLIED' AND shortage_quantity > 0)
  ),
  CONSTRAINT chk_mrp_requirement_scenarios CHECK (jsonb_typeof(substitute_scenarios) = 'array')
);

CREATE INDEX idx_mrp_requirements_plan_due
  ON mrp_plan_requirements (tenant_id, factory_id, plan_id, need_by_date, order_number, order_line_number);
CREATE INDEX idx_mrp_requirements_component_due
  ON mrp_plan_requirements (tenant_id, factory_id, component_item_id, need_by_date, plan_id);
CREATE INDEX idx_mrp_requirements_order
  ON mrp_plan_requirements (tenant_id, factory_id, order_id, order_line_id, plan_id);

CREATE OR REPLACE FUNCTION factoryos_prevent_mrp_plan_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'MRP planning snapshots are immutable; calculate a new run instead'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER mrp_plans_immutable
BEFORE UPDATE OR DELETE ON mrp_plans
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_mrp_plan_mutation();

CREATE TRIGGER mrp_plan_requirements_immutable
BEFORE UPDATE OR DELETE ON mrp_plan_requirements
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_mrp_plan_mutation();

ALTER TABLE mrp_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrp_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY mrp_plans_tenant_isolation ON mrp_plans
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE mrp_plan_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrp_plan_requirements FORCE ROW LEVEL SECURITY;
CREATE POLICY mrp_plan_requirements_tenant_isolation ON mrp_plan_requirements
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE mrp_plans IS
  'Immutable, factory-scoped MRP-lite calculation run with idempotent request and explainable exceptions; it does not post stock or create/release purchase orders.';
COMMENT ON TABLE mrp_plan_requirements IS
  'Immutable per-order-line and BOM-component demand allocation snapshot including current reserved stock, approved open incoming supply and the shortage/projected arrival dates.';
COMMENT ON COLUMN mrp_plan_requirements.allocated_quantity IS
  'Current inventory quantity already reserved by operational inventory reservations at calculation time.';
COMMENT ON COLUMN mrp_plan_requirements.planned_on_hand_allocation_quantity IS
  'Advisory FIFO allocation proposed from unreserved on-hand inventory; it is not an inventory reservation.';
COMMENT ON COLUMN mrp_plan_requirements.planned_incoming_allocation_quantity IS
  'Advisory allocation against open approved purchase-order quantity, including supply expected after the demand date.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('089_mrp_lite_material_planning', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
