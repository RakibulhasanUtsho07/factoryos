BEGIN;

-- During rollout, preserve one truthful "baseline imported" rights snapshot for
-- pre-existing tenant sources that predate the history trigger.
ALTER TABLE research_source_rights_history
  DROP CONSTRAINT chk_research_source_rights_history_action;
ALTER TABLE research_source_rights_history
  ADD CONSTRAINT chk_research_source_rights_history_action CHECK (
    action IN (
      'REGISTERED','BASELINE_IMPORTED','RIGHTS_CHANGED','SOURCE_CHANGED',
      'ACCESS_REVIEWED','ACCESS_REVOKED'
    )
  );

INSERT INTO research_source_rights_history (
  tenant_id,source_id,source_revision,rights_version,action,
  rights_snapshot,source_snapshot,actor_user_id,created_at
)
SELECT
  s.tenant_id,s.id,s.source_revision,s.rights_version,'BASELINE_IMPORTED',
  jsonb_build_object(
    'licenseStatus',s.license_status,
    'accessStatus',s.access_status,
    'rightsBasis',s.rights_basis,
    'licenseReference',s.license_reference,
    'fullTextStorageAllowed',s.full_text_storage_allowed,
    'reviewedBy',s.reviewed_by,
    'reviewedAt',s.reviewed_at,
    'reviewReason',s.review_reason
  ),
  jsonb_build_object(
    'namespace',s.namespace,'sourceType',s.source_type,'title',s.title,
    'authors',s.authors,'publicationDate',s.publication_date,
    'doi',s.doi,'venue',s.venue,'abstract',s.abstract,
    'sourceUrl',s.source_url,'sourceMetadata',s.source_metadata
  ),
  COALESCE(s.reviewed_by,s.created_by),
  clock_timestamp()
FROM research_sources s
WHERE s.namespace='TENANT' AND s.tenant_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM research_source_rights_history h
    WHERE h.source_id=s.id AND h.tenant_id=s.tenant_id
  );

-- Store no restricted excerpt body in the purge log. The SHA-256 digest plus
-- source/claim IDs preserves a verifiable audit reference without retaining it.
CREATE UNIQUE INDEX uq_research_claim_id_tenant
  ON research_claims (id,tenant_id);

CREATE TABLE research_source_content_purges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  source_id UUID NOT NULL,
  claim_id UUID NOT NULL,
  source_revision INTEGER NOT NULL,
  rights_version INTEGER NOT NULL,
  excerpt_sha256 CHAR(64) NOT NULL,
  purge_reason VARCHAR(40) NOT NULL,
  actor_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_research_source_content_purge_source
    FOREIGN KEY (source_id,tenant_id) REFERENCES research_sources(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_source_content_purge_claim
    FOREIGN KEY (claim_id,tenant_id) REFERENCES research_claims(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_source_content_purge_actor
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_source_content_purge_digest
    CHECK (excerpt_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_research_source_content_purge_versions
    CHECK (source_revision >= 1 AND rights_version >= 1),
  CONSTRAINT chk_research_source_content_purge_reason
    CHECK (purge_reason IN ('FULL_TEXT_STORAGE_REVOKED','SOURCE_ACCESS_REVOKED','LICENSE_RESTRICTED'))
);
CREATE INDEX idx_research_source_content_purges_timeline
  ON research_source_content_purges (tenant_id,source_id,created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_research_purge_unlicensed_excerpts()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  claim_row RECORD;
  excerpt_digest CHAR(64);
  purge_reason_value VARCHAR(40);
BEGIN
  IF NEW.namespace <> 'TENANT' OR NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.access_status IN ('REVOKED','REJECTED')
     AND OLD.access_status IS DISTINCT FROM NEW.access_status THEN
    purge_reason_value := 'SOURCE_ACCESS_REVOKED';
  ELSIF NEW.license_status IN ('RESTRICTED','UNKNOWN')
     AND OLD.license_status IS DISTINCT FROM NEW.license_status THEN
    purge_reason_value := 'LICENSE_RESTRICTED';
  ELSIF OLD.full_text_storage_allowed IS TRUE AND NEW.full_text_storage_allowed IS FALSE THEN
    purge_reason_value := 'FULL_TEXT_STORAGE_REVOKED';
  ELSE
    RETURN NEW;
  END IF;

  FOR claim_row IN
    SELECT id,stored_excerpt,provenance_ref
    FROM research_claims
    WHERE source_id=NEW.id AND tenant_id=NEW.tenant_id AND stored_excerpt IS NOT NULL
    FOR UPDATE
  LOOP
    excerpt_digest := encode(sha256(convert_to(claim_row.stored_excerpt,'UTF8')),'hex');

    INSERT INTO research_source_content_purges (
      tenant_id,source_id,claim_id,source_revision,rights_version,
      excerpt_sha256,purge_reason,actor_user_id
    ) VALUES (
      NEW.tenant_id,NEW.id,claim_row.id,NEW.source_revision,NEW.rights_version,
      excerpt_digest,purge_reason_value,COALESCE(NEW.reviewed_by,NEW.created_by)
    );

    UPDATE research_claims
       SET stored_excerpt=NULL,
           provenance_ref=provenance_ref || jsonb_build_object(
             'storedExcerptPurged',TRUE,
             'storedExcerptSha256',excerpt_digest,
             'storedExcerptPurgedAt',clock_timestamp(),
             'storedExcerptPurgeReason',purge_reason_value
           ),
           updated_at=clock_timestamp()
     WHERE id=claim_row.id AND tenant_id=NEW.tenant_id;
  END LOOP;

  RETURN NEW;
END;
$$;

-- PostgreSQL fires same-kind triggers in name order; "research_source_z..."
-- runs after the source/right version guard has updated NEW's version counters.
CREATE TRIGGER research_source_z_excerpt_purge_guard
BEFORE UPDATE OF full_text_storage_allowed,access_status,license_status ON research_sources
FOR EACH ROW EXECUTE FUNCTION factoryos_research_purge_unlicensed_excerpts();

CREATE TRIGGER research_source_content_purges_immutable
BEFORE UPDATE OR DELETE ON research_source_content_purges
FOR EACH ROW EXECUTE FUNCTION factoryos_research_reject_provenance_mutation();

ALTER TABLE research_source_content_purges ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_source_content_purges FORCE ROW LEVEL SECURITY;
CREATE POLICY research_source_content_purges_tenant_isolation
  ON research_source_content_purges
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

INSERT INTO schema_migrations (version,checksum)
VALUES ('136_research_content_rights_purge',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
