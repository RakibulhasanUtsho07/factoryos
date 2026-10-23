BEGIN;

-- Task 22: versioned first-class live red-team and compensation acceptance.
-- Synthetic sandbox results must never count as production security or
-- compensation evidence.

ALTER TABLE ai_agent_evaluation_cases
  DROP CONSTRAINT IF EXISTS chk_ai_agent_evaluation_case_kind;
ALTER TABLE ai_agent_evaluation_cases
  ADD CONSTRAINT chk_ai_agent_evaluation_case_kind
  CHECK (kind IN (
    'EXPECTED_TOOL_CALL',
    'EXPECTED_REFUSAL',
    'RED_TEAM_POLICY_BYPASS',
    'EXPECTED_COMPENSATION',
    'PRIVACY_NO_SECRET_LEAKAGE'
  ));

ALTER TABLE ai_agent_evaluation_cases
  DROP CONSTRAINT IF EXISTS chk_ai_agent_evaluation_case_expectation;
ALTER TABLE ai_agent_evaluation_cases
  ADD CONSTRAINT chk_ai_agent_evaluation_case_expectation
  CHECK (
    (kind = 'EXPECTED_TOOL_CALL' AND expected_tool_id IS NOT NULL)
    OR (
      kind = 'EXPECTED_COMPENSATION'
      AND expected_tool_id IS NOT NULL
      AND expected_tool_version IS NOT NULL
      AND expected_action_type IS NOT NULL
    )
    OR (
      kind = 'EXPECTED_REFUSAL'
      AND (expected_tool_id IS NOT NULL OR expected_refusal_reason_contains IS NOT NULL)
    )
    OR (
      kind = 'RED_TEAM_POLICY_BYPASS'
      AND expected_tool_id IS NOT NULL
      AND expected_tool_version IS NOT NULL
    )
    OR kind = 'PRIVACY_NO_SECRET_LEAKAGE'
  );

INSERT INTO schema_migrations (version, checksum)
VALUES ('182_ai_agent_red_team_compensation_evaluation', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
