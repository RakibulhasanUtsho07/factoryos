BEGIN;

-- WP02/Core Domain Kernel: explicit, factory-scoped unit masters and reviewed
-- conversion rules. Inventory ledger quantities stay in inventory_items.unit.
INSERT INTO permissions (code, description)
VALUES
  ('uom.read', 'Read unit-of-measure definitions and approved conversions in the authorized factory'),
  ('uom.write', 'Create immutable unit definitions and submit conversion rules for approval in the authorized factory'),
  ('uom.approve', 'Approve, reject or retire unit-of-measure conversion rules in the authorized factory')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('uom.read', 'uom.write')
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'uom.approve'
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE uom_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  unit_code VARCHAR(50) NOT NULL,
  name VARCHAR(160) NOT NULL,
  dimension_code VARCHAR(50) NOT NULL,
  decimal_precision SMALLINT NOT NULL DEFAULT 4,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_uom_unit_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_uom_unit_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_uom_unit_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_uom_unit_actor FOREIGN KEY (created_by_user_id)
    REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_uom_unit_code CHECK (unit_code ~ '^[A-Z0-9][A-Z0-9._-]{0,49}$'),
  CONSTRAINT chk_uom_unit_name CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT chk_uom_unit_dimension CHECK (dimension_code ~ '^[A-Z][A-Z0-9_]{0,49}$'),
  CONSTRAINT chk_uom_unit_precision CHECK (decimal_precision BETWEEN 0 AND 8),
  CONSTRAINT chk_uom_unit_idempotency CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_uom_unit_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX uq_uom_unit_code_ci
  ON uom_units (tenant_id, factory_id, lower(unit_code));
CREATE INDEX idx_uom_unit_dimension
  ON uom_units (tenant_id, factory_id, dimension_code, unit_code);

CREATE TABLE uom_conversion_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  from_unit_id UUID NOT NULL,
  to_unit_id UUID NOT NULL,
  factor_numerator NUMERIC(24,0) NOT NULL,
  factor_denominator NUMERIC(24,0) NOT NULL,
  rounding_mode VARCHAR(16) NOT NULL DEFAULT 'REJECT',
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING_APPROVAL',
  submitted_by_user_id UUID NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  decided_by_user_id UUID,
  decided_at TIMESTAMPTZ,
  decision_reason TEXT,
  retired_by_user_id UUID,
  retired_at TIMESTAMPTZ,
  retirement_reason TEXT,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_uom_conversion_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_uom_conversion_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_uom_conversion_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_uom_conversion_from_unit FOREIGN KEY (from_unit_id, tenant_id, factory_id)
    REFERENCES uom_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_uom_conversion_to_unit FOREIGN KEY (to_unit_id, tenant_id, factory_id)
    REFERENCES uom_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_uom_conversion_submitter FOREIGN KEY (submitted_by_user_id)
    REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_uom_conversion_decider FOREIGN KEY (decided_by_user_id)
    REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_uom_conversion_retire_actor FOREIGN KEY (retired_by_user_id)
    REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_uom_conversion_distinct CHECK (from_unit_id <> to_unit_id),
  CONSTRAINT chk_uom_conversion_numerator CHECK (factor_numerator > 0),
  CONSTRAINT chk_uom_conversion_denominator CHECK (factor_denominator > 0),
  CONSTRAINT chk_uom_conversion_rounding CHECK (rounding_mode IN ('REJECT', 'HALF_UP')),
  CONSTRAINT chk_uom_conversion_status CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETIRED')),
  CONSTRAINT chk_uom_conversion_version CHECK (version > 0),
  CONSTRAINT chk_uom_conversion_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_uom_conversion_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_uom_conversion_decision CHECK (
    (status = 'PENDING_APPROVAL' AND decided_by_user_id IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR
    (status IN ('APPROVED', 'REJECTED') AND decided_by_user_id IS NOT NULL
      AND decided_at IS NOT NULL AND length(btrim(COALESCE(decision_reason, ''))) > 0)
    OR
    (status = 'RETIRED' AND decided_by_user_id IS NOT NULL
      AND decided_at IS NOT NULL AND length(btrim(COALESCE(decision_reason, ''))) > 0
      AND retired_by_user_id IS NOT NULL AND retired_at IS NOT NULL
      AND length(btrim(COALESCE(retirement_reason, ''))) > 0)
  ),
  CONSTRAINT chk_uom_conversion_retirement CHECK (
    (retired_by_user_id IS NULL AND retired_at IS NULL AND retirement_reason IS NULL)
    OR
    (retired_by_user_id IS NOT NULL AND retired_at IS NOT NULL AND length(btrim(COALESCE(retirement_reason, ''))) > 0)
  )
);
-- Prevent duplicate active pairs in either direction (A->B conflicts with B->A).
CREATE UNIQUE INDEX uq_uom_conversion_active_unordered_pair
  ON uom_conversion_rules (
    tenant_id, factory_id,
    LEAST(from_unit_id, to_unit_id),
    GREATEST(from_unit_id, to_unit_id)
  )
  WHERE status IN ('PENDING_APPROVAL', 'APPROVED');
CREATE INDEX idx_uom_conversion_pair_status
  ON uom_conversion_rules (tenant_id, factory_id, from_unit_id, to_unit_id, status);

CREATE TABLE uom_conversion_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  conversion_rule_id UUID NOT NULL,
  event_type VARCHAR(16) NOT NULL,
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  changed_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_uom_conversion_event_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_uom_conversion_event_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_uom_conversion_event_rule FOREIGN KEY (conversion_rule_id, tenant_id, factory_id)
    REFERENCES uom_conversion_rules (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_uom_conversion_event_actor FOREIGN KEY (changed_by_user_id)
    REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_uom_conversion_event_type CHECK (event_type IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'RETIRED')),
  CONSTRAINT chk_uom_conversion_event_status CHECK (
    to_status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETIRED')
    AND (from_status IS NULL OR from_status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETIRED'))
    AND (
      (event_type = 'SUBMITTED' AND from_status IS NULL AND to_status = 'PENDING_APPROVAL')
      OR (event_type = 'APPROVED' AND from_status = 'PENDING_APPROVAL' AND to_status = 'APPROVED')
      OR (event_type = 'REJECTED' AND from_status = 'PENDING_APPROVAL' AND to_status = 'REJECTED')
      OR (event_type = 'RETIRED' AND from_status = 'APPROVED' AND to_status = 'RETIRED')
    )
  ),
  CONSTRAINT chk_uom_conversion_event_reason CHECK (length(btrim(reason)) > 0),
  CONSTRAINT chk_uom_conversion_event_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_uom_conversion_event_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_uom_conversion_event_history
  ON uom_conversion_events (tenant_id, factory_id, conversion_rule_id, created_at, id);

CREATE OR REPLACE FUNCTION factoryos_guard_uom_unit()
RETURNS trigger
LANGUAGE plpgsql
AS $uom_unit_guard$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'unit-of-measure definitions are immutable; create a new unit code for a new definition';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'UoM unit creator must match the authenticated user';
  END IF;
  RETURN NEW;
END;
$uom_unit_guard$;
CREATE TRIGGER trg_uom_unit_immutable
BEFORE INSERT OR UPDATE OR DELETE ON uom_units
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_uom_unit();

CREATE OR REPLACE FUNCTION factoryos_guard_uom_conversion_rule()
RETURNS trigger
LANGUAGE plpgsql
AS $uom_conversion_guard$
DECLARE
  v_from_dimension VARCHAR(50);
  v_to_dimension VARCHAR(50);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.submitted_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.status <> 'PENDING_APPROVAL'
       OR NEW.version <> 1
       OR NEW.decided_by_user_id IS NOT NULL
       OR NEW.decided_at IS NOT NULL
       OR NEW.decision_reason IS NOT NULL
       OR NEW.retired_by_user_id IS NOT NULL
       OR NEW.retired_at IS NOT NULL
       OR NEW.retirement_reason IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'conversion rules must begin pending approval under the authenticated submitter';
    END IF;
    SELECT dimension_code INTO v_from_dimension
    FROM uom_units
    WHERE id = NEW.from_unit_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    FOR SHARE;
    SELECT dimension_code INTO v_to_dimension
    FROM uom_units
    WHERE id = NEW.to_unit_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    FOR SHARE;
    IF v_from_dimension IS NULL OR v_to_dimension IS NULL OR v_from_dimension <> v_to_dimension THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'UoM conversions require units of the same dimension in the same factory';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'conversion-rule history cannot be deleted';
  END IF;

  IF ROW(
    NEW.id, NEW.tenant_id, NEW.factory_id, NEW.from_unit_id, NEW.to_unit_id,
    NEW.factor_numerator, NEW.factor_denominator, NEW.rounding_mode,
    NEW.submitted_by_user_id, NEW.submitted_at, NEW.idempotency_key, NEW.request_hash,
    NEW.correlation_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.factory_id, OLD.from_unit_id, OLD.to_unit_id,
    OLD.factor_numerator, OLD.factor_denominator, OLD.rounding_mode,
    OLD.submitted_by_user_id, OLD.submitted_at, OLD.idempotency_key, OLD.request_hash,
    OLD.correlation_id, OLD.created_at
  ) OR NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'conversion factor and source units are immutable; submit a new rule instead';
  END IF;

  IF OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('APPROVED', 'REJECTED') THEN
    IF NEW.decided_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.decided_by_user_id = OLD.submitted_by_user_id
       OR NEW.decided_at IS NULL
       OR NEW.decided_at < OLD.created_at
       OR length(btrim(COALESCE(NEW.decision_reason, ''))) = 0
       OR NEW.retired_by_user_id IS NOT NULL OR NEW.retired_at IS NOT NULL OR NEW.retirement_reason IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'conversion decision requires a different authorized actor and a reason';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'APPROVED' AND NEW.status = 'RETIRED' THEN
    IF NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
       OR NEW.retired_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.retired_at IS NULL
       OR NEW.retired_at < OLD.created_at
       OR length(btrim(COALESCE(NEW.retirement_reason, ''))) = 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retiring an approved conversion requires the authenticated actor and a reason';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid conversion-rule lifecycle transition';
END;
$uom_conversion_guard$;
CREATE TRIGGER trg_uom_conversion_rule_guard
BEFORE INSERT OR UPDATE OR DELETE ON uom_conversion_rules
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_uom_conversion_rule();

CREATE OR REPLACE FUNCTION factoryos_guard_uom_conversion_event()
RETURNS trigger
LANGUAGE plpgsql
AS $uom_conversion_event_guard$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'UoM conversion history is append-only';
  END IF;
  IF NEW.changed_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'UoM conversion event actor must match the authenticated user';
  END IF;
  RETURN NEW;
END;
$uom_conversion_event_guard$;
CREATE TRIGGER trg_uom_conversion_event_immutable
BEFORE INSERT OR UPDATE OR DELETE ON uom_conversion_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_uom_conversion_event();

CREATE OR REPLACE FUNCTION factoryos_assert_uom_unit_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $uom_unit_evidence$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
      AND a.resource_type = 'UOM_UNIT' AND a.resource_id = NEW.id AND a.action = 'CREATED'
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id = NEW.tenant_id AND o.factory_id = NEW.factory_id
      AND o.aggregate_type = 'UOM_UNIT' AND o.aggregate_id = NEW.id AND o.event_type = 'UOM.UNIT_CREATED'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'UoM units require transactional audit and outbox evidence';
  END IF;
  RETURN NULL;
END;
$uom_unit_evidence$;
CREATE CONSTRAINT TRIGGER ctr_uom_unit_evidence
AFTER INSERT ON uom_units
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_uom_unit_evidence();

CREATE OR REPLACE FUNCTION factoryos_assert_uom_conversion_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $uom_conversion_evidence$
DECLARE
  v_event_type VARCHAR(16);
  v_action VARCHAR(16);
  v_outbox_type VARCHAR(64);
BEGIN
  IF NEW.status = 'PENDING_APPROVAL' THEN
    v_event_type := 'SUBMITTED'; v_action := 'SUBMITTED'; v_outbox_type := 'UOM.CONVERSION_SUBMITTED';
  ELSIF NEW.status = 'APPROVED' THEN
    v_event_type := 'APPROVED'; v_action := 'APPROVED'; v_outbox_type := 'UOM.CONVERSION_APPROVED';
  ELSIF NEW.status = 'REJECTED' THEN
    v_event_type := 'REJECTED'; v_action := 'REJECTED'; v_outbox_type := 'UOM.CONVERSION_REJECTED';
  ELSE
    v_event_type := 'RETIRED'; v_action := 'RETIRED'; v_outbox_type := 'UOM.CONVERSION_RETIRED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM uom_conversion_events e
    WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
      AND e.conversion_rule_id = NEW.id AND e.to_status = NEW.status AND e.event_type = v_event_type
      AND e.changed_by_user_id = CASE
        WHEN NEW.status = 'PENDING_APPROVAL' THEN NEW.submitted_by_user_id
        WHEN NEW.status IN ('APPROVED', 'REJECTED') THEN NEW.decided_by_user_id
        ELSE NEW.retired_by_user_id
      END
  ) OR NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
      AND a.resource_type = 'UOM_CONVERSION' AND a.resource_id = NEW.id AND a.action = v_action
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id = NEW.tenant_id AND o.factory_id = NEW.factory_id
      AND o.aggregate_type = 'UOM_CONVERSION' AND o.aggregate_id = NEW.id AND o.event_type = v_outbox_type
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'UoM conversion lifecycle changes require event history, audit and outbox evidence';
  END IF;
  RETURN NULL;
END;
$uom_conversion_evidence$;
CREATE CONSTRAINT TRIGGER ctr_uom_conversion_evidence
AFTER INSERT OR UPDATE ON uom_conversion_rules
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_uom_conversion_evidence();

CREATE OR REPLACE FUNCTION factoryos_assert_uom_conversion_event_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $uom_conversion_event_evidence$
DECLARE
  v_outbox_type VARCHAR(64);
  v_action VARCHAR(16);
BEGIN
  v_outbox_type := CASE NEW.event_type
    WHEN 'SUBMITTED' THEN 'UOM.CONVERSION_SUBMITTED'
    WHEN 'APPROVED' THEN 'UOM.CONVERSION_APPROVED'
    WHEN 'REJECTED' THEN 'UOM.CONVERSION_REJECTED'
    ELSE 'UOM.CONVERSION_RETIRED'
  END;
  v_action := CASE NEW.event_type
    WHEN 'SUBMITTED' THEN 'SUBMITTED'
    WHEN 'APPROVED' THEN 'APPROVED'
    WHEN 'REJECTED' THEN 'REJECTED'
    ELSE 'RETIRED'
  END;
  IF NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
      AND a.resource_type = 'UOM_CONVERSION' AND a.resource_id = NEW.conversion_rule_id AND a.action = v_action
      AND a.correlation_id = NEW.correlation_id
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id = NEW.tenant_id AND o.factory_id = NEW.factory_id
      AND o.aggregate_type = 'UOM_CONVERSION' AND o.aggregate_id = NEW.conversion_rule_id
      AND o.event_type = v_outbox_type AND o.correlation_id = NEW.correlation_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'UoM conversion history rows require matching audit and outbox evidence';
  END IF;
  RETURN NULL;
END;
$uom_conversion_event_evidence$;
CREATE CONSTRAINT TRIGGER ctr_uom_conversion_event_evidence
AFTER INSERT ON uom_conversion_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_uom_conversion_event_evidence();

ALTER TABLE inventory_movements
  ADD COLUMN input_quantity NUMERIC(18,8),
  ADD COLUMN input_unit_code VARCHAR(50),
  ADD COLUMN conversion_rule_id UUID,
  ADD COLUMN conversion_factor_numerator NUMERIC(24,0),
  ADD COLUMN conversion_factor_denominator NUMERIC(24,0),
  ADD COLUMN conversion_rounding_mode VARCHAR(16);

UPDATE inventory_movements m
SET input_quantity = m.quantity,
    input_unit_code = i.unit
FROM inventory_items i
WHERE i.id = m.item_id AND i.tenant_id = m.tenant_id AND i.factory_id = m.factory_id;

ALTER TABLE inventory_movements
  ALTER COLUMN input_quantity SET NOT NULL,
  ALTER COLUMN input_unit_code SET NOT NULL;

ALTER TABLE inventory_movements
  ADD CONSTRAINT fk_inventory_movement_conversion_rule
    FOREIGN KEY (conversion_rule_id, tenant_id, factory_id)
    REFERENCES uom_conversion_rules (id, tenant_id, factory_id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_inventory_movement_input_quantity CHECK (input_quantity > 0),
  ADD CONSTRAINT chk_inventory_movement_input_unit CHECK (length(btrim(input_unit_code)) BETWEEN 1 AND 50),
  ADD CONSTRAINT chk_inventory_movement_conversion_snapshot CHECK (
    (conversion_rule_id IS NULL AND conversion_factor_numerator IS NULL
      AND conversion_factor_denominator IS NULL AND conversion_rounding_mode IS NULL)
    OR
    (conversion_rule_id IS NOT NULL AND conversion_factor_numerator > 0
      AND conversion_factor_denominator > 0 AND conversion_rounding_mode IN ('REJECT', 'HALF_UP'))
  );
CREATE INDEX idx_inventory_movements_conversion_rule
  ON inventory_movements (tenant_id, factory_id, conversion_rule_id)
  WHERE conversion_rule_id IS NOT NULL;

ALTER TABLE uom_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE uom_units FORCE ROW LEVEL SECURITY;
CREATE POLICY uom_units_tenant_isolation ON uom_units
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE uom_conversion_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE uom_conversion_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY uom_conversion_rules_tenant_isolation ON uom_conversion_rules
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE uom_conversion_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE uom_conversion_events FORCE ROW LEVEL SECURITY;
CREATE POLICY uom_conversion_events_tenant_isolation ON uom_conversion_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version)
VALUES ('075_uom_conversion_controls')
ON CONFLICT (version) DO NOTHING;

COMMENT ON TABLE uom_units IS
  'Immutable factory-scoped UoM codes, dimension classes and input quantity precision.';
COMMENT ON TABLE uom_conversion_rules IS
  'Reviewed exact rational conversions. Only APPROVED rules can convert values; opposite direction uses the exact inverse.';
COMMENT ON TABLE uom_conversion_events IS
  'Append-only submission, approval, rejection and retirement evidence for conversion rules.';
COMMENT ON COLUMN inventory_movements.input_quantity IS
  'Original operator/integration input quantity before conversion to the inventory item base unit.';
COMMENT ON COLUMN inventory_movements.conversion_rule_id IS
  'Approved conversion rule used for this stock movement; factors/mode are snapshotted beside it.';
COMMIT;
