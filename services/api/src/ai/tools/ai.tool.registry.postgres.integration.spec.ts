
import {
  randomUUID,
} from 'node:crypto';

import {
  Pool,
} from 'pg';

import type {
  PoolClient,
  QueryResult,
  QueryResultRow,
} from 'pg';

import {
  AiToolRegistryService,
} from './ai.tool.registry.service';

interface ActiveFactoryRow
  extends QueryResultRow {
  tenant_id: string;
  factory_id: string;
}

interface RegistryInsertedRow
  extends QueryResultRow {
  id: string;
  tenant_id: string | null;
  factory_id: string | null;
}

interface SavedTool {
  id: string;
  tenantId: string | null;
  factoryId: string | null;
}

interface ToolScopeFixtures {
  global: SavedTool;
  tenant?: SavedTool;
  factory?: SavedTool;
}

interface QueryContext {
  tenantId?: string | null;
  userId?: string | null;
}

const testDatabaseUrl =
  process.env.TEST_ADMIN_DATABASE_URL;

/*
 * The integration suite is skipped when the explicit admin
 * database URL is not configured. It must not silently switch
 * to an unknown application database.
 */
const describeWithPostgres =
  testDatabaseUrl
    ? describe
    : describe.skip;

describeWithPostgres(
  'AiToolRegistryService PostgreSQL integration',
  () => {
    let pool:
      Pool | undefined;

    let client:
      PoolClient | undefined;

    let registry:
      AiToolRegistryService;

    let tenantId:
      string;

    let factoryId:
      string;

    let otherTenantId:
      string;

    let otherFactoryId:
      string;

    let factoryToolId:
      string;

    let tenantToolId:
      string;

    let globalToolId:
      string;

    let factoryFixtures:
      ToolScopeFixtures;

    let tenantFixtures:
      ToolScopeFixtures;

    let globalFixtures:
      ToolScopeFixtures;

    function getClient(): PoolClient {
      if (!client) {
        throw new Error(
          'PostgreSQL integration client is not initialized.',
        );
      }

      return client;
    }

    async function insertTool(
      toolId: string,
      scopedTenantId: string | null,
      scopedFactoryId: string | null,
    ): Promise<SavedTool> {
      const db =
        getClient();

      const inputSchema =
        JSON.stringify({
          type: 'object',
          additionalProperties: true,
        });

      const outputSchema =
        JSON.stringify({
          type: 'object',
          additionalProperties: true,
        });

      const metadata =
        JSON.stringify({
          purpose:
            'B14 temporary PostgreSQL integration fixture',
        });

      const result =
        await db.query<RegistryInsertedRow>(
          `
          INSERT INTO public.ai_tool_registry (
            tenant_id,
            factory_id,
            tool_id,
            version,
            input_schema,
            output_schema,
            risk_class,
            required_scopes,
            approval_mode,
            write_capable,
            idempotency_required,
            timeout_ms,
            audit_mode,
            rollback,
            status,
            metadata
          )
          VALUES (
            $1::uuid,
            $2::uuid,
            $3,
            '1.0.0',
            $4::jsonb,
            $5::jsonb,
            'L0',
            ARRAY['ai.actions.execute']::text[],
            'none',
            false,
            false,
            1000,
            'REDACTED',
            '{"type":"NONE"}'::jsonb,
            'ACTIVE',
            $6::jsonb
          )
          RETURNING
            id::text AS id,
            tenant_id::text AS tenant_id,
            factory_id::text AS factory_id
          `,
          [
            scopedTenantId,
            scopedFactoryId,
            toolId,
            inputSchema,
            outputSchema,
            metadata,
          ],
        );

      const row =
        result.rows[0];

      if (!row) {
        throw new Error(
          `Failed to insert integration fixture for ${toolId}.`,
        );
      }

      return {
        id:
          row.id,

        tenantId:
          row.tenant_id,

        factoryId:
          row.factory_id,
      };
    }

    beforeAll(
      async () => {
        if (!testDatabaseUrl) {
          return;
        }

        pool =
          new Pool({
            connectionString:
              testDatabaseUrl,
          });

        client =
          await pool.connect();

        try {
          /*
           * This test uses a superuser only to create fixtures
           * inside a transaction. Actual lookups run as
           * factoryos_app, which must not bypass RLS.
           */
          const adminResult =
            await getClient().query<{
              role_name: string;
              is_superuser: boolean;
            }>(
              `
              SELECT
                current_user::text AS role_name,
                r.rolsuper AS is_superuser
              FROM pg_roles r
              WHERE r.rolname = current_user
              `,
            );

          if (
            adminResult.rows[0]?.is_superuser !==
            true
          ) {
            throw new Error(
              'TEST_ADMIN_DATABASE_URL must connect using a PostgreSQL superuser for transactional fixture setup.',
            );
          }

          const appRoleResult =
            await getClient().query<{
              rolsuper: boolean;
              rolbypassrls: boolean;
            }>(
              `
              SELECT
                rolsuper,
                rolbypassrls
              FROM pg_roles
              WHERE rolname = 'factoryos_app'
              `,
            );

          const appRole =
            appRoleResult.rows[0];

          if (
            !appRole ||
            appRole.rolsuper ||
            appRole.rolbypassrls
          ) {
            throw new Error(
              'factoryos_app must exist and must not have superuser or BYPASSRLS privileges.',
            );
          }

          const contextResult =
            await getClient().query<ActiveFactoryRow>(
              `
              SELECT
                t.id::text AS tenant_id,
                f.id::text AS factory_id
              FROM tenants t
              INNER JOIN factories f
                ON f.tenant_id = t.id
              WHERE
                t.status = 'ACTIVE'
                AND f.status = 'ACTIVE'
              ORDER BY
                t.created_at ASC,
                f.created_at ASC
              LIMIT 1
              `,
            );

          const context =
            contextResult.rows[0];

          if (!context) {
            throw new Error(
              'No active tenant/factory exists for the PostgreSQL integration test.',
            );
          }

          tenantId =
            context.tenant_id;

          factoryId =
            context.factory_id;

          /*
           * A second, non-matching tenant context is sufficient
           * to verify that tenant-A registry rows are hidden.
           */
          otherTenantId =
            randomUUID();

          otherFactoryId =
            randomUUID();

          const suffix =
            randomUUID();

          factoryToolId =
            `AI.REGISTRY.IT.FACTORY.${suffix}`;

          tenantToolId =
            `AI.REGISTRY.IT.TENANT.${suffix}`;

          globalToolId =
            `AI.REGISTRY.IT.GLOBAL.${suffix}`;

          /*
           * All inserted rows remain inside this transaction.
           * The final ROLLBACK removes the fixtures without
           * attempting DELETE against the immutable registry.
           */
          await getClient().query(
            'BEGIN',
          );

          factoryFixtures = {
            global:
              await insertTool(
                factoryToolId,
                null,
                null,
              ),

            tenant:
              await insertTool(
                factoryToolId,
                tenantId,
                null,
              ),

            factory:
              await insertTool(
                factoryToolId,
                tenantId,
                factoryId,
              ),
          };

          tenantFixtures = {
            global:
              await insertTool(
                tenantToolId,
                null,
                null,
              ),

            tenant:
              await insertTool(
                tenantToolId,
                tenantId,
                null,
              ),
          };

          globalFixtures = {
            global:
              await insertTool(
                globalToolId,
                null,
                null,
              ),
          };

          /*
           * Switch into the non-superuser application role.
           * FORCE ROW LEVEL SECURITY now applies to registry reads.
           */
          await getClient().query(
            'SET LOCAL ROLE factoryos_app',
          );

          /*
           * The adapter below runs real PostgreSQL queries on
           * this same transaction/client. It sets the tenant
           * context for each service query, matching the
           * DatabaseService tenant-context contract.
           */
          const databaseAdapter = {
            query: async <
              T extends QueryResultRow = QueryResultRow,
            >(
              sql: string,
              values: unknown[] = [],
              context?: QueryContext,
            ): Promise<QueryResult<T>> => {
              const db =
                getClient();

              if (
                context?.tenantId !==
                undefined
              ) {
                await db.query(
                  `
                  SELECT set_config(
                    'app.tenant_id',
                    $1,
                    true
                  )
                  `,
                  [
                    context.tenantId ?? '',
                  ],
                );
              }

              if (
                context?.userId !==
                undefined
              ) {
                await db.query(
                  `
                  SELECT set_config(
                    'app.user_id',
                    $1,
                    true
                  )
                  `,
                  [
                    context.userId ?? '',
                  ],
                );
              }

              return db.query<T>(
                sql,
                values as never,
              );
            },
          };

          registry =
            new AiToolRegistryService(
              databaseAdapter as never,
            );
        } catch (error) {
          try {
            await getClient().query(
              'ROLLBACK',
            );
          } catch {
            /*
             * Preserve the setup error if rollback is unavailable.
             */
          }

          client.release();
          client = undefined;

          await pool.end();
          pool = undefined;

          throw error;
        }
      },
      30000,
    );

    afterAll(
      async () => {
        if (client) {
          try {
            await client.query(
              'ROLLBACK',
            );
          } catch {
            /*
             * A failed transaction may already be aborted.
             * Releasing its connection closes the transaction.
             */
          }

          client.release();
          client = undefined;
        }

        if (pool) {
          await pool.end();
          pool = undefined;
        }
      },
      30000,
    );

    it(
      'prefers the factory-scoped definition over tenant and global definitions',
      async () => {
        const tool =
          await registry.getTool(
            tenantId,
            factoryId,
            factoryToolId,
            '1.0.0',
          );

        expect(
          tool.id,
        ).toBe(
          factoryFixtures.factory?.id,
        );

        expect(
          tool.tenantId,
        ).toBe(
          tenantId,
        );

        expect(
          tool.factoryId,
        ).toBe(
          factoryId,
        );
      },
    );

    it(
      'prefers the tenant-scoped definition when no factory-specific definition exists',
      async () => {
        const tool =
          await registry.getTool(
            tenantId,
            factoryId,
            tenantToolId,
            '1.0.0',
          );

        expect(
          tool.id,
        ).toBe(
          tenantFixtures.tenant?.id,
        );

        expect(
          tool.tenantId,
        ).toBe(
          tenantId,
        );

        expect(
          tool.factoryId,
        ).toBeNull();
      },
    );

    it(
      'returns the global definition when no scoped definition exists',
      async () => {
        const tool =
          await registry.getTool(
            tenantId,
            factoryId,
            globalToolId,
            '1.0.0',
          );

        expect(
          tool.id,
        ).toBe(
          globalFixtures.global.id,
        );

        expect(
          tool.tenantId,
        ).toBeNull();

        expect(
          tool.factoryId,
        ).toBeNull();
      },
    );

    it(
      'does not expose another tenant factory or tenant registry rows under RLS',
      async () => {
        const db =
          getClient();

        await db.query(
          `
          SELECT set_config(
            'app.tenant_id',
            $1,
            true
          )
          `,
          [
            otherTenantId,
          ],
        );

        /*
         * Read all matching scopes without an application-level
         * tenant/factory predicate. RLS itself must hide the
         * tenant-A rows for this tenant-B context.
         */
        const visibleRows =
          await db.query<RegistryInsertedRow>(
            `
            SELECT
              id::text AS id,
              tenant_id::text AS tenant_id,
              factory_id::text AS factory_id
            FROM public.ai_tool_registry
            WHERE
              tool_id = $1
              AND version = '1.0.0'
            `,
            [
              factoryToolId,
            ],
          );

        expect(
          visibleRows.rows.map(
            (row) => row.id,
          ),
        ).toEqual([
          factoryFixtures.global.id,
        ]);

        /*
         * The service must also resolve only the global fallback
         * under the different tenant context.
         */
        const resolved =
          await registry.getTool(
            otherTenantId,
            otherFactoryId,
            factoryToolId,
            '1.0.0',
          );

        expect(
          resolved.id,
        ).toBe(
          factoryFixtures.global.id,
        );

        expect(
          resolved.tenantId,
        ).toBeNull();

        expect(
          resolved.factoryId,
        ).toBeNull();
      },
    );
  },
);