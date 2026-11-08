BEGIN;
ALTER TABLE utility_meter_readings
  ADD COLUMN IF NOT EXISTS currency_code_snapshot CHAR(3),
  ADD COLUMN IF NOT EXISTS cost_center_code_snapshot VARCHAR(100);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='utility_meter_readings'::regclass AND conname='chk_utility_reading_currency_snapshot') THEN
    ALTER TABLE utility_meter_readings ADD CONSTRAINT chk_utility_reading_currency_snapshot
      CHECK (currency_code_snapshot IS NULL OR currency_code_snapshot ~ '^[A-Z]{3}$');
  END IF;
END; $$;

-- Historical rows intentionally remain NULL: do not infer old currency/cost-centre values.
CREATE OR REPLACE FUNCTION factoryos_snapshot_utility_reading_cost_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_meter RECORD;
BEGIN
  SELECT currency_code,cost_center_code INTO v_meter
    FROM utility_meters
   WHERE id=NEW.meter_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Utility reading cost snapshot requires an in-factory meter' USING ERRCODE='23503';
  END IF;
  NEW.currency_code_snapshot:=v_meter.currency_code;
  NEW.cost_center_code_snapshot:=v_meter.cost_center_code;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_utility_reading_source_cost_snapshot ON utility_meter_readings;
CREATE TRIGGER trg_utility_reading_source_cost_snapshot
  BEFORE INSERT ON utility_meter_readings
  FOR EACH ROW EXECUTE FUNCTION factoryos_snapshot_utility_reading_cost_scope();

ALTER TABLE utility_audit_events DROP CONSTRAINT IF EXISTS chk_utility_audit_entity;
ALTER TABLE utility_audit_events ADD CONSTRAINT chk_utility_audit_entity
  CHECK (entity_type IN ('METER','READING','UTILITY_EVENT','METER_SOURCE_BINDING','THRESHOLD_POLICY','WO_COST_ALLOCATION'));

CREATE TABLE IF NOT EXISTS utility_reading_work_order_cost_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  reading_id UUID NOT NULL,
  meter_id UUID NOT NULL,
  work_order_id UUID NOT NULL,
  allocation_kind VARCHAR(10) NOT NULL DEFAULT 'ALLOCATE',
  reverses_allocation_id UUID,
  allocation_basis VARCHAR(32) NOT NULL DEFAULT 'OPERATOR_ASSIGNED',
  allocated_quantity NUMERIC(24,8) NOT NULL,
  unit_code VARCHAR(24) NOT NULL,
  unit_cost_snapshot NUMERIC(18,8) NOT NULL,
  allocated_cost NUMERIC(24,8) NOT NULL,
  currency_code CHAR(3) NOT NULL,
  cost_center_code VARCHAR(100),
  reason TEXT NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  request_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_utility_reading_work_order_cost_allocation_scope UNIQUE (id,tenant_id,factory_id),
  CONSTRAINT uq_utility_reading_work_order_cost_allocation_idempotency UNIQUE (tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_utility_reading_work_order_cost_allocation_reading
    FOREIGN KEY (reading_id,tenant_id,factory_id) REFERENCES utility_meter_readings(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_reading_work_order_cost_allocation_meter
    FOREIGN KEY (meter_id,tenant_id,factory_id) REFERENCES utility_meters(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_reading_work_order_cost_allocation_work_order
    FOREIGN KEY (work_order_id,tenant_id,factory_id) REFERENCES work_orders(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_reading_work_order_cost_allocation_reversal
    FOREIGN KEY (reverses_allocation_id,tenant_id,factory_id) REFERENCES utility_reading_work_order_cost_allocations(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_reading_work_order_cost_allocation_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_utility_reading_work_order_cost_allocation_kind CHECK (allocation_kind IN ('ALLOCATE','REVERSAL')),
  CONSTRAINT chk_utility_reading_work_order_cost_allocation_reversal CHECK (
    (allocation_kind='ALLOCATE' AND reverses_allocation_id IS NULL) OR
    (allocation_kind='REVERSAL' AND reverses_allocation_id IS NOT NULL)
  ),
  CONSTRAINT chk_utility_reading_work_order_cost_allocation_basis CHECK (allocation_basis='OPERATOR_ASSIGNED'),
  CONSTRAINT chk_utility_reading_work_order_cost_allocation_quantity CHECK (allocated_quantity > 0),
  CONSTRAINT chk_utility_reading_work_order_cost_allocation_rate CHECK (unit_cost_snapshot >= 0),
  CONSTRAINT chk_utility_reading_work_order_cost_allocation_cost
    CHECK (allocated_cost >= 0 AND allocated_cost=ROUND(allocated_quantity*unit_cost_snapshot,8)),
  CONSTRAINT chk_utility_reading_work_order_cost_allocation_currency CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_utility_reading_work_order_cost_allocation_unit CHECK (length(btrim(unit_code)) BETWEEN 1 AND 24),
  CONSTRAINT chk_utility_reading_work_order_cost_allocation_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT chk_utility_reading_work_order_cost_allocation_idempotency CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_utility_reading_work_order_cost_allocation_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_utility_reading_work_order_cost_allocation_reading
  ON utility_reading_work_order_cost_allocations(tenant_id,factory_id,reading_id,created_at,id);
CREATE INDEX IF NOT EXISTS idx_utility_reading_work_order_cost_allocation_work_order
  ON utility_reading_work_order_cost_allocations(tenant_id,factory_id,work_order_id,created_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_utility_reading_work_order_cost_allocation_reversal
  ON utility_reading_work_order_cost_allocations(tenant_id,factory_id,reverses_allocation_id)
  WHERE reverses_allocation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_guard_utility_reading_work_order_cost_allocation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_source RECORD; v_work_order RECORD; v_original RECORD; v_net_allocated NUMERIC(24,8);
BEGIN
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Utility work-order allocation actor must match authenticated database context' USING ERRCODE='42501';
  END IF;
  IF NEW.reason IS NULL OR length(btrim(NEW.reason))=0 THEN
    RAISE EXCEPTION 'Utility work-order cost allocation requires a reason' USING ERRCODE='23514';
  END IF;
  IF NEW.allocation_kind='ALLOCATE' THEN
    SELECT r.consumption_quantity,r.unit_code,r.unit_cost_snapshot,r.currency_code_snapshot,
           r.cost_center_code_snapshot,r.reading_at
      INTO v_source
      FROM utility_meter_readings r
     WHERE r.id=NEW.reading_id AND r.meter_id=NEW.meter_id
       AND r.tenant_id=NEW.tenant_id AND r.factory_id=NEW.factory_id
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Allocation source reading was not found in the same factory' USING ERRCODE='23503'; END IF;
    IF v_source.currency_code_snapshot IS NULL THEN
      RAISE EXCEPTION 'Historical utility reading has no frozen currency snapshot and cannot be allocated' USING ERRCODE='23514';
    END IF;
    IF v_source.consumption_quantity<=0 THEN
      RAISE EXCEPTION 'A zero-consumption baseline reading cannot be allocated' USING ERRCODE='23514';
    END IF;
    IF NEW.unit_code IS DISTINCT FROM v_source.unit_code
       OR NEW.unit_cost_snapshot IS DISTINCT FROM v_source.unit_cost_snapshot
       OR NEW.currency_code IS DISTINCT FROM v_source.currency_code_snapshot
       OR NEW.cost_center_code IS DISTINCT FROM v_source.cost_center_code_snapshot THEN
      RAISE EXCEPTION 'Allocation UOM, rate, currency and cost centre must match immutable reading snapshots' USING ERRCODE='23514';
    END IF;
    IF NEW.allocated_cost IS DISTINCT FROM ROUND(NEW.allocated_quantity*NEW.unit_cost_snapshot,8)::NUMERIC(24,8) THEN
      RAISE EXCEPTION 'Allocated cost must equal quantity multiplied by source reading rate' USING ERRCODE='23514';
    END IF;
    SELECT status,released_at,completed_at INTO v_work_order
      FROM work_orders
     WHERE id=NEW.work_order_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
     FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Work order was not found in the same factory' USING ERRCODE='23503'; END IF;
    IF v_work_order.status NOT IN ('IN_PROGRESS','COMPLETED')
       OR v_work_order.released_at IS NULL OR v_source.reading_at<v_work_order.released_at
       OR (v_work_order.completed_at IS NOT NULL AND v_source.reading_at>v_work_order.completed_at) THEN
      RAISE EXCEPTION 'Utility reading timestamp must fall within an active released work-order window' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(SUM(CASE WHEN allocation_kind='ALLOCATE' THEN allocated_quantity
                             WHEN allocation_kind='REVERSAL' THEN -allocated_quantity ELSE 0 END),0)::NUMERIC(24,8)
      INTO v_net_allocated
      FROM utility_reading_work_order_cost_allocations
     WHERE reading_id=NEW.reading_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
    IF v_net_allocated+NEW.allocated_quantity>v_source.consumption_quantity THEN
      RAISE EXCEPTION 'Total net work-order allocations cannot exceed source meter consumption' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO v_original FROM utility_reading_work_order_cost_allocations
     WHERE id=NEW.reverses_allocation_id AND tenant_id=NEW.tenant_id
       AND factory_id=NEW.factory_id AND allocation_kind='ALLOCATE'
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reversal must reference one original allocation in the same factory' USING ERRCODE='23503'; END IF;
    IF EXISTS (SELECT 1 FROM utility_reading_work_order_cost_allocations
        WHERE reverses_allocation_id=v_original.id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id) THEN
      RAISE EXCEPTION 'An allocation can be fully reversed only once' USING ERRCODE='23514';
    END IF;
    IF NEW.reading_id IS DISTINCT FROM v_original.reading_id OR NEW.meter_id IS DISTINCT FROM v_original.meter_id
       OR NEW.work_order_id IS DISTINCT FROM v_original.work_order_id OR NEW.allocated_quantity IS DISTINCT FROM v_original.allocated_quantity
       OR NEW.unit_code IS DISTINCT FROM v_original.unit_code OR NEW.unit_cost_snapshot IS DISTINCT FROM v_original.unit_cost_snapshot
       OR NEW.allocated_cost IS DISTINCT FROM v_original.allocated_cost OR NEW.currency_code IS DISTINCT FROM v_original.currency_code
       OR NEW.cost_center_code IS DISTINCT FROM v_original.cost_center_code OR NEW.allocation_basis IS DISTINCT FROM v_original.allocation_basis THEN
      RAISE EXCEPTION 'Reversal must exactly negate the original allocation snapshots' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION factoryos_prevent_utility_reading_work_order_cost_allocation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Utility work-order cost allocation evidence is append-only; reverse it with a new row' USING ERRCODE='23514';
END; $$;

CREATE OR REPLACE FUNCTION factoryos_audit_utility_reading_work_order_cost_allocation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO utility_audit_events(
    tenant_id,factory_id,entity_type,entity_id,entity_version,action,actor_user_id,reason,event_data,correlation_id
  ) VALUES (
    NEW.tenant_id,NEW.factory_id,'WO_COST_ALLOCATION',NEW.id,1,
    CASE WHEN NEW.allocation_kind='REVERSAL' THEN 'REVERSED' ELSE 'ALLOCATED' END,
    NEW.created_by_user_id,NEW.reason,
    jsonb_build_object('allocation_kind',NEW.allocation_kind,'reverses_allocation_id',NEW.reverses_allocation_id,
      'reading_id',NEW.reading_id,'meter_id',NEW.meter_id,'work_order_id',NEW.work_order_id,
      'allocation_basis',NEW.allocation_basis,'allocated_quantity',NEW.allocated_quantity,
      'unit_code',NEW.unit_code,'unit_cost_snapshot',NEW.unit_cost_snapshot,'allocated_cost',NEW.allocated_cost,
      'currency_code',NEW.currency_code,'cost_center_code',NEW.cost_center_code),NEW.correlation_id
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_utility_work_order_cost_allocation_guard ON utility_reading_work_order_cost_allocations;
CREATE TRIGGER trg_utility_work_order_cost_allocation_guard BEFORE INSERT ON utility_reading_work_order_cost_allocations
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_utility_reading_work_order_cost_allocation();
DROP TRIGGER IF EXISTS trg_utility_work_order_cost_allocation_immutable ON utility_reading_work_order_cost_allocations;
CREATE TRIGGER trg_utility_work_order_cost_allocation_immutable BEFORE UPDATE OR DELETE ON utility_reading_work_order_cost_allocations
  FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_utility_reading_work_order_cost_allocation_mutation();
DROP TRIGGER IF EXISTS trg_utility_work_order_cost_allocation_audit ON utility_reading_work_order_cost_allocations;
CREATE TRIGGER trg_utility_work_order_cost_allocation_audit AFTER INSERT ON utility_reading_work_order_cost_allocations
  FOR EACH ROW EXECUTE FUNCTION factoryos_audit_utility_reading_work_order_cost_allocation();

ALTER TABLE utility_reading_work_order_cost_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE utility_reading_work_order_cost_allocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS utility_reading_work_order_cost_allocations_tenant_isolation ON utility_reading_work_order_cost_allocations;
CREATE POLICY utility_reading_work_order_cost_allocations_tenant_isolation ON utility_reading_work_order_cost_allocations
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

-- Migration 235 ran before this newly created relation existed. Register the
-- relation explicitly so generic tenant export remains excluded and erasure
-- remains blocked until a reviewed category-specific adapter is approved.
INSERT INTO factoryos_governance.tenant_relation_inventory (
  schema_name,relation_name,scope_model,data_category,export_disposition,
  erasure_disposition,audit_requirement,rationale
) VALUES (
  'public','utility_reading_work_order_cost_allocations','DIRECT_TENANT_ID','UNREVIEWED',
  'EXCLUDED','BLOCKED_UNREVIEWED','REVIEW_REQUIRED',
  'Append-only utility work-order cost allocations include immutable financial/source evidence; excluded from generic export and erasure pending category-specific adapter review.'
) ON CONFLICT (schema_name,relation_name) DO NOTHING;

INSERT INTO factoryos_governance.tenant_relation_ownership_reviews (
  schema_name,relation_name,ownership_class,evidence_type,evidence_detail,
  scope_predicate,export_disposition,erasure_disposition,review_status
) VALUES (
  'public','utility_reading_work_order_cost_allocations','DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
  'Migration 243 installs direct tenant_id scope and forced RLS. Technical scope verification does not approve export or erasure.',
  'tenant_id=public.factoryos_current_tenant_id()','EXCLUDED','BLOCKED_UNREVIEWED','VERIFIED'
) ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version,checksum)
VALUES ('243_utility_work_order_cost_allocations',NULL) ON CONFLICT(version) DO NOTHING;
COMMIT;
