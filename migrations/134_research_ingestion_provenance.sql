BEGIN;

-- WP08 / Phase D: source-rights revision history and resumable ingestion/extraction lineage.
ALTER TABLE research_sources
  ADD COLUMN IF NOT EXISTS source_revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS rights_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE research_sources
  ADD CONSTRAINT chk_research_source_revision_positive CHECK (source_revision >= 1),
  ADD CONSTRAINT chk_research_source_rights_version_positive CHECK (rights_version >= 1);

CREATE TABLE research_ingestion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  namespace VARCHAR(20) NOT NULL DEFAULT 'TENANT',
  source_id UUID NOT NULL,
  mode VARCHAR(20) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'QUEUED',
  stage VARCHAR(30) NOT NULL DEFAULT 'QUEUED',
  progress_percent SMALLINT NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  version INTEGER NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  source_revision INTEGER NOT NULL,
  rights_version INTEGER NOT NULL,
  rights_fingerprint CHAR(64) NOT NULL,
  rights_snapshot JSONB NOT NULL,
  source_snapshot JSONB NOT NULL,
  resume_checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_error_code VARCHAR(100),
  last_error_message VARCHAR(1000),
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  correlation_id UUID,
  created_by UUID NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_research_ingestion_job_scope UNIQUE (id, tenant_id),
  CONSTRAINT uq_research_ingestion_idempotency UNIQUE (tenant_id, source_id, idempotency_key),
  CONSTRAINT fk_research_ingestion_source_scope
    FOREIGN KEY (source_id, tenant_id, namespace)
    REFERENCES research_sources (id, tenant_id, namespace) ON DELETE RESTRICT,
  CONSTRAINT fk_research_ingestion_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_ingestion_lease_owner FOREIGN KEY (lease_owner) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_ingestion_namespace CHECK (namespace = 'TENANT'),
  CONSTRAINT chk_research_ingestion_mode CHECK (mode IN ('METADATA_ONLY', 'FULL_TEXT')),
  CONSTRAINT chk_research_ingestion_status CHECK (status IN (
    'QUEUED','RUNNING','PAUSED','SUCCEEDED','FAILED','CANCELLED',
    'BLOCKED_RIGHTS','BLOCKED_SOURCE_CHANGED'
  )),
  CONSTRAINT chk_research_ingestion_stage CHECK (stage IN (
    'QUEUED','RIGHTS_CHECK','FETCH_METADATA','FETCH_CONTENT','NORMALIZE',
    'SAFETY_SCAN','EXTRACT_CLAIMS','VALIDATE','COMMIT','COMPLETE'
  )),
  CONSTRAINT chk_research_ingestion_progress CHECK (progress_percent BETWEEN 0 AND 100),
  CONSTRAINT chk_research_ingestion_attempts CHECK (
    attempt_count >= 0 AND max_attempts BETWEEN 1 AND 10 AND attempt_count <= max_attempts
  ),
  CONSTRAINT chk_research_ingestion_version CHECK (version >= 1),
  CONSTRAINT chk_research_ingestion_hashes CHECK (
    request_hash ~ '^[a-f0-9]{64}$' AND rights_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_research_ingestion_snapshots CHECK (
    jsonb_typeof(rights_snapshot) = 'object'
    AND jsonb_typeof(source_snapshot) = 'object'
    AND jsonb_typeof(resume_checkpoint) = 'object'
  ),
  CONSTRAINT chk_research_ingestion_success_complete CHECK (
    status <> 'SUCCEEDED' OR (progress_percent = 100 AND stage = 'COMPLETE' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT chk_research_ingestion_lease CHECK (
    (status = 'RUNNING' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'RUNNING' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX idx_research_ingestion_queue
  ON research_ingestion_jobs (tenant_id, status, available_at, created_at)
  WHERE status IN ('QUEUED','PAUSED','RUNNING');
CREATE INDEX idx_research_ingestion_source
  ON research_ingestion_jobs (tenant_id, source_id, created_at DESC);
CREATE INDEX idx_research_ingestion_lease
  ON research_ingestion_jobs (status, lease_expires_at)
  WHERE status = 'RUNNING';

CREATE TABLE research_ingestion_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  job_id UUID NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  from_status VARCHAR(30),
  to_status VARCHAR(30),
  stage VARCHAR(30) NOT NULL,
  progress_percent SMALLINT NOT NULL,
  checkpoint_digest CHAR(64),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_research_ingestion_event_job
    FOREIGN KEY (job_id, tenant_id) REFERENCES research_ingestion_jobs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_ingestion_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_ingestion_event_detail CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT chk_research_ingestion_event_progress CHECK (progress_percent BETWEEN 0 AND 100),
  CONSTRAINT chk_research_ingestion_event_digest CHECK (
    checkpoint_digest IS NULL OR checkpoint_digest ~ '^[a-f0-9]{64}$'
  )
);
CREATE INDEX idx_research_ingestion_events_timeline
  ON research_ingestion_events (tenant_id, job_id, created_at, id);

CREATE TABLE research_extraction_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  job_id UUID NOT NULL,
  source_id UUID NOT NULL,
  extractor_name VARCHAR(160) NOT NULL,
  extractor_version VARCHAR(100) NOT NULL,
  schema_version VARCHAR(100) NOT NULL,
  model_provider VARCHAR(120),
  model_id VARCHAR(200),
  model_version VARCHAR(100),
  prompt_sha256 CHAR(64),
  config_sha256 CHAR(64),
  input_sha256 CHAR(64) NOT NULL,
  output_sha256 CHAR(64) NOT NULL,
  source_revision INTEGER NOT NULL,
  rights_version INTEGER NOT NULL,
  rights_fingerprint CHAR(64) NOT NULL,
  source_snapshot JSONB NOT NULL,
  rights_snapshot JSONB NOT NULL,
  safety_result VARCHAR(20) NOT NULL,
  safety_findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  claim_count INTEGER NOT NULL,
  untrusted_input BOOLEAN NOT NULL DEFAULT TRUE,
  full_text_persisted BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_research_extraction_job UNIQUE (job_id),
  CONSTRAINT uq_research_extraction_scope UNIQUE (id, tenant_id),
  CONSTRAINT fk_research_extraction_job
    FOREIGN KEY (job_id, tenant_id) REFERENCES research_ingestion_jobs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_extraction_source
    FOREIGN KEY (source_id, tenant_id) REFERENCES research_sources(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_extraction_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_extraction_hashes CHECK (
    input_sha256 ~ '^[a-f0-9]{64}$'
    AND output_sha256 ~ '^[a-f0-9]{64}$'
    AND rights_fingerprint ~ '^[a-f0-9]{64}$'
    AND (prompt_sha256 IS NULL OR prompt_sha256 ~ '^[a-f0-9]{64}$')
    AND (config_sha256 IS NULL OR config_sha256 ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT chk_research_extraction_snapshot CHECK (
    jsonb_typeof(source_snapshot) = 'object'
    AND jsonb_typeof(rights_snapshot) = 'object'
    AND jsonb_typeof(safety_findings) = 'array'
  ),
  CONSTRAINT chk_research_extraction_safety CHECK (safety_result IN ('PASS','REVIEW_REQUIRED')),
  CONSTRAINT chk_research_extraction_claim_count CHECK (claim_count BETWEEN 1 AND 100),
  CONSTRAINT chk_research_extraction_source_versions CHECK (source_revision >= 1 AND rights_version >= 1)
);
CREATE INDEX idx_research_extraction_source
  ON research_extraction_runs (tenant_id, source_id, created_at DESC);

CREATE TABLE research_extraction_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  extraction_run_id UUID NOT NULL,
  item_key VARCHAR(160) NOT NULL,
  source_locator JSONB NOT NULL,
  claim_text_sha256 CHAR(64) NOT NULL,
  excerpt_sha256 CHAR(64),
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  review_status VARCHAR(24) NOT NULL DEFAULT 'PROPOSED',
  claim_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_research_extraction_item_key UNIQUE (extraction_run_id, item_key),
  CONSTRAINT uq_research_extraction_item_scope UNIQUE (id, tenant_id),
  CONSTRAINT fk_research_extraction_item_run
    FOREIGN KEY (extraction_run_id, tenant_id) REFERENCES research_extraction_runs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_extraction_item_locator CHECK (
    jsonb_typeof(source_locator) = 'object' AND source_locator <> '{}'::jsonb
  ),
  CONSTRAINT chk_research_extraction_item_hashes CHECK (
    claim_text_sha256 ~ '^[a-f0-9]{64}$'
    AND (excerpt_sha256 IS NULL OR excerpt_sha256 ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT chk_research_extraction_item_flags CHECK (jsonb_typeof(safety_flags) = 'array'),
  CONSTRAINT chk_research_extraction_item_review CHECK (
    review_status IN ('PROPOSED','REVIEW_REQUIRED','REJECTED')
  )
);
CREATE INDEX idx_research_extraction_items_review
  ON research_extraction_items (tenant_id, review_status, created_at DESC);

ALTER TABLE research_claims
  ADD COLUMN extraction_item_id UUID,
  ADD CONSTRAINT fk_research_claim_extraction_item
    FOREIGN KEY (extraction_item_id, tenant_id)
    REFERENCES research_extraction_items(id, tenant_id) ON DELETE RESTRICT;
ALTER TABLE research_extraction_items
  ADD CONSTRAINT fk_research_extraction_item_claim
    FOREIGN KEY (claim_id) REFERENCES research_claims(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX uq_research_claim_extraction_item
  ON research_claims (extraction_item_id) WHERE extraction_item_id IS NOT NULL;
CREATE UNIQUE INDEX uq_research_extraction_item_claim
  ON research_extraction_items (claim_id) WHERE claim_id IS NOT NULL;

CREATE TABLE research_source_rights_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  source_id UUID NOT NULL,
  source_revision INTEGER NOT NULL,
  rights_version INTEGER NOT NULL,
  action VARCHAR(32) NOT NULL,
  rights_snapshot JSONB NOT NULL,
  source_snapshot JSONB NOT NULL,
  actor_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_research_source_rights_history_source
    FOREIGN KEY (source_id, tenant_id) REFERENCES research_sources(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_source_rights_history_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_source_rights_history_action CHECK (
    action IN ('REGISTERED','RIGHTS_CHANGED','SOURCE_CHANGED','ACCESS_REVIEWED','ACCESS_REVOKED')
  ),
  CONSTRAINT chk_research_source_rights_history_snapshots CHECK (
    jsonb_typeof(rights_snapshot) = 'object' AND jsonb_typeof(source_snapshot) = 'object'
  )
);
CREATE INDEX idx_research_source_rights_history
  ON research_source_rights_history (tenant_id, source_id, created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_research_source_revision_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.license_status, NEW.access_status, NEW.rights_basis, NEW.license_reference,
         NEW.full_text_storage_allowed, NEW.source_type)
     IS DISTINCT FROM
     ROW(OLD.license_status, OLD.access_status, OLD.rights_basis, OLD.license_reference,
         OLD.full_text_storage_allowed, OLD.source_type) THEN
    NEW.rights_version := OLD.rights_version + 1;
  ELSE
    NEW.rights_version := OLD.rights_version;
  END IF;

  IF ROW(NEW.title, NEW.authors, NEW.publication_date, NEW.doi, NEW.venue, NEW.abstract,
         NEW.source_url, NEW.source_metadata)
     IS DISTINCT FROM
     ROW(OLD.title, OLD.authors, OLD.publication_date, OLD.doi, OLD.venue, OLD.abstract,
         OLD.source_url, OLD.source_metadata) THEN
    NEW.source_revision := OLD.source_revision + 1;
  ELSE
    NEW.source_revision := OLD.source_revision;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER research_source_revision_guard
BEFORE UPDATE ON research_sources
FOR EACH ROW EXECUTE FUNCTION factoryos_research_source_revision_guard();

CREATE OR REPLACE FUNCTION factoryos_research_record_source_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  action_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    action_name := 'REGISTERED';
  ELSIF NEW.access_status = 'REVOKED' AND OLD.access_status IS DISTINCT FROM NEW.access_status THEN
    action_name := 'ACCESS_REVOKED';
  ELSIF OLD.rights_version IS DISTINCT FROM NEW.rights_version THEN
    action_name := 'RIGHTS_CHANGED';
  ELSIF OLD.source_revision IS DISTINCT FROM NEW.source_revision THEN
    action_name := 'SOURCE_CHANGED';
  ELSIF OLD.access_status IS DISTINCT FROM NEW.access_status
     OR OLD.reviewed_by IS DISTINCT FROM NEW.reviewed_by
     OR OLD.review_reason IS DISTINCT FROM NEW.review_reason THEN
    action_name := 'ACCESS_REVIEWED';
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO research_source_rights_history (
    tenant_id, source_id, source_revision, rights_version, action,
    rights_snapshot, source_snapshot, actor_user_id
  ) VALUES (
    NEW.tenant_id, NEW.id, NEW.source_revision, NEW.rights_version, action_name,
    jsonb_build_object(
      'licenseStatus', NEW.license_status,
      'accessStatus', NEW.access_status,
      'rightsBasis', NEW.rights_basis,
      'licenseReference', NEW.license_reference,
      'fullTextStorageAllowed', NEW.full_text_storage_allowed,
      'reviewedBy', NEW.reviewed_by,
      'reviewedAt', NEW.reviewed_at,
      'reviewReason', NEW.review_reason
    ),
    jsonb_build_object(
      'namespace', NEW.namespace, 'sourceType', NEW.source_type, 'title', NEW.title,
      'doi', NEW.doi, 'sourceUrl', NEW.source_url, 'publicationDate', NEW.publication_date,
      'venue', NEW.venue, 'sourceMetadata', NEW.source_metadata
    ),
    COALESCE(NEW.reviewed_by, NEW.created_by)
  );

  IF TG_OP = 'UPDATE'
     AND (OLD.rights_version IS DISTINCT FROM NEW.rights_version
          OR OLD.source_revision IS DISTINCT FROM NEW.source_revision
          OR OLD.access_status IS DISTINCT FROM NEW.access_status) THEN
    UPDATE research_ingestion_jobs
       SET status = CASE
             WHEN OLD.source_revision IS DISTINCT FROM NEW.source_revision THEN 'BLOCKED_SOURCE_CHANGED'
             ELSE 'BLOCKED_RIGHTS'
           END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error_code = CASE
             WHEN OLD.source_revision IS DISTINCT FROM NEW.source_revision THEN 'SOURCE_REVISION_CHANGED'
             ELSE 'SOURCE_RIGHTS_CHANGED'
           END,
           last_error_message = CASE
             WHEN OLD.source_revision IS DISTINCT FROM NEW.source_revision THEN 'Source metadata changed after this job was queued'
             ELSE 'Source rights or access approval changed after this job was queued'
           END,
           retryable = FALSE,
           completed_at = clock_timestamp(),
           updated_at = clock_timestamp(),
           version = version + 1
     WHERE source_id = NEW.id AND tenant_id = NEW.tenant_id
       AND status IN ('QUEUED','RUNNING','PAUSED');

    INSERT INTO research_ingestion_events (
      tenant_id, job_id, event_type, from_status, to_status, stage,
      progress_percent, detail, actor_user_id
    )
    SELECT tenant_id, id, 'JOB_BLOCKED_SOURCE_CHANGE',
           status, CASE
             WHEN OLD.source_revision IS DISTINCT FROM NEW.source_revision THEN 'BLOCKED_SOURCE_CHANGED'
             ELSE 'BLOCKED_RIGHTS'
           END,
           stage, progress_percent,
           jsonb_build_object('reasonCode',
             CASE WHEN OLD.source_revision IS DISTINCT FROM NEW.source_revision
               THEN 'SOURCE_REVISION_CHANGED' ELSE 'SOURCE_RIGHTS_CHANGED' END),
           COALESCE(NEW.reviewed_by, NEW.created_by)
      FROM research_ingestion_jobs
     WHERE source_id = NEW.id AND tenant_id = NEW.tenant_id
       AND status IN ('BLOCKED_RIGHTS','BLOCKED_SOURCE_CHANGED')
       AND updated_at >= clock_timestamp() - INTERVAL '1 second';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER research_source_rights_history_record
AFTER INSERT OR UPDATE ON research_sources
FOR EACH ROW EXECUTE FUNCTION factoryos_research_record_source_history();

CREATE OR REPLACE FUNCTION factoryos_research_ingestion_job_transition_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'QUEUED' OR NEW.progress_percent <> 0 OR NEW.attempt_count <> 0 THEN
      RAISE EXCEPTION 'RESEARCH_INGESTION_JOB_MUST_START_QUEUED';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('SUCCEEDED','CANCELLED','BLOCKED_RIGHTS','BLOCKED_SOURCE_CHANGED')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'RESEARCH_INGESTION_JOB_TERMINAL';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'QUEUED' AND NEW.status IN ('RUNNING','CANCELLED','FAILED','BLOCKED_RIGHTS','BLOCKED_SOURCE_CHANGED'))
    OR (OLD.status = 'RUNNING' AND NEW.status IN ('RUNNING','QUEUED','PAUSED','SUCCEEDED','FAILED','CANCELLED','BLOCKED_RIGHTS','BLOCKED_SOURCE_CHANGED'))
    OR (OLD.status = 'PAUSED' AND NEW.status IN ('RUNNING','CANCELLED','BLOCKED_RIGHTS','BLOCKED_SOURCE_CHANGED'))
    OR (OLD.status = 'FAILED' AND NEW.status IN ('QUEUED','CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'RESEARCH_INGESTION_JOB_INVALID_TRANSITION';
  END IF;

  IF NEW.progress_percent < OLD.progress_percent THEN
    RAISE EXCEPTION 'RESEARCH_INGESTION_PROGRESS_CANNOT_MOVE_BACKWARD';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'RESEARCH_INGESTION_VERSION_MUST_INCREMENT';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER research_ingestion_job_transition_guard
BEFORE INSERT OR UPDATE ON research_ingestion_jobs
FOR EACH ROW EXECUTE FUNCTION factoryos_research_ingestion_job_transition_guard();

CREATE OR REPLACE FUNCTION factoryos_research_reject_provenance_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'RESEARCH_PROVENANCE_IS_APPEND_ONLY';
END;
$$;

CREATE TRIGGER research_ingestion_events_immutable
BEFORE UPDATE OR DELETE ON research_ingestion_events
FOR EACH ROW EXECUTE FUNCTION factoryos_research_reject_provenance_mutation();
CREATE TRIGGER research_extraction_runs_immutable
BEFORE UPDATE OR DELETE ON research_extraction_runs
FOR EACH ROW EXECUTE FUNCTION factoryos_research_reject_provenance_mutation();
CREATE TRIGGER research_extraction_items_immutable
BEFORE UPDATE OR DELETE ON research_extraction_items
FOR EACH ROW EXECUTE FUNCTION factoryos_research_reject_provenance_mutation();
CREATE TRIGGER research_source_rights_history_immutable
BEFORE UPDATE OR DELETE ON research_source_rights_history
FOR EACH ROW EXECUTE FUNCTION factoryos_research_reject_provenance_mutation();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'research_ingestion_jobs','research_ingestion_events','research_extraction_runs',
    'research_extraction_items','research_source_rights_history'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id())',
      table_name || '_tenant_isolation', table_name);
  END LOOP;
END;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('134_research_ingestion_provenance', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
