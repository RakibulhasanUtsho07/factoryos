BEGIN;

-- Round 26: CBB role-aware access, staleness review, terminology aliases,
-- impact links, and append-only rollback receipts.

CREATE TABLE IF NOT EXISTS business_cbb_staleness_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  blueprint_id UUID NOT NULL,
  blueprint_version_id UUID NOT NULL,
  target_type VARCHAR(30) NOT NULL,
  target_id UUID NOT NULL,
  last_evidence_at TIMESTAMPTZ,
  stale_threshold_days INTEGER NOT NULL,
  review_status VARCHAR(30) NOT NULL DEFAULT 'OPEN',
  review_version INTEGER NOT NULL DEFAULT 1,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  review_reason TEXT,
  last_scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_cbb_staleness_blueprint_scope
    FOREIGN KEY (blueprint_id, tenant_id, factory_id)
    REFERENCES business_blueprints (id, tenant_id, factory_id) ON DELETE CASCADE,
  CONSTRAINT fk_cbb_staleness_version_scope
    FOREIGN KEY (blueprint_version_id, tenant_id, factory_id)
    REFERENCES business_blueprint_versions (id, tenant_id, factory_id) ON DELETE CASCADE,
  CONSTRAINT chk_cbb_staleness_target_type
    CHECK (target_type IN ('ENTITY','RELATION','PROCESS','PROCESS_STEP','RULE','TERM','EXCEPTION')),
  CONSTRAINT chk_cbb_staleness_threshold
    CHECK (stale_threshold_days BETWEEN 1 AND 3650),
  CONSTRAINT chk_cbb_staleness_status
    CHECK (review_status IN ('OPEN','MARKED_STALE','RECONFIRMED','DISMISSED')),
  CONSTRAINT chk_cbb_staleness_version
    CHECK (review_version >= 1),
  CONSTRAINT chk_cbb_staleness_decision
    CHECK ((review_status = 'OPEN' AND reviewed_by IS NULL AND reviewed_at IS NULL)
       OR (review_status <> 'OPEN' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cbb_staleness_review_subject
  ON business_cbb_staleness_reviews
     (tenant_id, factory_id, blueprint_version_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_cbb_staleness_open_scope
  ON business_cbb_staleness_reviews (tenant_id, factory_id, review_status, last_scanned_at DESC);

CREATE TABLE IF NOT EXISTS business_terminology_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  alias VARCHAR(300) NOT NULL,
  canonical_term VARCHAR(300) NOT NULL,
  language_code VARCHAR(20),
  source_system VARCHAR(150),
  state VARCHAR(30) NOT NULL DEFAULT 'PROPOSED',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT fk_cbb_terminology_factory_scope
    FOREIGN KEY (factory_id, tenant_id) REFERENCES factories (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT chk_cbb_terminology_alias
    CHECK (length(btrim(alias)) BETWEEN 1 AND 300),
  CONSTRAINT chk_cbb_terminology_canonical
    CHECK (length(btrim(canonical_term)) BETWEEN 1 AND 300),
  CONSTRAINT chk_cbb_terminology_state
    CHECK (state IN ('VERIFIED','INFERRED','PROPOSED','CONFLICTING','STALE')),
  CONSTRAINT chk_cbb_terminology_version
    CHECK (version >= 1),
  CONSTRAINT chk_cbb_terminology_metadata
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cbb_terminology_alias_scope
  ON business_terminology_aliases (tenant_id, factory_id, lower(alias));
CREATE INDEX IF NOT EXISTS idx_cbb_terminology_canonical_scope
  ON business_terminology_aliases (tenant_id, factory_id, lower(canonical_term), state);

CREATE TABLE IF NOT EXISTS business_terminology_alias_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  alias_id UUID NOT NULL,
  alias_version INTEGER NOT NULL,
  action VARCHAR(30) NOT NULL,
  snapshot JSONB NOT NULL,
  actor_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_cbb_terminology_history_action
    CHECK (action IN ('CREATED','UPDATED','RETIRED','RECONFIRMED')),
  CONSTRAINT chk_cbb_terminology_history_snapshot
    CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_cbb_terminology_history_scope
  ON business_terminology_alias_history (tenant_id, factory_id, alias_id, alias_version DESC);

CREATE TABLE IF NOT EXISTS business_cbb_impact_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  blueprint_id UUID NOT NULL,
  blueprint_version_id UUID NOT NULL,
  source_type VARCHAR(30) NOT NULL,
  source_id UUID NOT NULL,
  impacted_type VARCHAR(50) NOT NULL,
  impacted_ref VARCHAR(300) NOT NULL,
  impact_type VARCHAR(50) NOT NULL DEFAULT 'DEPENDS_ON',
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_cbb_impact_blueprint_scope
    FOREIGN KEY (blueprint_id, tenant_id, factory_id)
    REFERENCES business_blueprints (id, tenant_id, factory_id) ON DELETE CASCADE,
  CONSTRAINT fk_cbb_impact_version_scope
    FOREIGN KEY (blueprint_version_id, tenant_id, factory_id)
    REFERENCES business_blueprint_versions (id, tenant_id, factory_id) ON DELETE CASCADE,
  CONSTRAINT chk_cbb_impact_source_type
    CHECK (source_type IN ('ENTITY','RELATION','PROCESS','PROCESS_STEP','RULE','TERM','EXCEPTION')),
  CONSTRAINT chk_cbb_impact_impacted_type
    CHECK (impacted_type IN ('PROCESS','RULE','TERM','EXCEPTION','KPI','ORDER','ANALYST_WORKFLOW','SYSTEM','OTHER')),
  CONSTRAINT chk_cbb_impact_kind
    CHECK (impact_type IN ('DEPENDS_ON','AFFECTS','OWNED_BY','MEASURES','CONSUMED_BY','BLOCKS','RELATED_TO')),
  CONSTRAINT chk_cbb_impact_ref
    CHECK (length(btrim(impacted_ref)) BETWEEN 1 AND 300),
  CONSTRAINT chk_cbb_impact_metadata
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cbb_impact_link
  ON business_cbb_impact_links
    (tenant_id, factory_id, blueprint_version_id, source_type, source_id, impacted_type, lower(impacted_ref), impact_type);
CREATE INDEX IF NOT EXISTS idx_cbb_impact_source
  ON business_cbb_impact_links (tenant_id, factory_id, blueprint_version_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_cbb_impact_ref
  ON business_cbb_impact_links (tenant_id, factory_id, impacted_type, lower(impacted_ref));

CREATE TABLE IF NOT EXISTS business_cbb_rollback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  blueprint_id UUID NOT NULL,
  from_version_id UUID NOT NULL,
  restored_from_version_id UUID NOT NULL,
  to_version_id UUID NOT NULL,
  reason TEXT NOT NULL,
  actor_user_id UUID NOT NULL,
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_cbb_rollback_blueprint_scope
    FOREIGN KEY (blueprint_id, tenant_id, factory_id)
    REFERENCES business_blueprints (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_cbb_rollback_from_version_scope
    FOREIGN KEY (from_version_id, tenant_id, factory_id)
    REFERENCES business_blueprint_versions (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_cbb_rollback_restored_version_scope
    FOREIGN KEY (restored_from_version_id, tenant_id, factory_id)
    REFERENCES business_blueprint_versions (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_cbb_rollback_to_version_scope
    FOREIGN KEY (to_version_id, tenant_id, factory_id)
    REFERENCES business_blueprint_versions (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_cbb_rollback_reason
    CHECK (length(btrim(reason)) >= 10)
);

CREATE INDEX IF NOT EXISTS idx_cbb_rollback_scope
  ON business_cbb_rollback_events (tenant_id, factory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS business_acl_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  acl_id UUID NOT NULL,
  action VARCHAR(30) NOT NULL,
  snapshot JSONB NOT NULL,
  actor_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_business_acl_history_action CHECK (action IN ('GRANTED','REVOKED','CHANGED')),
  CONSTRAINT chk_business_acl_history_snapshot CHECK (jsonb_typeof(snapshot) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_business_acl_history_scope
  ON business_acl_history (tenant_id, factory_id, created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_cbb_record_acl_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  row_data JSONB;
  actor UUID;
  action_name VARCHAR(30);
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_data := to_jsonb(OLD);
    actor := NULLIF(current_setting('app.user_id', true), '')::uuid;
    action_name := 'REVOKED';
  ELSE
    row_data := to_jsonb(NEW);
    actor := COALESCE(NEW.created_by, NULLIF(current_setting('app.user_id', true), '')::uuid);
    action_name := CASE WHEN TG_OP = 'INSERT' THEN 'GRANTED' ELSE 'CHANGED' END;
  END IF;
  INSERT INTO business_acl_history (tenant_id, factory_id, acl_id, action, snapshot, actor_user_id)
  VALUES ((row_data->>'tenant_id')::uuid, (row_data->>'factory_id')::uuid,
          (row_data->>'id')::uuid, action_name, row_data, actor);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS business_acl_record_history ON business_acl;
CREATE TRIGGER business_acl_record_history
AFTER INSERT OR UPDATE OR DELETE ON business_acl
FOR EACH ROW EXECUTE FUNCTION factoryos_cbb_record_acl_history();

CREATE OR REPLACE FUNCTION factoryos_cbb_record_terminology_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  row_data JSONB;
  action_name VARCHAR(30);
  actor UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_data := to_jsonb(OLD);
    action_name := 'RETIRED';
    actor := NULLIF(current_setting('app.user_id', true), '')::uuid;
  ELSIF TG_OP = 'INSERT' THEN
    row_data := to_jsonb(NEW);
    action_name := 'CREATED';
    actor := COALESCE(NEW.updated_by, NEW.created_by, NULLIF(current_setting('app.user_id', true), '')::uuid);
  ELSE
    row_data := to_jsonb(NEW);
    action_name := CASE
      WHEN NEW.state = 'STALE' AND OLD.state IS DISTINCT FROM 'STALE' THEN 'RETIRED'
      WHEN NEW.state = 'VERIFIED' AND OLD.state IS DISTINCT FROM 'VERIFIED' THEN 'RECONFIRMED'
      ELSE 'UPDATED'
    END;
    actor := COALESCE(NEW.updated_by, NEW.created_by, NULLIF(current_setting('app.user_id', true), '')::uuid);
  END IF;
  INSERT INTO business_terminology_alias_history (
    tenant_id, factory_id, alias_id, alias_version, action, snapshot, actor_user_id
  ) VALUES (
    (row_data->>'tenant_id')::uuid, (row_data->>'factory_id')::uuid,
    (row_data->>'id')::uuid, (row_data->>'version')::integer,
    action_name, row_data, actor
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_terminology_alias_history_record ON business_terminology_aliases;
CREATE TRIGGER business_terminology_alias_history_record
AFTER INSERT OR UPDATE OR DELETE ON business_terminology_aliases
FOR EACH ROW EXECUTE FUNCTION factoryos_cbb_record_terminology_history();

CREATE OR REPLACE FUNCTION factoryos_cbb_reject_governance_history_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CBB_GOVERNANCE_HISTORY_IS_APPEND_ONLY' USING ERRCODE='55000';
END;
$$;
DROP TRIGGER IF EXISTS business_acl_history_immutable ON business_acl_history;
CREATE TRIGGER business_acl_history_immutable BEFORE UPDATE OR DELETE ON business_acl_history
FOR EACH ROW EXECUTE FUNCTION factoryos_cbb_reject_governance_history_mutation();
DROP TRIGGER IF EXISTS business_terminology_alias_history_immutable ON business_terminology_alias_history;
CREATE TRIGGER business_terminology_alias_history_immutable BEFORE UPDATE OR DELETE ON business_terminology_alias_history
FOR EACH ROW EXECUTE FUNCTION factoryos_cbb_reject_governance_history_mutation();
DROP TRIGGER IF EXISTS business_cbb_rollback_events_immutable ON business_cbb_rollback_events;
CREATE TRIGGER business_cbb_rollback_events_immutable BEFORE UPDATE OR DELETE ON business_cbb_rollback_events
FOR EACH ROW EXECUTE FUNCTION factoryos_cbb_reject_governance_history_mutation();
DROP TRIGGER IF EXISTS business_cbb_impact_links_immutable ON business_cbb_impact_links;
CREATE TRIGGER business_cbb_impact_links_immutable BEFORE UPDATE OR DELETE ON business_cbb_impact_links
FOR EACH ROW EXECUTE FUNCTION factoryos_cbb_reject_governance_history_mutation();

ALTER TABLE business_cbb_staleness_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_cbb_staleness_reviews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_cbb_staleness_reviews_tenant_isolation ON business_cbb_staleness_reviews;
CREATE POLICY business_cbb_staleness_reviews_tenant_isolation
ON business_cbb_staleness_reviews
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE business_terminology_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_terminology_aliases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_terminology_aliases_tenant_isolation ON business_terminology_aliases;
CREATE POLICY business_terminology_aliases_tenant_isolation
ON business_terminology_aliases
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE business_terminology_alias_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_terminology_alias_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_terminology_alias_history_tenant_isolation ON business_terminology_alias_history;
CREATE POLICY business_terminology_alias_history_tenant_isolation
ON business_terminology_alias_history
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE business_cbb_impact_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_cbb_impact_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_cbb_impact_links_tenant_isolation ON business_cbb_impact_links;
CREATE POLICY business_cbb_impact_links_tenant_isolation
ON business_cbb_impact_links
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE business_cbb_rollback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_cbb_rollback_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_cbb_rollback_events_tenant_isolation ON business_cbb_rollback_events;
CREATE POLICY business_cbb_rollback_events_tenant_isolation
ON business_cbb_rollback_events
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE business_acl_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_acl_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_acl_history_tenant_isolation ON business_acl_history;
CREATE POLICY business_acl_history_tenant_isolation
ON business_acl_history
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version, checksum)
VALUES ('132_cbb_governance', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
