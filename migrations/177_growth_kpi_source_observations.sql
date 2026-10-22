BEGIN;

-- Version-pinned read-side observations sourced from approved FactoryOS ledgers.
-- These tables do not post or mutate Finance or Production source-of-record rows.

CREATE TABLE growth_kpi_source_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  source_kind VARCHAR(32) NOT NULL,
  adapter_version VARCHAR(80) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  input_hash CHAR(64) NOT NULL,
  source_record_ids JSONB NOT NULL,
  metric_keys JSONB NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_growth_kpi_source_sync_scope UNIQUE(id,tenant_id,factory_id,opportunity_id),
  CONSTRAINT uq_growth_kpi_source_sync_idempotency UNIQUE(tenant_id,factory_id,opportunity_id,idempotency_key),
  CONSTRAINT fk_growth_kpi_source_sync_opportunity FOREIGN KEY(opportunity_id,tenant_id,factory_id)
    REFERENCES growth_opportunities(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_kpi_source_sync_actor FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_kpi_source_sync_kind CHECK(source_kind IN ('FINANCIAL_FACT','PRODUCTION_OUTPUT')),
  CONSTRAINT chk_growth_kpi_source_sync_adapter CHECK(adapter_version='factoryos.growth.source-of-record.v1'),
  CONSTRAINT chk_growth_kpi_source_sync_idempotency CHECK(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  CONSTRAINT chk_growth_kpi_source_sync_hash CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_growth_kpi_source_sync_record_ids CHECK(jsonb_typeof(source_record_ids)='array' AND jsonb_array_length(source_record_ids) BETWEEN 1 AND 50),
  CONSTRAINT chk_growth_kpi_source_sync_metric_keys CHECK(jsonb_typeof(metric_keys)='array' AND jsonb_array_length(metric_keys) BETWEEN 1 AND 8)
);

CREATE TABLE growth_kpi_source_observations (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  sync_run_id UUID NOT NULL,
  source_kind VARCHAR(32) NOT NULL,
  adapter_version VARCHAR(80) NOT NULL,
  metric_key VARCHAR(100) NOT NULL,
  unit VARCHAR(40) NOT NULL,
  value NUMERIC(24,8) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  source_record_ref TEXT NOT NULL,
  source_revision_hash CHAR(64) NOT NULL,
  observation_hash CHAR(64) NOT NULL,
  source_financial_fact_id UUID,
  source_production_output_posting_id UUID,
  evidence_id UUID NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_growth_kpi_source_observation_scope UNIQUE(id,tenant_id,factory_id,opportunity_id),
  CONSTRAINT fk_growth_kpi_observation_sync FOREIGN KEY(sync_run_id,tenant_id,factory_id,opportunity_id)
    REFERENCES growth_kpi_source_sync_runs(id,tenant_id,factory_id,opportunity_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_kpi_observation_opportunity FOREIGN KEY(opportunity_id,tenant_id,factory_id)
    REFERENCES growth_opportunities(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_kpi_observation_finance_source FOREIGN KEY(source_financial_fact_id,tenant_id,factory_id)
    REFERENCES financial_facts(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_kpi_observation_production_source FOREIGN KEY(source_production_output_posting_id,tenant_id,factory_id)
    REFERENCES production_output_postings(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_kpi_observation_actor FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_kpi_observation_evidence FOREIGN KEY(evidence_id) REFERENCES growth_opportunity_evidence(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_kpi_observation_kind CHECK(
    (source_kind='FINANCIAL_FACT' AND source_financial_fact_id IS NOT NULL AND source_production_output_posting_id IS NULL)
    OR (source_kind='PRODUCTION_OUTPUT' AND source_financial_fact_id IS NULL AND source_production_output_posting_id IS NOT NULL)
  ),
  CONSTRAINT chk_growth_kpi_observation_adapter CHECK(adapter_version='factoryos.growth.source-of-record.v1'),
  CONSTRAINT chk_growth_kpi_observation_metric CHECK(metric_key ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  CONSTRAINT chk_growth_kpi_observation_unit CHECK(length(btrim(unit)) BETWEEN 1 AND 40),
  CONSTRAINT chk_growth_kpi_observation_value CHECK(abs(value)<=1000000000000),
  CONSTRAINT chk_growth_kpi_observation_source_ref CHECK(length(btrim(source_record_ref)) BETWEEN 1 AND 2000),
  CONSTRAINT chk_growth_kpi_observation_revision CHECK(source_revision_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_growth_kpi_observation_hash CHECK(observation_hash ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX uq_growth_kpi_observation_finance_revision
 ON growth_kpi_source_observations(tenant_id,factory_id,opportunity_id,source_financial_fact_id,metric_key,adapter_version)
 WHERE source_kind='FINANCIAL_FACT';
CREATE UNIQUE INDEX uq_growth_kpi_observation_production_revision
 ON growth_kpi_source_observations(tenant_id,factory_id,opportunity_id,source_production_output_posting_id,metric_key,adapter_version)
 WHERE source_kind='PRODUCTION_OUTPUT';
CREATE INDEX idx_growth_kpi_observation_metric_time
 ON growth_kpi_source_observations(tenant_id,factory_id,opportunity_id,metric_key,unit,observed_at DESC);
CREATE INDEX idx_growth_kpi_observation_sync
 ON growth_kpi_source_observations(tenant_id,factory_id,opportunity_id,sync_run_id,created_at);

CREATE TABLE growth_kpi_source_sync_items (
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  sync_run_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,factory_id,opportunity_id,sync_run_id,observation_id),
  CONSTRAINT fk_growth_kpi_sync_item_run FOREIGN KEY(sync_run_id,tenant_id,factory_id,opportunity_id)
    REFERENCES growth_kpi_source_sync_runs(id,tenant_id,factory_id,opportunity_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_kpi_sync_item_observation FOREIGN KEY(observation_id,tenant_id,factory_id,opportunity_id)
    REFERENCES growth_kpi_source_observations(id,tenant_id,factory_id,opportunity_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION factoryos_guard_growth_kpi_source_observation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  fact RECORD;
  production RECORD;
  evidence RECORD;
  expected_fact_type TEXT;
  expected_unit TEXT;
  expected_value NUMERIC(24,8);
  expected_time TIMESTAMPTZ;
  expected_ref TEXT;
  expected_hash TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'GROWTH_KPI_SOURCE_OBSERVATION_APPEND_ONLY' USING ERRCODE='55000';
  END IF;

  IF NEW.source_kind='FINANCIAL_FACT' THEN
    SELECT f.*, c.status AS connector_status, c.is_reporting_source
      INTO fact
      FROM financial_facts f
      JOIN finance_connectors c ON c.id=f.connector_id AND c.tenant_id=f.tenant_id AND c.factory_id=f.factory_id
     WHERE f.id=NEW.source_financial_fact_id
       AND f.tenant_id=NEW.tenant_id AND f.factory_id=NEW.factory_id
     FOR KEY SHARE OF f,c;
    IF NOT FOUND OR fact.connector_status <> 'ACTIVE' OR fact.is_reporting_source IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'GROWTH_KPI_SOURCE_REQUIRES_ACTIVE_FINANCE_REPORTING_CONNECTOR' USING ERRCODE='23514';
    END IF;
    expected_fact_type := CASE NEW.metric_key
      WHEN 'finance.actual_revenue' THEN 'ACTUAL_REVENUE'
      WHEN 'finance.actual_cost' THEN 'ACTUAL_COST'
      WHEN 'finance.actual_contribution_cost' THEN 'ACTUAL_CONTRIBUTION_COST'
      WHEN 'finance.forecast_revenue' THEN 'FORECAST_REVENUE'
      WHEN 'finance.forecast_cost' THEN 'FORECAST_COST'
      WHEN 'finance.forecast_contribution_cost' THEN 'FORECAST_CONTRIBUTION_COST'
      WHEN 'finance.inventory_value' THEN 'INVENTORY_VALUE'
      WHEN 'finance.open_po_commitment' THEN 'OPEN_PO_COMMITMENT'
      WHEN 'finance.accounts_receivable' THEN 'AR_OPEN'
      WHEN 'finance.accounts_payable' THEN 'AP_OPEN'
      WHEN 'finance.bank_balance' THEN 'BANK_BALANCE'
      ELSE NULL END;
    IF expected_fact_type IS NULL OR expected_fact_type <> fact.fact_type THEN
      RAISE EXCEPTION 'GROWTH_KPI_SOURCE_METRIC_FACT_TYPE_MISMATCH' USING ERRCODE='23514';
    END IF;
    expected_unit := fact.currency;
    expected_value := fact.amount;
    expected_time := fact.effective_at;
    expected_ref := 'finance-fact:' || fact.id::text;
    expected_hash := fact.fact_hash;
  ELSE
    SELECT p.*,i.unit AS item_unit INTO production
      FROM production_output_postings p
      JOIN inventory_items i ON i.id=p.finished_item_id AND i.tenant_id=p.tenant_id AND i.factory_id=p.factory_id
     WHERE p.id=NEW.source_production_output_posting_id
       AND p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id
     FOR KEY SHARE OF p,i;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'GROWTH_KPI_PRODUCTION_SOURCE_NOT_FOUND' USING ERRCODE='23503';
    END IF;
    expected_unit := CASE NEW.metric_key
      WHEN 'production.good_quantity' THEN production.item_unit
      WHEN 'production.scrap_quantity' THEN production.item_unit
      WHEN 'production.yield_percentage' THEN 'pct'
      WHEN 'production.cumulative_yield_percentage' THEN 'pct'
      ELSE NULL END;
    expected_value := CASE NEW.metric_key
      WHEN 'production.good_quantity' THEN production.good_quantity
      WHEN 'production.scrap_quantity' THEN production.scrap_quantity
      WHEN 'production.yield_percentage' THEN production.yield_percentage
      WHEN 'production.cumulative_yield_percentage' THEN production.cumulative_yield_percentage
      ELSE NULL END;
    IF expected_unit IS NULL OR expected_value IS NULL THEN
      RAISE EXCEPTION 'GROWTH_KPI_SOURCE_METRIC_NOT_ALLOWED_FOR_PRODUCTION_OUTPUT' USING ERRCODE='23514';
    END IF;
    expected_time := production.created_at;
    expected_ref := 'production-output:' || production.id::text;
    expected_hash := production.request_hash;
  END IF;

  IF NEW.unit IS DISTINCT FROM expected_unit OR NEW.value IS DISTINCT FROM expected_value
     OR NEW.observed_at IS DISTINCT FROM expected_time
     OR NEW.source_record_ref IS DISTINCT FROM expected_ref
     OR NEW.source_revision_hash IS DISTINCT FROM expected_hash THEN
    RAISE EXCEPTION 'GROWTH_KPI_SOURCE_OBSERVATION_DOES_NOT_MATCH_CANONICAL_SOURCE_ROW' USING ERRCODE='23514';
  END IF;

  SELECT e.id,e.tenant_id,e.factory_id,e.opportunity_id,e.evidence_type,e.origin_class,e.reference_ref,
         e.evidence_snapshot
    INTO evidence
    FROM growth_opportunity_evidence e
   WHERE e.id=NEW.evidence_id
   FOR KEY SHARE;
  IF NOT FOUND OR evidence.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR evidence.factory_id IS DISTINCT FROM NEW.factory_id
     OR evidence.opportunity_id IS DISTINCT FROM NEW.opportunity_id
     OR evidence.evidence_type <> 'OPERATIONAL_METRIC'
     OR evidence.origin_class <> 'OPERATIONAL'
     OR evidence.reference_ref IS DISTINCT FROM 'factoryos://growth/source-observations/' || NEW.id::text
     OR evidence.evidence_snapshot->>'metric_key' IS DISTINCT FROM NEW.metric_key
     OR evidence.evidence_snapshot->>'source_revision_hash' IS DISTINCT FROM NEW.source_revision_hash
     OR evidence.evidence_snapshot->>'source_record_ref' IS DISTINCT FROM NEW.source_record_ref
     OR evidence.evidence_snapshot->>'adapter_version' IS DISTINCT FROM NEW.adapter_version
     OR evidence.evidence_snapshot->>'unit' IS DISTINCT FROM NEW.unit
     OR (evidence.evidence_snapshot->>'value')::numeric IS DISTINCT FROM NEW.value
     OR (evidence.evidence_snapshot->>'observed_at')::timestamptz IS DISTINCT FROM NEW.observed_at THEN
    RAISE EXCEPTION 'GROWTH_KPI_SOURCE_OBSERVATION_EVIDENCE_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER growth_kpi_source_observation_guard
BEFORE INSERT OR UPDATE OR DELETE ON growth_kpi_source_observations
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_kpi_source_observation();

CREATE OR REPLACE FUNCTION factoryos_prevent_growth_kpi_source_sync_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only source lineage', TG_TABLE_NAME USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER growth_kpi_source_sync_runs_immutable
BEFORE UPDATE OR DELETE ON growth_kpi_source_sync_runs
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_growth_kpi_source_sync_mutation();
CREATE TRIGGER growth_kpi_source_sync_items_immutable
BEFORE UPDATE OR DELETE ON growth_kpi_source_sync_items
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_growth_kpi_source_sync_mutation();

CREATE OR REPLACE FUNCTION factoryos_guard_growth_source_observation_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.evidence_type='OPERATIONAL_METRIC'
     AND NEW.reference_ref LIKE 'factoryos://growth/source-observations/%'
     AND NOT EXISTS (
       SELECT 1 FROM growth_kpi_source_observations o
        WHERE o.id::text=substring(NEW.reference_ref from length('factoryos://growth/source-observations/')+1)
          AND o.evidence_id=NEW.id
          AND o.tenant_id=NEW.tenant_id
          AND o.factory_id=NEW.factory_id
          AND o.opportunity_id=NEW.opportunity_id
     ) THEN
    -- The matching observation is inserted after this evidence row in the same transaction.
    -- Defer this check to transaction commit to allow the two immutable records to cross-reference.
    NULL;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_check_growth_source_observation_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.evidence_type='OPERATIONAL_METRIC'
     AND NEW.reference_ref LIKE 'factoryos://growth/source-observations/%'
     AND NOT EXISTS (
       SELECT 1 FROM growth_kpi_source_observations o
        WHERE o.id::text=substring(NEW.reference_ref from length('factoryos://growth/source-observations/')+1)
          AND o.evidence_id=NEW.id
          AND o.tenant_id=NEW.tenant_id
          AND o.factory_id=NEW.factory_id
          AND o.opportunity_id=NEW.opportunity_id
     ) THEN
    RAISE EXCEPTION 'GROWTH_KPI_SOURCE_EVIDENCE_REQUIRES_LINKED_OBSERVATION' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER growth_source_observation_evidence_link_guard
AFTER INSERT ON growth_opportunity_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_check_growth_source_observation_evidence();

ALTER TABLE growth_kpi_source_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_kpi_source_sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY growth_kpi_source_sync_runs_tenant_isolation ON growth_kpi_source_sync_runs
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE growth_kpi_source_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_kpi_source_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY growth_kpi_source_observations_tenant_isolation ON growth_kpi_source_observations
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE growth_kpi_source_sync_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_kpi_source_sync_items FORCE ROW LEVEL SECURITY;
CREATE POLICY growth_kpi_source_sync_items_tenant_isolation ON growth_kpi_source_sync_items
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

INSERT INTO schema_migrations(version, checksum)
VALUES ('177_growth_kpi_source_observations', NULL)
ON CONFLICT(version) DO NOTHING;
COMMIT;
