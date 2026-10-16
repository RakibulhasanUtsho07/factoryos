BEGIN;

-- ============================================================
-- WP06 / FR-AGT-01 AGENT LANGUAGE AND OWNER METADATA
-- ============================================================
-- Preserve immutable historical definitions. Existing rows receive
-- the compatibility language default; owner_user_id remains nullable
-- for historical rows and is populated on newly created definitions.
-- New owner assignments are validated against active tenant membership
-- by the catalogue service and constrained to that tenant by this FK.
-- ============================================================

ALTER TABLE ai_agent_definitions
  ADD COLUMN IF NOT EXISTS language VARCHAR(35) NOT NULL DEFAULT 'en';

ALTER TABLE ai_agent_definitions
  ADD COLUMN IF NOT EXISTS owner_user_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ai_agent_definitions'::regclass
      AND conname = 'fk_ai_agent_definition_owner_membership'
  ) THEN
    ALTER TABLE ai_agent_definitions
      ADD CONSTRAINT fk_ai_agent_definition_owner_membership
      FOREIGN KEY (tenant_id, owner_user_id)
      REFERENCES tenant_memberships (tenant_id, user_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ai_agent_definitions'::regclass
      AND conname = 'chk_ai_agent_definition_language'
  ) THEN
    ALTER TABLE ai_agent_definitions
      ADD CONSTRAINT chk_ai_agent_definition_language
      CHECK (language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_agent_definitions_owner
  ON ai_agent_definitions (tenant_id, owner_user_id)
  WHERE owner_user_id IS NOT NULL;

INSERT INTO schema_migrations (version, checksum)
VALUES ('030_ai_agent_language_owner', NULL)
ON CONFLICT (version)
DO NOTHING;

COMMIT;
