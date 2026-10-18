BEGIN;

-- FR-RES-03: tenant-managed topic watchlist configuration.
-- Fetching DOI/publisher content is intentionally a separate ingestion-worker integration.
CREATE TABLE research_topic_watchlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  watchlist_key VARCHAR(160) NOT NULL,
  title VARCHAR(300) NOT NULL,
  topic_type VARCHAR(40) NOT NULL,
  description TEXT,
  topic_terms JSONB NOT NULL,
  inclusion_terms JSONB NOT NULL DEFAULT '[]'::jsonb,
  exclusion_terms JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_types JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  status_reason TEXT,
  created_by UUID NOT NULL,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_research_watchlist_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_watchlist_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_watchlist_updater FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_watchlist_key CHECK (length(btrim(watchlist_key)) BETWEEN 2 AND 160),
  CONSTRAINT chk_research_watchlist_title CHECK (length(btrim(title)) BETWEEN 2 AND 300),
  CONSTRAINT chk_research_watchlist_topic_type CHECK (
    topic_type IN ('SECTOR', 'TECHNOLOGY', 'PROCESS', 'MARKET', 'SUSTAINABILITY', 'STRATEGIC_QUESTION')
  ),
  CONSTRAINT chk_research_watchlist_terms CHECK (
    jsonb_typeof(topic_terms) = 'array' AND jsonb_array_length(topic_terms) BETWEEN 1 AND 25
  ),
  CONSTRAINT chk_research_watchlist_inclusion CHECK (
    jsonb_typeof(inclusion_terms) = 'array' AND jsonb_array_length(inclusion_terms) <= 50
  ),
  CONSTRAINT chk_research_watchlist_exclusion CHECK (
    jsonb_typeof(exclusion_terms) = 'array' AND jsonb_array_length(exclusion_terms) <= 50
  ),
  CONSTRAINT chk_research_watchlist_source_types CHECK (
    jsonb_typeof(source_types) = 'array' AND jsonb_array_length(source_types) BETWEEN 1 AND 10
  ),
  CONSTRAINT chk_research_watchlist_status CHECK (status IN ('ACTIVE', 'PAUSED', 'RETIRED')),
  CONSTRAINT chk_research_watchlist_reason CHECK (
    status_reason IS NULL OR length(btrim(status_reason)) > 0
  )
);

CREATE UNIQUE INDEX uq_research_watchlist_active_key
  ON research_topic_watchlists (tenant_id, lower(watchlist_key))
  WHERE status <> 'RETIRED';

CREATE INDEX idx_research_watchlist_status_updated
  ON research_topic_watchlists (tenant_id, status, updated_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_research_topic_watchlist()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Research topic watchlists are retained as configuration history'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.watchlist_key IS DISTINCT FROM OLD.watchlist_key
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.topic_type IS DISTINCT FROM OLD.topic_type
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.topic_terms IS DISTINCT FROM OLD.topic_terms
    OR NEW.inclusion_terms IS DISTINCT FROM OLD.inclusion_terms
    OR NEW.exclusion_terms IS DISTINCT FROM OLD.exclusion_terms
    OR NEW.source_types IS DISTINCT FROM OLD.source_types
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Research watchlist definitions are immutable; retire and create a replacement'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'RETIRED' THEN
    RAISE EXCEPTION 'Retired research watchlists are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'ACTIVE' AND NEW.status IN ('PAUSED', 'RETIRED'))
      OR (OLD.status = 'PAUSED' AND NEW.status IN ('ACTIVE', 'RETIRED'))
    ) THEN
      RAISE EXCEPTION 'Invalid research watchlist transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status_reason IS NULL OR length(btrim(NEW.status_reason)) = 0 OR NEW.updated_by IS NULL THEN
      RAISE EXCEPTION 'Research watchlist status transitions require a reason and actor'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status_reason IS DISTINCT FROM OLD.status_reason
    OR NEW.updated_by IS DISTINCT FROM OLD.updated_by THEN
    RAISE EXCEPTION 'Research watchlist decisions must change lifecycle status'
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER research_topic_watchlist_guard
BEFORE UPDATE OR DELETE ON research_topic_watchlists
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_topic_watchlist();

ALTER TABLE research_topic_watchlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_topic_watchlists FORCE ROW LEVEL SECURITY;
CREATE POLICY research_topic_watchlists_tenant_isolation
  ON research_topic_watchlists
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version, checksum)
VALUES ('042_research_topic_watchlists', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
