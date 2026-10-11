BEGIN;

-- FR-GRO-09 / FR-EXP2-07: decision readiness and ranked validation unknowns.
ALTER TABLE growth_scenarios
  ADD COLUMN decision_ready BOOLEAN GENERATED ALWAYS AS (
    COALESCE((output_snapshot #>> '{constraintGate,status}') = 'PASS', FALSE)
  ) STORED;

CREATE TABLE growth_validation_unknowns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  question TEXT NOT NULL,
  decision_variable VARCHAR(200) NOT NULL,
  impact_if_wrong NUMERIC(7, 3) NOT NULL,
  probability_unknown NUMERIC(5, 4) NOT NULL,
  validation_effort NUMERIC(7, 3) NOT NULL,
  validation_method VARCHAR(30) NOT NULL,
  owner_user_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  resolution_evidence_ref TEXT,
  resolution_notes TEXT,
  created_by UUID NOT NULL,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  resolved_at TIMESTAMPTZ,
  priority_score NUMERIC(12, 4) GENERATED ALWAYS AS (
    round((impact_if_wrong * probability_unknown) / validation_effort, 4)
  ) STORED,
  CONSTRAINT uq_growth_unknown_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_growth_unknown_opportunity FOREIGN KEY (opportunity_id, tenant_id, factory_id)
    REFERENCES growth_opportunities(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_unknown_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_unknown_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_unknown_updater FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_unknown_question CHECK (length(btrim(question)) > 0),
  CONSTRAINT chk_growth_unknown_variable CHECK (length(btrim(decision_variable)) > 0),
  CONSTRAINT chk_growth_unknown_impact CHECK (impact_if_wrong >= 0 AND impact_if_wrong <= 100),
  CONSTRAINT chk_growth_unknown_probability CHECK (probability_unknown >= 0 AND probability_unknown <= 1),
  CONSTRAINT chk_growth_unknown_effort CHECK (validation_effort > 0 AND validation_effort <= 100),
  CONSTRAINT chk_growth_unknown_method CHECK (
    validation_method IN ('MEASURE', 'DOCUMENT_REVIEW', 'CUSTOMER_INTERVIEW',
                          'PILOT', 'SUPPLIER_QUOTE', 'MARKET_TEST', 'EXPERT_REVIEW')
  ),
  CONSTRAINT chk_growth_unknown_status CHECK (
    status IN ('OPEN', 'VALIDATING', 'RESOLVED', 'NOT_MATERIAL')
  ),
  CONSTRAINT chk_growth_unknown_resolution CHECK (
    status NOT IN ('RESOLVED', 'NOT_MATERIAL')
    OR (
      resolution_evidence_ref IS NOT NULL
      AND length(btrim(resolution_evidence_ref)) > 0
      AND resolved_at IS NOT NULL
      AND updated_by IS NOT NULL
    )
  ),
  CONSTRAINT chk_growth_unknown_open CHECK (
    status NOT IN ('OPEN', 'VALIDATING') OR resolved_at IS NULL
  )
);

CREATE INDEX idx_growth_unknown_priority
  ON growth_validation_unknowns (
    tenant_id, factory_id, opportunity_id, status, priority_score DESC, created_at
  );

CREATE OR REPLACE FUNCTION factoryos_guard_growth_validation_unknown()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Growth validation unknowns are retained as decision evidence'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
    OR NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id
    OR NEW.question IS DISTINCT FROM OLD.question
    OR NEW.decision_variable IS DISTINCT FROM OLD.decision_variable
    OR NEW.impact_if_wrong IS DISTINCT FROM OLD.impact_if_wrong
    OR NEW.probability_unknown IS DISTINCT FROM OLD.probability_unknown
    OR NEW.validation_effort IS DISTINCT FROM OLD.validation_effort
    OR NEW.validation_method IS DISTINCT FROM OLD.validation_method
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Growth unknown definition is immutable; create a new assessment to change assumptions'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('RESOLVED', 'NOT_MATERIAL') THEN
    RAISE EXCEPTION 'Resolved growth unknowns are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'OPEN' AND NEW.status IN ('VALIDATING', 'RESOLVED', 'NOT_MATERIAL'))
      OR (OLD.status = 'VALIDATING' AND NEW.status IN ('RESOLVED', 'NOT_MATERIAL'))
    ) THEN
      RAISE EXCEPTION 'Invalid growth unknown lifecycle transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status IN ('RESOLVED', 'NOT_MATERIAL') THEN
    NEW.resolved_at := COALESCE(NEW.resolved_at, clock_timestamp());
    IF NEW.resolution_evidence_ref IS NULL OR length(btrim(NEW.resolution_evidence_ref)) = 0 THEN
      RAISE EXCEPTION 'Resolving a growth unknown requires a traceable evidence reference'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    NEW.resolved_at := NULL;
    NEW.resolution_evidence_ref := NULL;
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER growth_validation_unknown_guard
BEFORE UPDATE OR DELETE ON growth_validation_unknowns
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_validation_unknown();

CREATE OR REPLACE FUNCTION factoryos_guard_growth_scenario_constraints()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  constraint_snapshot JSONB;
  projected JSONB;
  capacity_limit NUMERIC;
  quality_limit NUMERIC;
  cash_reserve NUMERIC;
  delivery_limit NUMERIC;
  expected_currency TEXT;
  status_text TEXT;
BEGIN
  status_text := NEW.output_snapshot #>> '{constraintGate,status}';
  IF status_text IS DISTINCT FROM 'PASS' THEN
    RETURN NEW;
  END IF;

  SELECT constraints_snapshot INTO constraint_snapshot
  FROM growth_opportunities
  WHERE id = NEW.opportunity_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
  FOR SHARE;

  IF NEW.inputs -> 'constraints_snapshot' IS DISTINCT FROM constraint_snapshot THEN
    RAISE EXCEPTION 'Scenario constraints snapshot must equal the opportunity snapshot used at run time'
      USING ERRCODE = '23514';
  END IF;

  projected := NEW.inputs -> 'projected_constraint_metrics';
  IF constraint_snapshot IS NULL OR projected IS NULL
    OR jsonb_typeof(projected) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'A decision-ready scenario requires constraints and projected metrics'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(constraint_snapshot -> 'capacity') IS DISTINCT FROM 'object'
    OR jsonb_typeof(constraint_snapshot -> 'quality') IS DISTINCT FROM 'object'
    OR jsonb_typeof(constraint_snapshot -> 'cash') IS DISTINCT FROM 'object'
    OR jsonb_typeof(constraint_snapshot -> 'delivery') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'A decision-ready scenario requires all four constraint dimensions'
      USING ERRCODE = '23514';
  END IF;

  IF COALESCE(length(btrim(constraint_snapshot #>> '{capacity,source_ref}')), 0) = 0
    OR COALESCE(length(btrim(constraint_snapshot #>> '{quality,source_ref}')), 0) = 0
    OR COALESCE(length(btrim(constraint_snapshot #>> '{cash,source_ref}')), 0) = 0
    OR COALESCE(length(btrim(constraint_snapshot #>> '{delivery,source_ref}')), 0) = 0
    OR COALESCE(length(btrim(constraint_snapshot #>> '{capacity,as_of}')), 0) = 0
    OR COALESCE(length(btrim(constraint_snapshot #>> '{quality,as_of}')), 0) = 0
    OR COALESCE(length(btrim(constraint_snapshot #>> '{cash,as_of}')), 0) = 0
    OR COALESCE(length(btrim(constraint_snapshot #>> '{delivery,as_of}')), 0) = 0 THEN
    RAISE EXCEPTION 'A decision-ready scenario requires dated, referenced constraints'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
      SELECT 1 FROM growth_opportunity_evidence e
      WHERE e.opportunity_id = NEW.opportunity_id AND e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
        AND (e.reference_ref = constraint_snapshot #>> '{capacity,source_ref}' OR e.citation_url = constraint_snapshot #>> '{capacity,source_ref}')
    )
    OR NOT EXISTS (
      SELECT 1 FROM growth_opportunity_evidence e
      WHERE e.opportunity_id = NEW.opportunity_id AND e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
        AND (e.reference_ref = constraint_snapshot #>> '{quality,source_ref}' OR e.citation_url = constraint_snapshot #>> '{quality,source_ref}')
    )
    OR NOT EXISTS (
      SELECT 1 FROM growth_opportunity_evidence e
      WHERE e.opportunity_id = NEW.opportunity_id AND e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
        AND (e.reference_ref = constraint_snapshot #>> '{cash,source_ref}' OR e.citation_url = constraint_snapshot #>> '{cash,source_ref}')
    )
    OR NOT EXISTS (
      SELECT 1 FROM growth_opportunity_evidence e
      WHERE e.opportunity_id = NEW.opportunity_id AND e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
        AND (e.reference_ref = constraint_snapshot #>> '{delivery,source_ref}' OR e.citation_url = constraint_snapshot #>> '{delivery,source_ref}')
    ) THEN
    RAISE EXCEPTION 'Each constraint must reference evidence attached to this opportunity'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(projected -> 'capacity_utilization_pct') IS DISTINCT FROM 'number'
    OR jsonb_typeof(projected -> 'quality_yield_pct') IS DISTINCT FROM 'number'
    OR jsonb_typeof(projected -> 'cash_after_investment') IS DISTINCT FROM 'number'
    OR jsonb_typeof(projected -> 'cash_currency') IS DISTINCT FROM 'string'
    OR jsonb_typeof(projected -> 'delivery_backlog_days') IS DISTINCT FROM 'number'
    OR jsonb_typeof(constraint_snapshot #> '{capacity,max_utilization_pct}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(constraint_snapshot #> '{quality,min_yield_pct}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(constraint_snapshot #> '{cash,minimum_reserve}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(constraint_snapshot #> '{cash,currency}') IS DISTINCT FROM 'string'
    OR jsonb_typeof(constraint_snapshot #> '{delivery,max_backlog_days}') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'A decision-ready scenario requires valid numeric inputs and constraint limits'
      USING ERRCODE = '23514';
  END IF;

  IF (constraint_snapshot #>> '{capacity,as_of}')::timestamptz > clock_timestamp() + interval '5 minutes'
    OR (constraint_snapshot #>> '{quality,as_of}')::timestamptz > clock_timestamp() + interval '5 minutes'
    OR (constraint_snapshot #>> '{cash,as_of}')::timestamptz > clock_timestamp() + interval '5 minutes'
    OR (constraint_snapshot #>> '{delivery,as_of}')::timestamptz > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Constraint snapshot timestamps cannot be in the future'
      USING ERRCODE = '23514';
  END IF;

  capacity_limit := (constraint_snapshot #>> '{capacity,max_utilization_pct}')::numeric;
  quality_limit := (constraint_snapshot #>> '{quality,min_yield_pct}')::numeric;
  cash_reserve := (constraint_snapshot #>> '{cash,minimum_reserve}')::numeric;
  expected_currency := upper(constraint_snapshot #>> '{cash,currency}');
  delivery_limit := (constraint_snapshot #>> '{delivery,max_backlog_days}')::numeric;

  IF capacity_limit IS NULL OR capacity_limit < 0 OR capacity_limit > 1000
    OR quality_limit IS NULL OR quality_limit < 0 OR quality_limit > 100
    OR cash_reserve IS NULL OR cash_reserve < 0
    OR expected_currency !~ '^[A-Z]{3}$'
    OR delivery_limit IS NULL OR delivery_limit < 0 THEN
    RAISE EXCEPTION 'A decision-ready scenario has invalid constraint limits'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(NEW.output_snapshot #> '{constraintGate,checks}') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.output_snapshot #> '{constraintGate,checks}') <> 4
    OR NEW.output_snapshot #>> '{constraintGate,checks,0,dimension}' IS DISTINCT FROM 'capacity'
    OR NEW.output_snapshot #>> '{constraintGate,checks,1,dimension}' IS DISTINCT FROM 'quality'
    OR NEW.output_snapshot #>> '{constraintGate,checks,2,dimension}' IS DISTINCT FROM 'cash'
    OR NEW.output_snapshot #>> '{constraintGate,checks,3,dimension}' IS DISTINCT FROM 'delivery'
    OR NEW.output_snapshot #>> '{constraintGate,checks,0,passed}' IS DISTINCT FROM 'true'
    OR NEW.output_snapshot #>> '{constraintGate,checks,1,passed}' IS DISTINCT FROM 'true'
    OR NEW.output_snapshot #>> '{constraintGate,checks,2,passed}' IS DISTINCT FROM 'true'
    OR NEW.output_snapshot #>> '{constraintGate,checks,3,passed}' IS DISTINCT FROM 'true'
    OR (NEW.output_snapshot #>> '{constraintGate,checks,0,projected}')::numeric IS DISTINCT FROM (projected ->> 'capacity_utilization_pct')::numeric
    OR (NEW.output_snapshot #>> '{constraintGate,checks,1,projected}')::numeric IS DISTINCT FROM (projected ->> 'quality_yield_pct')::numeric
    OR (NEW.output_snapshot #>> '{constraintGate,checks,2,projected}')::numeric IS DISTINCT FROM (projected ->> 'cash_after_investment')::numeric
    OR (NEW.output_snapshot #>> '{constraintGate,checks,3,projected}')::numeric IS DISTINCT FROM (projected ->> 'delivery_backlog_days')::numeric THEN
    RAISE EXCEPTION 'A decision-ready scenario must persist four passing checks for the exact projected inputs'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.output_snapshot #>> '{constraintGate,decisionReady}' IS DISTINCT FROM 'true'
    OR (NEW.output_snapshot #>> '{constraintGate,checks,0,maximumAllowed}')::numeric IS DISTINCT FROM capacity_limit
    OR (NEW.output_snapshot #>> '{constraintGate,checks,1,minimumAllowed}')::numeric IS DISTINCT FROM quality_limit
    OR (NEW.output_snapshot #>> '{constraintGate,checks,2,minimumReserve}')::numeric IS DISTINCT FROM cash_reserve
    OR upper(NEW.output_snapshot #>> '{constraintGate,checks,2,expectedCurrency}') IS DISTINCT FROM expected_currency
    OR upper(NEW.output_snapshot #>> '{constraintGate,checks,2,currency}') IS DISTINCT FROM upper(projected ->> 'cash_currency')
    OR (NEW.output_snapshot #>> '{constraintGate,checks,3,maximumAllowed}')::numeric IS DISTINCT FROM delivery_limit
    OR NEW.output_snapshot #>> '{constraintGate,checks,0,sourceRef}' IS DISTINCT FROM constraint_snapshot #>> '{capacity,source_ref}'
    OR NEW.output_snapshot #>> '{constraintGate,checks,1,sourceRef}' IS DISTINCT FROM constraint_snapshot #>> '{quality,source_ref}'
    OR NEW.output_snapshot #>> '{constraintGate,checks,2,sourceRef}' IS DISTINCT FROM constraint_snapshot #>> '{cash,source_ref}'
    OR NEW.output_snapshot #>> '{constraintGate,checks,3,sourceRef}' IS DISTINCT FROM constraint_snapshot #>> '{delivery,source_ref}'
    OR NEW.output_snapshot #>> '{constraintGate,checks,0,asOf}' IS DISTINCT FROM constraint_snapshot #>> '{capacity,as_of}'
    OR NEW.output_snapshot #>> '{constraintGate,checks,1,asOf}' IS DISTINCT FROM constraint_snapshot #>> '{quality,as_of}'
    OR NEW.output_snapshot #>> '{constraintGate,checks,2,asOf}' IS DISTINCT FROM constraint_snapshot #>> '{cash,as_of}'
    OR NEW.output_snapshot #>> '{constraintGate,checks,3,asOf}' IS DISTINCT FROM constraint_snapshot #>> '{delivery,as_of}'
    OR (projected ->> 'capacity_utilization_pct')::numeric < 0
    OR (projected ->> 'capacity_utilization_pct')::numeric > 1000
    OR (projected ->> 'quality_yield_pct')::numeric < 0
    OR (projected ->> 'quality_yield_pct')::numeric > 100
    OR abs((projected ->> 'cash_after_investment')::numeric) > 1000000000000
    OR (projected ->> 'delivery_backlog_days')::numeric < 0
    OR (projected ->> 'delivery_backlog_days')::numeric > 36500
    OR (projected ->> 'capacity_utilization_pct')::numeric > capacity_limit
    OR (projected ->> 'quality_yield_pct')::numeric < quality_limit
    OR (projected ->> 'cash_after_investment')::numeric < cash_reserve
    OR upper(projected ->> 'cash_currency') <> expected_currency
    OR (projected ->> 'delivery_backlog_days')::numeric > delivery_limit THEN
    RAISE EXCEPTION 'A scenario that violates capacity, quality, cash or delivery limits cannot be decision-ready'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER growth_scenario_constraint_guard
BEFORE INSERT ON growth_scenarios
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_scenario_constraints();

ALTER TABLE growth_validation_unknowns ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_validation_unknowns FORCE ROW LEVEL SECURITY;
CREATE POLICY growth_validation_unknowns_tenant_isolation
  ON growth_validation_unknowns
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version, checksum)
VALUES ('040_growth_constraint_gate_unknowns', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
