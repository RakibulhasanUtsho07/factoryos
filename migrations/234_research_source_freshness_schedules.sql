BEGIN;

CREATE TABLE research_source_freshness_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  source_id UUID NOT NULL,
  mode VARCHAR(20) NOT NULL,
  interval_minutes INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  status_reason VARCHAR(500),
  next_due_at TIMESTAMPTZ NOT NULL,
  last_attempted_at TIMESTAMPTZ,
  last_enqueued_at TIMESTAMPTZ,
  last_job_id UUID,
  last_blocked_at TIMESTAMPTZ,
  last_blocked_code VARCHAR(100),
  row_version INTEGER NOT NULL DEFAULT 1,
  created_by UUID NOT NULL,
  updated_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_research_freshness_policy_scope UNIQUE(id,tenant_id),
  CONSTRAINT fk_research_freshness_source FOREIGN KEY(source_id,tenant_id)
    REFERENCES research_sources(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_freshness_last_job FOREIGN KEY(last_job_id,tenant_id)
    REFERENCES research_ingestion_jobs(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_freshness_creator FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_freshness_updater FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_freshness_mode CHECK(mode IN ('METADATA_ONLY','FULL_TEXT')),
  CONSTRAINT chk_research_freshness_interval CHECK(interval_minutes BETWEEN 60 AND 129600),
  CONSTRAINT chk_research_freshness_attempts CHECK(max_attempts BETWEEN 1 AND 10),
  CONSTRAINT chk_research_freshness_status CHECK(status IN ('ACTIVE','PAUSED','RETIRED')),
  CONSTRAINT chk_research_freshness_version CHECK(row_version >= 1),
  CONSTRAINT chk_research_freshness_blocked_code CHECK(
    last_blocked_code IS NULL OR last_blocked_code ~ '^[A-Z][A-Z0-9_]{1,99}$'
  ),
  CONSTRAINT chk_research_freshness_reason CHECK(
    status_reason IS NULL OR length(btrim(status_reason)) BETWEEN 8 AND 500
  )
);

CREATE UNIQUE INDEX uq_research_freshness_active_source
  ON research_source_freshness_policies(tenant_id,source_id)
  WHERE status IN ('ACTIVE','PAUSED');
CREATE INDEX idx_research_freshness_due_queue
  ON research_source_freshness_policies(tenant_id,next_due_at,id)
  WHERE status='ACTIVE';
CREATE INDEX idx_research_freshness_last_job
  ON research_source_freshness_policies(tenant_id,last_job_id)
  WHERE last_job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_guard_research_source_freshness_policy()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'RESEARCH_FRESHNESS_POLICY_DELETE_FORBIDDEN' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'ACTIVE' OR NEW.row_version<>1 OR NEW.last_job_id IS NOT NULL
       OR NEW.last_enqueued_at IS NOT NULL OR NEW.last_attempted_at IS NOT NULL
       OR NEW.last_blocked_at IS NOT NULL OR NEW.last_blocked_code IS NOT NULL
       OR length(btrim(COALESCE(NEW.status_reason,'')))<>0 THEN
      RAISE EXCEPTION 'RESEARCH_FRESHNESS_POLICY_INITIAL_STATE_INVALID' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.source_id,NEW.mode,NEW.interval_minutes,NEW.max_attempts,
         NEW.created_by,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.tenant_id,OLD.source_id,OLD.mode,OLD.interval_minutes,OLD.max_attempts,
         OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'RESEARCH_FRESHNESS_POLICY_CONFIGURATION_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF NEW.row_version<>OLD.row_version+1 THEN
    RAISE EXCEPTION 'RESEARCH_FRESHNESS_POLICY_VERSION_MUST_INCREMENT' USING ERRCODE='23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status='ACTIVE' AND NEW.status IN ('PAUSED','RETIRED'))
      OR (OLD.status='PAUSED' AND NEW.status IN ('ACTIVE','RETIRED'))
    ) OR length(btrim(COALESCE(NEW.status_reason,'')))<8 OR NEW.updated_by IS NULL THEN
      RAISE EXCEPTION 'RESEARCH_FRESHNESS_POLICY_TRANSITION_INVALID' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.status_reason IS DISTINCT FROM OLD.status_reason THEN
    RAISE EXCEPTION 'RESEARCH_FRESHNESS_POLICY_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  IF OLD.status='RETIRED' THEN
    RAISE EXCEPTION 'RESEARCH_FRESHNESS_POLICY_RETIRED_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'RESEARCH_FRESHNESS_POLICY_TIME_CANNOT_MOVE_BACKWARD' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER research_source_freshness_policy_guard
BEFORE INSERT OR UPDATE OR DELETE ON research_source_freshness_policies
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_source_freshness_policy();

ALTER TABLE research_source_freshness_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_source_freshness_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY research_source_freshness_policies_tenant_isolation
  ON research_source_freshness_policies
  USING(tenant_id=factoryos_current_tenant_id())
  WITH CHECK(tenant_id=factoryos_current_tenant_id());

INSERT INTO schema_migrations(version,checksum)
VALUES('234_research_source_freshness_schedules',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
