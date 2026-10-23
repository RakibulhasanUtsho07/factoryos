BEGIN;

-- Blind count defaults off for historical tasks. New API-created tasks opt into
-- blind counting by default and persist the policy at both task and proposal.
ALTER TABLE inventory_cycle_count_tasks
  ADD COLUMN IF NOT EXISTS blind_count BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS variance_escalation_threshold NUMERIC(18,4);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_cycle_count_task_variance_threshold'
      AND conrelid = 'inventory_cycle_count_tasks'::regclass
  ) THEN
    ALTER TABLE inventory_cycle_count_tasks
      ADD CONSTRAINT chk_inventory_cycle_count_task_variance_threshold
      CHECK (variance_escalation_threshold IS NULL OR variance_escalation_threshold > 0);
  END IF;
END $$;

ALTER TABLE inventory_cycle_count_proposals
  ADD COLUMN IF NOT EXISTS blind_count_snapshot BOOLEAN NOT NULL DEFAULT FALSE;

-- A variance escalation is immutable evidence of a count exceeding the policy
-- threshold. Approval/rejection is blocked until a different reviewer resolves it.
CREATE TABLE IF NOT EXISTS inventory_cycle_count_variance_escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  task_id UUID NOT NULL,
  proposal_id UUID NOT NULL,
  item_id UUID NOT NULL,
  expected_quantity NUMERIC(18,4) NOT NULL,
  counted_quantity NUMERIC(18,4) NOT NULL,
  variance_quantity NUMERIC(18,4) NOT NULL,
  threshold_quantity NUMERIC(18,4) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  resolved_by_user_id UUID,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  resolution_idempotency_key VARCHAR(255),
  resolution_request_hash VARCHAR(64),
  version BIGINT NOT NULL DEFAULT 1,

  CONSTRAINT uq_inventory_cycle_count_variance_escalation_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_inventory_cycle_count_variance_escalation_proposal
    UNIQUE (tenant_id, factory_id, proposal_id),
  CONSTRAINT uq_inventory_cycle_count_variance_escalation_resolution_key
    UNIQUE (tenant_id, factory_id, resolution_idempotency_key),
  CONSTRAINT fk_inventory_cycle_count_variance_escalation_task
    FOREIGN KEY (task_id, tenant_id, factory_id)
    REFERENCES inventory_cycle_count_tasks (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_variance_escalation_proposal
    FOREIGN KEY (proposal_id, tenant_id, factory_id)
    REFERENCES inventory_cycle_count_proposals (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_variance_escalation_item
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_variance_escalation_reviewer
    FOREIGN KEY (resolved_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_cycle_count_variance_escalation_quantities
    CHECK (
      expected_quantity >= 0
      AND counted_quantity >= 0
      AND threshold_quantity > 0
      AND variance_quantity = counted_quantity - expected_quantity
      AND abs(variance_quantity) >= threshold_quantity
    ),
  CONSTRAINT chk_inventory_cycle_count_variance_escalation_status
    CHECK (status IN ('OPEN', 'RESOLVED')),
  CONSTRAINT chk_inventory_cycle_count_variance_escalation_version
    CHECK (version > 0),
  CONSTRAINT chk_inventory_cycle_count_variance_escalation_resolution
    CHECK (
      (status = 'OPEN'
        AND resolved_by_user_id IS NULL AND resolved_at IS NULL
        AND resolution_note IS NULL AND resolution_idempotency_key IS NULL
        AND resolution_request_hash IS NULL AND version = 1)
      OR
      (status = 'RESOLVED'
        AND resolved_by_user_id IS NOT NULL AND resolved_at IS NOT NULL
        AND length(btrim(COALESCE(resolution_note, ''))) BETWEEN 1 AND 1000
        AND length(btrim(COALESCE(resolution_idempotency_key, ''))) BETWEEN 1 AND 255
        AND resolution_request_hash ~ '^[0-9a-f]{64}$' AND version = 2)
    )
);

CREATE INDEX IF NOT EXISTS idx_inventory_cycle_count_variance_escalation_open
  ON inventory_cycle_count_variance_escalations
  (tenant_id, factory_id, status, detected_at, id);

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_cycle_count_task_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.blind_count IS DISTINCT FROM OLD.blind_count
    OR NEW.variance_escalation_threshold IS DISTINCT FROM OLD.variance_escalation_threshold
  THEN
    RAISE EXCEPTION 'cycle-count blind-count and variance escalation policies are immutable after scheduling'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_cycle_count_task_policy_guard ON inventory_cycle_count_tasks;
CREATE TRIGGER inventory_cycle_count_task_policy_guard
BEFORE UPDATE ON inventory_cycle_count_tasks
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_cycle_count_task_policy();

-- Freeze whether the physical counter was blinded at submission time. Historical
-- proposals and non-task proposals retain FALSE.
CREATE OR REPLACE FUNCTION factoryos_validate_inventory_cycle_count_task_proposal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  task_row inventory_cycle_count_tasks%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.task_id IS DISTINCT FROM OLD.task_id
      OR NEW.blind_count_snapshot IS DISTINCT FROM OLD.blind_count_snapshot
    THEN
      RAISE EXCEPTION 'cycle-count proposal task binding and blind-count snapshot are immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.task_id IS NULL THEN
    NEW.blind_count_snapshot := FALSE;
    RETURN NEW;
  END IF;

  SELECT * INTO task_row
  FROM inventory_cycle_count_tasks t
  WHERE t.id = NEW.task_id AND t.tenant_id = NEW.tenant_id AND t.factory_id = NEW.factory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cycle-count task does not exist in this factory'
      USING ERRCODE = '23503';
  END IF;
  IF task_row.status <> 'IN_PROGRESS'
    OR task_row.item_id <> NEW.item_id
    OR task_row.location_id IS DISTINCT FROM NEW.location_id
    OR task_row.assigned_to_user_id IS DISTINCT FROM NEW.created_by_user_id
  THEN
    RAISE EXCEPTION 'cycle-count proposal does not match the active assigned task'
      USING ERRCODE = '23514';
  END IF;

  NEW.blind_count_snapshot := task_row.blind_count;
  RETURN NEW;
END;
$$;

-- Ensure a count with a material variance cannot be applied or rejected directly
-- from the proposal endpoint before independent escalation resolution.
CREATE OR REPLACE FUNCTION factoryos_guard_cycle_count_variance_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  escalation_row inventory_cycle_count_variance_escalations%ROWTYPE;
BEGIN
  IF NEW.status NOT IN ('APPLIED', 'REJECTED')
    OR NEW.status IS NOT DISTINCT FROM OLD.status
    OR NEW.task_id IS NULL
  THEN
    RETURN NEW;
  END IF;

  SELECT * INTO escalation_row
  FROM inventory_cycle_count_variance_escalations e
  WHERE e.tenant_id = NEW.tenant_id
    AND e.factory_id = NEW.factory_id
    AND e.proposal_id = NEW.id;

  IF FOUND THEN
    IF escalation_row.status <> 'RESOLVED' THEN
      RAISE EXCEPTION 'cycle-count variance escalation must be resolved before approval or rejection'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.reviewed_by_user_id IS NULL
      OR escalation_row.resolved_by_user_id = NEW.reviewed_by_user_id
    THEN
      RAISE EXCEPTION 'a different reviewer must decide the escalated cycle count'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_cycle_count_variance_decision_guard ON inventory_cycle_count_proposals;
CREATE TRIGGER inventory_cycle_count_variance_decision_guard
BEFORE UPDATE OF status ON inventory_cycle_count_proposals
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_cycle_count_variance_decision();

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_cycle_count_variance_escalation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  task_row inventory_cycle_count_tasks%ROWTYPE;
  proposal_row inventory_cycle_count_proposals%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cycle-count variance escalations are retained as operational evidence'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
      OR NEW.task_id IS DISTINCT FROM OLD.task_id
      OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
      OR NEW.item_id IS DISTINCT FROM OLD.item_id
      OR NEW.expected_quantity IS DISTINCT FROM OLD.expected_quantity
      OR NEW.counted_quantity IS DISTINCT FROM OLD.counted_quantity
      OR NEW.variance_quantity IS DISTINCT FROM OLD.variance_quantity
      OR NEW.threshold_quantity IS DISTINCT FROM OLD.threshold_quantity
      OR NEW.detected_at IS DISTINCT FROM OLD.detected_at
    THEN
      RAISE EXCEPTION 'cycle-count variance escalation evidence is immutable'
        USING ERRCODE = '55000';
    END IF;

    IF OLD.status <> 'OPEN' OR NEW.status <> 'RESOLVED'
      OR NEW.version <> OLD.version + 1
      OR NEW.resolved_by_user_id IS NULL
      OR NEW.resolved_at IS NULL
      OR length(btrim(COALESCE(NEW.resolution_note, ''))) NOT BETWEEN 1 AND 1000
      OR length(btrim(COALESCE(NEW.resolution_idempotency_key, ''))) NOT BETWEEN 1 AND 255
      OR NEW.resolution_request_hash !~ '^[0-9a-f]{64}$'
    THEN
      RAISE EXCEPTION 'invalid cycle-count variance escalation resolution transition'
        USING ERRCODE = '23514';
    END IF;

    SELECT * INTO proposal_row
    FROM inventory_cycle_count_proposals p
    WHERE p.id = OLD.proposal_id AND p.tenant_id = OLD.tenant_id
      AND p.factory_id = OLD.factory_id;
    IF NOT FOUND OR proposal_row.status <> 'PENDING_REVIEW'
      OR proposal_row.created_by_user_id = NEW.resolved_by_user_id
    THEN
      RAISE EXCEPTION 'variance escalation must be resolved by a reviewer other than the counter while review is pending'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO task_row
  FROM inventory_cycle_count_tasks t
  WHERE t.id = NEW.task_id AND t.tenant_id = NEW.tenant_id AND t.factory_id = NEW.factory_id;
  SELECT * INTO proposal_row
  FROM inventory_cycle_count_proposals p
  WHERE p.id = NEW.proposal_id AND p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id;

  IF NOT FOUND
    OR task_row.status <> 'AWAITING_REVIEW'
    OR task_row.current_proposal_id IS DISTINCT FROM NEW.proposal_id
    OR task_row.item_id <> NEW.item_id
    OR task_row.variance_escalation_threshold IS NULL
    OR NEW.threshold_quantity <> task_row.variance_escalation_threshold
    OR proposal_row.task_id IS DISTINCT FROM task_row.id
    OR proposal_row.status <> 'PENDING_REVIEW'
    OR proposal_row.counted_quantity <> NEW.counted_quantity
    OR (CASE WHEN proposal_row.location_id IS NULL
        THEN proposal_row.ledger_quantity_at_count
        ELSE proposal_row.location_quantity_at_count END) <> NEW.expected_quantity
    OR proposal_row.created_by_user_id <> task_row.assigned_to_user_id
  THEN
    RAISE EXCEPTION 'variance escalation does not match its pending task-linked count and configured threshold'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_cycle_count_variance_escalation_guard ON inventory_cycle_count_variance_escalations;
CREATE TRIGGER inventory_cycle_count_variance_escalation_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory_cycle_count_variance_escalations
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_cycle_count_variance_escalation();

ALTER TABLE inventory_cycle_count_variance_escalations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cycle_count_variance_escalations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_cycle_count_variance_escalations_tenant_isolation
  ON inventory_cycle_count_variance_escalations;
CREATE POLICY inventory_cycle_count_variance_escalations_tenant_isolation
  ON inventory_cycle_count_variance_escalations
  USING (tenant_id = public.factoryos_current_tenant_id())
  WITH CHECK (tenant_id = public.factoryos_current_tenant_id());

INSERT INTO factoryos_governance.tenant_relation_inventory (
  schema_name, relation_name, scope_model, data_category, export_disposition,
  erasure_disposition, audit_requirement, rationale
) VALUES (
  'public', 'inventory_cycle_count_variance_escalations', 'DIRECT_TENANT_ID', 'BUSINESS_DATA',
  'EXCLUDED', 'BLOCKED_UNREVIEWED', 'DOMAIN_LEDGER_OR_AUDIT_REVIEW',
  'Immutable variance escalation evidence binds a count, policy threshold, independent reviewer and stock decision.'
)
ON CONFLICT (schema_name, relation_name) DO UPDATE SET
  scope_model = EXCLUDED.scope_model,
  data_category = EXCLUDED.data_category,
  export_disposition = EXCLUDED.export_disposition,
  erasure_disposition = EXCLUDED.erasure_disposition,
  audit_requirement = EXCLUDED.audit_requirement,
  rationale = EXCLUDED.rationale,
  classified_at = clock_timestamp();

INSERT INTO factoryos_governance.tenant_relation_ownership_reviews (
  schema_name, relation_name, ownership_class, evidence_type, evidence_detail,
  scope_predicate, export_disposition, erasure_disposition, review_status
) VALUES (
  'public', 'inventory_cycle_count_variance_escalations', 'DIRECT_TENANT',
  'DIRECT_TENANT_COLUMN_AND_RLS',
  'Variance escalations carry tenant/factory scoped task and proposal FKs, forced tenant RLS and immutable resolution evidence.',
  'tenant_id = public.factoryos_current_tenant_id()',
  'EXCLUDED', 'BLOCKED_UNREVIEWED', 'VERIFIED'
)
ON CONFLICT (schema_name, relation_name) DO UPDATE SET
  ownership_class = EXCLUDED.ownership_class,
  evidence_type = EXCLUDED.evidence_type,
  evidence_detail = EXCLUDED.evidence_detail,
  scope_predicate = EXCLUDED.scope_predicate,
  export_disposition = EXCLUDED.export_disposition,
  erasure_disposition = EXCLUDED.erasure_disposition,
  review_status = EXCLUDED.review_status,
  reviewed_at = clock_timestamp();

INSERT INTO schema_migrations(version, checksum)
VALUES ('188_inventory_blind_count_variance_escalation', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
