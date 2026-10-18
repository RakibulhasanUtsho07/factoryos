BEGIN;

-- Separate consent effective time from ingestion/audit time. This matters when a
-- biometric reader uploads an offline event after a worker has withdrawn consent
-- or has granted consent again.
ALTER TABLE workforce_biometric_consent_events
  ADD COLUMN effective_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();

CREATE OR REPLACE FUNCTION factoryos_guard_workforce_biometric_consent_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_worker RECORD;
  v_previous_consent BOOLEAN;
BEGIN
  IF NEW.recorded_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Biometric consent actor must match authenticated database context' USING ERRCODE='42501';
  END IF;
  IF NEW.effective_at > clock_timestamp()+INTERVAL '5 minutes'
     OR NEW.effective_at < clock_timestamp()-INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'Biometric consent cannot be future-dated or backdated; correction requires a separately governed request'
      USING ERRCODE='23514';
  END IF;

  SELECT w.status,w.biometric_consent_at,w.biometric_consent_withdrawn_at,w.updated_by_user_id
  INTO v_worker
  FROM workforce_workers w
  WHERE w.id=NEW.worker_id AND w.tenant_id=NEW.tenant_id AND w.factory_id=NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND OR v_worker.status<>'ACTIVE' THEN
    RAISE EXCEPTION 'Consent can only be recorded for an active worker in the same factory' USING ERRCODE='23514';
  END IF;
  IF v_worker.updated_by_user_id IS DISTINCT FROM NEW.recorded_by_user_id THEN
    RAISE EXCEPTION 'Consent projection and consent recorder must use the same authenticated actor' USING ERRCODE='42501';
  END IF;

  SELECT e.consent_granted INTO v_previous_consent
  FROM workforce_biometric_consent_events e
  WHERE e.worker_id=NEW.worker_id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
  ORDER BY e.effective_at DESC,e.created_at DESC,e.id DESC
  LIMIT 1;
  IF FOUND AND v_previous_consent=NEW.consent_granted THEN
    RAISE EXCEPTION 'Biometric consent must change state before a new consent event can be recorded' USING ERRCODE='23514';
  END IF;

  IF NEW.consent_granted THEN
    IF v_worker.biometric_consent_at IS NULL OR v_worker.biometric_consent_withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'Grant evidence requires the worker consent projection to be active' USING ERRCODE='23514';
    END IF;
  ELSE
    IF v_worker.biometric_consent_at IS NULL OR v_worker.biometric_consent_withdrawn_at IS NULL
       OR v_worker.biometric_consent_withdrawn_at<v_worker.biometric_consent_at THEN
      RAISE EXCEPTION 'Withdrawal evidence requires a currently withdrawn consent projection' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_workforce_biometric_consent_actor_guard
BEFORE INSERT ON workforce_biometric_consent_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_workforce_biometric_consent_event();

CREATE OR REPLACE FUNCTION factoryos_guard_workforce_attendance_event()
RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF jsonb_typeof(NEW.capture_metadata)<>'object' THEN
    RAISE EXCEPTION 'Attendance capture metadata must be a JSON object' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM workforce_attendance_events e
    WHERE e.shift_assignment_id=NEW.shift_assignment_id AND e.tenant_id=NEW.tenant_id
      AND e.factory_id=NEW.factory_id AND e.occurred_at=NEW.occurred_at) THEN
    RAISE EXCEPTION 'Attendance events for one shift must have distinct occurrence timestamps' USING ERRCODE='23514';
  END IF;

  v_previous_type:=NULL;
  v_previous_at:=NULL;
  FOR v_stream IN
    SELECT stream.event_type,stream.occurred_at,stream.id FROM (
      SELECT e.event_type,e.occurred_at,e.id FROM workforce_attendance_events e
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

-- Every operator attribution must point to one immutable operation event. This
-- prevents output from being invented or counted against multiple source events.
ALTER TABLE workforce_productivity_reports
  ADD COLUMN source_operation_event_id UUID;
ALTER TABLE workforce_productivity_reports
  ADD CONSTRAINT fk_workforce_productivity_source_event
    FOREIGN KEY (source_operation_event_id,tenant_id,factory_id)
    REFERENCES work_order_events(id,tenant_id,factory_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX uq_workforce_productivity_source_event_worker
  ON workforce_productivity_reports (source_operation_event_id,worker_id)
  WHERE source_operation_event_id IS NOT NULL;

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
  FROM workforce_attendance_events
  WHERE shift_assignment_id=NEW.shift_assignment_id AND worker_id=NEW.worker_id
    AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND event_type='CLOCK_IN';
  IF NOT FOUND THEN RAISE EXCEPTION 'Productivity requires recorded clock-in evidence' USING ERRCODE='23514'; END IF;
  SELECT occurred_at INTO v_clock_out
  FROM workforce_attendance_events
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

CREATE OR REPLACE FUNCTION factoryos_append_workforce_audit_event()
RETURNS trigger LANGUAGE plpgsql AS $$
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
    NULLIF(v_row->>'actor_user_id','')::UUID,
    factoryos_current_user_id()
  );
  v_version := COALESCE(NULLIF(v_row->>'row_version','')::BIGINT,1);
  v_action := CASE
    WHEN TG_TABLE_NAME='workforce_biometric_consent_events'
      THEN CASE WHEN COALESCE((v_row->>'consent_granted')::BOOLEAN,FALSE) THEN 'CONSENT_GRANTED' ELSE 'CONSENT_WITHDRAWN' END
    WHEN TG_TABLE_NAME='workforce_attendance_events' THEN COALESCE(v_row->>'event_type','ATTENDANCE_CAPTURED')
    WHEN TG_TABLE_NAME='workforce_overtime_requests' AND TG_OP='UPDATE' THEN COALESCE(v_row->>'status','UPDATED')
    WHEN TG_OP='INSERT' THEN 'CREATED'
    ELSE 'UPDATED'
  END;
  v_event_data := jsonb_strip_nulls(jsonb_build_object(
    'status',v_row->>'status','row_version',v_version,'event_type',v_row->>'event_type',
    'source_type',v_row->>'source_type','operation_code',v_row->>'operation_code',
    'requested_minutes',v_row->>'requested_minutes','approved_minutes',v_row->>'approved_minutes',
    'consent_granted',v_row->>'consent_granted','effective_at',v_row->>'effective_at',
    'source_operation_event_id',v_row->>'source_operation_event_id',
    'good_quantity',v_row->>'good_quantity','scrap_quantity',v_row->>'scrap_quantity',
    'earned_minutes',v_row->>'earned_minutes','efficiency_percent',v_row->>'efficiency_percent'
  ));
  IF v_actor IS NULL OR v_entity_type IS NULL THEN
    RAISE EXCEPTION 'Workforce audit requires a known entity and authenticated actor' USING ERRCODE='42501';
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

COMMENT ON COLUMN workforce_biometric_consent_events.effective_at IS
  'Consent state effective time. Distinct from created_at so delayed biometric events can be validated against the consent state in effect when they occurred.';
COMMENT ON COLUMN workforce_productivity_reports.source_operation_event_id IS
  'Immutable shop-floor OUTPUT_REPORTED or WIP_TRANSFERRED event whose quantities this worker report attributes; each event quantity is split across workers, never duplicated.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('106_workforce_consent_timeline_and_output_attribution', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
