BEGIN;

CREATE OR REPLACE FUNCTION factoryos_prevent_workforce_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Workforce records are retained for audit; use an explicit lifecycle transition'
    USING ERRCODE = '55000';
END;
$$;

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
    IF COALESCE((v_new->>'row_version')::BIGINT, 1) <> 1 THEN
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

  IF (v_new->>'row_version') IS NULL OR (v_new->>'row_version')::BIGINT <> (v_old->>'row_version')::BIGINT + 1 THEN
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
  IF TG_TABLE_NAME='workforce_workers' AND OLD.status='ACTIVE' AND NEW.status='INACTIVE'
     AND EXISTS (
       SELECT 1 FROM workforce_shift_assignments a
       WHERE a.worker_id=NEW.id AND a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
         AND a.status IN ('PLANNED','CONFIRMED') AND a.planned_end_at>clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'A worker with future active shift assignments cannot be inactivated' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_workforce_shift_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_worker_status VARCHAR(16);
  v_shift_status VARCHAR(16);
  v_required_skill VARCHAR(120);
  v_operation_code VARCHAR(120);
  v_operation_status VARCHAR(20);
  v_order_status VARCHAR(24);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::TEXT || ':' || NEW.factory_id::TEXT || ':' || NEW.worker_id::TEXT || ':workforce-roster', 0
  ));

  SELECT status INTO v_worker_status
  FROM workforce_workers
  WHERE id=NEW.worker_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
  FOR SHARE;
  IF NOT FOUND OR v_worker_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Only an active worker in this factory may be rostered' USING ERRCODE='23514';
  END IF;

  SELECT status INTO v_shift_status
  FROM workforce_shift_templates
  WHERE id=NEW.shift_template_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
  FOR SHARE;
  IF NOT FOUND OR v_shift_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Shift template must be active in the same factory' USING ERRCODE='23514';
  END IF;

  IF NEW.work_order_id IS NOT NULL THEN
    SELECT status INTO v_order_status
    FROM work_orders
    WHERE id=NEW.work_order_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
    FOR SHARE;
    IF NOT FOUND OR v_order_status NOT IN ('RELEASED','IN_PROGRESS','ON_HOLD') THEN
      RAISE EXCEPTION 'Staffing can only link to a released, active or held work order' USING ERRCODE='23514';
    END IF;
  END IF;

  IF NEW.work_order_operation_id IS NOT NULL THEN
    SELECT required_skill, operation_code, status
    INTO v_required_skill, v_operation_code, v_operation_status
    FROM work_order_operations
    WHERE id=NEW.work_order_operation_id
      AND work_order_id=NEW.work_order_id
      AND tenant_id=NEW.tenant_id
      AND factory_id=NEW.factory_id
    FOR SHARE;
    IF NOT FOUND OR v_operation_status NOT IN ('READY','IN_PROGRESS','PAUSED','ON_HOLD') THEN
      RAISE EXCEPTION 'Staffing operation must belong to the same work order and be executable' USING ERRCODE='23514';
    END IF;
    IF NEW.operation_code IS NOT NULL AND NEW.operation_code <> v_operation_code THEN
      RAISE EXCEPTION 'Staffing operation code must match the frozen work-order operation' USING ERRCODE='23514';
    END IF;
    IF v_required_skill IS NOT NULL AND lower(COALESCE(NEW.required_skill_code,'')) <> lower(v_required_skill) THEN
      RAISE EXCEPTION 'Staffing skill must match the operation bulletin requirement' USING ERRCODE='23514';
    END IF;
  END IF;

  IF NEW.required_skill_code IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM workforce_worker_skills wws
    JOIN workforce_skills s
      ON s.id=wws.skill_id AND s.tenant_id=wws.tenant_id AND s.factory_id=wws.factory_id
    WHERE wws.worker_id=NEW.worker_id
      AND wws.tenant_id=NEW.tenant_id AND wws.factory_id=NEW.factory_id
      AND wws.status='ACTIVE' AND s.status='ACTIVE'
      AND lower(s.skill_code)=lower(NEW.required_skill_code)
      AND (wws.certificate_expires_on IS NULL OR wws.certificate_expires_on >= NEW.shift_date)
  ) THEN
    RAISE EXCEPTION 'Worker lacks the required active skill or has an expired certificate' USING ERRCODE='23514';
  END IF;

  IF NEW.status IN ('PLANNED','CONFIRMED') AND EXISTS (
    SELECT 1
    FROM workforce_shift_assignments a
    WHERE a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
      AND a.worker_id=NEW.worker_id AND a.id<>NEW.id
      AND a.status IN ('PLANNED','CONFIRMED')
      AND tstzrange(a.planned_start_at,a.planned_end_at,'[)')
          && tstzrange(NEW.planned_start_at,NEW.planned_end_at,'[)')
  ) THEN
    RAISE EXCEPTION 'A worker cannot be assigned to overlapping active shifts' USING ERRCODE='23514';
  END IF;

  IF TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status='PLANNED' AND NEW.status IN ('CONFIRMED','CANCELLED')) OR
      (OLD.status='CONFIRMED' AND NEW.status IN ('CANCELLED','COMPLETED'))
    ) THEN
      RAISE EXCEPTION 'Invalid staffing transition: % -> %',OLD.status,NEW.status USING ERRCODE='23514';
    END IF;
    IF length(btrim(COALESCE(NEW.last_change_reason,'')))=0 THEN
      RAISE EXCEPTION 'Staffing transitions require an auditable reason' USING ERRCODE='23514';
    END IF;
    IF NEW.status='CANCELLED' AND EXISTS (
      SELECT 1 FROM workforce_attendance_events e
      WHERE e.shift_assignment_id=OLD.id AND e.tenant_id=OLD.tenant_id AND e.factory_id=OLD.factory_id
    ) THEN
      RAISE EXCEPTION 'A shift with attendance evidence cannot be cancelled; record a correction instead' USING ERRCODE='23514';
    END IF;
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
  v_stream RECORD;
  v_previous_type VARCHAR(24);
  v_previous_at TIMESTAMPTZ;
BEGIN
  IF NEW.recorded_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Attendance recorder must match authenticated database context' USING ERRCODE='42501';
  END IF;

  -- Lock the assignment while reconstructing the event stream. Delayed/offline
  -- device events are accepted only when the complete timestamp-ordered stream
  -- remains valid; arrival order does not rewrite event time.
  SELECT a.worker_id,a.status,a.planned_start_at,a.planned_end_at,w.status AS worker_status,
         w.biometric_consent_at,w.biometric_consent_withdrawn_at
  INTO v_assignment
  FROM workforce_shift_assignments a
  JOIN workforce_workers w
    ON w.id=a.worker_id AND w.tenant_id=a.tenant_id AND w.factory_id=a.factory_id
  WHERE a.id=NEW.shift_assignment_id
    AND a.worker_id=NEW.worker_id
    AND a.tenant_id=NEW.tenant_id
    AND a.factory_id=NEW.factory_id
  FOR UPDATE OF a,w;
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
  IF EXISTS (
    SELECT 1 FROM workforce_attendance_events e
    WHERE e.shift_assignment_id=NEW.shift_assignment_id
      AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
      AND e.occurred_at=NEW.occurred_at
  ) THEN
    RAISE EXCEPTION 'Attendance events for one shift must have distinct occurrence timestamps' USING ERRCODE='23514';
  END IF;

  v_previous_type := NULL;
  v_previous_at := NULL;
  FOR v_stream IN
    SELECT stream.event_type,stream.occurred_at,stream.id
    FROM (
      SELECT e.event_type,e.occurred_at,e.id
      FROM workforce_attendance_events e
      WHERE e.shift_assignment_id=NEW.shift_assignment_id
        AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
      UNION ALL
      SELECT NEW.event_type,NEW.occurred_at,NEW.id
    ) AS stream
    ORDER BY stream.occurred_at,stream.id
  LOOP
    IF v_previous_at IS NULL THEN
      IF v_stream.event_type NOT IN ('CLOCK_IN','ABSENCE_RECORDED') THEN
        RAISE EXCEPTION 'First attendance event must be clock-in or an absence record' USING ERRCODE='23514';
      END IF;
    ELSIF v_previous_type='ABSENCE_RECORDED' OR v_previous_type='CLOCK_OUT' THEN
      RAISE EXCEPTION 'No attendance events are allowed after absence or clock-out' USING ERRCODE='23514';
    ELSIF v_previous_type='CLOCK_IN' OR v_previous_type='BREAK_END' THEN
      IF v_stream.event_type NOT IN ('BREAK_START','CLOCK_OUT') THEN
        RAISE EXCEPTION 'Attendance events must follow clock-in, paired breaks and clock-out order' USING ERRCODE='23514';
      END IF;
    ELSIF v_previous_type='BREAK_START' THEN
      IF v_stream.event_type <> 'BREAK_END' THEN
        RAISE EXCEPTION 'A break must end before another break or clock-out can be captured' USING ERRCODE='23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported attendance event sequence' USING ERRCODE='23514';
    END IF;
    v_previous_type := v_stream.event_type;
    v_previous_at := v_stream.occurred_at;
  END LOOP;
  RETURN NEW;
END;
$$;

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
    JOIN workforce_attendance_events e
      ON e.shift_assignment_id=a.id AND e.tenant_id=a.tenant_id AND e.factory_id=a.factory_id
      AND e.event_type='CLOCK_OUT'
    WHERE a.id=NEW.shift_assignment_id AND a.worker_id=NEW.worker_id
      AND a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id;
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
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_assignment RECORD;
  v_operation RECORD;
  v_clock_in TIMESTAMPTZ;
  v_clock_out TIMESTAMPTZ;
  v_duration_minutes NUMERIC;
BEGIN
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Productivity recorder must match authenticated database context' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.shift_assignment_id::text || ':workforce-productivity',0));

  SELECT a.id,a.worker_id,a.work_order_id,a.work_order_operation_id,a.status,a.shift_date
  INTO v_assignment
  FROM workforce_shift_assignments a
  WHERE a.id=NEW.shift_assignment_id AND a.worker_id=NEW.worker_id
    AND a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
  FOR SHARE;
  IF NOT FOUND OR v_assignment.status IN ('CANCELLED','PLANNED') THEN
    RAISE EXCEPTION 'Productivity requires a confirmed/completed worker assignment' USING ERRCODE='23514';
  END IF;
  SELECT id,work_order_id,operation_code,required_skill,status,run_minutes_per_unit
  INTO v_operation
  FROM work_order_operations
  WHERE id=NEW.work_order_operation_id AND work_order_id=NEW.work_order_id
    AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
  FOR SHARE;
  IF NOT FOUND OR v_operation.status NOT IN ('IN_PROGRESS','PAUSED','COMPLETED') THEN
    RAISE EXCEPTION 'Productivity must reference an active or completed work-order operation' USING ERRCODE='23514';
  END IF;
  IF v_operation.run_minutes_per_unit <= 0
     OR NEW.standard_minutes_per_unit <> v_operation.run_minutes_per_unit
     OR NEW.operation_code <> v_operation.operation_code THEN
    RAISE EXCEPTION 'Productivity standard time and operation code must match the frozen routing snapshot' USING ERRCODE='23514';
  END IF;
  IF v_assignment.work_order_id IS NOT NULL AND v_assignment.work_order_id<>NEW.work_order_id THEN
    RAISE EXCEPTION 'Productivity work order must match the worker assignment' USING ERRCODE='23514';
  END IF;
  IF v_assignment.work_order_operation_id IS NOT NULL AND v_assignment.work_order_operation_id<>NEW.work_order_operation_id THEN
    RAISE EXCEPTION 'Productivity operation must match the worker assignment' USING ERRCODE='23514';
  END IF;

  SELECT occurred_at INTO v_clock_in
  FROM workforce_attendance_events
  WHERE shift_assignment_id=NEW.shift_assignment_id AND worker_id=NEW.worker_id
    AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND event_type='CLOCK_IN';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Productivity capture requires a recorded worker clock-in' USING ERRCODE='23514';
  END IF;
  SELECT occurred_at INTO v_clock_out
  FROM workforce_attendance_events
  WHERE shift_assignment_id=NEW.shift_assignment_id AND worker_id=NEW.worker_id
    AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND event_type='CLOCK_OUT';
  IF NEW.production_started_at < v_clock_in
     OR (v_clock_out IS NOT NULL AND NEW.production_ended_at > v_clock_out) THEN
    RAISE EXCEPTION 'Productivity interval must be contained inside recorded attendance' USING ERRCODE='23514';
  END IF;
  v_duration_minutes := EXTRACT(EPOCH FROM (NEW.production_ended_at-NEW.production_started_at))/60;
  IF NEW.actual_minutes > v_duration_minutes THEN
    RAISE EXCEPTION 'Actual labor minutes cannot exceed the captured production interval' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM workforce_productivity_reports p
    WHERE p.shift_assignment_id=NEW.shift_assignment_id AND p.worker_id=NEW.worker_id
      AND p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id
      AND tstzrange(p.production_started_at,p.production_ended_at,'[)')
          && tstzrange(NEW.production_started_at,NEW.production_ended_at,'[)')
  ) THEN
    RAISE EXCEPTION 'Productivity labor intervals for a worker cannot overlap' USING ERRCODE='23514';
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

CREATE OR REPLACE FUNCTION factoryos_append_workforce_audit_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_actor UUID;
  v_entity_type VARCHAR(48);
  v_action VARCHAR(48);
  v_version BIGINT;
  v_event_data JSONB;
BEGIN
  v_entity_type := CASE TG_TABLE_NAME
    WHEN 'workforce_workers' THEN 'WORKER'
    WHEN 'workforce_skills' THEN 'SKILL'
    WHEN 'workforce_worker_skills' THEN 'WORKER_SKILL'
    WHEN 'workforce_shift_templates' THEN 'SHIFT_TEMPLATE'
    WHEN 'workforce_shift_assignments' THEN 'SHIFT_ASSIGNMENT'
    WHEN 'workforce_attendance_events' THEN 'ATTENDANCE_EVENT'
    WHEN 'workforce_overtime_requests' THEN 'OVERTIME_REQUEST'
    WHEN 'workforce_productivity_reports' THEN 'PRODUCTIVITY_REPORT'
    WHEN 'workforce_biometric_consent_events' THEN 'BIOMETRIC_CONSENT'
    ELSE NULL
  END;
  v_actor := COALESCE(
    NULLIF(v_row->>'updated_by_user_id','')::UUID,
    NULLIF(v_row->>'created_by_user_id','')::UUID,
    NULLIF(v_row->>'recorded_by_user_id','')::UUID,
    NULLIF(v_row->>'decided_by_user_id','')::UUID,
    factoryos_current_user_id()
  );
  v_version := COALESCE(NULLIF(v_row->>'row_version','')::BIGINT,1);
  v_action := CASE
    WHEN TG_TABLE_NAME='workforce_biometric_consent_events'
      THEN CASE WHEN COALESCE((v_row->>'consent_granted')::BOOLEAN,FALSE) THEN 'CONSENT_GRANTED' ELSE 'CONSENT_WITHDRAWN' END
    WHEN TG_TABLE_NAME='workforce_attendance_events' THEN COALESCE(v_row->>'event_type','ATTENDANCE_CAPTURED')
    WHEN TG_OP='INSERT' THEN 'CREATED'
    ELSE 'UPDATED'
  END;
  v_event_data := jsonb_strip_nulls(jsonb_build_object(
    'status',v_row->>'status',
    'row_version',v_version,
    'event_type',v_row->>'event_type',
    'source_type',v_row->>'source_type',
    'operation_code',v_row->>'operation_code',
    'requested_minutes',v_row->>'requested_minutes',
    'approved_minutes',v_row->>'approved_minutes',
    'consent_granted',v_row->>'consent_granted'
  ));
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Workforce audit requires an authenticated actor' USING ERRCODE='42501';
  END IF;
  INSERT INTO workforce_audit_events (
    tenant_id,factory_id,entity_type,entity_id,entity_version,action,actor_user_id,reason,event_data,correlation_id
  ) VALUES (
    (v_row->>'tenant_id')::UUID,(v_row->>'factory_id')::UUID,v_entity_type,
    (v_row->>'id')::UUID,v_version,v_action,v_actor,
    COALESCE(v_row->>'last_change_reason',v_row->>'reason',v_row->>'decision_reason'),
    v_event_data,NULLIF(v_row->>'correlation_id','')::UUID
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_prevent_workforce_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Attendance, productivity, biometric-consent and audit evidence are append-only'
    USING ERRCODE='55000';
END;
$$;

-- Worker/skill/shift/roster masters are versioned. Evidence tables are immutable.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workforce_workers','workforce_skills','workforce_worker_skills','workforce_shift_templates',
    'workforce_shift_assignments','workforce_attendance_events','workforce_overtime_requests',
    'workforce_productivity_reports','workforce_biometric_consent_events','workforce_audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id())',
      t||'_tenant_isolation',t);
  END LOOP;
END;
$$;

CREATE TRIGGER trg_workforce_worker_version_guard
BEFORE INSERT OR UPDATE ON workforce_workers
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_workforce_row_version();
CREATE TRIGGER trg_workforce_skill_version_guard
BEFORE INSERT OR UPDATE ON workforce_skills
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_workforce_row_version();
CREATE TRIGGER trg_workforce_worker_skill_version_guard
BEFORE INSERT OR UPDATE ON workforce_worker_skills
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_workforce_row_version();
CREATE TRIGGER trg_workforce_shift_template_version_guard
BEFORE INSERT OR UPDATE ON workforce_shift_templates
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_workforce_row_version();
CREATE TRIGGER trg_workforce_assignment_version_guard
BEFORE INSERT OR UPDATE ON workforce_shift_assignments
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_workforce_row_version();
CREATE TRIGGER trg_workforce_assignment_scope_guard
BEFORE INSERT OR UPDATE ON workforce_shift_assignments
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_workforce_shift_assignment();
CREATE TRIGGER trg_workforce_attendance_event_guard
BEFORE INSERT ON workforce_attendance_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_workforce_attendance_event();
CREATE TRIGGER trg_workforce_overtime_guard
BEFORE INSERT OR UPDATE ON workforce_overtime_requests
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_workforce_overtime();
CREATE TRIGGER trg_workforce_productivity_guard
BEFORE INSERT ON workforce_productivity_reports
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_workforce_productivity();

CREATE TRIGGER trg_workforce_workers_audit
AFTER INSERT OR UPDATE ON workforce_workers
FOR EACH ROW EXECUTE FUNCTION factoryos_append_workforce_audit_event();
CREATE TRIGGER trg_workforce_skills_audit
AFTER INSERT OR UPDATE ON workforce_skills
FOR EACH ROW EXECUTE FUNCTION factoryos_append_workforce_audit_event();
CREATE TRIGGER trg_workforce_worker_skills_audit
AFTER INSERT OR UPDATE ON workforce_worker_skills
FOR EACH ROW EXECUTE FUNCTION factoryos_append_workforce_audit_event();
CREATE TRIGGER trg_workforce_shifts_audit
AFTER INSERT OR UPDATE ON workforce_shift_templates
FOR EACH ROW EXECUTE FUNCTION factoryos_append_workforce_audit_event();
CREATE TRIGGER trg_workforce_assignments_audit
AFTER INSERT OR UPDATE ON workforce_shift_assignments
FOR EACH ROW EXECUTE FUNCTION factoryos_append_workforce_audit_event();
CREATE TRIGGER trg_workforce_attendance_audit
AFTER INSERT ON workforce_attendance_events
FOR EACH ROW EXECUTE FUNCTION factoryos_append_workforce_audit_event();
CREATE TRIGGER trg_workforce_overtime_audit
AFTER INSERT OR UPDATE ON workforce_overtime_requests
FOR EACH ROW EXECUTE FUNCTION factoryos_append_workforce_audit_event();
CREATE TRIGGER trg_workforce_productivity_audit
AFTER INSERT ON workforce_productivity_reports
FOR EACH ROW EXECUTE FUNCTION factoryos_append_workforce_audit_event();
CREATE TRIGGER trg_workforce_biometric_consent_audit
AFTER INSERT ON workforce_biometric_consent_events
FOR EACH ROW EXECUTE FUNCTION factoryos_append_workforce_audit_event();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workforce_workers','workforce_skills','workforce_worker_skills','workforce_shift_templates',
    'workforce_shift_assignments','workforce_attendance_events','workforce_overtime_requests',
    'workforce_productivity_reports','workforce_biometric_consent_events','workforce_audit_events'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_workforce_delete()',
      'trg_'||t||'_delete_guard',t);
  END LOOP;
END;
$$;

CREATE TRIGGER trg_workforce_attendance_evidence_immutable
BEFORE UPDATE OR DELETE ON workforce_attendance_events
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_workforce_evidence_mutation();
CREATE TRIGGER trg_workforce_productivity_evidence_immutable
BEFORE UPDATE OR DELETE ON workforce_productivity_reports
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_workforce_evidence_mutation();
CREATE TRIGGER trg_workforce_biometric_consent_immutable
BEFORE UPDATE OR DELETE ON workforce_biometric_consent_events
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_workforce_evidence_mutation();
CREATE TRIGGER trg_workforce_audit_evidence_immutable
BEFORE UPDATE OR DELETE ON workforce_audit_events
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_workforce_evidence_mutation();

INSERT INTO schema_migrations (version, checksum)
VALUES ('103_workforce_lifecycle_audit_guards', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
