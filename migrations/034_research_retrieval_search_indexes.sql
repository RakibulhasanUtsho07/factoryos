BEGIN;

-- ============================================================
-- WP08 / Governed lexical retrieval indexes and IAM permission
-- ============================================================
-- Ranking is lexical relevance only. Retrieval must still filter for the
-- newest VALID citation check and the newest matching RIGHTS and SECURITY
-- approvals for the exact immutable text hash.

INSERT INTO permissions (code, description)
VALUES
  ('research.retrieval.search', 'Search tenant-scoped research claims with approved and validated citations')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code = 'research.retrieval.search'
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_research_claim_registry_statement_fts
  ON research_claim_registry USING GIN (to_tsvector('simple', statement));

CREATE INDEX IF NOT EXISTS idx_research_claim_evidence_quote_fts
  ON research_claim_evidence USING GIN (to_tsvector('simple', quote_text));

CREATE INDEX IF NOT EXISTS idx_research_source_registry_title_key_fts
  ON research_source_registry USING GIN (to_tsvector('simple', title || ' ' || source_key));

INSERT INTO schema_migrations (version, checksum)
VALUES ('034_research_retrieval_search_indexes', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
