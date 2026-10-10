BEGIN;

-- ============================================================
-- WP09-A / Growth opportunity registry and outcome ledger
-- ============================================================
-- Opportunity records are immutable, explicit hypotheses. Expected-value
-- ranges are scenarios/estimates, not guarantees. Observed outcomes are
-- recorded separately with a source-system and source-record reference.

INSERT INTO permissions (code, description)
VALUES
  ('growth.opportunities.read', 'Read factory-scoped growth opportunities and observed outcomes'),
  ('growth.opportunities.write', 'Register versioned growth opportunity hypotheses'),
  ('growth.opportunities.decisions.write', 'Record auditable decisions on growth opportunities'),
  ('growth.opportunities.outcomes.write', 'Record source-referenced growth opportunity measurements')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code IN (
    'growth.opportunities.read',
    'growth.opportunities.write',
    'growth.opportunities.decisions.write',
    'growth.opportunities.outcomes.write'
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS growth_opportunity_registry (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                UUID NOT NULL,
    factory_id               UUID NOT NULL,
    opportunity_key          VARCHAR(180) NOT NULL,
    opportunity_version      VARCHAR(60) NOT NULL,
    category                 VARCHAR(40) NOT NULL,
    statement                TEXT NOT NULL,
    evidence                 JSONB NOT NULL,
    assumptions              JSONB NOT NULL,
    affected_nodes           JSONB NOT NULL,
    expected_value_min       NUMERIC(20, 6) NOT NULL,
    expected_value_max       NUMERIC(20, 6) NOT NULL,
    expected_value_metric    VARCHAR(100) NOT NULL,
    expected_value_unit      VARCHAR(40) NOT NULL,
    expected_value_currency  VARCHAR(3) NOT NULL,
    uncertainty              JSONB NOT NULL,
    effort_estimate          NUMERIC(16, 4) NOT NULL,
    effort_unit              VARCHAR(20) NOT NULL,
    dependencies             JSONB NOT NULL,
    time_to_impact            VARCHAR(20) NOT NULL,
    impact_date_assumption   DATE,
    risk_class               VARCHAR(20) NOT NULL,
    validation_plan          TEXT NOT NULL,
    decision_owner_role      VARCHAR(100) NOT NULL,
    request_hash             VARCHAR(64) NOT NULL,
    idempotency_key          VARCHAR(128) NOT NULL,
    created_by               UUID NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_growth_opportunity_factory_scope
      FOREIGN KEY (factory_id, tenant_id)
      REFERENCES factories (id, tenant_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_growth_opportunity_actor
      FOREIGN KEY (created_by)
      REFERENCES users (id)
      ON DELETE RESTRICT,

    CONSTRAINT uq_growth_opportunity_scope_id
      UNIQUE (id, tenant_id, factory_id),

    CONSTRAINT chk_growth_opportunity_category
      CHECK (category IN (
        'REVENUE_GROWTH', 'MARGIN_EXPANSION', 'PRODUCT_MIX',
        'CUSTOMER_EXPANSION', 'MARKET_CHANNEL_EXPANSION', 'CAPACITY_UNLOCK',
        'COST_REDUCTION', 'WORKING_CAPITAL', 'RISK_REDUCTION'
      )),

    CONSTRAINT chk_growth_opportunity_versioned_key
      CHECK (
        opportunity_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$'
        AND opportunity_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,59}$'
      ),

    CONSTRAINT chk_growth_opportunity_statement
      CHECK (LENGTH(BTRIM(statement)) BETWEEN 1 AND 4000),

    CONSTRAINT chk_growth_opportunity_evidence
      CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) BETWEEN 1 AND 50),

    CONSTRAINT chk_growth_opportunity_assumptions
      CHECK (jsonb_typeof(assumptions) = 'array' AND jsonb_array_length(assumptions) BETWEEN 1 AND 100),

    CONSTRAINT chk_growth_opportunity_affected_nodes
      CHECK (jsonb_typeof(affected_nodes) = 'array' AND jsonb_array_length(affected_nodes) BETWEEN 1 AND 100),

    CONSTRAINT chk_growth_opportunity_value_range
      CHECK (
        expected_value_min <= expected_value_max
        AND expected_value_metric ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$'
        AND expected_value_unit ~ '^[a-zA-Z0-9][a-zA-Z0-9._/%-]{0,39}$'
        AND expected_value_currency ~ '^[A-Z]{3}$'
      ),

    CONSTRAINT chk_growth_opportunity_uncertainty
      CHECK (
        jsonb_typeof(uncertainty) = 'object'
        AND uncertainty ? 'level'
        AND uncertainty ? 'limitations'
        AND uncertainty ? 'sensitivity_factors'
        AND uncertainty ? 'evidence_gaps'
      ),

    CONSTRAINT chk_growth_opportunity_effort
      CHECK (effort_estimate >= 0 AND effort_unit IN ('PERSON_HOURS', 'PERSON_DAYS', 'PERSON_WEEKS')),

    CONSTRAINT chk_growth_opportunity_dependencies
      CHECK (jsonb_typeof(dependencies) = 'array' AND jsonb_array_length(dependencies) <= 100),

    CONSTRAINT chk_growth_opportunity_horizon
      CHECK (time_to_impact IN ('IMMEDIATE', 'NEAR_TERM', 'STRATEGIC')),

    CONSTRAINT chk_growth_opportunity_risk
      CHECK (risk_class IN ('OPERATIONAL', 'FINANCIAL', 'COMPLIANCE', 'STRATEGIC')),

    CONSTRAINT chk_growth_opportunity_request_hash
      CHECK (request_hash ~ '^[a-f0-9]{64}$'),

    CONSTRAINT chk_growth_opportunity_idempotency
      CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),

    CONSTRAINT chk_growth_opportunity_owner_role
      CHECK (decision_owner_role ~ '^[A-Z][A-Z0-9_.:-]{1,99}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_opportunity_scope_version
  ON growth_opportunity_registry (tenant_id, factory_id, opportunity_key, opportunity_version);

CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_opportunity_scope_idempotency
  ON growth_opportunity_registry (tenant_id, factory_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_growth_opportunity_scope_created
  ON growth_opportunity_registry (tenant_id, factory_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_growth_opportunity_scope_category
  ON growth_opportunity_registry (tenant_id, factory_id, category, created_at DESC, id DESC);

ALTER TABLE growth_opportunity_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_opportunity_registry FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS growth_opportunity_registry_tenant_isolation
  ON growth_opportunity_registry;
CREATE POLICY growth_opportunity_registry_tenant_isolation
  ON growth_opportunity_registry
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION reject_growth_opportunity_registry_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Growth opportunity versions are immutable; create a new version instead';
END;
$$;

DROP TRIGGER IF EXISTS trg_growth_opportunity_registry_immutable
  ON growth_opportunity_registry;
CREATE TRIGGER trg_growth_opportunity_registry_immutable
  BEFORE UPDATE OR DELETE ON growth_opportunity_registry
  FOR EACH ROW
  EXECUTE FUNCTION reject_growth_opportunity_registry_mutation();

CREATE TABLE IF NOT EXISTS growth_opportunity_decisions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL,
    factory_id        UUID NOT NULL,
    opportunity_id    UUID NOT NULL,
    decision          VARCHAR(20) NOT NULL,
    rationale         TEXT NOT NULL,
    request_hash      VARCHAR(64) NOT NULL,
    idempotency_key   VARCHAR(128) NOT NULL,
    decided_by        UUID NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_growth_opportunity_decision_opportunity
      FOREIGN KEY (opportunity_id, tenant_id, factory_id)
      REFERENCES growth_opportunity_registry (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_growth_opportunity_decision_actor
      FOREIGN KEY (decided_by)
      REFERENCES users (id)
      ON DELETE RESTRICT,

    CONSTRAINT chk_growth_opportunity_decision
      CHECK (decision IN ('ACCEPTED', 'REJECTED', 'DEFERRED', 'WITHDRAWN')),

    CONSTRAINT chk_growth_opportunity_decision_rationale
      CHECK (LENGTH(BTRIM(rationale)) BETWEEN 1 AND 2000),

    CONSTRAINT chk_growth_opportunity_decision_request_hash
      CHECK (request_hash ~ '^[a-f0-9]{64}$'),

    CONSTRAINT chk_growth_opportunity_decision_idempotency
      CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_opportunity_decision_idempotency
  ON growth_opportunity_decisions (tenant_id, factory_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_growth_opportunity_decisions_latest
  ON growth_opportunity_decisions (tenant_id, factory_id, opportunity_id, created_at DESC, id DESC);

ALTER TABLE growth_opportunity_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_opportunity_decisions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS growth_opportunity_decisions_tenant_isolation
  ON growth_opportunity_decisions;
CREATE POLICY growth_opportunity_decisions_tenant_isolation
  ON growth_opportunity_decisions
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION reject_growth_opportunity_decision_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Growth opportunity decisions are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_growth_opportunity_decisions_immutable
  ON growth_opportunity_decisions;
CREATE TRIGGER trg_growth_opportunity_decisions_immutable
  BEFORE UPDATE OR DELETE ON growth_opportunity_decisions
  FOR EACH ROW
  EXECUTE FUNCTION reject_growth_opportunity_decision_mutation();

CREATE TABLE IF NOT EXISTS growth_opportunity_outcomes (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              UUID NOT NULL,
    factory_id             UUID NOT NULL,
    opportunity_id         UUID NOT NULL,
    measurement_stage      VARCHAR(20) NOT NULL,
    metric_key             VARCHAR(100) NOT NULL,
    actual_value           NUMERIC(20, 6) NOT NULL,
    metric_unit            VARCHAR(40) NOT NULL,
    observed_at            TIMESTAMPTZ NOT NULL,
    source_system          VARCHAR(20) NOT NULL,
    source_record_ref      VARCHAR(255) NOT NULL,
    source_snapshot_sha256 VARCHAR(64),
    request_hash           VARCHAR(64) NOT NULL,
    idempotency_key        VARCHAR(128) NOT NULL,
    recorded_by            UUID NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_growth_opportunity_outcome_opportunity
      FOREIGN KEY (opportunity_id, tenant_id, factory_id)
      REFERENCES growth_opportunity_registry (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_growth_opportunity_outcome_actor
      FOREIGN KEY (recorded_by)
      REFERENCES users (id)
      ON DELETE RESTRICT,

    CONSTRAINT chk_growth_opportunity_outcome_stage
      CHECK (measurement_stage IN ('BASELINE', 'PRE', 'POST', 'REALIZED')),

    CONSTRAINT chk_growth_opportunity_outcome_metric
      CHECK (
        metric_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$'
        AND metric_unit ~ '^[a-zA-Z0-9][a-zA-Z0-9._/%-]{0,39}$'
      ),

    CONSTRAINT chk_growth_opportunity_outcome_source
      CHECK (
        source_system IN ('ERP', 'MES', 'CRM', 'FINANCE', 'QUALITY', 'MAINTENANCE', 'OTHER')
        AND LENGTH(BTRIM(source_record_ref)) BETWEEN 1 AND 255
      ),

    CONSTRAINT chk_growth_opportunity_outcome_source_hash
      CHECK (source_snapshot_sha256 IS NULL OR source_snapshot_sha256 ~ '^[a-f0-9]{64}$'),

    CONSTRAINT chk_growth_opportunity_outcome_request_hash
      CHECK (request_hash ~ '^[a-f0-9]{64}$'),

    CONSTRAINT chk_growth_opportunity_outcome_idempotency
      CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_opportunity_outcome_idempotency
  ON growth_opportunity_outcomes (tenant_id, factory_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_growth_opportunity_outcomes_history
  ON growth_opportunity_outcomes (tenant_id, factory_id, opportunity_id, observed_at DESC, id DESC);

ALTER TABLE growth_opportunity_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_opportunity_outcomes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS growth_opportunity_outcomes_tenant_isolation
  ON growth_opportunity_outcomes;
CREATE POLICY growth_opportunity_outcomes_tenant_isolation
  ON growth_opportunity_outcomes
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION reject_growth_opportunity_outcome_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Growth opportunity observations are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_growth_opportunity_outcomes_immutable
  ON growth_opportunity_outcomes;
CREATE TRIGGER trg_growth_opportunity_outcomes_immutable
  BEFORE UPDATE OR DELETE ON growth_opportunity_outcomes
  FOR EACH ROW
  EXECUTE FUNCTION reject_growth_opportunity_outcome_mutation();

INSERT INTO schema_migrations (version, checksum)
VALUES ('035_growth_opportunity_registry', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
