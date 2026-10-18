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
  permission_count integer;
  reviewer_id uuid;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'finance_connectors','finance_connector_runs','financial_facts',
    'finance_fact_reconciliations','finance_connector_history'
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

  IF NOT factoryos_finance_json_has_sensitive_key('{"metadata":{"api_key":"never store"}}'::jsonb) THEN
    RAISE EXCEPTION 'Nested secret-like finance configuration keys were not detected';
  END IF;
  IF factoryos_finance_json_has_sensitive_key('{"accounting":{"cost_center":"FIN-01"}}'::jsonb) THEN
    RAISE EXCEPTION 'Ordinary finance metadata was misclassified as a secret';
  END IF;
  SELECT count(*) INTO permission_count FROM permissions WHERE code IN (
    'finance.connectors.read','finance.connectors.write','finance.connectors.approve',
    'finance.facts.read','finance.facts.ingest','finance.reconciliation.read',
    'finance.reconciliation.review','finance.margin.read','finance.working_capital.read'
  );
  IF permission_count<>9 THEN RAISE EXCEPTION 'Finance integration IAM permissions are incomplete'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uq_finance_domain_reporting_source') THEN
    RAISE EXCEPTION 'Single reporting-source constraint is missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='114_finance_integration_contract') THEN
    RAISE EXCEPTION 'Finance integration migration is not registered';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='115_finance_file_import_metadata') THEN
    RAISE EXCEPTION 'Finance file import migration is not registered';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='116_finance_file_import_metadata_integrity') THEN
    RAISE EXCEPTION 'Finance file import integrity migration is not registered';
  END IF;
  SELECT id INTO reviewer_id FROM users WHERE email='manager@factoryos.local';
  IF reviewer_id IS NULL THEN RAISE EXCEPTION 'Independent finance review test user is missing'; END IF;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO finance_connector_history(
      tenant_id,factory_id,connector_id,action,actor_user_id,reason,details
    ) VALUES(
      'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      'da100000-0000-4000-8000-000000000001','CREATED',
      (SELECT id FROM users WHERE email='manager@factoryos.local'),
      'Spoofed finance connector history actor','{}'::jsonb
    );
    RAISE EXCEPTION 'Finance connector history accepted a spoofed actor';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

INSERT INTO finance_connectors(
 id,tenant_id,factory_id,connector_code,display_name,source_system,domain,integration_mode,
 endpoint_url,secret_reference,configuration,status,row_version,idempotency_key,request_hash,created_by_user_id
) VALUES(
 'da100000-0000-4000-8000-000000000001',
 'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
 'CI-FINANCE-AR','CI finance receivables source','External Accounting Sandbox',
 'AR','MANUAL',NULL,NULL,'{}'::jsonb,'PENDING_APPROVAL',1,
 'ci-finance-connector-1',repeat('a',64),'921382b8-e83f-43ab-a576-e3db6a06b70c'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO finance_connectors(
      tenant_id,factory_id,connector_code,display_name,source_system,domain,integration_mode,
      is_reporting_source,configuration,status,row_version,idempotency_key,request_hash,created_by_user_id
    ) VALUES(
      'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      'CI-FINANCE-AR-DUP','Duplicate reporting authority','Other accounting sandbox','AR','MANUAL',
      true,'{}'::jsonb,'PENDING_APPROVAL',1,'ci-finance-connector-duplicate',repeat('1',64),
      '921382b8-e83f-43ab-a576-e3db6a06b70c'
    );
    RAISE EXCEPTION 'Two pending/active reporting authorities were accepted for the same domain';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO finance_connectors(
      tenant_id,factory_id,connector_code,display_name,source_system,domain,integration_mode,
      configuration,status,row_version,idempotency_key,request_hash,created_by_user_id
    ) VALUES(
      'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      'CI-FINANCE-SECRET','Secret config rejection','External Accounting Sandbox','AR','MANUAL',
      '{"nested":{"api_key":"must-not-be-stored"}}'::jsonb,'PENDING_APPROVAL',1,
      'ci-finance-secret-config',repeat('e',64),'921382b8-e83f-43ab-a576-e3db6a06b70c'
    );
    RAISE EXCEPTION 'Secret-like keys were accepted in connector configuration';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE finance_connectors SET status='ACTIVE',row_version=2,
      reviewed_by_user_id=factoryos_current_user_id(),reviewed_at=clock_timestamp(),
      decision_reason='This self approval must fail'
    WHERE id='da100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'Finance connector creator was allowed to self-approve';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

SELECT set_config('app.user_id',(SELECT id::text FROM users WHERE email='manager@factoryos.local'),true);
UPDATE finance_connectors SET status='ACTIVE',row_version=2,
 reviewed_by_user_id=factoryos_current_user_id(),reviewed_at=clock_timestamp(),
 decision_reason='Independent CI finance connector approval'
WHERE id='da100000-0000-4000-8000-000000000001';

SELECT set_config('app.user_id','921382b8-e83f-43ab-a576-e3db6a06b70c',true);
INSERT INTO finance_connector_runs(
 id,tenant_id,factory_id,connector_id,external_batch_ref,idempotency_key,request_hash,status,
 received_count,accepted_count,mismatch_count,source_occurred_at,actor_user_id,source_file_name,source_format,source_payload_sha256
) VALUES(
 'da100000-0000-4000-8000-000000000002',
 'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
 'da100000-0000-4000-8000-000000000001','CI-AR-BATCH-1','ci-finance-run-1',repeat('b',64),
 'COMPLETED_WITH_MISMATCHES',1,1,1,clock_timestamp(),'921382b8-e83f-43ab-a576-e3db6a06b70c',
  'finance-import.csv','CSV',repeat('d',64)
);

DO $$
BEGIN
  BEGIN
    INSERT INTO finance_connector_runs(
      id,tenant_id,factory_id,connector_id,external_batch_ref,idempotency_key,request_hash,status,
      received_count,accepted_count,mismatch_count,actor_user_id,source_format
    ) VALUES(
      'da100000-0000-4000-8000-000000000004',
      'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      'da100000-0000-4000-8000-000000000001','CI-AR-BATCH-BAD-FILE-META','ci-finance-run-bad-meta',repeat('e',64),
      'COMPLETED',1,1,0,'921382b8-e83f-43ab-a576-e3db6a06b70c','CSV'
    );
    RAISE EXCEPTION 'Finance connector run accepted partial file-import metadata';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

INSERT INTO financial_facts(
 id,tenant_id,factory_id,connector_id,connector_run_id,external_fact_id,source_fact_key,
 fact_type,source_record_type,source_record_ref,effective_at,due_at,currency,amount,
 customer_ref,source_quantity,source_rate,source_uom_code,metadata_snapshot,fact_hash,ingested_by_user_id
) VALUES(
 'da100000-0000-4000-8000-000000000003',
 'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
 'da100000-0000-4000-8000-000000000001','da100000-0000-4000-8000-000000000002',
 'CI-AR-EXT-1','AR-INVOICE-100','AR_OPEN','AR_INVOICE','AR-INVOICE-100',
 clock_timestamp(),clock_timestamp()+interval '15 days','BDT',1000,'CI-CUSTOMER',
 10,100,'PCS','{}'::jsonb,repeat('c',64),'921382b8-e83f-43ab-a576-e3db6a06b70c'
);

SELECT set_config('app.user_id',(SELECT id::text FROM users WHERE email='manager@factoryos.local'),true);
DO $$
BEGIN
  BEGIN
    INSERT INTO finance_fact_reconciliations(
      tenant_id,factory_id,fact_id,expected_source_type,expected_source_ref,
      source_quantity,expected_quantity,quantity_tolerance,source_rate,expected_rate,rate_tolerance,
      uom_code,match_status
    ) VALUES(
      'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      'da100000-0000-4000-8000-000000000003','SUPPLIER_INVOICE','SUPPLIER-INVOICE-100',
      10,9.5,0.1,100,100,0,'PCS','MISMATCH'
    );
    RAISE EXCEPTION 'A different actor was allowed to attach reconciliation evidence to another user fact';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
SELECT set_config('app.user_id','921382b8-e83f-43ab-a576-e3db6a06b70c',true);

INSERT INTO finance_fact_reconciliations(
 tenant_id,factory_id,fact_id,expected_source_type,expected_source_ref,
 source_quantity,expected_quantity,quantity_tolerance,source_rate,expected_rate,rate_tolerance,
 uom_code,match_status
) VALUES(
 'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
 'da100000-0000-4000-8000-000000000003','SUPPLIER_INVOICE','SUPPLIER-INVOICE-100',
 10,9.5,0.1,100,100,0,'PCS','MISMATCH'
);

DO $$
BEGIN
  BEGIN
    UPDATE financial_facts SET amount=2000
    WHERE id='da100000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'Governed financial fact update unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    INSERT INTO financial_facts(
      tenant_id,factory_id,connector_id,connector_run_id,external_fact_id,source_fact_key,
      fact_type,source_record_type,source_record_ref,effective_at,currency,amount,
      metadata_snapshot,fact_hash,ingested_by_user_id
    ) VALUES(
      'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      'da100000-0000-4000-8000-000000000001','da100000-0000-4000-8000-000000000002',
      'CI-AR-EXT-1','AR-INVOICE-100','AR_OPEN','AR_INVOICE','AR-INVOICE-100',
      clock_timestamp(),'BDT',1000,'{}'::jsonb,repeat('d',64),
      '921382b8-e83f-43ab-a576-e3db6a06b70c'
    );
    RAISE EXCEPTION 'Duplicate external finance fact unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO financial_facts(
      tenant_id,factory_id,connector_id,connector_run_id,external_fact_id,source_fact_key,
      fact_type,source_record_type,source_record_ref,effective_at,currency,amount,
      metadata_snapshot,fact_hash,ingested_by_user_id
    ) VALUES(
      'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      'da100000-0000-4000-8000-000000000001','da100000-0000-4000-8000-000000000002',
      'CI-AR-BAD-DOMAIN','CI-COST-100','ACTUAL_COST','GENERAL_LEDGER_LINE','COST-100',
      clock_timestamp(),'BDT',50,'{}'::jsonb,repeat('e',64),
      '921382b8-e83f-43ab-a576-e3db6a06b70c'
    );
    RAISE EXCEPTION 'AR connector accepted a cost fact outside its domain';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO financial_facts(
      tenant_id,factory_id,connector_id,connector_run_id,external_fact_id,source_fact_key,
      fact_type,source_record_type,source_record_ref,effective_at,currency,amount,
      metadata_snapshot,fact_hash,ingested_by_user_id
    ) VALUES(
      'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      'da100000-0000-4000-8000-000000000001','da100000-0000-4000-8000-000000000002',
      'CI-AR-SECRET-META','CI-AR-SECRET-META','AR_OPEN','AR_INVOICE','AR-SECRET-META',
      clock_timestamp(),'BDT',100,'{"authorization":"do-not-persist"}'::jsonb,repeat('f',64),
      '921382b8-e83f-43ab-a576-e3db6a06b70c'
    );
    RAISE EXCEPTION 'Secret-like keys were accepted in financial fact metadata';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO finance_fact_reconciliations(
      tenant_id,factory_id,fact_id,expected_source_type,expected_source_ref,
      source_quantity,expected_quantity,quantity_tolerance,source_rate,expected_rate,rate_tolerance,
      uom_code,match_status
    ) VALUES(
      'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      'da100000-0000-4000-8000-000000000003','SUPPLIER_INVOICE','SUPPLIER-INVOICE-100',
      11,9.5,0.1,100,100,0,'PCS','MISMATCH'
    );
    RAISE EXCEPTION 'Reconciliation with fabricated source quantity was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE finance_fact_reconciliations
    SET review_status='RESOLVED',review_reason='Invalid self review',
      reviewed_by_user_id=factoryos_current_user_id(),reviewed_at=clock_timestamp()
    WHERE fact_id='da100000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'Finance fact ingester was allowed to review their mismatch';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO financial_facts(
      tenant_id,factory_id,connector_id,connector_run_id,external_fact_id,source_fact_key,
      fact_type,source_record_type,source_record_ref,effective_at,currency,amount,
      source_quantity,source_rate,source_uom_code,metadata_snapshot,fact_hash,ingested_by_user_id
    ) VALUES(
      'faaab63d-c447-46ce-950d-deebdd7f5f30','24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      'da100000-0000-4000-8000-000000000001','da100000-0000-4000-8000-000000000002',
      'CI-AR-MISSING-RECON','CI-AR-MISSING-RECON','AR_OPEN','AR_INVOICE','AR-INVOICE-MISSING-RECON',
      clock_timestamp(),'BDT',100,1,100,'PCS','{}'::jsonb,repeat('9',64),
      '921382b8-e83f-43ab-a576-e3db6a06b70c'
    );
    SET CONSTRAINTS trg_financial_facts_reconciliation_required IMMEDIATE;
    RAISE EXCEPTION 'Financial fact source quantity/rate was committed without reconciliation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
SET CONSTRAINTS trg_financial_facts_reconciliation_required DEFERRED;

SELECT set_config('app.user_id',(SELECT id::text FROM users WHERE email='manager@factoryos.local'),true);
UPDATE finance_fact_reconciliations
SET review_status='RESOLVED',review_reason='Matched to reviewed supplier invoice',
 reviewed_by_user_id=factoryos_current_user_id(),reviewed_at=clock_timestamp()
WHERE fact_id='da100000-0000-4000-8000-000000000003'
  AND review_status='OPEN' AND match_status='MISMATCH';

DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM finance_fact_reconciliations
    WHERE fact_id='da100000-0000-4000-8000-000000000003'
      AND review_status='RESOLVED' AND match_status='MISMATCH'
  ) THEN RAISE EXCEPTION 'Reviewed finance mismatch evidence was not retained'; END IF;
END $$;

-- Verify row filtering with a non-superuser application role, not only RLS catalog flags.
SET LOCAL ROLE factoryos_app;
SELECT set_config('app.tenant_id','00000000-0000-4000-8000-000000000099',true);
DO $$
DECLARE
  table_name text;
  visible_rows bigint;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'finance_connectors','finance_connector_runs','financial_facts',
    'finance_fact_reconciliations','finance_connector_history'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM %I',table_name) INTO visible_rows;
    IF visible_rows<>0 THEN
      RAISE EXCEPTION 'Cross-tenant finance rows are visible through %',table_name;
    END IF;
  END LOOP;
END $$;

DO $
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='123_finance_file_exchange_validation_reports') THEN
    RAISE EXCEPTION 'finance file exchange migration is not registered';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.finance_connectors'::regclass AND conname='chk_finance_connector_mode' AND pg_get_constraintdef(oid) LIKE '%SFTP_IMPORT%' AND pg_get_constraintdef(oid) LIKE '%SFTP_EXPORT%' AND pg_get_constraintdef(oid) LIKE '%FILE_EXPORT%') THEN
    RAISE EXCEPTION 'finance connector file/SFTP modes are not constrained';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.finance_connectors'::regclass AND conname='chk_finance_sftp_configuration') THEN
    RAISE EXCEPTION 'pinned SFTP connector configuration guard is missing';
  END IF;
END $;

DO $
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='124_finance_file_import_validation_reports') THEN
    RAISE EXCEPTION 'finance file import validation-report migration is not registered';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.finance_file_import_validation_reports'::regclass AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'finance file validation reports must force tenant RLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.finance_file_import_validation_reports'::regclass AND tgname='trg_finance_file_validation_report_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'finance file validation reports must be immutable';
  END IF;
END $;

DO $
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='126_finance_file_export_receipts') THEN
    RAISE EXCEPTION 'finance file export receipt migration is not registered';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.finance_file_export_receipts'::regclass AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'finance file export receipts must force tenant RLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.finance_file_export_receipts'::regclass AND tgname='trg_finance_export_receipt_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'finance file export receipts must be immutable';
  END IF;
END $;

DO $ BEGIN IF NOT EXISTS(SELECT 1 FROM permissions WHERE code='finance.facts.export') THEN RAISE EXCEPTION 'finance.facts.export permission is missing'; END IF; END $;
ROLLBACK;
