BEGIN;

-- Attendance correction is intentionally a separate permission from read/capture.
INSERT INTO permissions (code, description)
VALUES ('workforce.attendance.correct', 'Append a reasoned, versioned correction to factory-scoped attendance evidence')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.code='workforce.attendance.correct'
WHERE r.code IN ('ORG_ADMIN','FACTORY_MANAGER')
ON CONFLICT (role_id,permission_id) DO NOTHING;

-- Shift template maintenance is versioned. Existing rosters keep their resolved
-- timestamp snapshots; template edits affect future roster calculations only.
ALTER TABLE workforce_shift_templates ADD COLUMN last_change_reason TEXT;

CREATE OR REPLACE FUNCTION factoryos_guard_workforce_shift_template_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'ACTIVE' OR NEW.row_version<>1 OR NEW.last_change_reason IS NOT NULL THEN
      RAISE EXCEPTION 'Shift templates must be created active at version one' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.shift_code IS DISTINCT FROM OLD.shift_code
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id THEN
    RAISE EXCEPTION 'Shift identity, code and original creation evidence are immutable' USING ERRCODE='23514';
  END IF;
  IF length(btrim(COALESCE(NEW.last_change_reason,'')))=0 THEN
    RAISE EXCEPTION 'Shift template edits require an auditable reason' USING ERRCODE='23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status='ACTIVE' AND NEW.status='INACTIVE') OR (OLD.status='INACTIVE' AND NEW.status='ACTIVE')
  ) THEN
    RAISE EXCEPTION 'Invalid shift-template lifecycle transition: % -> %',OLD.status,NEW.status USING ERRCODE='23514';
  END IF;
  IF OLD.status='ACTIVE' AND NEW.status='INACTIVE' AND EXISTS (
    SELECT 1 FROM workforce_shift_assignments a
    WHERE a.shift_template_id=OLD.id AND a.tenant_id=OLD.tenant_id AND a.factory_id=OLD.factory_id
      AND a.status IN ('PLANNED','CONFIRMED') AND a.planned_end_at>clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'A shift template with future planned or confirmed assignments cannot be inactivated' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_workforce_shift_template_lifecycle_guard
BEFORE INSERT OR UPDATE ON workforce_shift_templates
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_workforce_shift_template_lifecycle();

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
  CONSTRAINT uq_workforce_correction_scope UNIQUE (id,tenant_id,factory_id),
  CONSTRAINT uq_workforce_correction_chain UNIQUE (id,original_event_id,tenant_id,factory_id),
  CONSTRAINT uq_workforce_correction_version UNIQUE (original_event_id,correction_version),
  CONSTRAINT uq_workforce_correction_idempotency UNIQUE (tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_workforce_correction_original FOREIGN KEY (original_event_id,tenant_id,factory_id)
    REFERENCES workforce_attendance_events(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_correction_assignment FOREIGN KEY (shift_assignment_id,worker_id,tenant_id,factory_id)
    REFERENCES workforce_shift_assignments(id,worker_id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_correction_parent FOREIGN KEY (supersedes_correction_id,original_event_id,tenant_id,factory_id)
    REFERENCES workforce_attendance_corrections(id,original_event_id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_correction_actor FOREIGN KEY (corrected_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_workforce_correction_version CHECK (correction_version>0),
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

-- Security-invoker view applies the most recent correction without changing raw
-- reader evidence. All attendance, overtime and labor calculations share it.
CREATE OR REPLACE VIEW workforce_attendance_events_effective WITH (security_invoker=true) AS
SELECT e.id,e.tenant_id,e.factory_id,e.shift_assignment_id,e.worker_id,
  COALESCE(c.corrected_event_type,e.event_type) AS event_type,
  e.source_type,e.source_event_id,COALESCE(c.corrected_occurred_at,e.occurred_at) AS occurred_at,
  e.idempotency_key,e.request_hash,e.capture_metadata,e.recorded_by_user_id,e.correlation_id,e.request_id,e.created_at,
  c.id AS latest_correction_id,c.correction_version,c.reason AS correction_reason
FROM workforce_attendance_events e
LEFT JOIN LATERAL (
  SELECT ac.id,ac.correction_version,ac.corrected_event_type,ac.corrected_occurred_at,ac.reason
  FROM workforce_attendance_corrections ac
  WHERE ac.original_event_id=e.id AND ac.tenant_id=e.tenant_id AND ac.factory_id=e.factory_id
  ORDER BY ac.correction_version DESC
  LIMIT 1
) c ON TRUE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='factoryos_app') THEN
    EXECUTE 'GRANT SELECT ON workforce_attendance_events_effective TO factoryos_app';
  END IF;
END;
$$;

ALTER TABLE workforce_command_receipts DROP CONSTRAINT chk_workforce_command_receipt_type;
ALTER TABLE workforce_command_receipts ADD CONSTRAINT chk_workforce_command_receipt_type CHECK (
  entity_type IN ('WORKER','SHIFT_ASSIGNMENT','OVERTIME_REQUEST','SHIFT_TEMPLATE','ATTENDANCE_CORRECTION')
);

ALTER TABLE workforce_audit_events DROP CONSTRAINT chk_workforce_audit_entity_type;
ALTER TABLE workforce_audit_events ADD CONSTRAINT chk_workforce_audit_entity_type CHECK (entity_type IN (
  'WORKER','SKILL','WORKER_SKILL','SHIFT_TEMPLATE','SHIFT_ASSIGNMENT','ATTENDANCE_EVENT',
  'ATTENDANCE_CORRECTION','OVERTIME_REQUEST','PRODUCTIVITY_REPORT','BIOMETRIC_CONSENT'
));

CREATE OR REPLACE FUNCTION factoryos_guard_workforce_attendance_correction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_original RECORD;
  v_latest RECORD;
  v_has_latest BOOLEAN;
  v_item RECORD;
  v_state VARCHAR(24):='OFF_SHIFT';
  v_previous_time TIMESTAMPTZ;
  v_effective_clock_in TIMESTAMPTZ;
  v_effective_clock_out TIMESTAMPTZ;
BEGIN
  IF NEW.corrected_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Attendance correction actor must match authenticated database context' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text||':'||NEW.factory_id::text||':'||NEW.shift_assignment_id::text||':attendance-corrections',0
  ));
  SELECT e.worker_id,e.shift_assignment_id,a.status,a.planned_start_at,a.planned_end_at
  INTO v_original
  FROM workforce_attendance_events e
  JOIN workforce_shift_assignments a
    ON a.id=e.shift_assignment_id AND a.tenant_id=e.tenant_id AND a.factory_id=e.factory_id
  WHERE e.id=NEW.original_event_id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
  FOR UPDATE OF e,a;
  IF NOT FOUND OR v_original.worker_id<>NEW.worker_id OR v_original.shift_assignment_id<>NEW.shift_assignment_id THEN
    RAISE EXCEPTION 'Correction must reference the original attendance event, worker and shift assignment' USING ERRCODE='23503';
  END IF;
  IF v_original.status NOT IN ('CONFIRMED','COMPLETED') THEN
    RAISE EXCEPTION 'Attendance correction requires a confirmed/completed shift assignment' USING ERRCODE='23514';
  END IF;
  IF NEW.corrected_occurred_at<v_original.planned_start_at-INTERVAL '12 hours'
     OR NEW.corrected_occurred_at>v_original.planned_end_at+INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'Corrected timestamp is outside the shift attendance capture window' USING ERRCODE='23514';
  END IF;
  SELECT c.id,c.correction_version INTO v_latest
  FROM workforce_attendance_corrections c
  WHERE c.original_event_id=NEW.original_event_id AND c.tenant_id=NEW.tenant_id AND c.factory_id=NEW.factory_id
  ORDER BY c.correction_version DESC LIMIT 1 FOR UPDATE;
  v_has_latest:=FOUND;
  IF v_has_latest THEN
    IF NEW.correction_version<>v_latest.correction_version+1 OR NEW.supersedes_correction_id IS DISTINCT FROM v_latest.id THEN
      RAISE EXCEPTION 'Correction must append to the latest version exactly once' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.correction_version<>1 OR NEW.supersedes_correction_id IS NOT NULL THEN
    RAISE EXCEPTION 'First correction must start at version one' USING ERRCODE='23514';
  END IF;

  FOR v_item IN
    WITH latest_corrections AS (
      SELECT DISTINCT ON (c.original_event_id) c.original_event_id,c.corrected_event_type,c.corrected_occurred_at
      FROM workforce_attendance_corrections c
      WHERE c.tenant_id=NEW.tenant_id AND c.factory_id=NEW.factory_id
        AND c.shift_assignment_id=NEW.shift_assignment_id AND c.original_event_id<>NEW.original_event_id
      ORDER BY c.original_event_id,c.correction_version DESC
    ), effective AS (
      SELECT e.id,
        CASE WHEN e.id=NEW.original_event_id THEN NEW.corrected_event_type
             ELSE COALESCE(c.corrected_event_type,e.event_type) END AS event_type,
        CASE WHEN e.id=NEW.original_event_id THEN NEW.corrected_occurred_at
             ELSE COALESCE(c.corrected_occurred_at,e.occurred_at) END AS occurred_at
      FROM workforce_attendance_events e
      LEFT JOIN latest_corrections c ON c.original_event_id=e.id
      WHERE e.shift_assignment_id=NEW.shift_assignment_id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
    )
    SELECT event_type,occurred_at,id FROM effective ORDER BY occurred_at,id
  LOOP
    IF v_previous_time IS NOT NULL AND v_item.occurred_at<=v_previous_time THEN
      RAISE EXCEPTION 'Corrected attendance timeline has duplicate or descending timestamps' USING ERRCODE='23514';
    END IF;
    v_previous_time:=v_item.occurred_at;
    IF v_item.event_type='CLOCK_IN' THEN v_effective_clock_in:=v_item.occurred_at; END IF;
    IF v_item.event_type='CLOCK_OUT' THEN v_effective_clock_out:=v_item.occurred_at; END IF;
    IF v_state='OFF_SHIFT' AND v_item.event_type='CLOCK_IN' THEN
      v_state:='ON_SHIFT';
    ELSIF v_state='OFF_SHIFT' AND v_item.event_type='ABSENCE_RECORDED' THEN
      v_state:='ABSENT';
    ELSIF v_state='ON_SHIFT' AND v_item.event_type='BREAK_START' THEN
      v_state:='ON_BREAK';
    ELSIF v_state='ON_SHIFT' AND v_item.event_type='CLOCK_OUT' THEN
      v_state:='CLOCKED_OUT';
    ELSIF v_state='ON_BREAK' AND v_item.event_type='BREAK_END' THEN
      v_state:='ON_SHIFT';
    ELSE
      RAISE EXCEPTION 'Correction would create an invalid attendance event sequence: % while %',v_item.event_type,v_state USING ERRCODE='23514';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM workforce_overtime_requests o
    WHERE o.shift_assignment_id=NEW.shift_assignment_id AND o.tenant_id=NEW.tenant_id AND o.factory_id=NEW.factory_id
      AND (v_effective_clock_out IS NULL OR o.requested_minutes>
        GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (v_effective_clock_out-v_original.planned_end_at))/60)::INTEGER))
  ) THEN
    RAISE EXCEPTION 'Correction would invalidate an overtime request; resolve overtime evidence before correcting attendance' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM workforce_productivity_reports p
    WHERE p.shift_assignment_id=NEW.shift_assignment_id AND p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id
      AND (v_effective_clock_in IS NULL OR p.production_started_at<v_effective_clock_in
        OR (v_effective_clock_out IS NOT NULL AND p.production_ended_at>v_effective_clock_out))
  ) THEN
    RAISE EXCEPTION 'Correction would invalidate a captured productivity interval' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_audit_workforce_attendance_correction()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workforce_audit_events (
    tenant_id,factory_id,entity_type,entity_id,entity_version,action,actor_user_id,reason,event_data,correlation_id
  ) VALUES (
    NEW.tenant_id,NEW.factory_id,'ATTENDANCE_CORRECTION',NEW.id,NEW.correction_version,'CORRECTED',
    NEW.corrected_by_user_id,NEW.reason,
    jsonb_build_object('original_event_id',NEW.original_event_id,'shift_assignment_id',NEW.shift_assignment_id,
      'worker_id',NEW.worker_id,'corrected_event_type',NEW.corrected_event_type,
      'corrected_occurred_at',NEW.corrected_occurred_at,'supersedes_correction_id',NEW.supersedes_correction_id),
    NEW.correlation_id
  );
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
FOR EACH ROW EXECUTE FUNCTION factoryos_audit_workforce_attendance_correction();

CREATE OR REPLACE FUNCTION factoryos_workforce_capture_metadata_is_safe(p_metadata JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item RECORD;
  allowed_keys CONSTANT TEXT[] := ARRAY[
    'device_id','reader_id','terminal_id','site_code','source_sequence','sync_batch_id',
    'capture_method','reader_timestamp','firmware_version','signal_quality','device_event_type',
    'client_version','device_timezone','offline_synced','latency_ms','batch_id',
    'protocol_version','reader_status','status_code','error_code','integration_id'
  ];
BEGIN
  IF p_metadata IS NULL OR jsonb_typeof(p_metadata)<>'object'
     OR jsonb_object_length(p_metadata)>20 THEN
    RETURN FALSE;
  END IF;
  FOR item IN SELECT key,value FROM jsonb_each(p_metadata) LOOP
    IF NOT (item.key=ANY(allowed_keys))
       OR jsonb_typeof(item.value) NOT IN ('string','number','boolean','null') THEN
      RETURN FALSE;
    END IF;
    IF jsonb_typeof(item.value)='string' AND (
      length(item.value #>> '{}')>255
      OR (item.value #>> '{}') ~ '[[:cntrl:]]'
    ) THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_workforce_attendance_event()
RETURNS trigger LANGUAGE plpgsql AS $
DECLARE
  v_assignment RECORD;
  v_stream RECORD;
  v_previous_type VARCHAR(24);
  v_previous_at TIMESTAMPTZ;
  v_consent_active BOOLEAN;
BEGIN
  IF NEW.recorded_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Attendance recorder must match authenticated database context' USING ERRCODE='42501';
  END IF;

  -- Serialize all attendance commands for this assignment. Reconstructing the
  -- timestamp-ordered stream permits offline sync, but not invalid sequences.
  SELECT a.worker_id,a.status,a.planned_start_at,a.planned_end_at,w.status AS worker_status
  INTO v_assignment
  FROM workforce_shift_assignments a
  JOIN workforce_workers w ON w.id=a.worker_id AND w.tenant_id=a.tenant_id AND w.factory_id=a.factory_id
  WHERE a.id=NEW.shift_assignment_id AND a.worker_id=NEW.worker_id
    AND a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
  FOR UPDATE OF a,w;
  IF NOT FOUND OR v_assignment.status NOT IN ('CONFIRMED','COMPLETED') THEN
    RAISE EXCEPTION 'Attendance requires a confirmed or completed worker assignment' USING ERRCODE='23514';
  END IF;
  IF v_assignment.worker_status<>'ACTIVE' THEN
    RAISE EXCEPTION 'Attendance cannot be captured for an inactive worker' USING ERRCODE='23514';
  END IF;
  IF NEW.occurred_at<v_assignment.planned_start_at-INTERVAL '12 hours'
     OR NEW.occurred_at>v_assignment.planned_end_at+INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'Attendance event timestamp is outside the assignment capture window' USING ERRCODE='23514';
  END IF;
  IF NEW.source_type='BIOMETRIC' THEN
    SELECT COALESCE((
      SELECT ce.consent_granted
      FROM workforce_biometric_consent_events ce
      WHERE ce.worker_id=NEW.worker_id AND ce.tenant_id=NEW.tenant_id AND ce.factory_id=NEW.factory_id
        AND ce.effective_at<=NEW.occurred_at
      ORDER BY ce.effective_at DESC,ce.created_at DESC,ce.id DESC
      LIMIT 1
    ),FALSE) INTO v_consent_active;
    IF NOT v_consent_active THEN
      RAISE EXCEPTION 'Biometric attendance is not allowed unless explicit consent was active at event time' USING ERRCODE='42501';
    END IF;
  END IF;
  IF NOT factoryos_workforce_capture_metadata_is_safe(NEW.capture_metadata) THEN
    RAISE EXCEPTION 'Attendance metadata supports only bounded non-sensitive scalar device diagnostics' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM workforce_attendance_events_effective e
    WHERE e.shift_assignment_id=NEW.shift_assignment_id AND e.tenant_id=NEW.tenant_id
      AND e.factory_id=NEW.factory_id AND e.occurred_at=NEW.occurred_at) THEN
    RAISE EXCEPTION 'Attendance events for one shift must have distinct occurrence timestamps' USING ERRCODE='23514';
  END IF;

  v_previous_type:=NULL;
  v_previous_at:=NULL;
  FOR v_stream IN
    SELECT stream.event_type,stream.occurred_at,stream.id FROM (
      SELECT e.event_type,e.occurred_at,e.id FROM workforce_attendance_events_effective e
      WHERE e.shift_assignment_id=NEW.shift_assignment_id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
      UNION ALL SELECT NEW.event_type,NEW.occurred_at,NEW.id
    ) AS stream
    ORDER BY stream.occurred_at,stream.id
  LOOP
    IF v_previous_at IS NULL THEN
      IF v_stream.event_type NOT IN ('CLOCK_IN','ABSENCE_RECORDED') THEN
        RAISE EXCEPTION 'First attendance event must be clock-in or an absence record' USING ERRCODE='23514';
      END IF;
    ELSIF v_previous_type IN ('ABSENCE_RECORDED','CLOCK_OUT') THEN
      RAISE EXCEPTION 'No attendance events are allowed after absence or clock-out' USING ERRCODE='23514';
    ELSIF v_previous_type IN ('CLOCK_IN','BREAK_END') THEN
      IF v_stream.event_type NOT IN ('BREAK_START','CLOCK_OUT') THEN
        RAISE EXCEPTION 'Attendance events must follow clock-in, paired breaks and clock-out order' USING ERRCODE='23514';
      END IF;
    ELSIF v_previous_type='BREAK_START' THEN
      IF v_stream.event_type<>'BREAK_END' THEN
        RAISE EXCEPTION 'A break must end before another break or clock-out' USING ERRCODE='23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported attendance event sequence' USING ERRCODE='23514';
    END IF;
    v_previous_type:=v_stream.event_type;
    v_previous_at:=v_stream.occurred_at;
  END LOOP;
  RETURN NEW;
END;
$$;

-- Productivity attribution schema and source-event index are established by migration 106.

CREATE OR REPLACE FUNCTION factoryos_guard_workforce_overtime()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_actual_overtime INTEGER;
  v_threshold INTEGER;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.status <> 'PENDING' OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'Overtime requests must start pending under the authenticated creator' USING ERRCODE='42501';
    END IF;
    SELECT GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (e.occurred_at-a.planned_end_at))/60)::INTEGER),
           s.overtime_threshold_minutes
    INTO v_actual_overtime,v_threshold
    FROM workforce_shift_assignments a
    JOIN workforce_shift_templates s
      ON s.id=a.shift_template_id AND s.tenant_id=a.tenant_id AND s.factory_id=a.factory_id
    JOIN workforce_attendance_events_effective e
      ON e.shift_assignment_id=a.id AND e.tenant_id=a.tenant_id AND e.factory_id=a.factory_id
      AND e.event_type='CLOCK_OUT'
    WHERE a.id=NEW.shift_assignment_id AND a.worker_id=NEW.worker_id
      AND a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
      AND a.status IN ('CONFIRMED','COMPLETED');
    IF NOT FOUND OR COALESCE(v_actual_overtime,0) <= COALESCE(v_threshold,0) THEN
      RAISE EXCEPTION 'Overtime requires clock-out evidence beyond the configured threshold' USING ERRCODE='23514';
    END IF;
    IF NEW.requested_minutes > v_actual_overtime THEN
      RAISE EXCEPTION 'Requested overtime cannot exceed the observed post-shift interval' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.row_version <> OLD.row_version+1
     OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Overtime decisions require the current actor and exactly one version increment' USING ERRCODE='42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
     OR NEW.shift_assignment_id IS DISTINCT FROM OLD.shift_assignment_id
     OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
     OR NEW.requested_minutes IS DISTINCT FROM OLD.requested_minutes
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id THEN
    RAISE EXCEPTION 'Overtime request identity and original request are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status <> 'PENDING' OR NEW.status NOT IN ('APPROVED','REJECTED') THEN
    RAISE EXCEPTION 'Only pending overtime requests can be decided once' USING ERRCODE='23514';
  END IF;
  IF NEW.decided_by_user_id IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.decided_by_user_id IS NULL OR NEW.decided_by_user_id=NEW.created_by_user_id THEN
    RAISE EXCEPTION 'Overtime approval must be performed by a different authenticated actor' USING ERRCODE='42501';
  END IF;
  IF NEW.decided_at IS NULL OR length(btrim(COALESCE(NEW.decision_reason,'')))=0 THEN
    RAISE EXCEPTION 'Overtime decisions require timestamp and reason' USING ERRCODE='23514';
  END IF;
  IF NEW.status='APPROVED' AND NEW.approved_minutes NOT BETWEEN 1 AND NEW.requested_minutes THEN
    RAISE EXCEPTION 'Approved overtime must be positive and cannot exceed the request' USING ERRCODE='23514';
  END IF;
  IF NEW.status='REJECTED' AND NEW.approved_minutes<>0 THEN
    RAISE EXCEPTION 'Rejected overtime cannot approve any minutes' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_workforce_productivity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_assignment RECORD;
  v_operation RECORD;
  v_source RECORD;
  v_clock_in TIMESTAMPTZ;
  v_clock_out TIMESTAMPTZ;
  v_duration_minutes NUMERIC;
  v_target_quantity NUMERIC(18,4);
  v_prior_quantity NUMERIC(18,4);
  v_prior_good NUMERIC(18,4);
  v_prior_scrap NUMERIC(18,4);
  v_source_good NUMERIC(18,4);
  v_source_scrap NUMERIC(18,4);
BEGIN
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Productivity recorder must match authenticated database context' USING ERRCODE='42501';
  END IF;
  IF NEW.source_operation_event_id IS NULL THEN
    RAISE EXCEPTION 'Productivity capture must reference an immutable shop-floor operation event' USING ERRCODE='23514';
  END IF;
  IF NEW.actual_minutes>EXTRACT(EPOCH FROM (NEW.production_ended_at-NEW.production_started_at))/60 THEN
    RAISE EXCEPTION 'Actual labor minutes cannot exceed the recorded production interval' USING ERRCODE='23514';
  END IF;

  -- Lock by worker first to prevent overlapping intervals across different
  -- operations, then by operation, then by source event for split attribution.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text||':'||NEW.factory_id::text||':'||NEW.worker_id::text||':workforce-productivity-worker',0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.work_order_operation_id::text||':workforce-productivity-operation',0));

  SELECT e.event_type,e.work_order_id,e.operation_id,e.payload
  INTO v_source
  FROM work_order_events e
  WHERE e.id=NEW.source_operation_event_id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
    AND e.work_order_id=NEW.work_order_id AND e.operation_id=NEW.work_order_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source operation event must belong to the same work order and operation' USING ERRCODE='23503';
  END IF;
  IF v_source.event_type='OUTPUT_REPORTED' THEN
    v_source_good:=NULLIF(v_source.payload->>'good_quantity','')::NUMERIC(18,4);
    v_source_scrap:=NULLIF(v_source.payload->>'scrap_quantity','')::NUMERIC(18,4);
    IF v_source_good IS NULL OR v_source_scrap IS NULL THEN
      RAISE EXCEPTION 'Output event must contain canonical good and scrap quantities' USING ERRCODE='23514';
    END IF;
  ELSIF v_source.event_type='WIP_TRANSFERRED' THEN
    v_source_good:=NULLIF(v_source.payload->>'quantity','')::NUMERIC(18,4);
    v_source_scrap:=0;
    IF v_source_good IS NULL OR v_source_good<=0 OR NEW.scrap_quantity<>0 THEN
      RAISE EXCEPTION 'WIP-transfer productivity requires positive transferred quantity and zero attributed scrap' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Productivity source must be an OUTPUT_REPORTED or WIP_TRANSFERRED event' USING ERRCODE='23514';
  END IF;

  SELECT COALESCE(SUM(p.good_quantity),0),COALESCE(SUM(p.scrap_quantity),0)
  INTO v_prior_good,v_prior_scrap
  FROM workforce_productivity_reports p
  WHERE p.source_operation_event_id=NEW.source_operation_event_id
    AND p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id;
  IF v_prior_good+NEW.good_quantity>v_source_good OR v_prior_scrap+NEW.scrap_quantity>v_source_scrap THEN
    RAISE EXCEPTION 'Worker-attributed quantities cannot exceed the immutable operation-event output' USING ERRCODE='23514';
  END IF;

  SELECT a.id,a.worker_id,a.work_order_id,a.work_order_operation_id,a.status,a.shift_date
  INTO v_assignment
  FROM workforce_shift_assignments a
  WHERE a.id=NEW.shift_assignment_id AND a.worker_id=NEW.worker_id
    AND a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
  FOR SHARE;
  IF NOT FOUND OR v_assignment.status IN ('CANCELLED','PLANNED') THEN
    RAISE EXCEPTION 'Productivity requires a confirmed/completed worker assignment' USING ERRCODE='23514';
  END IF;

  SELECT op.id,op.work_order_id,op.operation_code,op.required_skill,op.status,op.run_minutes_per_unit,op.step_number
  INTO v_operation
  FROM work_order_operations op
  WHERE op.id=NEW.work_order_operation_id AND op.work_order_id=NEW.work_order_id
    AND op.tenant_id=NEW.tenant_id AND op.factory_id=NEW.factory_id
  FOR SHARE;
  IF NOT FOUND OR v_operation.status NOT IN ('IN_PROGRESS','PAUSED','COMPLETED') THEN
    RAISE EXCEPTION 'Productivity must reference an active or completed work-order operation' USING ERRCODE='23514';
  END IF;
  IF v_operation.run_minutes_per_unit<=0 OR NEW.standard_minutes_per_unit<>v_operation.run_minutes_per_unit
     OR NEW.operation_code<>v_operation.operation_code THEN
    RAISE EXCEPTION 'Productivity standard time and operation code must match the frozen routing snapshot' USING ERRCODE='23514';
  END IF;
  SELECT wo.target_quantity INTO v_target_quantity
  FROM work_orders wo WHERE wo.id=NEW.work_order_id AND wo.tenant_id=NEW.tenant_id AND wo.factory_id=NEW.factory_id
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Work order was not found in the same factory' USING ERRCODE='23503'; END IF;

  SELECT COALESCE(SUM(p.good_quantity+p.scrap_quantity),0)::NUMERIC(18,4)
  INTO v_prior_quantity
  FROM workforce_productivity_reports p
  WHERE p.work_order_id=NEW.work_order_id AND p.work_order_operation_id=NEW.work_order_operation_id
    AND p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id;
  IF v_prior_quantity+NEW.good_quantity+NEW.scrap_quantity>v_target_quantity THEN
    RAISE EXCEPTION 'Cumulative operator quantity exceeds the work-order target for this operation' USING ERRCODE='23514';
  END IF;

  IF v_assignment.work_order_id IS NOT NULL AND v_assignment.work_order_id<>NEW.work_order_id THEN
    RAISE EXCEPTION 'Productivity work order must match the worker assignment' USING ERRCODE='23514';
  END IF;
  IF v_assignment.work_order_operation_id IS NOT NULL AND v_assignment.work_order_operation_id<>NEW.work_order_operation_id THEN
    RAISE EXCEPTION 'Productivity operation must match the worker assignment' USING ERRCODE='23514';
  END IF;

  SELECT occurred_at INTO v_clock_in
  FROM workforce_attendance_events_effective
  WHERE shift_assignment_id=NEW.shift_assignment_id AND worker_id=NEW.worker_id
    AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND event_type='CLOCK_IN';
  IF NOT FOUND THEN RAISE EXCEPTION 'Productivity requires recorded clock-in evidence' USING ERRCODE='23514'; END IF;
  SELECT occurred_at INTO v_clock_out
  FROM workforce_attendance_events_effective
  WHERE shift_assignment_id=NEW.shift_assignment_id AND worker_id=NEW.worker_id
    AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND event_type='CLOCK_OUT';
  IF NEW.production_started_at<v_clock_in OR (v_clock_out IS NOT NULL AND NEW.production_ended_at>v_clock_out) THEN
    RAISE EXCEPTION 'Productivity interval must fit inside recorded attendance' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM workforce_productivity_reports p
    WHERE p.shift_assignment_id=NEW.shift_assignment_id AND p.worker_id=NEW.worker_id
      AND p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id
      AND tstzrange(p.production_started_at,p.production_ended_at,'[)')
        && tstzrange(NEW.production_started_at,NEW.production_ended_at,'[)')
  ) THEN
    RAISE EXCEPTION 'Productivity intervals for one worker cannot overlap' USING ERRCODE='23514';
  END IF;
  IF v_operation.required_skill IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workforce_worker_skills ws
    JOIN workforce_skills s ON s.id=ws.skill_id AND s.tenant_id=ws.tenant_id AND s.factory_id=ws.factory_id
    WHERE ws.worker_id=NEW.worker_id AND ws.tenant_id=NEW.tenant_id AND ws.factory_id=NEW.factory_id
      AND ws.status='ACTIVE' AND s.status='ACTIVE' AND lower(s.skill_code)=lower(v_operation.required_skill)
      AND (ws.certificate_expires_on IS NULL OR ws.certificate_expires_on>=v_assignment.shift_date)
  ) THEN
    RAISE EXCEPTION 'Worker must hold the operation-required skill with a valid certificate' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON TABLE workforce_attendance_corrections IS
  'Append-only, versioned attendance correction overlays. Original reader/manual/QR/API evidence is preserved.';
COMMENT ON VIEW workforce_attendance_events_effective IS
  'Security-invoker effective attendance timeline using the newest correction version per immutable source event.';
COMMENT ON COLUMN workforce_shift_templates.last_change_reason IS
  'Required operator-provided reason for each versioned shift-template edit or activation transition.';

INSERT INTO schema_migrations (version,checksum)
VALUES ('107_workforce_shift_revision_and_attendance_corrections',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
