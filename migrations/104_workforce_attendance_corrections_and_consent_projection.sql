BEGIN;

-- Consent is append-only evidence; the worker's current consent state is a projection
-- maintained atomically from that evidence rather than free-form API input.
CREATE OR REPLACE FUNCTION factoryos_guard_workforce_row_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_new JSONB := to_jsonb(NEW);
  v_old JSONB := to_jsonb(OLD);
  v_actor UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME <> 'workforce_attendance_events'
       AND TG_TABLE_NAME <> 'workforce_productivity_reports'
       AND TG_TABLE_NAME <> 'workforce_biometric_consent_events'
       AND COALESCE((v_new->>'row_version')::BIGINT, 1) <> 1 THEN
      RAISE EXCEPTION 'New workforce records must start at row_version 1' USING ERRCODE='23514';
    END IF;
    v_actor := COALESCE(
      NULLIF(v_new->>'created_by_user_id','')::UUID,
      NULLIF(v_new->>'recorded_by_user_id','')::UUID,
      NULLIF(v_new->>'actor_user_id','')::UUID
    );
    IF v_actor IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'Workforce record creator must match authenticated database context'
        USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;

  IF (v_new->>'row_version') IS NULL
     OR (v_new->>'row_version')::BIGINT <> (v_old->>'row_version')::BIGINT + 1 THEN
    RAISE EXCEPTION 'Workforce updates must increment row_version exactly once' USING ERRCODE='23514';
  END IF;
  v_actor := NULLIF(v_new->>'updated_by_user_id','')::UUID;
  IF v_actor IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Workforce updater must match authenticated database context'
      USING ERRCODE='42501';
  END IF;
  IF v_new->>'id' IS DISTINCT FROM v_old->>'id'
     OR v_new->>'tenant_id' IS DISTINCT FROM v_old->>'tenant_id'
     OR v_new->>'factory_id' IS DISTINCT FROM v_old->>'factory_id'
     OR v_new->>'created_at' IS DISTINCT FROM v_old->>'created_at'
     OR v_new->>'created_by_user_id' IS DISTINCT FROM v_old->>'created_by_user_id'
     OR v_new->>'idempotency_key' IS DISTINCT FROM v_old->>'idempotency_key'
     OR v_new->>'request_hash' IS DISTINCT FROM v_old->>'request_hash'
     OR v_new->>'correlation_id' IS DISTINCT FROM v_old->>'correlation_id' THEN
    RAISE EXCEPTION 'Workforce identity, scope and creation evidence are immutable'
      USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='workforce_workers'
     AND (NEW.biometric_consent_at IS DISTINCT FROM OLD.biometric_consent_at
       OR NEW.biometric_consent_withdrawn_at IS DISTINCT FROM OLD.biometric_consent_withdrawn_at)
     AND NULLIF(current_setting('app.workforce_consent_event_id',true),'')
       IS DISTINCT FROM (
         SELECT e.id::TEXT
         FROM workforce_biometric_consent_events e
         WHERE e.worker_id=NEW.id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
           AND e.recorded_by_user_id=factoryos_current_user_id()
         ORDER BY e.created_at DESC,e.id DESC LIMIT 1
       ) THEN
    RAISE EXCEPTION 'Worker biometric-consent projection may only change from the consent event trigger'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_workforce_attendance_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_assignment RECORD;
  v_item RECORD;
  v_state VARCHAR(24) := 'OFF_SHIFT';
  v_previous_time TIMESTAMPTZ;
  v_type VARCHAR(24);
  v_time TIMESTAMPTZ;
BEGIN
  IF NEW.recorded_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Attendance recorder must match authenticated database context' USING ERRCODE='42501';
  END IF;

  SELECT a.worker_id,a.status,a.planned_start_at,a.planned_end_at,w.status AS worker_status,
         w.biometric_consent_at,w.biometric_consent_withdrawn_at
  INTO v_assignment
  FROM workforce_shift_assignments a
  JOIN workforce_workers w
    ON w.id=a.worker_id AND w.tenant_id=a.tenant_id AND w.factory_id=a.factory_id
  WHERE a.id=NEW.shift_assignment_id AND a.worker_id=NEW.worker_id
    AND a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
  FOR SHARE OF a,w;
  IF NOT FOUND OR v_assignment.status='CANCELLED' THEN
    RAISE EXCEPTION 'Attendance requires an existing non-cancelled worker assignment' USING ERRCODE='23514';
  END IF;
  IF v_assignment.worker_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Attendance cannot be captured for an inactive worker' USING ERRCODE='23514';
  END IF;
  IF NEW.occurred_at < v_assignment.planned_start_at - INTERVAL '12 hours'
     OR NEW.occurred_at > v_assignment.planned_end_at + INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'Attendance event timestamp is outside the assignment capture window' USING ERRCODE='23514';
  END IF;
  IF NEW.source_type='BIOMETRIC' AND (
    v_assignment.biometric_consent_at IS NULL
    OR (v_assignment.biometric_consent_withdrawn_at IS NOT NULL
      AND v_assignment.biometric_consent_withdrawn_at >= v_assignment.biometric_consent_at)
  ) THEN
    RAISE EXCEPTION 'Biometric attendance requires current, explicit worker consent' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(NEW.capture_metadata) <> 'object' THEN
    RAISE EXCEPTION 'Attendance capture metadata must be a JSON object' USING ERRCODE='23514';
  END IF;

  -- Validate the complete event timeline so late-arriving biometric events can sync
  -- out of order in arrival time while still producing a valid occurred-at sequence.
  FOR v_item IN
    SELECT e.event_type,e.occurred_at,e.id
    FROM workforce_attendance_events e
    WHERE e.shift_assignment_id=NEW.shift_assignment_id
      AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
    UNION ALL
    SELECT NEW.event_type,NEW.occurred_at,NEW.id
    ORDER BY occurred_at,id
  LOOP
    v_type:=v_item.event_type;
    v_time:=v_item.occurred_at;
    IF v_previous_time IS NOT NULL AND v_time <= v_previous_time THEN
      RAISE EXCEPTION 'Attendance events must have strictly increasing timestamps' USING ERRCODE='23514';
    END IF;
    v_previous_time:=v_time;
    IF v_type='CLOCK_IN' AND v_state='OFF_SHIFT' THEN
      v_state:='ON_SHIFT';
    ELSIF v_type='BREAK_START' AND v_state='ON_SHIFT' THEN
      v_state:='ON_BREAK';
    ELSIF v_type='BREAK_END' AND v_state='ON_BREAK' THEN
      v_state:='ON_SHIFT';
    ELSIF v_type='CLOCK_OUT' AND v_state='ON_SHIFT' THEN
      v_state:='CLOCKED_OUT';
    ELSIF v_type='ABSENCE_RECORDED' AND v_state='OFF_SHIFT' THEN
      v_state:='ABSENT';
    ELSE
      RAISE EXCEPTION 'Invalid attendance event sequence: % while %',v_type,v_state USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TABLE workforce_attendance_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  original_event_id UUID NOT NULL,
  correction_version BIGINT NOT NULL DEFAULT 1,
  supersedes_correction_id UUID,
  worker_id UUID NOT NULL,
  shift_assignment_id UUID NOT NULL,
  corrected_event_type VARCHAR(24) NOT NULL,
  corrected_occurred_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  corrected_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_workforce_correction_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_workforce_correction_chain UNIQUE (id, original_event_id, tenant_id, factory_id),
  CONSTRAINT uq_workforce_correction_version UNIQUE (original_event_id, correction_version),
  CONSTRAINT uq_workforce_correction_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_workforce_correction_original FOREIGN KEY (original_event_id, tenant_id, factory_id)
    REFERENCES workforce_attendance_events(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_correction_assignment FOREIGN KEY (shift_assignment_id, worker_id, tenant_id, factory_id)
    REFERENCES workforce_shift_assignments(id, worker_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_correction_parent FOREIGN KEY (supersedes_correction_id, original_event_id, tenant_id, factory_id)
    REFERENCES workforce_attendance_corrections(id, original_event_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_correction_actor FOREIGN KEY (corrected_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_workforce_correction_version CHECK (correction_version > 0),
  CONSTRAINT chk_workforce_correction_type CHECK (corrected_event_type IN ('CLOCK_IN','CLOCK_OUT','BREAK_START','BREAK_END','ABSENCE_RECORDED')),
  CONSTRAINT chk_workforce_correction_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT chk_workforce_correction_key CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_workforce_correction_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_workforce_correction_assignment
  ON workforce_attendance_corrections (tenant_id,factory_id,shift_assignment_id,original_event_id,correction_version DESC);
ALTER TABLE workforce_attendance_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE workforce_attendance_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY workforce_attendance_corrections_tenant_isolation
  ON workforce_attendance_corrections
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_workforce_attendance_correction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_original RECORD;
  v_last RECORD;
  v_item RECORD;
  v_state VARCHAR(24) := 'OFF_SHIFT';
  v_type VARCHAR(24);
  v_time TIMESTAMPTZ;
  v_previous_time TIMESTAMPTZ;
BEGIN
  IF NEW.corrected_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Attendance correction actor must match authenticated database context' USING ERRCODE='42501';
  END IF;
  SELECT e.worker_id,e.shift_assignment_id,e.event_type,e.occurred_at,a.planned_start_at,a.planned_end_at
  INTO v_original
  FROM workforce_attendance_events e
  JOIN workforce_shift_assignments a
    ON a.id=e.shift_assignment_id AND a.tenant_id=e.tenant_id AND a.factory_id=e.factory_id
  WHERE e.id=NEW.original_event_id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
  FOR SHARE OF e,a;
  IF NOT FOUND OR v_original.worker_id<>NEW.worker_id OR v_original.shift_assignment_id<>NEW.shift_assignment_id THEN
    RAISE EXCEPTION 'Correction must refer to the same worker and shift as its original event' USING ERRCODE='23503';
  END IF;
  IF NEW.corrected_occurred_at < v_original.planned_start_at - INTERVAL '12 hours'
     OR NEW.corrected_occurred_at > v_original.planned_end_at + INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'Corrected attendance timestamp is outside the assignment capture window' USING ERRCODE='23514';
  END IF;

  SELECT c.id,c.correction_version INTO v_last
  FROM workforce_attendance_corrections c
  WHERE c.original_event_id=NEW.original_event_id AND c.tenant_id=NEW.tenant_id AND c.factory_id=NEW.factory_id
  ORDER BY c.correction_version DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    IF NEW.correction_version<>1 OR NEW.supersedes_correction_id IS NOT NULL THEN
      RAISE EXCEPTION 'First attendance correction must start at version 1' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.correction_version<>v_last.correction_version+1 OR NEW.supersedes_correction_id IS DISTINCT FROM v_last.id THEN
    RAISE EXCEPTION 'Attendance corrections must append to the latest version exactly once' USING ERRCODE='23514';
  END IF;

  -- Validate the effective (latest-corrected) timeline before accepting a correction.
  FOR v_item IN
    WITH ranked_corrections AS (
      SELECT DISTINCT ON (c.original_event_id)
        c.original_event_id,c.corrected_event_type,c.corrected_occurred_at
      FROM workforce_attendance_corrections c
      WHERE c.tenant_id=NEW.tenant_id AND c.factory_id=NEW.factory_id
        AND c.shift_assignment_id=NEW.shift_assignment_id
        AND c.original_event_id<>NEW.original_event_id
      ORDER BY c.original_event_id,c.correction_version DESC
    ), effective AS (
      SELECT e.id,
        CASE WHEN e.id=NEW.original_event_id THEN NEW.corrected_event_type
             ELSE COALESCE(c.corrected_event_type,e.event_type) END AS event_type,
        CASE WHEN e.id=NEW.original_event_id THEN NEW.corrected_occurred_at
             ELSE COALESCE(c.corrected_occurred_at,e.occurred_at) END AS occurred_at
      FROM workforce_attendance_events e
      LEFT JOIN ranked_corrections c ON c.original_event_id=e.id
      WHERE e.shift_assignment_id=NEW.shift_assignment_id
        AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
    )
    SELECT event_type,occurred_at,id FROM effective ORDER BY occurred_at,id
  LOOP
    v_type:=v_item.event_type;
    v_time:=v_item.occurred_at;
    IF v_previous_time IS NOT NULL AND v_time<=v_previous_time THEN
      RAISE EXCEPTION 'Corrected attendance event order has duplicate or descending timestamps' USING ERRCODE='23514';
    END IF;
    v_previous_time:=v_time;
    IF v_type='CLOCK_IN' AND v_state='OFF_SHIFT' THEN
      v_state:='ON_SHIFT';
    ELSIF v_type='BREAK_START' AND v_state='ON_SHIFT' THEN
      v_state:='ON_BREAK';
    ELSIF v_type='BREAK_END' AND v_state='ON_BREAK' THEN
      v_state:='ON_SHIFT';
    ELSIF v_type='CLOCK_OUT' AND v_state='ON_SHIFT' THEN
      v_state:='CLOCKED_OUT';
    ELSIF v_type='ABSENCE_RECORDED' AND v_state='OFF_SHIFT' THEN
      v_state:='ABSENT';
    ELSE
      RAISE EXCEPTION 'Correction would create an invalid attendance timeline: % while %',v_type,v_state USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_workforce_attendance_correction_guard
BEFORE INSERT ON workforce_attendance_corrections
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_workforce_attendance_correction();
CREATE TRIGGER trg_workforce_attendance_correction_immutable
BEFORE UPDATE OR DELETE ON workforce_attendance_corrections
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_workforce_evidence_mutation();
CREATE TRIGGER trg_workforce_attendance_correction_audit
AFTER INSERT ON workforce_attendance_corrections
FOR EACH ROW EXECUTE FUNCTION factoryos_append_workforce_audit_event();

CREATE OR REPLACE FUNCTION factoryos_apply_biometric_consent_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('app.workforce_consent_event_id',NEW.id::TEXT,true);
  IF NEW.consent_granted THEN
    UPDATE workforce_workers
    SET biometric_consent_at=NEW.created_at,
        biometric_consent_withdrawn_at=NULL,
        row_version=row_version+1,
        updated_by_user_id=NEW.recorded_by_user_id,
        last_change_reason=NEW.reason,
        updated_at=clock_timestamp()
    WHERE id=NEW.worker_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  ELSE
    UPDATE workforce_workers
    SET biometric_consent_withdrawn_at=NEW.created_at,
        row_version=row_version+1,
        updated_by_user_id=NEW.recorded_by_user_id,
        last_change_reason=NEW.reason,
        updated_at=clock_timestamp()
    WHERE id=NEW.worker_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consent event worker was not found in the same factory' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_workforce_consent_projection
AFTER INSERT ON workforce_biometric_consent_events
FOR EACH ROW EXECUTE FUNCTION factoryos_apply_biometric_consent_event();

-- Reconcile corrections and break intervals without mutating source evidence.
COMMENT ON TABLE workforce_attendance_corrections IS
  'Append-only, versioned correction overlays for raw attendance events. Original biometric/manual/QR/API evidence is never rewritten.';
COMMENT ON TABLE workforce_productivity_reports IS
  'Immutable worker-attributed operation output with earned minutes and efficiency derived from the released routing standard time.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('104_workforce_attendance_corrections_and_consent_projection', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
