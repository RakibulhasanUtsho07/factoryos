BEGIN;

-- Round 25 / FR-CBB-04..07: source-level provenance, immutable evidence
-- revisions, graph-version-bound links, and reviewable conflict decisions.

ALTER TABLE business_evidence
  ADD COLUMN IF NOT EXISTS source_key TEXT,
  ADD COLUMN IF NOT EXISTS source_system VARCHAR(150),
  ADD COLUMN IF NOT EXISTS source_record_id VARCHAR(300),
  ADD COLUMN IF NOT EXISTS source_version VARCHAR(150),
  ADD COLUMN IF NOT EXISTS source_uri TEXT,
  ADD COLUMN IF NOT EXISTS supersedes_evidence_id UUID,
  ADD COLUMN IF NOT EXISTS revision_no INTEGER NOT NULL DEFAULT 1;

DO $
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='business_evidence'::regclass AND conname='chk_business_evidence_revision_positive') THEN
    ALTER TABLE business_evidence ADD CONSTRAINT chk_business_evidence_revision_positive CHECK (revision_no >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='business_evidence'::regclass AND conname='chk_business_evidence_source_key') THEN
    ALTER TABLE business_evidence ADD CONSTRAINT chk_business_evidence_source_key CHECK (source_key IS NULL OR length(btrim(source_key)) BETWEEN 1 AND 1000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='business_evidence'::regclass AND conname='chk_business_evidence_source_uri') THEN
    ALTER TABLE business_evidence ADD CONSTRAINT chk_business_evidence_source_uri CHECK (source_uri IS NULL OR source_uri ~* '^https?://');
  END IF;
END $;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'business_evidence'::regclass
      AND conname = 'uq_business_evidence_id_scope'
  ) THEN
    ALTER TABLE business_evidence
      ADD CONSTRAINT uq_business_evidence_id_scope
      UNIQUE (id, tenant_id, factory_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'business_evidence'::regclass
      AND conname = 'fk_business_evidence_supersedes_scope'
  ) THEN
    ALTER TABLE business_evidence
      ADD CONSTRAINT fk_business_evidence_supersedes_scope
      FOREIGN KEY (supersedes_evidence_id, tenant_id, factory_id)
      REFERENCES business_evidence (id, tenant_id, factory_id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_business_evidence_source_revision
  ON business_evidence (tenant_id, factory_id, source_key, revision_no)
  WHERE source_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_business_evidence_supersedes
  ON business_evidence (tenant_id, factory_id, supersedes_evidence_id)
  WHERE supersedes_evidence_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_business_evidence_source_history
  ON business_evidence (tenant_id, factory_id, source_key, revision_no DESC)
  WHERE source_key IS NOT NULL;

-- Each provenance link remembers the exact blueprint version it annotates.
-- Old links are backfilled from their target graph row wherever possible.
ALTER TABLE business_evidence_links
  ADD COLUMN IF NOT EXISTS blueprint_id UUID,
  ADD COLUMN IF NOT EXISTS blueprint_version_id UUID;

WITH candidates AS (
  SELECT l.id, e.blueprint_version_id, v.blueprint_id
  FROM business_evidence_links l
  JOIN business_entities e ON l.target_type = 'ENTITY' AND e.id=l.target_id AND e.tenant_id=l.tenant_id AND e.factory_id=l.factory_id
  JOIN business_blueprint_versions v ON v.id=e.blueprint_version_id AND v.tenant_id=e.tenant_id AND v.factory_id=e.factory_id
  UNION ALL
  SELECT l.id, e.blueprint_version_id, v.blueprint_id
  FROM business_evidence_links l
  JOIN business_relations e ON l.target_type = 'RELATION' AND e.id=l.target_id AND e.tenant_id=l.tenant_id AND e.factory_id=l.factory_id
  JOIN business_blueprint_versions v ON v.id=e.blueprint_version_id AND v.tenant_id=e.tenant_id AND v.factory_id=e.factory_id
  UNION ALL
  SELECT l.id, e.blueprint_version_id, v.blueprint_id
  FROM business_evidence_links l
  JOIN business_processes e ON l.target_type = 'PROCESS' AND e.id=l.target_id AND e.tenant_id=l.tenant_id AND e.factory_id=l.factory_id
  JOIN business_blueprint_versions v ON v.id=e.blueprint_version_id AND v.tenant_id=e.tenant_id AND v.factory_id=e.factory_id
  UNION ALL
  SELECT l.id, e.blueprint_version_id, v.blueprint_id
  FROM business_evidence_links l
  JOIN business_process_steps e ON l.target_type = 'PROCESS_STEP' AND e.id=l.target_id AND e.tenant_id=l.tenant_id AND e.factory_id=l.factory_id
  JOIN business_blueprint_versions v ON v.id=e.blueprint_version_id AND v.tenant_id=e.tenant_id AND v.factory_id=e.factory_id
  UNION ALL
  SELECT l.id, e.blueprint_version_id, v.blueprint_id
  FROM business_evidence_links l
  JOIN business_rules e ON l.target_type = 'RULE' AND e.id=l.target_id AND e.tenant_id=l.tenant_id AND e.factory_id=l.factory_id
  JOIN business_blueprint_versions v ON v.id=e.blueprint_version_id AND v.tenant_id=e.tenant_id AND v.factory_id=e.factory_id
  UNION ALL
  SELECT l.id, e.blueprint_version_id, v.blueprint_id
  FROM business_evidence_links l
  JOIN business_terms e ON l.target_type = 'TERM' AND e.id=l.target_id AND e.tenant_id=l.tenant_id AND e.factory_id=l.factory_id
  JOIN business_blueprint_versions v ON v.id=e.blueprint_version_id AND v.tenant_id=e.tenant_id AND v.factory_id=e.factory_id
  UNION ALL
  SELECT l.id, e.blueprint_version_id, v.blueprint_id
  FROM business_evidence_links l
  JOIN business_exceptions e ON l.target_type = 'EXCEPTION' AND e.id=l.target_id AND e.tenant_id=l.tenant_id AND e.factory_id=l.factory_id
  JOIN business_blueprint_versions v ON v.id=e.blueprint_version_id AND v.tenant_id=e.tenant_id AND v.factory_id=e.factory_id
)
UPDATE business_evidence_links l
SET blueprint_version_id = COALESCE(l.blueprint_version_id, candidates.blueprint_version_id),
    blueprint_id = COALESCE(l.blueprint_id, candidates.blueprint_id)
FROM candidates
WHERE candidates.id = l.id
  AND (l.blueprint_version_id IS NULL OR l.blueprint_id IS NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'business_evidence_links'::regclass
      AND conname = 'fk_business_evidence_links_evidence_scope'
  ) THEN
    ALTER TABLE business_evidence_links
      ADD CONSTRAINT fk_business_evidence_links_evidence_scope
      FOREIGN KEY (evidence_id, tenant_id, factory_id)
      REFERENCES business_evidence (id, tenant_id, factory_id)
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'business_evidence_links'::regclass
      AND conname = 'fk_business_evidence_links_blueprint_scope'
  ) THEN
    ALTER TABLE business_evidence_links
      ADD CONSTRAINT fk_business_evidence_links_blueprint_scope
      FOREIGN KEY (blueprint_id, tenant_id, factory_id)
      REFERENCES business_blueprints (id, tenant_id, factory_id)
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'business_evidence_links'::regclass
      AND conname = 'fk_business_evidence_links_version_scope'
  ) THEN
    ALTER TABLE business_evidence_links
      ADD CONSTRAINT fk_business_evidence_links_version_scope
      FOREIGN KEY (blueprint_version_id, tenant_id, factory_id)
      REFERENCES business_blueprint_versions (id, tenant_id, factory_id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_business_evidence_links_blueprint_version
  ON business_evidence_links (tenant_id, factory_id, blueprint_id, blueprint_version_id, target_type, target_id);

CREATE OR REPLACE FUNCTION factoryos_cbb_guard_evidence_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_row business_evidence%ROWTYPE;
BEGIN
  IF NEW.source_key IS NULL THEN
    -- Legacy evidence remains readable during staged migration; all new API
    -- writes populate source_key and therefore use the strict contract below.
    RETURN NEW;
  END IF;

  NEW.source_key := btrim(NEW.source_key);
  IF length(NEW.source_key) = 0 OR length(NEW.source_key) > 1000 THEN
    RAISE EXCEPTION 'CBB_EVIDENCE_SOURCE_KEY_INVALID'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.source_timestamp IS NULL THEN
    RAISE EXCEPTION 'CBB_EVIDENCE_SOURCE_TIMESTAMP_REQUIRED'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.content_hash IS NULL OR NEW.content_hash !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'CBB_EVIDENCE_SHA256_REQUIRED'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.source_uri IS NOT NULL AND NEW.source_uri !~* '^https?://' THEN
    RAISE EXCEPTION 'CBB_EVIDENCE_SOURCE_URI_INVALID'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.supersedes_evidence_id IS NULL THEN
    IF NEW.revision_no <> 1 THEN
      RAISE EXCEPTION 'CBB_EVIDENCE_REVISION_MUST_LINK_PREDECESSOR'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO parent_row
    FROM business_evidence
    WHERE id = NEW.supersedes_evidence_id
      AND tenant_id = NEW.tenant_id
      AND factory_id = NEW.factory_id
      AND source_key = NEW.source_key
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CBB_EVIDENCE_PREDECESSOR_SCOPE_OR_SOURCE_MISMATCH'
        USING ERRCODE = '23503';
    END IF;

    IF NEW.revision_no <> parent_row.revision_no + 1 THEN
      RAISE EXCEPTION 'CBB_EVIDENCE_REVISION_SEQUENCE_INVALID'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.content_hash = parent_row.content_hash THEN
      RAISE EXCEPTION 'CBB_EVIDENCE_IDENTICAL_CONTENT_IS_REPLAY'
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1 FROM business_evidence newer
      WHERE newer.tenant_id = NEW.tenant_id
        AND newer.factory_id = NEW.factory_id
        AND newer.source_key = NEW.source_key
        AND newer.revision_no > parent_row.revision_no
    ) THEN
      RAISE EXCEPTION 'CBB_EVIDENCE_PREDECESSOR_IS_NOT_LATEST'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_evidence_revision_guard ON business_evidence;
CREATE TRIGGER business_evidence_revision_guard
BEFORE INSERT ON business_evidence
FOR EACH ROW EXECUTE FUNCTION factoryos_cbb_guard_evidence_revision();

CREATE OR REPLACE FUNCTION factoryos_cbb_reject_evidence_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CBB_EVIDENCE_IS_IMMUTABLE; create a new source revision'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS business_evidence_immutable ON business_evidence;
CREATE TRIGGER business_evidence_immutable
BEFORE UPDATE OR DELETE ON business_evidence
FOR EACH ROW EXECUTE FUNCTION factoryos_cbb_reject_evidence_mutation();

CREATE OR REPLACE FUNCTION factoryos_cbb_validate_evidence_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  bp_id UUID;
  version_id UUID;
  is_valid BOOLEAN := FALSE;
BEGIN
  NEW.target_type := upper(btrim(NEW.target_type));
  NEW.link_type := upper(btrim(NEW.link_type));
  IF NEW.link_type NOT IN ('SUPPORTS','CONTRADICTS','SUPERSEDES','RELATED_TO') THEN
    RAISE EXCEPTION 'CBB_EVIDENCE_LINK_TYPE_INVALID'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.target_type = 'BLUEPRINT' THEN
    SELECT b.id, b.current_version_id INTO bp_id, version_id
    FROM business_blueprints b
    WHERE b.id = NEW.target_id
      AND b.tenant_id = NEW.tenant_id
      AND b.factory_id = NEW.factory_id
      AND b.status = 'ACTIVE'
    FOR SHARE;
    is_valid := bp_id IS NOT NULL AND version_id IS NOT NULL;
  ELSIF NEW.target_type = 'ENTITY' THEN
    SELECT e.blueprint_version_id, v.blueprint_id INTO version_id, bp_id
    FROM business_entities e JOIN business_blueprint_versions v
      ON v.id = e.blueprint_version_id AND v.tenant_id = e.tenant_id AND v.factory_id = e.factory_id
    WHERE e.id = NEW.target_id AND e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    LIMIT 1 FOR SHARE OF e;
    is_valid := version_id IS NOT NULL;
  ELSIF NEW.target_type = 'RELATION' THEN
    SELECT e.blueprint_version_id, v.blueprint_id INTO version_id, bp_id
    FROM business_relations e JOIN business_blueprint_versions v
      ON v.id = e.blueprint_version_id AND v.tenant_id = e.tenant_id AND v.factory_id = e.factory_id
    WHERE e.id = NEW.target_id AND e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    LIMIT 1 FOR SHARE OF e;
    is_valid := version_id IS NOT NULL;
  ELSIF NEW.target_type = 'PROCESS' THEN
    SELECT e.blueprint_version_id, v.blueprint_id INTO version_id, bp_id
    FROM business_processes e JOIN business_blueprint_versions v
      ON v.id = e.blueprint_version_id AND v.tenant_id = e.tenant_id AND v.factory_id = e.factory_id
    WHERE e.id = NEW.target_id AND e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    LIMIT 1 FOR SHARE OF e;
    is_valid := version_id IS NOT NULL;
  ELSIF NEW.target_type = 'PROCESS_STEP' THEN
    SELECT e.blueprint_version_id, v.blueprint_id INTO version_id, bp_id
    FROM business_process_steps e JOIN business_blueprint_versions v
      ON v.id = e.blueprint_version_id AND v.tenant_id = e.tenant_id AND v.factory_id = e.factory_id
    WHERE e.id = NEW.target_id AND e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    LIMIT 1 FOR SHARE OF e;
    is_valid := version_id IS NOT NULL;
  ELSIF NEW.target_type = 'RULE' THEN
    SELECT e.blueprint_version_id, v.blueprint_id INTO version_id, bp_id
    FROM business_rules e JOIN business_blueprint_versions v
      ON v.id = e.blueprint_version_id AND v.tenant_id = e.tenant_id AND v.factory_id = e.factory_id
    WHERE e.id = NEW.target_id AND e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    LIMIT 1 FOR SHARE OF e;
    is_valid := version_id IS NOT NULL;
  ELSIF NEW.target_type = 'TERM' THEN
    SELECT e.blueprint_version_id, v.blueprint_id INTO version_id, bp_id
    FROM business_terms e JOIN business_blueprint_versions v
      ON v.id = e.blueprint_version_id AND v.tenant_id = e.tenant_id AND v.factory_id = e.factory_id
    WHERE e.id = NEW.target_id AND e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    LIMIT 1 FOR SHARE OF e;
    is_valid := version_id IS NOT NULL;
  ELSIF NEW.target_type = 'EXCEPTION' THEN
    SELECT e.blueprint_version_id, v.blueprint_id INTO version_id, bp_id
    FROM business_exceptions e JOIN business_blueprint_versions v
      ON v.id = e.blueprint_version_id AND v.tenant_id = e.tenant_id AND v.factory_id = e.factory_id
    WHERE e.id = NEW.target_id AND e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    LIMIT 1 FOR SHARE OF e;
    is_valid := version_id IS NOT NULL;
  END IF;

  IF NOT is_valid THEN
    RAISE EXCEPTION 'CBB_EVIDENCE_TARGET_NOT_FOUND_IN_FACTORY'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.blueprint_id IS NOT NULL AND NEW.blueprint_id <> bp_id THEN
    RAISE EXCEPTION 'CBB_EVIDENCE_BLUEPRINT_SCOPE_MISMATCH'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.blueprint_version_id IS NOT NULL AND NEW.blueprint_version_id <> version_id THEN
    RAISE EXCEPTION 'CBB_EVIDENCE_BLUEPRINT_VERSION_MISMATCH'
      USING ERRCODE = '23503';
  END IF;

  NEW.blueprint_id := bp_id;
  NEW.blueprint_version_id := version_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_evidence_links_validate ON business_evidence_links;
CREATE TRIGGER business_evidence_links_validate
BEFORE INSERT ON business_evidence_links
FOR EACH ROW EXECUTE FUNCTION factoryos_cbb_validate_evidence_link();

CREATE OR REPLACE FUNCTION factoryos_cbb_reject_evidence_link_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CBB_EVIDENCE_LINK_IS_IMMUTABLE'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS business_evidence_links_immutable ON business_evidence_links;
CREATE TRIGGER business_evidence_links_immutable
BEFORE UPDATE OR DELETE ON business_evidence_links
FOR EACH ROW EXECUTE FUNCTION factoryos_cbb_reject_evidence_link_mutation();

-- Conflict records are reviewable state, but their identity and evidence
-- ledger cannot be rewritten. Closing is an optimistic, single terminal transition.
ALTER TABLE business_conflicts
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS resolution_reason TEXT,
  ADD COLUMN IF NOT EXISTS resolution_evidence_id UUID;

DO $
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='business_conflicts'::regclass AND conname='chk_business_conflicts_version_positive') THEN
    ALTER TABLE business_conflicts ADD CONSTRAINT chk_business_conflicts_version_positive CHECK (version >= 1);
  END IF;
END $;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'business_conflicts'::regclass
      AND conname = 'uq_business_conflicts_id_scope'
  ) THEN
    ALTER TABLE business_conflicts
      ADD CONSTRAINT uq_business_conflicts_id_scope
      UNIQUE (id, tenant_id, factory_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'business_conflicts'::regclass
      AND conname = 'fk_business_conflicts_resolution_evidence'
  ) THEN
    ALTER TABLE business_conflicts
      ADD CONSTRAINT fk_business_conflicts_resolution_evidence
      FOREIGN KEY (resolution_evidence_id, tenant_id, factory_id)
      REFERENCES business_evidence (id, tenant_id, factory_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS business_conflict_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conflict_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  version INTEGER NOT NULL,
  action VARCHAR(30) NOT NULL,
  from_status VARCHAR(30),
  to_status VARCHAR(30) NOT NULL,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  actor_user_id UUID,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_business_conflict_history_scope
    FOREIGN KEY (conflict_id, tenant_id, factory_id)
    REFERENCES business_conflicts (id, tenant_id, factory_id)
    ON DELETE CASCADE,
  CONSTRAINT chk_business_conflict_history_action
    CHECK (action IN ('OPENED','EVIDENCE_ADDED','RESOLVED','DISMISSED')),
  CONSTRAINT chk_business_conflict_history_refs
    CHECK (jsonb_typeof(evidence_refs) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_business_conflict_history_scope
  ON business_conflict_history (tenant_id, factory_id, conflict_id, version DESC);

CREATE OR REPLACE FUNCTION factoryos_cbb_guard_conflict_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  evidence_id_text TEXT;
  target_exists BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.subject_type := upper(btrim(NEW.subject_type));
    IF NEW.status <> 'OPEN' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'CBB_CONFLICT_MUST_START_OPEN'
        USING ERRCODE = '23514';
    END IF;
    IF jsonb_typeof(NEW.evidence_refs) <> 'array' THEN
      RAISE EXCEPTION 'CBB_CONFLICT_EVIDENCE_REFS_MUST_BE_ARRAY'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD.status <> 'OPEN' THEN
      RAISE EXCEPTION 'CBB_CONFLICT_IS_TERMINAL'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
       OR NEW.factory_id <> OLD.factory_id OR NEW.blueprint_id <> OLD.blueprint_id
       OR NEW.subject_type <> OLD.subject_type OR NEW.subject_id <> OLD.subject_id
       OR NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.description IS DISTINCT FROM OLD.description THEN
      RAISE EXCEPTION 'CBB_CONFLICT_IDENTITY_IS_IMMUTABLE'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'CBB_CONFLICT_EXPECTED_VERSION_MISMATCH'
        USING ERRCODE = '40001';
    END IF;
    IF NEW.status = 'OPEN' THEN
      IF NOT (OLD.evidence_refs <@ NEW.evidence_refs) OR NEW.evidence_refs = OLD.evidence_refs
         OR jsonb_array_length(NEW.evidence_refs) <> (
           SELECT COUNT(DISTINCT value) FROM jsonb_array_elements_text(NEW.evidence_refs) AS evidence(value)
         )
         OR NEW.resolved_by IS NOT NULL
         OR NEW.resolved_at IS NOT NULL OR NEW.resolution_reason IS NOT NULL
         OR NEW.resolution_evidence_id IS NOT NULL OR NEW.resolution_ref IS NOT NULL THEN
        RAISE EXCEPTION 'CBB_CONFLICT_EVIDENCE_CAN_ONLY_APPEND_WHILE_OPEN'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.status IN ('RESOLVED','DISMISSED') THEN
      IF NEW.resolved_by IS NULL OR NEW.resolved_at IS NULL
         OR NEW.resolution_reason IS NULL OR length(btrim(NEW.resolution_reason)) < 10
         OR NEW.resolution_ref IS NULL OR length(btrim(NEW.resolution_ref)) < 10 THEN
        RAISE EXCEPTION 'CBB_CONFLICT_DECISION_EVIDENCE_REQUIRED'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.status = 'RESOLVED' AND NEW.resolution_evidence_id IS NULL THEN
        RAISE EXCEPTION 'CBB_CONFLICT_RESOLUTION_EVIDENCE_REQUIRED'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.resolution_evidence_id IS NOT NULL
        AND NOT (NEW.evidence_refs @> jsonb_build_array(NEW.resolution_evidence_id::text)) THEN
        RAISE EXCEPTION 'CBB_CONFLICT_RESOLUTION_EVIDENCE_NOT_ATTACHED'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'CBB_CONFLICT_STATUS_TRANSITION_INVALID'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  FOR evidence_id_text IN SELECT jsonb_array_elements_text(NEW.evidence_refs) LOOP
    IF evidence_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR NOT EXISTS (
        SELECT 1 FROM business_evidence e
        WHERE e.id = evidence_id_text::uuid
          AND e.tenant_id = NEW.tenant_id
          AND e.factory_id = NEW.factory_id
      ) THEN
      RAISE EXCEPTION 'CBB_CONFLICT_EVIDENCE_SCOPE_INVALID'
        USING ERRCODE = '23503';
    END IF;
  END LOOP;

  IF NEW.resolution_evidence_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM business_evidence e
    WHERE e.id = NEW.resolution_evidence_id
      AND e.tenant_id = NEW.tenant_id
      AND e.factory_id = NEW.factory_id
  ) THEN
    RAISE EXCEPTION 'CBB_CONFLICT_RESOLUTION_EVIDENCE_SCOPE_INVALID'
      USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM business_blueprint_versions v
    WHERE v.blueprint_id = NEW.blueprint_id
      AND v.tenant_id = NEW.tenant_id
      AND v.factory_id = NEW.factory_id
      AND CASE NEW.subject_type
        WHEN 'BLUEPRINT' THEN v.blueprint_id = NEW.subject_id
        WHEN 'ENTITY' THEN EXISTS (SELECT 1 FROM business_entities x WHERE x.id=NEW.subject_id AND x.blueprint_version_id=v.id AND x.tenant_id=NEW.tenant_id AND x.factory_id=NEW.factory_id)
        WHEN 'RELATION' THEN EXISTS (SELECT 1 FROM business_relations x WHERE x.id=NEW.subject_id AND x.blueprint_version_id=v.id AND x.tenant_id=NEW.tenant_id AND x.factory_id=NEW.factory_id)
        WHEN 'PROCESS' THEN EXISTS (SELECT 1 FROM business_processes x WHERE x.id=NEW.subject_id AND x.blueprint_version_id=v.id AND x.tenant_id=NEW.tenant_id AND x.factory_id=NEW.factory_id)
        WHEN 'PROCESS_STEP' THEN EXISTS (SELECT 1 FROM business_process_steps x WHERE x.id=NEW.subject_id AND x.blueprint_version_id=v.id AND x.tenant_id=NEW.tenant_id AND x.factory_id=NEW.factory_id)
        WHEN 'RULE' THEN EXISTS (SELECT 1 FROM business_rules x WHERE x.id=NEW.subject_id AND x.blueprint_version_id=v.id AND x.tenant_id=NEW.tenant_id AND x.factory_id=NEW.factory_id)
        WHEN 'TERM' THEN EXISTS (SELECT 1 FROM business_terms x WHERE x.id=NEW.subject_id AND x.blueprint_version_id=v.id AND x.tenant_id=NEW.tenant_id AND x.factory_id=NEW.factory_id)
        WHEN 'EXCEPTION' THEN EXISTS (SELECT 1 FROM business_exceptions x WHERE x.id=NEW.subject_id AND x.blueprint_version_id=v.id AND x.tenant_id=NEW.tenant_id AND x.factory_id=NEW.factory_id)
        ELSE FALSE
      END
  ) THEN
    RAISE EXCEPTION 'CBB_CONFLICT_SUBJECT_NOT_FOUND_IN_BLUEPRINT'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_conflicts_guard_transition ON business_conflicts;
CREATE TRIGGER business_conflicts_guard_transition
BEFORE INSERT OR UPDATE ON business_conflicts
FOR EACH ROW EXECUTE FUNCTION factoryos_cbb_guard_conflict_transition();

CREATE OR REPLACE FUNCTION factoryos_cbb_record_conflict_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  action_name VARCHAR(30);
  old_status VARCHAR(30);
  actor_id UUID;
  reason_text TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    action_name := 'OPENED';
    old_status := NULL;
    actor_id := NEW.created_by;
    reason_text := NEW.description;
  ELSIF OLD.status = 'OPEN' AND NEW.status = 'OPEN' THEN
    action_name := 'EVIDENCE_ADDED';
    old_status := OLD.status;
    actor_id := NEW.created_by;
    reason_text := 'Additional conflicting evidence attached';
  ELSIF NEW.status = 'RESOLVED' THEN
    action_name := 'RESOLVED';
    old_status := OLD.status;
    actor_id := NEW.resolved_by;
    reason_text := NEW.resolution_reason;
  ELSE
    action_name := 'DISMISSED';
    old_status := OLD.status;
    actor_id := NEW.resolved_by;
    reason_text := NEW.resolution_reason;
  END IF;

  INSERT INTO business_conflict_history (
    conflict_id, tenant_id, factory_id, version, action, from_status, to_status,
    evidence_refs, actor_user_id, reason
  ) VALUES (
    NEW.id, NEW.tenant_id, NEW.factory_id, NEW.version, action_name, old_status, NEW.status,
    NEW.evidence_refs, actor_id, reason_text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_conflicts_record_history ON business_conflicts;
CREATE TRIGGER business_conflicts_record_history
AFTER INSERT OR UPDATE ON business_conflicts
FOR EACH ROW EXECUTE FUNCTION factoryos_cbb_record_conflict_history();

CREATE OR REPLACE FUNCTION factoryos_cbb_guard_conflict_history_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $
BEGIN
  -- Only the AFTER trigger on business_conflicts may append history.
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'CBB_CONFLICT_HISTORY_IS_TRIGGER_MANAGED'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$;

DROP TRIGGER IF EXISTS business_conflict_history_guard_insert ON business_conflict_history;
CREATE TRIGGER business_conflict_history_guard_insert
BEFORE INSERT ON business_conflict_history
FOR EACH ROW EXECUTE FUNCTION factoryos_cbb_guard_conflict_history_insert();

CREATE OR REPLACE FUNCTION factoryos_cbb_reject_conflict_history_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $
BEGIN
  -- Permit only a cascade delete caused by deleting its scoped parent conflict;
  -- direct attempts to rewrite or delete audit history are rejected.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'CBB_CONFLICT_HISTORY_IS_APPEND_ONLY'
    USING ERRCODE = '55000';
END;
$;

DROP TRIGGER IF EXISTS business_conflict_history_immutable ON business_conflict_history;
CREATE TRIGGER business_conflict_history_immutable
BEFORE UPDATE OR DELETE ON business_conflict_history
FOR EACH ROW EXECUTE FUNCTION factoryos_cbb_reject_conflict_history_update();

ALTER TABLE business_conflict_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_conflict_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_conflict_history_tenant_isolation ON business_conflict_history;
CREATE POLICY business_conflict_history_tenant_isolation
ON business_conflict_history
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version, checksum)
VALUES ('131_cbb_evidence_provenance', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
