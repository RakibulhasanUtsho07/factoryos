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
    'saas_tenant_finance_retention_runs'
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

SET LOCAL ROLE factoryos_app;
SELECT set_config('app.tenant_id','16000000-0000-4000-8000-000000000001',true);
DO $$
DECLARE
  visible_targets integer;
  visible_policies integer;
  attempted integer;
BEGIN
  SELECT count(*) INTO visible_targets FROM saas_tenant_external_data_targets
   WHERE target_id IN ('sql-target-a-160','sql-target-b-160');
  IF visible_targets<>1 THEN RAISE EXCEPTION 'Tenant A must see only its own external targets; saw %',visible_targets; END IF;
  SELECT count(*) INTO visible_policies FROM saas_tenant_finance_retention_policies
   WHERE version=1 AND tenant_id IN ('16000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000002');
  IF visible_policies<>1 THEN RAISE EXCEPTION 'Tenant A must see only its own finance retention policy; saw %',visible_policies; END IF;

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
BEGIN
  SELECT count(*) INTO visible_targets FROM saas_tenant_external_data_targets
   WHERE target_id IN ('sql-target-a-160','sql-target-b-160');
  IF visible_targets<>1 THEN RAISE EXCEPTION 'Tenant B must see only its own external targets'; END IF;
  SELECT count(*) INTO visible_policies FROM saas_tenant_finance_retention_policies
   WHERE version=1 AND tenant_id IN ('16000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000002');
  IF visible_policies<>1 THEN RAISE EXCEPTION 'Tenant B must see only its own finance retention policy'; END IF;
END $$;
RESET ROLE;
ROLLBACK;

DO $$ BEGIN
  RAISE NOTICE 'External propagation scope, finance retention controls and cross-tenant negative checks passed';
END $$;
