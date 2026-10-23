BEGIN;

-- Persist multi-bin recurrence targets and allow one occurrence to point to a
-- session instead of a single cycle-count task.
ALTER TABLE inventory_cycle_count_recurring_policies
  ADD COLUMN IF NOT EXISTS session_location_ids UUID[] NOT NULL DEFAULT '{}'::uuid[];

ALTER TABLE inventory_cycle_count_recurring_policy_occurrences
  ADD COLUMN IF NOT EXISTS session_id UUID;
ALTER TABLE inventory_cycle_count_recurring_policy_occurrences
  ALTER COLUMN task_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'inventory_cycle_count_recurring_policies'::regclass
      AND conname = 'chk_inventory_cycle_count_recurring_policy_session_bins'
  ) THEN
    ALTER TABLE inventory_cycle_count_recurring_policies
      ADD CONSTRAINT chk_inventory_cycle_count_recurring_policy_session_bins
      CHECK (
        cardinality(session_location_ids) = 0
        OR (
          cardinality(session_location_ids) BETWEEN 2 AND 50
          AND array_position(session_location_ids, NULL::uuid) IS NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'inventory_cycle_count_recurring_policies'::regclass
      AND conname = 'chk_inventory_cycle_count_recurring_policy_location_mode'
  ) THEN
    ALTER TABLE inventory_cycle_count_recurring_policies
      ADD CONSTRAINT chk_inventory_cycle_count_recurring_policy_location_mode
      CHECK (location_id IS NULL OR cardinality(session_location_ids) = 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'inventory_cycle_count_recurring_policy_occurrences'::regclass
      AND conname = 'fk_inventory_cycle_count_recurring_occurrence_session'
  ) THEN
    ALTER TABLE inventory_cycle_count_recurring_policy_occurrences
      ADD CONSTRAINT fk_inventory_cycle_count_recurring_occurrence_session
      FOREIGN KEY (session_id, tenant_id, factory_id)
      REFERENCES inventory_cycle_count_sessions (id, tenant_id, factory_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'inventory_cycle_count_recurring_policy_occurrences'::regclass
      AND conname = 'chk_inventory_cycle_count_recurring_occurrence_target'
  ) THEN
    ALTER TABLE inventory_cycle_count_recurring_policy_occurrences
      ADD CONSTRAINT chk_inventory_cycle_count_recurring_occurrence_target
      CHECK (
        (task_id IS NOT NULL AND session_id IS NULL)
        OR (task_id IS NULL AND session_id IS NOT NULL)
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_cycle_count_recurring_occurrence_session
  ON inventory_cycle_count_recurring_policy_occurrences (tenant_id, factory_id, session_id)
  WHERE session_id IS NOT NULL;

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
    OR NEW.session_location_ids IS DISTINCT FROM OLD.session_location_ids
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

  IF cardinality(NEW.session_location_ids) > 0 THEN
    IF NEW.location_id IS NOT NULL
      OR cardinality(NEW.session_location_ids) < 2
      OR cardinality(NEW.session_location_ids) > 50
      OR array_position(NEW.session_location_ids, NULL::uuid) IS NOT NULL
      OR (SELECT count(DISTINCT requested.location_id)
          FROM unnest(NEW.session_location_ids) requested(location_id))
           <> cardinality(NEW.session_location_ids)
    THEN
      RAISE EXCEPTION 'recurring multi-bin policy requires 2–50 distinct bins and cannot also set location_id'
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1 FROM unnest(NEW.session_location_ids) requested(location_id)
      WHERE NOT EXISTS (
        SELECT 1
        FROM inventory_locations l
        JOIN inventory_locations p
          ON p.id = l.parent_location_id AND p.tenant_id = l.tenant_id
         AND p.factory_id = l.factory_id
        WHERE l.id = requested.location_id AND l.tenant_id = NEW.tenant_id
          AND l.factory_id = NEW.factory_id AND l.location_type = 'BIN'
          AND l.status = 'ACTIVE' AND p.location_type IN ('WAREHOUSE', 'STAGING')
          AND p.status = 'ACTIVE'
      )
    ) THEN
      RAISE EXCEPTION 'every recurring session bin must be active in the policy factory'
        USING ERRCODE = '23514';
    END IF;
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
      'last_run_at', NEW.last_run_at,
      'location_id', NEW.location_id,
      'session_location_ids', NEW.session_location_ids
    )
  );
  RETURN NEW;
END;
$$;

INSERT INTO schema_migrations(version, checksum)
VALUES ('194_inventory_cycle_count_recurring_sessions', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
