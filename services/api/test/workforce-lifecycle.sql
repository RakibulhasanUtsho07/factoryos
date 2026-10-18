-- Behavioral contract for shift roster, ordered attendance, consent, overtime and immutable receipts.
BEGIN;

SELECT set_config('app.tenant_id','faaab63d-c447-46ce-950d-deebdd7f5f30',true);
SELECT set_config('app.user_id','921382b8-e83f-43ab-a576-e3db6a06b70c',true);

DO $workforce_lifecycle$
DECLARE
  v_actor UUID := factoryos_current_user_id();
  v_tenant UUID := 'faaab63d-c447-46ce-950d-deebdd7f5f30';
  v_factory UUID := '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
  v_hash CHAR(64) := encode(digest('Workforce lifecycle behavioral contract','sha256'),'hex');
  v_worker UUID := gen_random_uuid();
  v_nonconsenting_worker UUID := gen_random_uuid();
  v_skill UUID := gen_random_uuid();
  v_shift UUID := gen_random_uuid();
  v_alt_shift UUID := gen_random_uuid();
  v_assignment UUID := gen_random_uuid();
  v_nonconsenting_assignment UUID := gen_random_uuid();
  v_overtime UUID := gen_random_uuid();
  v_corrected_event UUID;
  v_correction UUID;
  v_date DATE := CURRENT_DATE+1;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_corr UUID := gen_random_uuid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Workforce CI actor context was not established';
  END IF;

  v_start := (v_date + TIME '08:00:00') AT TIME ZONE 'Asia/Dhaka';
  v_end := (v_date + TIME '16:00:00') AT TIME ZONE 'Asia/Dhaka';

  INSERT INTO workforce_workers (
    id,tenant_id,factory_id,employee_code,display_name,status,row_version,idempotency_key,request_hash,
    created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_worker,v_tenant,v_factory,'CI-WFC-001','CI consented operator','ACTIVE',1,'ci-wfc-worker-001',v_hash,
    v_actor,v_actor,v_corr
  );
  INSERT INTO workforce_biometric_consent_events (
    tenant_id,factory_id,worker_id,consent_granted,purpose,reason,idempotency_key,request_hash,
    recorded_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_worker,true,'Attendance clocking','Consent captured for the CI fixture',
    'ci-wfc-consent-001',v_hash,v_actor,gen_random_uuid()
  );

  INSERT INTO workforce_workers (
    id,tenant_id,factory_id,employee_code,display_name,status,row_version,idempotency_key,request_hash,
    created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_nonconsenting_worker,v_tenant,v_factory,'CI-WFC-002','CI operator without biometric consent','ACTIVE',1,
    'ci-wfc-worker-002',v_hash,v_actor,v_actor,gen_random_uuid()
  );

  INSERT INTO workforce_skills (
    id,tenant_id,factory_id,skill_code,name,status,row_version,idempotency_key,request_hash,
    created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_skill,v_tenant,v_factory,'STITCH','Industrial stitching','ACTIVE',1,'ci-wfc-skill-stitch',v_hash,
    v_actor,v_actor,gen_random_uuid()
  );
  INSERT INTO workforce_worker_skills (
    tenant_id,factory_id,worker_id,skill_id,skill_level,certified_on,certificate_expires_on,
    status,row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_worker,v_skill,4,v_date-30,NULL,'ACTIVE',1,'ci-wfc-worker-skill',v_hash,
    v_actor,v_actor,gen_random_uuid()
  );

  INSERT INTO workforce_shift_templates (
    id,tenant_id,factory_id,shift_code,name,starts_at_local,ends_at_local,timezone_name,
    unpaid_break_minutes,late_grace_minutes,overtime_threshold_minutes,status,row_version,
    idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_shift,v_tenant,v_factory,'CI-WFC-DAY','CI Day Shift','08:00','16:00','Asia/Dhaka',
    60,10,15,'ACTIVE',1,'ci-wfc-shift-day',v_hash,v_actor,v_actor,gen_random_uuid()
  );

  INSERT INTO workforce_shift_assignments (
    id,tenant_id,factory_id,shift_template_id,worker_id,shift_date,planned_start_at,planned_end_at,
    required_skill_code,status,row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_assignment,v_tenant,v_factory,v_shift,v_worker,v_date,v_start,v_end,'STITCH',
    'PLANNED',1,'ci-wfc-assignment-001',v_hash,v_actor,v_actor,gen_random_uuid()
  );
  UPDATE workforce_shift_assignments SET status='CONFIRMED',row_version=2,updated_by_user_id=v_actor,
    last_change_reason='CI staffing confirmed',updated_at=clock_timestamp()
  WHERE id=v_assignment AND tenant_id=v_tenant AND factory_id=v_factory;

  -- Consent is evaluated at the event's occurrence time, not its later sync time.
  -- Database-level privacy guard rejects raw biometric payloads even if a client bypasses API validation.
  BEGIN
    INSERT INTO workforce_attendance_events (
      tenant_id,factory_id,shift_assignment_id,worker_id,event_type,source_type,source_event_id,
      occurred_at,idempotency_key,request_hash,capture_metadata,recorded_by_user_id,correlation_id
    ) VALUES (
      v_tenant,v_factory,v_assignment,v_worker,'CLOCK_IN','BIOMETRIC','ci-wfc-sensitive-metadata',
      v_start+INTERVAL '5 minutes','ci-wfc-sensitive-metadata',v_hash,
      '{"fingerprint_template":"must-not-be-persisted"}'::jsonb,v_actor,gen_random_uuid()
    );
    RAISE EXCEPTION 'expected the workforce metadata privacy guard to reject a biometric template' USING ERRCODE='P0001';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  INSERT INTO workforce_attendance_events (
    tenant_id,factory_id,shift_assignment_id,worker_id,event_type,source_type,source_event_id,
    occurred_at,idempotency_key,request_hash,capture_metadata,recorded_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_assignment,v_worker,'CLOCK_IN','BIOMETRIC','ci-wfc-clock-in-001',
    v_start+INTERVAL '5 minutes','ci-wfc-clock-in-001',v_hash,'{"device_id":"CI-reader"}'::jsonb,
    v_actor,gen_random_uuid()
  );
  INSERT INTO workforce_attendance_events (
    tenant_id,factory_id,shift_assignment_id,worker_id,event_type,source_type,occurred_at,idempotency_key,
    request_hash,capture_metadata,recorded_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_assignment,v_worker,'BREAK_START','QR',
    v_start+INTERVAL '4 hours','ci-wfc-break-start-001',v_hash,'{}'::jsonb,v_actor,gen_random_uuid()
  );
  INSERT INTO workforce_attendance_events (
    tenant_id,factory_id,shift_assignment_id,worker_id,event_type,source_type,occurred_at,idempotency_key,
    request_hash,capture_metadata,recorded_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_assignment,v_worker,'BREAK_END','QR',
    v_start+INTERVAL '4 hours 30 minutes','ci-wfc-break-end-001',v_hash,'{}'::jsonb,v_actor,gen_random_uuid()
  );
  INSERT INTO workforce_attendance_events (
    tenant_id,factory_id,shift_assignment_id,worker_id,event_type,source_type,occurred_at,idempotency_key,
    request_hash,capture_metadata,recorded_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_assignment,v_worker,'CLOCK_OUT','MANUAL',
    v_end+INTERVAL '45 minutes','ci-wfc-clock-out-001',v_hash,'{"capture_method":"MANUAL_SUPERVISOR_VERIFIED"}'::jsonb,v_actor,gen_random_uuid()
  );

  -- Attendance correction is a versioned overlay; the original reader event remains unchanged.
  SELECT id INTO v_corrected_event
  FROM workforce_attendance_events
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND idempotency_key='ci-wfc-break-end-001';
  IF v_corrected_event IS NULL THEN
    RAISE EXCEPTION 'Workforce correction fixture could not find the original break-end event';
  END IF;
  INSERT INTO workforce_attendance_corrections (
    tenant_id,factory_id,original_event_id,correction_version,supersedes_correction_id,
    worker_id,shift_assignment_id,corrected_event_type,corrected_occurred_at,reason,
    idempotency_key,request_hash,corrected_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_corrected_event,1,NULL,v_worker,v_assignment,'BREAK_END',
    v_start+INTERVAL '4 hours 35 minutes','CI correction version one',
    'ci-wfc-break-end-correction-001',v_hash,v_actor,gen_random_uuid()
  ) RETURNING id INTO v_correction;
  INSERT INTO workforce_attendance_corrections (
    tenant_id,factory_id,original_event_id,correction_version,supersedes_correction_id,
    worker_id,shift_assignment_id,corrected_event_type,corrected_occurred_at,reason,
    idempotency_key,request_hash,corrected_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_corrected_event,2,v_correction,v_worker,v_assignment,'BREAK_END',
    v_start+INTERVAL '4 hours 40 minutes','CI correction supersedes version one',
    'ci-wfc-break-end-correction-002',v_hash,v_actor,gen_random_uuid()
  );
  IF NOT EXISTS (
    SELECT 1 FROM workforce_attendance_events_effective e
    WHERE e.id=v_corrected_event AND e.event_type='BREAK_END'
      AND e.occurred_at=v_start+INTERVAL '4 hours 40 minutes'
      AND e.correction_version=2
  ) THEN
    RAISE EXCEPTION 'Effective attendance view must return the latest correction version';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM workforce_attendance_events e
    WHERE e.id=v_corrected_event AND e.occurred_at=v_start+INTERVAL '4 hours 30 minutes'
  ) THEN
    RAISE EXCEPTION 'An attendance correction must not mutate the original source event';
  END IF;
  BEGIN
    UPDATE workforce_attendance_corrections SET reason='tampered' WHERE id=v_correction;
    RAISE EXCEPTION 'expected immutable attendance correction evidence to reject updates' USING ERRCODE='P0001';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;

  -- A late-arriving earlier event is accepted only if the timestamp-ordered stream remains valid.
  BEGIN
    INSERT INTO workforce_attendance_events (
      tenant_id,factory_id,shift_assignment_id,worker_id,event_type,source_type,occurred_at,idempotency_key,
      request_hash,capture_metadata,recorded_by_user_id,correlation_id
    ) VALUES (
      v_tenant,v_factory,v_assignment,v_worker,'BREAK_START','MANUAL',
      v_start+INTERVAL '2 hours','ci-wfc-invalid-break-order',v_hash,'{}'::jsonb,v_actor,gen_random_uuid()
    );
    RAISE EXCEPTION 'expected the ordered attendance stream guard to reject a nested break' USING ERRCODE='P0001';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- A roster interval may not overlap another active shift for the same worker.
  INSERT INTO workforce_shift_templates (
    id,tenant_id,factory_id,shift_code,name,starts_at_local,ends_at_local,timezone_name,
    status,row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_alt_shift,v_tenant,v_factory,'CI-WFC-DAY-ALT','CI Alternate Day Shift','08:00','16:00','Asia/Dhaka',
    'ACTIVE',1,'ci-wfc-shift-alt',v_hash,v_actor,v_actor,gen_random_uuid()
  );
  BEGIN
    INSERT INTO workforce_shift_assignments (
      tenant_id,factory_id,shift_template_id,worker_id,shift_date,planned_start_at,planned_end_at,
      status,row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
    ) VALUES (
      v_tenant,v_factory,v_alt_shift,v_worker,v_date,v_start,v_end,
      'PLANNED',1,'ci-wfc-overlap-assignment',v_hash,v_actor,v_actor,gen_random_uuid()
    );
    RAISE EXCEPTION 'expected overlap protection to reject a second active assignment' USING ERRCODE='P0001';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Biometric input without consent is denied at database level.
  INSERT INTO workforce_shift_assignments (
    id,tenant_id,factory_id,shift_template_id,worker_id,shift_date,planned_start_at,planned_end_at,
    status,row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_nonconsenting_assignment,v_tenant,v_factory,v_shift,v_nonconsenting_worker,v_date,v_start,v_end,
    'PLANNED',1,'ci-wfc-assignment-no-consent',v_hash,v_actor,v_actor,gen_random_uuid()
  );
  UPDATE workforce_shift_assignments SET status='CONFIRMED',row_version=2,updated_by_user_id=v_actor,
    last_change_reason='CI staffing confirmed',updated_at=clock_timestamp()
  WHERE id=v_nonconsenting_assignment AND tenant_id=v_tenant AND factory_id=v_factory;
  BEGIN
    INSERT INTO workforce_attendance_events (
      tenant_id,factory_id,shift_assignment_id,worker_id,event_type,source_type,occurred_at,idempotency_key,
      request_hash,capture_metadata,recorded_by_user_id,correlation_id
    ) VALUES (
      v_tenant,v_factory,v_nonconsenting_assignment,v_nonconsenting_worker,'CLOCK_IN','BIOMETRIC',
      v_start+INTERVAL '5 minutes','ci-wfc-biometric-without-consent',v_hash,'{}'::jsonb,v_actor,gen_random_uuid()
    );
    RAISE EXCEPTION 'expected unconsented biometric capture to be denied' USING ERRCODE='P0001';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Overtime requests are bounded by clock-out evidence and cannot self-approve.
  INSERT INTO workforce_overtime_requests (
    id,tenant_id,factory_id,shift_assignment_id,worker_id,requested_minutes,approved_minutes,status,reason,
    row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_overtime,v_tenant,v_factory,v_assignment,v_worker,45,0,'PENDING','CI overtime evidence check',
    1,'ci-wfc-overtime-request',v_hash,v_actor,v_actor,gen_random_uuid()
  );
  BEGIN
    UPDATE workforce_overtime_requests SET status='APPROVED',approved_minutes=30,
      updated_by_user_id=v_actor,decided_by_user_id=v_actor,decided_at=clock_timestamp(),
      decision_reason='Attempted self approval',row_version=2,updated_at=clock_timestamp()
    WHERE id=v_overtime AND tenant_id=v_tenant AND factory_id=v_factory;
    RAISE EXCEPTION 'expected overtime maker-checker to reject self-approval' USING ERRCODE='P0001';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  INSERT INTO workforce_command_receipts (
    tenant_id,factory_id,idempotency_key,request_hash,entity_type,entity_id,response_snapshot,
    recorded_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,'ci-wfc-command-receipt',v_hash,'SHIFT_ASSIGNMENT',v_assignment,
    '{"status":"CONFIRMED","row_version":2}'::jsonb,v_actor,gen_random_uuid()
  );
  BEGIN
    UPDATE workforce_command_receipts SET response_snapshot='{}'::jsonb
    WHERE tenant_id=v_tenant AND factory_id=v_factory AND idempotency_key='ci-wfc-command-receipt';
    RAISE EXCEPTION 'expected command receipt immutability' USING ERRCODE='P0001';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;

  BEGIN
    UPDATE workforce_attendance_events SET capture_metadata='{"tampered":true}'::jsonb
    WHERE shift_assignment_id=v_assignment AND worker_id=v_worker AND event_type='CLOCK_IN';
    RAISE EXCEPTION 'expected immutable attendance evidence' USING ERRCODE='P0001';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
END;
$workforce_lifecycle$;

ROLLBACK;
