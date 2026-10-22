-- Task 16 populated PostgreSQL acceptance: source normalization, threshold notification,
-- emergency drill attendance/response, current SDS references and contractor induction.
BEGIN;

DO $energy_ehs_closure$
DECLARE
  v_tenant UUID:=gen_random_uuid();
  v_factory UUID:=gen_random_uuid();
  v_actor UUID:=gen_random_uuid();
  v_approver UUID:=gen_random_uuid();
  v_meter UUID:=gen_random_uuid();
  v_binding UUID:=gen_random_uuid();
  v_policy UUID:=gen_random_uuid();
  v_reading UUID:=gen_random_uuid();
  v_drill UUID:=gen_random_uuid();
  v_failed_drill UUID:=gen_random_uuid();
  v_chemical UUID:=gen_random_uuid();
  v_induction UUID:=gen_random_uuid();
  v_correlation UUID:=gen_random_uuid();
  v_hash CHAR(64):=encode(digest('energy and EHS closure contract','sha256'),'hex');
  v_alert_count INTEGER;
  v_outbox_count INTEGER;
  v_qty NUMERIC(24,8);
  v_cost NUMERIC(24,8);
BEGIN
  INSERT INTO tenants(id,slug,name) VALUES(v_tenant,'energy-ehs-'||v_tenant::text,'Energy and EHS Closure Test Tenant');
  INSERT INTO users(id,display_name) VALUES(v_actor,'Energy EHS Test Actor'),(v_approver,'Energy EHS Independent Approver');
  INSERT INTO factories(id,tenant_id,code,name,status)
    VALUES(v_factory,v_tenant,'EEC-'||upper(substr(v_factory::text,1,8)),'Energy EHS Closure Test Factory','ACTIVE');
  PERFORM set_config('app.tenant_id',v_tenant::text,TRUE);
  PERFORM set_config('app.user_id',v_actor::text,TRUE);
  PERFORM set_config('app.request_id',v_correlation::text,TRUE);
  PERFORM set_config('app.trace_id',v_correlation::text,TRUE);

  -- A vendor source map is created as DRAFT and independently approved before ingestion.
  INSERT INTO utility_meters(
    id,tenant_id,factory_id,meter_code,name,utility_type,reading_mode,unit_code,multiplier_factor,unit_cost,
    currency_code,cost_center_code,source_system_code,location,status,idempotency_key,request_hash,
    created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES(v_meter,v_tenant,v_factory,'EEC-ELEC-01','Energy EHS fixture meter','ELECTRICITY','INTERVAL','kWh',
    1,2.5,'BDT','CC-EEC','EDGE-CI-01','Test panel','ACTIVE','eec-meter',v_hash,v_actor,v_actor,v_correlation);

  INSERT INTO utility_meter_source_bindings(
    id,tenant_id,factory_id,source_system_code,source_meter_code,vendor_adapter,meter_id,source_unit_code,
    factor_to_meter_unit,polling_interval_seconds,credential_reference,config_metadata,status,row_version,
    idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES(v_binding,v_tenant,v_factory,'EDGE-CI-01','METER-17','MQTT',v_meter,'Wh',0.001,30,
    'secrets://factory/eec/meter-17','{"transport":"fixture-only","auth_mode":"secret-manager-reference"}'::jsonb,
    'DRAFT',1,'eec-source-binding',v_hash,v_actor,v_actor,v_correlation);

  PERFORM set_config('app.user_id',v_approver::text,TRUE);
  UPDATE utility_meter_source_bindings SET status='ACTIVE',row_version=2,approved_by_user_id=v_approver,
    approved_at=clock_timestamp(),last_change_reason='Independent approval of source and unit conversion',
    updated_by_user_id=v_approver,updated_at=clock_timestamp()
  WHERE id=v_binding AND tenant_id=v_tenant AND factory_id=v_factory AND status='DRAFT' AND row_version=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Approved vendor source mapping could not be activated'; END IF;

  INSERT INTO utility_threshold_policies(
    id,tenant_id,factory_id,policy_code,name,meter_id,utility_type,metric,comparison,threshold_value,
    threshold_unit_code,severity,status,row_version,idempotency_key,request_hash,created_by_user_id,
    updated_by_user_id,correlation_id
  ) VALUES(v_policy,v_tenant,v_factory,'EEC-HIGH-CONSUMPTION','Energy consumption alert',v_meter,'ELECTRICITY',
    'CONSUMPTION','GTE',10,'kWh','HIGH','DRAFT',1,'eec-threshold-policy',v_hash,v_actor,v_actor,v_correlation);
  UPDATE utility_threshold_policies SET status='ACTIVE',row_version=2,approved_by_user_id=v_approver,
    approved_at=clock_timestamp(),updated_by_user_id=v_approver,updated_at=clock_timestamp(),
    last_change_reason='Approved for staged source-ingestion test'
  WHERE id=v_policy AND tenant_id=v_tenant AND factory_id=v_factory AND status='DRAFT' AND row_version=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Threshold policy could not be independently activated'; END IF;

  PERFORM set_config('app.user_id',v_actor::text,TRUE);
  INSERT INTO utility_meter_readings(
    id,tenant_id,factory_id,meter_id,reading_at,reading_value,previous_reading_value,consumption_quantity,
    unit_code,unit_cost_snapshot,cost_amount,source_type,source_event_id,notes,idempotency_key,request_hash,
    recorded_by_user_id,correlation_id,request_id
  ) VALUES(v_reading,v_tenant,v_factory,v_meter,clock_timestamp(),20,NULL,20,'kWh',2.5,50,'METER_GATEWAY',
    'EDGE-CI-01:evt-001','Normalized fixture source: 20000 Wh × 0.001','eec-source-reading-001',v_hash,
    v_actor,v_correlation,v_correlation::text);

  SELECT count(*) INTO v_alert_count FROM utility_threshold_alerts
    WHERE tenant_id=v_tenant AND factory_id=v_factory AND reading_id=v_reading AND policy_id=v_policy;
  IF v_alert_count<>1 THEN RAISE EXCEPTION 'A threshold-matching reading must create exactly one linked alert'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM utility_threshold_alerts a
    JOIN utility_events e ON e.id=a.utility_event_id AND e.tenant_id=a.tenant_id AND e.factory_id=a.factory_id
    JOIN outbox_events o ON o.aggregate_id=a.id AND o.tenant_id=a.tenant_id AND o.factory_id=a.factory_id
      AND o.event_type='UTILITIES.THRESHOLD_ALERT_RAISED'
    WHERE a.tenant_id=v_tenant AND a.factory_id=v_factory AND a.reading_id=v_reading
      AND a.observed_value=20 AND a.threshold_snapshot=10 AND a.unit_code='kWh'
      AND e.status='OPEN' AND e.severity='HIGH' AND e.cause='policy=EEC-HIGH-CONSUMPTION'
  ) THEN RAISE EXCEPTION 'Threshold alert must preserve source reading, policy, severity and notification-outbox evidence'; END IF;
  IF NOT EXISTS(SELECT 1 FROM utility_audit_events WHERE tenant_id=v_tenant AND factory_id=v_factory
      AND entity_type='READING' AND entity_id=v_reading AND action='READING_RECORDED') THEN
    RAISE EXCEPTION 'Normalized utility reading did not generate the expected audit record';
  END IF;

  -- A below-threshold reading is normalized and audited but must not create an alert.
  INSERT INTO utility_meter_readings(
    tenant_id,factory_id,meter_id,reading_at,reading_value,previous_reading_value,consumption_quantity,
    unit_code,unit_cost_snapshot,cost_amount,source_type,source_event_id,notes,idempotency_key,request_hash,
    recorded_by_user_id,correlation_id,request_id
  ) VALUES(v_tenant,v_factory,v_meter,clock_timestamp()+INTERVAL '1 second',5,NULL,5,'kWh',2.5,12.5,'METER_GATEWAY',
    'EDGE-CI-01:evt-002','Below threshold fixture','eec-source-reading-002',v_hash,v_actor,v_correlation,v_correlation::text);
  SELECT count(*) INTO v_alert_count FROM utility_threshold_alerts WHERE tenant_id=v_tenant AND factory_id=v_factory;
  IF v_alert_count<>1 THEN RAISE EXCEPTION 'A below-threshold reading must not create an alert'; END IF;

  -- Drill completion is blocked until attendance and at least one response are recorded.
  INSERT INTO ehs_emergency_drills(
    id,tenant_id,factory_id,drill_number,drill_type,title,location,planned_at,owner_user_id,status,row_version,
    idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES(v_drill,v_tenant,v_factory,'EEC-DRILL-01','EVACUATION','Evacuation staged test','Test block',
    clock_timestamp()-INTERVAL '5 minutes',v_actor,'PLANNED',1,'eec-drill',v_hash,v_actor,v_actor,v_correlation);
  UPDATE ehs_emergency_drills SET status='IN_PROGRESS',started_at=clock_timestamp(),row_version=2,
    last_change_reason='Start staged evacuation test',updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_drill AND tenant_id=v_tenant AND factory_id=v_factory AND status='PLANNED' AND row_version=1;

  INSERT INTO ehs_drill_attendance(
    tenant_id,factory_id,drill_id,attendee_ref,attendee_name,user_id,attendance_status,recorded_at,notes,evidence,
    idempotency_key,request_hash,recorded_by_user_id,correlation_id
  ) VALUES(v_tenant,v_factory,v_drill,'CI-ATTENDEE-01','Test drill attendee',v_actor,'PRESENT',clock_timestamp(),
    'Attendance confirmed at muster point','{"muster_point":"NORTH-GATE","evidence_ref":"attendance-sheet-01"}'::jsonb,
    'eec-drill-attendance',v_hash,v_actor,v_correlation);
  INSERT INTO ehs_drill_responses(
    tenant_id,factory_id,drill_id,response_code,response_action,responder_user_id,elapsed_seconds,occurred_at,evidence,
    idempotency_key,request_hash,recorded_by_user_id,correlation_id
  ) VALUES(v_tenant,v_factory,v_drill,'EVACUATION-MUSTER','Muster point reached and headcount reconciled',v_actor,90,
    clock_timestamp(),'{"result":"PASS","headcount_checked":true}'::jsonb,'eec-drill-response',v_hash,v_actor,v_correlation);
  UPDATE ehs_emergency_drills SET status='COMPLETED',completed_at=clock_timestamp(),
    outcome_summary='Evacuation exercise completed; headcount reconciled',
    close_evidence='{"observer":"EHS CI","headcount_reconciled":true}'::jsonb,
    last_change_reason='Close staged evacuation test',row_version=3,updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_drill AND tenant_id=v_tenant AND factory_id=v_factory AND status='IN_PROGRESS' AND row_version=2;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM ehs_lifecycle_events WHERE tenant_id=v_tenant AND factory_id=v_factory
      AND entity_type='EMERGENCY_DRILL' AND entity_id=v_drill AND action='COMPLETED')
    OR NOT EXISTS(SELECT 1 FROM outbox_events WHERE tenant_id=v_tenant AND factory_id=v_factory
      AND aggregate_id=v_drill AND event_type='EHS.LIFECYCLE_CHANGED') THEN
    RAISE EXCEPTION 'Completed emergency drill requires accountable close-out, immutable lifecycle audit and notification outbox';
  END IF;

  INSERT INTO ehs_emergency_drills(
    id,tenant_id,factory_id,drill_number,drill_type,title,location,planned_at,owner_user_id,status,row_version,
    idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES(v_failed_drill,v_tenant,v_factory,'EEC-DRILL-02','FIRE','Incomplete drill','Test block',
    clock_timestamp()-INTERVAL '5 minutes',v_actor,'PLANNED',1,'eec-failed-drill',v_hash,v_actor,v_actor,v_correlation);
  UPDATE ehs_emergency_drills SET status='IN_PROGRESS',started_at=clock_timestamp(),row_version=2,
    last_change_reason='Start incomplete drill',updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_failed_drill AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=1;
  BEGIN
    UPDATE ehs_emergency_drills SET status='COMPLETED',completed_at=clock_timestamp(),
      outcome_summary='Should fail without attendance/response',close_evidence='{"test":true}'::jsonb,
      last_change_reason='Attempt prohibited close',row_version=3,updated_by_user_id=v_actor,updated_at=clock_timestamp()
    WHERE id=v_failed_drill AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=2;
    RAISE EXCEPTION 'Drill without attendance or response bypassed the database completion guard';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  IF (SELECT status FROM ehs_emergency_drills WHERE id=v_failed_drill) IS DISTINCT FROM 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'Rejected drill close attempt changed persistent drill status';
  END IF;

  INSERT INTO ehs_chemical_sds_registry(
    tenant_id,factory_id,chemical_code,chemical_name,manufacturer,hazard_class,storage_location,sds_revision,
    sds_document_uri,sds_issued_at,sds_review_due_at,handling_instructions,emergency_instructions,status,row_version,
    idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES(v_tenant,v_factory,'EEC-CHEM-01','Test cleaning agent','Test manufacturer','IRRITANT',
    'CHEMICAL-STORE-A','REV-2026-01','https://sds.example.invalid/eec-chem-01/rev-2026-01.pdf',
    clock_timestamp()-INTERVAL '1 month',clock_timestamp()+INTERVAL '6 months','Wear the listed PPE and keep container closed',
    'Flush exposure area and follow the site emergency procedure','DRAFT',1,'eec-sds',v_hash,v_actor,v_actor,v_correlation)
  RETURNING id INTO v_chemical;
  UPDATE ehs_chemical_sds_registry SET status='ACTIVE',row_version=2,last_change_reason='SDS checked and approved for the test store',
    updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_chemical AND tenant_id=v_tenant AND factory_id=v_factory AND status='DRAFT' AND row_version=1;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM ehs_lifecycle_events WHERE tenant_id=v_tenant AND factory_id=v_factory
      AND entity_type='CHEMICAL_SDS' AND entity_id=v_chemical AND action='ACTIVE') THEN
    RAISE EXCEPTION 'SDS activation must preserve revision lifecycle audit evidence';
  END IF;

  INSERT INTO ehs_contractor_inductions(
    tenant_id,factory_id,contractor_code,company_name,person_name,induction_at,expires_at,topics,evidence,status,
    row_version,idempotency_key,request_hash,recorded_by_user_id,updated_by_user_id,correlation_id
  ) VALUES(v_tenant,v_factory,'EEC-CON-01','Test contractor company','Test visitor',
    clock_timestamp()-INTERVAL '1 minute',clock_timestamp()+INTERVAL '1 day',
    '["PPE","EMERGENCY-ROUTES","PERMIT-TO-WORK"]'::jsonb,
    '{"trainer":"EHS CI","evidence_ref":"induction-sheet-01","quiz_passed":true}'::jsonb,'ACTIVE',1,
    'eec-contractor-induction',v_hash,v_actor,v_actor,v_correlation)
  RETURNING id INTO v_induction;
  IF NOT EXISTS(SELECT 1 FROM ehs_lifecycle_events WHERE tenant_id=v_tenant AND factory_id=v_factory
      AND entity_type='CONTRACTOR_INDUCTION' AND entity_id=v_induction AND action='CREATED')
    OR NOT EXISTS(SELECT 1 FROM outbox_events WHERE tenant_id=v_tenant AND factory_id=v_factory
      AND aggregate_id=v_induction AND event_type='EHS.LIFECYCLE_CHANGED') THEN
    RAISE EXCEPTION 'Contractor induction must have immutable audit and notification outbox evidence';
  END IF;

  SELECT count(*) INTO v_outbox_count FROM outbox_events
  WHERE tenant_id=v_tenant AND factory_id=v_factory
    AND event_type IN ('UTILITIES.THRESHOLD_ALERT_RAISED','EHS.LIFECYCLE_CHANGED');
  IF v_outbox_count<5 THEN RAISE EXCEPTION 'Expected source alert and EHS lifecycle notifications in transactional outbox'; END IF;

  RAISE NOTICE 'Energy/EHS closure acceptance passed: approved source normalization, threshold alert, accountable drill close, SDS revision and contractor induction';
END;
$energy_ehs_closure$;

ROLLBACK;
