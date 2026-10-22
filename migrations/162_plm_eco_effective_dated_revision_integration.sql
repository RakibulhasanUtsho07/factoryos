BEGIN;

-- PLM/ECO: effective-dated revision changes, checker approval, affected-order snapshots,
-- and DB-level guards against changing submitted engineering inputs or rewriting WIP snapshots.
INSERT INTO permissions (code, description)
VALUES
  ('products.eco.read', 'Read engineering change orders, revision comparisons and affected work orders'),
  ('products.eco.write', 'Create and submit engineering change orders for draft product revisions'),
  ('products.eco.approve', 'Approve or reject submitted engineering changes with maker-checker controls')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('products.eco.read', 'products.eco.write', 'products.eco.approve')
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS product_change_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  product_id UUID NOT NULL,
  source_product_version_id UUID,
  proposed_product_version_id UUID NOT NULL,
  title VARCHAR(160) NOT NULL,
  rationale TEXT NOT NULL,
  effective_date DATE NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  row_version BIGINT NOT NULL DEFAULT 1,
  diff_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  affected_order_count INTEGER NOT NULL DEFAULT 0,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  submit_idempotency_key VARCHAR(255),
  submit_request_hash CHAR(64),
  approval_idempotency_key VARCHAR(255),
  approval_request_hash CHAR(64),
  resolution_idempotency_key VARCHAR(255),
  resolution_request_hash CHAR(64),
  created_by_user_id UUID NOT NULL,
  submitted_by_user_id UUID,
  reviewer_user_id UUID,
  reviewed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  review_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_product_change_order_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_product_change_order_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_product_change_order_product
    FOREIGN KEY (product_id, tenant_id, factory_id)
    REFERENCES product_definitions (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_change_order_source_revision
    FOREIGN KEY (source_product_version_id, tenant_id, factory_id, product_id)
    REFERENCES product_versions (id, tenant_id, factory_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_change_order_proposed_revision
    FOREIGN KEY (proposed_product_version_id, tenant_id, factory_id, product_id)
    REFERENCES product_versions (id, tenant_id, factory_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_change_order_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_change_order_submitter
    FOREIGN KEY (submitted_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_change_order_reviewer
    FOREIGN KEY (reviewer_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_product_change_order_title CHECK (length(btrim(title)) BETWEEN 3 AND 160),
  CONSTRAINT chk_product_change_order_rationale CHECK (length(btrim(rationale)) BETWEEN 10 AND 4000),
  CONSTRAINT chk_product_change_order_status CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED')),
  CONSTRAINT chk_product_change_order_row_version CHECK (row_version > 0),
  CONSTRAINT chk_product_change_order_diff CHECK (jsonb_typeof(diff_snapshot) = 'object'),
  CONSTRAINT chk_product_change_order_affected_count CHECK (affected_order_count >= 0),
  CONSTRAINT chk_product_change_order_idempotency CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_product_change_order_request_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_product_change_order_submit_key_pair CHECK (
    (submit_idempotency_key IS NULL AND submit_request_hash IS NULL)
    OR (length(btrim(submit_idempotency_key)) > 0 AND submit_request_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT chk_product_change_order_approval_key_pair CHECK (
    (approval_idempotency_key IS NULL AND approval_request_hash IS NULL)
    OR (length(btrim(approval_idempotency_key)) > 0 AND approval_request_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT chk_product_change_order_resolution_key_pair CHECK (
    (resolution_idempotency_key IS NULL AND resolution_request_hash IS NULL)
    OR (length(btrim(resolution_idempotency_key)) > 0 AND resolution_request_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT chk_product_change_order_lifecycle_evidence CHECK (
    (status = 'DRAFT' AND submitted_by_user_id IS NULL AND submitted_at IS NULL AND reviewer_user_id IS NULL AND reviewed_at IS NULL)
    OR (status = 'SUBMITTED' AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL AND reviewer_user_id IS NULL AND reviewed_at IS NULL)
    OR (status IN ('APPROVED', 'REJECTED') AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL
        AND reviewer_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_change_order_active_proposed_revision
  ON product_change_orders (tenant_id, factory_id, proposed_product_version_id)
  WHERE status IN ('DRAFT', 'SUBMITTED', 'APPROVED');
CREATE INDEX IF NOT EXISTS idx_product_change_order_product_history
  ON product_change_orders (tenant_id, factory_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_change_order_review_queue
  ON product_change_orders (tenant_id, factory_id, status, effective_date, created_at);

CREATE TABLE IF NOT EXISTS product_change_order_affected_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  change_order_id UUID NOT NULL,
  work_order_id UUID NOT NULL,
  pinned_product_version_id UUID NOT NULL,
  status_at_snapshot VARCHAR(24) NOT NULL,
  planned_start_date DATE NOT NULL,
  due_date DATE NOT NULL,
  impact_type VARCHAR(48) NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_product_change_order_affected_work_order UNIQUE (change_order_id, work_order_id),
  CONSTRAINT fk_product_change_order_affected_order
    FOREIGN KEY (change_order_id, tenant_id, factory_id)
    REFERENCES product_change_orders (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_change_order_affected_work_order
    FOREIGN KEY (work_order_id, tenant_id, factory_id)
    REFERENCES work_orders (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_change_order_affected_revision
    FOREIGN KEY (pinned_product_version_id, tenant_id, factory_id)
    REFERENCES product_versions (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_product_change_order_affected_status CHECK (
    status_at_snapshot IN ('DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD')
  ),
  CONSTRAINT chk_product_change_order_impact_type CHECK (
    impact_type IN ('REVISION_REVIEW_BEFORE_START', 'SNAPSHOT_CROSSES_EFFECTIVE_DATE')
  ),
  CONSTRAINT chk_product_change_order_order_dates CHECK (due_date >= planned_start_date)
);
CREATE INDEX IF NOT EXISTS idx_product_change_order_affected_history
  ON product_change_order_affected_orders (tenant_id, factory_id, change_order_id, planned_start_date, work_order_id);

CREATE TABLE IF NOT EXISTS product_change_order_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  change_order_id UUID NOT NULL,
  event_type VARCHAR(16) NOT NULL,
  from_status VARCHAR(16),
  to_status VARCHAR(16) NOT NULL,
  actor_user_id UUID NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_product_change_order_event_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_product_change_order_event_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_product_change_order_event_order
    FOREIGN KEY (change_order_id, tenant_id, factory_id)
    REFERENCES product_change_orders (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_change_order_event_actor
    FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_product_change_order_event_type CHECK (event_type IN ('CREATED', 'SUBMITTED', 'APPROVED', 'REJECTED')),
  CONSTRAINT chk_product_change_order_event_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_product_change_order_event_payload CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_product_change_order_event_history
  ON product_change_order_events (tenant_id, factory_id, change_order_id, created_at, id);

ALTER TABLE product_change_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_change_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_change_orders_tenant_isolation ON product_change_orders;
CREATE POLICY product_change_orders_tenant_isolation ON product_change_orders
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE product_change_order_affected_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_change_order_affected_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_change_order_affected_orders_tenant_isolation ON product_change_order_affected_orders;
CREATE POLICY product_change_order_affected_orders_tenant_isolation ON product_change_order_affected_orders
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE product_change_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_change_order_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_change_order_events_tenant_isolation ON product_change_order_events;
CREATE POLICY product_change_order_events_tenant_isolation ON product_change_order_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_product_change_order_lifecycle()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'engineering change orders are retained as lifecycle evidence';
  END IF;

  IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.product_id, NEW.source_product_version_id,
         NEW.proposed_product_version_id, NEW.title, NEW.rationale, NEW.effective_date,
         NEW.idempotency_key, NEW.request_hash, NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.product_id, OLD.source_product_version_id,
         OLD.proposed_product_version_id, OLD.title, OLD.rationale, OLD.effective_date,
         OLD.idempotency_key, OLD.request_hash, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'engineering change identity and submitted engineering intent are immutable';
  END IF;

  IF OLD.status IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'resolved engineering change orders are immutable';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'engineering change order row_version must increment exactly once';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('DRAFT', 'SUBMITTED') THEN
    RAISE EXCEPTION 'engineering change order must be submitted before review';
  END IF;
  IF OLD.status = 'SUBMITTED' AND NEW.status NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'submitted engineering change order may only be approved or rejected';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_product_change_order_lifecycle ON product_change_orders;
CREATE TRIGGER trg_product_change_order_lifecycle
BEFORE UPDATE OR DELETE ON product_change_orders
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_product_change_order_lifecycle();

CREATE OR REPLACE FUNCTION factoryos_guard_product_change_order_event_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'engineering change order history is append-only';
END;
$$;
DROP TRIGGER IF EXISTS trg_product_change_order_events_immutable ON product_change_order_events;
CREATE TRIGGER trg_product_change_order_events_immutable
BEFORE UPDATE OR DELETE ON product_change_order_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_product_change_order_event_immutable();

CREATE OR REPLACE FUNCTION factoryos_guard_submitted_product_revision_inputs()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_product_version_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_product_version_id := OLD.product_version_id;
  ELSE
    v_product_version_id := NEW.product_version_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM product_change_orders co
    WHERE co.proposed_product_version_id = v_product_version_id AND co.status = 'SUBMITTED'
      AND co.tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
      AND co.factory_id = COALESCE(NEW.factory_id, OLD.factory_id)
  ) THEN
    RAISE EXCEPTION 'submitted ECO revision inputs are frozen; reject the ECO before changing its BOM, alternates, or routing';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_change_order_freezes_bom ON product_bom_lines;
CREATE TRIGGER trg_product_change_order_freezes_bom
BEFORE INSERT OR UPDATE OR DELETE ON product_bom_lines
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_submitted_product_revision_inputs();
DROP TRIGGER IF EXISTS trg_product_change_order_freezes_alternates ON product_bom_alternates;
CREATE TRIGGER trg_product_change_order_freezes_alternates
BEFORE INSERT OR UPDATE OR DELETE ON product_bom_alternates
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_submitted_product_revision_inputs();
DROP TRIGGER IF EXISTS trg_product_change_order_freezes_routing ON product_routing_steps;
CREATE TRIGGER trg_product_change_order_freezes_routing
BEFORE INSERT OR UPDATE OR DELETE ON product_routing_steps
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_submitted_product_revision_inputs();

CREATE OR REPLACE FUNCTION factoryos_guard_submitted_product_revision_metadata()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.effective_from, NEW.effective_to, NEW.expected_yield_percent, NEW.change_summary)
     IS DISTINCT FROM
     ROW(OLD.effective_from, OLD.effective_to, OLD.expected_yield_percent, OLD.change_summary)
     AND EXISTS (
       SELECT 1 FROM product_change_orders co
       WHERE co.proposed_product_version_id = OLD.id
         AND co.tenant_id = OLD.tenant_id AND co.factory_id = OLD.factory_id
         AND co.status = 'SUBMITTED'
     ) THEN
    RAISE EXCEPTION 'submitted ECO revision dates and specification are frozen; reject the ECO before editing';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_product_change_order_freezes_version_metadata ON product_versions;
CREATE TRIGGER trg_product_change_order_freezes_version_metadata
BEFORE UPDATE OF effective_from, effective_to, expected_yield_percent, change_summary ON product_versions
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_submitted_product_revision_metadata();

CREATE OR REPLACE FUNCTION factoryos_require_eco_for_submitted_revision_release()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_eco_id UUID;
BEGIN
  IF OLD.state = 'DRAFT' AND NEW.state = 'APPROVED' THEN
    BEGIN
      v_eco_id := NULLIF(current_setting('app.product_change_order_id', TRUE), '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_eco_id := NULL;
    END;
    IF EXISTS (
      SELECT 1 FROM product_change_orders co
      WHERE co.proposed_product_version_id = NEW.id
        AND co.status = 'SUBMITTED'
        AND co.tenant_id = NEW.tenant_id AND co.factory_id = NEW.factory_id
        AND co.id IS DISTINCT FROM v_eco_id
    ) THEN
      RAISE EXCEPTION 'product revision is under submitted ECO review; approve or reject the ECO instead of bypassing its checker';
    END IF;
    IF v_eco_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM product_change_orders co
      WHERE co.id = v_eco_id AND co.proposed_product_version_id = NEW.id
        AND co.status = 'SUBMITTED'
        AND co.tenant_id = NEW.tenant_id AND co.factory_id = NEW.factory_id
    ) THEN
      RAISE EXCEPTION 'ECO release context does not match a submitted engineering change order';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_product_version_eco_release_gate ON product_versions;
CREATE TRIGGER trg_product_version_eco_release_gate
BEFORE UPDATE OF state ON product_versions
FOR EACH ROW EXECUTE FUNCTION factoryos_require_eco_for_submitted_revision_release();

CREATE OR REPLACE FUNCTION factoryos_guard_work_order_effective_product_revision()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_state TEXT;
  v_effective_from DATE;
  v_effective_to DATE;
BEGIN
  -- Serialize creation/planning with revision release; then re-check the final
  -- effective interval after any concurrent ECO has closed the old revision.
  PERFORM 1 FROM product_definitions p
   WHERE p.id = NEW.product_id AND p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work order product definition is missing from the authorized factory';
  END IF;

  SELECT state, effective_from, COALESCE(effective_to_override, effective_to)
    INTO v_state, v_effective_from, v_effective_to
  FROM product_versions
  WHERE id = NEW.product_version_id AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id AND product_id = NEW.product_id;
  IF NOT FOUND OR v_state NOT IN ('APPROVED', 'RETIRED')
     OR v_effective_from > NEW.planned_start_date
     OR (v_effective_to IS NOT NULL AND v_effective_to < NEW.planned_start_date) THEN
    RAISE EXCEPTION 'work order product revision is not effective on planned_start_date; resolve the ECO or select the correct released revision';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_work_order_effective_product_revision ON work_orders;
CREATE TRIGGER trg_work_order_effective_product_revision
BEFORE INSERT OR UPDATE OF product_id, product_version_id, planned_start_date ON work_orders
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_work_order_effective_product_revision();

COMMENT ON TABLE product_change_orders IS
  'Maker-checker ECO lifecycle for immutable effective-dated product revisions; revision comparison and impact order list are snapshotted on submission/release.';
COMMENT ON TABLE product_change_order_affected_orders IS
  'Affected open production work orders pinned to their original revision; ECO evidence never rewrites order snapshots.';
COMMENT ON TABLE product_change_order_events IS
  'Append-only created/submitted/approved/rejected engineering-change history and idempotency evidence.';

INSERT INTO schema_migrations (version)
VALUES ('162_plm_eco_effective_dated_revision_integration')
ON CONFLICT (version) DO NOTHING;

COMMIT;
