-- End-to-end governance contract: an SQL-only deletion receipt is never
-- accepted as whole-tenant erasure. External stores require independently
-- reviewed per-store receipts with exact plan digest and zero residual copies.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'saas_tenant_external_data_targets',
    'saas_tenant_external_propagation_runs',
    'saas_tenant_external_propagation_receipts',
    'saas_tenant_external_propagation_manifests',
    'saas_tenant_external_propagation_manifest_items',
    'saas_tenant_external_propagation_resource_events',
    'saas_tenant_finance_retention_policies',
    'saas_tenant_finance_retention_runs',
    'saas_tenant_backup_writer_operations',
    'saas_tenant_backup_writer_fences',
    'saas_tenant_external_copy_coverage_decisions',
    'saas_tenant_backup_copy_class_coverage_decisions'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c WHERE c.oid=format('public.%I',t)::regclass
        AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN RAISE EXCEPTION 'ENABLE/FORCE RLS is required for %',t; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid=format('public.%I',t)::regclass
        AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
        AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
    ) THEN RAISE EXCEPTION 'tenant-bound USING/WITH CHECK policy missing for %',t; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM factoryos_governance.tenant_relation_ownership_reviews r
      WHERE r.schema_name='public' AND r.relation_name=t
        AND r.ownership_class='DIRECT_TENANT' AND r.review_status='VERIFIED'
    ) THEN RAISE EXCEPTION 'ownership review ledger lacks direct-tenant scope for %',t; END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.saas_tenant_backup_copy_class_coverage_decisions'::regclass
      AND c.conname='chk_saas_backup_copy_class_references'
      AND pg_get_constraintdef(c.oid) ILIKE '%evidence_reference%'
      AND pg_get_constraintdef(c.oid) ILIKE '%A-Za-z0-9._-%'
  ) THEN RAISE EXCEPTION 'backup evidence references must be constrained to opaque single-component artifact IDs'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='saas_tenant_data_legal_hold_external_propagation_fence'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'active legal holds must fence overlapping RUNNING external erasure';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_backup_copy_class_coverage_run_fence' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'backup copy-class inventory must be frozen during RUNNING propagation'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_external_copy_coverage_run_fence' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'external copy-class decisions must be frozen during RUNNING propagation'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_external_data_targets_run_fence' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'required target inventory must be frozen during RUNNING propagation'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='saas_tenant_external_propagation_active_legal_hold_fence'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'external propagation start/retry must be blocked by overlapping active legal holds';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.saas_tenant_data_erasure_runs'::regclass
      AND c.conname='chk_saas_erasure_run_receipt_scope'
      AND pg_get_constraintdef(c.oid) ILIKE '%POSTGRESQL_ONLY%'
  ) THEN RAISE EXCEPTION 'PostgreSQL erasure receipts must declare POSTGRESQL_ONLY scope'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='factoryos_guard_saas_tenant_data_erasure_request'
      AND p.prosrc ILIKE '%PROPAGATION_PENDING%'
      AND p.prosrc ILIKE '%POSTGRESQL_ONLY%'
      AND p.prosrc ILIKE '%zero-residual external propagation receipt%'
  ) THEN RAISE EXCEPTION 'tenant erasure lifecycle must require a matching zero-residual external propagation receipt'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_external_propagation_receipt_immutable' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'external propagation receipts must be immutable'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_external_propagation_manifest_guard' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'resource manifest must have a seal/immutability guard'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_external_propagation_manifest_item_guard' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'manifest items must only be appended to staging manifests'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_external_propagation_resource_event_guard' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'per-resource intent/deletion/verification events must be append-only and sequential'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.saas_tenant_external_propagation_manifests'::regclass
      AND conname='chk_saas_external_manifest_state'
      AND pg_get_constraintdef(oid) ILIKE '%STAGING%'
      AND pg_get_constraintdef(oid) ILIKE '%SEALED%'
      AND pg_get_constraintdef(oid) ILIKE '%ABORTED%'
  ) THEN RAISE EXCEPTION 'resource manifest must have explicit staging/sealed/aborted states'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.saas_tenant_external_propagation_manifests'::regclass
      AND conname='chk_saas_external_manifest_limits'
  ) THEN RAISE EXCEPTION 'resource manifest execution limits must be bounded'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.saas_tenant_external_propagation_manifest_items'::regclass
      AND conname='uq_saas_external_manifest_item_identity'
  ) THEN RAISE EXCEPTION 'resource manifest must reject duplicate identities'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.saas_tenant_external_propagation_manifest_items'::regclass
      AND conname='chk_saas_external_manifest_item_content_digest'
      AND pg_get_constraintdef(oid) ILIKE '%resource_content_digest%'
      AND pg_get_constraintdef(oid) ILIKE '%64%'
  ) THEN RAISE EXCEPTION 'resource manifest content digests must be optional SHA-256 values when available'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.saas_tenant_external_propagation_resource_events'::regclass
      AND conname='chk_saas_external_resource_event_result'
      AND pg_get_constraintdef(oid) ILIKE '%VERIFIED%'
      AND pg_get_constraintdef(oid) ILIKE '%verified_manifest_digest%'
      AND pg_get_constraintdef(oid) ILIKE '%residual_count%'
  ) THEN RAISE EXCEPTION 'verified resource events must bind the manifest digest and zero residual count'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='factoryos_guard_saas_external_propagation_resource_event'
      AND p.prosrc ILIKE '%DELETE_REQUESTED%'
      AND p.prosrc ILIKE '%FAILED_RETRYABLE%'
      AND p.prosrc ILIKE '%terminal resource outcomes%'
  ) THEN RAISE EXCEPTION 'per-resource event log must enforce sequential recovery transitions'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_external_propagation_run_guard' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'external propagation run state/recovery guard is missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_external_data_target_guard' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'external target independent-review guard is missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_finance_retention_policy_guard' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'finance retention policy approval guard is missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_finance_retention_run_immutable' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'finance retention run receipt must be append-only'; END IF;

  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid='public.saas_tenant_external_data_targets'::regclass
        AND conname='chk_saas_external_target_kind')
     NOT ILIKE '%OBJECT_STORAGE%' THEN
    RAISE EXCEPTION 'object storage targets are missing from the reviewed adapter registry'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.saas_tenant_external_data_targets'::regclass
      AND conname='chk_saas_external_target_kind'
      AND pg_get_constraintdef(oid) ILIKE '%CACHE%'
      AND pg_get_constraintdef(oid) ILIKE '%SEARCH_INDEX%'
      AND pg_get_constraintdef(oid) ILIKE '%VECTOR_STORE%'
      AND pg_get_constraintdef(oid) ILIKE '%LEARNING_ARTIFACT%'
      AND pg_get_constraintdef(oid) ILIKE '%EXTERNAL_PROVIDER%'
      AND pg_get_constraintdef(oid) ILIKE '%REPLICA%'
      AND pg_get_constraintdef(oid) ILIKE '%BACKUP%'
  ) THEN RAISE EXCEPTION 'external target registry does not cover all required storage classes'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.saas_tenant_finance_retention_runs'::regclass
      AND conname='chk_saas_finance_retention_run_actors'
  ) THEN RAISE EXCEPTION 'finance retention requires independent approval and execution actors'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.saas_tenant_finance_retention_runs'::regclass
      AND conname='chk_saas_finance_retention_run_result'
      AND pg_get_constraintdef(oid) ILIKE '%adapter_receipt_reference%'
      AND pg_get_constraintdef(oid) ILIKE '%residual_rows%'
  ) THEN RAISE EXCEPTION 'finance retention receipts must record adapter evidence and residual counts'; END IF;
END
$$;

-- Adversarial two-tenant tests against new target/finance governance rows.
BEGIN;
INSERT INTO tenants (id,slug,name,status,timezone,default_locale) VALUES
 ('16000000-0000-4000-8000-000000000001','propagation-a-160','Propagation Tenant A','ACTIVE','Asia/Dhaka','en-BD'),
 ('16000000-0000-4000-8000-000000000002','propagation-b-160','Propagation Tenant B','ACTIVE','Asia/Dhaka','en-BD');
INSERT INTO users (id,external_subject,email,display_name,status) VALUES
 ('16010000-0000-4000-8000-000000000001','propagation-user-a-160','propagation-a-160@factoryos.test','Propagation User A','ACTIVE'),
 ('16010000-0000-4000-8000-000000000002','propagation-user-b-160','propagation-b-160@factoryos.test','Propagation User B','ACTIVE');

INSERT INTO saas_tenant_external_copy_coverage_decisions
 (decision_id,tenant_id,category_code,store_kind,revision,disposition,evidence_reference,evidence_sha256,evidence_at,
  data_owner_reference,infrastructure_owner_reference,policy_reference,reason,status,idempotency_key,request_hash,submitted_by_user_id)
VALUES
 ('16060000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001','BUSINESS_DATA','OBJECT_STORAGE',1,
  'SUPPORTED','evidence-copycoverage-a-160',repeat('a',64),clock_timestamp(),'owner-data-a-160','owner-infra-a-160',
  'policy-retention-a-160','Synthetic pending copy-class fixture','PENDING','copy-coverage-a-160',repeat('e',64),'16010000-0000-4000-8000-000000000001'),
 ('16060000-0000-4000-8000-000000000002','16000000-0000-4000-8000-000000000002','BUSINESS_DATA','OBJECT_STORAGE',1,
  'SUPPORTED','evidence-copycoverage-b-160',repeat('b',64),clock_timestamp(),'owner-data-b-160','owner-infra-b-160',
  'policy-retention-b-160','Synthetic pending copy-class fixture','PENDING','copy-coverage-b-160',repeat('f',64),'16010000-0000-4000-8000-000000000002');

INSERT INTO saas_tenant_backup_copy_class_coverage_decisions
 (decision_id,tenant_id,category_code,copy_class_code,revision,disposition,evidence_reference,evidence_sha256,evidence_at,
  attestation_key_id,attestation_owner_reference,attestation_signature,data_owner_reference,infrastructure_owner_reference,
  policy_reference,reason,status,idempotency_key,request_hash,submitted_by_user_id)
VALUES
 ('16070000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001','BUSINESS_DATA','POSTGRESQL_WAL_PITR',1,
  'UNRESOLVED','evidence-backupclass-a-160',repeat('c',64),clock_timestamp(),'backup-owner-key-ci-160','owner-infra-a-160',repeat('A',86),
  'owner-data-a-160','owner-infra-a-160','policy-retention-a-160','Synthetic pending WAL/PITR fixture','PENDING','backup-class-a-160',repeat('d',64),'16010000-0000-4000-8000-000000000001'),
 ('16070000-0000-4000-8000-000000000002','16000000-0000-4000-8000-000000000002','BUSINESS_DATA','POSTGRESQL_WAL_PITR',1,
  'UNRESOLVED','evidence-backupclass-b-160',repeat('e',64),clock_timestamp(),'backup-owner-key-ci-160','owner-infra-b-160',repeat('A',86),
  'owner-data-b-160','owner-infra-b-160','policy-retention-b-160','Synthetic pending WAL/PITR fixture','PENDING','backup-class-b-160',repeat('f',64),'16010000-0000-4000-8000-000000000002');

INSERT INTO saas_tenant_external_data_targets
 (tenant_id,target_id,store_kind,adapter_key,config_reference,registration_reason,categories,required,
  registered_by_user_id,idempotency_key,request_hash)
VALUES
 ('16000000-0000-4000-8000-000000000001','sql-target-a-160','OBJECT_STORAGE','object-store.v1','factoryos.data.external.a','CI tenant isolation fixture','["BUSINESS_DATA"]',true,'16010000-0000-4000-8000-000000000001','sql-target-a-160',repeat('a',64)),
 ('16000000-0000-4000-8000-000000000002','sql-target-b-160','OBJECT_STORAGE','object-store.v1','factoryos.data.external.b','CI tenant isolation fixture','["BUSINESS_DATA"]',true,'16010000-0000-4000-8000-000000000002','sql-target-b-160',repeat('b',64));
INSERT INTO saas_tenant_finance_retention_policies
 (tenant_id,version,retention_days,legal_basis,finance_adapter_key,status,created_by_user_id,reason,idempotency_key,request_hash)
VALUES
 ('16000000-0000-4000-8000-000000000001',1,365,'Contractual finance record basis','finance.adapter.v1','PENDING','16010000-0000-4000-8000-000000000001','CI tenant-scoped finance retention fixture','sql-finance-a-160',repeat('c',64)),
 ('16000000-0000-4000-8000-000000000002',1,730,'Statutory finance record basis','finance.adapter.v1','PENDING','16010000-0000-4000-8000-000000000002','CI tenant-scoped finance retention fixture','sql-finance-b-160',repeat('d',64));

-- Build a schema-valid preserved export and a RUNNING external run so the
-- database trigger itself, not only the HTTP service, is exercised below.
INSERT INTO saas_tenant_data_transfers
 (tenant_id,transfer_id,version,operation_type,status,source_schema_version,required_categories,
  reason,idempotency_key,request_hash,actor_user_id)
VALUES
 ('16000000-0000-4000-8000-000000000001','16020000-0000-4000-8000-000000000001',1,
  'EXPORT','REQUESTED','1.0.0',
  '["BUSINESS_DATA","AUDIT_LOG","EVIDENCE","APPROVALS","FILE_REFERENCES"]'::jsonb,
  'Initial export version for legal-hold fence CI','hold-fence-export-v1',repeat('1',64),
  '16010000-0000-4000-8000-000000000001');
INSERT INTO saas_tenant_data_transfers
 (tenant_id,transfer_id,version,operation_type,status,source_schema_version,required_categories,
  source_bundle_reference,source_bundle_digest,source_manifest,preservation_verified,
  reason,idempotency_key,request_hash,actor_user_id)
VALUES
 ('16000000-0000-4000-8000-000000000001','16020000-0000-4000-8000-000000000001',2,
  'EXPORT','COMPLETED','1.0.0',
  '["BUSINESS_DATA","AUDIT_LOG","EVIDENCE","APPROVALS","FILE_REFERENCES"]'::jsonb,
  'fixture-export-fence-160',repeat('f',64), '{"fixture":"legal-hold-propagation-fence"}'::jsonb,true,
  'Completed export version for legal-hold fence CI','hold-fence-export-v2',repeat('2',64),
  '16010000-0000-4000-8000-000000000001');

INSERT INTO saas_tenant_data_erasure_requests
 (tenant_id,request_id,version,status,categories,export_transfer_id,export_transfer_version,
  export_bundle_digest,reason,requested_by_user_id,idempotency_key,request_hash)
VALUES
 ('16000000-0000-4000-8000-000000000001','16030000-0000-4000-8000-000000000001',1,'REQUESTED',
  '["BUSINESS_DATA"]'::jsonb,'16020000-0000-4000-8000-000000000001',2,repeat('f',64),
  'Legal hold propagation fence contract fixture','16010000-0000-4000-8000-000000000001',
  'hold-fence-erasure-v1',repeat('3',64));

UPDATE saas_tenant_external_data_targets
SET status='ACTIVE',reviewed_by_user_id='16010000-0000-4000-8000-000000000002',
    reviewed_at=clock_timestamp(),review_reason='Activate synthetic CI target for fence test'
WHERE tenant_id='16000000-0000-4000-8000-000000000001' AND target_id='sql-target-a-160';

INSERT INTO saas_tenant_external_propagation_runs
 (tenant_id,run_id,request_id,request_version,status,categories,source_export_digest,target_count,
  reason,idempotency_key,request_hash,executor_user_id)
VALUES
 ('16000000-0000-4000-8000-000000000001','16040000-0000-4000-8000-000000000001',
  '16030000-0000-4000-8000-000000000001',1,'RUNNING','["BUSINESS_DATA"]'::jsonb,
  repeat('f',64),1,'Synthetic in-flight run for legal-hold race contract',
  'hold-fence-propagation-v1',repeat('4',64),'16010000-0000-4000-8000-000000000002');

-- The database must close the check-to-provider-mutation race, not just the API preflight.
DO $$
DECLARE
  guard_message text;
BEGIN
  BEGIN
    UPDATE saas_tenant_external_copy_coverage_decisions
       SET status='ACCEPTED',reviewed_by_user_id='16010000-0000-4000-8000-000000000002',
           review_reason='Independent SQL run-fence review',reviewed_at=clock_timestamp(),
           valid_until=clock_timestamp()+interval '89 days'
     WHERE tenant_id='16000000-0000-4000-8000-000000000001'
       AND decision_id='16060000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'coverage review changed while an erasure run was RUNNING';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    GET STACKED DIAGNOSTICS guard_message = MESSAGE_TEXT;
    IF guard_message NOT LIKE '%external copy inventory is frozen while a propagation run is RUNNING%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO saas_tenant_external_data_targets
      (tenant_id,target_id,store_kind,adapter_key,config_reference,registration_reason,categories,required,
       registered_by_user_id,idempotency_key,request_hash)
    VALUES
      ('16000000-0000-4000-8000-000000000001','sql-target-running-160','OBJECT_STORAGE','object-store.v1',
       'factoryos.data.external.running','Run fence SQL negative test','["BUSINESS_DATA"]',true,
       '16010000-0000-4000-8000-000000000001','sql-target-running-160',repeat('1',64));
    RAISE EXCEPTION 'required target inventory changed while an erasure run was RUNNING';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    GET STACKED DIAGNOSTICS guard_message = MESSAGE_TEXT;
    IF guard_message NOT LIKE '%external copy inventory is frozen while a propagation run is RUNNING%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE saas_tenant_backup_copy_class_coverage_decisions
       SET status='ACCEPTED',reviewed_by_user_id='16010000-0000-4000-8000-000000000002',
           review_reason='Independent copy-class review',reviewed_at=clock_timestamp(),
           valid_until=clock_timestamp()+interval '89 days'
     WHERE tenant_id='16000000-0000-4000-8000-000000000001'
       AND decision_id='16070000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'backup copy-class evidence changed while an erasure run was RUNNING';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    GET STACKED DIAGNOSTICS guard_message = MESSAGE_TEXT;
    IF guard_message NOT LIKE '%external copy inventory is frozen while a propagation run is RUNNING%' THEN RAISE; END IF;
  END;
END $$;

-- The evidence signer metadata is immutable even while a decision is still pending.
DO $$
DECLARE
  guard_message text;
BEGIN
  BEGIN
    UPDATE saas_tenant_backup_copy_class_coverage_decisions
       SET attestation_signature=repeat('B',86)
     WHERE tenant_id='16000000-0000-4000-8000-000000000001'
       AND decision_id='16070000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'pending backup evidence signature was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    GET STACKED DIAGNOSTICS guard_message = MESSAGE_TEXT;
    IF guard_message NOT LIKE '%reviewed backup copy-class decisions are immutable%' THEN RAISE; END IF;
  END;
END $$;

-- Backup writer-fence SQL lifecycle acceptance. This is synthetic data only.
INSERT INTO saas_tenant_backup_writer_operations
  (tenant_id,operation_id,category_code,producer_id,writer_epoch)
VALUES
  ('16000000-0000-4000-8000-000000000001','16050000-0000-4000-8000-000000000001',
   'BUSINESS_DATA','backup-worker-ci',1);

INSERT INTO saas_tenant_backup_writer_fences
  (tenant_id,category_code,request_id,request_version,run_id,source_export_digest,state,writer_epoch,created_by_user_id)
VALUES
  ('16000000-0000-4000-8000-000000000001','BUSINESS_DATA',
   '16030000-0000-4000-8000-000000000001',1,'16040000-0000-4000-8000-000000000001',
   repeat('f',64),'DRAINING',1,'16010000-0000-4000-8000-000000000001');

DO $$
BEGIN
  BEGIN
    UPDATE saas_tenant_backup_writer_fences SET state='FENCING'
    WHERE tenant_id='16000000-0000-4000-8000-000000000001' AND category_code='BUSINESS_DATA'
      AND run_id='16040000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'writer fence advanced while upload outcome remained ACTIVE';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    INSERT INTO saas_tenant_backup_writer_operations (tenant_id,operation_id,category_code,producer_id,writer_epoch)
    VALUES ('16000000-0000-4000-8000-000000000001','16050000-0000-4000-8000-000000000002',
            'BUSINESS_DATA','backup-worker-late-ci',1);
    RAISE EXCEPTION 'writer permit was accepted after DRAINING fence began';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE saas_tenant_backup_writer_operations SET producer_id='tampered-worker'
    WHERE tenant_id='16000000-0000-4000-8000-000000000001'
      AND operation_id='16050000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'writer operation identity was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    DELETE FROM saas_tenant_backup_writer_operations
    WHERE tenant_id='16000000-0000-4000-8000-000000000001'
      AND operation_id='16050000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'writer operation evidence was deletable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END $$;

UPDATE saas_tenant_backup_writer_operations
SET status='COMPLETED',provider_operation_reference='s3-upload-fixture-160',completed_at=clock_timestamp()
WHERE tenant_id='16000000-0000-4000-8000-000000000001'
  AND operation_id='16050000-0000-4000-8000-000000000001';

UPDATE saas_tenant_backup_writer_fences SET state='FENCING'
WHERE tenant_id='16000000-0000-4000-8000-000000000001' AND category_code='BUSINESS_DATA'
  AND run_id='16040000-0000-4000-8000-000000000001';

DO $$
BEGIN
  BEGIN
    UPDATE saas_tenant_backup_writer_fences SET state='FENCED'
    WHERE tenant_id='16000000-0000-4000-8000-000000000001' AND category_code='BUSINESS_DATA'
      AND run_id='16040000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'FENCED accepted without provider policy/inventory evidence';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END $$;

-- This snapshot is synthetic CI evidence: a submitted inventory independently reviewed by a different actor.
INSERT INTO saas_tenant_backup_writer_inventory_snapshots
  (snapshot_id,tenant_id,category_code,revision,inventory_reference,manifest_digest,entry_count,status,
   idempotency_key,request_hash,registered_by_user_id)
VALUES
  ('16070000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001',
   'BUSINESS_DATA',1,'writer-inventory-ci-160','fb139422c8b254b8bd3f9bfd60b38a11f4939acbe8826098cc3ee3df01ba34dc',1,'PENDING',
   'writer-inventory-160-v1',repeat('d',64),'16010000-0000-4000-8000-000000000001');

INSERT INTO saas_tenant_backup_writer_inventory_entries
  (tenant_id,snapshot_id,entry_ordinal,producer_id,provider_principal_reference,access_path_code,permission_scope_digest)
VALUES
  ('16000000-0000-4000-8000-000000000001','16070000-0000-4000-8000-000000000001',
   1,'backup-worker-ci','aws-role-writer-ci-160','APP_WORKER',repeat('c',64));

UPDATE saas_tenant_backup_writer_inventory_snapshots
SET status='ACCEPTED',reviewed_by_user_id='16010000-0000-4000-8000-000000000002',
    review_reason='Independent CI review of the synthetic writer principal inventory',reviewed_at=clock_timestamp()
WHERE tenant_id='16000000-0000-4000-8000-000000000001'
  AND snapshot_id='16070000-0000-4000-8000-000000000001';

UPDATE saas_tenant_backup_writer_fences
SET state='FENCED',provider_fence_reference='s3-fence-policy-160',
    provider_policy_digest=repeat('a',64),writer_inventory_digest='fb139422c8b254b8bd3f9bfd60b38a11f4939acbe8826098cc3ee3df01ba34dc',fenced_writer_count=1,
    writer_inventory_reference='writer-inventory-ci-160',
    policy_ownership_review_reference='policy-owner-review-ci-160',
    staging_acceptance_reference='s3-stage-acceptance-ci-160',
    restore_replay_reference='restore-replay-ci-160',
    writer_inventory_snapshot_id='16070000-0000-4000-8000-000000000001'
WHERE tenant_id='16000000-0000-4000-8000-000000000001' AND category_code='BUSINESS_DATA'
  AND run_id='16040000-0000-4000-8000-000000000001';

UPDATE saas_tenant_backup_writer_fences SET state='ERASING'
WHERE tenant_id='16000000-0000-4000-8000-000000000001' AND category_code='BUSINESS_DATA'
  AND run_id='16040000-0000-4000-8000-000000000001';

DO $$
BEGIN
  BEGIN
    UPDATE saas_tenant_backup_writer_fences
    SET state='ERASURE_VERIFIED',erasure_manifest_digest=repeat('c',64),
        verification_reference='backup-verify-160',verified_residual_count=1
    WHERE tenant_id='16000000-0000-4000-8000-000000000001' AND category_code='BUSINESS_DATA'
      AND run_id='16040000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'backup erasure was verified while residual copies remained';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END $$;

UPDATE saas_tenant_backup_writer_fences
SET state='ERASURE_VERIFIED',erasure_manifest_digest=repeat('c',64),
    verification_reference='backup-verify-160',verified_residual_count=0
WHERE tenant_id='16000000-0000-4000-8000-000000000001' AND category_code='BUSINESS_DATA'
  AND run_id='16040000-0000-4000-8000-000000000001';

DO $$
BEGIN
  BEGIN
    UPDATE saas_tenant_backup_writer_fences SET state='RELEASED',released_at=clock_timestamp()
    WHERE tenant_id='16000000-0000-4000-8000-000000000001' AND category_code='BUSINESS_DATA'
      AND run_id='16040000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'writer fence was released without independent review and tombstone replay';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END $$;

UPDATE saas_tenant_backup_writer_fences
SET state='RELEASED',tombstone_replay_reference='restore-tombstone-replay-160',
    release_policy_digest=repeat('d',64),release_reference='s3-release-policy-160',
    release_writer_inventory_digest=repeat('e',64),release_writer_count=1,next_writer_epoch=2,
    reviewed_by_user_id='16010000-0000-4000-8000-000000000002',released_at=clock_timestamp()
WHERE tenant_id='16000000-0000-4000-8000-000000000001' AND category_code='BUSINESS_DATA'
  AND run_id='16040000-0000-4000-8000-000000000001';

DO $$
BEGIN
  BEGIN
    INSERT INTO saas_tenant_backup_writer_operations
      (tenant_id,operation_id,category_code,producer_id,writer_epoch)
    VALUES ('16000000-0000-4000-8000-000000000001','16050000-0000-4000-8000-000000000005',
            'BUSINESS_DATA','backup-worker-unconfirmed-release-ci',2);
    RAISE EXCEPTION 'next writer epoch was accepted before provider release confirmation';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END $$;

UPDATE saas_tenant_backup_writer_fences
SET provider_release_confirmed_at=clock_timestamp()
WHERE tenant_id='16000000-0000-4000-8000-000000000001' AND category_code='BUSINESS_DATA'
  AND run_id='16040000-0000-4000-8000-000000000001'
  AND state='RELEASED' AND release_reference='s3-release-policy-160'
  AND release_policy_digest=repeat('d',64);

DO $$
BEGIN
  BEGIN
    INSERT INTO saas_tenant_backup_writer_operations (tenant_id,operation_id,category_code,producer_id,writer_epoch)
    VALUES ('16000000-0000-4000-8000-000000000001','16050000-0000-4000-8000-000000000003',
            'BUSINESS_DATA','backup-worker-stale-epoch-ci',1);
    RAISE EXCEPTION 'stale writer epoch was accepted after release';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END $$;

INSERT INTO saas_tenant_backup_writer_operations
  (tenant_id,operation_id,category_code,producer_id,writer_epoch)
VALUES
  ('16000000-0000-4000-8000-000000000001','16050000-0000-4000-8000-000000000004',
   'BUSINESS_DATA','backup-worker-current-epoch-ci',2);
UPDATE saas_tenant_backup_writer_operations
SET status='COMPLETED',provider_operation_reference='s3-upload-after-erase-160',completed_at=clock_timestamp()
WHERE tenant_id='16000000-0000-4000-8000-000000000001'
  AND operation_id='16050000-0000-4000-8000-000000000004';

DO $$
BEGIN
  BEGIN
    INSERT INTO saas_tenant_data_legal_holds
      (tenant_id,categories,case_reference,reason,idempotency_key,request_hash,created_by_user_id)
    VALUES
      ('16000000-0000-4000-8000-000000000001','["BUSINESS_DATA"]'::jsonb,
       'CASE-BLOCKED-160','Legal hold requested during in-flight erasure',
       'hold-blocked-running-v1',repeat('5',64),'16010000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'overlapping legal hold was accepted during RUNNING propagation';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  -- Category scoping matters: unrelated evidence must not be spuriously blocked.
  INSERT INTO saas_tenant_data_legal_holds
    (tenant_id,categories,case_reference,reason,idempotency_key,request_hash,created_by_user_id)
  VALUES
    ('16000000-0000-4000-8000-000000000001','["EVIDENCE"]'::jsonb,
     'CASE-EVIDENCE-160','Preserve evidence independent of business-data erasure',
     'hold-evidence-running-v1',repeat('6',64),'16010000-0000-4000-8000-000000000001');
END $$;

-- Once the run is no longer RUNNING, the fence should not become a permanent
-- ban on creating a new hold; the ordinary hold lifecycle applies again.
UPDATE saas_tenant_external_propagation_runs
SET status='PARTIAL'
WHERE tenant_id='16000000-0000-4000-8000-000000000001'
  AND run_id='16040000-0000-4000-8000-000000000001';
INSERT INTO saas_tenant_data_legal_holds
  (tenant_id,categories,case_reference,reason,idempotency_key,request_hash,created_by_user_id)
VALUES
  ('16000000-0000-4000-8000-000000000001','["BUSINESS_DATA"]'::jsonb,
   'CASE-AFTER-160','Preserve records after the propagation attempt is stopped',
   'hold-after-partial-v1',repeat('7',64),'16010000-0000-4000-8000-000000000001');

-- The reciprocal trigger rejects both restart of a partial run and a new
-- RUNNING run when the same tenant/category is covered by an active hold.
DO $$
BEGIN
  BEGIN
    UPDATE saas_tenant_external_propagation_runs
    SET status='RUNNING'
    WHERE tenant_id='16000000-0000-4000-8000-000000000001'
      AND run_id='16040000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'external propagation retry entered RUNNING despite active legal hold';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  BEGIN
    INSERT INTO saas_tenant_external_propagation_runs
      (tenant_id,run_id,request_id,request_version,status,categories,source_export_digest,target_count,
       reason,idempotency_key,request_hash,executor_user_id)
    VALUES
      ('16000000-0000-4000-8000-000000000001','16040000-0000-4000-8000-000000000002',
       '16030000-0000-4000-8000-000000000001',1,'RUNNING','["BUSINESS_DATA"]'::jsonb,
       repeat('f',64),1,'Negative fixture: active legal hold must block new propagation run',
       'hold-fence-propagation-v2',repeat('8',64),'16010000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'new external propagation run entered RUNNING despite active legal hold';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END $$;

SET LOCAL ROLE factoryos_app;
SELECT set_config('app.tenant_id','16000000-0000-4000-8000-000000000001',true);
DO $$
DECLARE
  visible_targets integer;
  visible_policies integer;
  visible_writer_operations integer;
  visible_writer_fences integer;
  visible_copy_coverage integer;
  attempted integer;
BEGIN
  SELECT count(*) INTO visible_targets FROM saas_tenant_external_data_targets
   WHERE target_id IN ('sql-target-a-160','sql-target-b-160');
  IF visible_targets<>1 THEN RAISE EXCEPTION 'Tenant A must see only its own external targets; saw %',visible_targets; END IF;
  SELECT count(*) INTO visible_policies FROM saas_tenant_finance_retention_policies
   WHERE version=1 AND tenant_id IN ('16000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000002');
  IF visible_policies<>1 THEN RAISE EXCEPTION 'Tenant A must see only its own finance retention policy; saw %',visible_policies; END IF;
  SELECT count(*) INTO visible_writer_operations FROM saas_tenant_backup_writer_operations
    WHERE operation_id IN ('16050000-0000-4000-8000-000000000001','16050000-0000-4000-8000-000000000004');
  IF visible_writer_operations<>2 THEN RAISE EXCEPTION 'Tenant A must see both of its backup writer operations; saw %',visible_writer_operations; END IF;
  SELECT count(*) INTO visible_writer_fences FROM saas_tenant_backup_writer_fences
    WHERE run_id='16040000-0000-4000-8000-000000000001';
  IF visible_writer_fences<>1 THEN RAISE EXCEPTION 'Tenant A must see its own backup writer fence; saw %',visible_writer_fences; END IF;
  SELECT count(*) INTO visible_copy_coverage FROM saas_tenant_external_copy_coverage_decisions
    WHERE decision_id IN ('16060000-0000-4000-8000-000000000001','16060000-0000-4000-8000-000000000002');
  IF visible_copy_coverage<>1 THEN RAISE EXCEPTION 'Tenant A must see only its own copy-class coverage row; saw %',visible_copy_coverage; END IF;

  UPDATE saas_tenant_external_data_targets SET status='PAUSED'
   WHERE tenant_id='16000000-0000-4000-8000-000000000002' AND target_id='sql-target-b-160';
  GET DIAGNOSTICS attempted = ROW_COUNT;
  IF attempted<>0 THEN RAISE EXCEPTION 'Tenant A changed tenant B external target'; END IF;

  IF NOT has_table_privilege('factoryos_app','public.saas_tenant_external_data_targets','INSERT') THEN
    RAISE EXCEPTION 'factoryos_app requires INSERT privilege to exercise RLS WITH CHECK on external targets';
  END IF;
  BEGIN
    INSERT INTO saas_tenant_external_data_targets
     (tenant_id,target_id,store_kind,adapter_key,config_reference,registration_reason,categories,required,
      registered_by_user_id,idempotency_key,request_hash)
    VALUES
     ('16000000-0000-4000-8000-000000000002','cross-tenant-write-160','OBJECT_STORAGE','object-store.v1',
      'factoryos.data.external.bad','cross-tenant negative test','["BUSINESS_DATA"]',true,
      '16010000-0000-4000-8000-000000000002','cross-tenant-write-160',repeat('e',64));
    RAISE EXCEPTION 'Tenant A unexpectedly registered a target in tenant B';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

SELECT set_config('app.tenant_id','16000000-0000-4000-8000-000000000002',true);
DO $$
DECLARE
  visible_targets integer;
  visible_policies integer;
  visible_writer_operations integer;
  visible_writer_fences integer;
  visible_copy_coverage integer;
BEGIN
  SELECT count(*) INTO visible_targets FROM saas_tenant_external_data_targets
   WHERE target_id IN ('sql-target-a-160','sql-target-b-160');
  IF visible_targets<>1 THEN RAISE EXCEPTION 'Tenant B must see only its own external targets'; END IF;
  SELECT count(*) INTO visible_policies FROM saas_tenant_finance_retention_policies
   WHERE version=1 AND tenant_id IN ('16000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000002');
  IF visible_policies<>1 THEN RAISE EXCEPTION 'Tenant B must see only its own finance retention policy'; END IF;
  SELECT count(*) INTO visible_writer_operations FROM saas_tenant_backup_writer_operations
    WHERE operation_id IN ('16050000-0000-4000-8000-000000000001','16050000-0000-4000-8000-000000000004');
  IF visible_writer_operations<>0 THEN RAISE EXCEPTION 'Tenant B must not see tenant A backup writer operations'; END IF;
  SELECT count(*) INTO visible_writer_fences FROM saas_tenant_backup_writer_fences
    WHERE run_id='16040000-0000-4000-8000-000000000001';
  IF visible_writer_fences<>0 THEN RAISE EXCEPTION 'Tenant B must not see tenant A backup writer fence'; END IF;
  SELECT count(*) INTO visible_copy_coverage FROM saas_tenant_external_copy_coverage_decisions
    WHERE decision_id IN ('16060000-0000-4000-8000-000000000001','16060000-0000-4000-8000-000000000002');
  IF visible_copy_coverage<>1 THEN RAISE EXCEPTION 'Tenant B must see only its own copy-class coverage row; saw %',visible_copy_coverage; END IF;
END $$;
RESET ROLE;
ROLLBACK;

DO $$ BEGIN
  RAISE NOTICE 'External propagation scope, finance retention controls and cross-tenant negative checks passed';
END $$;
