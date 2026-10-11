BEGIN;

-- WP08/WP09 foundation: governed research provenance + reproducible growth decisions.
INSERT INTO permissions (code, description)
VALUES
  ('research.read', 'Read approved and tenant-scoped research sources, claims and knowledge releases'),
  ('research.write', 'Register tenant research sources, claims and relevance mappings'),
  ('research.review', 'Review research rights, evidence claims and knowledge release promotion'),
  ('growth.read', 'Read tenant/factory growth opportunities, scenarios and experiments'),
  ('growth.write', 'Create evidence-backed growth hypotheses and reproducible scenarios'),
  ('growth.review', 'Approve growth opportunities and controlled experiments')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('research.read', 'research.write', 'research.review',
                                 'growth.read', 'growth.write', 'growth.review')
WHERE r.code = 'ORG_ADMIN' AND r.is_system = true
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('research.read', 'research.write', 'growth.read', 'growth.write')
WHERE r.code = 'FACTORY_MANAGER'
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE research_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  namespace VARCHAR(20) NOT NULL DEFAULT 'TENANT',
  source_type VARCHAR(40) NOT NULL,
  title VARCHAR(1000) NOT NULL,
  authors JSONB NOT NULL DEFAULT '[]'::jsonb,
  publication_date DATE,
  doi VARCHAR(255),
  venue VARCHAR(500),
  abstract TEXT,
  source_url TEXT,
  license_status VARCHAR(40) NOT NULL DEFAULT 'UNKNOWN',
  access_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  rights_basis TEXT,
  license_reference TEXT,
  full_text_storage_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  untrusted_content BOOLEAN NOT NULL DEFAULT TRUE,
  source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  review_reason TEXT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_research_source_namespace UNIQUE (id, namespace),
  CONSTRAINT uq_research_source_scope UNIQUE (id, tenant_id, namespace),
  CONSTRAINT fk_research_source_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_source_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_source_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_source_scope CHECK (
    (namespace = 'GLOBAL' AND tenant_id IS NULL)
    OR (namespace = 'TENANT' AND tenant_id IS NOT NULL)
  ),
  CONSTRAINT chk_research_source_type CHECK (
    source_type IN ('DOI_METADATA', 'OPEN_ACCESS_REPOSITORY', 'PUBLISHER_FEED',
                    'INSTITUTIONAL_REPOSITORY', 'CUSTOMER_PROVIDED', 'STANDARD',
                    'VENDOR_MATERIAL', 'SURVEY', 'PREPRINT', 'OPINION')
  ),
  CONSTRAINT chk_research_source_license CHECK (
    license_status IN ('OPEN_ACCESS', 'LICENSED', 'USER_PROVIDED_AUTHORIZED',
                       'RESTRICTED', 'UNKNOWN')
  ),
  CONSTRAINT chk_research_source_access CHECK (
    access_status IN ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED')
  ),
  CONSTRAINT chk_research_source_title CHECK (length(btrim(title)) > 0),
  CONSTRAINT chk_research_source_authors CHECK (jsonb_typeof(authors) = 'array'),
  CONSTRAINT chk_research_source_metadata CHECK (jsonb_typeof(source_metadata) = 'object'),
  CONSTRAINT chk_research_source_storage_rights CHECK (
    NOT full_text_storage_allowed
    OR (
      license_status IN ('OPEN_ACCESS', 'LICENSED', 'USER_PROVIDED_AUTHORIZED')
      AND rights_basis IS NOT NULL
      AND length(btrim(rights_basis)) > 0
    )
  ),
  CONSTRAINT chk_research_source_approval_rights CHECK (
    access_status <> 'APPROVED'
    OR (
      license_status IN ('OPEN_ACCESS', 'LICENSED', 'USER_PROVIDED_AUTHORIZED')
      AND rights_basis IS NOT NULL
      AND length(btrim(rights_basis)) > 0
      AND reviewed_by IS NOT NULL
      AND reviewed_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX uq_research_source_global_doi
  ON research_sources (lower(doi))
  WHERE tenant_id IS NULL AND doi IS NOT NULL;
CREATE UNIQUE INDEX uq_research_source_tenant_doi
  ON research_sources (tenant_id, lower(doi))
  WHERE tenant_id IS NOT NULL AND doi IS NOT NULL;
CREATE INDEX idx_research_source_scope_status
  ON research_sources (tenant_id, namespace, access_status, ingested_at DESC);
CREATE INDEX idx_research_source_topic_search
  ON research_sources USING gin (source_metadata jsonb_path_ops);

CREATE TABLE research_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  namespace VARCHAR(20) NOT NULL,
  source_id UUID NOT NULL,
  claim_text TEXT NOT NULL,
  methodology TEXT,
  dataset_description TEXT,
  limitations TEXT,
  practical_implication TEXT,
  evidence_grade VARCHAR(20) NOT NULL DEFAULT 'UNASSESSED',
  evidence_strength VARCHAR(20) NOT NULL DEFAULT 'UNASSESSED',
  topic_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  provenance_ref JSONB NOT NULL,
  stored_excerpt TEXT,
  conflict_group_id UUID,
  status VARCHAR(20) NOT NULL DEFAULT 'PROPOSED',
  created_by UUID,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  review_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_research_claim_namespace UNIQUE (id, namespace),
  CONSTRAINT uq_research_claim_scope UNIQUE (id, tenant_id, namespace),
  CONSTRAINT fk_research_claim_source_namespace FOREIGN KEY (source_id, namespace)
    REFERENCES research_sources(id, namespace) ON DELETE RESTRICT,
  CONSTRAINT fk_research_claim_source_scope FOREIGN KEY (source_id, tenant_id, namespace)
    REFERENCES research_sources(id, tenant_id, namespace) ON DELETE RESTRICT,
  CONSTRAINT fk_research_claim_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_claim_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_claim_scope CHECK (
    (namespace = 'GLOBAL' AND tenant_id IS NULL)
    OR (namespace = 'TENANT' AND tenant_id IS NOT NULL)
  ),
  CONSTRAINT chk_research_claim_text CHECK (length(btrim(claim_text)) > 0),
  CONSTRAINT chk_research_claim_grade CHECK (evidence_grade IN ('A', 'B', 'C', 'D', 'UNASSESSED')),
  CONSTRAINT chk_research_claim_strength CHECK (evidence_strength IN ('STRONG', 'MODERATE', 'LIMITED', 'CONFLICTING', 'UNASSESSED')),
  CONSTRAINT chk_research_claim_tags CHECK (jsonb_typeof(topic_tags) = 'array'),
  CONSTRAINT chk_research_claim_provenance CHECK (jsonb_typeof(provenance_ref) = 'object'),
  CONSTRAINT chk_research_claim_excerpt CHECK (stored_excerpt IS NULL OR length(stored_excerpt) <= 4000),
  CONSTRAINT chk_research_claim_status CHECK (status IN ('PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED')),
  CONSTRAINT chk_research_claim_approval CHECK (
    status <> 'APPROVED'
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX idx_research_claim_source_status
  ON research_claims (source_id, status);
CREATE INDEX idx_research_claim_scope_status
  ON research_claims (tenant_id, namespace, status, created_at DESC);
CREATE INDEX idx_research_claim_tags
  ON research_claims USING gin (topic_tags);

CREATE TABLE research_claim_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  namespace VARCHAR(20) NOT NULL,
  claim_a_id UUID NOT NULL,
  claim_b_id UUID NOT NULL,
  relation_type VARCHAR(20) NOT NULL,
  context TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_research_link_a_namespace FOREIGN KEY (claim_a_id, namespace)
    REFERENCES research_claims(id, namespace) ON DELETE RESTRICT,
  CONSTRAINT fk_research_link_b_namespace FOREIGN KEY (claim_b_id, namespace)
    REFERENCES research_claims(id, namespace) ON DELETE RESTRICT,
  CONSTRAINT fk_research_link_a_scope FOREIGN KEY (claim_a_id, tenant_id, namespace)
    REFERENCES research_claims(id, tenant_id, namespace) ON DELETE RESTRICT,
  CONSTRAINT fk_research_link_b_scope FOREIGN KEY (claim_b_id, tenant_id, namespace)
    REFERENCES research_claims(id, tenant_id, namespace) ON DELETE RESTRICT,
  CONSTRAINT fk_research_link_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_link_scope CHECK (
    (namespace = 'GLOBAL' AND tenant_id IS NULL)
    OR (namespace = 'TENANT' AND tenant_id IS NOT NULL)
  ),
  CONSTRAINT chk_research_link_distinct_claims CHECK (claim_a_id <> claim_b_id),
  CONSTRAINT chk_research_link_type CHECK (relation_type IN ('SUPPORTS', 'CONTRADICTS', 'RELATED_TO')),
  CONSTRAINT chk_research_link_context CHECK (length(btrim(context)) > 0),
  CONSTRAINT uq_research_claim_link UNIQUE (claim_a_id, claim_b_id, relation_type)
);
CREATE INDEX idx_research_link_claim_b ON research_claim_links (claim_b_id, relation_type);

CREATE TABLE research_knowledge_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  namespace VARCHAR(20) NOT NULL,
  release_key VARCHAR(160) NOT NULL,
  version INTEGER NOT NULL,
  title VARCHAR(500) NOT NULL,
  claim_ids JSONB NOT NULL,
  source_list JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_grade VARCHAR(20) NOT NULL,
  effective_at TIMESTAMPTZ,
  owner_user_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  validation_report JSONB NOT NULL DEFAULT '{}'::jsonb,
  regression_evidence_ref TEXT,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_research_release_scope UNIQUE (id, tenant_id, namespace),
  CONSTRAINT fk_research_release_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_release_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_release_scope CHECK (
    (namespace = 'GLOBAL' AND tenant_id IS NULL)
    OR (namespace = 'TENANT' AND tenant_id IS NOT NULL)
  ),
  CONSTRAINT chk_research_release_key CHECK (length(btrim(release_key)) > 0),
  CONSTRAINT chk_research_release_version CHECK (version > 0),
  CONSTRAINT chk_research_release_title CHECK (length(btrim(title)) > 0),
  CONSTRAINT chk_research_release_claims CHECK (jsonb_typeof(claim_ids) = 'array' AND jsonb_array_length(claim_ids) > 0),
  CONSTRAINT chk_research_release_sources CHECK (jsonb_typeof(source_list) = 'array'),
  CONSTRAINT chk_research_release_validation CHECK (jsonb_typeof(validation_report) = 'object'),
  CONSTRAINT chk_research_release_grade CHECK (evidence_grade IN ('A', 'B', 'C', 'D', 'MIXED')),
  CONSTRAINT chk_research_release_status CHECK (status IN ('DRAFT', 'PROMOTED', 'REJECTED', 'RETIRED')),
  CONSTRAINT chk_research_release_promoted_evidence CHECK (
    status <> 'PROMOTED'
    OR (
      validation_report @> '{"consistencyPassed":true,"citationCoveragePassed":true,"rightsPassed":true,"safetyReviewed":true}'::jsonb
      AND regression_evidence_ref IS NOT NULL
      AND length(btrim(regression_evidence_ref)) > 0
      AND reviewed_by IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND effective_at IS NOT NULL
    )
  )
);
CREATE UNIQUE INDEX uq_research_release_tenant_version
  ON research_knowledge_releases (tenant_id, release_key, version)
  WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX uq_research_release_global_version
  ON research_knowledge_releases (release_key, version)
  WHERE tenant_id IS NULL;
CREATE INDEX idx_research_release_scope_status
  ON research_knowledge_releases (tenant_id, namespace, status, created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_research_release()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invalid_claim_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'PROMOTED' THEN
      RAISE EXCEPTION 'Promoted research knowledge releases are immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'PROMOTED' THEN
    RAISE EXCEPTION 'Promoted research knowledge releases are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'PROMOTED' THEN
    SELECT COUNT(*) INTO invalid_claim_count
    FROM jsonb_array_elements_text(NEW.claim_ids) AS ids(claim_id)
    LEFT JOIN research_claims c ON c.id = ids.claim_id::uuid
    WHERE c.id IS NULL
       OR c.status <> 'APPROVED'
       OR NOT (c.tenant_id IS NULL OR c.tenant_id = NEW.tenant_id);

    IF invalid_claim_count > 0 THEN
      RAISE EXCEPTION 'Research release can only include approved visible claims'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER research_knowledge_releases_guard
BEFORE INSERT OR UPDATE OR DELETE ON research_knowledge_releases
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_release();

CREATE TABLE research_relevance_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  research_claim_id UUID NOT NULL,
  business_entity_id UUID NOT NULL,
  relevance_rationale TEXT NOT NULL,
  client_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  counter_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  applicability_assumptions JSONB NOT NULL DEFAULT '[]'::jsonb,
  validation_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'PROPOSED',
  created_by UUID NOT NULL,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  review_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_research_relevance_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_research_relevance_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_relevance_claim FOREIGN KEY (research_claim_id)
    REFERENCES research_claims(id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_relevance_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_relevance_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_relevance_review CHECK ((status = 'PROPOSED' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (status <> 'PROPOSED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CONSTRAINT chk_research_relevance_rationale CHECK (length(btrim(relevance_rationale)) > 0),
  CONSTRAINT chk_research_relevance_client_evidence CHECK (jsonb_typeof(client_evidence) = 'array'),
  CONSTRAINT chk_research_relevance_counter_evidence CHECK (jsonb_typeof(counter_evidence) = 'array'),
  CONSTRAINT chk_research_relevance_assumptions CHECK (jsonb_typeof(applicability_assumptions) = 'array'),
  CONSTRAINT chk_research_relevance_plan CHECK (jsonb_typeof(validation_plan) = 'object'),
  CONSTRAINT chk_research_relevance_status CHECK (status IN ('PROPOSED', 'ACCEPTED', 'REJECTED'))
);
CREATE INDEX idx_research_relevance_claim ON research_relevance_mappings (tenant_id, factory_id, research_claim_id);

CREATE OR REPLACE FUNCTION factoryos_guard_research_claim_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $
DECLARE
  source_status TEXT;
  source_license TEXT;
  source_rights TEXT;
BEGIN
  IF NEW.status = 'APPROVED' THEN
    IF NEW.evidence_grade = 'UNASSESSED'
      OR NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL
      OR jsonb_typeof(NEW.provenance_ref) <> 'object'
      OR NEW.provenance_ref = '{}'::jsonb THEN
      RAISE EXCEPTION 'Research claims require an evidence grade, citation locator and reviewer before approval'
        USING ERRCODE = '23514';
    END IF;

    SELECT access_status, license_status, rights_basis
      INTO source_status, source_license, source_rights
    FROM research_sources
    WHERE id = NEW.source_id AND namespace = NEW.namespace
      AND (tenant_id IS NOT DISTINCT FROM NEW.tenant_id);

    IF NOT FOUND OR source_status <> 'APPROVED'
      OR source_license NOT IN ('OPEN_ACCESS', 'LICENSED', 'USER_PROVIDED_AUTHORIZED')
      OR source_rights IS NULL OR length(btrim(source_rights)) = 0 THEN
      RAISE EXCEPTION 'Research claims require an approved source with documented reuse rights'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$;
CREATE TRIGGER research_claim_approval_guard
BEFORE INSERT OR UPDATE ON research_claims
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_claim_approval();

CREATE OR REPLACE FUNCTION factoryos_guard_research_relevance()
RETURNS trigger
LANGUAGE plpgsql
AS $
DECLARE
  claim_status TEXT;
  source_status TEXT;
  entity_state TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.status <> 'PROPOSED' OR NEW.status NOT IN ('ACCEPTED', 'REJECTED') THEN
      RAISE EXCEPTION 'Invalid research relevance decision transition'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL THEN
      RAISE EXCEPTION 'Research relevance decisions require a reviewer'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT c.status, s.access_status
    INTO claim_status, source_status
  FROM research_claims c
  JOIN research_sources s ON s.id = c.source_id AND s.namespace = c.namespace
  WHERE c.id = NEW.research_claim_id
    AND (c.tenant_id IS NULL OR c.tenant_id = NEW.tenant_id);

  IF NOT FOUND OR claim_status <> 'APPROVED' OR source_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Research relevance mappings require an approved visible research claim'
      USING ERRCODE = '23514';
  END IF;

  SELECT state INTO entity_state FROM business_entities
  WHERE id = NEW.business_entity_id AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id AND state IN ('VERIFIED', 'INFERRED');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Research relevance mapping must target a visible verified or inferred CBB node'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$;
CREATE TRIGGER research_relevance_guard
BEFORE INSERT OR UPDATE ON research_relevance_mappings
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_relevance();

CREATE TABLE growth_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  title VARCHAR(300) NOT NULL,
  category VARCHAR(40) NOT NULL,
  opportunity_statement TEXT NOT NULL,
  success_hypothesis TEXT NOT NULL,
  assumptions JSONB NOT NULL,
  constraints_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  affected_business_nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_value_low NUMERIC(20, 4) NOT NULL,
  expected_value_high NUMERIC(20, 4) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'BDT',
  uncertainty_pct NUMERIC(7, 3) NOT NULL,
  effort VARCHAR(20) NOT NULL,
  time_to_impact_days INTEGER NOT NULL,
  implementation_risk VARCHAR(20) NOT NULL,
  owner_user_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  created_by UUID NOT NULL,
  decided_by UUID,
  decided_at TIMESTAMPTZ,
  decision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_growth_opportunity_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_growth_opportunity_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_opportunity_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_opportunity_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_opportunity_decider FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_opportunity_title CHECK (length(btrim(title)) > 0),
  CONSTRAINT chk_growth_opportunity_category CHECK (category IN (
    'REVENUE_GROWTH', 'MARGIN_EXPANSION', 'PRODUCT_MIX', 'CUSTOMER_EXPANSION',
    'MARKET_CHANNEL_EXPANSION', 'CAPACITY_UNLOCK', 'COST_REDUCTION',
    'WORKING_CAPITAL', 'RISK_REDUCTION', 'RESILIENCE', 'EXPORT_READINESS'
  )),
  CONSTRAINT chk_growth_opportunity_assumptions CHECK (jsonb_typeof(assumptions) = 'array' AND jsonb_array_length(assumptions) > 0),
  CONSTRAINT chk_growth_opportunity_constraints CHECK (jsonb_typeof(constraints_snapshot) = 'object'),
  CONSTRAINT chk_growth_opportunity_nodes CHECK (jsonb_typeof(affected_business_nodes) = 'array'),
  CONSTRAINT chk_growth_opportunity_value_range CHECK (expected_value_low <= expected_value_high),
  CONSTRAINT chk_growth_opportunity_currency CHECK (currency = upper(currency) AND currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_growth_opportunity_uncertainty CHECK (uncertainty_pct >= 0 AND uncertainty_pct <= 100),
  CONSTRAINT chk_growth_opportunity_effort CHECK (effort IN ('SMALL', 'MEDIUM', 'LARGE', 'UNKNOWN')),
  CONSTRAINT chk_growth_opportunity_days CHECK (time_to_impact_days >= 0),
  CONSTRAINT chk_growth_opportunity_risk CHECK (implementation_risk IN ('LOW', 'MEDIUM', 'HIGH', 'UNKNOWN')),
  CONSTRAINT chk_growth_opportunity_status CHECK (status IN ('DRAFT', 'PROPOSED', 'ACCEPTED', 'REJECTED', 'IN_PROGRESS', 'REALIZED', 'CLOSED')),
  CONSTRAINT chk_growth_opportunity_statement CHECK (length(btrim(opportunity_statement)) > 0 AND length(btrim(success_hypothesis)) > 0),
  CONSTRAINT chk_growth_opportunity_decision CHECK (
    (status IN ('DRAFT', 'PROPOSED') AND decided_by IS NULL AND decided_at IS NULL)
    OR (status NOT IN ('DRAFT', 'PROPOSED') AND (status = 'IN_PROGRESS' OR status = 'REALIZED' OR status = 'CLOSED' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)))
  )
);
CREATE INDEX idx_growth_opportunities_factory_status ON growth_opportunities (tenant_id, factory_id, status, created_at DESC);
CREATE INDEX idx_growth_opportunities_category ON growth_opportunities (tenant_id, factory_id, category, created_at DESC);

CREATE TABLE growth_opportunity_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  evidence_type VARCHAR(30) NOT NULL,
  origin_class VARCHAR(30) NOT NULL,
  research_claim_id UUID,
  business_entity_id UUID,
  reference_ref TEXT,
  citation_url TEXT,
  description TEXT NOT NULL,
  confidence NUMERIC(5, 4) NOT NULL DEFAULT 0.5,
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_by UUID NOT NULL,
  CONSTRAINT fk_growth_evidence_opportunity FOREIGN KEY (opportunity_id, tenant_id, factory_id)
    REFERENCES growth_opportunities(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_evidence_claim FOREIGN KEY (research_claim_id) REFERENCES research_claims(id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_evidence_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_evidence_type CHECK (evidence_type IN ('RESEARCH_CLAIM', 'CBB_ENTITY', 'OPERATIONAL_METRIC', 'MARKET_SIGNAL', 'CLIENT_DOCUMENT')),
  CONSTRAINT chk_growth_evidence_origin CHECK (origin_class IN ('EXTERNAL_RESEARCH', 'CLIENT_PRIVATE', 'OPERATIONAL', 'MARKET')),
  CONSTRAINT chk_growth_evidence_description CHECK (length(btrim(description)) > 0),
  CONSTRAINT chk_growth_evidence_confidence CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT chk_growth_evidence_snapshot CHECK (jsonb_typeof(evidence_snapshot) = 'object'),
  CONSTRAINT chk_growth_evidence_claim_ref CHECK (
    (evidence_type = 'RESEARCH_CLAIM' AND research_claim_id IS NOT NULL AND origin_class = 'EXTERNAL_RESEARCH')
    OR (evidence_type <> 'RESEARCH_CLAIM' AND research_claim_id IS NULL)
  ),
  CONSTRAINT chk_growth_evidence_cbb_ref CHECK (
    (evidence_type = 'CBB_ENTITY' AND business_entity_id IS NOT NULL AND origin_class = 'CLIENT_PRIVATE')
    OR (evidence_type <> 'CBB_ENTITY' AND business_entity_id IS NULL)
  )
);
CREATE INDEX idx_growth_evidence_opportunity ON growth_opportunity_evidence (tenant_id, factory_id, opportunity_id, captured_at);

CREATE TABLE growth_scenarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  scenario_name VARCHAR(200) NOT NULL,
  scenario_type VARCHAR(20) NOT NULL,
  model_version VARCHAR(100) NOT NULL,
  data_vintage TIMESTAMPTZ NOT NULL,
  baseline_source_ref TEXT NOT NULL,
  inputs JSONB NOT NULL,
  output_snapshot JSONB NOT NULL,
  input_hash VARCHAR(64) NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_growth_scenario_opportunity FOREIGN KEY (opportunity_id, tenant_id, factory_id)
    REFERENCES growth_opportunities(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_scenario_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_scenario_name CHECK (length(btrim(scenario_name)) > 0),
  CONSTRAINT chk_growth_scenario_type CHECK (scenario_type IN ('BASE', 'UPSIDE', 'DOWNSIDE', 'STRESS', 'CUSTOM')),
  CONSTRAINT chk_growth_scenario_source CHECK (length(btrim(baseline_source_ref)) > 0),
  CONSTRAINT chk_growth_scenario_inputs CHECK (jsonb_typeof(inputs) = 'object'),
  CONSTRAINT chk_growth_scenario_output CHECK (jsonb_typeof(output_snapshot) = 'object'),
  CONSTRAINT chk_growth_scenario_hash CHECK (input_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_growth_scenario_history ON growth_scenarios (tenant_id, factory_id, opportunity_id, created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_prevent_growth_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only evidence', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER growth_scenarios_immutable
BEFORE UPDATE OR DELETE ON growth_scenarios
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_growth_snapshot_mutation();
CREATE TRIGGER growth_opportunity_evidence_immutable
BEFORE UPDATE OR DELETE ON growth_opportunity_evidence
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_growth_snapshot_mutation();

CREATE OR REPLACE FUNCTION factoryos_guard_growth_evidence_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $
DECLARE
  claim_ok BOOLEAN;
  entity_ok BOOLEAN;
BEGIN
  IF NEW.evidence_type = 'RESEARCH_CLAIM' THEN
    SELECT EXISTS (
      SELECT 1
      FROM research_claims c
      JOIN research_sources s ON s.id = c.source_id AND s.namespace = c.namespace
      WHERE c.id = NEW.research_claim_id
        AND c.status = 'APPROVED'
        AND s.access_status = 'APPROVED'
        AND (c.tenant_id IS NULL OR c.tenant_id = NEW.tenant_id)
    ) INTO claim_ok;
    IF NOT claim_ok THEN
      RAISE EXCEPTION 'Growth research evidence must be an approved, visible, rights-cleared claim'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.evidence_type = 'CBB_ENTITY' THEN
    SELECT EXISTS (
      SELECT 1 FROM business_entities
      WHERE id = NEW.business_entity_id
        AND tenant_id = NEW.tenant_id
        AND factory_id = NEW.factory_id
        AND state IN ('VERIFIED', 'INFERRED')
    ) INTO entity_ok;
    IF NOT entity_ok THEN
      RAISE EXCEPTION 'Growth CBB evidence must be visible and verified/inferred'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$;
CREATE TRIGGER growth_evidence_scope_guard
BEFORE INSERT ON growth_opportunity_evidence
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_evidence_scope();

CREATE TABLE growth_experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  name VARCHAR(300) NOT NULL,
  objective TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  leading_indicators JSONB NOT NULL,
  duration_days INTEGER NOT NULL,
  owner_user_id UUID NOT NULL,
  baseline_measurements JSONB NOT NULL,
  stop_conditions JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PLANNED',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_growth_experiment_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_growth_experiment_opportunity FOREIGN KEY (opportunity_id, tenant_id, factory_id)
    REFERENCES growth_opportunities(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_experiment_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_experiment_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_experiment_name CHECK (length(btrim(name)) > 0),
  CONSTRAINT chk_growth_experiment_objective CHECK (length(btrim(objective)) > 0),
  CONSTRAINT chk_growth_experiment_hypothesis CHECK (length(btrim(hypothesis)) > 0),
  CONSTRAINT chk_growth_experiment_duration CHECK (duration_days BETWEEN 1 AND 3650),
  CONSTRAINT chk_growth_experiment_indicators CHECK (jsonb_typeof(leading_indicators) = 'array' AND jsonb_array_length(leading_indicators) > 0),
  CONSTRAINT chk_growth_experiment_baseline CHECK (jsonb_typeof(baseline_measurements) = 'object'),
  CONSTRAINT chk_growth_experiment_stop_conditions CHECK (jsonb_typeof(stop_conditions) = 'array' AND jsonb_array_length(stop_conditions) > 0),
  CONSTRAINT chk_growth_experiment_status CHECK (status IN ('PLANNED', 'RUNNING', 'COMPLETED', 'STOPPED')),
  CONSTRAINT chk_growth_experiment_lifecycle CHECK (
    (status = 'PLANNED' AND started_at IS NULL AND ended_at IS NULL)
    OR (status = 'RUNNING' AND started_at IS NOT NULL AND ended_at IS NULL)
    OR (status IN ('COMPLETED', 'STOPPED') AND started_at IS NOT NULL AND ended_at IS NOT NULL)
  )
);
CREATE INDEX idx_growth_experiments_opportunity ON growth_experiments (tenant_id, factory_id, opportunity_id, created_at DESC);

CREATE TABLE growth_experiment_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  experiment_id UUID NOT NULL,
  pre_measurements JSONB NOT NULL,
  post_measurements JSONB NOT NULL,
  assessment VARCHAR(20) NOT NULL,
  stop_condition_triggered BOOLEAN NOT NULL DEFAULT FALSE,
  result_notes TEXT,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL,
  recorded_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_growth_result_experiment FOREIGN KEY (experiment_id, tenant_id, factory_id)
    REFERENCES growth_experiments(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_result_actor FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT uq_growth_experiment_result_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT chk_growth_result_pre CHECK (jsonb_typeof(pre_measurements) = 'object'),
  CONSTRAINT chk_growth_result_post CHECK (jsonb_typeof(post_measurements) = 'object'),
  CONSTRAINT chk_growth_result_assessment CHECK (assessment IN ('POSITIVE', 'NEUTRAL', 'NEGATIVE', 'INCONCLUSIVE')),
  CONSTRAINT chk_growth_result_evidence CHECK (jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) > 0)
);
CREATE INDEX idx_growth_results_experiment ON growth_experiment_results (tenant_id, factory_id, experiment_id, observed_at DESC);

CREATE TABLE growth_opportunity_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  experiment_result_id UUID,
  assessment VARCHAR(20) NOT NULL,
  realized_metrics JSONB NOT NULL,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  recorded_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_growth_outcome_opportunity FOREIGN KEY (opportunity_id, tenant_id, factory_id)
    REFERENCES growth_opportunities(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_outcome_result FOREIGN KEY (experiment_result_id, tenant_id, factory_id) REFERENCES growth_experiment_results(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_outcome_actor FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_outcome_assessment CHECK (assessment IN ('POSITIVE', 'NEUTRAL', 'NEGATIVE', 'INCONCLUSIVE')),
  CONSTRAINT chk_growth_outcome_metrics CHECK (jsonb_typeof(realized_metrics) = 'object'),
  CONSTRAINT chk_growth_outcome_evidence CHECK (jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) > 0)
);
CREATE INDEX idx_growth_outcome_opportunity ON growth_opportunity_outcomes (tenant_id, factory_id, opportunity_id, observed_at DESC);

CREATE TRIGGER growth_experiment_results_immutable
BEFORE UPDATE OR DELETE ON growth_experiment_results
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_growth_snapshot_mutation();
CREATE TRIGGER growth_opportunity_outcomes_immutable
BEFORE UPDATE OR DELETE ON growth_opportunity_outcomes
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_growth_snapshot_mutation();

CREATE OR REPLACE FUNCTION factoryos_guard_growth_opportunity_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence_count INTEGER;
  outcome_count INTEGER;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'DRAFT' AND NEW.status IN ('PROPOSED', 'REJECTED'))
      OR (OLD.status = 'PROPOSED' AND NEW.status IN ('ACCEPTED', 'REJECTED'))
      OR (OLD.status = 'ACCEPTED' AND NEW.status IN ('IN_PROGRESS', 'CLOSED'))
      OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('REALIZED', 'CLOSED'))
      OR (OLD.status = 'REALIZED' AND NEW.status = 'CLOSED')
    ) THEN
      RAISE EXCEPTION 'Invalid growth opportunity status transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;

    IF NEW.status = 'ACCEPTED' THEN
      SELECT COUNT(*) INTO evidence_count
      FROM growth_opportunity_evidence
      WHERE opportunity_id = NEW.id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
      IF evidence_count = 0 OR length(btrim(NEW.success_hypothesis)) = 0 THEN
        RAISE EXCEPTION 'Growth opportunities require evidence and a measurable hypothesis before acceptance'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF NEW.status = 'REALIZED' THEN
      SELECT COUNT(*) INTO outcome_count
      FROM growth_opportunity_outcomes
      WHERE opportunity_id = NEW.id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
      IF outcome_count = 0 THEN
        RAISE EXCEPTION 'Growth opportunity cannot be marked REALIZED without outcome evidence'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER growth_opportunity_lifecycle
BEFORE UPDATE ON growth_opportunities
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_opportunity_lifecycle();

CREATE OR REPLACE FUNCTION factoryos_guard_growth_experiment_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'PLANNED' AND NEW.status IN ('RUNNING', 'STOPPED'))
      OR (OLD.status = 'RUNNING' AND NEW.status IN ('COMPLETED', 'STOPPED'))
    ) THEN
      RAISE EXCEPTION 'Invalid growth experiment status transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER growth_experiment_lifecycle
BEFORE UPDATE ON growth_experiments
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_experiment_lifecycle();

-- RLS: tenants may read approved global research material and their own rows,
-- but normal tenant sessions cannot create or mutate the GLOBAL namespace.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'research_sources', 'research_claims', 'research_claim_links', 'research_knowledge_releases'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id IS NULL OR tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id())',
      table_name || '_tenant_isolation', table_name);
  END LOOP;
END;
$$;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'research_relevance_mappings', 'growth_opportunities', 'growth_opportunity_evidence',
    'growth_scenarios', 'growth_experiments', 'growth_experiment_results', 'growth_opportunity_outcomes'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id())',
      table_name || '_tenant_isolation', table_name);
  END LOOP;
END;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('039_research_growth_intelligence', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
