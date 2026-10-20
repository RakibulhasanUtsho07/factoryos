BEGIN;

-- Separate execute permission: a policy editor/reviewer is not implicitly a purge executor.
INSERT INTO permissions(code, description) VALUES
  ('saas.data_retention.execute', 'Execute bounded, tenant-scoped retention and approved erasure runs')
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code='ORG_ADMIN' AND r.is_system=true
  AND p.code='saas.data_retention.execute'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Audit and other regulated/control-plane categories are review-only. This
-- prevents an accidentally configured DELETE policy from purging the evidence
-- needed to explain a prior decision or security incident.
CREATE OR REPLACE FUNCTION factoryos_guard_saas_retention_policy_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE prior_version bigint;
BEGIN
  IF NEW.category_code IN ('AUDIT_LOG','APPROVALS','EFFECTIVE_DATED_MASTER_DATA','IAM_ACCESS')
     AND NEW.disposition <> 'REVIEW' THEN
    RAISE EXCEPTION 'protected retention category requires REVIEW disposition'
      USING ERRCODE = '55000';
  END IF;
  SELECT max(version) INTO prior_version
  FROM public.saas_tenant_data_retention_policies
  WHERE tenant_id=NEW.tenant_id AND category_code=NEW.category_code;
  IF prior_version IS NULL AND NEW.version <> 1 THEN
    RAISE EXCEPTION 'first retention policy version must be 1';
  END IF;
  IF prior_version IS NOT NULL AND NEW.version <> prior_version + 1 THEN
    RAISE EXCEPTION 'retention policy versions must be contiguous';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS saas_tenant_data_retention_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  category_code varchar(40) NOT NULL,
  policy_version bigint NOT NULL,
  mode varchar(12) NOT NULL,
  status varchar(12) NOT NULL,
  cutoff_at timestamptz NOT NULL,
  examined_rows bigint NOT NULL DEFAULT 0,
  eligible_rows bigint NOT NULL DEFAULT 0,
  affected_rows bigint NOT NULL DEFAULT 0,
  held_rows bigint NOT NULL DEFAULT 0,
  table_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest_digest varchar(64),
  reason varchar(1000) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  initiated_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_retention_run_scope UNIQUE (tenant_id, run_id),
  CONSTRAINT uq_saas_retention_run_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_saas_retention_run_policy FOREIGN KEY (tenant_id, category_code, policy_version)
    REFERENCES saas_tenant_data_retention_policies(tenant_id, category_code, version) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_retention_run_category CHECK (category_code IN (
    'BUSINESS_DATA','AUDIT_LOG','EVIDENCE','APPROVALS','EFFECTIVE_DATED_MASTER_DATA',
    'AI_CONTEXT','LEARNING_EVALUATION','INTEGRATION_METADATA','FILE_REFERENCES','IAM_ACCESS'
  )),
  CONSTRAINT chk_saas_retention_run_mode CHECK (mode IN ('DRY_RUN','EXECUTE')),
  CONSTRAINT chk_saas_retention_run_status CHECK (status IN ('COMPLETED','BLOCKED','FAILED')),
  CONSTRAINT chk_saas_retention_run_counts CHECK (
    examined_rows >= 0 AND eligible_rows >= 0 AND affected_rows >= 0 AND held_rows >= 0
    AND eligible_rows <= examined_rows AND affected_rows <= eligible_rows AND held_rows <= examined_rows
  ),
  CONSTRAINT chk_saas_retention_run_manifest CHECK (jsonb_typeof(table_manifest) = 'object'),
  CONSTRAINT chk_saas_retention_run_digest CHECK (manifest_digest IS NULL OR manifest_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_retention_run_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_retention_run_key CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_retention_run_hash CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_retention_run_manifest_status CHECK (
    (status='COMPLETED' AND manifest_digest IS NOT NULL)
    OR (status IN ('BLOCKED','FAILED'))
  )
);
CREATE INDEX IF NOT EXISTS idx_saas_retention_runs_tenant_created
  ON saas_tenant_data_retention_runs(tenant_id, created_at DESC);

ALTER TABLE saas_tenant_data_retention_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_data_retention_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_data_retention_runs_tenant_isolation ON saas_tenant_data_retention_runs;
CREATE POLICY saas_tenant_data_retention_runs_tenant_isolation
  ON saas_tenant_data_retention_runs
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
DROP TRIGGER IF EXISTS saas_tenant_data_retention_runs_immutable ON saas_tenant_data_retention_runs;
CREATE TRIGGER saas_tenant_data_retention_runs_immutable
  BEFORE UPDATE OR DELETE ON saas_tenant_data_retention_runs
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS chk_saas_tenant_erasure_status;
ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT chk_saas_tenant_erasure_status
    CHECK (status IN ('REQUESTED','APPROVED','REJECTED','EXECUTING','VERIFIED'));

ALTER TABLE saas_tenant_data_erasure_requests
  ADD COLUMN IF NOT EXISTS execution_started_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS execution_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_run_id uuid,
  ADD COLUMN IF NOT EXISTS execution_manifest_digest varchar(64);

ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS chk_saas_tenant_erasure_review;
ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT chk_saas_tenant_erasure_review CHECK (
    (status='REQUESTED' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL
      AND execution_started_by_user_id IS NULL AND execution_started_at IS NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL)
    OR
    (status='REJECTED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NULL AND execution_started_at IS NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL)
    OR
    (status='APPROVED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NULL AND execution_started_at IS NULL
      AND execution_completed_at IS NULL AND execution_run_id IS NULL AND execution_manifest_digest IS NULL)
    OR
    (status='EXECUTING' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NOT NULL
      AND execution_started_by_user_id<>requested_by_user_id
      AND execution_started_by_user_id<>reviewed_by_user_id
      AND execution_started_at IS NOT NULL AND execution_completed_at IS NULL
      AND execution_run_id IS NULL AND execution_manifest_digest IS NULL)
    OR
    (status='VERIFIED' AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>requested_by_user_id
      AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 3 AND 1000
      AND execution_started_by_user_id IS NOT NULL
      AND execution_started_by_user_id<>requested_by_user_id
      AND execution_started_by_user_id<>reviewed_by_user_id
      AND execution_started_at IS NOT NULL AND execution_completed_at IS NOT NULL
      AND execution_run_id IS NOT NULL AND execution_manifest_digest ~ '^[a-f0-9]{64}$')
  );

CREATE TABLE IF NOT EXISTS saas_tenant_data_erasure_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_version bigint NOT NULL,
  status varchar(12) NOT NULL,
  categories jsonb NOT NULL,
  deleted_rows bigint NOT NULL DEFAULT 0,
  table_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest_digest varchar(64),
  source_export_digest varchar(64) NOT NULL,
  executor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  failure_code varchar(64),
  reason varchar(1000) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_erasure_run_scoped_id UNIQUE (tenant_id, request_id, request_version, run_id),
  CONSTRAINT uq_saas_erasure_run_idempotency UNIQUE (tenant_id, request_id, idempotency_key),
  CONSTRAINT fk_saas_erasure_run_request FOREIGN KEY (tenant_id, request_id, request_version)
    REFERENCES saas_tenant_data_erasure_requests(tenant_id, request_id, version) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_erasure_run_status CHECK (status IN ('COMPLETED','FAILED')),
  CONSTRAINT chk_saas_erasure_run_counts CHECK (deleted_rows >= 0),
  CONSTRAINT chk_saas_erasure_run_categories CHECK (jsonb_typeof(categories)='array' AND jsonb_array_length(categories) BETWEEN 1 AND 10),
  CONSTRAINT chk_saas_erasure_run_manifest CHECK (jsonb_typeof(table_manifest)='object'),
  CONSTRAINT chk_saas_erasure_run_digest CHECK (manifest_digest IS NULL OR manifest_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_erasure_run_source_digest CHECK (source_export_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_erasure_run_failure CHECK (
    (status='COMPLETED' AND manifest_digest IS NOT NULL AND failure_code IS NULL)
    OR (status='FAILED' AND failure_code IS NOT NULL AND failure_code ~ '^[A-Z0-9_]{1,64}
  ),
  CONSTRAINT chk_saas_erasure_run_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_erasure_run_key CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_erasure_run_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_erasure_runs_tenant_request
  ON saas_tenant_data_erasure_runs(tenant_id, request_id, created_at DESC);

ALTER TABLE saas_tenant_data_erasure_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_data_erasure_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_data_erasure_runs_tenant_isolation ON saas_tenant_data_erasure_runs;
CREATE POLICY saas_tenant_data_erasure_runs_tenant_isolation
  ON saas_tenant_data_erasure_runs
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
DROP TRIGGER IF EXISTS saas_tenant_data_erasure_runs_immutable ON saas_tenant_data_erasure_runs;
CREATE TRIGGER saas_tenant_data_erasure_runs_immutable
  BEFORE UPDATE OR DELETE ON saas_tenant_data_erasure_runs
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS fk_saas_tenant_erasure_execution_run;
ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT fk_saas_tenant_erasure_execution_run
  FOREIGN KEY (tenant_id, request_id, version, execution_run_id)
  REFERENCES saas_tenant_data_erasure_runs(tenant_id, request_id, request_version, run_id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION factoryos_guard_saas_tenant_data_erasure_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
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
       OR NEW.execution_manifest_digest IS NOT NULL THEN
      RAISE EXCEPTION 'erasure requests must start cleanly in REQUESTED version 1' USING ERRCODE='55000';
    END IF;
    SELECT * INTO source_transfer FROM public.saas_tenant_data_transfers t
    WHERE t.tenant_id=NEW.tenant_id AND t.transfer_id=NEW.export_transfer_id
      AND t.version=NEW.export_transfer_version AND t.operation_type='EXPORT'
      AND t.status='COMPLETED' AND t.preservation_verified=true
      AND t.source_bundle_digest=NEW.export_bundle_digest;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'erasure request requires a completed preserved export for the same tenant' USING ERRCODE='55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(source_transfer.required_categories) exported(category)
        WHERE exported.category=requested.category
      )
    ) THEN
      RAISE EXCEPTION 'requested erasure categories must be present in the preserved export' USING ERRCODE='55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE requested.category NOT IN ('BUSINESS_DATA','EVIDENCE','AI_CONTEXT','LEARNING_EVALUATION')
    ) THEN
      RAISE EXCEPTION 'requested erasure category has no reviewed deletion adapter' USING ERRCODE='55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.saas_tenant_data_legal_holds h
      CROSS JOIN LATERAL jsonb_array_elements_text(h.categories) held(category)
      CROSS JOIN LATERAL jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE h.tenant_id=NEW.tenant_id AND h.status='ACTIVE' AND held.category=requested.category
    ) THEN
      RAISE EXCEPTION 'active legal hold blocks erasure request' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.request_id,NEW.version,NEW.categories,NEW.export_transfer_id,
      NEW.export_transfer_version,NEW.export_bundle_digest,NEW.reason,NEW.requested_by_user_id,
      NEW.idempotency_key,NEW.request_hash,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.request_id,OLD.version,OLD.categories,OLD.export_transfer_id,
      OLD.export_transfer_version,OLD.export_bundle_digest,OLD.reason,OLD.requested_by_user_id,
      OLD.idempotency_key,OLD.request_hash,OLD.created_at) THEN
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
       OR NEW.execution_manifest_digest IS NOT NULL THEN
      RAISE EXCEPTION 'erasure review requires a distinct reviewer, reason and clean execution state' USING ERRCODE='55000';
    END IF;
    IF NEW.status='APPROVED' AND EXISTS (
      SELECT 1 FROM public.saas_tenant_data_legal_holds h
      CROSS JOIN LATERAL jsonb_array_elements_text(h.categories) held(category)
      CROSS JOIN LATERAL jsonb_array_elements_text(OLD.categories) requested(category)
      WHERE h.tenant_id=OLD.tenant_id AND h.status='ACTIVE' AND held.category=requested.category
    ) THEN
      RAISE EXCEPTION 'active legal hold blocks approval for one or more categories' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='APPROVED' AND NEW.status='EXECUTING' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason)
       IS DISTINCT FROM (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason)
       OR NEW.execution_started_by_user_id IS NULL
       OR NEW.execution_started_by_user_id IN (OLD.requested_by_user_id,OLD.reviewed_by_user_id)
       OR NEW.execution_started_at IS NULL OR NEW.execution_completed_at IS NOT NULL
       OR NEW.execution_run_id IS NOT NULL OR NEW.execution_manifest_digest IS NOT NULL THEN
      RAISE EXCEPTION 'erasure execution requires an independent executor and clean execution receipt' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='EXECUTING' AND NEW.status='VERIFIED' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason,NEW.execution_started_by_user_id,NEW.execution_started_at)
       IS DISTINCT FROM
       (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason,OLD.execution_started_by_user_id,OLD.execution_started_at)
       OR NEW.execution_completed_at IS NULL OR NEW.execution_run_id IS NULL
       OR NEW.execution_manifest_digest !~ '^[a-f0-9]{64}$'
       OR NOT EXISTS (
         SELECT 1 FROM public.saas_tenant_data_erasure_runs r
         WHERE r.tenant_id=NEW.tenant_id AND r.request_id=NEW.request_id
           AND r.request_version=NEW.version AND r.run_id=NEW.execution_run_id
           AND r.status='COMPLETED' AND r.manifest_digest=NEW.execution_manifest_digest
       ) THEN
      RAISE EXCEPTION 'verified erasure requires a matching completed run manifest' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid tenant erasure lifecycle transition: % -> %', OLD.status, NEW.status
    USING ERRCODE='40001';
END;
$$;

INSERT INTO schema_migrations(version, checksum)
VALUES ('155_saas_retention_execution_and_erasure_receipts', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
)
  ),
  CONSTRAINT chk_saas_erasure_run_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_erasure_run_key CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_erasure_run_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_erasure_runs_tenant_request
  ON saas_tenant_data_erasure_runs(tenant_id, request_id, created_at DESC);

ALTER TABLE saas_tenant_data_erasure_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_data_erasure_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_tenant_data_erasure_runs_tenant_isolation ON saas_tenant_data_erasure_runs;
CREATE POLICY saas_tenant_data_erasure_runs_tenant_isolation
  ON saas_tenant_data_erasure_runs
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());
DROP TRIGGER IF EXISTS saas_tenant_data_erasure_runs_immutable ON saas_tenant_data_erasure_runs;
CREATE TRIGGER saas_tenant_data_erasure_runs_immutable
  BEFORE UPDATE OR DELETE ON saas_tenant_data_erasure_runs
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

ALTER TABLE saas_tenant_data_erasure_requests
  DROP CONSTRAINT IF EXISTS fk_saas_tenant_erasure_execution_run;
ALTER TABLE saas_tenant_data_erasure_requests
  ADD CONSTRAINT fk_saas_tenant_erasure_execution_run
  FOREIGN KEY (tenant_id, request_id, version, execution_run_id)
  REFERENCES saas_tenant_data_erasure_runs(tenant_id, request_id, request_version, run_id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION factoryos_guard_saas_tenant_data_erasure_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
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
       OR NEW.execution_manifest_digest IS NOT NULL THEN
      RAISE EXCEPTION 'erasure requests must start cleanly in REQUESTED version 1' USING ERRCODE='55000';
    END IF;
    SELECT * INTO source_transfer FROM public.saas_tenant_data_transfers t
    WHERE t.tenant_id=NEW.tenant_id AND t.transfer_id=NEW.export_transfer_id
      AND t.version=NEW.export_transfer_version AND t.operation_type='EXPORT'
      AND t.status='COMPLETED' AND t.preservation_verified=true
      AND t.source_bundle_digest=NEW.export_bundle_digest;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'erasure request requires a completed preserved export for the same tenant' USING ERRCODE='55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(source_transfer.required_categories) exported(category)
        WHERE exported.category=requested.category
      )
    ) THEN
      RAISE EXCEPTION 'requested erasure categories must be present in the preserved export' USING ERRCODE='55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE requested.category NOT IN ('BUSINESS_DATA','EVIDENCE','AI_CONTEXT','LEARNING_EVALUATION')
    ) THEN
      RAISE EXCEPTION 'requested erasure category has no reviewed deletion adapter' USING ERRCODE='55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.saas_tenant_data_legal_holds h
      CROSS JOIN LATERAL jsonb_array_elements_text(h.categories) held(category)
      CROSS JOIN LATERAL jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE h.tenant_id=NEW.tenant_id AND h.status='ACTIVE' AND held.category=requested.category
    ) THEN
      RAISE EXCEPTION 'active legal hold blocks erasure request' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.request_id,NEW.version,NEW.categories,NEW.export_transfer_id,
      NEW.export_transfer_version,NEW.export_bundle_digest,NEW.reason,NEW.requested_by_user_id,
      NEW.idempotency_key,NEW.request_hash,NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.request_id,OLD.version,OLD.categories,OLD.export_transfer_id,
      OLD.export_transfer_version,OLD.export_bundle_digest,OLD.reason,OLD.requested_by_user_id,
      OLD.idempotency_key,OLD.request_hash,OLD.created_at) THEN
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
       OR NEW.execution_manifest_digest IS NOT NULL THEN
      RAISE EXCEPTION 'erasure review requires a distinct reviewer, reason and clean execution state' USING ERRCODE='55000';
    END IF;
    IF NEW.status='APPROVED' AND EXISTS (
      SELECT 1 FROM public.saas_tenant_data_legal_holds h
      CROSS JOIN LATERAL jsonb_array_elements_text(h.categories) held(category)
      CROSS JOIN LATERAL jsonb_array_elements_text(OLD.categories) requested(category)
      WHERE h.tenant_id=OLD.tenant_id AND h.status='ACTIVE' AND held.category=requested.category
    ) THEN
      RAISE EXCEPTION 'active legal hold blocks approval for one or more categories' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='APPROVED' AND NEW.status='EXECUTING' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason)
       IS DISTINCT FROM (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason)
       OR NEW.execution_started_by_user_id IS NULL
       OR NEW.execution_started_by_user_id IN (OLD.requested_by_user_id,OLD.reviewed_by_user_id)
       OR NEW.execution_started_at IS NULL OR NEW.execution_completed_at IS NOT NULL
       OR NEW.execution_run_id IS NOT NULL OR NEW.execution_manifest_digest IS NOT NULL THEN
      RAISE EXCEPTION 'erasure execution requires an independent executor and clean execution receipt' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='EXECUTING' AND NEW.status='VERIFIED' THEN
    IF (NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.review_reason,NEW.execution_started_by_user_id,NEW.execution_started_at)
       IS DISTINCT FROM
       (OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.review_reason,OLD.execution_started_by_user_id,OLD.execution_started_at)
       OR NEW.execution_completed_at IS NULL OR NEW.execution_run_id IS NULL
       OR NEW.execution_manifest_digest !~ '^[a-f0-9]{64}$'
       OR NOT EXISTS (
         SELECT 1 FROM public.saas_tenant_data_erasure_runs r
         WHERE r.tenant_id=NEW.tenant_id AND r.request_id=NEW.request_id
           AND r.request_version=NEW.version AND r.run_id=NEW.execution_run_id
           AND r.status='COMPLETED' AND r.manifest_digest=NEW.execution_manifest_digest
       ) THEN
      RAISE EXCEPTION 'verified erasure requires a matching completed run manifest' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid tenant erasure lifecycle transition: % -> %', OLD.status, NEW.status
    USING ERRCODE='40001';
END;
$$;

INSERT INTO schema_migrations(version, checksum)
VALUES ('155_saas_retention_execution_and_erasure_receipts', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
