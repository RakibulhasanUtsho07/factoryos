BEGIN;

-- Round 26 hardening: aliases are unique within their actual source context,
-- not globally by spelling. The same source token may legitimately map
-- differently across languages or source systems, and lookup handles ambiguity.
DROP INDEX IF EXISTS uq_cbb_terminology_alias_scope;

CREATE UNIQUE INDEX uq_cbb_terminology_alias_scope
  ON business_terminology_aliases (
    tenant_id,
    factory_id,
    lower(alias),
    COALESCE(lower(language_code), ''),
    COALESCE(lower(source_system), '')
  );

-- Keep source-context lookup bounded and avoid scanning every spelling variant.
CREATE INDEX IF NOT EXISTS idx_cbb_terminology_alias_context
  ON business_terminology_aliases (
    tenant_id,
    factory_id,
    lower(alias),
    lower(source_system),
    lower(language_code),
    state
  );

INSERT INTO schema_migrations (version, checksum)
VALUES ('133_cbb_terminology_context', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
