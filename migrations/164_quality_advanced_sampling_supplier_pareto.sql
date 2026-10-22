BEGIN;

INSERT INTO permissions (code, description)
VALUES
  ('quality.advanced.read', 'Read AQL sampling, fabric roll scoring, supplier quality and defect Pareto evidence'),
  ('quality.advanced.manage', 'Manage versioned AQL and fabric-roll scoring profiles and submit sampling evidence')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('quality.advanced.read', 'quality.advanced.manage')
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS quality_aql_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  profile_code VARCHAR(100) NOT NULL,
  revision INTEGER NOT NULL,
  inspection_type VARCHAR(24) NOT NULL,
  aql_percent NUMERIC(6,3) NOT NULL,
  inspection_level VARCHAR(8) NOT NULL,
  lot_size_min INTEGER NOT NULL,
  lot_size_max INTEGER NOT NULL,
  sample_size INTEGER NOT NULL,
  accept_number INTEGER NOT NULL,
  reject_number INTEGER NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  row_version BIGINT NOT NULL DEFAULT 1,
  notes TEXT,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quality_aql_profile_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_aql_profile_revision UNIQUE (tenant_id, factory_id, profile_code, revision),
  CONSTRAINT uq_quality_aql_profile_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_aql_profile_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_aql_profile_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_aql_profile_type CHECK (inspection_type IN ('INCOMING','IN_PROCESS','FINAL','INVENTORY','SUPPLIER')),
  CONSTRAINT chk_quality_aql_profile_percent CHECK (aql_percent > 0 AND aql_percent <= 100),
  CONSTRAINT chk_quality_aql_profile_level CHECK (inspection_level IN ('S-1','S-2','S-3','S-4','I','II','III')),
  CONSTRAINT chk_quality_aql_profile_lot_range CHECK (lot_size_min > 0 AND lot_size_max >= lot_size_min),
  CONSTRAINT chk_quality_aql_profile_sample CHECK (sample_size > 0 AND sample_size <= lot_size_min),
  CONSTRAINT chk_quality_aql_profile_accept_reject CHECK (accept_number >= 0 AND reject_number > accept_number AND reject_number <= sample_size),
  CONSTRAINT chk_quality_aql_profile_status CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  CONSTRAINT chk_quality_aql_profile_version CHECK (row_version > 0),
  CONSTRAINT chk_quality_aql_profile_key CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_quality_aql_profile_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS quality_fabric_scoring_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  profile_code VARCHAR(100) NOT NULL,
  revision INTEGER NOT NULL,
  inspection_type VARCHAR(24) NOT NULL,
  max_points_per_100_square_yards NUMERIC(12,4) NOT NULL,
  minimum_roll_count INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  row_version BIGINT NOT NULL DEFAULT 1,
  notes TEXT,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quality_fabric_profile_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_fabric_profile_revision UNIQUE (tenant_id, factory_id, profile_code, revision),
  CONSTRAINT uq_quality_fabric_profile_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_fabric_profile_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_fabric_profile_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_fabric_profile_type CHECK (inspection_type IN ('INCOMING','IN_PROCESS','FINAL','INVENTORY','SUPPLIER')),
  CONSTRAINT chk_quality_fabric_profile_limit CHECK (max_points_per_100_square_yards > 0),
  CONSTRAINT chk_quality_fabric_profile_roll_count CHECK (minimum_roll_count BETWEEN 1 AND 10000),
  CONSTRAINT chk_quality_fabric_profile_status CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  CONSTRAINT chk_quality_fabric_profile_version CHECK (row_version > 0),
  CONSTRAINT chk_quality_fabric_profile_key CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_quality_fabric_profile_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE quality_inspections
  ADD COLUMN IF NOT EXISTS aql_profile_id UUID,
  ADD COLUMN IF NOT EXISTS fabric_scoring_profile_id UUID;

DO $quality_sampling_fks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='quality_inspections'::regclass AND conname='fk_quality_inspection_aql_profile') THEN
    ALTER TABLE quality_inspections ADD CONSTRAINT fk_quality_inspection_aql_profile
      FOREIGN KEY (aql_profile_id, tenant_id, factory_id)
      REFERENCES quality_aql_profiles(id, tenant_id, factory_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='quality_inspections'::regclass AND conname='fk_quality_inspection_fabric_profile') THEN
    ALTER TABLE quality_inspections ADD CONSTRAINT fk_quality_inspection_fabric_profile
      FOREIGN KEY (fabric_scoring_profile_id, tenant_id, factory_id)
      REFERENCES quality_fabric_scoring_profiles(id, tenant_id, factory_id) ON DELETE RESTRICT;
  END IF;
END;
$quality_sampling_fks$;

CREATE TABLE IF NOT EXISTS quality_sampling_profile_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  inspection_id UUID NOT NULL,
  aql_profile_id UUID,
  fabric_scoring_profile_id UUID,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quality_sampling_binding_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_sampling_binding_inspection UNIQUE (tenant_id, factory_id, inspection_id),
  CONSTRAINT uq_quality_sampling_binding_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_sampling_binding_inspection FOREIGN KEY (inspection_id, tenant_id, factory_id)
    REFERENCES quality_inspections(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_sampling_binding_aql FOREIGN KEY (aql_profile_id, tenant_id, factory_id)
    REFERENCES quality_aql_profiles(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_sampling_binding_fabric FOREIGN KEY (fabric_scoring_profile_id, tenant_id, factory_id)
    REFERENCES quality_fabric_scoring_profiles(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_sampling_binding_actor FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_sampling_binding_nonempty CHECK (aql_profile_id IS NOT NULL OR fabric_scoring_profile_id IS NOT NULL),
  CONSTRAINT chk_quality_sampling_binding_key CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_quality_sampling_binding_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS quality_aql_sample_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  inspection_id UUID NOT NULL,
  profile_id UUID NOT NULL,
  profile_revision INTEGER NOT NULL,
  aql_percent_snapshot NUMERIC(6,3) NOT NULL,
  inspection_level_snapshot VARCHAR(8) NOT NULL,
  lot_size INTEGER NOT NULL,
  sample_size INTEGER NOT NULL,
  accept_number INTEGER NOT NULL,
  reject_number INTEGER NOT NULL,
  observed_nonconforming INTEGER NOT NULL,
  decision VARCHAR(12) NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quality_aql_run_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_aql_run_per_inspection UNIQUE (tenant_id, factory_id, inspection_id),
  CONSTRAINT uq_quality_aql_run_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_aql_run_inspection FOREIGN KEY (inspection_id, tenant_id, factory_id)
    REFERENCES quality_inspections(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_aql_run_profile FOREIGN KEY (profile_id, tenant_id, factory_id)
    REFERENCES quality_aql_profiles(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_aql_run_actor FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_aql_run_snapshot CHECK (
    lot_size > 0 AND sample_size > 0 AND sample_size <= lot_size
    AND accept_number >= 0 AND reject_number > accept_number
    AND reject_number <= sample_size
    AND observed_nonconforming BETWEEN 0 AND sample_size
  ),
  CONSTRAINT chk_quality_aql_run_decision CHECK (decision IN ('ACCEPT','REJECT','HOLD')),
  CONSTRAINT chk_quality_aql_run_evidence CHECK (jsonb_typeof(evidence)='object' AND evidence <> '{}'::jsonb),
  CONSTRAINT chk_quality_aql_run_key CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_quality_aql_run_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS quality_fabric_roll_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  inspection_id UUID NOT NULL,
  profile_id UUID NOT NULL,
  profile_revision INTEGER NOT NULL,
  roll_code VARCHAR(120) NOT NULL,
  roll_length_yards NUMERIC(18,4) NOT NULL,
  roll_width_inches NUMERIC(12,4) NOT NULL,
  total_defect_points NUMERIC(18,4) NOT NULL,
  points_per_100_square_yards NUMERIC(18,4) NOT NULL,
  max_points_snapshot NUMERIC(12,4) NOT NULL,
  decision VARCHAR(12) NOT NULL,
  defects JSONB NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quality_fabric_roll_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_fabric_roll_code UNIQUE (tenant_id, factory_id, inspection_id, roll_code),
  CONSTRAINT uq_quality_fabric_roll_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_fabric_roll_inspection FOREIGN KEY (inspection_id, tenant_id, factory_id)
    REFERENCES quality_inspections(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_fabric_roll_profile FOREIGN KEY (profile_id, tenant_id, factory_id)
    REFERENCES quality_fabric_scoring_profiles(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_fabric_roll_actor FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_fabric_roll_dimensions CHECK (roll_length_yards > 0 AND roll_width_inches > 0),
  CONSTRAINT chk_quality_fabric_roll_points CHECK (total_defect_points >= 0 AND points_per_100_square_yards >= 0 AND max_points_snapshot > 0),
  CONSTRAINT chk_quality_fabric_roll_decision CHECK (decision IN ('PASS','HOLD')),
  CONSTRAINT chk_quality_fabric_roll_defects CHECK (jsonb_typeof(defects)='array'),
  CONSTRAINT chk_quality_fabric_roll_evidence CHECK (jsonb_typeof(evidence)='object' AND evidence <> '{}'::jsonb),
  CONSTRAINT chk_quality_fabric_roll_key CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_quality_fabric_roll_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS quality_defect_context_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  defect_id UUID NOT NULL,
  line_code VARCHAR(100),
  operation_code VARCHAR(100),
  style_code VARCHAR(120),
  shift_code VARCHAR(80),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quality_defect_context_scope UNIQUE (defect_id, tenant_id, factory_id),
  CONSTRAINT uq_quality_defect_context_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_defect_context_defect FOREIGN KEY (defect_id, tenant_id, factory_id)
    REFERENCES quality_defects(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_defect_context_actor FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_defect_context_evidence CHECK (jsonb_typeof(evidence)='object'),
  CONSTRAINT chk_quality_defect_context_nonempty CHECK (
    (line_code IS NULL OR length(btrim(line_code)) BETWEEN 1 AND 100)
    AND (operation_code IS NULL OR length(btrim(operation_code)) BETWEEN 1 AND 100)
    AND (style_code IS NULL OR length(btrim(style_code)) BETWEEN 1 AND 120)
    AND (shift_code IS NULL OR length(btrim(shift_code)) BETWEEN 1 AND 80)
    AND (line_code IS NOT NULL OR operation_code IS NOT NULL OR style_code IS NOT NULL OR shift_code IS NOT NULL)
  ),
  CONSTRAINT chk_quality_defect_context_key CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_quality_defect_context_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS quality_supplier_quality_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  supplier_id UUID NOT NULL,
  source_link_id UUID NOT NULL,
  inspection_id UUID NOT NULL,
  defect_id UUID NOT NULL,
  goods_receipt_id UUID,
  goods_receipt_line_id UUID NOT NULL,
  event_type VARCHAR(24) NOT NULL DEFAULT 'DEFECT_REPORTED',
  defect_code VARCHAR(100) NOT NULL,
  severity VARCHAR(12) NOT NULL,
  affected_quantity NUMERIC(18,4) NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quality_supplier_event_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_supplier_event_source UNIQUE (tenant_id, factory_id, source_link_id, event_type),
  CONSTRAINT fk_quality_supplier_event_link FOREIGN KEY (source_link_id, tenant_id, factory_id)
    REFERENCES quality_defect_links(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_supplier_event_inspection FOREIGN KEY (inspection_id, tenant_id, factory_id)
    REFERENCES quality_inspections(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_supplier_event_defect FOREIGN KEY (defect_id, tenant_id, factory_id)
    REFERENCES quality_defects(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_supplier_event_grn_line FOREIGN KEY (goods_receipt_line_id, tenant_id, factory_id, goods_receipt_id)
    REFERENCES goods_receipt_lines(id, tenant_id, factory_id, goods_receipt_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_supplier_event_actor FOREIGN KEY (recorded_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_supplier_event_type CHECK (event_type IN ('DEFECT_REPORTED')),
  CONSTRAINT chk_quality_supplier_event_severity CHECK (severity IN ('CRITICAL','MAJOR','MINOR')),
  CONSTRAINT chk_quality_supplier_event_quantity CHECK (affected_quantity > 0),
  CONSTRAINT chk_quality_supplier_event_evidence CHECK (jsonb_typeof(evidence)='object')
);

CREATE INDEX IF NOT EXISTS idx_quality_aql_profile_selection
  ON quality_aql_profiles (tenant_id, factory_id, profile_code, inspection_type, status, revision DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_quality_aql_profile_active
  ON quality_aql_profiles (tenant_id, factory_id, lower(profile_code), inspection_type) WHERE status='ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS uq_quality_aql_profile_code_revision_ci
  ON quality_aql_profiles (tenant_id, factory_id, lower(profile_code), revision);
CREATE INDEX IF NOT EXISTS idx_quality_fabric_profile_selection
  ON quality_fabric_scoring_profiles (tenant_id, factory_id, profile_code, inspection_type, status, revision DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_quality_fabric_profile_active
  ON quality_fabric_scoring_profiles (tenant_id, factory_id, lower(profile_code), inspection_type) WHERE status='ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS uq_quality_fabric_profile_code_revision_ci
  ON quality_fabric_scoring_profiles (tenant_id, factory_id, lower(profile_code), revision);
CREATE INDEX IF NOT EXISTS idx_quality_supplier_event_supplier_time
  ON quality_supplier_quality_events (tenant_id, factory_id, supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quality_defect_context_dimensions
  ON quality_defect_context_snapshots (tenant_id, factory_id, style_code, shift_code, line_code, operation_code);

CREATE OR REPLACE FUNCTION factoryos_evaluate_aql_sample(
  p_observed_nonconforming INTEGER,
  p_accept_number INTEGER,
  p_reject_number INTEGER
) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_accept_number < 0 OR p_reject_number <= p_accept_number
      OR p_observed_nonconforming < 0 THEN 'HOLD'
    WHEN p_observed_nonconforming <= p_accept_number THEN 'ACCEPT'
    WHEN p_observed_nonconforming >= p_reject_number THEN 'REJECT'
    ELSE 'HOLD'
  END
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_quality_advanced_profile()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_active_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'advanced quality profiles are retained as revision evidence' USING ERRCODE='55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
      OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'advanced quality profile actor must match authenticated user' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - ARRAY['status','row_version','updated_by_user_id','updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','row_version','updated_by_user_id','updated_at']) THEN
    RAISE EXCEPTION 'advanced quality profile content is immutable; create a new revision' USING ERRCODE='55000';
  END IF;

  IF NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.row_version <> OLD.row_version + 1
     OR NOT ((OLD.status='DRAFT' AND NEW.status IN ('ACTIVE','RETIRED'))
          OR (OLD.status='ACTIVE' AND NEW.status='RETIRED')) THEN
    RAISE EXCEPTION 'invalid advanced quality profile lifecycle transition' USING ERRCODE='23514';
  END IF;

  IF NEW.status='ACTIVE' THEN
    IF TG_TABLE_NAME='quality_aql_profiles' THEN
      SELECT count(*) INTO v_active_count FROM quality_aql_profiles
      WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
        AND lower(profile_code)=lower(NEW.profile_code) AND inspection_type=NEW.inspection_type
        AND status='ACTIVE' AND id<>NEW.id;
    ELSE
      SELECT count(*) INTO v_active_count FROM quality_fabric_scoring_profiles
      WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
        AND lower(profile_code)=lower(NEW.profile_code) AND inspection_type=NEW.inspection_type
        AND status='ACTIVE' AND id<>NEW.id;
    END IF;
    IF v_active_count > 0 THEN
      RAISE EXCEPTION 'another active revision already exists for this profile code and inspection type' USING ERRCODE='23505';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_quality_aql_profile_lifecycle ON quality_aql_profiles;
CREATE TRIGGER trg_quality_aql_profile_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON quality_aql_profiles
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_advanced_profile();
DROP TRIGGER IF EXISTS trg_quality_fabric_profile_lifecycle ON quality_fabric_scoring_profiles;
CREATE TRIGGER trg_quality_fabric_profile_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON quality_fabric_scoring_profiles
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_advanced_profile();

-- Profile binding is the only permitted versioned OPEN -> OPEN update. The original target
-- guard rejected same-state metadata changes, preventing the binding endpoint from reaching
-- the binding-specific actor/type/one-time checks below.
CREATE OR REPLACE FUNCTION factoryos_guard_quality_inspection_target()
RETURNS trigger
LANGUAGE plpgsql
AS $
DECLARE
  v_item UUID;
  v_unit UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.inspection_type, NEW.target_type, NEW.target_id,
      NEW.inventory_item_id, NEW.traceability_unit_id, NEW.plan_code, NEW.sample_quantity, NEW.notes,
      NEW.idempotency_key, NEW.request_hash, NEW.created_by_user_id, NEW.correlation_id, NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.inspection_type, OLD.target_type, OLD.target_id,
      OLD.inventory_item_id, OLD.traceability_unit_id, OLD.plan_code, OLD.sample_quantity, OLD.notes,
      OLD.idempotency_key, OLD.request_hash, OLD.created_by_user_id, OLD.correlation_id, OLD.created_at)
      OR NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at <= OLD.updated_at
      OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'quality inspection identity is immutable; lifecycle changes require optimistic version increments'
        USING ERRCODE = '55000';
    END IF;
    IF NOT (
      (OLD.status IN ('OPEN', 'ON_HOLD') AND NEW.status = 'IN_PROGRESS')
      OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('PASSED', 'FAILED', 'ON_HOLD', 'CANCELLED'))
      OR (OLD.status IN ('FAILED', 'ON_HOLD', 'PASSED') AND NEW.status IN ('DISPOSITIONED', 'ON_HOLD'))
      OR (OLD.status = 'OPEN' AND NEW.status = 'OPEN'
        AND OLD.aql_profile_id IS NULL AND OLD.fabric_scoring_profile_id IS NULL
        AND (NEW.aql_profile_id IS NOT NULL OR NEW.fabric_scoring_profile_id IS NOT NULL))
    ) THEN
      RAISE EXCEPTION 'invalid quality inspection transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.status <> 'OPEN' OR NEW.row_version <> 1 THEN
    RAISE EXCEPTION 'quality inspection must start OPEN under the authenticated actor'
      USING ERRCODE = '23514';
  END IF;

  CASE NEW.target_type
    WHEN 'INVENTORY_ITEM' THEN
      SELECT i.id INTO v_item FROM inventory_items i
      WHERE i.id = NEW.target_id AND i.tenant_id = NEW.tenant_id AND i.factory_id = NEW.factory_id
      FOR SHARE;
    WHEN 'TRACEABILITY_UNIT' THEN
      SELECT u.id, u.inventory_item_id INTO v_unit, v_item FROM traceability_units u
      WHERE u.id = NEW.target_id AND u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id
      FOR SHARE;
    WHEN 'GOODS_RECEIPT_LINE' THEN
      SELECT l.inventory_item_id INTO v_item
      FROM goods_receipt_lines l JOIN goods_receipts g
        ON g.id = l.goods_receipt_id AND g.tenant_id = l.tenant_id AND g.factory_id = l.factory_id
      WHERE l.id = NEW.target_id AND l.tenant_id = NEW.tenant_id AND l.factory_id = NEW.factory_id
        AND g.status = 'POSTED'
      FOR SHARE OF l, g;
    WHEN 'PRODUCTION_REPORT' THEN
      SELECT COALESCE(wo.finished_item_id, ol.inventory_item_id) INTO v_item
      FROM order_production_reports r
      JOIN order_lines ol ON ol.id = r.order_line_id AND ol.order_id = r.order_id
        AND ol.tenant_id = r.tenant_id AND ol.factory_id = r.factory_id
      LEFT JOIN work_orders wo ON wo.id = r.work_order_id AND wo.tenant_id = r.tenant_id AND wo.factory_id = r.factory_id
      WHERE r.id = NEW.target_id AND r.tenant_id = NEW.tenant_id AND r.factory_id = NEW.factory_id
      FOR SHARE OF r, ol;
    WHEN 'WORK_ORDER' THEN
      PERFORM 1 FROM work_orders wo
      WHERE wo.id = NEW.target_id AND wo.tenant_id = NEW.tenant_id AND wo.factory_id = NEW.factory_id
      FOR SHARE;
    ELSE
      RAISE EXCEPTION 'unsupported quality inspection target type' USING ERRCODE = '23514';
  END CASE;

  IF NEW.target_type = 'TRACEABILITY_UNIT' THEN
    IF v_unit IS NULL THEN RAISE EXCEPTION 'traceability unit is not in this factory' USING ERRCODE = '23503'; END IF;
    IF NEW.traceability_unit_id IS NOT NULL AND NEW.traceability_unit_id IS DISTINCT FROM NEW.target_id THEN
      RAISE EXCEPTION 'quality traceability target binding is invalid' USING ERRCODE = '23514';
    END IF;
    IF NEW.inventory_item_id IS NOT NULL AND NEW.inventory_item_id IS DISTINCT FROM v_item THEN
      RAISE EXCEPTION 'quality traceability inventory mapping is invalid' USING ERRCODE = '23514';
    END IF;
    NEW.traceability_unit_id := NEW.target_id;
    NEW.inventory_item_id := v_item;
  ELSE
    IF NOT FOUND THEN RAISE EXCEPTION 'quality inspection target was not found in this factory' USING ERRCODE = '23503'; END IF;
    IF NEW.traceability_unit_id IS NOT NULL THEN
      RAISE EXCEPTION 'only traceability-unit inspections may link a traceability unit' USING ERRCODE = '23514';
    END IF;
    IF NEW.inventory_item_id IS NOT NULL AND NEW.inventory_item_id IS DISTINCT FROM v_item THEN
      RAISE EXCEPTION 'quality inspection inventory mapping must be resolved by the database' USING ERRCODE = '23514';
    END IF;
    NEW.inventory_item_id := v_item;
  END IF;
  RETURN NEW;
END;
$;

CREATE OR REPLACE FUNCTION factoryos_guard_quality_sampling_profile_binding()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_type TEXT;
BEGIN
  IF NEW.aql_profile_id IS NOT DISTINCT FROM OLD.aql_profile_id
    AND NEW.fabric_scoring_profile_id IS NOT DISTINCT FROM OLD.fabric_scoring_profile_id THEN
    RETURN NEW;
  END IF;
  IF OLD.status<>'OPEN' OR NEW.status<>'OPEN'
    OR OLD.aql_profile_id IS NOT NULL OR OLD.fabric_scoring_profile_id IS NOT NULL THEN
    RAISE EXCEPTION 'sampling profiles can only be bound once while an inspection is OPEN' USING ERRCODE='55000';
  END IF;
  IF NEW.aql_profile_id IS NOT NULL THEN
    SELECT inspection_type INTO v_type FROM quality_aql_profiles
    WHERE id=NEW.aql_profile_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND status='ACTIVE' FOR SHARE;
    IF NOT FOUND OR v_type IS DISTINCT FROM NEW.inspection_type THEN
      RAISE EXCEPTION 'an ACTIVE AQL profile matching the inspection type is required' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.fabric_scoring_profile_id IS NOT NULL THEN
    SELECT inspection_type INTO v_type FROM quality_fabric_scoring_profiles
    WHERE id=NEW.fabric_scoring_profile_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND status='ACTIVE' FOR SHARE;
    IF NOT FOUND OR v_type IS DISTINCT FROM NEW.inspection_type THEN
      RAISE EXCEPTION 'an ACTIVE fabric scoring profile matching the inspection type is required' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_quality_sampling_profile_binding ON quality_inspections;
CREATE TRIGGER trg_quality_sampling_profile_binding
BEFORE UPDATE OF aql_profile_id,fabric_scoring_profile_id ON quality_inspections
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_sampling_profile_binding();

CREATE OR REPLACE FUNCTION factoryos_guard_quality_aql_sample_run()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_inspection quality_inspections%ROWTYPE;
  v_profile quality_aql_profiles%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'AQL sample runs are append-only evidence' USING ERRCODE='55000';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'AQL sample actor must match authenticated user' USING ERRCODE='23514';
  END IF;

  SELECT * INTO v_inspection FROM quality_inspections
  WHERE id=NEW.inspection_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id FOR UPDATE;
  IF NOT FOUND OR v_inspection.aql_profile_id IS DISTINCT FROM NEW.profile_id
    OR v_inspection.status NOT IN ('OPEN','IN_PROGRESS') THEN
    RAISE EXCEPTION 'AQL sample must use the bound profile on an open or in-progress inspection' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_profile FROM quality_aql_profiles
  WHERE id=NEW.profile_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  IF NOT FOUND OR NEW.lot_size NOT BETWEEN v_profile.lot_size_min AND v_profile.lot_size_max
     OR NEW.sample_size<>v_profile.sample_size THEN
    RAISE EXCEPTION 'AQL lot size or sample size does not match the bound profile' USING ERRCODE='23514';
  END IF;
  NEW.profile_revision:=v_profile.revision;
  NEW.aql_percent_snapshot:=v_profile.aql_percent;
  NEW.inspection_level_snapshot:=v_profile.inspection_level;
  NEW.accept_number:=v_profile.accept_number;
  NEW.reject_number:=v_profile.reject_number;
  NEW.decision:=factoryos_evaluate_aql_sample(NEW.observed_nonconforming,NEW.accept_number,NEW.reject_number);
  IF NEW.decision='HOLD' AND NEW.observed_nonconforming NOT BETWEEN NEW.accept_number AND NEW.reject_number-1 THEN
    RAISE EXCEPTION 'AQL sample counts are outside the profile decision range' USING ERRCODE='23514';
  END IF;
  IF NEW.decision='HOLD' AND NEW.observed_nonconforming<>NEW.accept_number+1 THEN
    -- A deliberate gap between accept and reject numbers remains HOLD and never implies release.
    NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_quality_aql_sample_run_guard ON quality_aql_sample_runs;
CREATE TRIGGER trg_quality_aql_sample_run_guard
BEFORE INSERT OR UPDATE OR DELETE ON quality_aql_sample_runs
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_aql_sample_run();

CREATE OR REPLACE FUNCTION factoryos_guard_quality_fabric_roll_score()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_inspection quality_inspections%ROWTYPE;
  v_profile quality_fabric_scoring_profiles%ROWTYPE;
  v_sum NUMERIC(18,4);
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'fabric roll scores are append-only evidence' USING ERRCODE='55000';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'fabric roll score actor must match authenticated user' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_inspection FROM quality_inspections
  WHERE id=NEW.inspection_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id FOR UPDATE;
  IF NOT FOUND OR v_inspection.fabric_scoring_profile_id IS DISTINCT FROM NEW.profile_id
    OR v_inspection.status NOT IN ('OPEN','IN_PROGRESS') THEN
    RAISE EXCEPTION 'fabric roll score must use the bound profile on an open or in-progress inspection' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_profile FROM quality_fabric_scoring_profiles
  WHERE id=NEW.profile_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'fabric scoring profile not found in this factory' USING ERRCODE='23503'; END IF;
  IF jsonb_typeof(NEW.defects)<>'array' THEN RAISE EXCEPTION 'fabric defect evidence must be an array' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(sum((item->>'points')::numeric),0) INTO v_sum
  FROM jsonb_array_elements(NEW.defects) AS item
  WHERE jsonb_typeof(item)='object' AND item ? 'points'
    AND (item->>'points') ~ '^[0-9]+([.][0-9]{1,4})?$';
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.defects) AS item
    WHERE jsonb_typeof(item)<>'object' OR NOT (item ? 'points')
       OR (item->>'points') !~ '^[0-9]+([.][0-9]{1,4})?$'
  ) OR v_sum IS DISTINCT FROM NEW.total_defect_points THEN
    RAISE EXCEPTION 'fabric defect point evidence must reconcile exactly to total_defect_points' USING ERRCODE='23514';
  END IF;
  NEW.profile_revision:=v_profile.revision;
  NEW.max_points_snapshot:=v_profile.max_points_per_100_square_yards;
  NEW.points_per_100_square_yards:=round(NEW.total_defect_points*3600/(NEW.roll_length_yards*NEW.roll_width_inches),4);
  NEW.decision:=CASE WHEN NEW.points_per_100_square_yards<=NEW.max_points_snapshot THEN 'PASS' ELSE 'HOLD' END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_quality_fabric_roll_score_guard ON quality_fabric_roll_scores;
CREATE TRIGGER trg_quality_fabric_roll_score_guard
BEFORE INSERT OR UPDATE OR DELETE ON quality_fabric_roll_scores
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_fabric_roll_score();

CREATE OR REPLACE FUNCTION factoryos_require_advanced_quality_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_decision TEXT;
  v_roll_count INTEGER;
  v_minimum_roll_count INTEGER;
BEGIN
  IF TG_OP='UPDATE' AND NEW.status='PASSED' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.aql_profile_id IS NOT NULL THEN
      SELECT decision INTO v_decision FROM quality_aql_sample_runs
      WHERE inspection_id=NEW.id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
      IF v_decision IS DISTINCT FROM 'ACCEPT' THEN
        RAISE EXCEPTION 'AQL-bound inspection cannot pass without an ACCEPT sample decision' USING ERRCODE='23514';
      END IF;
    END IF;
    IF NEW.fabric_scoring_profile_id IS NOT NULL THEN
      SELECT minimum_roll_count INTO v_minimum_roll_count FROM quality_fabric_scoring_profiles
      WHERE id=NEW.fabric_scoring_profile_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
      SELECT count(*) INTO v_roll_count FROM quality_fabric_roll_scores
      WHERE inspection_id=NEW.id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
        AND decision='PASS';
      IF v_minimum_roll_count IS NULL OR v_roll_count<v_minimum_roll_count
        OR EXISTS (SELECT 1 FROM quality_fabric_roll_scores WHERE inspection_id=NEW.id
                   AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND decision<>'PASS') THEN
        RAISE EXCEPTION 'fabric-scored inspection requires the configured number of passing rolls and no held roll' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_zz_quality_require_advanced_evidence ON quality_inspections;
CREATE TRIGGER trg_zz_quality_require_advanced_evidence
BEFORE UPDATE OF status ON quality_inspections
FOR EACH ROW EXECUTE FUNCTION factoryos_require_advanced_quality_evidence();

CREATE OR REPLACE FUNCTION factoryos_record_quality_supplier_defect()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_supplier UUID;
  v_receipt UUID;
  v_defect quality_defects%ROWTYPE;
  v_actor UUID;
  v_corr UUID := gen_random_uuid();
  v_event_id UUID;
BEGIN
  IF NEW.goods_receipt_line_id IS NULL THEN RETURN NEW; END IF;
  SELECT po.supplier_id, gr.goods_receipt_id INTO v_supplier, v_receipt
  FROM goods_receipt_lines gr
  JOIN purchase_orders po ON po.id=gr.purchase_order_id AND po.tenant_id=gr.tenant_id AND po.factory_id=gr.factory_id
  WHERE gr.id=NEW.goods_receipt_line_id AND gr.tenant_id=NEW.tenant_id AND gr.factory_id=NEW.factory_id;
  IF v_supplier IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_defect FROM quality_defects
  WHERE id=NEW.defect_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  v_actor:=NEW.created_by_user_id;
  INSERT INTO quality_supplier_quality_events (
    tenant_id,factory_id,supplier_id,source_link_id,inspection_id,defect_id,goods_receipt_id,goods_receipt_line_id,
    event_type,defect_code,severity,affected_quantity,evidence,recorded_by_user_id,correlation_id
  ) VALUES (
    NEW.tenant_id,NEW.factory_id,v_supplier,NEW.id,v_defect.inspection_id,NEW.defect_id,v_receipt,NEW.goods_receipt_line_id,
    'DEFECT_REPORTED',v_defect.defect_code,v_defect.severity,
    COALESCE(NEW.affected_quantity,v_defect.affected_quantity),jsonb_build_object('source','QUALITY_DEFECT_LINK','link_type',NEW.link_type,
      'source_link_id',NEW.id,'source_link_evidence',NEW.evidence,'quality_defect_evidence',v_defect.evidence),
    v_actor,v_corr
  ) ON CONFLICT (tenant_id,factory_id,source_link_id,event_type) DO NOTHING
  RETURNING id INTO v_event_id;
  IF v_event_id IS NOT NULL THEN
    INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
    VALUES (NEW.tenant_id,NEW.factory_id,v_defect.inspection_id,NEW.defect_id,'SUPPLIER_QUALITY_DEFECT_LINKED',
      jsonb_build_object('supplier_id',v_supplier,'goods_receipt_id',v_receipt,'goods_receipt_line_id',NEW.goods_receipt_line_id,'supplier_quality_event_id',v_event_id),
      v_actor,v_corr);
    INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
    VALUES (NEW.tenant_id,NEW.factory_id,'SUPPLIER_QUALITY',v_supplier,'QUALITY.SUPPLIER_DEFECT_RECORDED',
      jsonb_build_object('supplier_id',v_supplier,'defect_id',NEW.defect_id,'inspection_id',v_defect.inspection_id,'event_id',v_event_id,'correlation_id',v_corr));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_quality_supplier_defect_link ON quality_defect_links;
CREATE TRIGGER trg_quality_supplier_defect_link
AFTER INSERT ON quality_defect_links
FOR EACH ROW EXECUTE FUNCTION factoryos_record_quality_supplier_defect();

CREATE OR REPLACE FUNCTION factoryos_guard_quality_sampling_binding_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_inspection quality_inspections%ROWTYPE;
  v_type TEXT;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'sampling profile binding evidence is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'sampling-profile binding actor must match authenticated user' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_inspection FROM quality_inspections
  WHERE id=NEW.inspection_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id FOR SHARE;
  IF NOT FOUND OR v_inspection.status<>'OPEN'
    OR NEW.aql_profile_id IS DISTINCT FROM v_inspection.aql_profile_id
    OR NEW.fabric_scoring_profile_id IS DISTINCT FROM v_inspection.fabric_scoring_profile_id THEN
    RAISE EXCEPTION 'sampling-profile binding evidence must match the OPEN inspection binding' USING ERRCODE='23514';
  END IF;
  IF NEW.aql_profile_id IS NOT NULL THEN
    SELECT inspection_type INTO v_type FROM quality_aql_profiles
    WHERE id=NEW.aql_profile_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
    IF NOT FOUND OR v_type IS DISTINCT FROM v_inspection.inspection_type THEN
      RAISE EXCEPTION 'AQL evidence binding must match the inspection type and factory' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.fabric_scoring_profile_id IS NOT NULL THEN
    SELECT inspection_type INTO v_type FROM quality_fabric_scoring_profiles
    WHERE id=NEW.fabric_scoring_profile_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
    IF NOT FOUND OR v_type IS DISTINCT FROM v_inspection.inspection_type THEN
      RAISE EXCEPTION 'fabric scoring evidence binding must match the inspection type and factory' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_quality_sampling_binding_evidence_guard ON quality_sampling_profile_bindings;
CREATE TRIGGER trg_quality_sampling_binding_evidence_guard
BEFORE INSERT ON quality_sampling_profile_bindings
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_sampling_binding_evidence();

CREATE OR REPLACE FUNCTION factoryos_guard_quality_defect_context_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'defect context is append-only evidence' USING ERRCODE='55000';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'defect context actor must match authenticated user' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_quality_defect_context_actor_guard ON quality_defect_context_snapshots;
CREATE TRIGGER trg_quality_defect_context_actor_guard
BEFORE INSERT ON quality_defect_context_snapshots
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_defect_context_evidence();

CREATE OR REPLACE FUNCTION factoryos_guard_quality_supplier_event_source()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_link quality_defect_links%ROWTYPE;
  v_defect quality_defects%ROWTYPE;
  v_supplier UUID;
  v_receipt UUID;
  v_expected_quantity NUMERIC(18,4);
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'supplier quality events are append-only' USING ERRCODE='55000';
  END IF;
  IF NEW.event_type<>'DEFECT_REPORTED' THEN
    RAISE EXCEPTION 'unsupported supplier-quality event type' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_link FROM quality_defect_links
  WHERE id=NEW.source_link_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id FOR SHARE;
  IF NOT FOUND OR v_link.link_type<>'GOODS_RECEIPT_LINE' OR v_link.goods_receipt_line_id IS NULL OR v_link.goods_receipt_id IS NULL THEN
    RAISE EXCEPTION 'supplier quality event must derive from a scoped goods-receipt-line defect link' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_defect FROM quality_defects
  WHERE id=v_link.defect_id AND tenant_id=v_link.tenant_id AND factory_id=v_link.factory_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'supplier quality source defect was not found' USING ERRCODE='23503'; END IF;
  SELECT po.supplier_id,gr.goods_receipt_id INTO v_supplier,v_receipt
  FROM goods_receipt_lines gr
  JOIN purchase_orders po ON po.id=gr.purchase_order_id AND po.tenant_id=gr.tenant_id AND po.factory_id=gr.factory_id
  WHERE gr.id=v_link.goods_receipt_line_id AND gr.tenant_id=v_link.tenant_id AND gr.factory_id=v_link.factory_id;
  IF v_supplier IS NULL OR v_receipt IS DISTINCT FROM v_link.goods_receipt_id
    OR NEW.supplier_id IS DISTINCT FROM v_supplier
    OR NEW.goods_receipt_id IS DISTINCT FROM v_receipt
    OR NEW.goods_receipt_line_id IS DISTINCT FROM v_link.goods_receipt_line_id
    OR NEW.defect_id IS DISTINCT FROM v_defect.id
    OR NEW.inspection_id IS DISTINCT FROM v_defect.inspection_id
    OR NEW.defect_code IS DISTINCT FROM v_defect.defect_code
    OR NEW.severity IS DISTINCT FROM v_defect.severity
    OR NEW.recorded_by_user_id IS DISTINCT FROM v_link.created_by_user_id THEN
    RAISE EXCEPTION 'supplier quality event must preserve PO-derived supplier, GRN, defect, actor and severity provenance' USING ERRCODE='23514';
  END IF;
  v_expected_quantity:=COALESCE(v_link.affected_quantity,v_defect.affected_quantity);
  IF NEW.affected_quantity IS DISTINCT FROM v_expected_quantity THEN
    RAISE EXCEPTION 'supplier quality event quantity must match the source defect link' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(NEW.evidence)<>'object' OR NEW.evidence='{}'::jsonb THEN
    RAISE EXCEPTION 'supplier quality event must retain non-empty evidence' USING ERRCODE='23514';
  END IF;
  NEW.evidence:=NEW.evidence || jsonb_build_object(
    'source_link_evidence',v_link.evidence,'quality_defect_evidence',v_defect.evidence,
    'purchase_order_supplier_id',v_supplier,'goods_receipt_id',v_receipt);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_quality_supplier_event_source_guard ON quality_supplier_quality_events;
CREATE TRIGGER trg_quality_supplier_event_source_guard
BEFORE INSERT ON quality_supplier_quality_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_supplier_event_source();

CREATE OR REPLACE FUNCTION factoryos_prevent_quality_advanced_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'advanced quality evidence is append-only' USING ERRCODE='55000';
END;
$$;
DROP TRIGGER IF EXISTS trg_quality_aql_sample_run_immutable ON quality_aql_sample_runs;
CREATE TRIGGER trg_quality_aql_sample_run_immutable
BEFORE UPDATE OR DELETE ON quality_aql_sample_runs
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_quality_advanced_evidence_mutation();
DROP TRIGGER IF EXISTS trg_quality_fabric_roll_score_immutable ON quality_fabric_roll_scores;
CREATE TRIGGER trg_quality_fabric_roll_score_immutable
BEFORE UPDATE OR DELETE ON quality_fabric_roll_scores
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_quality_advanced_evidence_mutation();
DROP TRIGGER IF EXISTS trg_quality_supplier_event_immutable ON quality_supplier_quality_events;
CREATE TRIGGER trg_quality_supplier_event_immutable
BEFORE UPDATE OR DELETE ON quality_supplier_quality_events
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_quality_advanced_evidence_mutation();
DROP TRIGGER IF EXISTS trg_quality_defect_context_immutable ON quality_defect_context_snapshots;
CREATE TRIGGER trg_quality_defect_context_immutable
BEFORE UPDATE OR DELETE ON quality_defect_context_snapshots
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_quality_advanced_evidence_mutation();
DROP TRIGGER IF EXISTS trg_quality_sampling_binding_immutable ON quality_sampling_profile_bindings;
CREATE TRIGGER trg_quality_sampling_binding_immutable
BEFORE UPDATE OR DELETE ON quality_sampling_profile_bindings
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_quality_advanced_evidence_mutation();

DO $quality_rls$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'quality_aql_profiles','quality_fabric_scoring_profiles','quality_sampling_profile_bindings','quality_aql_sample_runs',
    'quality_fabric_roll_scores','quality_defect_context_snapshots','quality_supplier_quality_events'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I',t||'_tenant_isolation',t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id())',t||'_tenant_isolation',t);
  END LOOP;
END;
$quality_rls$;

COMMENT ON TABLE quality_aql_profiles IS
  'Tenant/factory-scoped, versioned AQL sampling profiles. Acceptance and rejection numbers are explicitly approved configuration, not hard-coded standards tables.';
COMMENT ON TABLE quality_aql_sample_runs IS
  'Immutable sample decision snapshot; the database calculates ACCEPT/REJECT/HOLD from the bound profile and records actor/evidence.';
COMMENT ON TABLE quality_fabric_roll_scores IS
  'Immutable per-roll four-point scoring record; score is points per 100 square yards based on roll length in yards and width in inches.';
COMMENT ON TABLE quality_supplier_quality_events IS
  'Append-only supplier quality linkage derived from a defect link to a goods-receipt line and that line purchase order supplier.';
COMMENT ON TABLE quality_defect_context_snapshots IS
  'Immutable line/operation/style/shift labels captured when a defect is recorded for reproducible defect Pareto reporting.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('164_quality_advanced_sampling_supplier_pareto', NULL)
ON CONFLICT (version) DO NOTHING;
COMMIT;
