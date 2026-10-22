BEGIN;

-- Task 22: bind live planner/executor traces to the exact immutable agent definition
-- and persist evaluation results separately from synthetic sandbox results.
ALTER TABLE agent_tasks
  ADD COLUMN IF NOT EXISTS agent_definition_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='agent_tasks'::regclass
      AND conname='fk_agent_task_agent_definition_scope'
  ) THEN
    ALTER TABLE agent_tasks
      ADD CONSTRAINT fk_agent_task_agent_definition_scope
      FOREIGN KEY (agent_definition_id,tenant_id,factory_id)
      REFERENCES ai_agent_definitions (id,tenant_id,factory_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_definition
  ON agent_tasks (tenant_id,factory_id,agent_definition_id,created_at DESC)
  WHERE agent_definition_id IS NOT NULL;

ALTER TABLE ai_agent_evaluation_cases
  DROP CONSTRAINT IF EXISTS chk_ai_agent_evaluation_case_kind;
ALTER TABLE ai_agent_evaluation_cases
  ADD CONSTRAINT chk_ai_agent_evaluation_case_kind
  CHECK (kind IN ('EXPECTED_TOOL_CALL','EXPECTED_REFUSAL','PRIVACY_NO_SECRET_LEAKAGE'));

ALTER TABLE ai_agent_evaluation_cases
  DROP CONSTRAINT IF EXISTS chk_ai_agent_evaluation_case_expectation;
ALTER TABLE ai_agent_evaluation_cases
  ADD CONSTRAINT chk_ai_agent_evaluation_case_expectation
  CHECK (
    (kind='EXPECTED_TOOL_CALL' AND expected_tool_id IS NOT NULL)
    OR (kind='EXPECTED_REFUSAL' AND
        (expected_tool_id IS NOT NULL OR expected_refusal_reason_contains IS NOT NULL))
    OR kind='PRIVACY_NO_SECRET_LEAKAGE'
  );

CREATE TABLE IF NOT EXISTS ai_agent_live_evaluation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  case_id UUID NOT NULL,
  agent_task_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL,
  expected_summary JSONB NOT NULL,
  observed_summary JSONB NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_ai_agent_live_evaluation_case_task UNIQUE (case_id,agent_task_id),
  CONSTRAINT fk_ai_agent_live_evaluation_case
    FOREIGN KEY (case_id,tenant_id,factory_id)
    REFERENCES ai_agent_evaluation_cases (id,tenant_id,factory_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_ai_agent_live_evaluation_task
    FOREIGN KEY (agent_task_id,tenant_id,factory_id)
    REFERENCES agent_tasks (id,tenant_id,factory_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_ai_agent_live_evaluation_creator
    FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_ai_agent_live_evaluation_status
    CHECK (status IN ('PASS','FAIL','INCONCLUSIVE')),
  CONSTRAINT chk_ai_agent_live_evaluation_expected
    CHECK (jsonb_typeof(expected_summary)='object'),
  CONSTRAINT chk_ai_agent_live_evaluation_observed
    CHECK (jsonb_typeof(observed_summary)='object')
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_live_evaluation_results_report
  ON ai_agent_live_evaluation_results (tenant_id,factory_id,case_id,created_at DESC);

ALTER TABLE ai_agent_live_evaluation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_live_evaluation_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_live_evaluation_results_tenant_isolation
  ON ai_agent_live_evaluation_results;
CREATE POLICY ai_agent_live_evaluation_results_tenant_isolation
  ON ai_agent_live_evaluation_results
  USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

DROP TRIGGER IF EXISTS ai_agent_live_evaluation_results_immutable
  ON ai_agent_live_evaluation_results;
CREATE TRIGGER ai_agent_live_evaluation_results_immutable
  BEFORE UPDATE OR DELETE ON ai_agent_live_evaluation_results
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

INSERT INTO schema_migrations (version,checksum)
VALUES ('180_ai_agent_live_execution_evaluation',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
