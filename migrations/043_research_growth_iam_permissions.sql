BEGIN;

-- Permission catalog for the Research and Growth controllers.
-- Role grants remain explicit: this migration does not broaden production roles.
INSERT INTO permissions (code, description)
VALUES
  ('research.read', 'Read approved research sources, claims, releases and topic watchlists'),
  ('research.write', 'Register and maintain research sources, claims, topic watchlists and release drafts'),
  ('research.review', 'Review research rights, claims, watchlists and knowledge release promotions'),
  ('growth.read', 'Read growth opportunities, scenarios, experiments and realized outcomes'),
  ('growth.write', 'Create and manage growth hypotheses, scenarios, experiments and validation unknowns'),
  ('growth.review', 'Accept or reject growth hypotheses and review validation decisions')
ON CONFLICT (code) DO UPDATE
SET description = EXCLUDED.description;

INSERT INTO schema_migrations (version, checksum)
VALUES ('043_research_growth_iam_permissions', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
