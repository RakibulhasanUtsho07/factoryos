BEGIN;
INSERT INTO permissions(code,description) VALUES
 ('products.eco.read','Read engineering change orders, revision comparisons and affected production orders'),
 ('products.eco.write','Create and submit engineering change orders'),
 ('products.eco.approve','Approve or reject engineering changes and release effective product revisions')
ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code IN('products.eco.read','products.eco.write','products.eco.approve')
WHERE r.code IN('ORG_ADMIN','FACTORY_MANAGER') ON CONFLICT(role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS product_engineering_changes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL, factory_id UUID NOT NULL, product_id UUID NOT NULL,
 eco_number VARCHAR(100) NOT NULL, title VARCHAR(255) NOT NULL, rationale TEXT NOT NULL,
 source_version_id UUID NOT NULL, target_version_id UUID NOT NULL, effective_on DATE NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'DRAFT', row_version BIGINT NOT NULL DEFAULT 1,
 source_snapshot JSONB NOT NULL, target_snapshot JSONB NOT NULL, revision_diff JSONB NOT NULL,
 affected_order_count INTEGER NOT NULL DEFAULT 0,
 idempotency_key VARCHAR(255) NOT NULL, request_hash CHAR(64) NOT NULL,
 submit_idempotency_key VARCHAR(255), submit_request_hash CHAR(64),
 decision_idempotency_key VARCHAR(255), decision_request_hash CHAR(64),
 created_by_user_id UUID NOT NULL, updated_by_user_id UUID NOT NULL,
 submitted_by_user_id UUID, submitted_at TIMESTAMPTZ, decision_by_user_id UUID, decision_at TIMESTAMPTZ, decision_note TEXT,
 approved_by_user_id UUID, approved_at TIMESTAMPTZ, correlation_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT uq_product_eco_scope UNIQUE(id,tenant_id,factory_id,product_id),
 CONSTRAINT uq_product_eco_number UNIQUE(tenant_id,factory_id,eco_number),
 CONSTRAINT uq_product_eco_idempotency UNIQUE(tenant_id,factory_id,idempotency_key),
 CONSTRAINT fk_product_eco_product FOREIGN KEY(product_id,tenant_id,factory_id) REFERENCES product_definitions(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_product_eco_source FOREIGN KEY(source_version_id,tenant_id,factory_id,product_id) REFERENCES product_versions(id,tenant_id,factory_id,product_id) ON DELETE RESTRICT,
 CONSTRAINT fk_product_eco_target FOREIGN KEY(target_version_id,tenant_id,factory_id,product_id) REFERENCES product_versions(id,tenant_id,factory_id,product_id) ON DELETE RESTRICT,
 CONSTRAINT fk_product_eco_creator FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT fk_product_eco_updater FOREIGN KEY(updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT fk_product_eco_submitter FOREIGN KEY(submitted_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT fk_product_eco_decider FOREIGN KEY(decision_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT fk_product_eco_approver FOREIGN KEY(approved_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_product_eco_versions CHECK(source_version_id<>target_version_id),
 CONSTRAINT chk_product_eco_status CHECK(status IN('DRAFT','SUBMITTED','APPROVED','REJECTED')),
 CONSTRAINT chk_product_eco_version CHECK(row_version>0),
 CONSTRAINT chk_product_eco_fields CHECK(length(btrim(eco_number)) BETWEEN 1 AND 100 AND length(btrim(title)) BETWEEN 1 AND 255 AND length(btrim(rationale)) BETWEEN 1 AND 4000),
 CONSTRAINT chk_product_eco_key_hash CHECK(length(btrim(idempotency_key)) BETWEEN 1 AND 255 AND request_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT chk_product_eco_snapshots CHECK(jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(target_snapshot)='object' AND jsonb_typeof(revision_diff)='object'),
 CONSTRAINT chk_product_eco_impact_count CHECK(affected_order_count>=0),
 CONSTRAINT chk_product_eco_submit_pair CHECK((submit_idempotency_key IS NULL AND submit_request_hash IS NULL AND submitted_by_user_id IS NULL AND submitted_at IS NULL) OR (length(btrim(submit_idempotency_key)) BETWEEN 1 AND 255 AND submit_request_hash ~ '^[0-9a-f]{64}$' AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL)),
 CONSTRAINT chk_product_eco_decision_pair CHECK((decision_idempotency_key IS NULL AND decision_request_hash IS NULL AND decision_by_user_id IS NULL AND decision_at IS NULL) OR (length(btrim(decision_idempotency_key)) BETWEEN 1 AND 255 AND decision_request_hash ~ '^[0-9a-f]{64}$' AND decision_by_user_id IS NOT NULL AND decision_at IS NOT NULL)),
 CONSTRAINT chk_product_eco_approval_pair CHECK((status='APPROVED' AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND decision_by_user_id=approved_by_user_id) OR (status<>'APPROVED' AND approved_by_user_id IS NULL AND approved_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_product_eco_timeline ON product_engineering_changes(tenant_id,factory_id,product_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS product_eco_order_impacts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, factory_id UUID NOT NULL, product_id UUID NOT NULL,
 eco_id UUID NOT NULL, work_order_id UUID NOT NULL, source_order_id UUID NOT NULL, order_line_id UUID NOT NULL, work_order_number VARCHAR(100) NOT NULL,
 status_at_assessment VARCHAR(24) NOT NULL, work_order_row_version BIGINT NOT NULL, pinned_product_version_id UUID NOT NULL,
 planned_start_date DATE NOT NULL, due_date DATE NOT NULL, target_quantity NUMERIC(18,4) NOT NULL,
 impact_type VARCHAR(40) NOT NULL, order_snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT uq_product_eco_impact UNIQUE(eco_id,work_order_id),
 CONSTRAINT fk_product_eco_impact_eco FOREIGN KEY(eco_id,tenant_id,factory_id,product_id) REFERENCES product_engineering_changes(id,tenant_id,factory_id,product_id) ON DELETE RESTRICT,
 CONSTRAINT fk_product_eco_impact_work_order FOREIGN KEY(work_order_id,tenant_id,factory_id) REFERENCES work_orders(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_product_eco_impact_order_line FOREIGN KEY(order_line_id,source_order_id,tenant_id,factory_id) REFERENCES order_lines(id,order_id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_product_eco_impact_version FOREIGN KEY(pinned_product_version_id,tenant_id,factory_id,product_id) REFERENCES product_versions(id,tenant_id,factory_id,product_id) ON DELETE RESTRICT,
 CONSTRAINT chk_product_eco_impact_type CHECK(impact_type IN('REPLAN_BEFORE_RELEASE','PRESERVE_RELEASED_SNAPSHOT_REVIEW')),
 CONSTRAINT chk_product_eco_impact_values CHECK(target_quantity>0 AND work_order_row_version>0 AND jsonb_typeof(order_snapshot)='object')
);
CREATE INDEX IF NOT EXISTS idx_product_eco_impacts_order ON product_eco_order_impacts(tenant_id,factory_id,work_order_id,eco_id);

CREATE TABLE IF NOT EXISTS product_eco_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, factory_id UUID NOT NULL, product_id UUID NOT NULL,
 eco_id UUID NOT NULL, event_type VARCHAR(40) NOT NULL, actor_user_id UUID NOT NULL,
 idempotency_key VARCHAR(255) NOT NULL, correlation_id UUID NOT NULL, payload JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT fk_product_eco_event_eco FOREIGN KEY(eco_id,tenant_id,factory_id,product_id) REFERENCES product_engineering_changes(id,tenant_id,factory_id,product_id) ON DELETE RESTRICT,
 CONSTRAINT fk_product_eco_event_actor FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT uq_product_eco_event_key UNIQUE(tenant_id,factory_id,eco_id,idempotency_key),
 CONSTRAINT chk_product_eco_event_type CHECK(event_type IN('CREATED','SUBMITTED','APPROVED','REJECTED')),
 CONSTRAINT chk_product_eco_event_payload CHECK(jsonb_typeof(payload)='object')
);

CREATE OR REPLACE FUNCTION factoryos_guard_product_engineering_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'DRAFT' OR NEW.row_version<>1 OR NEW.submitted_at IS NOT NULL OR NEW.decision_at IS NOT NULL OR NEW.approved_at IS NOT NULL THEN RAISE EXCEPTION 'ECO must begin in DRAFT at row version one' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ECO history cannot be deleted' USING ERRCODE='55000'; END IF;
 IF ROW(NEW.id,NEW.tenant_id,NEW.factory_id,NEW.product_id,NEW.eco_number,NEW.source_version_id,NEW.target_version_id,NEW.effective_on,NEW.source_snapshot,NEW.target_snapshot,NEW.revision_diff,NEW.idempotency_key,NEW.request_hash,NEW.created_by_user_id,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.factory_id,OLD.product_id,OLD.eco_number,OLD.source_version_id,OLD.target_version_id,OLD.effective_on,OLD.source_snapshot,OLD.target_snapshot,OLD.revision_diff,OLD.idempotency_key,OLD.request_hash,OLD.created_by_user_id,OLD.created_at)
 THEN RAISE EXCEPTION 'ECO identity and revision snapshots are immutable' USING ERRCODE='55000'; END IF;
 IF NEW.row_version<>OLD.row_version+1 OR NEW.updated_at<=OLD.updated_at THEN RAISE EXCEPTION 'ECO update requires row_version increment' USING ERRCODE='23514'; END IF;
 IF OLD.status='DRAFT' AND NEW.status='SUBMITTED' THEN
  IF NEW.submitted_by_user_id IS NULL OR NEW.submitted_at IS NULL OR NEW.submit_idempotency_key IS NULL OR NEW.submit_request_hash IS NULL OR NEW.updated_by_user_id IS DISTINCT FROM NEW.submitted_by_user_id THEN RAISE EXCEPTION 'ECO submission requires actor, timestamp and idempotency evidence' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status='SUBMITTED' AND NEW.status IN('APPROVED','REJECTED') THEN
  IF NEW.decision_by_user_id IS NULL OR NEW.decision_at IS NULL OR NEW.decision_idempotency_key IS NULL OR NEW.decision_request_hash IS NULL OR NEW.updated_by_user_id IS DISTINCT FROM NEW.decision_by_user_id THEN RAISE EXCEPTION 'ECO decision requires reviewer and idempotency evidence' USING ERRCODE='23514'; END IF;
  IF NEW.status='APPROVED' AND (NEW.approved_by_user_id IS NULL OR NEW.approved_at IS NULL OR NEW.decision_by_user_id=NEW.created_by_user_id OR length(btrim(COALESCE(NEW.decision_note,'')))>0) THEN RAISE EXCEPTION 'Approval requires maker-checker and no rejection note' USING ERRCODE='23514'; END IF;
  IF NEW.status='REJECTED' AND length(btrim(COALESCE(NEW.decision_note,'')))=0 THEN RAISE EXCEPTION 'Rejection requires a reason' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'Invalid ECO lifecycle transition: % -> %',OLD.status,NEW.status USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS trg_product_engineering_change_guard ON product_engineering_changes;
CREATE TRIGGER trg_product_engineering_change_guard BEFORE INSERT OR UPDATE OR DELETE ON product_engineering_changes FOR EACH ROW EXECUTE FUNCTION factoryos_guard_product_engineering_change();

CREATE OR REPLACE FUNCTION factoryos_guard_product_eco_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ECO evidence is append-only' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS trg_product_eco_impact_immutable ON product_eco_order_impacts;
CREATE TRIGGER trg_product_eco_impact_immutable BEFORE UPDATE OR DELETE ON product_eco_order_impacts FOR EACH ROW EXECUTE FUNCTION factoryos_guard_product_eco_evidence();
DROP TRIGGER IF EXISTS trg_product_eco_event_immutable ON product_eco_events;
CREATE TRIGGER trg_product_eco_event_immutable BEFORE UPDATE OR DELETE ON product_eco_events FOR EACH ROW EXECUTE FUNCTION factoryos_guard_product_eco_evidence();

ALTER TABLE product_engineering_changes ENABLE ROW LEVEL SECURITY; ALTER TABLE product_engineering_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_engineering_changes_tenant_isolation ON product_engineering_changes;
CREATE POLICY product_engineering_changes_tenant_isolation ON product_engineering_changes USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());
ALTER TABLE product_eco_order_impacts ENABLE ROW LEVEL SECURITY; ALTER TABLE product_eco_order_impacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_eco_order_impacts_tenant_isolation ON product_eco_order_impacts;
CREATE POLICY product_eco_order_impacts_tenant_isolation ON product_eco_order_impacts USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());
ALTER TABLE product_eco_events ENABLE ROW LEVEL SECURITY; ALTER TABLE product_eco_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_eco_events_tenant_isolation ON product_eco_events;
CREATE POLICY product_eco_events_tenant_isolation ON product_eco_events USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());
INSERT INTO schema_migrations(version,checksum) VALUES('162_product_eco_effective_date_change_orders',NULL) ON CONFLICT(version) DO NOTHING;
COMMIT;