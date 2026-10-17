BEGIN;
-- WP02: tenant/factory-scoped supplier master and purchase-order lifecycle.
CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  country_code CHAR(2) NOT NULL DEFAULT 'BD',
  email VARCHAR(320),
  phone VARCHAR(80),
  tax_reference VARCHAR(120),
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'BDT',
  address TEXT,
  notes TEXT,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT uq_suppliers_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT uq_suppliers_tenant_code UNIQUE (tenant_id, code),
  CONSTRAINT fk_suppliers_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_suppliers_created_by FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_suppliers_status CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT chk_suppliers_country CHECK (country_code = upper(country_code) AND char_length(country_code) = 2),
  CONSTRAINT chk_suppliers_currency CHECK (currency = upper(currency) AND char_length(currency) = 3),
  CONSTRAINT chk_suppliers_payment_terms CHECK (payment_terms_days BETWEEN 0 AND 3650),
  CONSTRAINT chk_suppliers_version CHECK (version > 0),
  CONSTRAINT chk_suppliers_code CHECK (length(btrim(code)) > 0),
  CONSTRAINT chk_suppliers_name CHECK (length(btrim(name)) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_tenant_code_ci ON suppliers (tenant_id, upper(code));
CREATE INDEX IF NOT EXISTS idx_suppliers_tenant_status_name ON suppliers (tenant_id, status, lower(name), id);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  supplier_id UUID NOT NULL,
  po_number VARCHAR(100) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_delivery_date DATE,
  currency CHAR(3) NOT NULL DEFAULT 'BDT',
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by_user_id UUID NOT NULL,
  submitted_by_user_id UUID,
  submitted_at TIMESTAMPTZ,
  approved_by_user_id UUID,
  approved_at TIMESTAMPTZ,
  rejected_by_user_id UUID,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  cancelled_by_user_id UUID,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  idempotency_key VARCHAR(255),
  request_hash CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT uq_purchase_orders_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_purchase_orders_scope_number UNIQUE (tenant_id, factory_id, po_number),
  CONSTRAINT uq_purchase_orders_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_purchase_orders_factory_tenant FOREIGN KEY (factory_id, tenant_id) REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_purchase_orders_supplier_tenant FOREIGN KEY (supplier_id, tenant_id) REFERENCES suppliers(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_purchase_orders_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_purchase_orders_submitter FOREIGN KEY (submitted_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_purchase_orders_approver FOREIGN KEY (approved_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_purchase_orders_rejector FOREIGN KEY (rejected_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_purchase_orders_canceller FOREIGN KEY (cancelled_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_purchase_orders_status CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT chk_purchase_orders_currency CHECK (currency = upper(currency) AND char_length(currency) = 3),
  CONSTRAINT chk_purchase_orders_payment_terms CHECK (payment_terms_days BETWEEN 0 AND 3650),
  CONSTRAINT chk_purchase_orders_version CHECK (version > 0),
  CONSTRAINT chk_purchase_orders_number CHECK (length(btrim(po_number)) > 0),
  CONSTRAINT chk_purchase_orders_date_range CHECK (expected_delivery_date IS NULL OR expected_delivery_date >= order_date),
  CONSTRAINT chk_purchase_orders_idempotency_pair CHECK (
    (idempotency_key IS NULL AND request_hash IS NULL)
    OR (length(btrim(idempotency_key)) > 0 AND request_hash IS NOT NULL AND request_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT chk_purchase_orders_submission_fields CHECK (
    (submitted_by_user_id IS NULL AND submitted_at IS NULL)
    OR (submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL)
  ),
  CONSTRAINT chk_purchase_orders_approval_fields CHECK (
    (approved_by_user_id IS NULL AND approved_at IS NULL)
    OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT chk_purchase_orders_rejection_fields CHECK (
    (rejected_by_user_id IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL)
    OR (rejected_by_user_id IS NOT NULL AND rejected_at IS NOT NULL AND length(btrim(COALESCE(rejection_reason, ''))) > 0)
  ),
  CONSTRAINT chk_purchase_orders_cancellation_fields CHECK (
    (cancelled_by_user_id IS NULL AND cancelled_at IS NULL AND cancellation_reason IS NULL)
    OR (cancelled_by_user_id IS NOT NULL AND cancelled_at IS NOT NULL AND length(btrim(COALESCE(cancellation_reason, ''))) > 0)
  )
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_factory_status_created
  ON purchase_orders (tenant_id, factory_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier_created
  ON purchase_orders (tenant_id, supplier_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  purchase_order_id UUID NOT NULL,
  line_number INTEGER NOT NULL,
  inventory_item_id UUID,
  description VARCHAR(500) NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  unit VARCHAR(50) NOT NULL,
  unit_price NUMERIC(18,4) NOT NULL,
  line_amount NUMERIC(24,4) GENERATED ALWAYS AS (round(quantity * unit_price, 4)) STORED,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_purchase_order_lines_number UNIQUE (purchase_order_id, line_number),
  CONSTRAINT fk_purchase_order_lines_order_scope FOREIGN KEY (purchase_order_id, tenant_id, factory_id) REFERENCES purchase_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_purchase_order_lines_inventory_scope FOREIGN KEY (inventory_item_id, tenant_id, factory_id) REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_purchase_order_lines_number CHECK (line_number > 0),
  CONSTRAINT chk_purchase_order_lines_quantity CHECK (quantity > 0),
  CONSTRAINT chk_purchase_order_lines_price CHECK (unit_price >= 0),
  CONSTRAINT chk_purchase_order_lines_description CHECK (length(btrim(description)) > 0),
  CONSTRAINT chk_purchase_order_lines_unit CHECK (length(btrim(unit)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_scope_order
  ON purchase_order_lines (tenant_id, factory_id, purchase_order_id, line_number);

CREATE TABLE IF NOT EXISTS purchase_order_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  purchase_order_id UUID NOT NULL,
  from_status VARCHAR(24),
  to_status VARCHAR(24) NOT NULL,
  version BIGINT NOT NULL,
  actor_user_id UUID NOT NULL,
  reason TEXT,
  request_id UUID,
  trace_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_purchase_order_history_version UNIQUE (purchase_order_id, version),
  CONSTRAINT fk_purchase_order_history_order_scope FOREIGN KEY (purchase_order_id, tenant_id, factory_id) REFERENCES purchase_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_purchase_order_history_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_purchase_order_history_status CHECK (
    to_status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED')
    AND (from_status IS NULL OR from_status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'))
  ),
  CONSTRAINT chk_purchase_order_history_version CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS idx_purchase_order_history_scope_created
  ON purchase_order_status_history (tenant_id, factory_id, purchase_order_id, created_at, id);

CREATE OR REPLACE FUNCTION factoryos_guard_supplier_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supplier records cannot be deleted; disable the supplier instead' USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.code IS DISTINCT FROM OLD.code OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'supplier identity and creation provenance are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'supplier updates must increment version by exactly one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_suppliers_lifecycle_guard
BEFORE UPDATE OR DELETE ON suppliers FOR EACH ROW EXECUTE FUNCTION factoryos_guard_supplier_lifecycle();

CREATE OR REPLACE FUNCTION factoryos_guard_purchase_order_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase orders cannot be deleted; use a lifecycle transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.factory_id IS DISTINCT FROM OLD.factory_id OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.po_number IS DISTINCT FROM OLD.po_number OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'purchase-order identity, supplier and creation provenance are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'purchase-order updates must increment version by exactly one' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'DRAFT'
     AND ROW(NEW.order_date, NEW.expected_delivery_date, NEW.currency, NEW.payment_terms_days, NEW.notes)
         IS DISTINCT FROM ROW(OLD.order_date, OLD.expected_delivery_date, OLD.currency, OLD.payment_terms_days, OLD.notes) THEN
    RAISE EXCEPTION 'commercial terms are frozen after a purchase order is submitted' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('SUBMITTED', 'CANCELLED'))
      OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'invalid purchase-order transition: % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'SUBMITTED' AND (NEW.submitted_by_user_id IS NULL OR NEW.submitted_at IS NULL) THEN
      RAISE EXCEPTION 'submission actor and timestamp are required' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'APPROVED' THEN
      IF NEW.approved_by_user_id IS NULL OR NEW.approved_at IS NULL THEN
        RAISE EXCEPTION 'approval actor and timestamp are required' USING ERRCODE = '23514';
      END IF;
      IF NEW.approved_by_user_id = NEW.created_by_user_id THEN
        RAISE EXCEPTION 'purchase-order creator cannot approve their own order' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.status = 'REJECTED' AND (NEW.rejected_by_user_id IS NULL OR NEW.rejected_at IS NULL
       OR length(btrim(COALESCE(NEW.rejection_reason, ''))) = 0) THEN
      RAISE EXCEPTION 'rejection actor, timestamp and reason are required' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'CANCELLED' AND (NEW.cancelled_by_user_id IS NULL OR NEW.cancelled_at IS NULL
       OR length(btrim(COALESCE(NEW.cancellation_reason, ''))) = 0) THEN
      RAISE EXCEPTION 'cancellation actor, timestamp and reason are required' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_purchase_orders_lifecycle_guard
BEFORE UPDATE OR DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION factoryos_guard_purchase_order_lifecycle();

CREATE OR REPLACE FUNCTION factoryos_guard_purchase_order_line_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status VARCHAR(24);
  v_order_id UUID;
  v_tenant_id UUID;
  v_factory_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_order_id := OLD.purchase_order_id;
    v_tenant_id := OLD.tenant_id;
    v_factory_id := OLD.factory_id;
  ELSE
    v_order_id := NEW.purchase_order_id;
    v_tenant_id := NEW.tenant_id;
    v_factory_id := NEW.factory_id;
  END IF;
  SELECT status INTO v_status FROM purchase_orders
    WHERE id = v_order_id AND tenant_id = v_tenant_id AND factory_id = v_factory_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase order line parent does not exist in the same tenant/factory scope' USING ERRCODE = '23503';
  END IF;
  IF v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'purchase-order lines are immutable after submission' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_purchase_order_lines_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION factoryos_guard_purchase_order_line_lifecycle();

CREATE OR REPLACE FUNCTION factoryos_guard_purchase_order_history_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'purchase-order status history is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_purchase_order_history_immutable
BEFORE UPDATE OR DELETE ON purchase_order_status_history FOR EACH ROW EXECUTE FUNCTION factoryos_guard_purchase_order_history_immutable();

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
CREATE POLICY suppliers_tenant_isolation ON suppliers
  USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_orders_tenant_isolation ON purchase_orders
  USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_order_lines_tenant_isolation ON purchase_order_lines
  USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE purchase_order_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_status_history FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_order_status_history_tenant_isolation ON purchase_order_status_history
  USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO permissions (code, description) VALUES
  ('suppliers.read', 'Read tenant-scoped supplier records'),
  ('suppliers.write', 'Create and manage tenant-scoped suppliers'),
  ('purchase_orders.read', 'Read purchase orders within the authorized tenant/factory scope'),
  ('purchase_orders.write', 'Create and submit purchase orders within the authorized factory scope'),
  ('purchase_orders.approve', 'Approve or reject submitted purchase orders')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN' AND r.is_system = true
  AND p.code IN ('suppliers.read', 'suppliers.write', 'purchase_orders.read', 'purchase_orders.write', 'purchase_orders.approve')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'FACTORY_MANAGER' AND r.is_system = false
  AND p.code IN ('suppliers.read', 'suppliers.write', 'purchase_orders.read', 'purchase_orders.write')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO schema_migrations (version, checksum)
VALUES ('067_supplier_purchase_order_lifecycle', NULL)
ON CONFLICT (version) DO NOTHING;

COMMENT ON TABLE suppliers IS 'Tenant-private supplier master. Records are disabled rather than deleted; code and creator provenance are immutable.';
COMMENT ON TABLE purchase_orders IS 'Factory-scoped supplier purchase-order aggregate with optimistic versioning, separate approval authority, and durable idempotency claims.';
COMMENT ON TABLE purchase_order_lines IS 'Commercial purchase-order lines; line amount is deterministic and lines become immutable after submission.';
COMMENT ON TABLE purchase_order_status_history IS 'Append-only purchase-order lifecycle decisions with actor, reason, correlation references and aggregate version.';
COMMIT;
