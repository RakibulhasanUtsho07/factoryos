BEGIN;

-- Keep approved release rows immutable. Current activation and lifecycle transitions
-- are modeled separately so rollback never rewrites historical release content.
ALTER TABLE research_knowledge_releases
  ADD CONSTRAINT uq_research_release_lifecycle_identity
  UNIQUE (id, tenant_id, release_key, version);

CREATE TABLE research_release_channels (
  tenant_id UUID NOT NULL,
  release_key VARCHAR(160) NOT NULL,
  active_release_id UUID NOT NULL,
  active_version INTEGER NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_by UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pk_research_release_channels PRIMARY KEY (tenant_id, release_key),
  CONSTRAINT fk_research_release_channel_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_release_channel_active_release
    FOREIGN KEY (active_release_id, tenant_id, release_key, active_version)
    REFERENCES research_knowledge_releases(id, tenant_id, release_key, version) ON DELETE RESTRICT,
  CONSTRAINT fk_research_release_channel_actor
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_release_channel_key CHECK (length(btrim(release_key)) > 0),
  CONSTRAINT chk_research_release_channel_version CHECK (active_version > 0),
  CONSTRAINT chk_research_release_channel_revision CHECK (revision > 0)
);

CREATE TABLE research_release_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  release_id UUID NOT NULL,
  release_key VARCHAR(160) NOT NULL,
  version INTEGER NOT NULL,
  event_type VARCHAR(24) NOT NULL,
  related_release_id UUID,
  related_version INTEGER,
  reason TEXT NOT NULL,
  actor_user_id UUID NOT NULL,
  request_id VARCHAR(200),
  trace_id VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_research_release_lifecycle_release
    FOREIGN KEY (release_id, tenant_id, release_key, version)
    REFERENCES research_knowledge_releases(id, tenant_id, release_key, version) ON DELETE RESTRICT,
  CONSTRAINT fk_research_release_lifecycle_related_release
    FOREIGN KEY (related_release_id, tenant_id, release_key, related_version)
    REFERENCES research_knowledge_releases(id, tenant_id, release_key, version) ON DELETE RESTRICT,
  CONSTRAINT fk_research_release_lifecycle_actor
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_release_lifecycle_event_type
    CHECK (event_type IN ('PROMOTED', 'SUPERSEDED', 'ROLLBACK_FROM', 'ROLLBACK_TO', 'BASELINE_IMPORTED')),
  CONSTRAINT chk_research_release_lifecycle_related_pair
    CHECK ((related_release_id IS NULL AND related_version IS NULL)
      OR (related_release_id IS NOT NULL AND related_version IS NOT NULL)),
  CONSTRAINT chk_research_release_lifecycle_reason
    CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  CONSTRAINT chk_research_release_lifecycle_distinct_related
    CHECK (related_release_id IS NULL OR related_release_id <> release_id)
);

CREATE INDEX idx_research_release_channels_active
  ON research_release_channels (tenant_id, active_release_id);
CREATE INDEX idx_research_release_lifecycle_history
  ON research_release_lifecycle_events (tenant_id, release_key, created_at DESC, id DESC);
CREATE INDEX idx_research_release_lifecycle_release
  ON research_release_lifecycle_events (tenant_id, release_id, created_at DESC, id DESC);

-- Adopt the latest still-eligible promoted version for each tenant/release key.
-- Legacy history is explicitly labelled as imported; no fictional pre-migration
-- promotion or supersession timestamps are generated.
WITH eligible AS (
  SELECT r.id, r.tenant_id, r.release_key, r.version,
         COALESCE(r.reviewed_by, r.owner_user_id) AS actor_id,
         row_number() OVER (
           PARTITION BY r.tenant_id, r.release_key
           ORDER BY r.version DESC, r.effective_at DESC NULLS LAST, r.created_at DESC, r.id DESC
         ) AS row_number
    FROM research_knowledge_releases r
   WHERE r.tenant_id IS NOT NULL
     AND r.namespace = 'TENANT'
     AND r.status = 'PROMOTED'
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(r.claim_ids) AS release_claim(claim_id)
        WHERE NOT EXISTS (
          SELECT 1
            FROM research_claims c
            JOIN research_sources s ON s.id = c.source_id AND s.namespace = c.namespace
           WHERE c.id = release_claim.claim_id::uuid
             AND c.status = 'APPROVED'
             AND (c.tenant_id = r.tenant_id OR c.tenant_id IS NULL)
             AND s.access_status = 'APPROVED'
             AND s.license_status IN ('OPEN_ACCESS', 'LICENSED', 'USER_PROVIDED_AUTHORIZED')
             AND NULLIF(BTRIM(s.rights_basis), '') IS NOT NULL
        )
     )
)
INSERT INTO research_release_channels (
  tenant_id, release_key, active_release_id, active_version, revision, updated_by
)
SELECT tenant_id, release_key, id, version, 1, actor_id
  FROM eligible
 WHERE row_number = 1
ON CONFLICT (tenant_id, release_key) DO NOTHING;

INSERT INTO research_release_lifecycle_events (
  tenant_id, release_id, release_key, version, event_type, reason, actor_user_id
)
SELECT r.tenant_id, r.id, r.release_key, r.version, 'BASELINE_IMPORTED',
       'Legacy promoted release imported during lifecycle migration; historic event timestamps were not inferred.',
       COALESCE(r.reviewed_by, r.owner_user_id)
  FROM research_knowledge_releases r
 WHERE r.tenant_id IS NOT NULL
   AND r.namespace = 'TENANT'
   AND r.status = 'PROMOTED';

CREATE OR REPLACE FUNCTION factoryos_guard_research_release_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_release RECORD;
  v_invalid_claim_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_CHANNELS_CANNOT_BE_DELETED'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.release_key IS DISTINCT FROM OLD.release_key
       OR NEW.revision <> OLD.revision + 1
       OR NEW.active_release_id IS NOT DISTINCT FROM OLD.active_release_id THEN
      RAISE EXCEPTION 'RESEARCH_RELEASE_CHANNEL_REQUIRES_A_NEW_TARGET_AND_NEXT_REVISION'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.revision <> 1 THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_CHANNEL_INITIAL_REVISION_MUST_BE_ONE'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.updated_by IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.tenant_id IS DISTINCT FROM factoryos_current_tenant_id() THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_CHANNEL_ACTOR_OR_TENANT_MISMATCH'
      USING ERRCODE = '42501';
  END IF;

  SELECT r.* INTO v_release
    FROM research_knowledge_releases r
   WHERE r.id = NEW.active_release_id
     AND r.tenant_id = NEW.tenant_id
     AND r.namespace = 'TENANT'
     AND r.release_key = NEW.release_key
     AND r.version = NEW.active_version
     AND r.status = 'PROMOTED'
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_CHANNEL_TARGET_MUST_BE_A_PROMOTED_TENANT_VERSION'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer INTO v_invalid_claim_count
    FROM jsonb_array_elements_text(v_release.claim_ids) AS release_claim(claim_id)
   WHERE NOT EXISTS (
     SELECT 1
       FROM research_claims c
       JOIN research_sources s ON s.id = c.source_id AND s.namespace = c.namespace
      WHERE c.id = release_claim.claim_id::uuid
        AND c.status = 'APPROVED'
        AND (c.tenant_id = NEW.tenant_id OR c.tenant_id IS NULL)
        AND s.access_status = 'APPROVED'
        AND s.license_status IN ('OPEN_ACCESS', 'LICENSED', 'USER_PROVIDED_AUTHORIZED')
        AND NULLIF(BTRIM(s.rights_basis), '') IS NOT NULL
   );

  IF v_invalid_claim_count > 0 THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_CHANNEL_REQUIRES_CURRENT_APPROVED_CLAIMS_AND_SOURCE_RIGHTS'
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER research_release_channel_guard
BEFORE INSERT OR UPDATE OR DELETE ON research_release_channels
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_release_channel();

CREATE OR REPLACE FUNCTION factoryos_guard_research_release_lifecycle_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_release_status VARCHAR(20);
  v_active_release_id UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_LIFECYCLE_EVENTS_ARE_APPEND_ONLY'
      USING ERRCODE = '55000';
  END IF;

  SELECT status INTO v_release_status
    FROM research_knowledge_releases
   WHERE id = NEW.release_id
     AND tenant_id = NEW.tenant_id
     AND namespace = 'TENANT'
     AND release_key = NEW.release_key
     AND version = NEW.version
   FOR SHARE;

  IF NOT FOUND OR v_release_status <> 'PROMOTED' THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_LIFECYCLE_EVENT_REQUIRES_A_PROMOTED_RELEASE'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.event_type <> 'BASELINE_IMPORTED'
     AND (NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.tenant_id IS DISTINCT FROM factoryos_current_tenant_id()) THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_LIFECYCLE_EVENT_ACTOR_OR_TENANT_MISMATCH'
      USING ERRCODE = '42501';
  END IF;

  SELECT active_release_id INTO v_active_release_id
    FROM research_release_channels
   WHERE tenant_id = NEW.tenant_id AND release_key = NEW.release_key;

  IF NEW.event_type IN ('PROMOTED', 'ROLLBACK_TO')
     AND v_active_release_id IS DISTINCT FROM NEW.release_id THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_LIFECYCLE_EVENT_TARGET_IS_NOT_ACTIVE'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.event_type IN ('SUPERSEDED', 'ROLLBACK_FROM')
     AND (NEW.related_release_id IS NULL OR v_active_release_id IS DISTINCT FROM NEW.related_release_id) THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_LIFECYCLE_EVENT_SUCCESSOR_IS_NOT_ACTIVE'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER research_release_lifecycle_events_guard
BEFORE INSERT OR UPDATE OR DELETE ON research_release_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_release_lifecycle_event();

ALTER TABLE research_release_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_release_channels FORCE ROW LEVEL SECURITY;
CREATE POLICY research_release_channels_tenant_isolation
  ON research_release_channels
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE research_release_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_release_lifecycle_events FORCE ROW LEVEL SECURITY;
CREATE POLICY research_release_lifecycle_events_tenant_isolation
  ON research_release_lifecycle_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version, checksum)
VALUES ('142_research_release_lifecycle', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
