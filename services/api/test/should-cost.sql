\set ON_ERROR_STOP on
BEGIN;

SELECT set_config('app.tenant_id','faaab63d-c447-46ce-950d-deebdd7f5f30',true);
SELECT set_config('app.user_id','921382b8-e83f-43ab-a576-e3db6a06b70c',true);

DO $$
DECLARE
  table_name text;
  rls_enabled boolean;
  rls_forced boolean;
  policies integer;
  permissions_found integer;
  profile_id uuid := 'd7f8f399-17a4-4a2e-b0c0-6c2192ca7001';
  bad_profile_id uuid := 'd7f8f399-17a4-4a2e-b0c0-6c2192ca7002';
  quotation_id uuid := 'd7f8f399-17a4-4a2e-b0c0-6c2192ca7003';
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'should_cost_profiles','should_cost_profile_components','should_cost_assessments',
    'should_cost_component_evidence','should_cost_history'
  ] LOOP
    SELECT c.relrowsecurity,c.relforcerowsecurity INTO rls_enabled,rls_forced
    FROM pg_class c WHERE c.oid=to_regclass('public.'||table_name);
    IF rls_enabled IS DISTINCT FROM true OR rls_forced IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Forced tenant RLS is required on %',table_name;
    END IF;
    SELECT count(*) INTO policies FROM pg_policies
    WHERE schemaname='public' AND tablename=table_name AND policyname=table_name||'_tenant_isolation';
    IF policies<>1 THEN RAISE EXCEPTION 'Tenant isolation policy missing for %',table_name; END IF;
  END LOOP;

  SELECT count(*) INTO permissions_found FROM permissions WHERE code IN (
    'should_cost.profiles.read','should_cost.profiles.write','should_cost.profiles.submit',
    'should_cost.profiles.approve','should_cost.assessments.read','should_cost.assessments.calculate'
  );
  IF permissions_found<>6 THEN RAISE EXCEPTION 'Should-cost IAM permissions are incomplete'; END IF;
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='113_deterministic_should_cost_engine') THEN
    RAISE EXCEPTION 'Should-cost migration is not registered';
  END IF;
END;
$$;

INSERT INTO should_cost_profiles(
  id,tenant_id,factory_id,product_id,profile_code,version,currency,output_unit,status,is_current,row_version,
  idempotency_key,request_hash,created_by_user_id,updated_by_user_id
) VALUES (
  'd7f8f399-17a4-4a2e-b0c0-6c2192ca7001',
  'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  NULL,'CI-SHOULD-COST',1,'BDT','PCS','DRAFT',false,1,'ci-should-cost-profile',repeat('a',64),
  '921382b8-e83f-43ab-a576-e3db6a06b70c','921382b8-e83f-43ab-a576-e3db6a06b70c'
);

INSERT INTO should_cost_profiles(
  id,tenant_id,factory_id,product_id,profile_code,version,currency,output_unit,status,is_current,row_version,
  idempotency_key,request_hash,created_by_user_id,updated_by_user_id
) VALUES (
  'd7f8f399-17a4-4a2e-b0c0-6c2192ca7002',
  'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  NULL,'CI-SHOULD-COST-BAD',1,'BDT','PCS','DRAFT',false,1,'ci-should-cost-profile-bad',repeat('b',64),
  '921382b8-e83f-43ab-a576-e3db6a06b70c','921382b8-e83f-43ab-a576-e3db6a06b70c'
);

INSERT INTO should_cost_profile_components(
  tenant_id,factory_id,profile_id,category,calculation_method,is_required,base_categories,guidance,created_by_user_id
) VALUES
 ('faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7','d7f8f399-17a4-4a2e-b0c0-6c2192ca7001','MATERIAL','DIRECT_RATE',true,ARRAY[]::varchar(20[]),'Quantity and supplier rate evidence','921382b8-e83f-43ab-a576-e3db6a06b70c'),
 ('faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7','d7f8f399-17a4-4a2e-b0c0-6c2192ca7001','LABOUR','DIRECT_RATE',true,ARRAY[]::varchar(20[]),'Routing time and labour rate evidence','921382b8-e83f-43ab-a576-e3db6a06b70c'),
 ('faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7','d7f8f399-17a4-4a2e-b0c0-6c2192ca7001','ENERGY','DIRECT_RATE',true,ARRAY[]::varchar(20[]),'Meter consumption and energy rate evidence','921382b8-e83f-43ab-a576-e3db6a06b70c'),
 ('faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7','d7f8f399-17a4-4a2e-b0c0-6c2192ca7001','FREIGHT','FIXED_PER_BATCH',true,ARRAY[]::varchar(20[]),'Shipment quote and batch allocation','921382b8-e83f-43ab-a576-e3db6a06b70c'),
 ('faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7','d7f8f399-17a4-4a2e-b0c0-6c2192ca7001','DUTY','PERCENT_OF_BASE',true,ARRAY['MATERIAL','FREIGHT']::varchar(20[]),'Effective duty schedule','921382b8-e83f-43ab-a576-e3db6a06b70c'),
 ('faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7','d7f8f399-17a4-4a2e-b0c0-6c2192ca7001','OVERHEAD','PERCENT_OF_BASE',true,ARRAY['LABOUR','ENERGY']::varchar(20[]),'Approved overhead rate card','921382b8-e83f-43ab-a576-e3db6a06b70c'),
 ('faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7','d7f8f399-17a4-4a2e-b0c0-6c2192ca7001','SCRAP','SCRAP_GROSS_UP',true,ARRAY['MATERIAL','LABOUR','ENERGY']::varchar(20[]),'Approved process scrap allowance','921382b8-e83f-43ab-a576-e3db6a06b70c');

DO $$
BEGIN
  BEGIN
    INSERT INTO should_cost_profile_components(
      tenant_id,factory_id,profile_id,category,calculation_method,is_required,base_categories,guidance,created_by_user_id
    ) VALUES (
      'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      'd7f8f399-17a4-4a2e-b0c0-6c2192ca7002','MATERIAL','PERCENT_OF_BASE',true,
      ARRAY['SCRAP']::varchar(20[]),'invalid forward dependency','921382b8-e83f-43ab-a576-e3db6a06b70c'
    );
    RAISE EXCEPTION 'Unsupported/cyclic profile formula was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE should_cost_profile_components SET guidance='tampered'
    WHERE profile_id='d7f8f399-17a4-4a2e-b0c0-6c2192ca7001' AND category='MATERIAL';
    RAISE EXCEPTION 'Immutable should-cost formula was editable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END;
$$;

UPDATE should_cost_profiles
SET status='PENDING_APPROVAL',row_version=2,updated_by_user_id=factoryos_current_user_id(),
    submitted_by_user_id=factoryos_current_user_id(),submitted_at=clock_timestamp(),
    decision_reason='CI profile submission'
WHERE id='d7f8f399-17a4-4a2e-b0c0-6c2192ca7001'
  AND tenant_id='faaab63d-c447-46ce-950d-deebdd7f5f30'
  AND factory_id='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7'
  AND row_version=1;

DO $$
BEGIN
  BEGIN
    UPDATE should_cost_profiles
    SET status='APPROVED',is_current=true,row_version=3,
        updated_by_user_id=factoryos_current_user_id(),approved_by_user_id=factoryos_current_user_id(),
        approved_at=clock_timestamp(),decision_reason='invalid self approval'
    WHERE id='d7f8f399-17a4-4a2e-b0c0-6c2192ca7001';
    RAISE EXCEPTION 'Should-cost profile self-approval was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

INSERT INTO sales_quotations(
  id,tenant_id,factory_id,quote_number,customer_name,status,current_revision,version,
  created_by_user_id,updated_by_user_id,last_change_reason
) VALUES (
  'd7f8f399-17a4-4a2e-b0c0-6c2192ca7003',
  'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  'CI-SHOULD-COST-GATE','Should-cost approval gate fixture','DRAFT',1,1,
  '921382b8-e83f-43ab-a576-e3db6a06b70c','921382b8-e83f-43ab-a576-e3db6a06b70c',
  'CI quotation gate fixture created'
);

INSERT INTO quotation_versions(
  tenant_id,factory_id,quotation_id,revision_number,currency,base_currency,exchange_rate_to_base,
  exchange_rate_as_of,exchange_rate_source,subtotal,discount_total,tax_total,total,total_base,
  default_tax_percent,max_discount_percent,approval_required,approval_discount_threshold_percent,
  pricing_rule_code,pricing_rule_snapshot,created_by_user_id
) VALUES(
  'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  'd7f8f399-17a4-4a2e-b0c0-6c2192ca7003',1,'BDT','BDT',1,CURRENT_DATE,'IDENTITY',
  100,0,0,100,100,0,0,true,0,'CI-SHOULD-COST-GATE',
  '{"rule_code":"CI-SHOULD-COST-GATE","rule_version":null,"allowed_currencies":["BDT"]}',
  '921382b8-e83f-43ab-a576-e3db6a06b70c'
);

DO $$
BEGIN
  BEGIN
    UPDATE sales_quotations SET status='APPROVED',version=version+1,
      updated_by_user_id=factoryos_current_user_id(),last_change_reason='CI must-cost gate check'
    WHERE id='d7f8f399-17a4-4a2e-b0c0-6c2192ca7003';
    RAISE EXCEPTION 'Quotation was approved without current-revision should-cost evidence';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

ROLLBACK;
