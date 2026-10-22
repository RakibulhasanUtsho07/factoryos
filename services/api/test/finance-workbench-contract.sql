\set ON_ERROR_STOP on
BEGIN;

SELECT set_config('app.tenant_id','faaab63d-c447-46ce-950d-deebdd7f5f30',true);
SELECT set_config('app.user_id','921382b8-e83f-43ab-a576-e3db6a06b70c',true);

DO $$
DECLARE
  t text;
  enabled boolean;
  forced boolean;
  policy_count integer;
  trigger_count integer;
  permission_count integer;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_close_periods','finance_close_period_history'] LOOP
    SELECT relrowsecurity,relforcerowsecurity INTO enabled,forced
      FROM pg_class WHERE oid=to_regclass('public.'||t);
    IF enabled IS DISTINCT FROM true OR forced IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Finance-close table % must force tenant RLS',t;
    END IF;
    SELECT count(*) INTO policy_count FROM pg_policies
      WHERE schemaname='public' AND tablename=t AND policyname=t||'_tenant_isolation';
    IF policy_count<>1 THEN RAISE EXCEPTION 'Finance-close tenant policy missing on %',t; END IF;
  END LOOP;

  SELECT count(*) INTO trigger_count FROM pg_trigger
    WHERE NOT tgisinternal AND tgname IN (
      'trg_finance_close_period_guard','trg_finance_close_period_history_guard'
    );
  IF trigger_count<>2 THEN RAISE EXCEPTION 'Finance-close lifecycle/history guards are incomplete'; END IF;

  SELECT count(*) INTO permission_count FROM permissions WHERE code IN (
    'finance.workbench.read','finance.close.read','finance.close.write',
    'finance.close.submit','finance.close.approve'
  );
  IF permission_count<>5 THEN RAISE EXCEPTION 'Finance workbench/close permissions are incomplete'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM users u
    JOIN tenant_memberships tm ON tm.user_id=u.id AND tm.tenant_id='faaab63d-c447-46ce-950d-deebdd7f5f30' AND tm.status='ACTIVE'
    JOIN user_roles ur ON ur.membership_id=tm.id AND ur.factory_id='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7'
    JOIN roles r ON r.id=ur.role_id
    JOIN role_permissions rp ON rp.role_id=r.id
    JOIN permissions p ON p.id=rp.permission_id AND p.code='finance.workbench.read'
    WHERE u.email='manager@factoryos.local' AND r.code='FACTORY_MANAGER'
  ) THEN RAISE EXCEPTION 'Development factory manager is missing finance workbench read permission'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM roles r
    JOIN role_permissions rp ON rp.role_id=r.id
    JOIN permissions p ON p.id=rp.permission_id AND p.code='finance.close.approve'
    WHERE r.code='ORG_ADMIN'
  ) THEN RAISE EXCEPTION 'Development org admin is missing finance close approval permission'; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='170_finance_costing_profitability_close_workbench') THEN
    RAISE EXCEPTION 'Finance workbench close migration is not registered';
  END IF;
END $$;

INSERT INTO finance_close_periods(
  id,tenant_id,factory_id,currency,period_start,period_end,status,row_version,
  idempotency_key,request_hash,snapshot,snapshot_hash,created_by_user_id
) VALUES(
  'da200000-0000-4000-8000-000000000001',
  'faaab63d-c447-46ce-950d-deebdd7f5f30',
  '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  'BDT','2026-09-01','2026-09-30','DRAFT',1,
  'ci-finance-close-202609-bdt',repeat('a',64),
  '{"schema":"factoryos.finance-close-snapshot/v1","readiness":{"can_submit":true}}'::jsonb,
  repeat('b',64),'921382b8-e83f-43ab-a576-e3db6a06b70c'
);

INSERT INTO finance_close_period_history(
  tenant_id,factory_id,close_period_id,event_version,action,actor_user_id,reason,snapshot_hash,idempotency_key,request_hash,details
) VALUES(
  'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  'da200000-0000-4000-8000-000000000001',1,'CREATED',
  '921382b8-e83f-43ab-a576-e3db6a06b70c','Create finance close contract fixture',
  repeat('b',64),'close-created-history',repeat('1',64),'{"contract_test":true}'::jsonb
);

-- Valid submission is versioned; an attempted self-approval must fail at the
-- database boundary even if an API/controller guard were bypassed.
UPDATE finance_close_periods
SET status='SUBMITTED',row_version=2,
    submitted_by_user_id=factoryos_current_user_id(),submitted_at=clock_timestamp()
WHERE id='da200000-0000-4000-8000-000000000001';

INSERT INTO finance_close_period_history(
  tenant_id,factory_id,close_period_id,event_version,action,actor_user_id,reason,snapshot_hash,idempotency_key,request_hash,details
) VALUES(
  'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  'da200000-0000-4000-8000-000000000001',2,'SUBMITTED',
  '921382b8-e83f-43ab-a576-e3db6a06b70c','Submit finance close contract fixture',
  repeat('b',64),'close-submitted-history',repeat('2',64),'{"contract_test":true}'::jsonb
);

DO $$
BEGIN
  BEGIN
    UPDATE finance_close_periods
    SET status='APPROVED',row_version=3,
        approved_by_user_id=factoryos_current_user_id(),approved_at=clock_timestamp(),
        approval_reason='Attempt to approve my own close'
    WHERE id='da200000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'Finance-close submitter was able to approve their own close';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

SELECT set_config('app.user_id',(SELECT id::text FROM users WHERE email='manager@factoryos.local'),true);

-- Even a properly separated reviewer cannot change the snapshot as part of
-- approval: the submitted hash is the evidence being approved.
DO $finance_close_snapshot_guard$
BEGIN
  BEGIN
    UPDATE finance_close_periods
    SET status='APPROVED',row_version=3,
        approved_by_user_id=factoryos_current_user_id(),approved_at=clock_timestamp(),
        approval_reason='Independent finance close review approved',
        snapshot='{"tampered_during_approval":true}'::jsonb,
        snapshot_hash=repeat('c',64)
    WHERE id='da200000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'Finance-close snapshot was changed during approval';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END $finance_close_snapshot_guard$;

UPDATE finance_close_periods
SET status='APPROVED',row_version=3,
    approved_by_user_id=factoryos_current_user_id(),approved_at=clock_timestamp(),
    approval_reason='Independent finance close review approved'
WHERE id='da200000-0000-4000-8000-000000000001';

INSERT INTO finance_close_period_history(
  tenant_id,factory_id,close_period_id,event_version,action,actor_user_id,reason,snapshot_hash,idempotency_key,request_hash,details
) VALUES(
  'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  'da200000-0000-4000-8000-000000000001',3,'APPROVED',
  (SELECT id FROM users WHERE email='manager@factoryos.local'),
  'Independent finance close review approved',repeat('b',64),'close-approved-history',repeat('3',64),'{"contract_test":true}'::jsonb
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM finance_close_periods
    WHERE id='da200000-0000-4000-8000-000000000001'
      AND status='APPROVED' AND row_version=3
      AND approved_by_user_id<>submitted_by_user_id
  ) THEN RAISE EXCEPTION 'Independent finance-close approval was not retained'; END IF;
  IF (SELECT count(*) FROM finance_close_period_history
      WHERE close_period_id='da200000-0000-4000-8000-000000000001')<>3 THEN
    RAISE EXCEPTION 'Finance-close transition history is incomplete';
  END IF;

  BEGIN
    DELETE FROM finance_close_period_history
    WHERE close_period_id='da200000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'Finance-close history allowed deletion';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  BEGIN
    UPDATE finance_close_periods SET snapshot='{"mutated":true}'::jsonb,row_version=4
    WHERE id='da200000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'Approved finance-close snapshot was mutable';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END $$;

-- Verify isolation through the unprivileged runtime role, not only catalog flags.
SET LOCAL ROLE factoryos_app;
SELECT set_config('app.tenant_id','00000000-0000-4000-8000-000000000099',true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM finance_close_periods;
  IF n<>0 THEN RAISE EXCEPTION 'Cross-tenant finance-close periods are visible to app role'; END IF;
  SELECT count(*) INTO n FROM finance_close_period_history;
  IF n<>0 THEN RAISE EXCEPTION 'Cross-tenant finance-close history is visible to app role'; END IF;
END $$;

ROLLBACK;
