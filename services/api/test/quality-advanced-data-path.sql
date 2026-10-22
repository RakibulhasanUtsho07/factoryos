-- Data-path acceptance for AQL decisions, fabric roll scoring, quality quarantine and approved release.
-- All fixture changes are rolled back; deferred evidence constraints are forced before rollback.
BEGIN;

DO $qa_data$
DECLARE
  v_tenant UUID := gen_random_uuid();
  v_factory UUID := gen_random_uuid();
  v_actor UUID := gen_random_uuid();
  v_approver UUID := gen_random_uuid();
  v_item UUID := gen_random_uuid();
  v_aql_profile UUID := gen_random_uuid();
  v_fabric_profile UUID := gen_random_uuid();
  v_reject_inspection UUID := gen_random_uuid();
  v_accept_inspection UUID := gen_random_uuid();
  v_reject_sample UUID := gen_random_uuid();
  v_roll_pass UUID := gen_random_uuid();
  v_roll_hold UUID := gen_random_uuid();
  v_reject_hold UUID := gen_random_uuid();
  v_disposition UUID := gen_random_uuid();
  v_correlation UUID := gen_random_uuid();
  v_pass_blocked BOOLEAN := FALSE;
  v_decision TEXT;
  v_score NUMERIC(18,4);
  v_stock_before NUMERIC(18,4);
BEGIN
  INSERT INTO tenants (id, slug, name)
  VALUES (v_tenant, 'qa-advanced-' || v_tenant::text, 'Advanced Quality Integration');
  INSERT INTO users (id, display_name)
  VALUES (v_actor, 'Advanced Quality Inspector'), (v_approver, 'Independent Quality Approver');
  INSERT INTO factories (id, tenant_id, code, name, status)
  VALUES (v_factory, v_tenant, 'QA-' || upper(substr(v_factory::text,1,8)), 'Advanced Quality Factory', 'ACTIVE');

  PERFORM set_config('app.tenant_id',v_tenant::text,true);
  PERFORM set_config('app.user_id',v_actor::text,true);
  PERFORM set_config('app.request_id',gen_random_uuid()::text,true);
  PERFORM set_config('app.trace_id',v_correlation::text,true);

  INSERT INTO inventory_items (id,tenant_id,factory_id,sku,name,unit,created_by_user_id)
  VALUES (v_item,v_tenant,v_factory,'QA-SKU-'||upper(substr(v_item::text,1,8)),'Advanced Quality Test Item','PCS',v_actor);
  INSERT INTO inventory_stock_balances (tenant_id,factory_id,item_id,quantity_on_hand)
  VALUES (v_tenant,v_factory,v_item,50);

  INSERT INTO quality_aql_profiles (
    id,tenant_id,factory_id,profile_code,revision,inspection_type,aql_percent,inspection_level,
    lot_size_min,lot_size_max,sample_size,accept_number,reject_number,status,row_version,
    idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_aql_profile,v_tenant,v_factory,'INCOMING-AQL-TEST',1,'INCOMING',2.500,'II',
    5,500,5,1,3,'DRAFT',1,'qa-data-aql-profile',repeat('a',64),v_actor,v_actor,v_correlation
  );
  UPDATE quality_aql_profiles
  SET status='ACTIVE',row_version=2,updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_aql_profile AND tenant_id=v_tenant AND factory_id=v_factory;

  INSERT INTO quality_fabric_scoring_profiles (
    id,tenant_id,factory_id,profile_code,revision,inspection_type,max_points_per_100_square_yards,
    minimum_roll_count,status,row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_fabric_profile,v_tenant,v_factory,'FABRIC-FOUR-POINT-TEST',1,'INCOMING',10.0000,
    2,'DRAFT',1,'qa-data-fabric-profile',repeat('b',64),v_actor,v_actor,v_correlation
  );
  UPDATE quality_fabric_scoring_profiles
  SET status='ACTIVE',row_version=2,updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_fabric_profile AND tenant_id=v_tenant AND factory_id=v_factory;

  -- A rejected AQL sample and one failed roll must prevent inspection PASS.
  INSERT INTO quality_inspections (
    id,tenant_id,factory_id,inspection_type,target_type,target_id,status,row_version,
    idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_reject_inspection,v_tenant,v_factory,'INCOMING','INVENTORY_ITEM',v_item,'OPEN',1,
    'qa-data-reject-inspection',repeat('c',64),v_actor,v_actor,v_correlation
  );
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_reject_inspection,1,NULL,'OPEN','CREATED',NULL,
    'qa-data-reject-created',repeat('d',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_reject_inspection,'INSPECTION_CREATED','{"source":"qa-data-path"}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_reject_inspection,'QUALITY.INSPECTION_CHANGED',
    jsonb_build_object('status','OPEN','version',1,'correlation_id',v_correlation));

  UPDATE quality_inspections
  SET aql_profile_id=v_aql_profile,fabric_scoring_profile_id=v_fabric_profile,
      row_version=2,updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_reject_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=1;

  INSERT INTO quality_sampling_profile_bindings (
    tenant_id,factory_id,inspection_id,aql_profile_id,fabric_scoring_profile_id,idempotency_key,
    request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_reject_inspection,v_aql_profile,v_fabric_profile,'qa-data-reject-bind',
    repeat('e',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_reject_inspection,'SAMPLING_PROFILES_BOUND',
    jsonb_build_object('aql_profile_id',v_aql_profile,'fabric_profile_id',v_fabric_profile),v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_reject_inspection,'QUALITY.SAMPLING_PROFILES_BOUND',
    jsonb_build_object('aql_profile_id',v_aql_profile,'fabric_profile_id',v_fabric_profile,'correlation_id',v_correlation));

  INSERT INTO quality_aql_sample_runs (
    tenant_id,factory_id,inspection_id,profile_id,profile_revision,aql_percent_snapshot,inspection_level_snapshot,
    lot_size,sample_size,accept_number,reject_number,observed_nonconforming,decision,evidence,
    idempotency_key,request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_reject_inspection,v_aql_profile,2,2.500,'II',
    100,5,1,3,3,'HOLD','{"sample_sheet":"QA-SHEET-REJECT-01","method":"random-across-lot"}'::jsonb,
    'qa-data-reject-sample',repeat('f',64),v_actor,v_correlation
  ) RETURNING id INTO v_reject_sample;
  SELECT decision INTO v_decision FROM quality_aql_sample_runs WHERE id=v_reject_sample;
  IF v_decision IS DISTINCT FROM 'REJECT' THEN
    RAISE EXCEPTION 'AQL rejection count must produce REJECT, got %',v_decision;
  END IF;

  INSERT INTO quality_fabric_roll_scores (
    tenant_id,factory_id,inspection_id,profile_id,profile_revision,roll_code,roll_length_yards,roll_width_inches,
    total_defect_points,points_per_100_square_yards,max_points_snapshot,decision,defects,evidence,
    idempotency_key,request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_reject_inspection,v_fabric_profile,2,'ROLL-PASS-001',100,60,
    5,0,10,'HOLD','[{"defect_code":"MINOR-SLUB","points":5}]'::jsonb,'{"roll_sheet":"ROLL-QA-001"}'::jsonb,
    'qa-data-roll-pass',repeat('1',64),v_actor,v_correlation
  ) RETURNING id,points_per_100_square_yards INTO v_roll_pass,v_score;
  IF v_score<>3.0000 OR (SELECT decision FROM quality_fabric_roll_scores WHERE id=v_roll_pass)<>'PASS' THEN
    RAISE EXCEPTION 'Passing roll score must calculate to 3.0000 points per 100 square yards; got %',v_score;
  END IF;

  INSERT INTO quality_fabric_roll_scores (
    tenant_id,factory_id,inspection_id,profile_id,profile_revision,roll_code,roll_length_yards,roll_width_inches,
    total_defect_points,points_per_100_square_yards,max_points_snapshot,decision,defects,evidence,
    idempotency_key,request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_reject_inspection,v_fabric_profile,2,'ROLL-HOLD-001',100,60,
    20,0,10,'PASS','[{"defect_code":"MAJOR-HOLE","points":20}]'::jsonb,'{"roll_sheet":"ROLL-QA-002"}'::jsonb,
    'qa-data-roll-hold',repeat('2',64),v_actor,v_correlation
  ) RETURNING id,points_per_100_square_yards INTO v_roll_hold,v_score;
  IF v_score<>12.0000 OR (SELECT decision FROM quality_fabric_roll_scores WHERE id=v_roll_hold)<>'HOLD' THEN
    RAISE EXCEPTION 'Held roll score must calculate to 12.0000 points per 100 square yards; got %',v_score;
  END IF;

  UPDATE quality_inspections
  SET status='IN_PROGRESS',row_version=3,updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_reject_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=2;
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (v_tenant,v_factory,v_reject_inspection,3,'OPEN','IN_PROGRESS','START','Inspection started',
    'qa-data-reject-start',repeat('3',64),v_actor,v_correlation);
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_reject_inspection,'INSPECTION_START','{"status":"IN_PROGRESS","version":3}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_reject_inspection,'QUALITY.INSPECTION_CHANGED',
    jsonb_build_object('status','IN_PROGRESS','version',3,'correlation_id',v_correlation));

  BEGIN
    UPDATE quality_inspections
    SET status='PASSED',row_version=4,updated_by_user_id=v_actor,updated_at=clock_timestamp()
    WHERE id=v_reject_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=3;
  EXCEPTION WHEN check_violation THEN
    v_pass_blocked:=TRUE;
  END;
  IF NOT v_pass_blocked THEN
    RAISE EXCEPTION 'Inspection with rejected AQL sample / held roll must not transition to PASSED';
  END IF;

  UPDATE quality_inspections
  SET status='ON_HOLD',row_version=4,updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_reject_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=3;
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (v_tenant,v_factory,v_reject_inspection,4,'IN_PROGRESS','ON_HOLD','HOLD',
    'AQL reject and fabric roll above approved point limit','qa-data-reject-hold',repeat('4',64),v_actor,v_correlation);
  INSERT INTO quality_holds (tenant_id,factory_id,inspection_id,inventory_item_id,status,reason,created_by_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_reject_inspection,v_item,'ACTIVE','AQL/fabric scoring acceptance gate',v_actor,v_correlation)
  RETURNING id INTO v_reject_hold;
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,hold_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_reject_inspection,v_reject_hold,'INSPECTION_HOLD',
    jsonb_build_object('reason','AQL reject and fabric score hold','hold_id',v_reject_hold),v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_reject_inspection,'QUALITY.INSPECTION_CHANGED',
    jsonb_build_object('status','ON_HOLD','version',4,'hold_id',v_reject_hold,'correlation_id',v_correlation));

  -- An independent approver records the approved release disposition; inventory remains unchanged.
  SELECT quantity_on_hand INTO v_stock_before FROM inventory_stock_balances
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item FOR UPDATE;
  PERFORM set_config('app.user_id',v_approver::text,true);
  INSERT INTO quality_dispositions (
    tenant_id,factory_id,inspection_id,hold_id,inventory_item_id,action,status,quantity,reason,
    idempotency_key,request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_reject_inspection,v_reject_hold,v_item,'RELEASE','RECORDED',NULL,
    'Independent reviewer approved release disposition','qa-data-approved-release',repeat('5',64),v_approver,v_correlation
  ) RETURNING id INTO v_disposition;
  UPDATE quality_inspections
  SET status='DISPOSITIONED',row_version=5,updated_by_user_id=v_approver,updated_at=clock_timestamp()
  WHERE id=v_reject_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=4;
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (v_tenant,v_factory,v_reject_inspection,5,'ON_HOLD','DISPOSITIONED','DISPOSITION',
    'Independent reviewer approved release disposition','qa-data-release-event',repeat('6',64),v_approver,v_correlation);
  UPDATE quality_holds
  SET status='RELEASED',released_by_user_id=v_approver,released_at=clock_timestamp(),
      release_reason='Independent reviewer approved release disposition',updated_at=clock_timestamp()
  WHERE id=v_reject_hold AND tenant_id=v_tenant AND factory_id=v_factory AND status='ACTIVE';
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,hold_id,disposition_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_reject_inspection,v_reject_hold,v_disposition,'QUALITY_DISPOSITION_RELEASED',
    jsonb_build_object('disposition_id',v_disposition,'hold_status','RELEASED'),v_approver,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_reject_inspection,'QUALITY.INSPECTION_CHANGED',
    jsonb_build_object('status','DISPOSITIONED','version',5,'disposition_id',v_disposition,'correlation_id',v_correlation));

  IF (SELECT status FROM quality_holds WHERE id=v_reject_hold)<>'RELEASED'
    OR (SELECT status FROM quality_dispositions WHERE id=v_disposition)<>'RECORDED'
    OR (SELECT count(*) FROM quality_holds WHERE inventory_item_id=v_item AND tenant_id=v_tenant AND factory_id=v_factory AND status='ACTIVE')<>0
    OR (SELECT quantity_on_hand FROM inventory_stock_balances WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item)<>v_stock_before THEN
    RAISE EXCEPTION 'Approved release must close the hold without inventing an inventory stock movement';
  END IF;

  -- A separate inspection with an ACCEPT sample is allowed to pass.
  PERFORM set_config('app.user_id',v_actor::text,true);
  INSERT INTO quality_inspections (
    id,tenant_id,factory_id,inspection_type,target_type,target_id,status,row_version,
    idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_accept_inspection,v_tenant,v_factory,'INCOMING','INVENTORY_ITEM',v_item,'OPEN',1,
    'qa-data-accept-inspection',repeat('7',64),v_actor,v_actor,v_correlation
  );
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (v_tenant,v_factory,v_accept_inspection,1,NULL,'OPEN','CREATED',NULL,
    'qa-data-accept-created',repeat('8',64),v_actor,v_correlation);
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_accept_inspection,'INSPECTION_CREATED','{"source":"qa-data-path"}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_accept_inspection,'QUALITY.INSPECTION_CHANGED',
    jsonb_build_object('status','OPEN','version',1,'correlation_id',v_correlation));

  UPDATE quality_inspections SET aql_profile_id=v_aql_profile,row_version=2,updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_accept_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=1;
  INSERT INTO quality_sampling_profile_bindings (
    tenant_id,factory_id,inspection_id,aql_profile_id,fabric_scoring_profile_id,idempotency_key,request_hash,created_by_user_id,correlation_id
  ) VALUES (v_tenant,v_factory,v_accept_inspection,v_aql_profile,NULL,'qa-data-accept-bind',repeat('9',64),v_actor,v_correlation);
  INSERT INTO quality_aql_sample_runs (
    tenant_id,factory_id,inspection_id,profile_id,profile_revision,aql_percent_snapshot,inspection_level_snapshot,
    lot_size,sample_size,accept_number,reject_number,observed_nonconforming,decision,evidence,idempotency_key,request_hash,created_by_user_id,correlation_id
  ) VALUES (v_tenant,v_factory,v_accept_inspection,v_aql_profile,2,2.500,'II',
    100,5,1,3,1,'HOLD','{"sample_sheet":"QA-SHEET-ACCEPT-01"}'::jsonb,
    'qa-data-accept-sample',repeat('a',64),v_actor,v_correlation);
  IF (SELECT decision FROM quality_aql_sample_runs WHERE inspection_id=v_accept_inspection)<>'ACCEPT' THEN
    RAISE EXCEPTION 'AQL accept count must produce ACCEPT';
  END IF;

  UPDATE quality_inspections SET status='IN_PROGRESS',row_version=3,updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_accept_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=2;
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (v_tenant,v_factory,v_accept_inspection,3,'OPEN','IN_PROGRESS','START','Inspection started',
    'qa-data-accept-start',repeat('b',64),v_actor,v_correlation);
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_accept_inspection,'INSPECTION_START','{"status":"IN_PROGRESS","version":3}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_accept_inspection,'QUALITY.INSPECTION_CHANGED',
    jsonb_build_object('status','IN_PROGRESS','version',3,'correlation_id',v_correlation));

  UPDATE quality_inspections SET status='PASSED',row_version=4,updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_accept_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=3;
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (v_tenant,v_factory,v_accept_inspection,4,'IN_PROGRESS','PASSED','PASS','AQL sample accepted',
    'qa-data-accept-pass',repeat('c',64),v_actor,v_correlation);
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_accept_inspection,'INSPECTION_PASS','{"status":"PASSED","version":4}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_accept_inspection,'QUALITY.INSPECTION_CHANGED',
    jsonb_build_object('status','PASSED','version',4,'correlation_id',v_correlation));

  IF (SELECT status FROM quality_inspections WHERE id=v_accept_inspection)<>'PASSED'
    OR (SELECT decision FROM quality_aql_sample_runs WHERE inspection_id=v_accept_inspection)<>'ACCEPT' THEN
    RAISE EXCEPTION 'AQL ACCEPT result must be able to pass its inspection';
  END IF;

  RAISE NOTICE 'AQL reject/accept, fabric roll scoring, pass guard, quarantine and approved release data-path acceptance passed';
END;
$qa_data$;

SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
