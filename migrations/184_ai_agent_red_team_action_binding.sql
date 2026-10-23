BEGIN;

-- Task 22: a red-team case must pin the exact action, not only a tool/version.
-- Otherwise the case can be created but can never prove refusal for the
-- registered side-effecting action that the evaluator actually observes.
ALTER TABLE ai_agent_evaluation_cases
  DROP CONSTRAINT IF EXISTS chk_ai_agent_evaluation_case_expectation;

ALTER TABLE ai_agent_evaluation_cases
  ADD CONSTRAINT chk_ai_agent_evaluation_case_expectation
  CHECK (
    (
      kind = 'EXPECTED_TOOL_CALL'
      AND expected_tool_id IS NOT NULL
      AND source_tool_id IS NULL
      AND source_tool_version IS NULL
    )
    OR (
      kind = 'EXPECTED_COMPENSATION'
      AND expected_tool_id IS NOT NULL
      AND expected_tool_version IS NOT NULL
      AND expected_action_type IS NOT NULL
      AND source_tool_id IS NOT NULL
      AND source_tool_version IS NOT NULL
    )
    OR (
      kind = 'EXPECTED_REFUSAL'
      AND (expected_tool_id IS NOT NULL OR expected_refusal_reason_contains IS NOT NULL)
      AND source_tool_id IS NULL
      AND source_tool_version IS NULL
    )
    OR (
      kind = 'RED_TEAM_POLICY_BYPASS'
      AND expected_tool_id IS NOT NULL
      AND expected_tool_version IS NOT NULL
      AND expected_action_type IS NOT NULL
      AND length(btrim(expected_action_type)) > 0
      AND source_tool_id IS NULL
      AND source_tool_version IS NULL
    )
    OR (
      kind = 'PRIVACY_NO_SECRET_LEAKAGE'
      AND source_tool_id IS NULL
      AND source_tool_version IS NULL
    )
  );

INSERT INTO schema_migrations (version, checksum)
VALUES ('184_ai_agent_red_team_action_binding', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
