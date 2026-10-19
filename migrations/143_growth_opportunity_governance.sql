BEGIN;

-- Explicit, versionable governance for growth assumptions, constraints, missing
-- evidence and the named business decision owner. Existing prose assumptions
-- are imported as unvalidated records rather than silently treated as facts.

CREATE TABLE growth_opportunity_assumptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  statement TEXT NOT NULL,
  rationale TEXT,
  risk_if_false VARCHAR(20) NOT NULL DEFAULT 'HIGH',
  confidence_pct NUMERIC(5,2) NOT NULL DEFAULT 50,
  validation_method TEXT NOT NULL,
  initial_evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  owner_user_id UUID NOT NULL,
  blocks_decision BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_growth_assumption_scope UNIQUE (id, tenant_id, factory_id, opportunity_id),
  CONSTRAINT fk_growth_assumption_opportunity FOREIGN KEY (opportunity_id, tenant_id, factory_id)
    REFERENCES growth_opportunities(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_assumption_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_assumption_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_assumption_statement CHECK (length(btrim(statement)) BETWEEN 5 AND 4000),
  CONSTRAINT chk_growth_assumption_risk CHECK (risk_if_false IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  CONSTRAINT chk_growth_assumption_confidence CHECK (confidence_pct BETWEEN 0 AND 100),
  CONSTRAINT chk_growth_assumption_method CHECK (length(btrim(validation_method)) BETWEEN 5 AND 2000),
  CONSTRAINT chk_growth_assumption_refs CHECK (jsonb_typeof(initial_evidence_refs) = 'array')
);
CREATE INDEX idx_growth_assumptions_opportunity
  ON growth_opportunity_assumptions (tenant_id, factory_id, opportunity_id, created_at, id);

CREATE TABLE growth_opportunity_assumption_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  assumption_id UUID NOT NULL,
  decision VARCHAR(24) NOT NULL,
  reason TEXT NOT NULL,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  decided_by UUID NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  request_id UUID,
  trace_id UUID,
  CONSTRAINT fk_growth_assumption_decision_assumption
    FOREIGN KEY (assumption_id, tenant_id, factory_id, opportunity_id)
    REFERENCES growth_opportunity_assumptions(id, tenant_id, factory_id, opportunity_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_assumption_decision_actor FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_assumption_decision_value CHECK (decision IN ('VALIDATED','REFUTED','DEFERRED','NEEDS_EVIDENCE','WAIVED')),
  CONSTRAINT chk_growth_assumption_decision_reason CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  CONSTRAINT chk_growth_assumption_decision_refs CHECK (jsonb_typeof(evidence_refs) = 'array'),
  CONSTRAINT chk_growth_assumption_decision_evidence CHECK (decision NOT IN ('VALIDATED','REFUTED','WAIVED') OR jsonb_array_length(evidence_refs) > 0)
);
CREATE INDEX idx_growth_assumption_decisions_latest
  ON growth_opportunity_assumption_decisions
  (tenant_id, factory_id, opportunity_id, assumption_id, decided_at DESC, id DESC);

CREATE TABLE growth_opportunity_constraints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  dimension VARCHAR(24) NOT NULL,
  applicability VARCHAR(24) NOT NULL DEFAULT 'UNKNOWN',
  constraint_name VARCHAR(300) NOT NULL,
  limit_operator VARCHAR(16),
  threshold_value NUMERIC(20,4),
  observed_value NUMERIC(20,4),
  unit VARCHAR(60),
  source_evidence_ref TEXT,
  source_as_of TIMESTAMPTZ,
  rationale TEXT NOT NULL,
  owner_user_id UUID NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_growth_constraint_identity UNIQUE (id, tenant_id, factory_id, opportunity_id),
  CONSTRAINT fk_growth_constraint_opportunity FOREIGN KEY (opportunity_id, tenant_id, factory_id)
    REFERENCES growth_opportunities(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_constraint_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_constraint_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_constraint_dimension CHECK (dimension IN (
    'CAPACITY','QUALITY','CASH','DELIVERY','REGULATORY','CUSTOMER','TECHNICAL','WORKFORCE','OTHER'
  )),
  CONSTRAINT chk_growth_constraint_applicability CHECK (applicability IN ('APPLICABLE','NOT_APPLICABLE','UNKNOWN')),
  CONSTRAINT chk_growth_constraint_name CHECK (length(btrim(constraint_name)) BETWEEN 3 AND 300),
  CONSTRAINT chk_growth_constraint_operator CHECK (limit_operator IS NULL OR limit_operator IN ('MAX','MIN','EQUALS')),
  CONSTRAINT chk_growth_constraint_evaluation CHECK (
    (applicability = 'APPLICABLE'
      AND limit_operator IS NOT NULL AND threshold_value IS NOT NULL
      AND observed_value IS NOT NULL AND NULLIF(BTRIM(unit),'') IS NOT NULL
      AND NULLIF(BTRIM(source_evidence_ref),'') IS NOT NULL AND source_as_of IS NOT NULL)
    OR (applicability = 'NOT_APPLICABLE' AND length(btrim(rationale)) >= 10)
    OR applicability = 'UNKNOWN'
  ),
  CONSTRAINT chk_growth_constraint_rationale CHECK (length(btrim(rationale)) BETWEEN 5 AND 2000)
);
CREATE INDEX idx_growth_constraints_latest
  ON growth_opportunity_constraints (tenant_id, factory_id, opportunity_id, dimension, created_at DESC, id DESC);

CREATE TABLE growth_opportunity_evidence_gaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  question TEXT NOT NULL,
  required_evidence TEXT NOT NULL,
  impact VARCHAR(20) NOT NULL,
  owner_user_id UUID NOT NULL,
  due_at TIMESTAMPTZ,
  blocks_decision BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_growth_evidence_gap_scope UNIQUE (id, tenant_id, factory_id, opportunity_id),
  CONSTRAINT fk_growth_evidence_gap_opportunity FOREIGN KEY (opportunity_id, tenant_id, factory_id)
    REFERENCES growth_opportunities(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_evidence_gap_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_evidence_gap_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_evidence_gap_question CHECK (length(btrim(question)) BETWEEN 5 AND 4000),
  CONSTRAINT chk_growth_evidence_gap_required CHECK (length(btrim(required_evidence)) BETWEEN 5 AND 2000),
  CONSTRAINT chk_growth_evidence_gap_impact CHECK (impact IN ('LOW','MEDIUM','HIGH','CRITICAL'))
);
CREATE INDEX idx_growth_evidence_gaps_opportunity
  ON growth_opportunity_evidence_gaps (tenant_id, factory_id, opportunity_id, created_at DESC);

CREATE TABLE growth_opportunity_evidence_gap_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  evidence_gap_id UUID NOT NULL,
  decision VARCHAR(20) NOT NULL,
  reason TEXT NOT NULL,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  actor_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  request_id UUID,
  trace_id UUID,
  CONSTRAINT fk_growth_gap_event_gap FOREIGN KEY (evidence_gap_id, tenant_id, factory_id, opportunity_id)
    REFERENCES growth_opportunity_evidence_gaps(id, tenant_id, factory_id, opportunity_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_gap_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_gap_event_decision CHECK (decision IN ('IN_REVIEW','RESOLVED','WAIVED','REOPENED')),
  CONSTRAINT chk_growth_gap_event_reason CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  CONSTRAINT chk_growth_gap_event_refs CHECK (jsonb_typeof(evidence_refs) = 'array'),
  CONSTRAINT chk_growth_gap_event_resolution_evidence CHECK (decision <> 'RESOLVED' OR jsonb_array_length(evidence_refs) > 0)
);
CREATE INDEX idx_growth_gap_events_latest
  ON growth_opportunity_evidence_gap_events (tenant_id, factory_id, opportunity_id, evidence_gap_id, created_at DESC, id DESC);

CREATE TABLE growth_opportunity_decision_owners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  role_code VARCHAR(32) NOT NULL,
  owner_user_id UUID NOT NULL,
  rationale TEXT NOT NULL,
  assigned_by UUID NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  active_to TIMESTAMPTZ,
  CONSTRAINT uq_growth_decision_owner_identity UNIQUE (id, tenant_id, factory_id, opportunity_id),
  CONSTRAINT fk_growth_decision_owner_opportunity FOREIGN KEY (opportunity_id, tenant_id, factory_id)
    REFERENCES growth_opportunities(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_decision_owner_user FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_decision_owner_assigner FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_decision_owner_role CHECK (role_code IN (
    'BUSINESS_OWNER','DECISION_OWNER','FINANCE_REVIEWER','OPERATIONS_REVIEWER',
    'QUALITY_REVIEWER','RISK_REVIEWER','EVIDENCE_OWNER'
  )),
  CONSTRAINT chk_growth_decision_owner_rationale CHECK (length(btrim(rationale)) BETWEEN 10 AND 2000),
  CONSTRAINT chk_growth_decision_owner_term CHECK (active_to IS NULL OR active_to >= assigned_at)
);
CREATE UNIQUE INDEX uq_growth_decision_owner_current_role
  ON growth_opportunity_decision_owners (tenant_id, factory_id, opportunity_id, role_code)
  WHERE active_to IS NULL;
CREATE INDEX idx_growth_decision_owner_history
  ON growth_opportunity_decision_owners (tenant_id, factory_id, opportunity_id, role_code, assigned_at DESC);

-- Preserve the creator/business owner as a role assignment without fabricating a
-- decision owner. A separate decision owner must be named before accepting.
INSERT INTO growth_opportunity_decision_owners (
  tenant_id, factory_id, opportunity_id, role_code, owner_user_id,
  rationale, assigned_by, assigned_at
)
SELECT tenant_id, factory_id, id, 'BUSINESS_OWNER', owner_user_id,
       'Baseline import of the opportunity business owner; original assignment history was not available.',
       created_by, created_at
FROM growth_opportunities
ON CONFLICT DO NOTHING;

-- Existing free-text assumptions remain visible but are marked as unvalidated.
INSERT INTO growth_opportunity_assumptions (
  tenant_id, factory_id, opportunity_id, statement, rationale, risk_if_false,
  confidence_pct, validation_method, initial_evidence_refs, owner_user_id,
  blocks_decision, created_by, created_at
)
SELECT o.tenant_id, o.factory_id, o.id,
       CASE WHEN length(btrim(a.statement)) >= 5
            THEN left(btrim(a.statement), 4000)
            ELSE 'Legacy assumption needs clarification: ' ||
                 COALESCE(NULLIF(left(btrim(a.statement), 3500), ''), 'blank previous value')
       END,
       'Imported from the legacy assumptions array; rationale/evidence must be reviewed. Original value: ' ||
         COALESCE(NULLIF(left(btrim(a.statement), 1000), ''), '[blank]'),
       'HIGH', 50,
       'Clarify the prior statement, attach evidence, and record a VALIDATED or reasoned WAIVED review decision.',
       '[]'::jsonb, o.owner_user_id, TRUE, o.created_by, o.created_at
FROM growth_opportunities o
CROSS JOIN LATERAL jsonb_array_elements_text(o.assumptions) AS a(statement);

CREATE OR REPLACE FUNCTION factoryos_guard_growth_assumptions_payload()
RETURNS TRIGGER LANGUAGE plpgsql AS $
DECLARE
  invalid_count INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.assumptions IS DISTINCT FROM OLD.assumptions THEN
    RAISE EXCEPTION 'GROWTH_OPPORTUNITY_ASSUMPTIONS_ARRAY_IS_IMMUTABLE_USE_GOVERNANCE_RECORDS'
      USING ERRCODE = '55000';
  END IF;
  IF jsonb_typeof(NEW.assumptions) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'GROWTH_OPPORTUNITY_ASSUMPTIONS_MUST_BE_AN_ARRAY'
      USING ERRCODE = '23514';
  END IF;
  SELECT COUNT(*)::integer INTO invalid_count
    FROM jsonb_array_elements(NEW.assumptions) AS item(value)
   WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'string'
      OR length(btrim(item.value #>> '{}')) < 5
      OR length(btrim(item.value #>> '{}')) > 2000;
  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'GROWTH_OPPORTUNITY_ASSUMPTIONS_MUST_BE_NONBLANK_STRINGS_OF_5_TO_2000_CHARACTERS'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$;
CREATE TRIGGER growth_opportunity_assumptions_payload_guard
BEFORE INSERT OR UPDATE OF assumptions ON growth_opportunities
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_assumptions_payload();

CREATE OR REPLACE FUNCTION factoryos_seed_growth_opportunity_assumptions()
RETURNS TRIGGER LANGUAGE plpgsql AS $
BEGIN
  INSERT INTO growth_opportunity_assumptions (
    tenant_id, factory_id, opportunity_id, statement, rationale, risk_if_false,
    confidence_pct, validation_method, initial_evidence_refs, owner_user_id,
    blocks_decision, created_by
  )
  SELECT NEW.tenant_id, NEW.factory_id, NEW.id, btrim(item.statement),
         'Imported from the opportunity assumptions payload; verify before decision.',
         'HIGH', 50,
         'Attach source evidence and submit an explicit VALIDATED, REFUTED or WAIVED review.',
         '[]'::jsonb, NEW.owner_user_id, TRUE, NEW.created_by
  FROM jsonb_array_elements_text(NEW.assumptions) AS item(statement);
  RETURN NEW;
END;
$$;
CREATE TRIGGER growth_opportunity_assumptions_seed
AFTER INSERT ON growth_opportunities
FOR EACH ROW EXECUTE FUNCTION factoryos_seed_growth_opportunity_assumptions();

CREATE OR REPLACE FUNCTION factoryos_growth_opportunity_evidence_ref_exists(
  p_tenant_id UUID, p_factory_id UUID, p_opportunity_id UUID, p_ref TEXT
) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM growth_opportunity_evidence e
     WHERE e.tenant_id = p_tenant_id AND e.factory_id = p_factory_id
       AND e.opportunity_id = p_opportunity_id
       AND (e.reference_ref = p_ref OR e.citation_url = p_ref
            OR e.research_claim_id::text = p_ref OR e.business_entity_id::text = p_ref)
  );
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_growth_assumption_decision()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_ref TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'GROWTH_ASSUMPTION_DECISIONS_ARE_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF NEW.decided_by IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.tenant_id IS DISTINCT FROM factoryos_current_tenant_id() THEN
    RAISE EXCEPTION 'GROWTH_ASSUMPTION_DECISION_ACTOR_OR_TENANT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF NEW.decision IN ('VALIDATED','REFUTED','WAIVED') THEN
    FOR v_ref IN SELECT jsonb_array_elements_text(NEW.evidence_refs) LOOP
      IF NOT factoryos_growth_opportunity_evidence_ref_exists(NEW.tenant_id, NEW.factory_id, NEW.opportunity_id, v_ref) THEN
        RAISE EXCEPTION 'GROWTH_ASSUMPTION_DECISION_EVIDENCE_NOT_ATTACHED_TO_OPPORTUNITY' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_growth_assumption_records()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'GROWTH_ASSUMPTION_RECORDS_ARE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.created_by IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.tenant_id IS DISTINCT FROM factoryos_current_tenant_id() THEN
    RAISE EXCEPTION 'GROWTH_ASSUMPTION_ACTOR_OR_TENANT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM users u JOIN tenant_memberships tm ON tm.user_id = u.id
     WHERE u.id = NEW.owner_user_id AND u.status = 'ACTIVE'
       AND tm.tenant_id = NEW.tenant_id AND tm.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'GROWTH_ASSUMPTION_OWNER_MUST_BE_AN_ACTIVE_TENANT_MEMBER' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$;
CREATE TRIGGER growth_opportunity_assumptions_immutable
BEFORE UPDATE OR DELETE ON growth_opportunity_assumptions
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_assumption_records();
CREATE TRIGGER growth_opportunity_assumption_decisions_append_only
BEFORE INSERT OR UPDATE OR DELETE ON growth_opportunity_assumption_decisions
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_assumption_decision();

CREATE OR REPLACE FUNCTION factoryos_guard_growth_constraint_record()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'GROWTH_CONSTRAINT_RECORDS_ARE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.created_by IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.tenant_id IS DISTINCT FROM factoryos_current_tenant_id() THEN
    RAISE EXCEPTION 'GROWTH_CONSTRAINT_ACTOR_OR_TENANT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF NEW.applicability = 'APPLICABLE'
     AND NOT factoryos_growth_opportunity_evidence_ref_exists(NEW.tenant_id, NEW.factory_id, NEW.opportunity_id, NEW.source_evidence_ref) THEN
    RAISE EXCEPTION 'GROWTH_CONSTRAINT_SOURCE_EVIDENCE_NOT_ATTACHED_TO_OPPORTUNITY' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM users u JOIN tenant_memberships tm ON tm.user_id = u.id
     WHERE u.id = NEW.owner_user_id AND u.status = 'ACTIVE'
       AND tm.tenant_id = NEW.tenant_id AND tm.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'GROWTH_CONSTRAINT_OWNER_MUST_BE_AN_ACTIVE_TENANT_MEMBER' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_as_of > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'GROWTH_CONSTRAINT_SOURCE_AS_OF_CANNOT_BE_IN_FUTURE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER growth_opportunity_constraints_immutable
BEFORE INSERT OR UPDATE OR DELETE ON growth_opportunity_constraints
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_constraint_record();

CREATE OR REPLACE FUNCTION factoryos_guard_growth_evidence_gap_record()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'GROWTH_EVIDENCE_GAP_RECORDS_ARE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.created_by IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.tenant_id IS DISTINCT FROM factoryos_current_tenant_id() THEN
    RAISE EXCEPTION 'GROWTH_EVIDENCE_GAP_ACTOR_OR_TENANT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM users u JOIN tenant_memberships tm ON tm.user_id = u.id
     WHERE u.id = NEW.owner_user_id AND u.status = 'ACTIVE'
       AND tm.tenant_id = NEW.tenant_id AND tm.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'GROWTH_EVIDENCE_GAP_OWNER_MUST_BE_AN_ACTIVE_TENANT_MEMBER' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$;
CREATE TRIGGER growth_opportunity_evidence_gaps_immutable
BEFORE UPDATE OR DELETE ON growth_opportunity_evidence_gaps
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_evidence_gap_record();

CREATE OR REPLACE FUNCTION factoryos_guard_growth_evidence_gap_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_ref TEXT;
  v_previous TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'GROWTH_EVIDENCE_GAP_EVENTS_ARE_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.tenant_id IS DISTINCT FROM factoryos_current_tenant_id() THEN
    RAISE EXCEPTION 'GROWTH_EVIDENCE_GAP_EVENT_ACTOR_OR_TENANT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  -- Serialize per-gap transitions so concurrent reviewers cannot both act on
  -- the same stale prior state and produce an invalid history ordering.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.evidence_gap_id::text, 0));
  SELECT decision INTO v_previous
    FROM growth_opportunity_evidence_gap_events
   WHERE evidence_gap_id = NEW.evidence_gap_id
     AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id AND opportunity_id = NEW.opportunity_id
   ORDER BY created_at DESC, id DESC LIMIT 1;
  IF v_previous IS NOT NULL AND NOT (
    (v_previous = 'IN_REVIEW' AND NEW.decision IN ('IN_REVIEW','RESOLVED','WAIVED','REOPENED'))
    OR (v_previous = 'REOPENED' AND NEW.decision IN ('IN_REVIEW','RESOLVED','WAIVED'))
    OR (v_previous = 'RESOLVED' AND NEW.decision = 'REOPENED')
    OR (v_previous = 'WAIVED' AND NEW.decision = 'REOPENED')
  ) THEN
    RAISE EXCEPTION 'GROWTH_EVIDENCE_GAP_INVALID_TRANSITION: % -> %', v_previous, NEW.decision USING ERRCODE = '23514';
  END IF;
  IF NEW.decision = 'RESOLVED' THEN
    FOR v_ref IN SELECT jsonb_array_elements_text(NEW.evidence_refs) LOOP
      IF NOT factoryos_growth_opportunity_evidence_ref_exists(NEW.tenant_id, NEW.factory_id, NEW.opportunity_id, v_ref) THEN
        RAISE EXCEPTION 'GROWTH_EVIDENCE_GAP_RESOLUTION_EVIDENCE_NOT_ATTACHED_TO_OPPORTUNITY' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER growth_opportunity_evidence_gap_events_append_only
BEFORE INSERT OR UPDATE OR DELETE ON growth_opportunity_evidence_gap_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_evidence_gap_event();

CREATE OR REPLACE FUNCTION factoryos_guard_growth_decision_owner_assignment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_created_by UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GROWTH_DECISION_OWNER_ASSIGNMENTS_CANNOT_BE_DELETED' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.active_to IS NOT NULL OR NEW.active_to IS NULL
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
       OR NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id
       OR NEW.role_code IS DISTINCT FROM OLD.role_code
       OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
       OR NEW.rationale IS DISTINCT FROM OLD.rationale
       OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by
       OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
       OR NEW.active_to < OLD.assigned_at THEN
      RAISE EXCEPTION 'GROWTH_DECISION_OWNER_HISTORY_IS_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF NEW.active_to IS DISTINCT FROM OLD.active_to
       AND factoryos_current_user_id() IS NULL THEN
      RAISE EXCEPTION 'GROWTH_DECISION_OWNER_CLOSER_REQUIRED' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.assigned_by IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.tenant_id IS DISTINCT FROM factoryos_current_tenant_id() THEN
    RAISE EXCEPTION 'GROWTH_DECISION_OWNER_ASSIGNMENT_ACTOR_OR_TENANT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM users u JOIN tenant_memberships tm ON tm.user_id = u.id
     WHERE u.id = NEW.owner_user_id AND u.status = 'ACTIVE'
       AND tm.tenant_id = NEW.tenant_id AND tm.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'GROWTH_DECISION_OWNER_MUST_BE_AN_ACTIVE_TENANT_MEMBER' USING ERRCODE = '23514';
  END IF;
  SELECT created_by INTO v_created_by FROM growth_opportunities
   WHERE id = NEW.opportunity_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
  IF NOT EXISTS (
    SELECT 1
      FROM users u
      JOIN tenant_memberships tm ON tm.user_id = u.id
     WHERE u.id = NEW.owner_user_id
       AND u.status = 'ACTIVE'
       AND tm.tenant_id = NEW.tenant_id
       AND tm.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'GROWTH_DECISION_OWNER_MUST_BE_AN_ACTIVE_TENANT_MEMBER' USING ERRCODE = '23514';
  END IF;
  IF NEW.role_code = 'DECISION_OWNER' AND NEW.owner_user_id = v_created_by THEN
    RAISE EXCEPTION 'GROWTH_DECISION_OWNER_MUST_DIFFER_FROM_OPPORTUNITY_CREATOR' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER growth_opportunity_decision_owner_guard
BEFORE INSERT OR UPDATE OR DELETE ON growth_opportunity_decision_owners
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_decision_owner_assignment();

CREATE TABLE growth_opportunity_decision_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  decision VARCHAR(12) NOT NULL,
  actor_user_id UUID NOT NULL,
  owner_assignment_id UUID NOT NULL,
  reason TEXT NOT NULL,
  readiness_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id UUID,
  trace_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_growth_opportunity_decision_history_opportunity FOREIGN KEY (opportunity_id, tenant_id, factory_id)
    REFERENCES growth_opportunities(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_opportunity_decision_history_owner FOREIGN KEY (owner_assignment_id, tenant_id, factory_id, opportunity_id)
    REFERENCES growth_opportunity_decision_owners(id, tenant_id, factory_id, opportunity_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_opportunity_decision_history_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_opportunity_decision_history_decision CHECK (decision IN ('ACCEPT','REJECT')),
  CONSTRAINT chk_growth_opportunity_decision_history_reason CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  CONSTRAINT chk_growth_opportunity_decision_history_snapshot CHECK (jsonb_typeof(readiness_snapshot) = 'object')
);
CREATE INDEX idx_growth_opportunity_decision_history
  ON growth_opportunity_decision_history (tenant_id, factory_id, opportunity_id, created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_growth_opportunity_decision_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'GROWTH_OPPORTUNITY_DECISION_HISTORY_IS_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.tenant_id IS DISTINCT FROM factoryos_current_tenant_id()
     OR NOT EXISTS (
       SELECT 1 FROM growth_opportunity_decision_owners own
        WHERE own.id = NEW.owner_assignment_id
          AND own.tenant_id = NEW.tenant_id AND own.factory_id = NEW.factory_id
          AND own.opportunity_id = NEW.opportunity_id
          AND own.role_code = 'DECISION_OWNER'
          AND own.owner_user_id = NEW.actor_user_id
     ) THEN
    RAISE EXCEPTION 'GROWTH_OPPORTUNITY_DECISION_HISTORY_ACTOR_OR_OWNER_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER growth_opportunity_decision_history_append_only
BEFORE INSERT OR UPDATE OR DELETE ON growth_opportunity_decision_history
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_opportunity_decision_history();

CREATE OR REPLACE FUNCTION factoryos_growth_opportunity_governance_ready(
  p_tenant_id UUID, p_factory_id UUID, p_opportunity_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_dimension TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM growth_opportunity_evidence
     WHERE tenant_id = p_tenant_id AND factory_id = p_factory_id AND opportunity_id = p_opportunity_id
  ) THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM growth_opportunity_assumptions a
    LEFT JOIN LATERAL (
      SELECT d.decision, d.evidence_refs
        FROM growth_opportunity_assumption_decisions d
       WHERE d.assumption_id = a.id AND d.tenant_id = a.tenant_id
         AND d.factory_id = a.factory_id AND d.opportunity_id = a.opportunity_id
       ORDER BY d.decided_at DESC, d.id DESC LIMIT 1
    ) last_decision ON TRUE
    WHERE a.tenant_id = p_tenant_id AND a.factory_id = p_factory_id
      AND a.opportunity_id = p_opportunity_id AND a.blocks_decision
      AND (COALESCE(last_decision.decision NOT IN ('VALIDATED','WAIVED'), TRUE)
        OR COALESCE(jsonb_array_length(last_decision.evidence_refs), 0) = 0)
  ) THEN
    RETURN FALSE;
  END IF;

  FOREACH v_dimension IN ARRAY ARRAY['CAPACITY','QUALITY','CASH','DELIVERY'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM growth_opportunity_constraints c
       WHERE c.tenant_id = p_tenant_id AND c.factory_id = p_factory_id
         AND c.opportunity_id = p_opportunity_id AND c.dimension = v_dimension
         AND c.applicability <> 'UNKNOWN'
         AND c.id = (
           SELECT c2.id FROM growth_opportunity_constraints c2
            WHERE c2.tenant_id = c.tenant_id AND c2.factory_id = c.factory_id
              AND c2.opportunity_id = c.opportunity_id AND c2.dimension = c.dimension
            ORDER BY c2.created_at DESC, c2.id DESC LIMIT 1
         )
         AND (c.applicability = 'NOT_APPLICABLE' AND length(btrim(c.rationale)) >= 10
           OR (c.applicability = 'APPLICABLE'
             AND c.source_evidence_ref IS NOT NULL AND c.source_as_of IS NOT NULL
             AND c.threshold_value IS NOT NULL AND c.observed_value IS NOT NULL
             AND factoryos_growth_opportunity_evidence_ref_exists(
               c.tenant_id, c.factory_id, c.opportunity_id, c.source_evidence_ref
             )))
    ) THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM growth_opportunity_evidence_gaps g
    LEFT JOIN LATERAL (
      SELECT e.decision, e.evidence_refs
        FROM growth_opportunity_evidence_gap_events e
       WHERE e.evidence_gap_id = g.id AND e.tenant_id = g.tenant_id
         AND e.factory_id = g.factory_id AND e.opportunity_id = g.opportunity_id
       ORDER BY e.created_at DESC, e.id DESC LIMIT 1
    ) latest ON TRUE
    WHERE g.tenant_id = p_tenant_id AND g.factory_id = p_factory_id
      AND g.opportunity_id = p_opportunity_id AND g.blocks_decision
      AND (latest.decision IS NULL OR latest.decision NOT IN ('RESOLVED','WAIVED')
        OR (latest.decision = 'RESOLVED' AND COALESCE(jsonb_array_length(latest.evidence_refs), 0) = 0))
  ) THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_growth_opportunity_lifecycle()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
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

    IF NEW.status IN ('ACCEPTED','REJECTED') THEN
      IF NOT EXISTS (
        SELECT 1 FROM users u JOIN tenant_memberships tm ON tm.user_id = u.id
         WHERE u.id = NEW.decided_by AND u.status = 'ACTIVE'
           AND tm.tenant_id = NEW.tenant_id AND tm.status = 'ACTIVE'
      ) THEN
        RAISE EXCEPTION 'GROWTH_OPPORTUNITY_DECISION_ACTOR_MUST_BE_AN_ACTIVE_TENANT_MEMBER' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM growth_opportunity_decision_owners own
         WHERE own.tenant_id = NEW.tenant_id AND own.factory_id = NEW.factory_id
           AND own.opportunity_id = NEW.id AND own.role_code = 'DECISION_OWNER'
           AND own.owner_user_id = NEW.decided_by AND own.active_to IS NULL
      ) THEN
        RAISE EXCEPTION 'GROWTH_OPPORTUNITY_REQUIRES_THE_ASSIGNED_DECISION_OWNER' USING ERRCODE = '23514';
      END IF;
      IF NEW.decided_by IS DISTINCT FROM factoryos_current_user_id()
         OR NEW.tenant_id IS DISTINCT FROM factoryos_current_tenant_id() THEN
        RAISE EXCEPTION 'GROWTH_OPPORTUNITY_DECISION_ACTOR_OR_TENANT_MISMATCH' USING ERRCODE = '42501';
      END IF;
    END IF;

    IF NEW.status = 'ACCEPTED' THEN
      SELECT COUNT(*) INTO evidence_count
      FROM growth_opportunity_evidence
      WHERE opportunity_id = NEW.id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
      IF evidence_count = 0 OR length(btrim(NEW.success_hypothesis)) = 0 THEN
        RAISE EXCEPTION 'Growth opportunities require evidence and a measurable hypothesis before acceptance'
          USING ERRCODE = '23514';
      END IF;
      IF NOT factoryos_growth_opportunity_governance_ready(NEW.tenant_id, NEW.factory_id, NEW.id) THEN
        RAISE EXCEPTION 'GROWTH_OPPORTUNITY_GOVERNANCE_INCOMPLETE: assumptions, core constraints and blocking evidence gaps must be resolved'
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

-- All new records are tenant-isolated even when bypassing the HTTP layer.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'growth_opportunity_assumptions',
    'growth_opportunity_assumption_decisions',
    'growth_opportunity_constraints',
    'growth_opportunity_evidence_gaps',
    'growth_opportunity_evidence_gap_events',
    'growth_opportunity_decision_owners',
    'growth_opportunity_decision_history'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('143_growth_opportunity_governance', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
