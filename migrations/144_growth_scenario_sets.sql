BEGIN;

-- Reproducible scenario runs: one immutable, versioned input snapshot owns
-- exactly one BASE/UPSIDE/DOWNSIDE/STRESS case plus bounded one-factor
-- sensitivity points. Scenario outputs remain in growth_scenarios.
ALTER TABLE growth_scenarios
  ADD CONSTRAINT uq_growth_scenario_scope
  UNIQUE (id, tenant_id, factory_id, opportunity_id);

CREATE TABLE growth_scenario_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  set_name VARCHAR(140) NOT NULL,
  set_version INTEGER NOT NULL,
  model_version VARCHAR(100) NOT NULL,
  data_vintage TIMESTAMPTZ NOT NULL,
  baseline_source_ref TEXT NOT NULL,
  inputs JSONB NOT NULL,
  input_hash VARCHAR(64) NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_growth_scenario_set_version
    UNIQUE (tenant_id, factory_id, opportunity_id, set_version),
  CONSTRAINT uq_growth_scenario_set_scope
    UNIQUE (id, tenant_id, factory_id, opportunity_id),
  CONSTRAINT fk_growth_scenario_set_opportunity
    FOREIGN KEY (opportunity_id, tenant_id, factory_id)
    REFERENCES growth_opportunities(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_scenario_set_creator
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_scenario_set_name
    CHECK (length(btrim(set_name)) BETWEEN 1 AND 140),
  CONSTRAINT chk_growth_scenario_set_version
    CHECK (set_version > 0),
  CONSTRAINT chk_growth_scenario_set_model
    CHECK (length(btrim(model_version)) BETWEEN 1 AND 100),
  CONSTRAINT chk_growth_scenario_set_vintage
    CHECK (data_vintage <= clock_timestamp() + interval '5 minutes'),
  CONSTRAINT chk_growth_scenario_set_source
    CHECK (length(btrim(baseline_source_ref)) BETWEEN 1 AND 2000),
  CONSTRAINT chk_growth_scenario_set_inputs
    CHECK (jsonb_typeof(inputs) = 'object'),
  CONSTRAINT chk_growth_scenario_set_hash
    CHECK (input_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_growth_scenario_sets_history
  ON growth_scenario_sets (tenant_id, factory_id, opportunity_id, set_version DESC);

CREATE TABLE growth_scenario_set_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  scenario_set_id UUID NOT NULL,
  scenario_id UUID NOT NULL,
  scenario_key VARCHAR(200) NOT NULL,
  scenario_type VARCHAR(20) NOT NULL,
  sensitivity_parameter VARCHAR(60),
  sensitivity_value NUMERIC(20,4),
  position INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_growth_scenario_set_member_key
    UNIQUE (scenario_set_id, scenario_key),
  CONSTRAINT uq_growth_scenario_set_member_scenario
    UNIQUE (scenario_id),
  CONSTRAINT fk_growth_scenario_set_member_set
    FOREIGN KEY (scenario_set_id, tenant_id, factory_id, opportunity_id)
    REFERENCES growth_scenario_sets(id, tenant_id, factory_id, opportunity_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_scenario_set_member_scenario
    FOREIGN KEY (scenario_id, tenant_id, factory_id, opportunity_id)
    REFERENCES growth_scenarios(id, tenant_id, factory_id, opportunity_id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_scenario_set_member_key
    CHECK (length(btrim(scenario_key)) BETWEEN 1 AND 200),
  CONSTRAINT chk_growth_scenario_set_member_type
    CHECK (scenario_type IN ('BASE', 'UPSIDE', 'DOWNSIDE', 'STRESS', 'CUSTOM')),
  CONSTRAINT chk_growth_scenario_set_member_position
    CHECK (position > 0),
  CONSTRAINT chk_growth_scenario_set_member_sensitivity
    CHECK (
      (scenario_type = 'CUSTOM'
        AND sensitivity_parameter IN (
          'price_change_pct', 'volume_change_pct', 'variable_cost_change_pct',
          'fixed_cost_change_pct', 'investment', 'uncertainty_pct'
        )
        AND sensitivity_value IS NOT NULL)
      OR (scenario_type <> 'CUSTOM'
        AND scenario_type IN ('BASE', 'UPSIDE', 'DOWNSIDE', 'STRESS')
        AND sensitivity_parameter IS NULL AND sensitivity_value IS NULL)
    )
);
CREATE INDEX idx_growth_scenario_set_members_order
  ON growth_scenario_set_members
  (tenant_id, factory_id, opportunity_id, scenario_set_id, position);

CREATE OR REPLACE FUNCTION factoryos_guard_growth_scenario_set_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  expected_version INTEGER;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM factoryos_current_tenant_id()
     OR NEW.created_by IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_ACTOR_OR_TENANT_MISMATCH'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM growth_opportunities o
   WHERE o.id = NEW.opportunity_id
     AND o.tenant_id = NEW.tenant_id
     AND o.factory_id = NEW.factory_id
     AND o.status IN ('ACCEPTED', 'IN_PROGRESS')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_REQUIRES_OPEN_ACCEPTED_OPPORTUNITY'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(MAX(s.set_version), 0) + 1
    INTO expected_version
    FROM growth_scenario_sets s
   WHERE s.tenant_id = NEW.tenant_id
     AND s.factory_id = NEW.factory_id
     AND s.opportunity_id = NEW.opportunity_id;
  IF NEW.set_version IS DISTINCT FROM expected_version THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_VERSION_MUST_BE_NEXT: expected %, got %',
      expected_version, NEW.set_version
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER growth_scenario_set_version_guard
BEFORE INSERT ON growth_scenario_sets
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_scenario_set_version();

CREATE OR REPLACE FUNCTION factoryos_guard_growth_scenario_set_member()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_version INTEGER;
  parent_hash TEXT;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM factoryos_current_tenant_id() THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_MEMBER_TENANT_MISMATCH'
      USING ERRCODE = '42501';
  END IF;

  SELECT s.set_version, s.input_hash
    INTO parent_version, parent_hash
    FROM growth_scenario_sets s
   WHERE s.id = NEW.scenario_set_id
     AND s.tenant_id = NEW.tenant_id
     AND s.factory_id = NEW.factory_id
     AND s.opportunity_id = NEW.opportunity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_MEMBER_PARENT_SCOPE_MISMATCH'
      USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM growth_scenarios s
     WHERE s.id = NEW.scenario_id
       AND s.tenant_id = NEW.tenant_id
       AND s.factory_id = NEW.factory_id
       AND s.opportunity_id = NEW.opportunity_id
       AND s.scenario_type = NEW.scenario_type
       AND s.inputs #>> '{scenario_set,id}' = NEW.scenario_set_id::TEXT
       AND s.inputs #>> '{scenario_set,version}' = parent_version::TEXT
       AND s.inputs #>> '{scenario_set,input_hash}' = parent_hash
  ) THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_MEMBER_OUTPUT_OR_SNAPSHOT_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.scenario_type = 'CUSTOM'
     AND (NEW.sensitivity_parameter IS NULL OR NEW.sensitivity_value IS NULL) THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SENSITIVITY_METADATA_REQUIRED'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER growth_scenario_set_member_guard
BEFORE INSERT ON growth_scenario_set_members
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_scenario_set_member();

CREATE TRIGGER growth_scenario_sets_immutable
BEFORE UPDATE OR DELETE ON growth_scenario_sets
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_growth_snapshot_mutation();
CREATE TRIGGER growth_scenario_set_members_immutable
BEFORE UPDATE OR DELETE ON growth_scenario_set_members
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_growth_snapshot_mutation();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'growth_scenario_sets',
    'growth_scenario_set_members'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id())',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('144_growth_scenario_sets', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
