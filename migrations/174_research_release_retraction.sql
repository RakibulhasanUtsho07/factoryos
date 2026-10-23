BEGIN;

-- Retraction deactivates the serving pointer without rewriting or deleting a
-- promoted version. The history/event tables retain the released content lineage.
ALTER TABLE research_release_channels
  ALTER COLUMN active_release_id DROP NOT NULL,
  ALTER COLUMN active_version DROP NOT NULL;
ALTER TABLE research_release_channels
  DROP CONSTRAINT IF EXISTS chk_research_release_channel_version;
ALTER TABLE research_release_channels
  DROP CONSTRAINT IF EXISTS chk_research_release_channel_active_pair;
ALTER TABLE research_release_channels
  ADD CONSTRAINT chk_research_release_channel_active_pair CHECK (
    (active_release_id IS NULL AND active_version IS NULL)
    OR (active_release_id IS NOT NULL AND active_version IS NOT NULL AND active_version > 0)
  );

ALTER TABLE research_release_lifecycle_events
  DROP CONSTRAINT chk_research_release_lifecycle_event_type;
ALTER TABLE research_release_lifecycle_events
  ADD CONSTRAINT chk_research_release_lifecycle_event_type
  CHECK (event_type IN ('PROMOTED','SUPERSEDED','ROLLBACK_FROM','ROLLBACK_TO','RETRACTED','BASELINE_IMPORTED'));

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
       OR (NEW.active_release_id IS NOT DISTINCT FROM OLD.active_release_id
           AND NEW.active_version IS NOT DISTINCT FROM OLD.active_version) THEN
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

  IF NEW.active_release_id IS NULL THEN
    IF TG_OP <> 'UPDATE' OR NEW.active_version IS NOT NULL THEN
      RAISE EXCEPTION 'RESEARCH_RELEASE_CHANNEL_EMPTY_TARGET_REQUIRES_RETRACTION'
        USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.active_version IS NULL THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_CHANNEL_ACTIVE_VERSION_REQUIRED'
      USING ERRCODE = '23514';
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

DROP TRIGGER IF EXISTS research_release_channel_guard ON research_release_channels;
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
  v_latest_event VARCHAR(24);
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

  IF NEW.event_type = 'RETRACTED' THEN
    IF v_active_release_id IS NOT NULL OR NEW.related_release_id IS NOT NULL OR NEW.related_version IS NOT NULL THEN
      RAISE EXCEPTION 'RESEARCH_RELEASE_RETRACTION_CHANNEL_NOT_EMPTY'
        USING ERRCODE = '23514';
    END IF;
    SELECT event_type INTO v_latest_event
      FROM research_release_lifecycle_events
     WHERE tenant_id=NEW.tenant_id AND release_key=NEW.release_key AND release_id=NEW.release_id
     ORDER BY created_at DESC, id DESC
     LIMIT 1;
    IF v_latest_event IS NULL OR v_latest_event NOT IN ('PROMOTED','ROLLBACK_TO') THEN
      RAISE EXCEPTION 'RESEARCH_RELEASE_RETRACTION_REQUIRES_RECENT_ACTIVE_EVENT'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

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

DROP TRIGGER IF EXISTS research_release_lifecycle_events_guard ON research_release_lifecycle_events;
CREATE TRIGGER research_release_lifecycle_events_guard
BEFORE INSERT OR UPDATE OR DELETE ON research_release_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_release_lifecycle_event();

INSERT INTO schema_migrations (version,checksum)
VALUES ('174_research_release_retraction',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
