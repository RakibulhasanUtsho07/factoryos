BEGIN;

-- Formal WMS cycle-count work queue. A task captures immutable count scope and
-- due/assignment intent; proposal review remains the stock-changing boundary.
CREATE TABLE IF NOT EXISTS inventory_cycle_count_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  location_id UUID,
  assigned_to_user_id UUID,
  due_at TIMESTAMPTZ NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  status VARCHAR(24) NOT NULL DEFAULT 'SCHEDULED',
  current_proposal_id UUID,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  notes TEXT,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  started_by_user_id UUID,
  started_at TIMESTAMPTZ,
  submitted_by_user_id UUID,
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_by_user_id UUID,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  version BIGINT NOT NULL DEFAULT 1,

  CONSTRAINT uq_inventory_cycle_count_task_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_inventory_cycle_count_task_idempotency
    UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_inventory_cycle_count_task_item_scope
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_task_location_scope
    FOREIGN KEY (location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_task_assignee
    FOREIGN KEY (assigned_to_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_task_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_task_starter
    FOREIGN KEY (started_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_task_submitter
    FOREIGN KEY (submitted_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_task_completer
    FOREIGN KEY (cancelled_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_task_current_proposal
    FOREIGN KEY (current_proposal_id, tenant_id, factory_id)
    REFERENCES inventory_cycle_count_proposals (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_cycle_count_task_priority CHECK (priority BETWEEN 0 AND 10000),
  CONSTRAINT chk_inventory_cycle_count_task_status
    CHECK (status IN ('SCHEDULED', 'IN_PROGRESS', 'AWAITING_REVIEW', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT chk_inventory_cycle_count_task_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_inventory_cycle_count_task_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_inventory_cycle_count_task_version CHECK (version > 0),
  CONSTRAINT chk_inventory_cycle_count_task_state_fields CHECK (
    (status <> 'SCHEDULED' OR
      (started_at IS NULL AND started_by_user_id IS NULL AND current_proposal_id IS NULL))
    AND
    (status NOT IN ('IN_PROGRESS', 'AWAITING_REVIEW', 'COMPLETED')
      OR (started_at IS NOT NULL AND started_by_user_id IS NOT NULL AND assigned_to_user_id IS NOT NULL))
    AND
    (status <> 'AWAITING_REVIEW' OR
      (current_proposal_id IS NOT NULL AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL))
    AND
    (status <> 'COMPLETED' OR
      (current_proposal_id IS NOT NULL AND completed_at IS NOT NULL))
    AND
    (status <> 'CANCELLED' OR
      (cancelled_by_user_id IS NOT NULL AND cancelled_at IS NOT NULL
       AND length(btrim(COALESCE(cancellation_reason, ''))) > 0))
  )
);

CREATE INDEX IF NOT EXISTS idx_inventory_cycle_count_tasks_due
  ON inventory_cycle_count_tasks
  (tenant_id, factory_id, status, due_at, priority, id);
CREATE INDEX IF NOT EXISTS idx_inventory_cycle_count_tasks_assignee
  ON inventory_cycle_count_tasks
  (tenant_id, factory_id, assigned_to_user_id, status, due_at, id);

ALTER TABLE inventory_cycle_count_proposals
  ADD COLUMN IF NOT EXISTS task_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_inventory_cycle_count_proposal_task_scope'
      AND conrelid = 'inventory_cycle_count_proposals'::regclass
  ) THEN
    ALTER TABLE inventory_cycle_count_proposals
      ADD CONSTRAINT fk_inventory_cycle_count_proposal_task_scope
      FOREIGN KEY (task_id, tenant_id, factory_id)
      REFERENCES inventory_cycle_count_tasks (id, tenant_id, factory_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_cycle_count_proposals_task_created
  ON inventory_cycle_count_proposals (tenant_id, factory_id, task_id, created_at DESC)
  WHERE task_id IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_cycle_count_task()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory_cycle_count_tasks are retained as operational evidence'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
    OR NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.location_id IS DISTINCT FROM OLD.location_id
    OR NEW.due_at IS DISTINCT FROM OLD.due_at
    OR NEW.priority IS DISTINCT FROM OLD.priority
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'cycle-count task scheduling facts are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'cycle-count task version must advance exactly once'
      USING ERRCODE = '55000';
  END IF;

  -- Every accepted UPDATE is one explicit lifecycle transition. Prevent
  -- same-state writes from rewriting who started/submitted/cancelled the task.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'cycle-count task updates must advance the lifecycle'
      USING ERRCODE = '55000';
  END IF;

  IF (NEW.started_by_user_id IS DISTINCT FROM OLD.started_by_user_id
      OR NEW.started_at IS DISTINCT FROM OLD.started_at)
    AND NOT (OLD.status = 'SCHEDULED' AND NEW.status = 'IN_PROGRESS')
  THEN
    RAISE EXCEPTION 'cycle-count task start evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF (NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
      OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at)
    AND NOT (OLD.status = 'IN_PROGRESS' AND NEW.status = 'AWAITING_REVIEW')
  THEN
    RAISE EXCEPTION 'cycle-count task submission evidence is immutable outside proposal submission'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.current_proposal_id IS DISTINCT FROM OLD.current_proposal_id
    AND NOT (
      (OLD.status = 'IN_PROGRESS' AND NEW.status = 'AWAITING_REVIEW'
        AND OLD.current_proposal_id IS NULL AND NEW.current_proposal_id IS NOT NULL)
      OR
      (OLD.status = 'AWAITING_REVIEW' AND NEW.status = 'IN_PROGRESS'
        AND OLD.current_proposal_id IS NOT NULL AND NEW.current_proposal_id IS NULL)
    )
  THEN
    RAISE EXCEPTION 'cycle-count task proposal pointer may change only during submit or rejection'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.completed_at IS DISTINCT FROM OLD.completed_at
    AND NOT (OLD.status = 'AWAITING_REVIEW' AND NEW.status = 'COMPLETED')
  THEN
    RAISE EXCEPTION 'cycle-count task completion evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF (NEW.cancelled_by_user_id IS DISTINCT FROM OLD.cancelled_by_user_id
      OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
      OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason)
    AND NOT (OLD.status IN ('SCHEDULED', 'IN_PROGRESS') AND NEW.status = 'CANCELLED')
  THEN
    RAISE EXCEPTION 'cycle-count task cancellation evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.assigned_to_user_id IS DISTINCT FROM OLD.assigned_to_user_id
    AND NOT (
      OLD.status = 'SCHEDULED' AND NEW.status = 'IN_PROGRESS'
      AND OLD.assigned_to_user_id IS NULL AND NEW.assigned_to_user_id IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'cycle-count task assignment is immutable after scheduling'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.assigned_to_user_id IS DISTINCT FROM OLD.assigned_to_user_id
    AND NEW.assigned_to_user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM users u
      JOIN tenant_memberships tm ON tm.user_id = u.id
      WHERE u.id = NEW.assigned_to_user_id AND u.status = 'ACTIVE'
        AND tm.tenant_id = NEW.tenant_id AND tm.status = 'ACTIVE'
    )
  THEN
    RAISE EXCEPTION 'cycle-count task assignee must be an active member of this tenant'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'SCHEDULED' AND NEW.status IN ('IN_PROGRESS', 'CANCELLED'))
    OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('AWAITING_REVIEW', 'CANCELLED'))
    OR (OLD.status = 'AWAITING_REVIEW' AND NEW.status IN ('IN_PROGRESS', 'COMPLETED'))
  ) THEN
    RAISE EXCEPTION 'invalid cycle-count task lifecycle transition'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status IN ('IN_PROGRESS', 'AWAITING_REVIEW', 'COMPLETED')
    AND NEW.assigned_to_user_id IS NULL
  THEN
    RAISE EXCEPTION 'active cycle-count task must have an assigned counter'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'AWAITING_REVIEW' THEN
    IF NEW.current_proposal_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM inventory_cycle_count_proposals p
      WHERE p.id = NEW.current_proposal_id
        AND p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
        AND p.task_id = NEW.id AND p.status = 'PENDING_REVIEW'
    ) THEN
      RAISE EXCEPTION 'awaiting-review task must reference its pending count proposal'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'COMPLETED' THEN
    IF NEW.current_proposal_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM inventory_cycle_count_proposals p
      WHERE p.id = NEW.current_proposal_id
        AND p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
        AND p.task_id = NEW.id AND p.status = 'APPLIED'
    ) THEN
      RAISE EXCEPTION 'completed task must reference an applied count proposal'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'IN_PROGRESS' AND OLD.status = 'AWAITING_REVIEW' THEN
    IF NEW.current_proposal_id IS NOT NULL OR OLD.current_proposal_id IS NULL THEN
      RAISE EXCEPTION 'rejected count task must clear its pending proposal pointer'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_cycle_count_task_guard ON inventory_cycle_count_tasks;
CREATE TRIGGER inventory_cycle_count_task_guard
BEFORE UPDATE OR DELETE ON inventory_cycle_count_tasks
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_cycle_count_task();

CREATE OR REPLACE FUNCTION factoryos_validate_inventory_cycle_count_task_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM inventory_items i
    WHERE i.id = NEW.item_id AND i.tenant_id = NEW.tenant_id
      AND i.factory_id = NEW.factory_id AND i.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'cycle-count task requires an active item in this factory'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM inventory_locations l
    JOIN inventory_locations p
      ON p.id = l.parent_location_id AND p.tenant_id = l.tenant_id
      AND p.factory_id = l.factory_id
    WHERE l.id = NEW.location_id AND l.tenant_id = NEW.tenant_id
      AND l.factory_id = NEW.factory_id
      AND l.location_type = 'BIN' AND l.status = 'ACTIVE'
      AND p.location_type IN ('WAREHOUSE', 'STAGING') AND p.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'cycle-count task location must be an active bin under an active warehouse or staging location'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.assigned_to_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM users u
    JOIN tenant_memberships tm ON tm.user_id = u.id
    WHERE u.id = NEW.assigned_to_user_id AND u.status = 'ACTIVE'
      AND tm.tenant_id = NEW.tenant_id AND tm.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'cycle-count task assignee must be an active member of this tenant'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_cycle_count_task_insert_guard ON inventory_cycle_count_tasks;
CREATE TRIGGER inventory_cycle_count_task_insert_guard
BEFORE INSERT ON inventory_cycle_count_tasks
FOR EACH ROW EXECUTE FUNCTION factoryos_validate_inventory_cycle_count_task_insert();

CREATE OR REPLACE FUNCTION factoryos_validate_inventory_cycle_count_task_proposal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  task_row inventory_cycle_count_tasks%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.task_id IS DISTINCT FROM OLD.task_id THEN
      RAISE EXCEPTION 'cycle-count proposal task binding is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.task_id IS NULL THEN
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
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_cycle_count_task_proposal_guard ON inventory_cycle_count_proposals;
CREATE TRIGGER inventory_cycle_count_task_proposal_guard
BEFORE INSERT OR UPDATE ON inventory_cycle_count_proposals
FOR EACH ROW EXECUTE FUNCTION factoryos_validate_inventory_cycle_count_task_proposal();

ALTER TABLE inventory_cycle_count_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cycle_count_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_cycle_count_tasks_tenant_isolation ON inventory_cycle_count_tasks;
CREATE POLICY inventory_cycle_count_tasks_tenant_isolation
  ON inventory_cycle_count_tasks
  USING (tenant_id = public.factoryos_current_tenant_id())
  WITH CHECK (tenant_id = public.factoryos_current_tenant_id());

INSERT INTO factoryos_governance.tenant_relation_inventory (
  schema_name, relation_name, scope_model, data_category, export_disposition,
  erasure_disposition, audit_requirement, rationale
) VALUES (
  'public', 'inventory_cycle_count_tasks', 'DIRECT_TENANT_ID', 'BUSINESS_DATA',
  'EXCLUDED', 'BLOCKED_UNREVIEWED', 'DOMAIN_LEDGER_OR_AUDIT_REVIEW',
  'Scheduled warehouse counts carry assignment, approval and stock-control provenance.'
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
  'public', 'inventory_cycle_count_tasks', 'DIRECT_TENANT',
  'DIRECT_TENANT_COLUMN_AND_RLS',
  'Cycle-count tasks use a required tenant_id, forced RLS, composite factory scope references and immutable lifecycle guards.',
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
VALUES ('187_inventory_cycle_count_tasks', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
