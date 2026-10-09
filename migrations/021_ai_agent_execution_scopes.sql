BEGIN;

ALTER TABLE ai_agent_definitions
  ADD COLUMN IF NOT EXISTS execution_scopes TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'ai_agent_definitions'::regclass
      AND conname = 'chk_ai_agent_definition_execution_scopes'
  ) THEN
    ALTER TABLE ai_agent_definitions
      ADD CONSTRAINT chk_ai_agent_definition_execution_scopes
      CHECK (
        array_position(execution_scopes, '') IS NULL
        AND (
          array_length(execution_scopes, 1) IS NULL
          OR array_length(execution_scopes, 1) <= 100
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_agent_definitions_execution_scopes
  ON ai_agent_definitions
  USING GIN (execution_scopes);

UPDATE ai_agent_definitions d
SET execution_scopes = COALESCE(
  (
    SELECT ARRAY(
      SELECT DISTINCT required_scope.scope
      FROM ai_agent_tool_grants g
      CROSS JOIN LATERAL (
        SELECT tr.required_scopes
        FROM ai_tool_registry tr
        WHERE tr.tool_id = g.tool_id
          AND tr.version = g.tool_version
          AND tr.status = 'ACTIVE'
          AND (tr.tenant_id IS NULL OR tr.tenant_id = d.tenant_id)
          AND (tr.factory_id IS NULL OR tr.factory_id = d.factory_id)
        ORDER BY CASE
          WHEN tr.tenant_id = d.tenant_id AND tr.factory_id = d.factory_id THEN 1
          WHEN tr.tenant_id = d.tenant_id AND tr.factory_id IS NULL THEN 2
          WHEN tr.tenant_id IS NULL AND tr.factory_id IS NULL THEN 3
          ELSE 4
        END
        LIMIT 1
      ) resolved_tool
      CROSS JOIN LATERAL unnest(
        COALESCE(resolved_tool.required_scopes, '{}'::TEXT[])
      ) AS required_scope(scope)
      WHERE g.tenant_id = d.tenant_id
        AND g.factory_id = d.factory_id
        AND g.agent_definition_id = d.id
        AND g.status = 'ACTIVE'
        AND g.effective_from <= NOW()
        AND (g.expires_at IS NULL OR g.expires_at > NOW())
      ORDER BY required_scope.scope
    )
  ),
  '{}'::TEXT[]
);

INSERT INTO schema_migrations (
  version,
  checksum
)
VALUES (
  '021_ai_agent_execution_scopes',
  NULL
)
ON CONFLICT (version)
DO NOTHING;

COMMIT;
