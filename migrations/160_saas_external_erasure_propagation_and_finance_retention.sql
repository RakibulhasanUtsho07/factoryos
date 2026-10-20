BEGIN;

-- External propagation is a second, independently evidenced phase. A PostgreSQL
-- erasure receipt is explicitly POSTGRESQL_ONLY and cannot finalize whole-tenant
-- deletion. Provider credentials stay in the deployment secret manager; these
-- rows contain opaque configuration references only.
INSERT INTO permissions(code, description) VALUES
  ('saas.data_retention.propagate', 'Execute and verify approved external tenant erasure propagation'),
  ('saas.data_retention.finance_review', 'Approve tenant-specific finance ledger retention policies'),
  ('saas.data_retention.finance_execute', 'Execute the separately approved finance ledger retention adapter')
ON CONFLICT (code) DO UPDATE SET description=EXCLUDED.description;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='ORG_ADMIN' AND r.is_system=true
  AND p.code IN ('saas.data_retention.propagate','saas.data_retention.finance_review','saas.data_retention.finance_execute')
ON CONFLICT (role_id,permission_id) DO NOTHING;

ALTER TABLE saas_tenant_data_erasure_runs
  ADD COLUMN IF NOT EXISTS receipt_scope varchar(32) NOT NULL DEFAULT 'POSTGRESQL_ONLY';
ALTER TABLE saas_tenant_data_erasure_runs
  DROP CONSTRAINT IF EXISTS chk_saas_erasure_run_receipt_scope;
ALTER TABLE saas_tenant_data_erasure_runs
  ADD CONSTRAINT chk_saas_erasure_run_receipt_scope CHECK (receipt_scope='POSTGRESQL_ONLY');

CREATE TABLE IF NOT EXISTS saas_tenant_external_data_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  target_id varchar(100) NOT NULL,
  store_kind varchar(32) NOT NULL,
  adapter_key varchar(100) NOT NULL,
  config_reference varchar(200) NOT NULL,
  registration_reason varchar(1000) NOT NULL,
  categories jsonb NOT NULL,
  required boolean NOT NULL DEFAULT true,
  status varchar(12) NOT NULL DEFAULT 'PENDING',
  registered_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_reason varchar(1000),
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_external_target_scope UNIQUE (tenant_id,target_id),
  CONSTRAINT uq_saas_external_target_adapter UNIQUE (tenant_id,store_kind,adapter_key,target_id),
  CONSTRAINT uq_saas_external_target_id_tenant UNIQUE (tenant_id,id),
  CONSTRAINT uq_saas_external_target_idempotency UNIQUE (tenant_id,idempotency_key),
  CONSTRAINT chk_saas_external_target_kind CHECK (store_kind IN (
    'OBJECT_STORAGE','CACHE','SEARCH_INDEX','VECTOR_STORE','LEARNING_ARTIFACT',
    'EXTERNAL_PROVIDER','REPLICA','BACKUP'
  )),
  CONSTRAINT chk_saas_external_target_key CHECK (target_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  CONSTRAINT chk_saas_external_adapter_key CHECK (adapter_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  CONSTRAINT chk_saas_external_config_reference CHECK (
    config_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND config_reference !~* '://'
    AND config_reference !~* '(secret|password|credential|access[-_]?key|token)'
  ),
  CONSTRAINT chk_saas_external_target_registration_reason CHECK (length(btrim(registration_reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_external_target_categories CHECK (
    jsonb_typeof(categories)='array' AND jsonb_array_length(categories) BETWEEN 1 AND 10
    AND categories <@ '[ "BUSINESS_DATA", "AUDIT_LOG", "EVIDENCE", "APPROVALS", "EFFECTIVE_DATED_MASTER_DATA", "AI_CONTEXT", "LEARNING_EVALUATION", "INTEGRATION_METADATA", "FILE_REFERENCES", "IAM_ACCESS" ]'::jsonb
  ),
  CONSTRAINT chk_saas_external_target_status CHECK (status IN ('PENDING','ACTIVE','PAUSED','REJECTED')),
  CONSTRAINT chk_saas_external_target_review CHECK (
    (status='PENDING' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
    OR (status='REJECTED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>registered_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000)
    OR (status IN ('ACTIVE','PAUSED') AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id<>registered_by_user_id AND reviewed_at IS NOT NULL
      AND length(btrim(review_reason)) BETWEEN 3 AND 1000)
  ),
  CONSTRAINT chk_saas_external_target_idempotency CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_external_target_request_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_external_targets_required
  ON saas_tenant_external_data_targets(tenant_id,status,store_kind) WHERE required;
ALTER TABLE saas_tenant_external_data_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_data_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_data_targets_tenant_isolation ON saas_tenant_external_data_targets;
CREATE POLICY saas_tenant_external_data_targets_tenant_isolation
  ON saas_tenant_external_data_targets
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_tenant_external_data_target()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'external target registration is retained as governance evidence' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING' OR NEW.reviewed_by_user_id IS NOT NULL
       OR NEW.reviewed_at IS NOT NULL OR NEW.review_reason IS NOT NULL THEN
      RAISE EXCEPTION 'external targets must be independently reviewed after registration' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.target_id,NEW.store_kind,NEW.adapter_key,NEW.config_reference,NEW.registration_reason,
      NEW.categories,NEW.required,NEW.registered_by_user_id,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.target_id,OLD.store_kind,OLD.adapter_key,OLD.config_reference,OLD.registration_reason,
      OLD.categories,OLD.required,OLD.registered_by_user_id,OLD.idempotency_key,OLD.request_hash,OLD.created_at) THEN
    RAISE EXCEPTION 'external target scope/config reference is immutable; register a new target version' USING ERRCODE='55000';
  END IF;
  IF NEW.status NOT IN ('ACTIVE','PAUSED','REJECTED')
     OR NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=OLD.registered_by_user_id
     OR NEW.reviewed_at IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000
     OR NOT (OLD.status='PENDING' AND NEW.status IN ('ACTIVE','REJECTED')
       OR OLD.status='ACTIVE' AND NEW.status='PAUSED'
       OR OLD.status='PAUSED' AND NEW.status='ACTIVE') THEN
    RAISE EXCEPTION 'external target review/status transition requires a distinct reviewer and reason' USING ERRCODE='55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_data_target_guard ON saas_tenant_external_data_targets;
CREATE TRIGGER saas_tenant_external_data_target_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_external_data_targets
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_tenant_external_data_target();

CREATE TABLE IF NOT EXISTS saas_tenant_external_propagation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_version bigint NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'RUNNING',
  categories jsonb NOT NULL,
  source_export_digest varchar(64) NOT NULL,
  external_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest_digest varchar(64),
  target_count integer NOT NULL DEFAULT 0,
  verified_targets integer NOT NULL DEFAULT 0,
  planned_copies bigint NOT NULL DEFAULT 0,
  deleted_copies bigint NOT NULL DEFAULT 0,
  residual_copies bigint NOT NULL DEFAULT 0,
  failure_code varchar(64),
  reason varchar(1000) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  executor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CONSTRAINT uq_saas_external_propagation_run_scope UNIQUE (tenant_id,request_id,request_version,run_id),
  CONSTRAINT uq_saas_external_propagation_idempotency UNIQUE (tenant_id,request_id,idempotency_key),
  CONSTRAINT fk_saas_external_propagation_request FOREIGN KEY (tenant_id,request_id,request_version)
    REFERENCES saas_tenant_data_erasure_requests(tenant_id,request_id,version) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_external_propagation_status CHECK (status IN ('RUNNING','PARTIAL','FAILED','VERIFIED')),
  CONSTRAINT chk_saas_external_propagation_categories CHECK (jsonb_typeof(categories)='array' AND jsonb_array_length(categories) BETWEEN 1 AND 10),
  CONSTRAINT chk_saas_external_propagation_digest CHECK (source_export_digest ~ '^[a-f0-9]{64}$'
    AND (manifest_digest IS NULL OR manifest_digest ~ '^[a-f0-9]{64}$')),
  CONSTRAINT chk_saas_external_propagation_counts CHECK (
    target_count>=0 AND verified_targets>=0 AND verified_targets<=target_count
    AND planned_copies>=0 AND deleted_copies>=0 AND residual_copies>=0 AND deleted_copies<=planned_copies
  ),
  CONSTRAINT chk_saas_external_propagation_terminal CHECK (
    (status='VERIFIED' AND manifest_digest IS NOT NULL AND finished_at IS NOT NULL
      AND target_count>0 AND verified_targets=target_count AND residual_copies=0
      AND deleted_copies=planned_copies AND failure_code IS NULL)
    OR (status IN ('RUNNING','PARTIAL') AND finished_at IS NULL AND manifest_digest IS NULL)
    OR (status='FAILED' AND finished_at IS NOT NULL AND failure_code IS NOT NULL AND failure_code ~ '^[A-Z0-9_]{1,64} CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_external_propagation_key CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_external_propagation_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_external_propagation_request
  ON saas_tenant_external_propagation_runs(tenant_id,request_id,created_at DESC);
ALTER TABLE saas_tenant_external_propagation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_runs_tenant_isolation ON saas_tenant_external_propagation_runs;
CREATE POLICY saas_tenant_external_propagation_runs_tenant_isolation
  ON saas_tenant_external_propagation_runs
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_external_propagation_run()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'external propagation run evidence is immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'RUNNING' OR NEW.manifest_digest IS NOT NULL OR NEW.finished_at IS NOT NULL
       OR NEW.verified_targets<>0 OR NEW.deleted_copies<>0 OR NEW.residual_copies<>0 THEN
      RAISE EXCEPTION 'external propagation runs must start in a clean RUNNING state' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.run_id,NEW.request_id,NEW.request_version,NEW.categories,
      NEW.source_export_digest,NEW.reason,NEW.idempotency_key,NEW.request_hash,
      NEW.executor_user_id,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.run_id,OLD.request_id,OLD.request_version,OLD.categories,
      OLD.source_export_digest,OLD.reason,OLD.idempotency_key,OLD.request_hash,
      OLD.executor_user_id,OLD.created_at) THEN
    RAISE EXCEPTION 'external propagation run identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='VERIFIED' OR NOT (
       OLD.status='RUNNING' AND NEW.status IN ('RUNNING','PARTIAL','FAILED','VERIFIED')
       OR OLD.status='PARTIAL' AND NEW.status IN ('RUNNING','FAILED','VERIFIED')
       OR OLD.status='FAILED' AND NEW.status='RUNNING'
     ) THEN
    RAISE EXCEPTION 'invalid external propagation state transition: % -> %',OLD.status,NEW.status USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_run_guard ON saas_tenant_external_propagation_runs;
CREATE TRIGGER saas_tenant_external_propagation_run_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_external_propagation_runs
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_external_propagation_run();

CREATE TABLE IF NOT EXISTS saas_tenant_external_propagation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  run_id uuid NOT NULL,
  target_id varchar(100) NOT NULL,
  store_kind varchar(32) NOT NULL,
  attempt_no integer NOT NULL,
  status varchar(12) NOT NULL,
  planned_copies bigint NOT NULL,
  deleted_copies bigint NOT NULL,
  residual_copies bigint NOT NULL,
  manifest_digest varchar(64) NOT NULL,
  verified_manifest_digest varchar(64),
  verification_reference varchar(200),
  residual_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_code varchar(64),
  provider_receipt_reference varchar(200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_saas_external_receipt_run FOREIGN KEY (tenant_id,request_id,run_id)
    REFERENCES saas_tenant_external_propagation_runs(tenant_id,request_id,run_id) ON DELETE RESTRICT,
  CONSTRAINT fk_saas_external_receipt_target FOREIGN KEY (tenant_id,target_id)
    REFERENCES saas_tenant_external_data_targets(tenant_id,target_id) ON DELETE RESTRICT,
  CONSTRAINT uq_saas_external_receipt_attempt UNIQUE (tenant_id,request_id,run_id,target_id,attempt_no),
  CONSTRAINT chk_saas_external_receipt_kind CHECK (store_kind IN (
    'OBJECT_STORAGE','CACHE','SEARCH_INDEX','VECTOR_STORE','LEARNING_ARTIFACT',
    'EXTERNAL_PROVIDER','REPLICA','BACKUP'
  )),
  CONSTRAINT chk_saas_external_receipt_attempt CHECK (attempt_no>=1),
  CONSTRAINT chk_saas_external_receipt_status CHECK (status IN ('VERIFIED','RESIDUALS','FAILED')),
  CONSTRAINT chk_saas_external_receipt_counts CHECK (
    planned_copies>=0 AND deleted_copies>=0 AND residual_copies>=0 AND deleted_copies<=planned_copies
  ),
  CONSTRAINT chk_saas_external_receipt_manifest CHECK (
    manifest_digest ~ '^[a-f0-9]{64}$'
    AND (verified_manifest_digest IS NULL OR verified_manifest_digest ~ '^[a-f0-9]{64}$')
    AND jsonb_typeof(residual_manifest)='array'
  ),
  CONSTRAINT chk_saas_external_receipt_verification CHECK (
    (status='VERIFIED' AND verified_manifest_digest IS NOT NULL AND verified_manifest_digest=manifest_digest AND residual_copies=0
      AND deleted_copies=planned_copies AND verification_reference IS NOT NULL
      AND failure_code IS NULL)
    OR (status='RESIDUALS' AND residual_copies>0 AND jsonb_array_length(residual_manifest)>0)
    OR (status='FAILED' AND failure_code IS NOT NULL AND failure_code ~ '^[A-Z0-9_]{1,64} ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_receipts_tenant_isolation ON saas_tenant_external_propagation_receipts;
CREATE POLICY saas_tenant_external_propagation_receipts_tenant_isolation
  ON saas_tenant_external_propagation_receipts
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE OR REPLACE FUNCTION factoryos_reject_saas_external_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  RAISE EXCEPTION 'external provider receipts are append-only evidence' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_receipt_immutable ON saas_tenant_external_propagation_receipts;
CREATE TRIGGER saas_tenant_external_propagation_receipt_immutable
  BEFORE UPDATE OR DELETE ON saas_tenant_external_propagation_receipts
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_saas_external_receipt_mutation();

ALTER TABLE saas_tenant_data_erasure_requests
  ADD COLUMN IF NOT EXISTS propagation_run_id uuid,
  ADD COLUMN IF NOT EXISTS propagation_manifest_digest varchar(64),
  ADD COLUMN IF NOT EXISTS propagation_verified_at timestamptz;

ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS chk_saas_tenant_erasure_status;
ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS chk_saas_tenant_erasure_review;

-- Older releases used VERIFIED for PostgreSQL-only deletion. Demote those rows
-- before installing the stricter lifecycle constraints; preserve the SQL receipt
-- and increment row_version so that they cannot masquerade as whole-tenant erasure.
ALTER TABLE saas_tenant_data_erasure_requests DISABLE TRIGGER USER;
UPDATE saas_tenant_data_erasure_requests
SET status='PROPAGATION_PENDING',
    propagation_run_id=NULL,
    propagation_manifest_digest=NULL,
    propagation_verified_at=NULL,
    row_version=row_version+1,
    updated_at=clock_timestamp()
WHERE status='VERIFIED'
  AND propagation_run_id IS NULL
  AND propagation_manifest_digest IS NULL
  AND propagation_verified_at IS NULL
  AND execution_run_id IS NOT NULL
  AND execution_manifest_digest ~ '^[a-f0-9]{64}$';
ALTER TABLE saas_tenant_data_erasure_requests ENABLE TRIGGER USER;

ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT chk_saas_tenant_erasure_status CHECK (status IN (
    'REQUESTED','APPROVED','REJECTED','EXECUTING','PROPAGATION_PENDING','VERIFIED'
  ));
ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT chk_saas_tenant_erasure_review CHECK (
    (status='REQUESTED' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL
      AND execution_started_by_user_id IS NULL AND execution_started_at IS NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='REJECTED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NULL AND execution_started_at IS NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='APPROVED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NULL AND execution_started_at IS NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='EXECUTING' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NOT NULL AND execution_started_by_user_id<>requested_by_user_id
      AND execution_started_by_user_id<>reviewed_by_user_id AND execution_started_at IS NOT NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='PROPAGATION_PENDING' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NOT NULL AND execution_started_by_user_id<>requested_by_user_id
      AND execution_started_by_user_id<>reviewed_by_user_id AND execution_started_at IS NOT NULL
      AND execution_completed_at IS NOT NULL AND execution_run_id IS NOT NULL
      AND execution_manifest_digest ~ '^[a-f0-9]{64}$'
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='VERIFIED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NOT NULL AND execution_started_by_user_id<>requested_by_user_id
      AND execution_started_by_user_id<>reviewed_by_user_id AND execution_started_at IS NOT NULL
      AND execution_completed_at IS NOT NULL AND execution_run_id IS NOT NULL
      AND execution_manifest_digest ~ '^[a-f0-9]{64}$'
      AND propagation_run_id IS NOT NULL AND propagation_manifest_digest ~ '^[a-f0-9]{64}$'
      AND propagation_verified_at IS NOT NULL)
  );


ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS fk_saas_tenant_erasure_propagation_run;
ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT fk_saas_tenant_erasure_propagation_run
  FOREIGN KEY (tenant_id,request_id,version,propagation_run_id)
  REFERENCES saas_tenant_external_propagation_runs(tenant_id,request_id,request_version,run_id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION factoryos_guard_saas_tenant_data_erasure_request()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_transfer public.saas_tenant_data_transfers%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'tenant erasure request evidence is retained' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'REQUESTED' OR NEW.version<>1 OR NEW.row_version<>1
       OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_reason IS NOT NULL
       OR NEW.execution_started_by_user_id IS NOT NULL OR NEW.execution_started_at IS NOT NULL
       OR NEW.execution_completed_at IS NOT NULL OR NEW.execution_run_id IS NOT NULL
       OR NEW.execution_manifest_digest IS NOT NULL OR NEW.propagation_run_id IS NOT NULL
       OR NEW.propagation_manifest_digest IS NOT NULL OR NEW.propagation_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'erasure requests must start cleanly in REQUESTED version 1' USING ERRCODE='55000';
    END IF;
    SELECT * INTO source_transfer FROM public.saas_tenant_data_transfers t
    WHERE t.tenant_id=NEW.tenant_id AND t.transfer_id=NEW.export_transfer_id
      AND t.version=NEW.export_transfer_version AND t.operation_type='EXPORT'
      AND t.status='COMPLETED' AND t.source_bundle_digest=NEW.export_bundle_digest;
    IF NOT FOUND THEN RAISE EXCEPTION 'erasure request requires a completed preserved export for the same tenant' USING ERRCODE='55000'; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_transfer.required_categories) exported(category)
        WHERE exported.category=requested.category)
    ) THEN RAISE EXCEPTION 'requested erasure categories must be present in the preserved export' USING ERRCODE='55000'; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE requested.category NOT IN ('BUSINESS_DATA','EVIDENCE','AI_CONTEXT','LEARNING_EVALUATION')
    ) THEN RAISE EXCEPTION 'requested erasure category has no reviewed deletion adapter' USING ERRCODE='55000'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.saas_tenant_data_legal_holds h
      CROSS JOIN LATERAL jsonb_array_elements_text(h.categories) held(category)
      CROSS JOIN LATERAL jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE h.tenant_id=NEW.tenant_id AND h.status='ACTIVE' AND held.category=requested.category
    ) THEN RAISE EXCEPTION 'active legal hold blocks erasure request' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.request_id,NEW.version,NEW.categories,NEW.export_transfer_id,NEW.export_transfer_version,
      NEW.export_bundle_digest,NEW.reason,NEW.requested_by_user_id,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.request_id,OLD.version,OLD.categories,OLD.export_transfer_id,OLD.export_transfer_version,
      OLD.export_bundle_digest,OLD.reason,OLD.requested_by_user_id,OLD.idempotency_key,OLD.request_hash,OLD.created_at) THEN
    RAISE EXCEPTION 'erasure request definition is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.row_version<>OLD.row_version+1 THEN
    RAISE EXCEPTION 'erasure lifecycle transitions must advance exactly one row version' USING ERRCODE='40001';
  END IF;
  IF OLD.status='REQUESTED' AND NEW.status IN ('APPROVED','REJECTED') THEN
    IF NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=OLD.requested_by_user_id
       OR NEW.reviewed_at IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000
       OR NEW.execution_started_by_user_id IS NOT NULL OR NEW.execution_started_at IS NOT NULL
       OR NEW.execution_completed_at IS NOT NULL OR NEW.execution_run_id IS NOT NULL
       OR NEW.execution_manifest_digest IS NOT NULL OR NEW.propagation_run_id IS NOT NULL
       OR NEW.propagation_manifest_digest IS NOT NULL OR NEW.propagation_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'erasure review requires distinct reviewer, reason and clean execution state' USING ERRCODE='55000';
    END IF;
    IF NEW.status='APPROVED' AND EXISTS (
      SELECT 1 FROM public.saas_tenant_data_legal_holds h
      CROSS JOIN LATERAL jsonb_array_elements_text(h.categories) held(category)
      CROSS JOIN LATERAL jsonb_array_elements_text(OLD.categories) requested(category)
      WHERE h.tenant_id=OLD.tenant_id AND h.status='ACTIVE' AND held.category=requested.category
    ) THEN RAISE EXCEPTION 'active legal hold blocks approval for one or more categories' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='APPROVED' AND NEW.status='EXECUTING' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason) IS DISTINCT FROM
       (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason)
       OR NEW.execution_started_by_user_id IS NULL
       OR NEW.execution_started_by_user_id IN (OLD.requested_by_user_id,OLD.reviewed_by_user_id)
       OR NEW.execution_started_at IS NULL OR NEW.execution_completed_at IS NOT NULL
       OR NEW.execution_run_id IS NOT NULL OR NEW.execution_manifest_digest IS NOT NULL
       OR NEW.propagation_run_id IS NOT NULL OR NEW.propagation_manifest_digest IS NOT NULL
       OR NEW.propagation_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'PostgreSQL erasure phase requires an independent executor and clean receipt state' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='EXECUTING' AND NEW.status='PROPAGATION_PENDING' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason,NEW.execution_started_by_user_id,NEW.execution_started_at)
       IS DISTINCT FROM
       (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason,OLD.execution_started_by_user_id,OLD.execution_started_at)
       OR NEW.execution_completed_at IS NULL OR NEW.execution_run_id IS NULL
       OR NEW.execution_manifest_digest !~ '^[a-f0-9]{64}$'
       OR NEW.propagation_run_id IS NOT NULL OR NEW.propagation_manifest_digest IS NOT NULL OR NEW.propagation_verified_at IS NOT NULL
       OR NOT EXISTS (
         SELECT 1 FROM public.saas_tenant_data_erasure_runs r
         WHERE r.tenant_id=NEW.tenant_id AND r.request_id=NEW.request_id
           AND r.request_version=NEW.version AND r.run_id=NEW.execution_run_id
           AND r.status='COMPLETED' AND r.manifest_digest=NEW.execution_manifest_digest
           AND r.receipt_scope='POSTGRESQL_ONLY'
       ) THEN
      RAISE EXCEPTION 'PROPAGATION_PENDING requires a matching PostgreSQL-only deletion receipt' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='PROPAGATION_PENDING' AND NEW.status='VERIFIED' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason,NEW.execution_started_by_user_id,
        NEW.execution_started_at,NEW.execution_completed_at,NEW.execution_run_id,NEW.execution_manifest_digest)
       IS DISTINCT FROM
       (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason,OLD.execution_started_by_user_id,
        OLD.execution_started_at,OLD.execution_completed_at,OLD.execution_run_id,OLD.execution_manifest_digest)
       OR NEW.propagation_run_id IS NULL OR NEW.propagation_manifest_digest !~ '^[a-f0-9]{64}$'
       OR NEW.propagation_verified_at IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM public.saas_tenant_external_propagation_runs r
         WHERE r.tenant_id=NEW.tenant_id AND r.request_id=NEW.request_id
           AND r.request_version=NEW.version AND r.run_id=NEW.propagation_run_id
           AND r.status='VERIFIED' AND r.manifest_digest=NEW.propagation_manifest_digest
           AND r.residual_copies=0 AND r.deleted_copies=r.planned_copies
       ) THEN
      RAISE EXCEPTION 'VERIFIED requires zero-residual external propagation receipt bound to this request' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid tenant erasure lifecycle transition: % -> %',OLD.status,NEW.status USING ERRCODE='40001';
END $$;

-- A separate finance-retention policy cannot be expressed as BUSINESS_DATA.
-- Policies are versioned, reviewed by a distinct actor, and the executor must
-- be independent. This ledger is intentionally not bound to the generic delete adapter.
CREATE TABLE IF NOT EXISTS saas_tenant_finance_retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  version bigint NOT NULL,
  retention_days integer NOT NULL,
  legal_basis varchar(200) NOT NULL,
  finance_adapter_key varchar(100) NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'PENDING',
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_reason varchar(1000),
  reason varchar(1000) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_finance_retention_version UNIQUE (tenant_id,version),
  CONSTRAINT uq_saas_finance_retention_key UNIQUE (tenant_id,idempotency_key),
  CONSTRAINT chk_saas_finance_retention_version CHECK (version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_saas_finance_retention_days CHECK (retention_days BETWEEN 1 AND 36500),
  CONSTRAINT chk_saas_finance_retention_adapter CHECK (finance_adapter_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  CONSTRAINT chk_saas_finance_retention_status CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  CONSTRAINT chk_saas_finance_retention_review CHECK (
    (status='PENDING' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
    OR (status IN ('APPROVED','REJECTED') AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id<>created_by_user_id AND reviewed_at IS NOT NULL
      AND length(btrim(review_reason)) BETWEEN 3 AND 1000)
  ),
  CONSTRAINT chk_saas_finance_retention_legal_basis CHECK (length(btrim(legal_basis)) BETWEEN 3 AND 200),
  CONSTRAINT chk_saas_finance_retention_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_finance_retention_key_format CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_finance_retention_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
ALTER TABLE saas_tenant_finance_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_finance_retention_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_finance_retention_policies_tenant_isolation ON saas_tenant_finance_retention_policies;
CREATE POLICY saas_tenant_finance_retention_policies_tenant_isolation
  ON saas_tenant_finance_retention_policies
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_finance_retention_policy()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE prior_version bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'finance retention policy evidence is immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT max(version) INTO prior_version FROM public.saas_tenant_finance_retention_policies WHERE tenant_id=NEW.tenant_id;
    IF NEW.version<>COALESCE(prior_version,0)+1 OR NEW.status<>'PENDING'
      OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_reason IS NOT NULL THEN
      RAISE EXCEPTION 'finance retention policy must use next version and independent review' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.version,NEW.retention_days,NEW.legal_basis,NEW.finance_adapter_key,
      NEW.created_by_user_id,NEW.reason,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.version,OLD.retention_days,OLD.legal_basis,OLD.finance_adapter_key,
      OLD.created_by_user_id,OLD.reason,OLD.idempotency_key,OLD.request_hash,OLD.created_at)
     OR OLD.status<>'PENDING' OR NEW.status NOT IN ('APPROVED','REJECTED')
     OR NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=OLD.created_by_user_id
     OR NEW.reviewed_at IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'finance retention review requires a distinct reviewer and immutable policy scope' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_finance_retention_policy_guard ON saas_tenant_finance_retention_policies;
CREATE TRIGGER saas_tenant_finance_retention_policy_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_finance_retention_policies
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_finance_retention_policy();

CREATE TABLE IF NOT EXISTS saas_tenant_finance_retention_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  policy_version bigint NOT NULL,
  mode varchar(12) NOT NULL,
  status varchar(12) NOT NULL,
  cutoff_at timestamptz NOT NULL,
  planned_rows bigint NOT NULL DEFAULT 0,
  deleted_rows bigint NOT NULL DEFAULT 0,
  residual_rows bigint NOT NULL DEFAULT 0,
  table_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest_digest varchar(64),
  adapter_receipt_reference varchar(200),
  failure_code varchar(64),
  reason varchar(1000) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  approved_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  executor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CONSTRAINT uq_saas_finance_retention_run UNIQUE (tenant_id,run_id),
  CONSTRAINT uq_saas_finance_retention_run_key UNIQUE (tenant_id,idempotency_key),
  CONSTRAINT fk_saas_finance_retention_run_policy FOREIGN KEY (tenant_id,policy_version)
    REFERENCES saas_tenant_finance_retention_policies(tenant_id,version) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_finance_retention_run_mode CHECK (mode IN ('DRY_RUN','EXECUTE')),
  CONSTRAINT chk_saas_finance_retention_run_status CHECK (status IN ('COMPLETED','BLOCKED','FAILED')),
  CONSTRAINT chk_saas_finance_retention_run_counts CHECK (
    planned_rows>=0 AND deleted_rows>=0 AND residual_rows>=0 AND deleted_rows<=planned_rows
  ),
  CONSTRAINT chk_saas_finance_retention_run_manifest CHECK (
    jsonb_typeof(table_manifest)='object'
    AND (manifest_digest IS NULL OR manifest_digest ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT chk_saas_finance_retention_run_result CHECK (
    (status='COMPLETED' AND manifest_digest IS NOT NULL AND residual_rows=0 AND failure_code IS NULL
      AND finished_at IS NOT NULL AND adapter_receipt_reference IS NOT NULL)
    OR (status='BLOCKED' AND failure_code IS NOT NULL AND finished_at IS NOT NULL)
    OR (status='FAILED' AND failure_code IS NOT NULL AND finished_at IS NOT NULL)
  ),
  CONSTRAINT chk_saas_finance_retention_run_actors CHECK (approved_by_user_id<>executor_user_id),
  CONSTRAINT chk_saas_finance_retention_run_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_finance_retention_run_key CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_finance_retention_run_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_finance_retention_runs_tenant
  ON saas_tenant_finance_retention_runs(tenant_id,created_at DESC);
ALTER TABLE saas_tenant_finance_retention_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_finance_retention_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_finance_retention_runs_tenant_isolation ON saas_tenant_finance_retention_runs;
CREATE POLICY saas_tenant_finance_retention_runs_tenant_isolation
  ON saas_tenant_finance_retention_runs
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE OR REPLACE FUNCTION factoryos_reject_saas_finance_retention_run_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'finance retention receipts are append-only' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS saas_tenant_finance_retention_run_immutable ON saas_tenant_finance_retention_runs;
CREATE TRIGGER saas_tenant_finance_retention_run_immutable
  BEFORE UPDATE OR DELETE ON saas_tenant_finance_retention_runs
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_saas_finance_retention_run_mutation();

-- These control-plane receipts/configuration are not generic tenant export data and
-- are not eligible for business-data erasure.
INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_external_data_targets','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Tenant-scoped provider target configuration and independent review evidence.'),
  ('public','saas_tenant_external_propagation_runs','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','External propagation lifecycle with exact copy-count, manifest and recovery evidence.'),
  ('public','saas_tenant_external_propagation_receipts','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable per-adapter deletion and residual-verification receipt.'),
  ('public','saas_tenant_finance_retention_policies','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Separately approved finance/usage ledger retention policy; not part of generic business erasure.'),
  ('public','saas_tenant_finance_retention_runs','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable result from the separately approved finance retention adapter.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,
  classified_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('160_saas_external_erasure_propagation_and_finance_retention',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;)
  ),
  CONSTRAINT chk_saas_external_propagation_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_external_propagation_key CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_external_propagation_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_external_propagation_request
  ON saas_tenant_external_propagation_runs(tenant_id,request_id,created_at DESC);
ALTER TABLE saas_tenant_external_propagation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_runs_tenant_isolation ON saas_tenant_external_propagation_runs;
CREATE POLICY saas_tenant_external_propagation_runs_tenant_isolation
  ON saas_tenant_external_propagation_runs
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_external_propagation_run()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'external propagation run evidence is immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'RUNNING' OR NEW.manifest_digest IS NOT NULL OR NEW.finished_at IS NOT NULL
       OR NEW.verified_targets<>0 OR NEW.deleted_copies<>0 OR NEW.residual_copies<>0 THEN
      RAISE EXCEPTION 'external propagation runs must start in a clean RUNNING state' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.run_id,NEW.request_id,NEW.request_version,NEW.categories,
      NEW.source_export_digest,NEW.reason,NEW.idempotency_key,NEW.request_hash,
      NEW.executor_user_id,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.run_id,OLD.request_id,OLD.request_version,OLD.categories,
      OLD.source_export_digest,OLD.reason,OLD.idempotency_key,OLD.request_hash,
      OLD.executor_user_id,OLD.created_at) THEN
    RAISE EXCEPTION 'external propagation run identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='VERIFIED' OR NOT (
       OLD.status='RUNNING' AND NEW.status IN ('RUNNING','PARTIAL','FAILED','VERIFIED')
       OR OLD.status='PARTIAL' AND NEW.status IN ('RUNNING','FAILED','VERIFIED')
       OR OLD.status='FAILED' AND NEW.status='RUNNING'
     ) THEN
    RAISE EXCEPTION 'invalid external propagation state transition: % -> %',OLD.status,NEW.status USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_run_guard ON saas_tenant_external_propagation_runs;
CREATE TRIGGER saas_tenant_external_propagation_run_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_external_propagation_runs
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_external_propagation_run();

CREATE TABLE IF NOT EXISTS saas_tenant_external_propagation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  run_id uuid NOT NULL,
  target_id varchar(100) NOT NULL,
  store_kind varchar(32) NOT NULL,
  attempt_no integer NOT NULL,
  status varchar(12) NOT NULL,
  planned_copies bigint NOT NULL,
  deleted_copies bigint NOT NULL,
  residual_copies bigint NOT NULL,
  manifest_digest varchar(64) NOT NULL,
  verified_manifest_digest varchar(64),
  verification_reference varchar(200),
  residual_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_code varchar(64),
  provider_receipt_reference varchar(200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_saas_external_receipt_run FOREIGN KEY (tenant_id,request_id,run_id)
    REFERENCES saas_tenant_external_propagation_runs(tenant_id,request_id,run_id) ON DELETE RESTRICT,
  CONSTRAINT fk_saas_external_receipt_target FOREIGN KEY (tenant_id,target_id)
    REFERENCES saas_tenant_external_data_targets(tenant_id,target_id) ON DELETE RESTRICT,
  CONSTRAINT uq_saas_external_receipt_attempt UNIQUE (tenant_id,request_id,run_id,target_id,attempt_no),
  CONSTRAINT chk_saas_external_receipt_kind CHECK (store_kind IN (
    'OBJECT_STORAGE','CACHE','SEARCH_INDEX','VECTOR_STORE','LEARNING_ARTIFACT',
    'EXTERNAL_PROVIDER','REPLICA','BACKUP'
  )),
  CONSTRAINT chk_saas_external_receipt_attempt CHECK (attempt_no>=1),
  CONSTRAINT chk_saas_external_receipt_status CHECK (status IN ('VERIFIED','RESIDUALS','FAILED')),
  CONSTRAINT chk_saas_external_receipt_counts CHECK (
    planned_copies>=0 AND deleted_copies>=0 AND residual_copies>=0 AND deleted_copies<=planned_copies
  ),
  CONSTRAINT chk_saas_external_receipt_manifest CHECK (
    manifest_digest ~ '^[a-f0-9]{64}$'
    AND (verified_manifest_digest IS NULL OR verified_manifest_digest ~ '^[a-f0-9]{64}$')
    AND jsonb_typeof(residual_manifest)='array'
  ),
  CONSTRAINT chk_saas_external_receipt_verification CHECK (
    (status='VERIFIED' AND verified_manifest_digest IS NOT NULL AND verified_manifest_digest=manifest_digest AND residual_copies=0
      AND deleted_copies=planned_copies AND verification_reference IS NOT NULL
      AND failure_code IS NULL)
    OR (status='RESIDUALS' AND residual_copies>0 AND jsonb_array_length(residual_manifest)>0)
    OR (status='FAILED' AND failure_code IS NOT NULL AND failure_code ~ '^[A-Z0-9_]{1,64}
  )
);
ALTER TABLE saas_tenant_external_propagation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_receipts_tenant_isolation ON saas_tenant_external_propagation_receipts;
CREATE POLICY saas_tenant_external_propagation_receipts_tenant_isolation
  ON saas_tenant_external_propagation_receipts
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE OR REPLACE FUNCTION factoryos_reject_saas_external_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  RAISE EXCEPTION 'external provider receipts are append-only evidence' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_receipt_immutable ON saas_tenant_external_propagation_receipts;
CREATE TRIGGER saas_tenant_external_propagation_receipt_immutable
  BEFORE UPDATE OR DELETE ON saas_tenant_external_propagation_receipts
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_saas_external_receipt_mutation();

ALTER TABLE saas_tenant_data_erasure_requests
  ADD COLUMN IF NOT EXISTS propagation_run_id uuid,
  ADD COLUMN IF NOT EXISTS propagation_manifest_digest varchar(64),
  ADD COLUMN IF NOT EXISTS propagation_verified_at timestamptz;

ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS chk_saas_tenant_erasure_status;
ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS chk_saas_tenant_erasure_review;

-- Older releases used VERIFIED for PostgreSQL-only deletion. Demote those rows
-- before installing the stricter lifecycle constraints; preserve the SQL receipt
-- and increment row_version so that they cannot masquerade as whole-tenant erasure.
ALTER TABLE saas_tenant_data_erasure_requests DISABLE TRIGGER USER;
UPDATE saas_tenant_data_erasure_requests
SET status='PROPAGATION_PENDING',
    propagation_run_id=NULL,
    propagation_manifest_digest=NULL,
    propagation_verified_at=NULL,
    row_version=row_version+1,
    updated_at=clock_timestamp()
WHERE status='VERIFIED'
  AND propagation_run_id IS NULL
  AND propagation_manifest_digest IS NULL
  AND propagation_verified_at IS NULL
  AND execution_run_id IS NOT NULL
  AND execution_manifest_digest ~ '^[a-f0-9]{64}$';
ALTER TABLE saas_tenant_data_erasure_requests ENABLE TRIGGER USER;

ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT chk_saas_tenant_erasure_status CHECK (status IN (
    'REQUESTED','APPROVED','REJECTED','EXECUTING','PROPAGATION_PENDING','VERIFIED'
  ));
ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT chk_saas_tenant_erasure_review CHECK (
    (status='REQUESTED' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL
      AND execution_started_by_user_id IS NULL AND execution_started_at IS NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='REJECTED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NULL AND execution_started_at IS NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='APPROVED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NULL AND execution_started_at IS NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='EXECUTING' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NOT NULL AND execution_started_by_user_id<>requested_by_user_id
      AND execution_started_by_user_id<>reviewed_by_user_id AND execution_started_at IS NOT NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='PROPAGATION_PENDING' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NOT NULL AND execution_started_by_user_id<>requested_by_user_id
      AND execution_started_by_user_id<>reviewed_by_user_id AND execution_started_at IS NOT NULL
      AND execution_completed_at IS NOT NULL AND execution_run_id IS NOT NULL
      AND execution_manifest_digest ~ '^[a-f0-9]{64}$'
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='VERIFIED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NOT NULL AND execution_started_by_user_id<>requested_by_user_id
      AND execution_started_by_user_id<>reviewed_by_user_id AND execution_started_at IS NOT NULL
      AND execution_completed_at IS NOT NULL AND execution_run_id IS NOT NULL
      AND execution_manifest_digest ~ '^[a-f0-9]{64}$'
      AND propagation_run_id IS NOT NULL AND propagation_manifest_digest ~ '^[a-f0-9]{64}$'
      AND propagation_verified_at IS NOT NULL)
  );


ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS fk_saas_tenant_erasure_propagation_run;
ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT fk_saas_tenant_erasure_propagation_run
  FOREIGN KEY (tenant_id,request_id,version,propagation_run_id)
  REFERENCES saas_tenant_external_propagation_runs(tenant_id,request_id,request_version,run_id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION factoryos_guard_saas_tenant_data_erasure_request()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_transfer public.saas_tenant_data_transfers%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'tenant erasure request evidence is retained' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'REQUESTED' OR NEW.version<>1 OR NEW.row_version<>1
       OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_reason IS NOT NULL
       OR NEW.execution_started_by_user_id IS NOT NULL OR NEW.execution_started_at IS NOT NULL
       OR NEW.execution_completed_at IS NOT NULL OR NEW.execution_run_id IS NOT NULL
       OR NEW.execution_manifest_digest IS NOT NULL OR NEW.propagation_run_id IS NOT NULL
       OR NEW.propagation_manifest_digest IS NOT NULL OR NEW.propagation_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'erasure requests must start cleanly in REQUESTED version 1' USING ERRCODE='55000';
    END IF;
    SELECT * INTO source_transfer FROM public.saas_tenant_data_transfers t
    WHERE t.tenant_id=NEW.tenant_id AND t.transfer_id=NEW.export_transfer_id
      AND t.version=NEW.export_transfer_version AND t.operation_type='EXPORT'
      AND t.status='COMPLETED' AND t.source_bundle_digest=NEW.export_bundle_digest;
    IF NOT FOUND THEN RAISE EXCEPTION 'erasure request requires a completed preserved export for the same tenant' USING ERRCODE='55000'; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_transfer.required_categories) exported(category)
        WHERE exported.category=requested.category)
    ) THEN RAISE EXCEPTION 'requested erasure categories must be present in the preserved export' USING ERRCODE='55000'; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE requested.category NOT IN ('BUSINESS_DATA','EVIDENCE','AI_CONTEXT','LEARNING_EVALUATION')
    ) THEN RAISE EXCEPTION 'requested erasure category has no reviewed deletion adapter' USING ERRCODE='55000'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.saas_tenant_data_legal_holds h
      CROSS JOIN LATERAL jsonb_array_elements_text(h.categories) held(category)
      CROSS JOIN LATERAL jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE h.tenant_id=NEW.tenant_id AND h.status='ACTIVE' AND held.category=requested.category
    ) THEN RAISE EXCEPTION 'active legal hold blocks erasure request' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.request_id,NEW.version,NEW.categories,NEW.export_transfer_id,NEW.export_transfer_version,
      NEW.export_bundle_digest,NEW.reason,NEW.requested_by_user_id,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.request_id,OLD.version,OLD.categories,OLD.export_transfer_id,OLD.export_transfer_version,
      OLD.export_bundle_digest,OLD.reason,OLD.requested_by_user_id,OLD.idempotency_key,OLD.request_hash,OLD.created_at) THEN
    RAISE EXCEPTION 'erasure request definition is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.row_version<>OLD.row_version+1 THEN
    RAISE EXCEPTION 'erasure lifecycle transitions must advance exactly one row version' USING ERRCODE='40001';
  END IF;
  IF OLD.status='REQUESTED' AND NEW.status IN ('APPROVED','REJECTED') THEN
    IF NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=OLD.requested_by_user_id
       OR NEW.reviewed_at IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000
       OR NEW.execution_started_by_user_id IS NOT NULL OR NEW.execution_started_at IS NOT NULL
       OR NEW.execution_completed_at IS NOT NULL OR NEW.execution_run_id IS NOT NULL
       OR NEW.execution_manifest_digest IS NOT NULL OR NEW.propagation_run_id IS NOT NULL
       OR NEW.propagation_manifest_digest IS NOT NULL OR NEW.propagation_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'erasure review requires distinct reviewer, reason and clean execution state' USING ERRCODE='55000';
    END IF;
    IF NEW.status='APPROVED' AND EXISTS (
      SELECT 1 FROM public.saas_tenant_data_legal_holds h
      CROSS JOIN LATERAL jsonb_array_elements_text(h.categories) held(category)
      CROSS JOIN LATERAL jsonb_array_elements_text(OLD.categories) requested(category)
      WHERE h.tenant_id=OLD.tenant_id AND h.status='ACTIVE' AND held.category=requested.category
    ) THEN RAISE EXCEPTION 'active legal hold blocks approval for one or more categories' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='APPROVED' AND NEW.status='EXECUTING' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason) IS DISTINCT FROM
       (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason)
       OR NEW.execution_started_by_user_id IS NULL
       OR NEW.execution_started_by_user_id IN (OLD.requested_by_user_id,OLD.reviewed_by_user_id)
       OR NEW.execution_started_at IS NULL OR NEW.execution_completed_at IS NOT NULL
       OR NEW.execution_run_id IS NOT NULL OR NEW.execution_manifest_digest IS NOT NULL
       OR NEW.propagation_run_id IS NOT NULL OR NEW.propagation_manifest_digest IS NOT NULL
       OR NEW.propagation_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'PostgreSQL erasure phase requires an independent executor and clean receipt state' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='EXECUTING' AND NEW.status='PROPAGATION_PENDING' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason,NEW.execution_started_by_user_id,NEW.execution_started_at)
       IS DISTINCT FROM
       (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason,OLD.execution_started_by_user_id,OLD.execution_started_at)
       OR NEW.execution_completed_at IS NULL OR NEW.execution_run_id IS NULL
       OR NEW.execution_manifest_digest !~ '^[a-f0-9]{64}$'
       OR NEW.propagation_run_id IS NOT NULL OR NEW.propagation_manifest_digest IS NOT NULL OR NEW.propagation_verified_at IS NOT NULL
       OR NOT EXISTS (
         SELECT 1 FROM public.saas_tenant_data_erasure_runs r
         WHERE r.tenant_id=NEW.tenant_id AND r.request_id=NEW.request_id
           AND r.request_version=NEW.version AND r.run_id=NEW.execution_run_id
           AND r.status='COMPLETED' AND r.manifest_digest=NEW.execution_manifest_digest
           AND r.receipt_scope='POSTGRESQL_ONLY'
       ) THEN
      RAISE EXCEPTION 'PROPAGATION_PENDING requires a matching PostgreSQL-only deletion receipt' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='PROPAGATION_PENDING' AND NEW.status='VERIFIED' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason,NEW.execution_started_by_user_id,
        NEW.execution_started_at,NEW.execution_completed_at,NEW.execution_run_id,NEW.execution_manifest_digest)
       IS DISTINCT FROM
       (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason,OLD.execution_started_by_user_id,
        OLD.execution_started_at,OLD.execution_completed_at,OLD.execution_run_id,OLD.execution_manifest_digest)
       OR NEW.propagation_run_id IS NULL OR NEW.propagation_manifest_digest !~ '^[a-f0-9]{64}$'
       OR NEW.propagation_verified_at IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM public.saas_tenant_external_propagation_runs r
         WHERE r.tenant_id=NEW.tenant_id AND r.request_id=NEW.request_id
           AND r.request_version=NEW.version AND r.run_id=NEW.propagation_run_id
           AND r.status='VERIFIED' AND r.manifest_digest=NEW.propagation_manifest_digest
           AND r.residual_copies=0 AND r.deleted_copies=r.planned_copies
       ) THEN
      RAISE EXCEPTION 'VERIFIED requires zero-residual external propagation receipt bound to this request' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid tenant erasure lifecycle transition: % -> %',OLD.status,NEW.status USING ERRCODE='40001';
END $$;

-- A separate finance-retention policy cannot be expressed as BUSINESS_DATA.
-- Policies are versioned, reviewed by a distinct actor, and the executor must
-- be independent. This ledger is intentionally not bound to the generic delete adapter.
CREATE TABLE IF NOT EXISTS saas_tenant_finance_retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  version bigint NOT NULL,
  retention_days integer NOT NULL,
  legal_basis varchar(200) NOT NULL,
  finance_adapter_key varchar(100) NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'PENDING',
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_reason varchar(1000),
  reason varchar(1000) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_finance_retention_version UNIQUE (tenant_id,version),
  CONSTRAINT uq_saas_finance_retention_key UNIQUE (tenant_id,idempotency_key),
  CONSTRAINT chk_saas_finance_retention_version CHECK (version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_saas_finance_retention_days CHECK (retention_days BETWEEN 1 AND 36500),
  CONSTRAINT chk_saas_finance_retention_adapter CHECK (finance_adapter_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  CONSTRAINT chk_saas_finance_retention_status CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  CONSTRAINT chk_saas_finance_retention_review CHECK (
    (status='PENDING' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
    OR (status IN ('APPROVED','REJECTED') AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id<>created_by_user_id AND reviewed_at IS NOT NULL
      AND length(btrim(review_reason)) BETWEEN 3 AND 1000)
  ),
  CONSTRAINT chk_saas_finance_retention_legal_basis CHECK (length(btrim(legal_basis)) BETWEEN 3 AND 200),
  CONSTRAINT chk_saas_finance_retention_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_finance_retention_key_format CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_finance_retention_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
ALTER TABLE saas_tenant_finance_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_finance_retention_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_finance_retention_policies_tenant_isolation ON saas_tenant_finance_retention_policies;
CREATE POLICY saas_tenant_finance_retention_policies_tenant_isolation
  ON saas_tenant_finance_retention_policies
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_finance_retention_policy()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE prior_version bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'finance retention policy evidence is immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT max(version) INTO prior_version FROM public.saas_tenant_finance_retention_policies WHERE tenant_id=NEW.tenant_id;
    IF NEW.version<>COALESCE(prior_version,0)+1 OR NEW.status<>'PENDING'
      OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_reason IS NOT NULL THEN
      RAISE EXCEPTION 'finance retention policy must use next version and independent review' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.version,NEW.retention_days,NEW.legal_basis,NEW.finance_adapter_key,
      NEW.created_by_user_id,NEW.reason,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.version,OLD.retention_days,OLD.legal_basis,OLD.finance_adapter_key,
      OLD.created_by_user_id,OLD.reason,OLD.idempotency_key,OLD.request_hash,OLD.created_at)
     OR OLD.status<>'PENDING' OR NEW.status NOT IN ('APPROVED','REJECTED')
     OR NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=OLD.created_by_user_id
     OR NEW.reviewed_at IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'finance retention review requires a distinct reviewer and immutable policy scope' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_finance_retention_policy_guard ON saas_tenant_finance_retention_policies;
CREATE TRIGGER saas_tenant_finance_retention_policy_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_finance_retention_policies
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_finance_retention_policy();

CREATE TABLE IF NOT EXISTS saas_tenant_finance_retention_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  policy_version bigint NOT NULL,
  mode varchar(12) NOT NULL,
  status varchar(12) NOT NULL,
  cutoff_at timestamptz NOT NULL,
  planned_rows bigint NOT NULL DEFAULT 0,
  deleted_rows bigint NOT NULL DEFAULT 0,
  residual_rows bigint NOT NULL DEFAULT 0,
  table_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest_digest varchar(64),
  adapter_receipt_reference varchar(200),
  failure_code varchar(64),
  reason varchar(1000) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  approved_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  executor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CONSTRAINT uq_saas_finance_retention_run UNIQUE (tenant_id,run_id),
  CONSTRAINT uq_saas_finance_retention_run_key UNIQUE (tenant_id,idempotency_key),
  CONSTRAINT fk_saas_finance_retention_run_policy FOREIGN KEY (tenant_id,policy_version)
    REFERENCES saas_tenant_finance_retention_policies(tenant_id,version) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_finance_retention_run_mode CHECK (mode IN ('DRY_RUN','EXECUTE')),
  CONSTRAINT chk_saas_finance_retention_run_status CHECK (status IN ('COMPLETED','BLOCKED','FAILED')),
  CONSTRAINT chk_saas_finance_retention_run_counts CHECK (
    planned_rows>=0 AND deleted_rows>=0 AND residual_rows>=0 AND deleted_rows<=planned_rows
  ),
  CONSTRAINT chk_saas_finance_retention_run_manifest CHECK (
    jsonb_typeof(table_manifest)='object'
    AND (manifest_digest IS NULL OR manifest_digest ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT chk_saas_finance_retention_run_result CHECK (
    (status='COMPLETED' AND manifest_digest IS NOT NULL AND residual_rows=0 AND failure_code IS NULL
      AND finished_at IS NOT NULL AND adapter_receipt_reference IS NOT NULL)
    OR (status='BLOCKED' AND failure_code IS NOT NULL AND finished_at IS NOT NULL)
    OR (status='FAILED' AND failure_code IS NOT NULL AND finished_at IS NOT NULL)
  ),
  CONSTRAINT chk_saas_finance_retention_run_actors CHECK (approved_by_user_id<>executor_user_id),
  CONSTRAINT chk_saas_finance_retention_run_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_finance_retention_run_key CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_finance_retention_run_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_finance_retention_runs_tenant
  ON saas_tenant_finance_retention_runs(tenant_id,created_at DESC);
ALTER TABLE saas_tenant_finance_retention_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_finance_retention_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_finance_retention_runs_tenant_isolation ON saas_tenant_finance_retention_runs;
CREATE POLICY saas_tenant_finance_retention_runs_tenant_isolation
  ON saas_tenant_finance_retention_runs
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE OR REPLACE FUNCTION factoryos_reject_saas_finance_retention_run_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'finance retention receipts are append-only' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS saas_tenant_finance_retention_run_immutable ON saas_tenant_finance_retention_runs;
CREATE TRIGGER saas_tenant_finance_retention_run_immutable
  BEFORE UPDATE OR DELETE ON saas_tenant_finance_retention_runs
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_saas_finance_retention_run_mutation();

-- These control-plane receipts/configuration are not generic tenant export data and
-- are not eligible for business-data erasure.
INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_external_data_targets','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Tenant-scoped provider target configuration and independent review evidence.'),
  ('public','saas_tenant_external_propagation_runs','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','External propagation lifecycle with exact copy-count, manifest and recovery evidence.'),
  ('public','saas_tenant_external_propagation_receipts','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable per-adapter deletion and residual-verification receipt.'),
  ('public','saas_tenant_finance_retention_policies','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Separately approved finance/usage ledger retention policy; not part of generic business erasure.'),
  ('public','saas_tenant_finance_retention_runs','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable result from the separately approved finance retention adapter.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,
  classified_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('160_saas_external_erasure_propagation_and_finance_retention',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;)
  )
);
ALTER TABLE saas_tenant_external_propagation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_receipts_tenant_isolation ON saas_tenant_external_propagation_receipts;
CREATE POLICY saas_tenant_external_propagation_receipts_tenant_isolation
  ON saas_tenant_external_propagation_receipts
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE OR REPLACE FUNCTION factoryos_reject_saas_external_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  RAISE EXCEPTION 'external provider receipts are append-only evidence' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_receipt_immutable ON saas_tenant_external_propagation_receipts;
CREATE TRIGGER saas_tenant_external_propagation_receipt_immutable
  BEFORE UPDATE OR DELETE ON saas_tenant_external_propagation_receipts
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_saas_external_receipt_mutation();

ALTER TABLE saas_tenant_data_erasure_requests
  ADD COLUMN IF NOT EXISTS propagation_run_id uuid,
  ADD COLUMN IF NOT EXISTS propagation_manifest_digest varchar(64),
  ADD COLUMN IF NOT EXISTS propagation_verified_at timestamptz;

ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS chk_saas_tenant_erasure_status;
ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS chk_saas_tenant_erasure_review;

-- Older releases used VERIFIED for PostgreSQL-only deletion. Demote those rows
-- before installing the stricter lifecycle constraints; preserve the SQL receipt
-- and increment row_version so that they cannot masquerade as whole-tenant erasure.
ALTER TABLE saas_tenant_data_erasure_requests DISABLE TRIGGER USER;
UPDATE saas_tenant_data_erasure_requests
SET status='PROPAGATION_PENDING',
    propagation_run_id=NULL,
    propagation_manifest_digest=NULL,
    propagation_verified_at=NULL,
    row_version=row_version+1,
    updated_at=clock_timestamp()
WHERE status='VERIFIED'
  AND propagation_run_id IS NULL
  AND propagation_manifest_digest IS NULL
  AND propagation_verified_at IS NULL
  AND execution_run_id IS NOT NULL
  AND execution_manifest_digest ~ '^[a-f0-9]{64}$';
ALTER TABLE saas_tenant_data_erasure_requests ENABLE TRIGGER USER;

ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT chk_saas_tenant_erasure_status CHECK (status IN (
    'REQUESTED','APPROVED','REJECTED','EXECUTING','PROPAGATION_PENDING','VERIFIED'
  ));
ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT chk_saas_tenant_erasure_review CHECK (
    (status='REQUESTED' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL
      AND execution_started_by_user_id IS NULL AND execution_started_at IS NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='REJECTED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NULL AND execution_started_at IS NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='APPROVED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NULL AND execution_started_at IS NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='EXECUTING' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NOT NULL AND execution_started_by_user_id<>requested_by_user_id
      AND execution_started_by_user_id<>reviewed_by_user_id AND execution_started_at IS NOT NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='PROPAGATION_PENDING' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NOT NULL AND execution_started_by_user_id<>requested_by_user_id
      AND execution_started_by_user_id<>reviewed_by_user_id AND execution_started_at IS NOT NULL
      AND execution_completed_at IS NOT NULL AND execution_run_id IS NOT NULL
      AND execution_manifest_digest ~ '^[a-f0-9]{64}$'
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='VERIFIED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NOT NULL AND execution_started_by_user_id<>requested_by_user_id
      AND execution_started_by_user_id<>reviewed_by_user_id AND execution_started_at IS NOT NULL
      AND execution_completed_at IS NOT NULL AND execution_run_id IS NOT NULL
      AND execution_manifest_digest ~ '^[a-f0-9]{64}$'
      AND propagation_run_id IS NOT NULL AND propagation_manifest_digest ~ '^[a-f0-9]{64}$'
      AND propagation_verified_at IS NOT NULL)
  );


ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS fk_saas_tenant_erasure_propagation_run;
ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT fk_saas_tenant_erasure_propagation_run
  FOREIGN KEY (tenant_id,request_id,version,propagation_run_id)
  REFERENCES saas_tenant_external_propagation_runs(tenant_id,request_id,request_version,run_id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION factoryos_guard_saas_tenant_data_erasure_request()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_transfer public.saas_tenant_data_transfers%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'tenant erasure request evidence is retained' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'REQUESTED' OR NEW.version<>1 OR NEW.row_version<>1
       OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_reason IS NOT NULL
       OR NEW.execution_started_by_user_id IS NOT NULL OR NEW.execution_started_at IS NOT NULL
       OR NEW.execution_completed_at IS NOT NULL OR NEW.execution_run_id IS NOT NULL
       OR NEW.execution_manifest_digest IS NOT NULL OR NEW.propagation_run_id IS NOT NULL
       OR NEW.propagation_manifest_digest IS NOT NULL OR NEW.propagation_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'erasure requests must start cleanly in REQUESTED version 1' USING ERRCODE='55000';
    END IF;
    SELECT * INTO source_transfer FROM public.saas_tenant_data_transfers t
    WHERE t.tenant_id=NEW.tenant_id AND t.transfer_id=NEW.export_transfer_id
      AND t.version=NEW.export_transfer_version AND t.operation_type='EXPORT'
      AND t.status='COMPLETED' AND t.source_bundle_digest=NEW.export_bundle_digest;
    IF NOT FOUND THEN RAISE EXCEPTION 'erasure request requires a completed preserved export for the same tenant' USING ERRCODE='55000'; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_transfer.required_categories) exported(category)
        WHERE exported.category=requested.category)
    ) THEN RAISE EXCEPTION 'requested erasure categories must be present in the preserved export' USING ERRCODE='55000'; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE requested.category NOT IN ('BUSINESS_DATA','EVIDENCE','AI_CONTEXT','LEARNING_EVALUATION')
    ) THEN RAISE EXCEPTION 'requested erasure category has no reviewed deletion adapter' USING ERRCODE='55000'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.saas_tenant_data_legal_holds h
      CROSS JOIN LATERAL jsonb_array_elements_text(h.categories) held(category)
      CROSS JOIN LATERAL jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE h.tenant_id=NEW.tenant_id AND h.status='ACTIVE' AND held.category=requested.category
    ) THEN RAISE EXCEPTION 'active legal hold blocks erasure request' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.request_id,NEW.version,NEW.categories,NEW.export_transfer_id,NEW.export_transfer_version,
      NEW.export_bundle_digest,NEW.reason,NEW.requested_by_user_id,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.request_id,OLD.version,OLD.categories,OLD.export_transfer_id,OLD.export_transfer_version,
      OLD.export_bundle_digest,OLD.reason,OLD.requested_by_user_id,OLD.idempotency_key,OLD.request_hash,OLD.created_at) THEN
    RAISE EXCEPTION 'erasure request definition is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.row_version<>OLD.row_version+1 THEN
    RAISE EXCEPTION 'erasure lifecycle transitions must advance exactly one row version' USING ERRCODE='40001';
  END IF;
  IF OLD.status='REQUESTED' AND NEW.status IN ('APPROVED','REJECTED') THEN
    IF NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=OLD.requested_by_user_id
       OR NEW.reviewed_at IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000
       OR NEW.execution_started_by_user_id IS NOT NULL OR NEW.execution_started_at IS NOT NULL
       OR NEW.execution_completed_at IS NOT NULL OR NEW.execution_run_id IS NOT NULL
       OR NEW.execution_manifest_digest IS NOT NULL OR NEW.propagation_run_id IS NOT NULL
       OR NEW.propagation_manifest_digest IS NOT NULL OR NEW.propagation_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'erasure review requires distinct reviewer, reason and clean execution state' USING ERRCODE='55000';
    END IF;
    IF NEW.status='APPROVED' AND EXISTS (
      SELECT 1 FROM public.saas_tenant_data_legal_holds h
      CROSS JOIN LATERAL jsonb_array_elements_text(h.categories) held(category)
      CROSS JOIN LATERAL jsonb_array_elements_text(OLD.categories) requested(category)
      WHERE h.tenant_id=OLD.tenant_id AND h.status='ACTIVE' AND held.category=requested.category
    ) THEN RAISE EXCEPTION 'active legal hold blocks approval for one or more categories' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='APPROVED' AND NEW.status='EXECUTING' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason) IS DISTINCT FROM
       (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason)
       OR NEW.execution_started_by_user_id IS NULL
       OR NEW.execution_started_by_user_id IN (OLD.requested_by_user_id,OLD.reviewed_by_user_id)
       OR NEW.execution_started_at IS NULL OR NEW.execution_completed_at IS NOT NULL
       OR NEW.execution_run_id IS NOT NULL OR NEW.execution_manifest_digest IS NOT NULL
       OR NEW.propagation_run_id IS NOT NULL OR NEW.propagation_manifest_digest IS NOT NULL
       OR NEW.propagation_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'PostgreSQL erasure phase requires an independent executor and clean receipt state' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='EXECUTING' AND NEW.status='PROPAGATION_PENDING' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason,NEW.execution_started_by_user_id,NEW.execution_started_at)
       IS DISTINCT FROM
       (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason,OLD.execution_started_by_user_id,OLD.execution_started_at)
       OR NEW.execution_completed_at IS NULL OR NEW.execution_run_id IS NULL
       OR NEW.execution_manifest_digest !~ '^[a-f0-9]{64}$'
       OR NEW.propagation_run_id IS NOT NULL OR NEW.propagation_manifest_digest IS NOT NULL OR NEW.propagation_verified_at IS NOT NULL
       OR NOT EXISTS (
         SELECT 1 FROM public.saas_tenant_data_erasure_runs r
         WHERE r.tenant_id=NEW.tenant_id AND r.request_id=NEW.request_id
           AND r.request_version=NEW.version AND r.run_id=NEW.execution_run_id
           AND r.status='COMPLETED' AND r.manifest_digest=NEW.execution_manifest_digest
           AND r.receipt_scope='POSTGRESQL_ONLY'
       ) THEN
      RAISE EXCEPTION 'PROPAGATION_PENDING requires a matching PostgreSQL-only deletion receipt' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='PROPAGATION_PENDING' AND NEW.status='VERIFIED' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason,NEW.execution_started_by_user_id,
        NEW.execution_started_at,NEW.execution_completed_at,NEW.execution_run_id,NEW.execution_manifest_digest)
       IS DISTINCT FROM
       (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason,OLD.execution_started_by_user_id,
        OLD.execution_started_at,OLD.execution_completed_at,OLD.execution_run_id,OLD.execution_manifest_digest)
       OR NEW.propagation_run_id IS NULL OR NEW.propagation_manifest_digest !~ '^[a-f0-9]{64}$'
       OR NEW.propagation_verified_at IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM public.saas_tenant_external_propagation_runs r
         WHERE r.tenant_id=NEW.tenant_id AND r.request_id=NEW.request_id
           AND r.request_version=NEW.version AND r.run_id=NEW.propagation_run_id
           AND r.status='VERIFIED' AND r.manifest_digest=NEW.propagation_manifest_digest
           AND r.residual_copies=0 AND r.deleted_copies=r.planned_copies
       ) THEN
      RAISE EXCEPTION 'VERIFIED requires zero-residual external propagation receipt bound to this request' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid tenant erasure lifecycle transition: % -> %',OLD.status,NEW.status USING ERRCODE='40001';
END $$;

-- A separate finance-retention policy cannot be expressed as BUSINESS_DATA.
-- Policies are versioned, reviewed by a distinct actor, and the executor must
-- be independent. This ledger is intentionally not bound to the generic delete adapter.
CREATE TABLE IF NOT EXISTS saas_tenant_finance_retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  version bigint NOT NULL,
  retention_days integer NOT NULL,
  legal_basis varchar(200) NOT NULL,
  finance_adapter_key varchar(100) NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'PENDING',
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_reason varchar(1000),
  reason varchar(1000) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_finance_retention_version UNIQUE (tenant_id,version),
  CONSTRAINT uq_saas_finance_retention_key UNIQUE (tenant_id,idempotency_key),
  CONSTRAINT chk_saas_finance_retention_version CHECK (version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_saas_finance_retention_days CHECK (retention_days BETWEEN 1 AND 36500),
  CONSTRAINT chk_saas_finance_retention_adapter CHECK (finance_adapter_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  CONSTRAINT chk_saas_finance_retention_status CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  CONSTRAINT chk_saas_finance_retention_review CHECK (
    (status='PENDING' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
    OR (status IN ('APPROVED','REJECTED') AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id<>created_by_user_id AND reviewed_at IS NOT NULL
      AND length(btrim(review_reason)) BETWEEN 3 AND 1000)
  ),
  CONSTRAINT chk_saas_finance_retention_legal_basis CHECK (length(btrim(legal_basis)) BETWEEN 3 AND 200),
  CONSTRAINT chk_saas_finance_retention_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_finance_retention_key_format CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_finance_retention_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
ALTER TABLE saas_tenant_finance_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_finance_retention_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_finance_retention_policies_tenant_isolation ON saas_tenant_finance_retention_policies;
CREATE POLICY saas_tenant_finance_retention_policies_tenant_isolation
  ON saas_tenant_finance_retention_policies
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_finance_retention_policy()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE prior_version bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'finance retention policy evidence is immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT max(version) INTO prior_version FROM public.saas_tenant_finance_retention_policies WHERE tenant_id=NEW.tenant_id;
    IF NEW.version<>COALESCE(prior_version,0)+1 OR NEW.status<>'PENDING'
      OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_reason IS NOT NULL THEN
      RAISE EXCEPTION 'finance retention policy must use next version and independent review' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.version,NEW.retention_days,NEW.legal_basis,NEW.finance_adapter_key,
      NEW.created_by_user_id,NEW.reason,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.version,OLD.retention_days,OLD.legal_basis,OLD.finance_adapter_key,
      OLD.created_by_user_id,OLD.reason,OLD.idempotency_key,OLD.request_hash,OLD.created_at)
     OR OLD.status<>'PENDING' OR NEW.status NOT IN ('APPROVED','REJECTED')
     OR NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=OLD.created_by_user_id
     OR NEW.reviewed_at IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'finance retention review requires a distinct reviewer and immutable policy scope' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_finance_retention_policy_guard ON saas_tenant_finance_retention_policies;
CREATE TRIGGER saas_tenant_finance_retention_policy_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_finance_retention_policies
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_finance_retention_policy();

CREATE TABLE IF NOT EXISTS saas_tenant_finance_retention_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  policy_version bigint NOT NULL,
  mode varchar(12) NOT NULL,
  status varchar(12) NOT NULL,
  cutoff_at timestamptz NOT NULL,
  planned_rows bigint NOT NULL DEFAULT 0,
  deleted_rows bigint NOT NULL DEFAULT 0,
  residual_rows bigint NOT NULL DEFAULT 0,
  table_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest_digest varchar(64),
  adapter_receipt_reference varchar(200),
  failure_code varchar(64),
  reason varchar(1000) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  approved_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  executor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CONSTRAINT uq_saas_finance_retention_run UNIQUE (tenant_id,run_id),
  CONSTRAINT uq_saas_finance_retention_run_key UNIQUE (tenant_id,idempotency_key),
  CONSTRAINT fk_saas_finance_retention_run_policy FOREIGN KEY (tenant_id,policy_version)
    REFERENCES saas_tenant_finance_retention_policies(tenant_id,version) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_finance_retention_run_mode CHECK (mode IN ('DRY_RUN','EXECUTE')),
  CONSTRAINT chk_saas_finance_retention_run_status CHECK (status IN ('COMPLETED','BLOCKED','FAILED')),
  CONSTRAINT chk_saas_finance_retention_run_counts CHECK (
    planned_rows>=0 AND deleted_rows>=0 AND residual_rows>=0 AND deleted_rows<=planned_rows
  ),
  CONSTRAINT chk_saas_finance_retention_run_manifest CHECK (
    jsonb_typeof(table_manifest)='object'
    AND (manifest_digest IS NULL OR manifest_digest ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT chk_saas_finance_retention_run_result CHECK (
    (status='COMPLETED' AND manifest_digest IS NOT NULL AND residual_rows=0 AND failure_code IS NULL
      AND finished_at IS NOT NULL AND adapter_receipt_reference IS NOT NULL)
    OR (status='BLOCKED' AND failure_code IS NOT NULL AND finished_at IS NOT NULL)
    OR (status='FAILED' AND failure_code IS NOT NULL AND finished_at IS NOT NULL)
  ),
  CONSTRAINT chk_saas_finance_retention_run_actors CHECK (approved_by_user_id<>executor_user_id),
  CONSTRAINT chk_saas_finance_retention_run_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_finance_retention_run_key CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_finance_retention_run_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_finance_retention_runs_tenant
  ON saas_tenant_finance_retention_runs(tenant_id,created_at DESC);
ALTER TABLE saas_tenant_finance_retention_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_finance_retention_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_finance_retention_runs_tenant_isolation ON saas_tenant_finance_retention_runs;
CREATE POLICY saas_tenant_finance_retention_runs_tenant_isolation
  ON saas_tenant_finance_retention_runs
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE OR REPLACE FUNCTION factoryos_reject_saas_finance_retention_run_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'finance retention receipts are append-only' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS saas_tenant_finance_retention_run_immutable ON saas_tenant_finance_retention_runs;
CREATE TRIGGER saas_tenant_finance_retention_run_immutable
  BEFORE UPDATE OR DELETE ON saas_tenant_finance_retention_runs
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_saas_finance_retention_run_mutation();

-- These control-plane receipts/configuration are not generic tenant export data and
-- are not eligible for business-data erasure.
INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_external_data_targets','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Tenant-scoped provider target configuration and independent review evidence.'),
  ('public','saas_tenant_external_propagation_runs','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','External propagation lifecycle with exact copy-count, manifest and recovery evidence.'),
  ('public','saas_tenant_external_propagation_receipts','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable per-adapter deletion and residual-verification receipt.'),
  ('public','saas_tenant_finance_retention_policies','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Separately approved finance/usage ledger retention policy; not part of generic business erasure.'),
  ('public','saas_tenant_finance_retention_runs','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable result from the separately approved finance retention adapter.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,
  classified_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('160_saas_external_erasure_propagation_and_finance_retention',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;)
  ),
  CONSTRAINT chk_saas_external_propagation_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_external_propagation_key CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_external_propagation_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_external_propagation_request
  ON saas_tenant_external_propagation_runs(tenant_id,request_id,created_at DESC);
ALTER TABLE saas_tenant_external_propagation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_runs_tenant_isolation ON saas_tenant_external_propagation_runs;
CREATE POLICY saas_tenant_external_propagation_runs_tenant_isolation
  ON saas_tenant_external_propagation_runs
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_external_propagation_run()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'external propagation run evidence is immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'RUNNING' OR NEW.manifest_digest IS NOT NULL OR NEW.finished_at IS NOT NULL
       OR NEW.verified_targets<>0 OR NEW.deleted_copies<>0 OR NEW.residual_copies<>0 THEN
      RAISE EXCEPTION 'external propagation runs must start in a clean RUNNING state' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.run_id,NEW.request_id,NEW.request_version,NEW.categories,
      NEW.source_export_digest,NEW.reason,NEW.idempotency_key,NEW.request_hash,
      NEW.executor_user_id,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.run_id,OLD.request_id,OLD.request_version,OLD.categories,
      OLD.source_export_digest,OLD.reason,OLD.idempotency_key,OLD.request_hash,
      OLD.executor_user_id,OLD.created_at) THEN
    RAISE EXCEPTION 'external propagation run identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='VERIFIED' OR NOT (
       OLD.status='RUNNING' AND NEW.status IN ('RUNNING','PARTIAL','FAILED','VERIFIED')
       OR OLD.status='PARTIAL' AND NEW.status IN ('RUNNING','FAILED','VERIFIED')
       OR OLD.status='FAILED' AND NEW.status='RUNNING'
     ) THEN
    RAISE EXCEPTION 'invalid external propagation state transition: % -> %',OLD.status,NEW.status USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_run_guard ON saas_tenant_external_propagation_runs;
CREATE TRIGGER saas_tenant_external_propagation_run_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_external_propagation_runs
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_external_propagation_run();

CREATE TABLE IF NOT EXISTS saas_tenant_external_propagation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  run_id uuid NOT NULL,
  target_id varchar(100) NOT NULL,
  store_kind varchar(32) NOT NULL,
  attempt_no integer NOT NULL,
  status varchar(12) NOT NULL,
  planned_copies bigint NOT NULL,
  deleted_copies bigint NOT NULL,
  residual_copies bigint NOT NULL,
  manifest_digest varchar(64) NOT NULL,
  verified_manifest_digest varchar(64),
  verification_reference varchar(200),
  residual_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_code varchar(64),
  provider_receipt_reference varchar(200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_saas_external_receipt_run FOREIGN KEY (tenant_id,request_id,run_id)
    REFERENCES saas_tenant_external_propagation_runs(tenant_id,request_id,run_id) ON DELETE RESTRICT,
  CONSTRAINT fk_saas_external_receipt_target FOREIGN KEY (tenant_id,target_id)
    REFERENCES saas_tenant_external_data_targets(tenant_id,target_id) ON DELETE RESTRICT,
  CONSTRAINT uq_saas_external_receipt_attempt UNIQUE (tenant_id,request_id,run_id,target_id,attempt_no),
  CONSTRAINT chk_saas_external_receipt_kind CHECK (store_kind IN (
    'OBJECT_STORAGE','CACHE','SEARCH_INDEX','VECTOR_STORE','LEARNING_ARTIFACT',
    'EXTERNAL_PROVIDER','REPLICA','BACKUP'
  )),
  CONSTRAINT chk_saas_external_receipt_attempt CHECK (attempt_no>=1),
  CONSTRAINT chk_saas_external_receipt_status CHECK (status IN ('VERIFIED','RESIDUALS','FAILED')),
  CONSTRAINT chk_saas_external_receipt_counts CHECK (
    planned_copies>=0 AND deleted_copies>=0 AND residual_copies>=0 AND deleted_copies<=planned_copies
  ),
  CONSTRAINT chk_saas_external_receipt_manifest CHECK (
    manifest_digest ~ '^[a-f0-9]{64}$'
    AND (verified_manifest_digest IS NULL OR verified_manifest_digest ~ '^[a-f0-9]{64}$')
    AND jsonb_typeof(residual_manifest)='array'
  ),
  CONSTRAINT chk_saas_external_receipt_verification CHECK (
    (status='VERIFIED' AND verified_manifest_digest IS NOT NULL AND verified_manifest_digest=manifest_digest AND residual_copies=0
      AND deleted_copies=planned_copies AND verification_reference IS NOT NULL
      AND failure_code IS NULL)
    OR (status='RESIDUALS' AND residual_copies>0 AND jsonb_array_length(residual_manifest)>0)
    OR (status='FAILED' AND failure_code IS NOT NULL AND failure_code ~ '^[A-Z0-9_]{1,64}
  )
);
ALTER TABLE saas_tenant_external_propagation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_external_propagation_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_external_propagation_receipts_tenant_isolation ON saas_tenant_external_propagation_receipts;
CREATE POLICY saas_tenant_external_propagation_receipts_tenant_isolation
  ON saas_tenant_external_propagation_receipts
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE OR REPLACE FUNCTION factoryos_reject_saas_external_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  RAISE EXCEPTION 'external provider receipts are append-only evidence' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS saas_tenant_external_propagation_receipt_immutable ON saas_tenant_external_propagation_receipts;
CREATE TRIGGER saas_tenant_external_propagation_receipt_immutable
  BEFORE UPDATE OR DELETE ON saas_tenant_external_propagation_receipts
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_saas_external_receipt_mutation();

ALTER TABLE saas_tenant_data_erasure_requests
  ADD COLUMN IF NOT EXISTS propagation_run_id uuid,
  ADD COLUMN IF NOT EXISTS propagation_manifest_digest varchar(64),
  ADD COLUMN IF NOT EXISTS propagation_verified_at timestamptz;

ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS chk_saas_tenant_erasure_status;
ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS chk_saas_tenant_erasure_review;

-- Older releases used VERIFIED for PostgreSQL-only deletion. Demote those rows
-- before installing the stricter lifecycle constraints; preserve the SQL receipt
-- and increment row_version so that they cannot masquerade as whole-tenant erasure.
ALTER TABLE saas_tenant_data_erasure_requests DISABLE TRIGGER USER;
UPDATE saas_tenant_data_erasure_requests
SET status='PROPAGATION_PENDING',
    propagation_run_id=NULL,
    propagation_manifest_digest=NULL,
    propagation_verified_at=NULL,
    row_version=row_version+1,
    updated_at=clock_timestamp()
WHERE status='VERIFIED'
  AND propagation_run_id IS NULL
  AND propagation_manifest_digest IS NULL
  AND propagation_verified_at IS NULL
  AND execution_run_id IS NOT NULL
  AND execution_manifest_digest ~ '^[a-f0-9]{64}$';
ALTER TABLE saas_tenant_data_erasure_requests ENABLE TRIGGER USER;

ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT chk_saas_tenant_erasure_status CHECK (status IN (
    'REQUESTED','APPROVED','REJECTED','EXECUTING','PROPAGATION_PENDING','VERIFIED'
  ));
ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT chk_saas_tenant_erasure_review CHECK (
    (status='REQUESTED' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL
      AND execution_started_by_user_id IS NULL AND execution_started_at IS NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='REJECTED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NULL AND execution_started_at IS NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='APPROVED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NULL AND execution_started_at IS NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='EXECUTING' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NOT NULL AND execution_started_by_user_id<>requested_by_user_id
      AND execution_started_by_user_id<>reviewed_by_user_id AND execution_started_at IS NOT NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='PROPAGATION_PENDING' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NOT NULL AND execution_started_by_user_id<>requested_by_user_id
      AND execution_started_by_user_id<>reviewed_by_user_id AND execution_started_at IS NOT NULL
      AND execution_completed_at IS NOT NULL AND execution_run_id IS NOT NULL
      AND execution_manifest_digest ~ '^[a-f0-9]{64}$'
      AND propagation_run_id IS NULL AND propagation_manifest_digest IS NULL AND propagation_verified_at IS NULL)
    OR
    (status='VERIFIED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NOT NULL AND execution_started_by_user_id<>requested_by_user_id
      AND execution_started_by_user_id<>reviewed_by_user_id AND execution_started_at IS NOT NULL
      AND execution_completed_at IS NOT NULL AND execution_run_id IS NOT NULL
      AND execution_manifest_digest ~ '^[a-f0-9]{64}$'
      AND propagation_run_id IS NOT NULL AND propagation_manifest_digest ~ '^[a-f0-9]{64}$'
      AND propagation_verified_at IS NOT NULL)
  );


ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS fk_saas_tenant_erasure_propagation_run;
ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT fk_saas_tenant_erasure_propagation_run
  FOREIGN KEY (tenant_id,request_id,version,propagation_run_id)
  REFERENCES saas_tenant_external_propagation_runs(tenant_id,request_id,request_version,run_id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION factoryos_guard_saas_tenant_data_erasure_request()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_transfer public.saas_tenant_data_transfers%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'tenant erasure request evidence is retained' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'REQUESTED' OR NEW.version<>1 OR NEW.row_version<>1
       OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_reason IS NOT NULL
       OR NEW.execution_started_by_user_id IS NOT NULL OR NEW.execution_started_at IS NOT NULL
       OR NEW.execution_completed_at IS NOT NULL OR NEW.execution_run_id IS NOT NULL
       OR NEW.execution_manifest_digest IS NOT NULL OR NEW.propagation_run_id IS NOT NULL
       OR NEW.propagation_manifest_digest IS NOT NULL OR NEW.propagation_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'erasure requests must start cleanly in REQUESTED version 1' USING ERRCODE='55000';
    END IF;
    SELECT * INTO source_transfer FROM public.saas_tenant_data_transfers t
    WHERE t.tenant_id=NEW.tenant_id AND t.transfer_id=NEW.export_transfer_id
      AND t.version=NEW.export_transfer_version AND t.operation_type='EXPORT'
      AND t.status='COMPLETED' AND t.source_bundle_digest=NEW.export_bundle_digest;
    IF NOT FOUND THEN RAISE EXCEPTION 'erasure request requires a completed preserved export for the same tenant' USING ERRCODE='55000'; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_transfer.required_categories) exported(category)
        WHERE exported.category=requested.category)
    ) THEN RAISE EXCEPTION 'requested erasure categories must be present in the preserved export' USING ERRCODE='55000'; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE requested.category NOT IN ('BUSINESS_DATA','EVIDENCE','AI_CONTEXT','LEARNING_EVALUATION')
    ) THEN RAISE EXCEPTION 'requested erasure category has no reviewed deletion adapter' USING ERRCODE='55000'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.saas_tenant_data_legal_holds h
      CROSS JOIN LATERAL jsonb_array_elements_text(h.categories) held(category)
      CROSS JOIN LATERAL jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE h.tenant_id=NEW.tenant_id AND h.status='ACTIVE' AND held.category=requested.category
    ) THEN RAISE EXCEPTION 'active legal hold blocks erasure request' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.request_id,NEW.version,NEW.categories,NEW.export_transfer_id,NEW.export_transfer_version,
      NEW.export_bundle_digest,NEW.reason,NEW.requested_by_user_id,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.request_id,OLD.version,OLD.categories,OLD.export_transfer_id,OLD.export_transfer_version,
      OLD.export_bundle_digest,OLD.reason,OLD.requested_by_user_id,OLD.idempotency_key,OLD.request_hash,OLD.created_at) THEN
    RAISE EXCEPTION 'erasure request definition is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.row_version<>OLD.row_version+1 THEN
    RAISE EXCEPTION 'erasure lifecycle transitions must advance exactly one row version' USING ERRCODE='40001';
  END IF;
  IF OLD.status='REQUESTED' AND NEW.status IN ('APPROVED','REJECTED') THEN
    IF NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=OLD.requested_by_user_id
       OR NEW.reviewed_at IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000
       OR NEW.execution_started_by_user_id IS NOT NULL OR NEW.execution_started_at IS NOT NULL
       OR NEW.execution_completed_at IS NOT NULL OR NEW.execution_run_id IS NOT NULL
       OR NEW.execution_manifest_digest IS NOT NULL OR NEW.propagation_run_id IS NOT NULL
       OR NEW.propagation_manifest_digest IS NOT NULL OR NEW.propagation_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'erasure review requires distinct reviewer, reason and clean execution state' USING ERRCODE='55000';
    END IF;
    IF NEW.status='APPROVED' AND EXISTS (
      SELECT 1 FROM public.saas_tenant_data_legal_holds h
      CROSS JOIN LATERAL jsonb_array_elements_text(h.categories) held(category)
      CROSS JOIN LATERAL jsonb_array_elements_text(OLD.categories) requested(category)
      WHERE h.tenant_id=OLD.tenant_id AND h.status='ACTIVE' AND held.category=requested.category
    ) THEN RAISE EXCEPTION 'active legal hold blocks approval for one or more categories' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='APPROVED' AND NEW.status='EXECUTING' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason) IS DISTINCT FROM
       (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason)
       OR NEW.execution_started_by_user_id IS NULL
       OR NEW.execution_started_by_user_id IN (OLD.requested_by_user_id,OLD.reviewed_by_user_id)
       OR NEW.execution_started_at IS NULL OR NEW.execution_completed_at IS NOT NULL
       OR NEW.execution_run_id IS NOT NULL OR NEW.execution_manifest_digest IS NOT NULL
       OR NEW.propagation_run_id IS NOT NULL OR NEW.propagation_manifest_digest IS NOT NULL
       OR NEW.propagation_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'PostgreSQL erasure phase requires an independent executor and clean receipt state' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='EXECUTING' AND NEW.status='PROPAGATION_PENDING' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason,NEW.execution_started_by_user_id,NEW.execution_started_at)
       IS DISTINCT FROM
       (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason,OLD.execution_started_by_user_id,OLD.execution_started_at)
       OR NEW.execution_completed_at IS NULL OR NEW.execution_run_id IS NULL
       OR NEW.execution_manifest_digest !~ '^[a-f0-9]{64}$'
       OR NEW.propagation_run_id IS NOT NULL OR NEW.propagation_manifest_digest IS NOT NULL OR NEW.propagation_verified_at IS NOT NULL
       OR NOT EXISTS (
         SELECT 1 FROM public.saas_tenant_data_erasure_runs r
         WHERE r.tenant_id=NEW.tenant_id AND r.request_id=NEW.request_id
           AND r.request_version=NEW.version AND r.run_id=NEW.execution_run_id
           AND r.status='COMPLETED' AND r.manifest_digest=NEW.execution_manifest_digest
           AND r.receipt_scope='POSTGRESQL_ONLY'
       ) THEN
      RAISE EXCEPTION 'PROPAGATION_PENDING requires a matching PostgreSQL-only deletion receipt' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='PROPAGATION_PENDING' AND NEW.status='VERIFIED' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason,NEW.execution_started_by_user_id,
        NEW.execution_started_at,NEW.execution_completed_at,NEW.execution_run_id,NEW.execution_manifest_digest)
       IS DISTINCT FROM
       (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason,OLD.execution_started_by_user_id,
        OLD.execution_started_at,OLD.execution_completed_at,OLD.execution_run_id,OLD.execution_manifest_digest)
       OR NEW.propagation_run_id IS NULL OR NEW.propagation_manifest_digest !~ '^[a-f0-9]{64}$'
       OR NEW.propagation_verified_at IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM public.saas_tenant_external_propagation_runs r
         WHERE r.tenant_id=NEW.tenant_id AND r.request_id=NEW.request_id
           AND r.request_version=NEW.version AND r.run_id=NEW.propagation_run_id
           AND r.status='VERIFIED' AND r.manifest_digest=NEW.propagation_manifest_digest
           AND r.residual_copies=0 AND r.deleted_copies=r.planned_copies
       ) THEN
      RAISE EXCEPTION 'VERIFIED requires zero-residual external propagation receipt bound to this request' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid tenant erasure lifecycle transition: % -> %',OLD.status,NEW.status USING ERRCODE='40001';
END $$;

-- A separate finance-retention policy cannot be expressed as BUSINESS_DATA.
-- Policies are versioned, reviewed by a distinct actor, and the executor must
-- be independent. This ledger is intentionally not bound to the generic delete adapter.
CREATE TABLE IF NOT EXISTS saas_tenant_finance_retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  version bigint NOT NULL,
  retention_days integer NOT NULL,
  legal_basis varchar(200) NOT NULL,
  finance_adapter_key varchar(100) NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'PENDING',
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_reason varchar(1000),
  reason varchar(1000) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_finance_retention_version UNIQUE (tenant_id,version),
  CONSTRAINT uq_saas_finance_retention_key UNIQUE (tenant_id,idempotency_key),
  CONSTRAINT chk_saas_finance_retention_version CHECK (version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_saas_finance_retention_days CHECK (retention_days BETWEEN 1 AND 36500),
  CONSTRAINT chk_saas_finance_retention_adapter CHECK (finance_adapter_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  CONSTRAINT chk_saas_finance_retention_status CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  CONSTRAINT chk_saas_finance_retention_review CHECK (
    (status='PENDING' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
    OR (status IN ('APPROVED','REJECTED') AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id<>created_by_user_id AND reviewed_at IS NOT NULL
      AND length(btrim(review_reason)) BETWEEN 3 AND 1000)
  ),
  CONSTRAINT chk_saas_finance_retention_legal_basis CHECK (length(btrim(legal_basis)) BETWEEN 3 AND 200),
  CONSTRAINT chk_saas_finance_retention_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_finance_retention_key_format CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_finance_retention_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
ALTER TABLE saas_tenant_finance_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_finance_retention_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_finance_retention_policies_tenant_isolation ON saas_tenant_finance_retention_policies;
CREATE POLICY saas_tenant_finance_retention_policies_tenant_isolation
  ON saas_tenant_finance_retention_policies
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_finance_retention_policy()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE prior_version bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'finance retention policy evidence is immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT max(version) INTO prior_version FROM public.saas_tenant_finance_retention_policies WHERE tenant_id=NEW.tenant_id;
    IF NEW.version<>COALESCE(prior_version,0)+1 OR NEW.status<>'PENDING'
      OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_reason IS NOT NULL THEN
      RAISE EXCEPTION 'finance retention policy must use next version and independent review' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.version,NEW.retention_days,NEW.legal_basis,NEW.finance_adapter_key,
      NEW.created_by_user_id,NEW.reason,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.version,OLD.retention_days,OLD.legal_basis,OLD.finance_adapter_key,
      OLD.created_by_user_id,OLD.reason,OLD.idempotency_key,OLD.request_hash,OLD.created_at)
     OR OLD.status<>'PENDING' OR NEW.status NOT IN ('APPROVED','REJECTED')
     OR NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=OLD.created_by_user_id
     OR NEW.reviewed_at IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'finance retention review requires a distinct reviewer and immutable policy scope' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_tenant_finance_retention_policy_guard ON saas_tenant_finance_retention_policies;
CREATE TRIGGER saas_tenant_finance_retention_policy_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_finance_retention_policies
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_finance_retention_policy();

CREATE TABLE IF NOT EXISTS saas_tenant_finance_retention_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  policy_version bigint NOT NULL,
  mode varchar(12) NOT NULL,
  status varchar(12) NOT NULL,
  cutoff_at timestamptz NOT NULL,
  planned_rows bigint NOT NULL DEFAULT 0,
  deleted_rows bigint NOT NULL DEFAULT 0,
  residual_rows bigint NOT NULL DEFAULT 0,
  table_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest_digest varchar(64),
  adapter_receipt_reference varchar(200),
  failure_code varchar(64),
  reason varchar(1000) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  approved_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  executor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CONSTRAINT uq_saas_finance_retention_run UNIQUE (tenant_id,run_id),
  CONSTRAINT uq_saas_finance_retention_run_key UNIQUE (tenant_id,idempotency_key),
  CONSTRAINT fk_saas_finance_retention_run_policy FOREIGN KEY (tenant_id,policy_version)
    REFERENCES saas_tenant_finance_retention_policies(tenant_id,version) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_finance_retention_run_mode CHECK (mode IN ('DRY_RUN','EXECUTE')),
  CONSTRAINT chk_saas_finance_retention_run_status CHECK (status IN ('COMPLETED','BLOCKED','FAILED')),
  CONSTRAINT chk_saas_finance_retention_run_counts CHECK (
    planned_rows>=0 AND deleted_rows>=0 AND residual_rows>=0 AND deleted_rows<=planned_rows
  ),
  CONSTRAINT chk_saas_finance_retention_run_manifest CHECK (
    jsonb_typeof(table_manifest)='object'
    AND (manifest_digest IS NULL OR manifest_digest ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT chk_saas_finance_retention_run_result CHECK (
    (status='COMPLETED' AND manifest_digest IS NOT NULL AND residual_rows=0 AND failure_code IS NULL
      AND finished_at IS NOT NULL AND adapter_receipt_reference IS NOT NULL)
    OR (status='BLOCKED' AND failure_code IS NOT NULL AND finished_at IS NOT NULL)
    OR (status='FAILED' AND failure_code IS NOT NULL AND finished_at IS NOT NULL)
  ),
  CONSTRAINT chk_saas_finance_retention_run_actors CHECK (approved_by_user_id<>executor_user_id),
  CONSTRAINT chk_saas_finance_retention_run_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_finance_retention_run_key CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_finance_retention_run_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_finance_retention_runs_tenant
  ON saas_tenant_finance_retention_runs(tenant_id,created_at DESC);
ALTER TABLE saas_tenant_finance_retention_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_finance_retention_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_finance_retention_runs_tenant_isolation ON saas_tenant_finance_retention_runs;
CREATE POLICY saas_tenant_finance_retention_runs_tenant_isolation
  ON saas_tenant_finance_retention_runs
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
CREATE OR REPLACE FUNCTION factoryos_reject_saas_finance_retention_run_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'finance retention receipts are append-only' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS saas_tenant_finance_retention_run_immutable ON saas_tenant_finance_retention_runs;
CREATE TRIGGER saas_tenant_finance_retention_run_immutable
  BEFORE UPDATE OR DELETE ON saas_tenant_finance_retention_runs
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_saas_finance_retention_run_mutation();

-- These control-plane receipts/configuration are not generic tenant export data and
-- are not eligible for business-data erasure.
INSERT INTO factoryos_governance.tenant_relation_inventory
  (schema_name,relation_name,scope_model,data_category,export_disposition,erasure_disposition,audit_requirement,rationale)
VALUES
  ('public','saas_tenant_external_data_targets','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Tenant-scoped provider target configuration and independent review evidence.'),
  ('public','saas_tenant_external_propagation_runs','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','External propagation lifecycle with exact copy-count, manifest and recovery evidence.'),
  ('public','saas_tenant_external_propagation_receipts','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable per-adapter deletion and residual-verification receipt.'),
  ('public','saas_tenant_finance_retention_policies','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Separately approved finance/usage ledger retention policy; not part of generic business erasure.'),
  ('public','saas_tenant_finance_retention_runs','DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED','PROTECTED','APPEND_ONLY_AUDIT','Immutable result from the separately approved finance retention adapter.')
ON CONFLICT(schema_name,relation_name) DO UPDATE SET
  scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
  export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
  audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,
  classified_at=clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES ('160_saas_external_erasure_propagation_and_finance_retention',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;