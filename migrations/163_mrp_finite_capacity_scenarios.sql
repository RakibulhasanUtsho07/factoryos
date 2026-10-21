BEGIN;
INSERT INTO permissions(code,description) VALUES
 ('mrp.capacity.read','Read finite-capacity MRP scenarios, shift calendars and frozen-horizon diffs'),
 ('mrp.capacity.manage','Manage factory-scoped work-centre capacity calendars'),
 ('mrp.capacity.write','Calculate immutable finite-capacity schedules from an MRP-lite run')
ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code IN('mrp.capacity.read','mrp.capacity.manage','mrp.capacity.write')
WHERE r.code IN('ORG_ADMIN','FACTORY_MANAGER') ON CONFLICT(role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS mrp_work_centre_capacity_calendar (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, factory_id UUID NOT NULL,
 work_centre_id UUID NOT NULL, capacity_date DATE NOT NULL, shift_code VARCHAR(80) NOT NULL,
 available_minutes NUMERIC(12,4) NOT NULL, efficiency_percent NUMERIC(6,3) NOT NULL DEFAULT 100,
 skill_codes TEXT[] NOT NULL DEFAULT ARRAY[]::text[], status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
 row_version BIGINT NOT NULL DEFAULT 1, idempotency_key VARCHAR(255) NOT NULL, request_hash CHAR(64) NOT NULL,
 last_change_reason TEXT, created_by_user_id UUID NOT NULL, updated_by_user_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT uq_mrp_capacity_calendar_scope UNIQUE(id,tenant_id,factory_id),
 CONSTRAINT uq_mrp_capacity_calendar_slot UNIQUE(tenant_id,factory_id,work_centre_id,capacity_date,shift_code),
 CONSTRAINT uq_mrp_capacity_calendar_idempotency UNIQUE(tenant_id,factory_id,idempotency_key),
 CONSTRAINT fk_mrp_capacity_calendar_centre FOREIGN KEY(work_centre_id,tenant_id,factory_id)
  REFERENCES manufacturing_work_centres(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_mrp_capacity_calendar_creator FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT fk_mrp_capacity_calendar_updater FOREIGN KEY(updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_mrp_capacity_calendar_shift CHECK(length(btrim(shift_code)) BETWEEN 1 AND 80),
 CONSTRAINT chk_mrp_capacity_calendar_minutes CHECK(available_minutes>=0 AND available_minutes<=10080),
 CONSTRAINT chk_mrp_capacity_calendar_efficiency CHECK(efficiency_percent>0 AND efficiency_percent<=150),
 CONSTRAINT chk_mrp_capacity_calendar_version CHECK(row_version>0),
 CONSTRAINT chk_mrp_capacity_calendar_status CHECK(status IN('ACTIVE','INACTIVE')),
 CONSTRAINT chk_mrp_capacity_calendar_key_hash CHECK(length(btrim(idempotency_key)) BETWEEN 1 AND 255 AND request_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT chk_mrp_capacity_calendar_skills CHECK(array_position(skill_codes,NULL) IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_mrp_capacity_calendar_day
 ON mrp_work_centre_capacity_calendar(tenant_id,factory_id,capacity_date,work_centre_id,shift_code);

CREATE TABLE IF NOT EXISTS mrp_capacity_plans (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, factory_id UUID NOT NULL,
 source_mrp_plan_id UUID NOT NULL, plan_version INTEGER NOT NULL, scenario_name VARCHAR(120) NOT NULL,
 horizon_start DATE NOT NULL, horizon_end DATE NOT NULL, frozen_horizon_start DATE NOT NULL, frozen_horizon_end DATE NOT NULL,
 compare_to_plan_id UUID, status VARCHAR(24) NOT NULL DEFAULT 'CALCULATED',
 idempotency_key VARCHAR(255) NOT NULL, request_hash CHAR(64) NOT NULL, request_id UUID, trace_id UUID, correlation_id UUID NOT NULL,
 summary JSONB NOT NULL DEFAULT '{}'::jsonb, conflicts JSONB NOT NULL DEFAULT '[]'::jsonb, scenario_diff JSONB NOT NULL DEFAULT '[]'::jsonb,
 created_by_user_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT uq_mrp_capacity_plan_scope UNIQUE(id,tenant_id,factory_id),
 CONSTRAINT uq_mrp_capacity_plan_version UNIQUE(tenant_id,factory_id,source_mrp_plan_id,plan_version),
 CONSTRAINT uq_mrp_capacity_plan_idempotency UNIQUE(tenant_id,factory_id,idempotency_key),
 CONSTRAINT fk_mrp_capacity_plan_source FOREIGN KEY(source_mrp_plan_id,tenant_id,factory_id)
  REFERENCES mrp_plans(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_mrp_capacity_plan_compare FOREIGN KEY(compare_to_plan_id,tenant_id,factory_id)
  REFERENCES mrp_capacity_plans(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_mrp_capacity_plan_creator FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_mrp_capacity_plan_version CHECK(plan_version>0),
 CONSTRAINT chk_mrp_capacity_plan_horizon CHECK(horizon_end>=horizon_start AND horizon_end-horizon_start<=365),
 CONSTRAINT chk_mrp_capacity_plan_frozen CHECK(frozen_horizon_start>=horizon_start AND frozen_horizon_end>=frozen_horizon_start AND frozen_horizon_end<=horizon_end),
 CONSTRAINT chk_mrp_capacity_plan_name CHECK(length(btrim(scenario_name)) BETWEEN 1 AND 120),
 CONSTRAINT chk_mrp_capacity_plan_status CHECK(status IN('CALCULATED','CAPACITY_CONFLICTS','MATERIAL_BLOCKED')),
 CONSTRAINT chk_mrp_capacity_plan_key CHECK(length(btrim(idempotency_key)) BETWEEN 1 AND 255 AND request_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT chk_mrp_capacity_plan_json CHECK(jsonb_typeof(summary)='object' AND jsonb_typeof(conflicts)='array' AND jsonb_typeof(scenario_diff)='array')
);
CREATE INDEX IF NOT EXISTS idx_mrp_capacity_plan_timeline
 ON mrp_capacity_plans(tenant_id,factory_id,source_mrp_plan_id,plan_version DESC,created_at DESC);

CREATE TABLE IF NOT EXISTS mrp_capacity_plan_operations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, factory_id UUID NOT NULL,
 plan_id UUID NOT NULL, order_id UUID NOT NULL, order_line_id UUID NOT NULL,
 product_id UUID NOT NULL, product_version_id UUID NOT NULL, product_routing_step_id UUID NOT NULL, work_centre_id UUID NOT NULL,
 order_number VARCHAR(100) NOT NULL, order_line_number INTEGER NOT NULL, product_code VARCHAR(120) NOT NULL,
 product_version_number INTEGER NOT NULL, need_by_date DATE NOT NULL, step_number INTEGER NOT NULL,
 operation_code VARCHAR(100) NOT NULL, operation_name VARCHAR(255) NOT NULL, required_skill VARCHAR(120),
 planned_quantity NUMERIC(18,4) NOT NULL, setup_minutes NUMERIC(12,4) NOT NULL, sam_smv_minutes_per_unit NUMERIC(12,4) NOT NULL,
 queue_minutes NUMERIC(12,4) NOT NULL, transfer_minutes NUMERIC(12,4) NOT NULL, required_minutes NUMERIC(16,4) NOT NULL,
 scheduled_minutes NUMERIC(16,4) NOT NULL DEFAULT 0, unscheduled_minutes NUMERIC(16,4) NOT NULL DEFAULT 0,
 material_ready_on DATE, material_status VARCHAR(24) NOT NULL, capacity_status VARCHAR(32) NOT NULL,
 scheduled_start_date DATE, scheduled_finish_date DATE, schedule_segments JSONB NOT NULL DEFAULT '[]'::jsonb,
 conflict_codes JSONB NOT NULL DEFAULT '[]'::jsonb, frozen_horizon_protected BOOLEAN NOT NULL DEFAULT FALSE,
 frozen_revision_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT uq_mrp_capacity_op UNIQUE(plan_id,order_line_id,product_routing_step_id),
 CONSTRAINT fk_mrp_capacity_op_plan FOREIGN KEY(plan_id,tenant_id,factory_id) REFERENCES mrp_capacity_plans(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_mrp_capacity_op_order_line FOREIGN KEY(order_line_id,order_id,tenant_id,factory_id)
  REFERENCES order_lines(id,order_id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_mrp_capacity_op_version FOREIGN KEY(product_version_id,tenant_id,factory_id,product_id)
  REFERENCES product_versions(id,tenant_id,factory_id,product_id) ON DELETE RESTRICT,
 CONSTRAINT fk_mrp_capacity_op_routing FOREIGN KEY(product_routing_step_id,product_version_id,tenant_id,factory_id)
  REFERENCES product_routing_steps(id,product_version_id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_mrp_capacity_op_work_centre FOREIGN KEY(work_centre_id,tenant_id,factory_id)
  REFERENCES manufacturing_work_centres(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT chk_mrp_capacity_op_quantities CHECK(planned_quantity>0 AND required_minutes>0 AND scheduled_minutes>=0 AND unscheduled_minutes>=0),
 CONSTRAINT chk_mrp_capacity_op_step CHECK(step_number>0 AND order_line_number>0 AND product_version_number>0),
 CONSTRAINT chk_mrp_capacity_op_material CHECK(material_status IN('READY','LATE_SUPPLY','UNSUPPLIED')),
 CONSTRAINT chk_mrp_capacity_op_status CHECK(capacity_status IN('SCHEDULED','LATE_SCHEDULE','CAPACITY_CONFLICT','MATERIAL_BLOCKED','FROZEN_HORIZON_CONFLICT')),
 CONSTRAINT chk_mrp_capacity_op_json CHECK(jsonb_typeof(schedule_segments)='array' AND jsonb_typeof(conflict_codes)='array' AND jsonb_typeof(frozen_revision_snapshot)='object')
);
CREATE INDEX IF NOT EXISTS idx_mrp_capacity_op_plan_schedule
 ON mrp_capacity_plan_operations(tenant_id,factory_id,plan_id,scheduled_start_date,work_centre_id,step_number);

CREATE OR REPLACE FUNCTION factoryos_guard_mrp_capacity_calendar()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.row_version<>1 OR NEW.last_change_reason IS NOT NULL OR NEW.status<>'ACTIVE' THEN
   RAISE EXCEPTION 'Capacity calendar entries start active at version one' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Capacity calendar audit history is retained; inactivate the entry instead' USING ERRCODE='55000'; END IF;
 IF ROW(NEW.id,NEW.tenant_id,NEW.factory_id,NEW.work_centre_id,NEW.capacity_date,NEW.shift_code,NEW.idempotency_key,NEW.request_hash,NEW.created_by_user_id,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.factory_id,OLD.work_centre_id,OLD.capacity_date,OLD.shift_code,OLD.idempotency_key,OLD.request_hash,OLD.created_by_user_id,OLD.created_at) THEN
  RAISE EXCEPTION 'Capacity calendar slot identity and creation evidence are immutable' USING ERRCODE='55000';
 END IF;
 IF NEW.row_version<>OLD.row_version+1 OR NEW.updated_at<=OLD.updated_at OR length(btrim(COALESCE(NEW.last_change_reason,'')))=0 THEN
  RAISE EXCEPTION 'Capacity calendar edits require a row-version increment and change reason' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_mrp_capacity_calendar_guard ON mrp_work_centre_capacity_calendar;
CREATE TRIGGER trg_mrp_capacity_calendar_guard BEFORE INSERT OR UPDATE OR DELETE ON mrp_work_centre_capacity_calendar
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_mrp_capacity_calendar();

CREATE OR REPLACE FUNCTION factoryos_prevent_mrp_capacity_plan_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Capacity plans are immutable snapshots; recalculate a new plan version' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS trg_mrp_capacity_plan_immutable ON mrp_capacity_plans;
CREATE TRIGGER trg_mrp_capacity_plan_immutable BEFORE UPDATE OR DELETE ON mrp_capacity_plans
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_mrp_capacity_plan_mutation();
DROP TRIGGER IF EXISTS trg_mrp_capacity_plan_operations_immutable ON mrp_capacity_plan_operations;
CREATE TRIGGER trg_mrp_capacity_plan_operations_immutable BEFORE UPDATE OR DELETE ON mrp_capacity_plan_operations
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_mrp_capacity_plan_mutation();

ALTER TABLE mrp_work_centre_capacity_calendar ENABLE ROW LEVEL SECURITY; ALTER TABLE mrp_work_centre_capacity_calendar FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mrp_capacity_calendar_tenant_isolation ON mrp_work_centre_capacity_calendar;
CREATE POLICY mrp_capacity_calendar_tenant_isolation ON mrp_work_centre_capacity_calendar USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());
ALTER TABLE mrp_capacity_plans ENABLE ROW LEVEL SECURITY; ALTER TABLE mrp_capacity_plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mrp_capacity_plans_tenant_isolation ON mrp_capacity_plans;
CREATE POLICY mrp_capacity_plans_tenant_isolation ON mrp_capacity_plans USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());
ALTER TABLE mrp_capacity_plan_operations ENABLE ROW LEVEL SECURITY; ALTER TABLE mrp_capacity_plan_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mrp_capacity_plan_operations_tenant_isolation ON mrp_capacity_plan_operations;
CREATE POLICY mrp_capacity_plan_operations_tenant_isolation ON mrp_capacity_plan_operations USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

COMMENT ON TABLE mrp_work_centre_capacity_calendar IS 'Effective-dated shift capacity and skill calendar used only for planning; updates require row-version and reason.';
COMMENT ON TABLE mrp_capacity_plans IS 'Immutable finite-capacity MRP scenario derived from an immutable MRP-lite material plan; never commits inventory reservations or purchase orders.';
COMMENT ON TABLE mrp_capacity_plan_operations IS 'Immutable route-operation schedule snapshot with standard-minute/SAM-SMV demand, material readiness, capacity conflicts and frozen-horizon evidence.';
INSERT INTO schema_migrations(version,checksum) VALUES('163_mrp_finite_capacity_scenarios',NULL) ON CONFLICT(version) DO NOTHING;
COMMIT;