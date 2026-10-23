BEGIN;

CREATE TABLE IF NOT EXISTS inventory_cycle_count_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  assigned_to_user_id UUID NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  expected_bin_count SMALLINT NOT NULL,
  blind_count BOOLEAN NOT NULL DEFAULT TRUE,
  variance_escalation_threshold NUMERIC(18,4),
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  notes TEXT,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_inventory_cycle_count_session_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_inventory_cycle_count_session_idempotency
    UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_inventory_cycle_count_session_item
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_session_assignee
    FOREIGN KEY (assigned_to_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_session_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_cycle_count_session_priority CHECK (priority BETWEEN 0 AND 10000),
  CONSTRAINT chk_inventory_cycle_count_session_bin_count CHECK (expected_bin_count BETWEEN 2 AND 50),
  CONSTRAINT chk_inventory_cycle_count_session_threshold
    CHECK (variance_escalation_threshold IS NULL OR variance_escalation_threshold > 0),
  CONSTRAINT chk_inventory_cycle_count_session_idempotency
    CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_inventory_cycle_count_session_hash
    CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE inventory_cycle_count_tasks
  ADD COLUMN IF NOT EXISTS session_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_inventory_cycle_count_task_session_scope'
      AND conrelid = 'inventory_cycle_count_tasks'::regclass
  ) THEN
    ALTER TABLE inventory_cycle_count_tasks
      ADD CONSTRAINT fk_inventory_cycle_count_task_session_scope
      FOREIGN KEY (session_id, tenant_id, factory_id)
      REFERENCES inventory_cycle_count_sessions (id, tenant_id, factory_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_cycle_count_session_task_bin
  ON inventory_cycle_count_tasks (tenant_id, factory_id, session_id, location_id)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_cycle_count_sessions_scope_created
  ON inventory_cycle_count_sessions (tenant_id, factory_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_cycle_count_session()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cycle-count session scheduling evidence is immutable and retained'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS inventory_cycle_count_session_immutable_guard ON inventory_cycle_count_sessions;
CREATE TRIGGER inventory_cycle_count_session_immutable_guard
BEFORE UPDATE OR DELETE ON inventory_cycle_count_sessions
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_cycle_count_session();

CREATE OR REPLACE FUNCTION factoryos_validate_inventory_cycle_count_session_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM inventory_items i
    WHERE i.id = NEW.item_id AND i.tenant_id = NEW.tenant_id
      AND i.factory_id = NEW.factory_id AND i.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'cycle-count session requires an active item in this factory'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM users u
    JOIN tenant_memberships tm ON tm.user_id = u.id
    WHERE u.id = NEW.assigned_to_user_id AND u.status = 'ACTIVE'
      AND tm.tenant_id = NEW.tenant_id AND tm.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'cycle-count session assignee must be an active tenant member'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_cycle_count_session_insert_guard ON inventory_cycle_count_sessions;
CREATE TRIGGER inventory_cycle_count_session_insert_guard
BEFORE INSERT ON inventory_cycle_count_sessions
FOR EACH ROW EXECUTE FUNCTION factoryos_validate_inventory_cycle_count_session_insert();

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_cycle_count_session_task()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_row inventory_cycle_count_sessions%ROWTYPE;
  existing_count INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.session_id IS DISTINCT FROM OLD.session_id THEN
      RAISE EXCEPTION 'cycle-count task session binding is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.session_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO session_row
  FROM inventory_cycle_count_sessions s
  WHERE s.id = NEW.session_id
    AND s.tenant_id = NEW.tenant_id
    AND s.factory_id = NEW.factory_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cycle-count task session does not exist in this factory'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.location_id IS NULL
    OR NEW.item_id IS DISTINCT FROM session_row.item_id
    OR NEW.assigned_to_user_id IS DISTINCT FROM session_row.assigned_to_user_id
    OR NEW.due_at IS DISTINCT FROM session_row.due_at
    OR NEW.priority IS DISTINCT FROM session_row.priority
    OR NEW.blind_count IS DISTINCT FROM session_row.blind_count
    OR NEW.variance_escalation_threshold IS DISTINCT FROM session_row.variance_escalation_threshold
    OR NEW.created_by_user_id IS DISTINCT FROM session_row.created_by_user_id
    OR NEW.notes IS DISTINCT FROM session_row.notes
  THEN
    RAISE EXCEPTION 'cycle-count session task must match its immutable session policy and bin scope'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer INTO existing_count
  FROM inventory_cycle_count_tasks t
  WHERE t.session_id = NEW.session_id
    AND t.tenant_id = NEW.tenant_id
    AND t.factory_id = NEW.factory_id;

  IF existing_count >= session_row.expected_bin_count THEN
    RAISE EXCEPTION 'cycle-count session cannot contain more tasks than its scheduled bin count'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_cycle_count_session_task_guard ON inventory_cycle_count_tasks;
CREATE TRIGGER inventory_cycle_count_session_task_guard
BEFORE INSERT OR UPDATE OF session_id ON inventory_cycle_count_tasks
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_cycle_count_session_task();

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_cycle_count_session_task_cancellation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.session_id IS NULL OR NEW.status IS DISTINCT FROM 'CANCELLED' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(current_setting('app.inventory_cycle_count_session_cancel', true), '') <> 'true' THEN
    RAISE EXCEPTION 'session-linked count tasks must be cancelled through their parent session'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_cycle_count_session_task_cancel_guard ON inventory_cycle_count_tasks;
CREATE TRIGGER inventory_cycle_count_session_task_cancel_guard
BEFORE UPDATE OF status ON inventory_cycle_count_tasks
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_cycle_count_session_task_cancellation();

CREATE OR REPLACE FUNCTION factoryos_validate_inventory_cycle_count_session_task_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actual_count INTEGER;
BEGIN
  SELECT count(*)::integer INTO actual_count
  FROM inventory_cycle_count_tasks t
  WHERE t.session_id = NEW.id
    AND t.tenant_id = NEW.tenant_id
    AND t.factory_id = NEW.factory_id;

  IF actual_count <> NEW.expected_bin_count THEN
    RAISE EXCEPTION 'cycle-count session requires exactly its expected number of bin tasks'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_cycle_count_session_task_count_guard ON inventory_cycle_count_sessions;
CREATE CONSTRAINT TRIGGER inventory_cycle_count_session_task_count_guard
AFTER INSERT ON inventory_cycle_count_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_validate_inventory_cycle_count_session_task_count();

ALTER TABLE inventory_cycle_count_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cycle_count_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_cycle_count_sessions_tenant_isolation ON inventory_cycle_count_sessions;
CREATE POLICY inventory_cycle_count_sessions_tenant_isolation
  ON inventory_cycle_count_sessions
  USING (tenant_id = public.factoryos_current_tenant_id())
  WITH CHECK (tenant_id = public.factoryos_current_tenant_id());

INSERT INTO factoryos_governance.tenant_relation_inventory (
  schema_name, relation_name, scope_model, data_category, export_disposition,
  erasure_disposition, audit_requirement, rationale
) VALUES (
  'public', 'inventory_cycle_count_sessions', 'DIRECT_TENANT_ID', 'BUSINESS_DATA',
  'EXCLUDED', 'BLOCKED_UNREVIEWED', 'DOMAIN_LEDGER_OR_AUDIT_REVIEW',
  'Multi-bin cycle-count sessions freeze item, bins, counter, schedule and count policy while child tasks retain per-bin evidence.'
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
  'public', 'inventory_cycle_count_sessions', 'DIRECT_TENANT',
  'DIRECT_TENANT_COLUMN_AND_RLS',
  'Sessions use direct tenant scope, forced RLS, composite factory-scoped item/task foreign keys, immutable parent evidence and a deferred exact-child-count guard.',
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
VALUES ('189_inventory_cycle_count_sessions', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
