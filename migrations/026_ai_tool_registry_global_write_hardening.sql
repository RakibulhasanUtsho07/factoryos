BEGIN;

-- ============================================================
-- Security hardening: AI tool registry row-level security
-- ============================================================
-- Global tools must remain readable by tenant-scoped executions,
-- but tenant-scoped sessions must not be able to add global tool
-- definitions and affect registry resolution precedence.
--
-- Global registry changes are deployment/migration operations
-- performed by a privileged migration role. Normal application
-- sessions may insert only rows belonging to their active tenant.
-- The existing immutable trigger continues to reject updates and
-- deletes; no UPDATE/DELETE RLS policy is intentionally provided.
-- ============================================================

DROP POLICY IF EXISTS
    ai_tool_registry_tenant_isolation
ON ai_tool_registry;

DROP POLICY IF EXISTS
    ai_tool_registry_select_scope
ON ai_tool_registry;

CREATE POLICY
    ai_tool_registry_select_scope
ON ai_tool_registry
FOR SELECT
USING (
    tenant_id IS NULL
    OR tenant_id = factoryos_current_tenant_id()
);

DROP POLICY IF EXISTS
    ai_tool_registry_insert_tenant_scope
ON ai_tool_registry;

CREATE POLICY
    ai_tool_registry_insert_tenant_scope
ON ai_tool_registry
FOR INSERT
WITH CHECK (
    tenant_id IS NOT NULL
    AND tenant_id = factoryos_current_tenant_id()
);

COMMENT ON POLICY ai_tool_registry_select_scope
ON ai_tool_registry IS
    'Allow reading global tools and tools scoped to the active tenant.';

COMMENT ON POLICY ai_tool_registry_insert_tenant_scope
ON ai_tool_registry IS
    'Tenant sessions may insert tenant-scoped tools only; global catalog changes require a privileged migration role.';

INSERT INTO schema_migrations (
    version,
    checksum
)
VALUES (
    '026_ai_tool_registry_global_write_hardening',
    NULL
)
ON CONFLICT (
    version
)
DO NOTHING;

COMMIT;
