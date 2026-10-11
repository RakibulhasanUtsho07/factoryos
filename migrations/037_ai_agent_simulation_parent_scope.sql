BEGIN;

-- A simulation child's lineage must never cross tenant, factory or sandbox boundaries.
-- Keep the parent id usable as a composite FK target for all scope dimensions.
CREATE UNIQUE INDEX IF NOT EXISTS uq_simulation_runs_parent_scope
ON simulation_runs (id, tenant_id, factory_id, sandbox_id);

ALTER TABLE simulation_runs
    DROP CONSTRAINT IF EXISTS fk_simulation_run_parent;

ALTER TABLE simulation_runs
    DROP CONSTRAINT IF EXISTS fk_simulation_run_parent_scope;

ALTER TABLE simulation_runs
    ADD CONSTRAINT fk_simulation_run_parent_scope
    FOREIGN KEY (parent_run_id, tenant_id, factory_id, sandbox_id)
    REFERENCES simulation_runs (id, tenant_id, factory_id, sandbox_id)
    ON DELETE RESTRICT;

INSERT INTO schema_migrations (version, checksum)
VALUES ('037_ai_agent_simulation_parent_scope', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
