BEGIN;

-- A worker's current biometric-consent state is a projection of append-only consent evidence.
CREATE OR REPLACE FUNCTION factoryos_guard_workforce_row_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_new JSONB := to_jsonb(NEW);
  v_old JSONB := to_jsonb(OLD);
  v_actor UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME NOT IN ('workforce_attendance_events','workforce_productivity_reports','workforce_biometric_consent_events')
       AND COALESCE((v_new->>'row_version')::BIGINT,1) <> 1 THEN
      RAISE EXCEPTION 'New workforce records must start at row_version 1' USING ERRCODE='23514';
    END IF;
    v_actor := COALESCE(
      NULLIF(v_new->>'created_by_user_id','')::UUID,
      NULLIF(v_new->>'recorded_by_user_id','')::UUID,
      NULLIF(v_new->>'actor_user_id','')::UUID
    );
    IF v_actor IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'Workforce record creator must match authenticated database context' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;

  IF (v_new->>'row_version') IS NULL
     OR (v_new->>'row_version')::BIGINT <> (v_old->>'row_version')::BIGINT + 1 THEN
    RAISE EXCEPTION 'Workforce updates must increment row_version exactly once' USING ERRCODE='23514';
  END IF;
  v_actor := NULLIF(v_new->>'updated_by_user_id','')::UUID;
  IF v_actor IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Workforce updater must match authenticated database context' USING ERRCODE='42501';
  END IF;
  IF v_new->>'id' IS DISTINCT FROM v_old->>'id'
     OR v_new->>'tenant_id' IS DISTINCT FROM v_old->>'tenant_id'
     OR v_new->>'factory_id' IS DISTINCT FROM v_old->>'factory_id'
     OR v_new->>'created_at' IS DISTINCT FROM v_old->>'created_at'
     OR v_new->>'created_by_user_id' IS DISTINCT FROM v_old->>'created_by_user_id'
     OR v_new->>'idempotency_key' IS DISTINCT FROM v_old->>'idempotency_key'
     OR v_new->>'request_hash' IS DISTINCT FROM v_old->>'request_hash'
     OR v_new->>'correlation_id' IS DISTINCT FROM v_old->>'correlation_id' THEN
    RAISE EXCEPTION 'Workforce identity, scope and creation evidence are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='workforce_workers'
     AND (NEW.biometric_consent_at IS DISTINCT FROM OLD.biometric_consent_at
       OR NEW.biometric_consent_withdrawn_at IS DISTINCT FROM OLD.biometric_consent_withdrawn_at)
     AND NULLIF(current_setting('app.workforce_consent_event_id',true),'')
       IS DISTINCT FROM (
         SELECT e.id::TEXT FROM workforce_biometric_consent_events e
         WHERE e.worker_id=NEW.id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
           AND e.recorded_by_user_id=factoryos_current_user_id()
         ORDER BY e.created_at DESC,e.id DESC LIMIT 1
       ) THEN
    RAISE EXCEPTION 'Biometric-consent state may only change through consent evidence' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;

-- Breaks may repeat; all timestamp-effective events must still form one legal shift timeline.
CREATE OR REPLACE FUNCTION factoryos_guard_workforce_attendance_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_assignment RECORD;
  v_item RECORD;
  v_state VARCHAR(24) := 'OFF_SHIFT';
  v_previous_time TIMESTAMPTZ;
BEGIN
  IF NEW.recorded_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Attendance recorder must match authenticated database context' USING ERRCODE='42501';
  END IF;
  SELECT a.status,a.planned_start_at,a.planned_end_at,w.status AS worker_status,
         w.biometric_consent_at,w.biometric_consent_withdrawn_at
  INTO v_assignment
  FROM workforce_shift_assignments a
  JOIN workforce_workers w ON w.id=a.worker_id AND w.tenant_id=a.tenant_id AND w.factory_id=a.factory_id
  WHERE a.id=NEW.shift_assignment_id AND a.worker_id=NEW.worker_id
    AND a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
  FOR SHARE OF a,w;
  IF NOT FOUND OR v_assignment.status='CANCELLED' THEN
    RAISE EXCEPTION 'Attendance requires a non-cancelled worker assignment' USING ERRCODE='23514';
  END IF;
  IF v_assignment.worker_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Attendance cannot be captured for an inactive worker' USING ERRCODE='23514';
  END IF;
  IF NEW.occurred_at < v_assignment.planned_start_at - INTERVAL '12 hours'
     OR NEW.occurred_at > v_assignment.planned_end_at + INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'Attendance timestamp is outside the shift capture window' USING ERRCODE='23514';
  END IF;
  IF NEW.source_type='BIOMETRIC' AND (
    v_assignment.biometric_consent_at IS NULL
    OR (v_assignment.biometric_consent_withdrawn_at IS NOT NULL
      AND v_assignment.biometric_consent_withdrawn_at >= v_assignment.biometric_consent_at)
  ) THEN
    RAISE EXCEPTION 'Biometric attendance requires current explicit worker consent' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(NEW.capture_metadata) <> 'object' THEN
    RAISE EXCEPTION 'Attendance metadata must be a JSON object' USING ERRCODE='23514';
  END IF;

  FOR v_item IN
    SELECT e.event_type,e.occurred_at,e.id
    FROM workforce_attendance_events e
    WHERE e.shift_assignment_id=NEW.shift_assignment_id
      AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
    UNION ALL
    SELECT NEW.event_type,NEW.occurred_at,NEW.id
    ORDER BY occurred_at,id
  LOOP
    IF v_previous_time IS NOT NULL AND v_item.occurred_at<=v_previous_time THEN
      RAISE EXCEPTION 'Attendance timestamps must be strictly increasing' USING ERRCODE='23514';
    END IF;
    v_previous_time:=v_item.occurred_at;
    IF v_item.event_type='CLOCK_IN' AND v_state='OFF_SHIFT' THEN
      v_state:='ON_SHIFT';
    ELSIF v_item.event_type='BREAK_START' AND v_state='ON_SHIFT' THEN
      v_state:='ON_BREAK';
    ELSIF v_item.event_type='BREAK_END' AND v_state='ON_BREAK' THEN
      v_state:='ON_SHIFT';
    ELSIF v_item.event_type='CLOCK_OUT' AND v_state='ON_SHIFT' THEN
      v_state:='CLOCKED_OUT';
    ELSIF v_item.event_type='ABSENCE_RECORDED' AND v_state='OFF_SHIFT' THEN
      v_state:='ABSENT';
    ELSE
      RAISE EXCEPTION 'Invalid attendance sequence: % while %',v_item.event_type,v_state USING ERRCODE='23514';
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
CREATE POLICY workforce_attendance_corrections_tenant_isolation ON workforce_attendance_corrections
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE workforce_audit_events DROP CONSTRAINT chk_workforce_audit_entity_type;
ALTER TABLE workforce_audit_events ADD CONSTRAINT chk_workforce_audit_entity_type CHECK (entity_type IN (
  'WORKER','SKILL','WORKER_SKILL','SHIFT_TEMPLATE','SHIFT_ASSIGNMENT','ATTENDANCE_EVENT',
  'ATTENDANCE_CORRECTION','OVERTIME_REQUEST','PRODUCTIVITY_REPORT','BIOMETRIC_CONSENT'
));

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
    WHEN 'workforce_attendance_corrections' THEN 'ATTENDANCE_CORRECTION'
    WHEN 'workforce_overtime_requests' THEN 'OVERTIME_REQUEST'
    WHEN 'workforce_productivity_reports' THEN 'PRODUCTIVITY_REPORT'
    WHEN 'workforce_biometric_consent_events' THEN 'BIOMETRIC_CONSENT'
    ELSE NULL
  END;
  v_actor := COALESCE(
    NULLIF(v_row->>'updated_by_user_id','')::UUID,
    NULLIF(v_row->>'created_by_user_id','')::UUID,
    NULLIF(v_row->>'recorded_by_user_id','')::UUID,
    NULLIF(v_row->>'corrected_by_user_id','')::UUID,
    NULLIF(v_row->>'decided_by_user_id','')::UUID,
    NULLIF(v_row->>'actor_user_id','')::UUID,
    factoryos_current_user_id()
  );
  v_version := COALESCE(NULLIF(v_row->>'row_version','')::BIGINT,NULLIF(v_row->>'correction_version','')::BIGINT,1);
  v_action := CASE
    WHEN TG_TABLE_NAME='workforce_biometric_consent_events'
      THEN CASE WHEN COALESCE((v_row->>'consent_granted')::BOOLEAN,FALSE) THEN 'CONSENT_GRANTED' ELSE 'CONSENT_WITHDRAWN' END
    WHEN TG_TABLE_NAME='workforce_attendance_events' THEN COALESCE(v_row->>'event_type','ATTENDANCE_CAPTURED')
    WHEN TG_TABLE_NAME='workforce_attendance_corrections' THEN 'CORRECTED'
    WHEN TG_TABLE_NAME='workforce_overtime_requests' AND TG_OP='UPDATE' THEN COALESCE(v_row->>'status','UPDATED')
    WHEN TG_OP='INSERT' THEN 'CREATED'
    ELSE 'UPDATED'
  END;
  v_event_data := jsonb_strip_nulls(jsonb_build_object(
    'status',v_row->>'status','row_version',v_version,'event_type',v_row->>'event_type',
    'source_type',v_row->>'source_type','operation_code',v_row->>'operation_code',
    'requested_minutes',v_row->>'requested_minutes','approved_minutes',v_row->>'approved_minutes',
    'consent_granted',v_row->>'consent_granted','original_event_id',v_row->>'original_event_id',
    'correction_version',v_row->>'correction_version','corrected_event_type',v_row->>'corrected_event_type',
    'good_quantity',v_row->>'good_quantity','scrap_quantity',v_row->>'scrap_quantity',
    'efficiency_percent',v_row->>'efficiency_percent'
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

CREATE OR REPLACE FUNCTION factoryos_guard_workforce_attendance_correction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_original RECORD;
  v_last RECORD;
  v_item RECORD;
  v_state VARCHAR(24) := 'OFF_SHIFT';
  v_previous_time TIMESTAMPTZ;
BEGIN
  IF NEW.corrected_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Attendance correction actor must match authenticated database context' USING ERRCODE='42501';
  END IF;
  SELECT e.worker_id,e.shift_assignment_id,a.planned_start_at,a.planned_end_at
  INTO v_original
  FROM workforce_attendance_events e
  JOIN workforce_shift_assignments a ON a.id=e.shift_assignment_id AND a.tenant_id=e.tenant_id AND a.factory_id=e.factory_id
  WHERE e.id=NEW.original_event_id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
  FOR SHARE OF e,a;
  IF NOT FOUND OR v_original.worker_id<>NEW.worker_id OR v_original.shift_assignment_id<>NEW.shift_assignment_id THEN
    RAISE EXCEPTION 'Correction must refer to its original worker and shift' USING ERRCODE='23503';
  END IF;
  IF NEW.corrected_occurred_at < v_original.planned_start_at - INTERVAL '12 hours'
     OR NEW.corrected_occurred_at > v_original.planned_end_at + INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'Corrected timestamp is outside the shift capture window' USING ERRCODE='23514';
  END IF;

  SELECT c.id,c.correction_version INTO v_last
  FROM workforce_attendance_corrections c
  WHERE c.original_event_id=NEW.original_event_id AND c.tenant_id=NEW.tenant_id AND c.factory_id=NEW.factory_id
  ORDER BY c.correction_version DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    IF NEW.correction_version<>1 OR NEW.supersedes_correction_id IS NOT NULL THEN
      RAISE EXCEPTION 'First correction must start at version 1' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.correction_version<>v_last.correction_version+1 OR NEW.supersedes_correction_id IS DISTINCT FROM v_last.id THEN
    RAISE EXCEPTION 'Correction must append to the latest version exactly once' USING ERRCODE='23514';
  END IF;

  FOR v_item IN
    WITH ranked_corrections AS (
      SELECT DISTINCT ON (c.original_event_id) c.original_event_id,c.corrected_event_type,c.corrected_occurred_at
      FROM workforce_attendance_corrections c
      WHERE c.tenant_id=NEW.tenant_id AND c.factory_id=NEW.factory_id
        AND c.shift_assignment_id=NEW.shift_assignment_id AND c.original_event_id<>NEW.original_event_id
      ORDER BY c.original_event_id,c.correction_version DESC
    ), effective AS (
      SELECT e.id,
        CASE WHEN e.id=NEW.original_event_id THEN NEW.corrected_event_type ELSE COALESCE(c.corrected_event_type,e.event_type) END AS event_type,
        CASE WHEN e.id=NEW.original_event_id THEN NEW.corrected_occurred_at ELSE COALESCE(c.corrected_occurred_at,e.occurred_at) END AS occurred_at
      FROM workforce_attendance_events e
      LEFT JOIN ranked_corrections c ON c.original_event_id=e.id
      WHERE e.shift_assignment_id=NEW.shift_assignment_id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
    )
    SELECT event_type,occurred_at,id FROM effective ORDER BY occurred_at,id
  LOOP
    IF v_previous_time IS NOT NULL AND v_item.occurred_at<=v_previous_time THEN
      RAISE EXCEPTION 'Correction creates duplicate or descending timestamps' USING ERRCODE='23514';
    END IF;
    v_previous_time:=v_item.occurred_at;
    IF v_item.event_type='CLOCK_IN' AND v_state='OFF_SHIFT' THEN
      v_state:='ON_SHIFT';
    ELSIF v_item.event_type='BREAK_START' AND v_state='ON_SHIFT' THEN
      v_state:='ON_BREAK';
    ELSIF v_item.event_type='BREAK_END' AND v_state='ON_BREAK' THEN
      v_state:='ON_SHIFT';
    ELSIF v_item.event_type='CLOCK_OUT' AND v_state='ON_SHIFT' THEN
      v_state:='CLOCKED_OUT';
    ELSIF v_item.event_type='ABSENCE_RECORDED' AND v_state='OFF_SHIFT' THEN
      v_state:='ABSENT';
    ELSE
      RAISE EXCEPTION 'Correction creates invalid attendance sequence: % while %',v_item.event_type,v_state USING ERRCODE='23514';
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
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.workforce_consent_event_id',NEW.id::TEXT,true);
  IF NEW.consent_granted THEN
    UPDATE workforce_workers
    SET biometric_consent_at=NEW.created_at,biometric_consent_withdrawn_at=NULL,
        row_version=row_version+1,updated_by_user_id=NEW.recorded_by_user_id,
        last_change_reason=NEW.reason,updated_at=clock_timestamp()
    WHERE id=NEW.worker_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  ELSE
    UPDATE workforce_workers
    SET biometric_consent_withdrawn_at=NEW.created_at,row_version=row_version+1,
        updated_by_user_id=NEW.recorded_by_user_id,last_change_reason=NEW.reason,updated_at=clock_timestamp()
    WHERE id=NEW.worker_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consent worker must exist in the same factory' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_workforce_consent_projection
AFTER INSERT ON workforce_biometric_consent_events
FOR EACH ROW EXECUTE FUNCTION factoryos_apply_biometric_consent_event();

CREATE OR REPLACE FUNCTION factoryos_guard_workforce_productivity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_assignment RECORD;
  v_operation RECORD;
  v_report RECORD;
  v_clock_in TIMESTAMPTZ;
  v_clock_out TIMESTAMPTZ;
  v_prior_good NUMERIC(18,4);
  v_prior_scrap NUMERIC(18,4);
BEGIN
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Productivity recorder must match authenticated database context' USING ERRCODE='42501';
  END IF;
  IF NEW.actual_minutes > EXTRACT(EPOCH FROM (NEW.production_ended_at-NEW.production_started_at))/60 THEN
    RAISE EXCEPTION 'Actual labor minutes cannot exceed the recorded production interval' USING ERRCODE='23514';
  END IF;

  SELECT r.work_order_id,r.work_order_operation_id,r.good_quantity,r.scrap_quantity
  INTO v_report
  FROM order_production_reports r
  WHERE r.id=NEW.production_report_id AND r.tenant_id=NEW.tenant_id AND r.factory_id=NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND OR v_report.work_order_id IS DISTINCT FROM NEW.work_order_id
     OR v_report.work_order_operation_id IS DISTINCT FROM NEW.work_order_operation_id THEN
    RAISE EXCEPTION 'Operator report must reference the same canonical operation output report' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(p.good_quantity),0),COALESCE(SUM(p.scrap_quantity),0)
  INTO v_prior_good,v_prior_scrap
  FROM workforce_productivity_reports p
  WHERE p.production_report_id=NEW.production_report_id AND p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id;
  IF v_prior_good+NEW.good_quantity>v_report.good_quantity
     OR v_prior_scrap+NEW.scrap_quantity>v_report.scrap_quantity THEN
    RAISE EXCEPTION 'Worker-attributed output cannot exceed canonical production quantities' USING ERRCODE='23514';
  END IF;

  SELECT a.work_order_id,a.work_order_operation_id,a.status,a.shift_date
  INTO v_assignment
  FROM workforce_shift_assignments a
  WHERE a.id=NEW.shift_assignment_id AND a.worker_id=NEW.worker_id
    AND a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
  FOR SHARE;
  IF NOT FOUND OR v_assignment.status IN ('CANCELLED','PLANNED') THEN
    RAISE EXCEPTION 'Productivity requires a confirmed or completed assignment' USING ERRCODE='23514';
  END IF;
  SELECT op.id,op.work_order_id,op.operation_code,op.required_skill,op.status,op.run_minutes_per_unit
  INTO v_operation
  FROM work_order_operations op
  WHERE op.id=NEW.work_order_operation_id AND op.work_order_id=NEW.work_order_id
    AND op.tenant_id=NEW.tenant_id AND op.factory_id=NEW.factory_id
  FOR SHARE;
  IF NOT FOUND OR v_operation.status NOT IN ('IN_PROGRESS','PAUSED','COMPLETED') THEN
    RAISE EXCEPTION 'Productivity requires an active or completed operation' USING ERRCODE='23514';
  END IF;
  IF v_operation.run_minutes_per_unit<=0
     OR NEW.standard_minutes_per_unit<>v_operation.run_minutes_per_unit
     OR NEW.operation_code<>v_operation.operation_code THEN
    RAISE EXCEPTION 'Standard time and operation code must match the frozen routing snapshot' USING ERRCODE='23514';
  END IF;
  IF v_assignment.work_order_id IS NOT NULL AND v_assignment.work_order_id<>NEW.work_order_id THEN
    RAISE EXCEPTION 'Productivity work order does not match the assignment' USING ERRCODE='23514';
  END IF;
  IF v_assignment.work_order_operation_id IS NOT NULL AND v_assignment.work_order_operation_id<>NEW.work_order_operation_id THEN
    RAISE EXCEPTION 'Productivity operation does not match the assignment' USING ERRCODE='23514';
  END IF;
  SELECT MIN(e.occurred_at) FILTER (WHERE e.event_type='CLOCK_IN'),
         MAX(e.occurred_at) FILTER (WHERE e.event_type='CLOCK_OUT')
  INTO v_clock_in,v_clock_out
  FROM workforce_attendance_events e
  WHERE e.shift_assignment_id=NEW.shift_assignment_id AND e.worker_id=NEW.worker_id
    AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id;
  IF v_clock_in IS NULL THEN
    RAISE EXCEPTION 'Productivity requires recorded clock-in evidence' USING ERRCODE='23514';
  END IF;
  IF NEW.production_started_at<v_clock_in OR (v_clock_out IS NOT NULL AND NEW.production_ended_at>v_clock_out) THEN
    RAISE EXCEPTION 'Productivity interval must fit inside recorded attendance' USING ERRCODE='23514';
  END IF;
  IF v_operation.required_skill IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workforce_worker_skills ws
    JOIN workforce_skills s ON s.id=ws.skill_id AND s.tenant_id=ws.tenant_id AND s.factory_id=ws.factory_id
    WHERE ws.worker_id=NEW.worker_id AND ws.tenant_id=NEW.tenant_id AND ws.factory_id=NEW.factory_id
      AND ws.status='ACTIVE' AND s.status='ACTIVE'
      AND lower(s.skill_code)=lower(v_operation.required_skill)
      AND (ws.certificate_expires_on IS NULL OR ws.certificate_expires_on>=v_assignment.shift_date)
  ) THEN
    RAISE EXCEPTION 'Worker must hold the required skill with a valid certificate' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON TABLE workforce_attendance_corrections IS
  'Append-only, versioned correction overlays for attendance events; original source evidence is never rewritten.';
COMMENT ON TABLE workforce_productivity_reports IS
  'Immutable worker-attributed output tied to canonical production reports, with earned minutes and efficiency derived from the routing standard.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('104_workforce_attendance_corrections_and_consent_projection', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
