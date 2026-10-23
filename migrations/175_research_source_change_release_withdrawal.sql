BEGIN;

-- Any source/rights revision invalidates the evidence snapshot served by an
-- active tenant release. Withdraw its active pointer in the same transaction;
-- preserve the immutable promoted version and append a reasoned RETRACTED event.
CREATE OR REPLACE FUNCTION factoryos_research_retract_stale_active_releases()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  channel_row RECORD;
  actor_id UUID;
  retraction_reason TEXT;
  next_revision BIGINT;
BEGIN
  IF NEW.namespace <> 'TENANT' OR NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.source_revision IS NOT DISTINCT FROM OLD.source_revision
     AND NEW.rights_version IS NOT DISTINCT FROM OLD.rights_version THEN
    RETURN NEW;
  END IF;

  FOR channel_row IN
    SELECT ch.tenant_id,ch.release_key,ch.active_release_id,ch.active_version,ch.revision
      FROM research_release_channels ch
      JOIN research_knowledge_releases r
        ON r.id=ch.active_release_id AND r.tenant_id=ch.tenant_id
       AND r.release_key=ch.release_key AND r.version=ch.active_version
      WHERE ch.tenant_id=NEW.tenant_id
        AND ch.active_release_id IS NOT NULL
        AND r.status='PROMOTED'
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements_text(r.claim_ids) AS release_claim(claim_id)
            JOIN research_claims c ON c.id=release_claim.claim_id::uuid
           WHERE c.source_id=NEW.id AND c.tenant_id=NEW.tenant_id
        )
      FOR UPDATE OF ch
  LOOP
    actor_id := factoryos_current_user_id();
    IF actor_id IS NULL OR factoryos_current_tenant_id() IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'RESEARCH_SOURCE_REVISION_CHANGE_REQUIRES_AUTHENTICATED_TENANT_ACTOR'
        USING ERRCODE='42501';
    END IF;

    retraction_reason := left(
      'Source/rights revision changed for source ' || NEW.id::text ||
      '; release requires fresh source/evidence review before re-promotion.',
      2000
    );

    UPDATE research_release_channels
       SET active_release_id=NULL,
           active_version=NULL,
           revision=revision+1,
           updated_by=actor_id
     WHERE tenant_id=channel_row.tenant_id
       AND release_key=channel_row.release_key
       AND active_release_id=channel_row.active_release_id
       AND active_version=channel_row.active_version
     RETURNING revision INTO next_revision;

    IF next_revision IS NULL THEN
      RAISE EXCEPTION 'RESEARCH_SOURCE_REVISION_RELEASE_WITHDRAWAL_CONFLICT'
        USING ERRCODE='40001';
    END IF;

    INSERT INTO research_release_lifecycle_events (
      tenant_id,release_id,release_key,version,event_type,related_release_id,
      related_version,reason,actor_user_id,request_id,trace_id
    ) VALUES (
      channel_row.tenant_id,channel_row.active_release_id,channel_row.release_key,
      channel_row.active_version,'RETRACTED',NULL,NULL,retraction_reason,
      actor_id,NULL,NULL
    );

    INSERT INTO outbox_events (
      tenant_id,factory_id,aggregate_type,aggregate_id,event_type,event_version,
      occurred_at,correlation_id,causation_id,actor,source,payload
    ) VALUES (
      channel_row.tenant_id,NULL,'RESEARCH_RELEASE',channel_row.active_release_id,
      'RESEARCH.RELEASE_RETRACTED',1,clock_timestamp(),gen_random_uuid(),NULL,
      jsonb_build_object('type','user','id',actor_id::text),
      jsonb_build_object('system','FactoryOS','connector','research-source-rights-guard','version','0.1.0'),
      jsonb_build_object(
        'release_id',channel_row.active_release_id,
        'release_key',channel_row.release_key,
        'version',channel_row.active_version,
        'reason',retraction_reason,
        'source_id',NEW.id,
        'source_revision',NEW.source_revision,
        'rights_version',NEW.rights_version,
        'active_release_id',NULL,
        'active_version',NULL,
        'channel_revision',next_revision
      )
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS research_source_zzzz_retract_stale_releases ON research_sources;
CREATE TRIGGER research_source_zzzz_retract_stale_releases
AFTER UPDATE ON research_sources
FOR EACH ROW EXECUTE FUNCTION factoryos_research_retract_stale_active_releases();

INSERT INTO schema_migrations (version,checksum)
VALUES ('175_research_source_change_release_withdrawal',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
