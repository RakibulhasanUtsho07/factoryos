-- Behavioural contract for permit maker-checker/isolation, safety incident and CAPA verification.
BEGIN;
SELECT set_config('app.tenant_id','faaab63d-c447-46ce-950d-deebdd7f5f30',true);
SELECT set_config('app.user_id','921382b8-e83f-43ab-a576-e3db6a06b70c',true);
DO $ehs_test$
DECLARE
  v_requester UUID:=factoryos_current_user_id();
  v_tenant UUID:='faaab63d-c447-46ce-950d-deebdd7f5f30';
  v_factory UUID:='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
  v_approver UUID:='11111111-1111-4111-8111-111111111111';
  v_owner UUID:='22222222-2222-4222-8222-222222222222';
  v_verifier UUID:='33333333-3333-4333-8333-333333333333';
  v_hash CHAR(64):=encode(digest('ehs lifecycle CI contract','sha256'),'hex');
  v_permit UUID:=gen_random_uuid();
  v_incident UUID:=gen_random_uuid();
  v_action UUID:=gen_random_uuid();
BEGIN
  IF v_requester IS NULL THEN RAISE EXCEPTION 'EHS authenticated actor context was not established'; END IF;
  INSERT INTO users(id,external_subject,email,display_name,status) VALUES
    (v_approver,'ehs-ci-approver','ehs-ci-approver@factoryos.local','EHS CI Approver','ACTIVE'),
    (v_owner,'ehs-ci-owner','ehs-ci-owner@factoryos.local','EHS CI Action Owner','ACTIVE'),
    (v_verifier,'ehs-ci-verifier','ehs-ci-verifier@factoryos.local','EHS CI Independent Verifier','ACTIVE')
  ON CONFLICT(id) DO UPDATE SET status='ACTIVE';

  INSERT INTO ehs_safety_permits(
    id,tenant_id,factory_id,permit_number,permit_type,risk_level,title,work_scope,location,
    requires_isolation,isolation_points,valid_from,expires_at,requested_by_user_id,updated_by_user_id,
    idempotency_key,request_hash,correlation_id
  ) VALUES (
    v_permit,v_tenant,v_factory,'CI-LOTO-001','ELECTRICAL_LOTO','HIGH','Isolate line drive',
    'Inspect the drive motor and verify zero energy','Main electrical room',TRUE,
    '[{"code":"MAIN-BREAKER","description":"Main motor feed breaker"}]'::jsonb,
    clock_timestamp()-INTERVAL '5 minutes',clock_timestamp()+INTERVAL '1 hour',
    v_requester,v_requester,'ci-ehs-permit',v_hash,gen_random_uuid()
  );
  UPDATE ehs_safety_permits SET status='PENDING_APPROVAL',row_version=2,
    last_change_reason='Permit submitted for independent review',updated_by_user_id=v_requester,updated_at=clock_timestamp()
    WHERE id=v_permit AND tenant_id=v_tenant AND factory_id=v_factory;

  -- A requester cannot self-approve a high-risk permit.
  BEGIN
    UPDATE ehs_safety_permits SET status='APPROVED',approved_by_user_id=v_requester,
      approved_at=clock_timestamp(),decision_reason='Self-approval must fail',row_version=3,
      last_change_reason='Invalid self approval',updated_by_user_id=v_requester,updated_at=clock_timestamp()
    WHERE id=v_permit AND tenant_id=v_tenant AND factory_id=v_factory;
    RAISE EXCEPTION 'expected same-actor permit approval to be rejected' USING ERRCODE='P0001';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  PERFORM set_config('app.user_id',v_approver::text,true);
  UPDATE ehs_safety_permits SET status='APPROVED',approved_by_user_id=v_approver,
    approved_at=clock_timestamp(),decision_reason='Energy isolation procedure approved',row_version=3,
    last_change_reason='Approved by independent safety officer',updated_by_user_id=v_approver,updated_at=clock_timestamp()
  WHERE id=v_permit AND tenant_id=v_tenant AND factory_id=v_factory;

  -- An approved high-risk permit is not activatable before every isolation point is evidenced.
  BEGIN
    UPDATE ehs_safety_permits SET status='ACTIVE',activated_by_user_id=v_approver,activated_at=clock_timestamp(),
      row_version=4,last_change_reason='Premature activation',updated_by_user_id=v_approver,updated_at=clock_timestamp()
    WHERE id=v_permit AND tenant_id=v_tenant AND factory_id=v_factory;
    RAISE EXCEPTION 'expected missing isolation verification to block activation' USING ERRCODE='P0001';
  EXCEPTION WHEN check_violation THEN NULL; END;

  PERFORM set_config('app.user_id',v_requester::text,true);
  UPDATE ehs_safety_permits SET isolation_verification='[{"code":"MAIN-BREAKER","verified":true,"evidence":"Tested dead and tagged"}]'::jsonb,
    isolation_verified_by_user_id=v_requester,isolation_verified_at=clock_timestamp(),row_version=4,
    last_change_reason='Zero-energy test and tag photograph recorded',updated_by_user_id=v_requester,updated_at=clock_timestamp()
  WHERE id=v_permit AND tenant_id=v_tenant AND factory_id=v_factory;

  PERFORM set_config('app.user_id',v_approver::text,true);
  UPDATE ehs_safety_permits SET status='ACTIVE',activated_by_user_id=v_approver,activated_at=clock_timestamp(),
    row_version=5,last_change_reason='Isolation verified; work authorized',updated_by_user_id=v_approver,updated_at=clock_timestamp()
  WHERE id=v_permit AND tenant_id=v_tenant AND factory_id=v_factory;

  PERFORM set_config('app.user_id',v_verifier::text,true);
  UPDATE ehs_safety_permits SET status='CLOSED',closed_by_user_id=v_verifier,closed_at=clock_timestamp(),
    closure_evidence='{"guards_reinstalled":true,"line_tested":true,"area_clear":true}'::jsonb,
    closure_reason='Work complete; equipment safely returned to service',row_version=6,
    last_change_reason='Permit close-out evidence verified',updated_by_user_id=v_verifier,updated_at=clock_timestamp()
  WHERE id=v_permit AND tenant_id=v_tenant AND factory_id=v_factory;
  IF (SELECT status FROM ehs_safety_permits WHERE id=v_permit)<>'CLOSED' THEN
    RAISE EXCEPTION 'Permit-to-work did not complete its verified lifecycle';
  END IF;

  PERFORM set_config('app.user_id',v_requester::text,true);
  INSERT INTO ehs_incidents(
    id,tenant_id,factory_id,incident_number,incident_type,severity,title,description,location,occurred_at,
    assigned_owner_user_id,due_at,created_by_user_id,updated_by_user_id,idempotency_key,request_hash,correlation_id
  ) VALUES (
    v_incident,v_tenant,v_factory,'CI-NEAR-MISS-001','NEAR_MISS','HIGH','Unprotected belt observation',
    'A guard was loose near the drive pulley','Line A drive end',clock_timestamp(),
    v_owner,clock_timestamp()+INTERVAL '1 day',v_requester,v_requester,'ci-ehs-incident',v_hash,gen_random_uuid()
  );
  UPDATE ehs_incidents SET status='INVESTIGATING',row_version=2,
    investigation_summary='Guard fastener fatigue is being checked',last_change_reason='Investigation assigned',
    updated_by_user_id=v_requester,updated_at=clock_timestamp()
  WHERE id=v_incident AND tenant_id=v_tenant AND factory_id=v_factory;

  INSERT INTO ehs_corrective_actions(
    id,tenant_id,factory_id,incident_id,action_number,description,assigned_owner_user_id,due_at,
    idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_action,v_tenant,v_factory,v_incident,'CI-CAPA-001','Replace fastener and inspect all line guards',
    v_owner,clock_timestamp()+INTERVAL '1 day','ci-ehs-action',v_hash,v_requester,v_requester,gen_random_uuid()
  );
  PERFORM set_config('app.user_id',v_owner::text,true);
  UPDATE ehs_corrective_actions SET status='IN_PROGRESS',row_version=2,
    last_change_reason='Repair started',updated_by_user_id=v_owner,updated_at=clock_timestamp()
  WHERE id=v_action AND tenant_id=v_tenant AND factory_id=v_factory;

  PERFORM set_config('app.user_id',v_verifier::text,true);
  UPDATE ehs_incidents SET status='RESOLVED',root_cause='Guard fixing fastener fatigued under vibration',
    closure_evidence='{"repair_order":"CI-REPAIR-1","inspection":"pending final verification"}'::jsonb,
    row_version=3,last_change_reason='Root cause recorded and corrective action underway',
    updated_by_user_id=v_verifier,updated_at=clock_timestamp()
  WHERE id=v_incident AND tenant_id=v_tenant AND factory_id=v_factory;
  BEGIN
    UPDATE ehs_incidents SET status='CLOSED',closed_by_user_id=v_verifier,closed_at=clock_timestamp(),
      row_version=4,last_change_reason='Close before action verification',updated_by_user_id=v_verifier,updated_at=clock_timestamp()
    WHERE id=v_incident AND tenant_id=v_tenant AND factory_id=v_factory;
    RAISE EXCEPTION 'expected unverified corrective action to block incident closure' USING ERRCODE='P0001';
  EXCEPTION WHEN check_violation THEN NULL; END;

  PERFORM set_config('app.user_id',v_owner::text,true);
  UPDATE ehs_corrective_actions SET status='READY_FOR_VERIFICATION',root_cause='Fastener fatigue confirmed; new locking hardware installed',
    completion_evidence='{"replacement_part":"LOCK-NUT-M8","inspection_photo":"ci://evidence/guard"}'::jsonb,
    submitted_by_user_id=v_owner,submitted_at=clock_timestamp(),row_version=3,
    last_change_reason='Repair evidence submitted for independent verification',
    updated_by_user_id=v_owner,updated_at=clock_timestamp()
  WHERE id=v_action AND tenant_id=v_tenant AND factory_id=v_factory;

  PERFORM set_config('app.user_id',v_verifier::text,true);
  UPDATE ehs_corrective_actions SET status='VERIFIED',verified_by_user_id=v_verifier,verified_at=clock_timestamp(),
    verification_evidence='{"guard_pull_test":"pass","line_released":true}'::jsonb,row_version=4,
    last_change_reason='Independent line-side verification passed',
    updated_by_user_id=v_verifier,updated_at=clock_timestamp()
  WHERE id=v_action AND tenant_id=v_tenant AND factory_id=v_factory;

  UPDATE ehs_incidents SET status='CLOSED',closed_by_user_id=v_verifier,closed_at=clock_timestamp(),
    closure_evidence='{"repair_order":"CI-REPAIR-1","final_inspection":"passed","line_released":true}'::jsonb,
    row_version=4,
    last_change_reason='Safety finding closed after verified action',updated_by_user_id=v_verifier,updated_at=clock_timestamp()
  WHERE id=v_incident AND tenant_id=v_tenant AND factory_id=v_factory;

  IF (SELECT status FROM ehs_corrective_actions WHERE id=v_action)<>'VERIFIED'
     OR (SELECT status FROM ehs_incidents WHERE id=v_incident)<>'CLOSED'
     OR (SELECT count(*) FROM ehs_audit_events WHERE entity_id IN (v_permit,v_incident,v_action))<10 THEN
    RAISE EXCEPTION 'EHS action verification, incident closure or audit evidence is incomplete';
  END IF;
END
$ehs_test$;
ROLLBACK;
