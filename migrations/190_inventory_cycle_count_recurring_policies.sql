BEGIN;

CREATE TABLE IF NOT EXISTS inventory_cycle_count_recurring_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  location_id UUID,
  assigned_to_user_id UUID NOT NULL,
  cadence_unit VARCHAR(8) NOT NULL,
  cadence_interval SMALLINT NOT NULL DEFAULT 1,
  anchor_at TIMESTAMPTZ NOT NULL,
  next_occurrence_number BIGINT NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  priority INTEGER NOT NULL DEFAULT 100,
  blind_count BOOLEAN NOT NULL DEFAULT TRUE,
  variance_escalation_threshold NUMERIC(18,4),
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  notes TEXT,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 1,

  CONSTRAINT uq_inventory_cycle_count_recurring_policy_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_inventory_cycle_count_recurring_policy_idempotency
    UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_inventory_cycle_count_recurring_policy_item
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_recurring_policy_location
    FOREIGN KEY (location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_recurring_policy_assignee
    FOREIGN KEY (assigned_to_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_recurring_policy_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_cycle_count_recurring_policy_cadence
    CHECK (cadence_unit IN ('DAILY', 'WEEKLY', 'MONTHLY')),
  CONSTRAINT chk_inventory_cycle_count_recurring_policy_interval
    CHECK (
      (cadence_unit = 'DAILY' AND cadence_interval BETWEEN 1 AND 365)
      OR (cadence_unit = 'WEEKLY' AND cadence_interval BETWEEN 1 AND 52)
      OR (cadence_unit = 'MONTHLY' AND cadence_interval BETWEEN 1 AND 24)
    ),
  CONSTRAINT chk_inventory_cycle_count_recurring_policy_occurrence_number
    CHECK (next_occurrence_number BETWEEN 0 AND 100000),
  CONSTRAINT chk_inventory_cycle_count_recurring_policy_priority
    CHECK (priority BETWEEN 0 AND 10000),
  CONSTRAINT chk_inventory_cycle_count_recurring_policy_threshold
    CHECK (variance_escalation_threshold IS NULL OR variance_escalation_threshold > 0),
  CONSTRAINT chk_inventory_cycle_count_recurring_policy_status
    CHECK (status IN ('ACTIVE', 'PAUSED', 'RETIRED')),
  CONSTRAINT chk_inventory_cycle_count_recurring_policy_key
    CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_inventory_cycle_count_recurring_policy_hash
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_inventory_cycle_count_recurring_policy_version
    CHECK (version > 0),
  CONSTRAINT chk_inventory_cycle_count_recurring_policy_cursor
    CHECK (
      (next_occurrence_number = 0 AND last_run_at IS NULL)
      OR (next_occurrence_number > 0 AND last_run_at IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS inventory_cycle_count_recurring_policy_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  policy_id UUID NOT NULL,
  task_id UUID NOT NULL,
  occurrence_number BIGINT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  materialized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  request_hash VARCHAR(64) NOT NULL,

  CONSTRAINT uq_inventory_cycle_count_recurring_occurrence_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_inventory_cycle_count_recurring_occurrence_number
    UNIQUE (tenant_id, factory_id, policy_id, occurrence_number),
  CONSTRAINT uq_inventory_cycle_count_recurring_occurrence_task
    UNIQUE (tenant_id, factory_id, task_id),
  CONSTRAINT fk_inventory_cycle_count_recurring_occurrence_policy
    FOREIGN KEY (policy_id, tenant_id, factory_id)
    REFERENCES inventory_cycle_count_recurring_policies (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_recurring_occurrence_task
    FOREIGN KEY (task_id, tenant_id, factory_id)
    REFERENCES inventory_cycle_count_tasks (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_cycle_count_recurring_occurrence_number
    CHECK (occurrence_number BETWEEN 0 AND 100000),
  CONSTRAINT chk_inventory_cycle_count_recurring_occurrence_hash
    CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS inventory_cycle_count_recurring_policy_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  policy_id UUID NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  actor_user_id UUID,
  occurrence_number BIGINT,
  occurrence_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_inventory_cycle_count_recurring_policy_event_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_inventory_cycle_count_recurring_policy_event_policy
    FOREIGN KEY (policy_id, tenant_id, factory_id)
    REFERENCES inventory_cycle_count_recurring_policies (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_recurring_policy_event_actor
    FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_cycle_count_recurring_policy_event_type
    CHECK (event_type IN ('CREATED', 'PAUSED', 'RESUMED', 'RETIRED', 'OCCURRENCE_MATERIALIZED')),
  CONSTRAINT chk_inventory_cycle_count_recurring_policy_event_occurrence
    CHECK (
      (event_type = 'OCCURRENCE_MATERIALIZED'
        AND occurrence_number IS NOT NULL AND occurrence_number BETWEEN 0 AND 100000
        AND occurrence_at IS NOT NULL)
      OR
      (event_type <> 'OCCURRENCE_MATERIALIZED'
        AND occurrence_number IS NULL AND occurrence_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_inventory_cycle_count_recurring_policy_due
  ON inventory_cycle_count_recurring_policies
  (tenant_id, factory_id, status, next_run_at, id);
CREATE INDEX IF NOT EXISTS idx_inventory_cycle_count_recurring_occurrence_history
  ON inventory_cycle_count_recurring_policy_occurrences
  (tenant_id, factory_id, policy_id, scheduled_for DESC, id);
CREATE INDEX IF NOT EXISTS idx_inventory_cycle_count_recurring_policy_events
  ON inventory_cycle_count_recurring_policy_events
  (tenant_id, factory_id, policy_id, occurred_at DESC, id);

CREATE OR REPLACE FUNCTION factoryos_cycle_count_recurring_expected_run(
  p_anchor_at TIMESTAMPTZ,
  p_cadence_unit VARCHAR,
  p_cadence_interval SMALLINT,
  p_occurrence_number BIGINT
)
RETURNS TIMESTAMPTZ
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT (
    (p_anchor_at AT TIME ZONE 'UTC') + CASE p_cadence_unit
      WHEN 'DAILY' THEN make_interval(days => (p_cadence_interval::BIGINT * p_occurrence_number)::INTEGER)
      WHEN 'WEEKLY' THEN make_interval(days => (7::BIGINT * p_cadence_interval * p_occurrence_number)::INTEGER)
      WHEN 'MONTHLY' THEN make_interval(months => (p_cadence_interval::BIGINT * p_occurrence_number)::INTEGER)
    END
  ) AT TIME ZONE 'UTC'
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_cycle_count_recurring_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_next_run TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'recurring cycle-count policies are retained as operational evidence'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
    OR NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.location_id IS DISTINCT FROM OLD.location_id
    OR NEW.assigned_to_user_id IS DISTINCT FROM OLD.assigned_to_user_id
    OR NEW.cadence_unit IS DISTINCT FROM OLD.cadence_unit
    OR NEW.cadence_interval IS DISTINCT FROM OLD.cadence_interval
    OR NEW.anchor_at IS DISTINCT FROM OLD.anchor_at
    OR NEW.priority IS DISTINCT FROM OLD.priority
    OR NEW.blind_count IS DISTINCT FROM OLD.blind_count
    OR NEW.variance_escalation_threshold IS DISTINCT FROM OLD.variance_escalation_threshold
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'recurring cycle-count policy definition is immutable; create a new policy to change its scope or cadence'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'recurring cycle-count policy version must advance exactly once'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'ACTIVE' AND NEW.status IN ('PAUSED', 'RETIRED'))
      OR (OLD.status = 'PAUSED' AND NEW.status IN ('ACTIVE', 'RETIRED'))
    ) THEN
      RAISE EXCEPTION 'invalid recurring cycle-count policy status transition'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.next_occurrence_number IS DISTINCT FROM OLD.next_occurrence_number
      OR NEW.next_run_at IS DISTINCT FROM OLD.next_run_at
      OR NEW.last_run_at IS DISTINCT FROM OLD.last_run_at
    THEN
      RAISE EXCEPTION 'policy pause/resume/retire cannot also advance the occurrence cursor'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    IF OLD.status <> 'ACTIVE'
      OR NEW.next_occurrence_number <> OLD.next_occurrence_number + 1
      OR NEW.last_run_at IS DISTINCT FROM OLD.next_run_at
    THEN
      RAISE EXCEPTION 'only an active recurring policy may materialize its next scheduled occurrence'
        USING ERRCODE = '55000';
    END IF;
    expected_next_run := public.factoryos_cycle_count_recurring_expected_run(
      NEW.anchor_at, NEW.cadence_unit, NEW.cadence_interval, NEW.next_occurrence_number
    );
    IF NEW.next_run_at IS DISTINCT FROM expected_next_run THEN
      RAISE EXCEPTION 'recurring policy cursor must advance from the immutable anchor and occurrence number'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_validate_cycle_count_recurring_policy_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'ACTIVE' OR NEW.next_occurrence_number <> 0
    OR NEW.next_run_at IS DISTINCT FROM NEW.anchor_at OR NEW.last_run_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'recurring policy must begin active at occurrence zero with its anchor as the first run'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM inventory_items i
    WHERE i.id = NEW.item_id AND i.tenant_id = NEW.tenant_id
      AND i.factory_id = NEW.factory_id AND i.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'recurring cycle-count policy requires an active item in this factory'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM inventory_locations l
    JOIN inventory_locations p
      ON p.id = l.parent_location_id AND p.tenant_id = l.tenant_id
     AND p.factory_id = l.factory_id
    WHERE l.id = NEW.location_id AND l.tenant_id = NEW.tenant_id
      AND l.factory_id = NEW.factory_id AND l.location_type = 'BIN'
      AND l.status = 'ACTIVE' AND p.location_type IN ('WAREHOUSE', 'STAGING')
      AND p.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'recurring cycle-count policy location must be an active bin in this factory'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM users u
    JOIN tenant_memberships tm ON tm.user_id = u.id
    WHERE u.id = NEW.assigned_to_user_id AND u.status = 'ACTIVE'
      AND tm.tenant_id = NEW.tenant_id AND tm.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'recurring cycle-count policy assignee must be an active tenant member'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_cycle_count_recurring_occurrence()
RETURNS trigger
LANGUAGE plpgsql
AS $occurrence_guard$
BEGIN
  RAISE EXCEPTION 'recurring cycle-count occurrence evidence is immutable and cannot be changed or deleted'
    USING ERRCODE = '55000';
END;
$occurrence_guard$;

DROP TRIGGER IF EXISTS inventory_cycle_count_recurring_occurrences_immutable
  ON inventory_cycle_count_recurring_policy_occurrences;
CREATE TRIGGER inventory_cycle_count_recurring_occurrences_immutable
BEFORE UPDATE OR DELETE ON inventory_cycle_count_recurring_policy_occurrences
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_cycle_count_recurring_occurrence();

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_cycle_count_recurring_policy_events()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'recurring cycle-count policy event history is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_record_inventory_cycle_count_recurring_policy_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_event_type VARCHAR(32);
  resolved_actor UUID;
  resolved_occurrence_number BIGINT;
  resolved_occurrence_at TIMESTAMPTZ;
BEGIN
  resolved_actor := NULLIF(current_setting('app.user_id', true), '')::UUID;

  IF TG_OP = 'INSERT' THEN
    resolved_event_type := 'CREATED';
    resolved_occurrence_number := NULL;
    resolved_occurrence_at := NULL;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    resolved_event_type := CASE NEW.status
      WHEN 'PAUSED' THEN 'PAUSED'
      WHEN 'ACTIVE' THEN 'RESUMED'
      WHEN 'RETIRED' THEN 'RETIRED'
    END;
    resolved_occurrence_number := NULL;
    resolved_occurrence_at := NULL;
  ELSE
    resolved_event_type := 'OCCURRENCE_MATERIALIZED';
    resolved_occurrence_number := NEW.next_occurrence_number - 1;
    resolved_occurrence_at := NEW.last_run_at;
  END IF;

  INSERT INTO inventory_cycle_count_recurring_policy_events (
    tenant_id, factory_id, policy_id, event_type, actor_user_id,
    occurrence_number, occurrence_at, payload
  ) VALUES (
    NEW.tenant_id, NEW.factory_id, NEW.id, resolved_event_type, resolved_actor,
    resolved_occurrence_number, resolved_occurrence_at,
    jsonb_build_object(
      'status', NEW.status,
      'version', NEW.version,
      'next_occurrence_number', NEW.next_occurrence_number,
      'next_run_at', NEW.next_run_at,
      'last_run_at', NEW.last_run_at
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_cycle_count_recurring_policy_insert_guard
  ON inventory_cycle_count_recurring_policies;
CREATE TRIGGER inventory_cycle_count_recurring_policy_insert_guard
BEFORE INSERT ON inventory_cycle_count_recurring_policies
FOR EACH ROW EXECUTE FUNCTION factoryos_validate_cycle_count_recurring_policy_insert();

DROP TRIGGER IF EXISTS inventory_cycle_count_recurring_policy_guard
  ON inventory_cycle_count_recurring_policies;
CREATE TRIGGER inventory_cycle_count_recurring_policy_guard
BEFORE UPDATE OR DELETE ON inventory_cycle_count_recurring_policies
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_cycle_count_recurring_policy();

DROP TRIGGER IF EXISTS inventory_cycle_count_recurring_policy_event_insert
  ON inventory_cycle_count_recurring_policies;
CREATE TRIGGER inventory_cycle_count_recurring_policy_event_insert
AFTER INSERT OR UPDATE ON inventory_cycle_count_recurring_policies
FOR EACH ROW EXECUTE FUNCTION factoryos_record_inventory_cycle_count_recurring_policy_event();

DROP TRIGGER IF EXISTS inventory_cycle_count_recurring_policy_events_immutable
  ON inventory_cycle_count_recurring_policy_events;
CREATE TRIGGER inventory_cycle_count_recurring_policy_events_immutable
BEFORE UPDATE OR DELETE ON inventory_cycle_count_recurring_policy_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_inventory_cycle_count_recurring_policy_events();

ALTER TABLE inventory_cycle_count_recurring_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cycle_count_recurring_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_cycle_count_recurring_policies_tenant_isolation
  ON inventory_cycle_count_recurring_policies;
CREATE POLICY inventory_cycle_count_recurring_policies_tenant_isolation
  ON inventory_cycle_count_recurring_policies
  USING (tenant_id = public.factoryos_current_tenant_id())
  WITH CHECK (tenant_id = public.factoryos_current_tenant_id());

ALTER TABLE inventory_cycle_count_recurring_policy_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cycle_count_recurring_policy_occurrences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_cycle_count_recurring_occurrences_tenant_isolation
  ON inventory_cycle_count_recurring_policy_occurrences;
CREATE POLICY inventory_cycle_count_recurring_occurrences_tenant_isolation
  ON inventory_cycle_count_recurring_policy_occurrences
  USING (tenant_id = public.factoryos_current_tenant_id())
  WITH CHECK (tenant_id = public.factoryos_current_tenant_id());

ALTER TABLE inventory_cycle_count_recurring_policy_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cycle_count_recurring_policy_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_cycle_count_recurring_policy_events_tenant_isolation
  ON inventory_cycle_count_recurring_policy_events;
CREATE POLICY inventory_cycle_count_recurring_policy_events_tenant_isolation
  ON inventory_cycle_count_recurring_policy_events
  USING (tenant_id = public.factoryos_current_tenant_id())
  WITH CHECK (tenant_id = public.factoryos_current_tenant_id());

INSERT INTO factoryos_governance.tenant_relation_inventory (
  schema_name, relation_name, scope_model, data_category, export_disposition,
  erasure_disposition, audit_requirement, rationale
) VALUES
(
  'public', 'inventory_cycle_count_recurring_policies', 'DIRECT_TENANT_ID', 'BUSINESS_DATA',
  'EXCLUDED', 'BLOCKED_UNREVIEWED', 'DOMAIN_LEDGER_OR_AUDIT_REVIEW',
  'Recurring count policy has immutable item, bin, counter, cadence and variance escalation settings with a database-guarded occurrence cursor.'
),
(
  'public', 'inventory_cycle_count_recurring_policy_occurrences', 'DIRECT_TENANT_ID', 'BUSINESS_DATA',
  'EXCLUDED', 'BLOCKED_UNREVIEWED', 'DOMAIN_LEDGER_OR_AUDIT_REVIEW',
  'Every recurring count occurrence is idempotently linked to one generated immutable count task.'
),
(
  'public', 'inventory_cycle_count_recurring_policy_events', 'DIRECT_TENANT_ID', 'AUDIT_DATA',
  'EXCLUDED', 'BLOCKED_UNREVIEWED', 'DOMAIN_LEDGER_OR_AUDIT_REVIEW',
  'Append-only recurring policy and materialization lifecycle evidence.'
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
) VALUES
(
  'public', 'inventory_cycle_count_recurring_policies', 'DIRECT_TENANT',
  'DIRECT_TENANT_COLUMN_AND_RLS',
  'Recurring policy rows enforce active target scope, immutable recurrence configuration, one-way lifecycle state and database-validated occurrence cursor progression.',
  'tenant_id = public.factoryos_current_tenant_id()',
  'EXCLUDED', 'BLOCKED_UNREVIEWED', 'VERIFIED'
),
(
  'public', 'inventory_cycle_count_recurring_policy_occurrences', 'DIRECT_TENANT',
  'DIRECT_TENANT_COLUMN_AND_RLS',
  'Occurrence records use tenant/factory scoped policy and task foreign keys plus a unique policy occurrence number.',
  'tenant_id = public.factoryos_current_tenant_id()',
  'EXCLUDED', 'BLOCKED_UNREVIEWED', 'VERIFIED'
),
(
  'public', 'inventory_cycle_count_recurring_policy_events', 'DIRECT_TENANT',
  'DIRECT_TENANT_COLUMN_AND_RLS',
  'Policy lifecycle/materialization events carry direct tenant scope, forced RLS and database-enforced append-only history.',
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
VALUES ('190_inventory_cycle_count_recurring_policies', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
