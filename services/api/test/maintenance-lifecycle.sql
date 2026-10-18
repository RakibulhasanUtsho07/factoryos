-- Behavioural PostgreSQL contract for maintenance hierarchy, approval and work-order lifecycle.
BEGIN;

SELECT set_config('app.tenant_id','faaab63d-c447-46ce-950d-deebdd7f5f30',true);
SELECT set_config('app.user_id','921382b8-e83f-43ab-a576-e3db6a06b70c',true);

DO $maintenance_test$
DECLARE
  v_actor UUID := factoryos_current_user_id();
  v_tenant UUID := 'faaab63d-c447-46ce-950d-deebdd7f5f30';
  v_factory UUID := '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
  v_root UUID := gen_random_uuid();
  v_child UUID := gen_random_uuid();
  v_plan UUID := gen_random_uuid();
  v_work_order UUID := gen_random_uuid();
  v_task UUID := gen_random_uuid();
  v_nonmember UUID := gen_random_uuid();
  v_hash CHAR(64) := encode(digest('maintenance lifecycle behavioural contract','sha256'),'hex');
  v_corr UUID;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'maintenance CI actor context was not established';
  END IF;

  INSERT INTO users (id,display_name,status)
  VALUES (v_nonmember,'Maintenance CI non-member','ACTIVE');

  -- Register two assets and attach auditable creation events.
  v_corr := gen_random_uuid();
  INSERT INTO maintenance_assets (
    id,tenant_id,factory_id,asset_code,name,asset_type,criticality,status,commissioned_on,
    row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_root,v_tenant,v_factory,'CI-MAINT-ROOT','CI maintenance parent','LINE','HIGH','ACTIVE',CURRENT_DATE,
    1,'ci-maint-root-create',v_hash,v_actor,v_actor,v_corr
  );
  INSERT INTO maintenance_events (
    tenant_id,factory_id,entity_type,entity_id,entity_version,action,to_status,reason,event_data,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,'ASSET',v_root,1,'CREATED','ACTIVE','Maintenance CI fixture created',
    '{}'::jsonb,'ci-maint-root-event',v_hash,v_actor,v_corr
  );

  v_corr := gen_random_uuid();
  INSERT INTO maintenance_assets (
    id,tenant_id,factory_id,parent_asset_id,asset_code,name,asset_type,criticality,status,commissioned_on,
    row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_child,v_tenant,v_factory,v_root,'CI-MAINT-CHILD','CI drive motor','MOTOR','CRITICAL','ACTIVE',CURRENT_DATE,
    1,'ci-maint-child-create',v_hash,v_actor,v_actor,v_corr
  );
  INSERT INTO maintenance_events (
    tenant_id,factory_id,entity_type,entity_id,entity_version,action,to_status,reason,event_data,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,'ASSET',v_child,1,'CREATED','ACTIVE','Maintenance CI fixture created',
    '{}'::jsonb,'ci-maint-child-event',v_hash,v_actor,v_corr
  );

  -- A parent cannot point to its own descendant and cannot be retired under an active child.
  BEGIN
    UPDATE maintenance_assets SET parent_asset_id=v_child,row_version=2,updated_by_user_id=v_actor,
      updated_at=clock_timestamp() WHERE id=v_root AND tenant_id=v_tenant AND factory_id=v_factory;
    RAISE EXCEPTION 'expected the asset hierarchy cycle guard to reject the update' USING ERRCODE='P0001';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    UPDATE maintenance_assets SET status='INACTIVE',row_version=2,updated_by_user_id=v_actor,
      updated_at=clock_timestamp() WHERE id=v_root AND tenant_id=v_tenant AND factory_id=v_factory;
    RAISE EXCEPTION 'expected the active-child guard to reject asset inactivation' USING ERRCODE='P0001';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- PM plan creator cannot approve their own preventive-maintenance plan.
  v_corr := gen_random_uuid();
  INSERT INTO maintenance_pm_plans (
    id,tenant_id,factory_id,asset_id,plan_code,revision,name,description,interval_value,interval_unit,
    next_due_on,estimated_duration_minutes,requires_shutdown,checklist,status,row_version,idempotency_key,
    request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_plan,v_tenant,v_factory,v_child,'CI-DAILY-CHECK',1,'Daily CI check','Behavioural PM fixture',
    1,'DAY',CURRENT_DATE,30,false,'[]'::jsonb,'DRAFT',1,'ci-maint-pm-create',v_hash,v_actor,v_actor,v_corr
  );
  INSERT INTO maintenance_events (
    tenant_id,factory_id,entity_type,entity_id,entity_version,action,to_status,reason,event_data,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,'PM_PLAN',v_plan,1,'CREATED','DRAFT','Maintenance CI PM plan created',
    '{}'::jsonb,'ci-maint-pm-event',v_hash,v_actor,v_corr
  );
  BEGIN
    UPDATE maintenance_pm_plans SET status='ACTIVE',approved_by_user_id=v_nonmember,approved_at=clock_timestamp(),
      row_version=2,updated_by_user_id=v_actor,updated_at=clock_timestamp()
    WHERE id=v_plan AND tenant_id=v_tenant AND factory_id=v_factory;
    RAISE EXCEPTION 'expected PM approver scope guard to reject a non-member' USING ERRCODE='P0001';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    UPDATE maintenance_pm_plans SET status='ACTIVE',approved_by_user_id=v_actor,approved_at=clock_timestamp(),
      row_version=2,updated_by_user_id=v_actor,updated_at=clock_timestamp()
    WHERE id=v_plan AND tenant_id=v_tenant AND factory_id=v_factory;
    RAISE EXCEPTION 'expected PM maker-checker to reject self-approval' USING ERRCODE='P0001';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO maintenance_work_orders (
      tenant_id,factory_id,work_order_number,work_order_type,asset_id,priority,status,title,description,
      assigned_to_user_id,row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
    ) VALUES (
      v_tenant,v_factory,'CI-MAINT-WO-OUT-OF-TENANT','BREAKDOWN',v_child,'HIGH','PLANNED',
      'Invalid assignee test','This insert must be rejected',v_nonmember,1,'ci-maint-wo-nonmember',v_hash,
      v_actor,v_actor,gen_random_uuid()
    );
    RAISE EXCEPTION 'expected the work-order assignee guard to reject a non-member' USING ERRCODE='P0001';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- A breakdown work order must pass through valid states, record start evidence,
  -- and cannot complete while a required checklist item remains pending.
  v_corr := gen_random_uuid();
  INSERT INTO maintenance_work_orders (
    id,tenant_id,factory_id,work_order_number,work_order_type,asset_id,priority,status,title,description,
    row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_work_order,v_tenant,v_factory,'CI-MAINT-WO-01','BREAKDOWN',v_child,'HIGH','PLANNED',
    'CI motor inspection','Check bearing and coupling',1,'ci-maint-wo-create',v_hash,v_actor,v_actor,v_corr
  );
  INSERT INTO maintenance_events (
    tenant_id,factory_id,entity_type,entity_id,entity_version,action,to_status,reason,event_data,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,'WORK_ORDER',v_work_order,1,'BREAKDOWN_REPORTED','PLANNED','Maintenance CI breakdown',
    '{}'::jsonb,'ci-maint-wo-event-1',v_hash,v_actor,v_corr
  );

  v_corr := gen_random_uuid();
  INSERT INTO maintenance_work_order_tasks (
    id,tenant_id,factory_id,work_order_id,task_code,description,sequence_no,is_required,status,evidence,
    row_version,idempotency_key,request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_task,v_tenant,v_factory,v_work_order,'CI-ISOLATE','Verify energy isolation',1,true,'PENDING','{}'::jsonb,
    1,'ci-maint-task-create',v_hash,v_actor,v_corr
  );
  INSERT INTO maintenance_events (
    tenant_id,factory_id,entity_type,entity_id,parent_work_order_id,entity_version,action,to_status,reason,
    event_data,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,'WORK_ORDER_TASK',v_task,v_work_order,1,'CREATED','PENDING','Maintenance CI checklist',
    '{}'::jsonb,'ci-maint-task-event-1',v_hash,v_actor,v_corr
  );

  UPDATE maintenance_work_orders SET status='APPROVED',row_version=2,updated_by_user_id=v_actor,
    updated_at=clock_timestamp()
  WHERE id=v_work_order AND tenant_id=v_tenant AND factory_id=v_factory;
  INSERT INTO maintenance_events (
    tenant_id,factory_id,entity_type,entity_id,entity_version,action,from_status,to_status,reason,event_data,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,'WORK_ORDER',v_work_order,2,'APPROVE','PLANNED','APPROVED','Work plan approved',
    '{}'::jsonb,'ci-maint-wo-event-2',v_hash,v_actor,gen_random_uuid()
  );

  UPDATE maintenance_work_orders SET status='IN_PROGRESS',row_version=3,started_by_user_id=v_actor,
    started_at=clock_timestamp(),updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_work_order AND tenant_id=v_tenant AND factory_id=v_factory;
  INSERT INTO maintenance_events (
    tenant_id,factory_id,entity_type,entity_id,entity_version,action,from_status,to_status,reason,event_data,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,'WORK_ORDER',v_work_order,3,'START','APPROVED','IN_PROGRESS','Technician started work',
    '{}'::jsonb,'ci-maint-wo-event-3',v_hash,v_actor,gen_random_uuid()
  );

  BEGIN
    UPDATE maintenance_work_orders SET status='COMPLETED',row_version=4,completed_by_user_id=v_actor,
      completed_at=clock_timestamp(),updated_by_user_id=v_actor,updated_at=clock_timestamp()
    WHERE id=v_work_order AND tenant_id=v_tenant AND factory_id=v_factory;
    RAISE EXCEPTION 'expected required checklist gate to reject work-order completion' USING ERRCODE='P0001';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  UPDATE maintenance_work_order_tasks SET status='COMPLETED',completion_reason='Isolation verified',
    evidence='{"lockout_tagout":"verified"}'::jsonb,completed_by_user_id=v_actor,completed_at=clock_timestamp(),
    row_version=2,updated_at=clock_timestamp()
  WHERE id=v_task AND tenant_id=v_tenant AND factory_id=v_factory;
  INSERT INTO maintenance_events (
    tenant_id,factory_id,entity_type,entity_id,parent_work_order_id,entity_version,action,from_status,to_status,
    reason,event_data,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,'WORK_ORDER_TASK',v_task,v_work_order,2,'COMPLETED','PENDING','COMPLETED',
    'Isolation verified','{"lockout_tagout":"verified"}'::jsonb,'ci-maint-task-event-2',v_hash,v_actor,gen_random_uuid()
  );

  UPDATE maintenance_work_orders SET status='COMPLETED',row_version=4,completed_by_user_id=v_actor,
    completed_at=clock_timestamp(),updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_work_order AND tenant_id=v_tenant AND factory_id=v_factory;
  INSERT INTO maintenance_events (
    tenant_id,factory_id,entity_type,entity_id,entity_version,action,from_status,to_status,reason,event_data,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,'WORK_ORDER',v_work_order,4,'COMPLETE','IN_PROGRESS','COMPLETED','Required checklist completed',
    '{}'::jsonb,'ci-maint-wo-event-4',v_hash,v_actor,gen_random_uuid()
  );
END;
$maintenance_test$;

-- Force deferred audit evidence to be checked before this transaction is rolled back.
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
