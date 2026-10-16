BEGIN;

-- FR-AGT-06: immutable per-agent expected-call/refusal cases and result history.
-- Evaluation uses previously recorded simulation runs; it never executes tools.

CREATE TABLE IF NOT EXISTS ai_agent_evaluation_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  agent_definition_id UUID NOT NULL,
  case_key VARCHAR(160) NOT NULL,
  case_version INTEGER NOT NULL,
  name VARCHAR(200) NOT NULL,
  description VARCHAR(2000),
  kind VARCHAR(30) NOT NULL,
  expected_tool_id VARCHAR(200),
  expected_tool_version VARCHAR(100),
  expected_action_type VARCHAR(200),
  expected_input_subset JSONB NOT NULL DEFAULT '{}'::JSONB,
  expected_refusal_reason_contains VARCHAR(300),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_ai_agent_evaluation_case_key_version
    UNIQUE (tenant_id, factory_id, agent_definition_id, case_key, case_version),
  CONSTRAINT uq_ai_agent_evaluation_case_id_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_ai_agent_evaluation_case_definition
    FOREIGN KEY (agent_definition_id, tenant_id, factory_id)
    REFERENCES ai_agent_definitions (id, tenant_id, factory_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_ai_agent_evaluation_case_creator
    FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_ai_agent_evaluation_case_key
    CHECK (LENGTH(BTRIM(case_key)) > 0),
  CONSTRAINT chk_ai_agent_evaluation_case_version CHECK (case_version >= 1),
  CONSTRAINT chk_ai_agent_evaluation_case_name CHECK (LENGTH(BTRIM(name)) > 0),
  CONSTRAINT chk_ai_agent_evaluation_case_kind CHECK (kind IN ('EXPECTED_TOOL_CALL', 'EXPECTED_REFUSAL')),
  CONSTRAINT chk_ai_agent_evaluation_case_status CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT chk_ai_agent_evaluation_case_tool_pair
    CHECK (
      (expected_tool_id IS NULL AND expected_tool_version IS NULL)
      OR (LENGTH(BTRIM(expected_tool_id)) > 0 AND LENGTH(BTRIM(expected_tool_version)) > 0)
    ),
  CONSTRAINT chk_ai_agent_evaluation_case_expectation
    CHECK (
      (kind = 'EXPECTED_TOOL_CALL' AND expected_tool_id IS NOT NULL)
      OR (kind = 'EXPECTED_REFUSAL' AND
        (expected_tool_id IS NOT NULL OR expected_refusal_reason_contains IS NOT NULL))
    ),
  CONSTRAINT chk_ai_agent_evaluation_case_input
    CHECK (jsonb_typeof(expected_input_subset) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_evaluation_cases_latest
ON ai_agent_evaluation_cases (tenant_id, factory_id, agent_definition_id, case_key, case_version DESC);

ALTER TABLE ai_agent_evaluation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_evaluation_cases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_evaluation_cases_tenant_isolation ON ai_agent_evaluation_cases;
CREATE POLICY ai_agent_evaluation_cases_tenant_isolation ON ai_agent_evaluation_cases
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());
DROP TRIGGER IF EXISTS ai_agent_evaluation_cases_immutable ON ai_agent_evaluation_cases;
CREATE TRIGGER ai_agent_evaluation_cases_immutable
BEFORE UPDATE OR DELETE ON ai_agent_evaluation_cases
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

CREATE TABLE IF NOT EXISTS ai_agent_evaluation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  case_id UUID NOT NULL,
  simulation_run_id UUID NOT NULL,
  sandbox_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL,
  expected_summary JSONB NOT NULL,
  observed_summary JSONB NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_ai_agent_evaluation_result_case_run UNIQUE (case_id, simulation_run_id),
  CONSTRAINT fk_ai_agent_evaluation_result_case
    FOREIGN KEY (case_id, tenant_id, factory_id)
    REFERENCES ai_agent_evaluation_cases (id, tenant_id, factory_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_ai_agent_evaluation_result_run
    FOREIGN KEY (simulation_run_id) REFERENCES simulation_runs (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ai_agent_evaluation_result_sandbox
    FOREIGN KEY (sandbox_id, tenant_id, factory_id)
    REFERENCES agent_sandboxes (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ai_agent_evaluation_result_creator
    FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_ai_agent_evaluation_result_status CHECK (status IN ('PASS', 'FAIL', 'INCONCLUSIVE')),
  CONSTRAINT chk_ai_agent_evaluation_result_expected CHECK (jsonb_typeof(expected_summary) = 'object'),
  CONSTRAINT chk_ai_agent_evaluation_result_observed CHECK (jsonb_typeof(observed_summary) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_evaluation_results_report
ON ai_agent_evaluation_results (tenant_id, factory_id, case_id, created_at DESC);
ALTER TABLE ai_agent_evaluation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_evaluation_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_evaluation_results_tenant_isolation ON ai_agent_evaluation_results;
CREATE POLICY ai_agent_evaluation_results_tenant_isolation ON ai_agent_evaluation_results
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());
DROP TRIGGER IF EXISTS ai_agent_evaluation_results_immutable ON ai_agent_evaluation_results;
CREATE TRIGGER ai_agent_evaluation_results_immutable
BEFORE UPDATE OR DELETE ON ai_agent_evaluation_results
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

INSERT INTO schema_migrations (version, checksum)
VALUES ('031_ai_agent_evaluation_cases', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
