-- Populated quality acceptance: one-time profile binding, AQL/fabric decisions, release barrier and disposition evidence.
BEGIN;

DO $advanced_quality_fixture$
DECLARE
  v_tenant UUID := gen_random_uuid();
  v_factory UUID := gen_random_uuid();
  v_actor UUID := gen_random_uuid();
  v_item UUID := gen_random_uuid();
  v_location UUID;
  v_analytics_inspection UUID := gen_random_uuid();
  v_defect_a UUID := gen_random_uuid();
  v_defect_b UUID := gen_random_uuid();
  v_defect_c UUID := gen_random_uuid();
  v_pareto_case RECORD;
  v_pareto_matches INTEGER;
  v_cumulative_pct NUMERIC(6,2);
  v_alert_count INTEGER;
  v_repeat_count INTEGER;
  v_repeat_qty NUMERIC(18,4);
  v_aql_profile UUID := gen_random_uuid();
  v_fabric_profile UUID := gen_random_uuid();
  v_aql_inspection UUID := gen_random_uuid();
  v_fabric_inspection UUID := gen_random_uuid();
  v_hold UUID := gen_random_uuid();
  v_disposition UUID := gen_random_uuid();
  v_scrap_disposition UUID := gen_random_uuid();
  v_scrap_hold UUID := gen_random_uuid();
  v_receipt_movement UUID := gen_random_uuid();
  v_issue_movement UUID := gen_random_uuid();
  v_posted_balance NUMERIC(18,4);
  v_correlation UUID := gen_random_uuid();
  v_request UUID := gen_random_uuid();
  v_pass_blocked BOOLEAN := FALSE;
  v_score NUMERIC(18,4);
  v_decision TEXT;
BEGIN
  INSERT INTO tenants (id,slug,name)
  VALUES (v_tenant,'qa-advanced-'||v_tenant::text,'Advanced Quality Test Tenant');
  INSERT INTO users (id,display_name) VALUES (v_actor,'Advanced Quality Test Actor');
  INSERT INTO factories (id,tenant_id,code,name,status)
  VALUES (v_factory,v_tenant,'QAX-'||upper(substr(v_factory::text,1,8)),'Advanced Quality Test Factory','ACTIVE');

  PERFORM set_config('app.tenant_id',v_tenant::text,TRUE);
  PERFORM set_config('app.user_id',v_actor::text,TRUE);
  PERFORM set_config('app.request_id',v_request::text,TRUE);
  PERFORM set_config('app.trace_id',v_correlation::text,TRUE);

  INSERT INTO inventory_items (id,tenant_id,factory_id,sku,name,unit,created_by_user_id)
  VALUES (v_item,v_tenant,v_factory,'QAX-SKU-'||upper(substr(v_item::text,1,8)),'Advanced quality sample item','PCS',v_actor);
  INSERT INTO inventory_stock_balances (tenant_id,factory_id,item_id,quantity_on_hand)
  VALUES (v_tenant,v_factory,v_item,0);

  INSERT INTO quality_aql_profiles (
    id,tenant_id,factory_id,profile_code,revision,inspection_type,aql_percent,inspection_level,
    lot_size_min,lot_size_max,sample_size,accept_number,reject_number,status,row_version,
    idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_aql_profile,v_tenant,v_factory,'QAX-AQL',1,'SUPPLIER',2.500,'II',
    10,100,5,0,2,'DRAFT',1,'qax-aql-profile',repeat('a',64),v_actor,v_actor,v_correlation
  );
  UPDATE quality_aql_profiles SET status='ACTIVE',row_version=2,updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_aql_profile AND tenant_id=v_tenant AND factory_id=v_factory;

  INSERT INTO quality_inspections (
    id,tenant_id,factory_id,inspection_type,target_type,target_id,inventory_item_id,status,row_version,
    idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_aql_inspection,v_tenant,v_factory,'SUPPLIER','INVENTORY_ITEM',v_item,v_item,'OPEN',1,
    'qax-aql-inspection',repeat('b',64),v_actor,v_actor,v_correlation
  );
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_aql_inspection,1,NULL,'OPEN','CREATED','AQL acceptance fixture created',
    'qax-aql-created',repeat('c',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_aql_inspection,'QAX_INSPECTION_CREATED','{"fixture":"AQL"}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_aql_inspection,'QUALITY.INSPECTION_CHANGED','{"status":"OPEN"}'::jsonb);

  -- Exercise the real trigger path: OPEN -> OPEN is allowed only for a first-time profile binding.
  UPDATE quality_inspections SET aql_profile_id=v_aql_profile,row_version=row_version+1,
    updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_aql_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'AQL profile binding did not update the inspection version'; END IF;
  INSERT INTO quality_sampling_profile_bindings (
    tenant_id,factory_id,inspection_id,aql_profile_id,idempotency_key,request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_aql_inspection,v_aql_profile,'qax-aql-binding',repeat('d',64),v_actor,v_correlation
  );

  INSERT INTO quality_aql_sample_runs (
    tenant_id,factory_id,inspection_id,profile_id,profile_revision,aql_percent_snapshot,inspection_level_snapshot,
    lot_size,sample_size,accept_number,reject_number,observed_nonconforming,decision,evidence,idempotency_key,
    request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_aql_inspection,v_aql_profile,1,2.500,'II',
    40,5,0,2,2,'HOLD','{"sample_sheet":"QAX-AQL-SHEET-001","inspector":"test-actor"}'::jsonb,
    'qax-aql-sample',repeat('e',64),v_actor,v_correlation
  );
  SELECT decision INTO v_decision FROM quality_aql_sample_runs
  WHERE inspection_id=v_aql_inspection AND tenant_id=v_tenant AND factory_id=v_factory;
  IF v_decision IS DISTINCT FROM 'REJECT' THEN
    RAISE EXCEPTION 'AQL reject number must determine the sample decision, got %',v_decision;
  END IF;

  UPDATE quality_inspections SET status='IN_PROGRESS',row_version=row_version+1,
    updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_aql_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=2;
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_aql_inspection,3,'OPEN','IN_PROGRESS','START','Started sampling review',
    'qax-aql-start',repeat('f',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_aql_inspection,'QAX_INSPECTION_STARTED','{"status":"IN_PROGRESS"}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_aql_inspection,'QUALITY.INSPECTION_CHANGED','{"status":"IN_PROGRESS"}'::jsonb);

  BEGIN
    UPDATE quality_inspections SET status='PASSED',row_version=row_version+1,
      updated_by_user_id=v_actor,updated_at=clock_timestamp()
    WHERE id=v_aql_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=3;
  EXCEPTION WHEN check_violation THEN
    v_pass_blocked := TRUE;
  END;
  IF NOT v_pass_blocked THEN
    RAISE EXCEPTION 'Inspection must not pass when its AQL sample decision is REJECT';
  END IF;

  UPDATE quality_inspections SET status='ON_HOLD',row_version=row_version+1,
    updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_aql_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=3;
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_aql_inspection,4,'IN_PROGRESS','ON_HOLD','HOLD','AQL reject requires authorized review',
    'qax-aql-hold',repeat('1',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_aql_inspection,'QAX_AQL_HOLD_CREATED','{"decision":"REJECT"}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_aql_inspection,'QUALITY.INSPECTION_CHANGED','{"status":"ON_HOLD"}'::jsonb);

  INSERT INTO quality_holds (id,tenant_id,factory_id,inspection_id,inventory_item_id,reason,created_by_user_id,correlation_id)
  VALUES (v_hold,v_tenant,v_factory,v_aql_inspection,v_item,'AQL acceptance fixture hold',v_actor,v_correlation);
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,hold_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_aql_inspection,v_hold,'QAX_HOLD_RECORDED','{"status":"ACTIVE"}'::jsonb,v_actor,v_correlation);

  INSERT INTO quality_dispositions (
    id,tenant_id,factory_id,inspection_id,hold_id,inventory_item_id,action,status,reason,
    idempotency_key,request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_disposition,v_tenant,v_factory,v_aql_inspection,v_hold,v_item,'RELEASE','RECORDED',
    'Authorized release after documented sample review','qax-aql-release',repeat('2',64),v_actor,v_correlation
  );

  UPDATE quality_holds SET status='RELEASED',released_by_user_id=v_actor,released_at=clock_timestamp(),
    release_reason='Authorized release after documented sample review',updated_at=clock_timestamp()
  WHERE id=v_hold AND tenant_id=v_tenant AND factory_id=v_factory AND status='ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'Authorized disposition failed to release the active hold'; END IF;

  UPDATE quality_inspections SET status='DISPOSITIONED',row_version=row_version+1,
    updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_aql_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=4;
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_aql_inspection,5,'ON_HOLD','DISPOSITIONED','DISPOSITION','Authorized release disposition recorded',
    'qax-aql-disposition',repeat('3',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,hold_id,disposition_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_aql_inspection,v_hold,v_disposition,'QAX_DISPOSITION_RECORDED','{"action":"RELEASE"}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_aql_inspection,'QUALITY.INSPECTION_CHANGED','{"status":"DISPOSITIONED"}'::jsonb);

  IF (SELECT status FROM quality_holds WHERE id=v_hold) IS DISTINCT FROM 'RELEASED'
    OR (SELECT status FROM quality_dispositions WHERE id=v_disposition) IS DISTINCT FROM 'RECORDED'
    OR (SELECT quantity_on_hand FROM inventory_stock_balances WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item) <> 0 THEN
    RAISE EXCEPTION 'Release disposition evidence or inventory conservation was inconsistent';
  END IF;

  -- Fabric scoring uses the real append-only trigger and its four-point score calculation.
  INSERT INTO quality_fabric_scoring_profiles (
    id,tenant_id,factory_id,profile_code,revision,inspection_type,max_points_per_100_square_yards,
    minimum_roll_count,status,row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_fabric_profile,v_tenant,v_factory,'QAX-FABRIC',1,'SUPPLIER',6.0000,2,'DRAFT',1,
    'qax-fabric-profile',repeat('4',64),v_actor,v_actor,v_correlation
  );
  UPDATE quality_fabric_scoring_profiles SET status='ACTIVE',row_version=row_version+1,
    updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_fabric_profile AND tenant_id=v_tenant AND factory_id=v_factory;

  INSERT INTO quality_inspections (
    id,tenant_id,factory_id,inspection_type,target_type,target_id,inventory_item_id,status,row_version,
    idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_fabric_inspection,v_tenant,v_factory,'SUPPLIER','INVENTORY_ITEM',v_item,v_item,'OPEN',1,
    'qax-fabric-inspection',repeat('5',64),v_actor,v_actor,v_correlation
  );
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_fabric_inspection,1,NULL,'OPEN','CREATED','Fabric roll acceptance fixture created',
    'qax-fabric-created',repeat('6',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_fabric_inspection,'QAX_FABRIC_INSPECTION_CREATED','{"fixture":"fabric-roll"}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_fabric_inspection,'QUALITY.INSPECTION_CHANGED','{"status":"OPEN"}'::jsonb);

  UPDATE quality_inspections SET fabric_scoring_profile_id=v_fabric_profile,row_version=row_version+1,
    updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_fabric_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=1;
  INSERT INTO quality_sampling_profile_bindings (
    tenant_id,factory_id,inspection_id,fabric_scoring_profile_id,idempotency_key,request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_fabric_inspection,v_fabric_profile,'qax-fabric-binding',repeat('7',64),v_actor,v_correlation
  );

  INSERT INTO quality_fabric_roll_scores (
    tenant_id,factory_id,inspection_id,profile_id,profile_revision,roll_code,roll_length_yards,roll_width_inches,
    total_defect_points,points_per_100_square_yards,max_points_snapshot,decision,defects,evidence,idempotency_key,
    request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_fabric_inspection,v_fabric_profile,1,'ROLL-PASS',100,60,10,0,6,'HOLD',
    '[{"code":"SLUB","points":10}]'::jsonb,'{"inspection_sheet":"QAX-ROLL-PASS"}'::jsonb,
    'qax-roll-pass',repeat('8',64),v_actor,v_correlation
  );
  INSERT INTO quality_fabric_roll_scores (
    tenant_id,factory_id,inspection_id,profile_id,profile_revision,roll_code,roll_length_yards,roll_width_inches,
    total_defect_points,points_per_100_square_yards,max_points_snapshot,decision,defects,evidence,idempotency_key,
    request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_fabric_inspection,v_fabric_profile,1,'ROLL-HOLD',100,60,12,0,6,'PASS',
    '[{"code":"HOLE","points":12}]'::jsonb,'{"inspection_sheet":"QAX-ROLL-HOLD"}'::jsonb,
    'qax-roll-hold',repeat('9',64),v_actor,v_correlation
  );
  SELECT points_per_100_square_yards,decision INTO v_score,v_decision FROM quality_fabric_roll_scores
  WHERE inspection_id=v_fabric_inspection AND roll_code='ROLL-PASS';
  IF v_score<>6.0000 OR v_decision<>'PASS' THEN
    RAISE EXCEPTION 'Fabric roll score on the approved limit should pass, got score %, decision %',v_score,v_decision;
  END IF;
  SELECT points_per_100_square_yards,decision INTO v_score,v_decision FROM quality_fabric_roll_scores
  WHERE inspection_id=v_fabric_inspection AND roll_code='ROLL-HOLD';
  IF v_score<>7.2000 OR v_decision<>'HOLD' THEN
    RAISE EXCEPTION 'Fabric roll score above the approved limit should hold, got score %, decision %',v_score,v_decision;
  END IF;

  UPDATE quality_inspections SET status='IN_PROGRESS',row_version=row_version+1,
    updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_fabric_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=2;
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_fabric_inspection,3,'OPEN','IN_PROGRESS','START','Started fabric roll decision',
    'qax-fabric-start',repeat('0',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_fabric_inspection,'QAX_FABRIC_INSPECTION_STARTED','{"status":"IN_PROGRESS"}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_fabric_inspection,'QUALITY.INSPECTION_CHANGED','{"status":"IN_PROGRESS"}'::jsonb);
  v_pass_blocked:=FALSE;
  BEGIN
    UPDATE quality_inspections SET status='PASSED',row_version=row_version+1,
      updated_by_user_id=v_actor,updated_at=clock_timestamp()
    WHERE id=v_fabric_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=3;
  EXCEPTION WHEN check_violation THEN
    v_pass_blocked:=TRUE;
  END;
  IF NOT v_pass_blocked THEN
    RAISE EXCEPTION 'Fabric-scored inspection must not pass when a roll is on HOLD';
  END IF;

  -- Exercise a full SCRAP through the same stock-balance-before-movement order used by InventoryService.
  -- A full issue is only completed when the disposition and hold are finalized by the inventory trigger.
  SELECT id INTO v_location FROM inventory_locations
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND is_default=TRUE AND status='ACTIVE';
  IF v_location IS NULL THEN RAISE EXCEPTION 'Default inventory location is required for SCRAP fixture'; END IF;

  UPDATE quality_inspections SET status='ON_HOLD',row_version=row_version+1,
    updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_fabric_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=3;
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_fabric_inspection,4,'IN_PROGRESS','ON_HOLD','HOLD',
    'Fabric roll failed approved point limit; item stock must remain quarantined',
    'qax-fabric-hold',repeat('1',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (
    v_tenant,v_factory,v_fabric_inspection,'QAX_FABRIC_HOLD_CREATED',
    '{"reason":"roll-score-over-limit"}'::jsonb,v_actor,v_correlation
  );
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (
    v_tenant,v_factory,'QUALITY_INSPECTION',v_fabric_inspection,'QUALITY.INSPECTION_CHANGED',
    '{"status":"ON_HOLD"}'::jsonb
  );
  INSERT INTO quality_holds (
    id,tenant_id,factory_id,inspection_id,inventory_item_id,reason,created_by_user_id,correlation_id
  ) VALUES (
    v_scrap_hold,v_tenant,v_factory,v_fabric_inspection,v_item,
    'Approved scrap hold for failing roll fixture',v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (
    tenant_id,factory_id,inspection_id,hold_id,action_type,payload,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_fabric_inspection,v_scrap_hold,'QAX_SCRAP_HOLD_RECORDED',
    '{"status":"ACTIVE"}'::jsonb,v_actor,v_correlation
  );

  PERFORM set_config('app.inventory_location_id',v_location::text,TRUE);
  UPDATE inventory_stock_balances SET quantity_on_hand=quantity_on_hand+5,
    version=version+1,updated_at=clock_timestamp()
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item
  RETURNING quantity_on_hand INTO v_posted_balance;
  INSERT INTO inventory_movements (
    id,tenant_id,factory_id,item_id,location_id,movement_type,quantity,quantity_delta,quantity_after,
    idempotency_key,request_hash,reference_type,reference_id,notes,created_by_user_id,correlation_id
  ) VALUES (
    v_receipt_movement,v_tenant,v_factory,v_item,v_location,'RECEIPT',5,5,v_posted_balance,
    'qax-scrap-fixture-receipt',repeat('4',64),'QAX_FIXTURE_RECEIPT',NULL,
    'Fixture stock to be scrapped through quality disposition',v_actor,v_correlation
  );

  INSERT INTO quality_dispositions (
    id,tenant_id,factory_id,inspection_id,hold_id,inventory_item_id,action,status,quantity,reason,
    idempotency_key,request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_scrap_disposition,v_tenant,v_factory,v_fabric_inspection,v_scrap_hold,v_item,'SCRAP','PENDING_INVENTORY',5,
    'Approved full stock scrap after fabric scoring failure',
    'qax-scrap-disposition',repeat('5',64),v_actor,v_correlation
  );
  UPDATE inventory_stock_balances SET quantity_on_hand=quantity_on_hand-5,
    version=version+1,updated_at=clock_timestamp()
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item
    AND quantity_on_hand-5>=quantity_reserved
  RETURNING quantity_on_hand INTO v_posted_balance;
  IF v_posted_balance IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'SCRAP did not reduce the aggregate inventory balance to zero';
  END IF;
  INSERT INTO inventory_movements (
    id,tenant_id,factory_id,item_id,location_id,movement_type,quantity,quantity_delta,quantity_after,
    idempotency_key,request_hash,reference_type,reference_id,notes,created_by_user_id,correlation_id
  ) VALUES (
    v_issue_movement,v_tenant,v_factory,v_item,v_location,'ISSUE',5,-5,v_posted_balance,
    'qax-scrap-stock-issue',repeat('6',64),'QUALITY_DISPOSITION',v_scrap_disposition,
    'Actual stock removal for approved quality SCRAP disposition',v_actor,v_correlation
  );

  IF (SELECT quantity_on_hand FROM inventory_stock_balances
      WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item)<>0
    OR (SELECT quantity_on_hand FROM inventory_location_balances
      WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item AND location_id=v_location)<>0
    OR (SELECT quantity_reserved FROM inventory_location_balances
      WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item AND location_id=v_location)<>0
    OR (SELECT status FROM quality_dispositions WHERE id=v_scrap_disposition)<>'COMPLETED'
    OR (SELECT inventory_movement_id FROM quality_dispositions WHERE id=v_scrap_disposition) IS DISTINCT FROM v_issue_movement
    OR (SELECT status FROM quality_holds WHERE id=v_scrap_hold)<>'DISPOSED' THEN
    RAISE EXCEPTION 'Approved SCRAP must reconcile aggregate/bin balances, movement evidence, completed disposition and disposed hold';
  END IF;


  -- Populate three real defect/context records and exercise every Pareto dimension
  -- plus repeat-alert grouping in the same tenant/factory used by this fixture.
  INSERT INTO quality_inspections (
    id,tenant_id,factory_id,inspection_type,target_type,target_id,inventory_item_id,status,row_version,
    idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_analytics_inspection,v_tenant,v_factory,'IN_PROCESS','INVENTORY_ITEM',v_item,v_item,'OPEN',1,
    'qax-analytics-inspection',repeat('7',64),v_actor,v_actor,v_correlation
  );
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_analytics_inspection,1,NULL,'OPEN','CREATED','Pareto and repeat-alert fixture',
    'qax-analytics-inspection-created',repeat('8',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_analytics_inspection,'QUALITY_INSPECTION_CREATED','{"fixture":"pareto-repeat-alert"}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_analytics_inspection,'QUALITY.INSPECTION_CHANGED','{"status":"OPEN","fixture":"pareto-repeat-alert"}'::jsonb);

  INSERT INTO quality_defects (
    id,tenant_id,factory_id,inspection_id,defect_code,severity,affected_quantity,description,evidence,
    idempotency_key,request_hash,reported_by_user_id,updated_by_user_id,correlation_id
  ) VALUES
    (v_defect_a,v_tenant,v_factory,v_analytics_inspection,'FABRIC_HOLE','MAJOR',3.2500,'Hole in first sample roll',
      '{"inspection_sheet":"QAX-PARETO-001","photo":"evidence://roll-001"}'::jsonb,
      'qax-defect-a',repeat('a',64),v_actor,v_actor,v_correlation),
    (v_defect_b,v_tenant,v_factory,v_analytics_inspection,'FABRIC_HOLE','MAJOR',2.7500,'Hole in second sample roll',
      '{"inspection_sheet":"QAX-PARETO-002","photo":"evidence://roll-002"}'::jsonb,
      'qax-defect-b',repeat('b',64),v_actor,v_actor,v_correlation),
    (v_defect_c,v_tenant,v_factory,v_analytics_inspection,'SLUB','MINOR',1.0000,'Slub found in third sample roll',
      '{"inspection_sheet":"QAX-PARETO-003"}'::jsonb,
      'qax-defect-c',repeat('c',64),v_actor,v_actor,v_correlation);

  INSERT INTO quality_defect_events (
    tenant_id,factory_id,defect_id,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES
    (v_tenant,v_factory,v_defect_a,NULL,'OPEN','REPORTED','Hole found on line A','qax-defect-a:reported',repeat('d',64),v_actor,v_correlation),
    (v_tenant,v_factory,v_defect_b,NULL,'OPEN','REPORTED','Second hole found on line A','qax-defect-b:reported',repeat('e',64),v_actor,v_correlation),
    (v_tenant,v_factory,v_defect_c,NULL,'OPEN','REPORTED','Slub found on line B','qax-defect-c:reported',repeat('f',64),v_actor,v_correlation);

  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES
    (v_tenant,v_factory,v_analytics_inspection,v_defect_a,'DEFECT_RECORDED','{"defect_code":"FABRIC_HOLE","affected_quantity":3.2500}'::jsonb,v_actor,v_correlation),
    (v_tenant,v_factory,v_analytics_inspection,v_defect_b,'DEFECT_RECORDED','{"defect_code":"FABRIC_HOLE","affected_quantity":2.7500}'::jsonb,v_actor,v_correlation),
    (v_tenant,v_factory,v_analytics_inspection,v_defect_c,'DEFECT_RECORDED','{"defect_code":"SLUB","affected_quantity":1.0000}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES
    (v_tenant,v_factory,'QUALITY_DEFECT',v_defect_a,'QUALITY.DEFECT_CHANGED','{"action":"DEFECT_RECORDED"}'::jsonb),
    (v_tenant,v_factory,'QUALITY_DEFECT',v_defect_b,'QUALITY.DEFECT_CHANGED','{"action":"DEFECT_RECORDED"}'::jsonb),
    (v_tenant,v_factory,'QUALITY_DEFECT',v_defect_c,'QUALITY.DEFECT_CHANGED','{"action":"DEFECT_RECORDED"}'::jsonb);

  INSERT INTO quality_defect_context_snapshots (
    tenant_id,factory_id,defect_id,line_code,operation_code,style_code,shift_code,evidence,
    idempotency_key,request_hash,created_by_user_id
  ) VALUES
    (v_tenant,v_factory,v_defect_a,'LINE-A','CUTTING','STYLE-A','DAY',
      '{"context_sheet":"QAX-CONTEXT-001"}'::jsonb,'qax-context-a',repeat('1',64),v_actor),
    (v_tenant,v_factory,v_defect_b,'LINE-A','CUTTING','STYLE-A','DAY',
      '{"context_sheet":"QAX-CONTEXT-002"}'::jsonb,'qax-context-b',repeat('2',64),v_actor),
    (v_tenant,v_factory,v_defect_c,'LINE-B','SEWING','STYLE-B','NIGHT',
      '{"context_sheet":"QAX-CONTEXT-003"}'::jsonb,'qax-context-c',repeat('3',64),v_actor);

  FOR v_pareto_case IN
    SELECT * FROM (VALUES
      ('DEFECT','FABRIC_HOLE'),
      ('LINE','LINE-A'),
      ('OPERATION','CUTTING'),
      ('STYLE','STYLE-A'),
      ('SHIFT','DAY')
    ) AS expected(dimension_name,dimension_value)
  LOOP
    SELECT count(*) INTO v_pareto_matches
    FROM (
      SELECT CASE v_pareto_case.dimension_name
        WHEN 'DEFECT' THEN d.defect_code
        WHEN 'LINE' THEN c.line_code
        WHEN 'OPERATION' THEN c.operation_code
        WHEN 'STYLE' THEN c.style_code
        WHEN 'SHIFT' THEN c.shift_code
      END AS dimension_value,count(*)::INTEGER AS defect_count
      FROM quality_defects d
      LEFT JOIN quality_defect_context_snapshots c
        ON c.defect_id=d.id AND c.tenant_id=d.tenant_id AND c.factory_id=d.factory_id
      WHERE d.tenant_id=v_tenant AND d.factory_id=v_factory
      GROUP BY 1
    ) grouped
    WHERE grouped.dimension_value=v_pareto_case.dimension_value AND grouped.defect_count=2;
    IF v_pareto_matches<>1 THEN
      RAISE EXCEPTION 'Pareto dimension % should show exactly two % defects; matched rows=%',
        v_pareto_case.dimension_name,v_pareto_case.dimension_value,v_pareto_matches;
    END IF;
  END LOOP;

  WITH grouped AS (
    SELECT d.defect_code AS dimension_value,count(*)::INTEGER AS defect_count
    FROM quality_defects d
    WHERE d.tenant_id=v_tenant AND d.factory_id=v_factory
    GROUP BY d.defect_code
  ), ranked AS (
    SELECT grouped.*,sum(defect_count) OVER ()::NUMERIC AS total_defects,
      sum(defect_count) OVER (ORDER BY defect_count DESC,dimension_value
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_defects
    FROM grouped
  )
  SELECT round(100*cumulative_defects/NULLIF(total_defects,0),2) INTO v_cumulative_pct
  FROM ranked WHERE dimension_value='FABRIC_HOLE';
  IF v_cumulative_pct IS DISTINCT FROM 66.67 THEN
    RAISE EXCEPTION 'Defect Pareto cumulative percentage should be 66.67%% for the top two-of-three group; got %',v_cumulative_pct;
  END IF;

  WITH defect_source AS (
    SELECT d.id,d.defect_code,d.severity,d.affected_quantity,d.status,d.created_at,c.style_code
    FROM quality_defects d
    LEFT JOIN quality_defect_context_snapshots c
      ON c.defect_id=d.id AND c.tenant_id=d.tenant_id AND c.factory_id=d.factory_id
    WHERE d.tenant_id=v_tenant AND d.factory_id=v_factory
      AND d.created_at>=clock_timestamp()-INTERVAL '365 days'
  ), supplier_by_defect AS (
    SELECT DISTINCT ON (e.defect_id) e.defect_id,e.supplier_id,s.code AS supplier_code
    FROM quality_supplier_quality_events e JOIN suppliers s ON s.id=e.supplier_id AND s.tenant_id=e.tenant_id
    WHERE e.tenant_id=v_tenant AND e.factory_id=v_factory ORDER BY e.defect_id,e.created_at
  ), rework_by_defect AS (
    SELECT defect_id,count(*)::INTEGER AS task_count FROM quality_rework_orders
    WHERE tenant_id=v_tenant AND factory_id=v_factory AND status<>'CANCELLED' GROUP BY defect_id
  ), alerts AS (
    SELECT ds.defect_code,COALESCE(ds.style_code,'(not captured)') AS style_code,
      sbd.supplier_id,sbd.supplier_code,count(DISTINCT ds.id)::INTEGER AS occurrence_count,
      count(DISTINCT ds.id) FILTER (WHERE ds.severity='CRITICAL')::INTEGER AS critical_count,
      sum(ds.affected_quantity)::NUMERIC(18,4) AS affected_quantity,
      count(DISTINCT ds.id) FILTER (WHERE ds.status IN ('OPEN','REWORK'))::INTEGER AS unresolved_count,
      sum(COALESCE(rbd.task_count,0))::INTEGER AS rework_task_count,
      CASE WHEN count(DISTINCT ds.id) FILTER (WHERE ds.severity='CRITICAL')>0 THEN 'HIGH'
           WHEN count(DISTINCT ds.id)>=4 THEN 'MEDIUM' ELSE 'WATCH' END AS alert_level
    FROM defect_source ds
    LEFT JOIN supplier_by_defect sbd ON sbd.defect_id=ds.id
    LEFT JOIN rework_by_defect rbd ON rbd.defect_id=ds.id
    GROUP BY ds.defect_code,ds.style_code,sbd.supplier_id,sbd.supplier_code
    HAVING count(DISTINCT ds.id)>=2
  )
  SELECT count(*)::INTEGER,max(occurrence_count),max(affected_quantity)
    INTO v_alert_count,v_repeat_count,v_repeat_qty
  FROM alerts WHERE defect_code='FABRIC_HOLE' AND style_code='STYLE-A';
  IF v_alert_count<>1 OR v_repeat_count<>2 OR v_repeat_qty<>6.0000 THEN
    RAISE EXCEPTION 'Repeated-defect alert should report two STYLE-A holes and affected quantity 6.0000; got rows %, count %, quantity %',
      v_alert_count,v_repeat_count,v_repeat_qty;
  END IF;

  SET CONSTRAINTS ctr_quality_inspection_evidence IMMEDIATE;
  RAISE NOTICE 'Populated advanced quality fixture passed: one-time binding, AQL reject/pass barrier, authorized release, supplier evidence fixture, fabric scoring/pass barrier and SCRAP ledger/hold reconciliation';
END;
$advanced_quality_fixture$;

ROLLBACK;
