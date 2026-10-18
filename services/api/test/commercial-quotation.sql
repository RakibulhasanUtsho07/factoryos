\set ON_ERROR_STOP on
BEGIN;

SELECT set_config('app.tenant_id', 'faaab63d-c447-46ce-950d-deebdd7f5f30', true);
SELECT set_config('app.user_id', '921382b8-e83f-43ab-a576-e3db6a06b70c', true);

DO $$
DECLARE
  table_name text;
  row_security_enabled boolean;
  row_security_forced boolean;
  policy_count integer;
  pricing_rule_id uuid;
  quotation_id uuid := 'a4be1a9e-8f6c-4c11-8c12-7ff8d2d80a31';
  quote_line_id uuid := 'b2c1b7a0-2c23-4c7d-bfc0-8ba8e1d82a22';
  exchange_rate_id uuid := 'c3d2c8b1-3d34-4d8e-8d20-9cb9f3c40b33';
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'commercial_pricing_rules','commercial_exchange_rates','sales_quotations',
    'quotation_versions','quotation_lines','quotation_history'
  ] LOOP
    SELECT c.relrowsecurity,c.relforcerowsecurity
      INTO row_security_enabled,row_security_forced
      FROM pg_class c WHERE c.oid=to_regclass('public.'||table_name);
    IF row_security_enabled IS DISTINCT FROM true OR row_security_forced IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'RLS must be enabled and forced for %',table_name;
    END IF;
    SELECT count(*) INTO policy_count FROM pg_policies
      WHERE schemaname='public' AND tablename=table_name AND policyname=table_name||'_tenant_isolation';
    IF policy_count <> 1 THEN RAISE EXCEPTION 'Tenant isolation policy missing for %',table_name; END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE code IN (
      'quotations.read','quotations.write','quotations.approve','quotations.send',
      'quotations.accept','quotations.convert','quotation_rules.read','quotation_rules.write',
      'exchange_rates.read','exchange_rates.write'
    ) GROUP BY 1 HAVING count(*) = 10
  ) THEN
    RAISE EXCEPTION 'Commercial permissions are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='112_commercial_quotation_lifecycle') THEN
    RAISE EXCEPTION 'Commercial migration version was not registered';
  END IF;
END;
$$;

INSERT INTO commercial_pricing_rules (
  tenant_id,factory_id,rule_code,customer_reference,version,base_currency,allowed_currencies,
  default_tax_percent,max_discount_percent,approval_required,approval_total_threshold,
  approval_discount_threshold_percent,incoterms_required,payment_terms_required,created_by_user_id
) VALUES (
  'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  'CI-COMMERCIAL-BASE',NULL,1,'BDT',ARRAY['BDT','USD']::varchar(3)[],
  7.50,10.00,true,100000.0000,5.00,false,false,'921382b8-e83f-43ab-a576-e3db6a06b70c'
);
SELECT id AS test_pricing_rule_id FROM commercial_pricing_rules
WHERE tenant_id='faaab63d-c447-46ce-950d-deebdd7f5f30'
  AND factory_id='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7'
  AND rule_code='CI-COMMERCIAL-BASE' AND version=1 \gset

INSERT INTO commercial_exchange_rates (
  id,tenant_id,factory_id,base_currency,quote_currency,rate_to_base,effective_on,source,created_by_user_id
) VALUES (
  'c3d2c8b1-3d34-4d8e-8d20-9cb9f3c40b33',
  'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  'USD','BDT',120.0000000000,CURRENT_DATE,'CI-fixture','921382b8-e83f-43ab-a576-e3db6a06b70c'
);

INSERT INTO sales_quotations (
  id,tenant_id,factory_id,quote_number,customer_name,customer_reference,
  status,current_revision,version,created_by_user_id,updated_by_user_id,last_change_reason
) VALUES (
  'a4be1a9e-8f6c-4c11-8c12-7ff8d2d80a31',
  'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  'CI-COMMERCIAL-Q-1','Commercial Contract Customer','CI-CUSTOMER',
  'DRAFT',1,1,'921382b8-e83f-43ab-a576-e3db6a06b70c',
  '921382b8-e83f-43ab-a576-e3db6a06b70c','CI quotation fixture created'
);

INSERT INTO quotation_versions (
  tenant_id,factory_id,quotation_id,revision_number,currency,base_currency,exchange_rate_to_base,
  exchange_rate_as_of,exchange_rate_source,requested_delivery_date,valid_until,incoterms,payment_terms,notes,
  subtotal,discount_total,tax_total,total,total_base,default_tax_percent,max_discount_percent,approval_required,
  approval_total_threshold,approval_discount_threshold_percent,pricing_rule_id,pricing_rule_version,
  pricing_rule_code,pricing_rule_snapshot,created_by_user_id
) VALUES (
  'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  'a4be1a9e-8f6c-4c11-8c12-7ff8d2d80a31',1,'BDT','BDT',1.0000000000,CURRENT_DATE,'IDENTITY',
  CURRENT_DATE+7,CURRENT_DATE+14,'EXW','Net 30','CI commercial quote fixture',
  100.0000,0.0000,7.5000,107.5000,107.5000,7.50,10.00,true,100000.0000,5.00,
  :'test_pricing_rule_id',1,'CI-COMMERCIAL-BASE',
  '{"rule_code":"CI-COMMERCIAL-BASE","rule_version":1,"allowed_currencies":["BDT","USD"],"approval_required_by_rule":true,"incoterms_required":false,"payment_terms_required":false}',
  '921382b8-e83f-43ab-a576-e3db6a06b70c'
);
SELECT id AS test_quotation_version_id FROM quotation_versions
WHERE quotation_id='a4be1a9e-8f6c-4c11-8c12-7ff8d2d80a31' AND revision_number=1 \gset

INSERT INTO quotation_lines (
  id,tenant_id,factory_id,quotation_id,quotation_version_id,line_number,product_code,product_name,
  quantity,unit,unit_price,discount_percent,tax_percent,line_subtotal,line_discount,line_tax,line_total,notes
) VALUES (
  'b2c1b7a0-2c23-4c7d-bfc0-8ba8e1d82a22',
  'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  'a4be1a9e-8f6c-4c11-8c12-7ff8d2d80a31',:'test_quotation_version_id',1,
  'CI-SKU','CI Commercial Product',2.0000,'PCS',50.0000,0.00,7.50,100.0000,0.0000,7.5000,107.5000,NULL
);

INSERT INTO quotation_history (
  tenant_id,factory_id,quotation_id,revision_number,from_status,to_status,action,actor_user_id,reason,details
) VALUES (
  'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  'a4be1a9e-8f6c-4c11-8c12-7ff8d2d80a31',1,NULL,'DRAFT','CREATED',
  '921382b8-e83f-43ab-a576-e3db6a06b70c','CI commercial contract fixture','{}'
);

DO $$
BEGIN
  BEGIN
    UPDATE commercial_exchange_rates SET rate_to_base=121
     WHERE id='c3d2c8b1-3d34-4d8e-8d20-9cb9f3c40b33';
    RAISE EXCEPTION 'Exchange-rate append-only guard did not fire';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE commercial_pricing_rules SET max_discount_percent=9
     WHERE rule_code='CI-COMMERCIAL-BASE' AND version=1
       AND tenant_id='faaab63d-c447-46ce-950d-deebdd7f5f30';
    RAISE EXCEPTION 'Commercial rule immutability guard did not fire';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE quotation_lines SET unit_price=51
     WHERE id='b2c1b7a0-2c23-4c7d-bfc0-8ba8e1d82a22';
    RAISE EXCEPTION 'Quotation line snapshot guard did not fire';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE sales_quotations SET status='SENT',version=version+1,updated_by_user_id=factoryos_current_user_id(),
      last_change_reason='CI invalid direct transition'
     WHERE id='a4be1a9e-8f6c-4c11-8c12-7ff8d2d80a31';
    RAISE EXCEPTION 'Quotation lifecycle transition guard did not fire';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;

  BEGIN
    INSERT INTO quotation_history (
      tenant_id,factory_id,quotation_id,revision_number,from_status,to_status,action,actor_user_id,reason,details
    ) VALUES (
      'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      'a4be1a9e-8f6c-4c11-8c12-7ff8d2d80a31',1,'DRAFT','APPROVED','APPROVED',
      '921382b8-e83f-43ab-a576-e3db6a06b70c','CI should block self approval','{}'
    );
    RAISE EXCEPTION 'Quotation self-approval guard did not fire';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END;
$$;

ROLLBACK;
