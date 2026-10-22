BEGIN;

-- Clearing the active pointer and recording the retraction must commit together.
-- A deferred guard permits either the API or the source-rights trigger to append
-- the event later in the same transaction, but rejects an unaudited withdrawal.
CREATE OR REPLACE FUNCTION factoryos_assert_research_release_channel_retraction_audited()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.active_release_id IS NOT NULL AND NEW.active_release_id IS NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM research_release_lifecycle_events e
       WHERE e.tenant_id=OLD.tenant_id
         AND e.release_key=OLD.release_key
         AND e.release_id=OLD.active_release_id
         AND e.version=OLD.active_version
         AND e.event_type='RETRACTED'
         AND e.related_release_id IS NULL
         AND e.related_version IS NULL
         AND e.actor_user_id=NEW.updated_by
         AND e.created_at >= transaction_timestamp()
    ) THEN
      RAISE EXCEPTION 'RESEARCH_RELEASE_CHANNEL_RETRACTION_REQUIRES_AUDITED_EVENT'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS research_release_channel_retraction_audit_guard ON research_release_channels;
CREATE CONSTRAINT TRIGGER research_release_channel_retraction_audit_guard
AFTER UPDATE ON research_release_channels
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD.active_release_id IS NOT NULL AND NEW.active_release_id IS NULL)
EXECUTE FUNCTION factoryos_assert_research_release_channel_retraction_audited();

INSERT INTO schema_migrations (version,checksum)
VALUES ('176_research_release_retraction_audit_guard',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
