BEGIN;

-- FR-GRO-09 / FR-EXP2-07: decision readiness and ranked validation unknowns.
ALTER TABLE growth_scenarios
  ADD COLUMN decision_ready BOOLEAN GENERATED ALWAYS AS (
    (output_snapshot #>> '{constraintGate,status}') = 'PASS'
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
