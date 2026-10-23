BEGIN;

ALTER TABLE ai_agent_evaluation_cases
  ADD COLUMN IF NOT EXISTS source_tool_id VARCHAR(200);
ALTER TABLE ai_agent_evaluation_cases
  ADD COLUMN IF NOT EXISTS source_tool_version VARCHAR(100);

ALTER TABLE ai_agent_evaluation_cases
  DROP CONSTRAINT IF EXISTS chk_ai_agent_evaluation_case_expectation;
ALTER TABLE ai_agent_evaluation_cases
  ADD CONSTRAINT chk_ai_agent_evaluation_case_expectation
  CHECK (
    (kind = 'EXPECTED_TOOL_CALL' AND expected_tool_id IS NOT NULL
      AND source_tool_id IS NULL AND source_tool_version IS NULL)
    OR (
      kind = 'EXPECTED_COMPENSATION'
      AND expected_tool_id IS NOT NULL AND expected_tool_version IS NOT NULL
      AND expected_action_type IS NOT NULL
      AND source_tool_id IS NOT NULL AND source_tool_version IS NOT NULL
    )
    OR (
      kind = 'EXPECTED_REFUSAL'
      AND (expected_tool_id IS NOT NULL OR expected_refusal_reason_contains IS NOT NULL)
      AND source_tool_id IS NULL AND source_tool_version IS NULL
    )
    OR (
      kind = 'RED_TEAM_POLICY_BYPASS'
      AND expected_tool_id IS NOT NULL AND expected_tool_version IS NOT NULL
      AND source_tool_id IS NULL AND source_tool_version IS NULL
    )
    OR (kind = 'PRIVACY_NO_SECRET_LEAKAGE'
      AND source_tool_id IS NULL AND source_tool_version IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_ai_agent_eval_case_source_executor
  ON ai_agent_evaluation_cases
    (tenant_id, factory_id, agent_definition_id, source_tool_id, source_tool_version, status)
  WHERE kind = 'EXPECTED_COMPENSATION';

INSERT INTO schema_migrations (version, checksum)
VALUES ('183_ai_agent_executor_case_source_binding', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
