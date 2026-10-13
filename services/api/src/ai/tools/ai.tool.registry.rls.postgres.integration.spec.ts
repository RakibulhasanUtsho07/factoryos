import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { PoolClient } from 'pg';

/**
 * Real PostgreSQL regression coverage for migration 026.
 *
 * Set TEST_APP_DATABASE_URL to a non-superuser application database
 * role after the focused bootstrap fixture and real migration 026 have
 * been applied. This suite is skipped when that dedicated URL is absent.
 *
 * Every test uses a transaction and rolls it back so the immutable
 * registry table is not left with test fixtures.
 */
const testDatabaseUrl = process.env.TEST_APP_DATABASE_URL;

const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

integrationDescribe('AI tool registry RLS (PostgreSQL integration)', () => {
  let pool!: Pool;

  const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
  const otherTenantId = '8aaab63d-c447-46ce-950d-deebdd7f5f31';

  async function beginTenantTransaction(
    client: PoolClient,
    scopedTenantId: string,
  ): Promise<void> {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true)",
      [scopedTenantId],
    );
  }

  async function rollbackAndRelease(client: PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }

  async function insertTenantTool(
    client: PoolClient,
    scopedTenantId: string,
    toolId: string,
  ): Promise<void> {
    await client.query(
      'INSERT INTO ai_tool_registry (tenant_id, factory_id, tool_id, version, input_schema, output_schema, risk_class, status) ' +
      'VALUES ($1, NULL, $2, \'1.0.0\', \'{"type":"object"}\'::jsonb, \'{"type":"object"}\'::jsonb, \'L0\', \'ACTIVE\')',
      [scopedTenantId, toolId],
    );
  }

  beforeAll(async () => {
    pool = new Pool({
      connectionString: testDatabaseUrl,
      max: 2,
      connectionTimeoutMillis: 5000,
    });

    const roleResult = await pool.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      'SELECT r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user',
    );

    const role = roleResult.rows[0];
    if (!role) {
      throw new Error('Unable to inspect the PostgreSQL integration role');
    }
    if (role.rolsuper || role.rolbypassrls) {
      throw new Error(
        'TEST_APP_DATABASE_URL must use a non-superuser role without BYPASSRLS',
      );
    }

    const tableResult = await pool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relname = 'ai_tool_registry'",
    );

    const table = tableResult.rows[0];
    if (!table?.relrowsecurity || !table.relforcerowsecurity) {
      throw new Error(
        'ai_tool_registry must exist with ENABLE and FORCE ROW LEVEL SECURITY; apply migrations first',
      );
    }

    const policyResult = await pool.query<{ policyname: string }>(
      "SELECT policyname FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'ai_tool_registry'",
    );
    const policyNames = new Set(
      policyResult.rows.map((row) => row.policyname),
    );
    if (
      !policyNames.has('ai_tool_registry_select_scope') ||
      !policyNames.has('ai_tool_registry_insert_tenant_scope')
    ) {
      throw new Error(
        'Migration 026 policies are missing from ai_tool_registry',
      );
    }
  }, 15_000);

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  it('allows tenant-scoped sessions to read the global NOOP tool', async () => {
    const client = await pool.connect();
    try {
      await beginTenantTransaction(client, tenantId);
      const result = await client.query(
        "SELECT tool_id FROM ai_tool_registry WHERE tenant_id IS NULL AND factory_id IS NULL AND tool_id = 'AI.RUNTIME.NOOP' AND version = '1.0.0' AND status = 'ACTIVE'",
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].tool_id).toBe('AI.RUNTIME.NOOP');
    } finally {
      await rollbackAndRelease(client);
    }
  });

  it('rejects a global registry insert from a tenant-scoped session', async () => {
    const client = await pool.connect();
    try {
      await beginTenantTransaction(client, tenantId);

      await expect(
        client.query(
          'INSERT INTO ai_tool_registry (tenant_id, factory_id, tool_id, version, input_schema, output_schema, risk_class, status) ' +
          'VALUES (NULL, NULL, $1, \'1.0.0\', \'{"type":"object"}\'::jsonb, \'{"type":"object"}\'::jsonb, \'L0\', \'ACTIVE\')',
          ['TEST.GLOBAL.' + randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await rollbackAndRelease(client);
    }
  });

  it('permits inserts scoped to the active tenant', async () => {
    const client = await pool.connect();
    const toolId = 'TEST.TENANT.' + randomUUID();
    try {
      await beginTenantTransaction(client, tenantId);
      await insertTenantTool(client, tenantId, toolId);

      const result = await client.query(
        'SELECT tenant_id::text AS tenant_id, tool_id FROM ai_tool_registry WHERE tenant_id = $1 AND tool_id = $2 AND version = \'1.0.0\'',
        [tenantId, toolId],
      );

      expect(result.rows).toEqual([{ tenant_id: tenantId, tool_id: toolId }]);
    } finally {
      await rollbackAndRelease(client);
    }
  });


  it('rejects an insert targeting a different tenant than the active context', async () => {
    const client = await pool.connect();
    try {
      await beginTenantTransaction(client, tenantId);

      await expect(
        insertTenantTool(client, otherTenantId, 'TEST.WRONG.TENANT.' + randomUUID()),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await rollbackAndRelease(client);
    }
  });

  it('rejects tenant-scoped inserts when no tenant context is present', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await expect(
        insertTenantTool(client, tenantId, 'TEST.NO.CONTEXT.' + randomUUID()),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await rollbackAndRelease(client);
    }
  });

  it('prevents application sessions from updating or deleting registry history', async () => {
    const client = await pool.connect();
    const toolId = 'TEST.IMMUTABLE.' + randomUUID();
    try {
      await beginTenantTransaction(client, tenantId);
      await insertTenantTool(client, tenantId, toolId);

      const updated = await client.query(
        "UPDATE ai_tool_registry SET metadata = '{\"attempt\":\"update\"}'::jsonb WHERE tenant_id = $1 AND tool_id = $2",
        [tenantId, toolId],
      );
      const deleted = await client.query(
        'DELETE FROM ai_tool_registry WHERE tenant_id = $1 AND tool_id = $2',
        [tenantId, toolId],
      );

      expect(updated.rowCount).toBe(0);
      expect(deleted.rowCount).toBe(0);
    } finally {
      await rollbackAndRelease(client);
    }
  });

  it('hides another tenant tool when the active tenant context changes', async () => {
    const client = await pool.connect();
    const toolId = 'TEST.CROSS.TENANT.' + randomUUID();
    try {
      await beginTenantTransaction(client, otherTenantId);
      await insertTenantTool(client, otherTenantId, toolId);

      await client.query(
        "SELECT set_config('app.tenant_id', $1, true)",
        [tenantId],
      );

      const result = await client.query(
        'SELECT id FROM ai_tool_registry WHERE tenant_id = $1 AND tool_id = $2',
        [otherTenantId, toolId],
      );

      expect(result.rows).toHaveLength(0);
    } finally {
      await rollbackAndRelease(client);
    }
  });
});
