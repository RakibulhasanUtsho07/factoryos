-- Behavioural contract for cumulative/interval metering, intensity, ordering and utility-event lifecycle.
BEGIN;
SELECT set_config('app.tenant_id','faaab63d-c447-46ce-950d-deebdd7f5f30',true);
SELECT set_config('app.user_id','921382b8-e83f-43ab-a576-e3db6a06b70c',true);
DO $utility_test$
DECLARE
  v_actor UUID:=factoryos_current_user_id();
  v_tenant UUID:='faaab63d-c447-46ce-950d-deebdd7f5f30';
  v_factory UUID:='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
  v_parent UUID:=gen_random_uuid();
  v_child UUID:=gen_random_uuid();
  v_hash CHAR(64):=encode(digest('utility lifecycle CI contract','sha256'),'hex');
  v_corr UUID:=gen_random_uuid();
  v_reading UUID:=gen_random_uuid();
  v_event UUID:=gen_random_uuid();
  v_qty NUMERIC;
  v_cost NUMERIC;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'utility actor context was not established'; END IF;

  INSERT INTO utility_meters(
    id,tenant_id,factory_id,meter_code,name,utility_type,reading_mode,unit_code,multiplier_factor,unit_cost,
    currency_code,cost_center_code,source_system_code,location,idempotency_key,request_hash,
    created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES(
    v_parent,v_tenant,v_factory,'CI-ELEC-MAIN','CI main electricity meter','ELECTRICITY','CUMULATIVE','kWh',1,0.25,
    'BDT','CC-UTIL','CI-METER-GW','Main switch room','ci-utility-parent',v_hash,v_actor,v_actor,v_corr
  );
  INSERT INTO utility_meters(
    id,tenant_id,factory_id,parent_meter_id,meter_code,name,utility_type,reading_mode,unit_code,multiplier_factor,unit_cost,
    currency_code,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES(
    v_child,v_tenant,v_factory,v_parent,'CI-WATER-SUB','CI water sub-meter','WATER','INTERVAL','m3',2,0.1,
    'BDT','ci-utility-child',v_hash,v_actor,v_actor,gen_random_uuid()
  );

  -- First cumulative observation establishes the counter baseline without inventing consumption.
  v_corr:=gen_random_uuid();
  INSERT INTO utility_meter_readings(
    id,tenant_id,factory_id,meter_id,reading_at,reading_value,previous_reading_value,consumption_quantity,
    unit_code,unit_cost_snapshot,cost_amount,source_type,source_event_id,idempotency_key,request_hash,
    recorded_by_user_id,correlation_id
  ) VALUES(
    v_reading,v_tenant,v_factory,v_parent,clock_timestamp()-INTERVAL '2 hours',100,NULL,0,
    'kWh',0.25,0,'METER_GATEWAY','ci-electric-001','ci-utility-reading-1',v_hash,v_actor,v_corr
  );
  v_corr:=gen_random_uuid();
  INSERT INTO utility_meter_readings(
    tenant_id,factory_id,meter_id,reading_at,reading_value,previous_reading_value,consumption_quantity,
    unit_code,unit_cost_snapshot,cost_amount,production_quantity,source_type,source_event_id,notes,
    idempotency_key,request_hash,recorded_by_user_id,correlation_id
  ) VALUES(
    v_tenant,v_factory,v_parent,clock_timestamp()-INTERVAL '1 hour',120,100,20,
    'kWh',0.25,5,10,'METER_GATEWAY','ci-electric-002','Baseline-to-current consumption',
    'ci-utility-reading-2',v_hash,v_actor,v_corr
  );
  SELECT consumption_quantity,cost_amount INTO v_qty,v_cost FROM utility_meter_readings
    WHERE tenant_id=v_tenant AND factory_id=v_factory AND idempotency_key='ci-utility-reading-2';
  IF v_qty<>20 OR v_cost<>5 THEN RAISE EXCEPTION 'Cumulative reading consumption/cost calculation incorrect: %, %',v_qty,v_cost; END IF;

  INSERT INTO utility_meter_readings(
    tenant_id,factory_id,meter_id,reading_at,reading_value,previous_reading_value,consumption_quantity,
    unit_code,unit_cost_snapshot,cost_amount,production_quantity,source_type,idempotency_key,request_hash,
    recorded_by_user_id,correlation_id
  ) VALUES(
    v_tenant,v_factory,v_child,clock_timestamp()-INTERVAL '30 minutes',12.5,NULL,25,
    'm3',0.1,2.5,5,'MANUAL','ci-utility-interval',v_hash,v_actor,gen_random_uuid()
  );
  SELECT consumption_quantity,cost_amount,intensity_per_unit INTO v_qty,v_cost
    FROM utility_meter_readings WHERE tenant_id=v_tenant AND factory_id=v_factory AND idempotency_key='ci-utility-interval';
  IF v_qty<>25 OR v_cost<>2.5 OR
    (SELECT intensity_per_unit FROM utility_meter_readings WHERE tenant_id=v_tenant AND factory_id=v_factory AND idempotency_key='ci-utility-interval')<>5
  THEN RAISE EXCEPTION 'Interval utility consumption, cost or per-unit intensity is incorrect'; END IF;

  -- Metering evidence must be strictly time-ordered and append-only.
  BEGIN
    INSERT INTO utility_meter_readings(
      tenant_id,factory_id,meter_id,reading_at,reading_value,previous_reading_value,consumption_quantity,
      unit_code,unit_cost_snapshot,cost_amount,source_type,idempotency_key,request_hash,recorded_by_user_id,correlation_id
    ) VALUES(
      v_tenant,v_factory,v_parent,clock_timestamp()-INTERVAL '90 minutes',115,120,0,'kWh',0.25,0,
      'MANUAL','ci-utility-out-of-order',v_hash,v_actor,gen_random_uuid()
    );
    RAISE EXCEPTION 'expected out-of-order utility reading to be rejected' USING ERRCODE='P0001';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    UPDATE utility_meters SET parent_meter_id=v_child,row_version=2,updated_by_user_id=v_actor,updated_at=clock_timestamp()
      WHERE id=v_parent AND tenant_id=v_tenant AND factory_id=v_factory;
    RAISE EXCEPTION 'expected utility meter hierarchy cycle to be rejected' USING ERRCODE='P0001';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO utility_events(
    id,tenant_id,factory_id,meter_id,event_number,event_type,severity,title,description,occurred_at,
    impact_minutes,impact_quantity,cause,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES(
    v_event,v_tenant,v_factory,v_parent,'CI-UTILITY-OUTAGE','OUTAGE','HIGH','CI outage',
    'Power interrupted on the main feed',clock_timestamp()-INTERVAL '20 minutes',15,4,'Grid trip',
    'ci-utility-event',v_hash,v_actor,v_actor,gen_random_uuid()
  );
  UPDATE utility_events SET status='ACKNOWLEDGED',row_version=2,last_change_reason='Technician acknowledged',
    updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_event AND tenant_id=v_tenant AND factory_id=v_factory;
  UPDATE utility_events SET status='RESOLVED',row_version=3,resolved_at=clock_timestamp(),
    resolution='Supply restored and monitored stable',last_change_reason='Power restored',
    updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_event AND tenant_id=v_tenant AND factory_id=v_factory;
  IF (SELECT status FROM utility_events WHERE id=v_event) <> 'RESOLVED' THEN
    RAISE EXCEPTION 'Utility event did not reach RESOLVED state';
  END IF;
  IF (SELECT count(*) FROM utility_audit_events WHERE entity_id IN (v_parent,v_child,v_event))<5 THEN
    RAISE EXCEPTION 'Utility meter/event lifecycle audit records are incomplete';
  END IF;
  IF (SELECT count(*) FROM utility_audit_events WHERE entity_type='READING'
      AND tenant_id=v_tenant AND factory_id=v_factory) < 3 THEN
    RAISE EXCEPTION 'Each append-only utility reading must produce a corresponding audit record';
  END IF;
END
$utility_test$;
ROLLBACK;
