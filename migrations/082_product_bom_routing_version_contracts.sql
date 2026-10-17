BEGIN;

-- FR-UFM-03 / FR-UFM-07: versioned product definitions, effective-dated
-- releases, component substitutions, and factory-scoped manufacturing routes.
INSERT INTO permissions (code, description)
VALUES
  ('products.master.read', 'Read factory-scoped product definitions, BOMs, routes and version history'),
  ('products.master.write', 'Create product definitions, draft versions, BOMs, routes and work centres'),
  ('products.version.approve', 'Approve or retire effective-dated product versions in the authorized factory'),
  ('products.alternate.approve', 'Approve permitted alternate material contracts in the authorized factory')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'products.master.read',
  'products.master.write',
  'products.version.approve',
  'products.alternate.approve'
)
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE product_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  inventory_item_id UUID NOT NULL,
  product_code VARCHAR(120) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  product_type VARCHAR(24) NOT NULL DEFAULT 'STANDARD',
  base_unit VARCHAR(50) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  version BIGINT NOT NULL DEFAULT 1,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_product_definition_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_product_definition_item_scope UNIQUE (inventory_item_id, tenant_id, factory_id),
  CONSTRAINT fk_product_definition_factory
    FOREIGN KEY (factory_id, tenant_id) REFERENCES factories (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_definition_inventory_item
    FOREIGN KEY (inventory_item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_definition_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_definition_updater
    FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_product_definition_code CHECK (length(btrim(product_code)) > 0),
  CONSTRAINT chk_product_definition_name CHECK (length(btrim(product_name)) > 0),
  CONSTRAINT chk_product_definition_type CHECK (product_type IN ('STANDARD', 'CONFIGURABLE', 'PHANTOM', 'KIT')),
  CONSTRAINT chk_product_definition_unit CHECK (length(btrim(base_unit)) > 0),
  CONSTRAINT chk_product_definition_status CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT chk_product_definition_version CHECK (version > 0)
);
CREATE UNIQUE INDEX uq_product_definition_code_ci
  ON product_definitions (tenant_id, factory_id, lower(product_code));

CREATE TABLE product_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  product_id UUID NOT NULL,
  version_number INTEGER NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  effective_from DATE NOT NULL,
  effective_to DATE,
  expected_yield_percent NUMERIC(7,4) NOT NULL DEFAULT 100,
  change_summary TEXT NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  approval_idempotency_key VARCHAR(255),
  approval_request_hash CHAR(64),
  retirement_idempotency_key VARCHAR(255),
  retirement_request_hash CHAR(64),
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  approved_by_user_id UUID,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_product_version_scope UNIQUE (id, tenant_id, factory_id, product_id),
  CONSTRAINT uq_product_version_number UNIQUE (product_id, version_number),
  CONSTRAINT uq_product_version_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_product_version_product
    FOREIGN KEY (product_id, tenant_id, factory_id)
    REFERENCES product_definitions (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_version_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_version_updater
    FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_version_approver
    FOREIGN KEY (approved_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_product_version_number CHECK (version_number > 0),
  CONSTRAINT chk_product_version_state CHECK (state IN ('DRAFT', 'APPROVED', 'RETIRED')),
  CONSTRAINT chk_product_version_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT chk_product_version_yield CHECK (expected_yield_percent > 0 AND expected_yield_percent <= 100),
  CONSTRAINT chk_product_version_summary CHECK (length(btrim(change_summary)) > 0),
  CONSTRAINT chk_product_version_row_version CHECK (row_version > 0),
  CONSTRAINT chk_product_version_idempotency CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_product_version_request_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_product_version_approval_pair CHECK (
    (state = 'DRAFT' AND approved_by_user_id IS NULL AND approved_at IS NULL)
    OR (state IN ('APPROVED', 'RETIRED') AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT chk_product_version_approval_key_pair CHECK (
    (approval_idempotency_key IS NULL AND approval_request_hash IS NULL)
    OR (length(btrim(approval_idempotency_key)) > 0 AND approval_request_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT chk_product_version_retirement_key_pair CHECK (
    (retirement_idempotency_key IS NULL AND retirement_request_hash IS NULL)
    OR (length(btrim(retirement_idempotency_key)) > 0 AND retirement_request_hash ~ '^[0-9a-f]{64}$')
  )
);
CREATE INDEX idx_product_versions_effective_lookup
  ON product_versions (tenant_id, factory_id, product_id, state, effective_from, effective_to);

CREATE TABLE manufacturing_work_centres (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  capacity_units_per_hour NUMERIC(18,4),
  version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_work_centre_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_work_centre_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_work_centre_factory
    FOREIGN KEY (factory_id, tenant_id) REFERENCES factories (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_centre_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_centre_updater
    FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_work_centre_code CHECK (length(btrim(code)) > 0),
  CONSTRAINT chk_work_centre_name CHECK (length(btrim(name)) > 0),
  CONSTRAINT chk_work_centre_status CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT chk_work_centre_capacity CHECK (capacity_units_per_hour IS NULL OR capacity_units_per_hour > 0),
  CONSTRAINT chk_work_centre_version CHECK (version > 0),
  CONSTRAINT chk_work_centre_idempotency CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_work_centre_request_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX uq_work_centre_code_ci
  ON manufacturing_work_centres (tenant_id, factory_id, lower(code));

CREATE TABLE product_bom_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  product_id UUID NOT NULL,
  product_version_id UUID NOT NULL,
  line_number INTEGER NOT NULL,
  component_item_id UUID NOT NULL,
  quantity_per NUMERIC(18,4) NOT NULL,
  unit VARCHAR(50) NOT NULL,
  wastage_percent NUMERIC(7,4) NOT NULL DEFAULT 0,
  alternate_group_code VARCHAR(100),
  notes TEXT,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_product_bom_line_scope UNIQUE (id, product_version_id, tenant_id, factory_id),
  CONSTRAINT uq_product_bom_line_number UNIQUE (product_version_id, line_number),
  CONSTRAINT fk_product_bom_line_version
    FOREIGN KEY (product_version_id, tenant_id, factory_id, product_id)
    REFERENCES product_versions (id, tenant_id, factory_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_bom_line_component
    FOREIGN KEY (component_item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_bom_line_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_product_bom_line_number CHECK (line_number > 0),
  CONSTRAINT chk_product_bom_line_quantity CHECK (quantity_per > 0),
  CONSTRAINT chk_product_bom_line_unit CHECK (length(btrim(unit)) > 0),
  CONSTRAINT chk_product_bom_line_wastage CHECK (wastage_percent >= 0 AND wastage_percent <= 100),
  CONSTRAINT chk_product_bom_line_alternate_group CHECK (
    alternate_group_code IS NULL OR length(btrim(alternate_group_code)) > 0
  )
);
CREATE INDEX idx_product_bom_lines_version
  ON product_bom_lines (tenant_id, factory_id, product_version_id, line_number);

CREATE TABLE product_bom_alternates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  product_id UUID NOT NULL,
  product_version_id UUID NOT NULL,
  bom_line_id UUID NOT NULL,
  alternate_item_id UUID NOT NULL,
  conversion_factor NUMERIC(18,6) NOT NULL DEFAULT 1,
  unit VARCHAR(50) NOT NULL,
  rationale TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  approval_idempotency_key VARCHAR(255),
  approval_request_hash CHAR(64),
  created_by_user_id UUID NOT NULL,
  approved_by_user_id UUID,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_product_bom_alternate_scope UNIQUE (id, product_version_id, tenant_id, factory_id),
  CONSTRAINT uq_product_bom_alternate_item UNIQUE (bom_line_id, alternate_item_id),
  CONSTRAINT uq_product_bom_alternate_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_product_bom_alternate_line
    FOREIGN KEY (bom_line_id, product_version_id, tenant_id, factory_id)
    REFERENCES product_bom_lines (id, product_version_id, tenant_id, factory_id) ON DELETE CASCADE,
  CONSTRAINT fk_product_bom_alternate_version
    FOREIGN KEY (product_version_id, tenant_id, factory_id, product_id)
    REFERENCES product_versions (id, tenant_id, factory_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_bom_alternate_item
    FOREIGN KEY (alternate_item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_bom_alternate_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_bom_alternate_approver
    FOREIGN KEY (approved_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_product_bom_alternate_factor CHECK (conversion_factor > 0),
  CONSTRAINT chk_product_bom_alternate_unit CHECK (length(btrim(unit)) > 0),
  CONSTRAINT chk_product_bom_alternate_rationale CHECK (length(btrim(rationale)) > 0),
  CONSTRAINT chk_product_bom_alternate_status CHECK (status IN ('DRAFT', 'APPROVED', 'RETIRED')),
  CONSTRAINT chk_product_bom_alternate_idempotency CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_product_bom_alternate_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_product_bom_alternate_approval_pair CHECK (
    (status = 'DRAFT' AND approved_by_user_id IS NULL AND approved_at IS NULL)
    OR (status IN ('APPROVED', 'RETIRED') AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT chk_product_bom_alternate_approval_key_pair CHECK (
    (approval_idempotency_key IS NULL AND approval_request_hash IS NULL)
    OR (length(btrim(approval_idempotency_key)) > 0 AND approval_request_hash ~ '^[0-9a-f]{64}$')
  )
);
CREATE INDEX idx_product_bom_alternates_line_status
  ON product_bom_alternates (tenant_id, factory_id, product_version_id, bom_line_id, status);

CREATE TABLE product_routing_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  product_id UUID NOT NULL,
  product_version_id UUID NOT NULL,
  step_number INTEGER NOT NULL,
  operation_code VARCHAR(100) NOT NULL,
  operation_name VARCHAR(255) NOT NULL,
  work_centre_id UUID NOT NULL,
  setup_minutes NUMERIC(12,4) NOT NULL DEFAULT 0,
  run_minutes_per_unit NUMERIC(12,4) NOT NULL DEFAULT 0,
  queue_minutes NUMERIC(12,4) NOT NULL DEFAULT 0,
  transfer_minutes NUMERIC(12,4) NOT NULL DEFAULT 0,
  required_skill VARCHAR(120),
  instructions TEXT,
  is_quality_gate BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_product_routing_step_scope UNIQUE (id, product_version_id, tenant_id, factory_id),
  CONSTRAINT uq_product_routing_step_number UNIQUE (product_version_id, step_number),
  CONSTRAINT fk_product_routing_step_version
    FOREIGN KEY (product_version_id, tenant_id, factory_id, product_id)
    REFERENCES product_versions (id, tenant_id, factory_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_routing_step_work_centre
    FOREIGN KEY (work_centre_id, tenant_id, factory_id)
    REFERENCES manufacturing_work_centres (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_routing_step_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_product_routing_step_number CHECK (step_number > 0),
  CONSTRAINT chk_product_routing_step_code CHECK (length(btrim(operation_code)) > 0),
  CONSTRAINT chk_product_routing_step_name CHECK (length(btrim(operation_name)) > 0),
  CONSTRAINT chk_product_routing_step_times CHECK (
    setup_minutes >= 0 AND run_minutes_per_unit >= 0
    AND queue_minutes >= 0 AND transfer_minutes >= 0
    AND (setup_minutes + run_minutes_per_unit + queue_minutes + transfer_minutes) > 0
  ),
  CONSTRAINT chk_product_routing_step_skill CHECK (required_skill IS NULL OR length(btrim(required_skill)) > 0)
);
CREATE INDEX idx_product_routing_steps_version
  ON product_routing_steps (tenant_id, factory_id, product_version_id, step_number);

CREATE OR REPLACE FUNCTION factoryos_guard_product_definition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_status VARCHAR(20);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product definitions cannot be deleted; disable the definition instead'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'product definitions must start at version one'
        USING ERRCODE = '23514';
    END IF;
    SELECT status INTO v_item_status
    FROM inventory_items
    WHERE id = NEW.inventory_item_id
      AND tenant_id = NEW.tenant_id
      AND factory_id = NEW.factory_id;
    IF NOT FOUND OR v_item_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'product definition requires an active finished-good inventory item in the same factory'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.inventory_item_id,
         NEW.product_code, NEW.product_name, NEW.product_type, NEW.base_unit,
         NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.inventory_item_id,
         OLD.product_code, OLD.product_name, OLD.product_type, OLD.base_unit,
         OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'product identity and creation provenance are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'product definition updates must increment version and updated_at'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_product_definition_guard
BEFORE INSERT OR UPDATE OR DELETE ON product_definitions
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_product_definition();

CREATE OR REPLACE FUNCTION factoryos_guard_manufacturing_work_centre()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'work centres cannot be deleted; disable the work centre instead'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'work centres must start at version one'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.code, NEW.name,
         NEW.idempotency_key, NEW.request_hash, NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.code, OLD.name,
         OLD.idempotency_key, OLD.request_hash, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'work centre identity and creation provenance are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'work centre updates must increment version and updated_at'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_manufacturing_work_centre_guard
BEFORE INSERT OR UPDATE OR DELETE ON manufacturing_work_centres
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_manufacturing_work_centre();

CREATE OR REPLACE FUNCTION factoryos_guard_product_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_bom_count INTEGER;
  v_route_count INTEGER;
  v_pending_alternates INTEGER;
  v_overlap_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product versions are retained for engineering and production traceability'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.row_version <> 1 OR NEW.state <> 'DRAFT'
       OR NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'product versions must start as unapproved draft version one'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM product_definitions p
      WHERE p.id = NEW.product_id AND p.tenant_id = NEW.tenant_id
        AND p.factory_id = NEW.factory_id AND p.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'product version requires an active product in the same factory'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.product_id,
         NEW.version_number, NEW.effective_from, NEW.effective_to,
         NEW.expected_yield_percent, NEW.change_summary,
         NEW.idempotency_key, NEW.request_hash, NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.product_id,
         OLD.version_number, OLD.effective_from, OLD.effective_to,
         OLD.expected_yield_percent, OLD.change_summary,
         OLD.idempotency_key, OLD.request_hash, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'product version engineering inputs are immutable; create a new draft version'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'product version updates must increment row_version and updated_at'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.state = 'DRAFT' AND NEW.state = 'DRAFT' THEN
    IF NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL
       OR NEW.approval_idempotency_key IS DISTINCT FROM OLD.approval_idempotency_key
       OR NEW.approval_request_hash IS DISTINCT FROM OLD.approval_request_hash
       OR NEW.retirement_idempotency_key IS DISTINCT FROM OLD.retirement_idempotency_key
       OR NEW.retirement_request_hash IS DISTINCT FROM OLD.retirement_request_hash THEN
      RAISE EXCEPTION 'draft version cannot set approval or retirement metadata'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'DRAFT' AND NEW.state = 'APPROVED' THEN
    IF NEW.approved_by_user_id IS NULL OR NEW.approved_at IS NULL
       OR NEW.approval_idempotency_key IS NULL OR NEW.approval_request_hash IS NULL THEN
      RAISE EXCEPTION 'approving a product version requires actor, time and idempotency evidence'
        USING ERRCODE = '23514';
    END IF;

    -- Lock the product to serialize effective-date overlap checks.
    PERFORM 1 FROM product_definitions p
    WHERE p.id = NEW.product_id AND p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
    FOR UPDATE;

    SELECT count(*) INTO v_bom_count
    FROM product_bom_lines b
    WHERE b.product_version_id = NEW.id AND b.tenant_id = NEW.tenant_id AND b.factory_id = NEW.factory_id;
    SELECT count(*) INTO v_route_count
    FROM product_routing_steps r
    WHERE r.product_version_id = NEW.id AND r.tenant_id = NEW.tenant_id AND r.factory_id = NEW.factory_id;
    SELECT count(*) INTO v_pending_alternates
    FROM product_bom_alternates a
    WHERE a.product_version_id = NEW.id AND a.tenant_id = NEW.tenant_id
      AND a.factory_id = NEW.factory_id AND a.status = 'DRAFT';

    IF v_bom_count < 1 THEN
      RAISE EXCEPTION 'a product version requires at least one BOM component before approval'
        USING ERRCODE = '23514';
    END IF;
    IF v_route_count < 1 THEN
      RAISE EXCEPTION 'a product version requires at least one routing step before approval'
        USING ERRCODE = '23514';
    END IF;
    IF v_pending_alternates > 0 THEN
      RAISE EXCEPTION 'all alternate material contracts must be approved or retired before version approval'
        USING ERRCODE = '23514';
    END IF;

    SELECT count(*) INTO v_overlap_count
    FROM product_versions v
    WHERE v.product_id = NEW.product_id
      AND v.tenant_id = NEW.tenant_id
      AND v.factory_id = NEW.factory_id
      AND v.id <> NEW.id
      AND v.state = 'APPROVED'
      AND v.effective_from <= COALESCE(NEW.effective_to, 'infinity'::date)
      AND COALESCE(v.effective_to, 'infinity'::date) >= NEW.effective_from;
    IF v_overlap_count > 0 THEN
      RAISE EXCEPTION 'approved product version effective dates cannot overlap'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'APPROVED' AND NEW.state = 'RETIRED' THEN
    IF NEW.retirement_idempotency_key IS NULL OR NEW.retirement_request_hash IS NULL
       OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.approval_idempotency_key IS DISTINCT FROM OLD.approval_idempotency_key
       OR NEW.approval_request_hash IS DISTINCT FROM OLD.approval_request_hash THEN
      RAISE EXCEPTION 'retiring a product version requires separate idempotency evidence and preserves approval provenance'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid product version state transition'
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_product_version_guard
BEFORE INSERT OR UPDATE OR DELETE ON product_versions
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_product_version();

CREATE OR REPLACE FUNCTION factoryos_guard_product_bom_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_state VARCHAR(16);
  v_item_status VARCHAR(20);
BEGIN
  IF TG_OP = 'UPDATE'
     AND ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.product_id, NEW.product_version_id, NEW.created_by_user_id, NEW.created_at)
       IS DISTINCT FROM
         ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.product_id, OLD.product_version_id, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'BOM line scope and creation provenance are immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT state INTO v_state
  FROM product_versions
  WHERE id = COALESCE(NEW.product_version_id, OLD.product_version_id)
    AND tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
    AND factory_id = COALESCE(NEW.factory_id, OLD.factory_id)
  FOR UPDATE;
  IF NOT FOUND OR v_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'BOM components may only change while their product version is draft'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT status INTO v_item_status
  FROM inventory_items
  WHERE id = NEW.component_item_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
  IF NOT FOUND OR v_item_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'BOM component must be active inventory in the same factory'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_product_bom_line_guard
BEFORE INSERT OR UPDATE OR DELETE ON product_bom_lines
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_product_bom_line();

CREATE OR REPLACE FUNCTION factoryos_guard_product_bom_alternate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_state VARCHAR(16);
  v_component_item_id UUID;
  v_item_status VARCHAR(20);
BEGIN
  IF TG_OP = 'UPDATE'
     AND ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.product_id, NEW.product_version_id,
             NEW.bom_line_id, NEW.alternate_item_id, NEW.conversion_factor, NEW.unit,
             NEW.rationale, NEW.idempotency_key, NEW.request_hash, NEW.created_by_user_id, NEW.created_at)
       IS DISTINCT FROM
         ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.product_id, OLD.product_version_id,
             OLD.bom_line_id, OLD.alternate_item_id, OLD.conversion_factor, OLD.unit,
             OLD.rationale, OLD.idempotency_key, OLD.request_hash, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'alternate material contract inputs are immutable; create a replacement contract'
      USING ERRCODE = '55000';
  END IF;

  SELECT state INTO v_state
  FROM product_versions
  WHERE id = COALESCE(NEW.product_version_id, OLD.product_version_id)
    AND tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
    AND factory_id = COALESCE(NEW.factory_id, OLD.factory_id)
  FOR UPDATE;
  IF NOT FOUND OR v_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'alternate material contracts may only change before product version approval'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT component_item_id INTO v_component_item_id
  FROM product_bom_lines
  WHERE id = NEW.bom_line_id AND product_version_id = NEW.product_version_id
    AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'alternate material must reference a BOM line in the same product version'
      USING ERRCODE = '23503';
  END IF;
  IF v_component_item_id = NEW.alternate_item_id THEN
    RAISE EXCEPTION 'alternate material must differ from the primary BOM component'
      USING ERRCODE = '23514';
  END IF;
  SELECT status INTO v_item_status
  FROM inventory_items
  WHERE id = NEW.alternate_item_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
  IF NOT FOUND OR v_item_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'alternate material must be active inventory in the same factory'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'alternate material contracts must start as unapproved drafts'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'RETIRED') THEN
    IF NEW.approved_by_user_id IS NULL OR NEW.approved_at IS NULL THEN
      RAISE EXCEPTION 'alternate material transition requires actor and timestamp'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'APPROVED'
       AND (NEW.approval_idempotency_key IS NULL OR NEW.approval_request_hash IS NULL) THEN
      RAISE EXCEPTION 'alternate approval requires idempotency evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid alternate material state transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_product_bom_alternate_guard
BEFORE INSERT OR UPDATE OR DELETE ON product_bom_alternates
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_product_bom_alternate();

CREATE OR REPLACE FUNCTION factoryos_guard_product_routing_step()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_state VARCHAR(16);
  v_work_centre_status VARCHAR(16);
BEGIN
  IF TG_OP = 'UPDATE'
     AND ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.product_id, NEW.product_version_id, NEW.created_by_user_id, NEW.created_at)
       IS DISTINCT FROM
         ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.product_id, OLD.product_version_id, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'routing step scope and creation provenance are immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT state INTO v_state
  FROM product_versions
  WHERE id = COALESCE(NEW.product_version_id, OLD.product_version_id)
    AND tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
    AND factory_id = COALESCE(NEW.factory_id, OLD.factory_id)
  FOR UPDATE;
  IF NOT FOUND OR v_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'routing steps may only change while their product version is draft'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT status INTO v_work_centre_status
  FROM manufacturing_work_centres
  WHERE id = NEW.work_centre_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
  IF NOT FOUND OR v_work_centre_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'routing step requires an active work centre in the same factory'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_product_routing_step_guard
BEFORE INSERT OR UPDATE OR DELETE ON product_routing_steps
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_product_routing_step();

ALTER TABLE product_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY product_definitions_tenant_isolation ON product_definitions
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE product_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY product_versions_tenant_isolation ON product_versions
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE manufacturing_work_centres ENABLE ROW LEVEL SECURITY;
ALTER TABLE manufacturing_work_centres FORCE ROW LEVEL SECURITY;
CREATE POLICY manufacturing_work_centres_tenant_isolation ON manufacturing_work_centres
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE product_bom_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_bom_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY product_bom_lines_tenant_isolation ON product_bom_lines
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE product_bom_alternates ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_bom_alternates FORCE ROW LEVEL SECURITY;
CREATE POLICY product_bom_alternates_tenant_isolation ON product_bom_alternates
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE product_routing_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_routing_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY product_routing_steps_tenant_isolation ON product_routing_steps
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE product_definitions IS
  'Factory-scoped finished-good definitions backed by an active inventory item; identity is retained and disabled rather than deleted.';
COMMENT ON TABLE product_versions IS
  'Immutable engineering revisions with effective dates, optimistic row versioning, approval evidence and non-overlapping approved intervals.';
COMMENT ON TABLE product_bom_lines IS
  'Version-specific BOM component quantities and explicit wastage percentages; lines are editable only while the parent version is a draft.';
COMMENT ON TABLE product_bom_alternates IS
  'Explicit component substitution contract with conversion factor, rationale and independent approval evidence.';
COMMENT ON TABLE product_routing_steps IS
  'Ordered manufacturing operations tied to active work centres with deterministic setup, run, queue and transfer time assumptions.';
COMMENT ON COLUMN product_versions.expected_yield_percent IS
  'Expected good output percentage for planning; actual good/scrap output remains recorded by production-report domain events.';
COMMENT ON COLUMN product_bom_lines.wastage_percent IS
  'Planning assumption per component line; required quantity is computed from quantity_per and the approved version wastage rule.';
COMMENT ON COLUMN product_bom_alternates.conversion_factor IS
  'Quantity of the alternate material needed per base component unit, in the declared alternate unit contract.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('082_product_bom_routing_version_contracts', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
