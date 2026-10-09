
import {
  randomUUID,
} from 'node:crypto';

import {
  NotFoundException,
} from '@nestjs/common';

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

interface TenantFactoryRow
  extends QueryResultRow {
  tenant_id: string;
  factory_id: string;
}

interface RegistryRow
  extends QueryResultRow {
  id: string;
}

interface AppRoleRow
  extends QueryResultRow {
  rolsuper: boolean;
  rolbypassrls: boolean;
}

interface TestQueryContext {
  tenantId?: string | null;
  userId?: string | null;
}

interface SavedDefinition {
  id: string;
  tenantId: string | null;
  factoryId: string | null;
  status: string;
}

const testDatabaseUrl =
  process.env.TEST_ADMIN_DATABASE_URL;

const describeWithPostgres =
  testDatabaseUrl
    ? describe
    : describe.skip;

describeWithPostgres(
  'AI Tool Registry lifecycle PostgreSQL integration',
  () => {
    let pool:
      Pool | undefined;

    let client:
      PoolClient | undefined;

    let transactionOpen =
      false;

    let registry:
      AiToolRegistryService;

    let tenantId:
      string;

    let factoryId:
      string;

    let disabledFallbackToolId:
      string;

    let retiredFallbackToolId:
      string;

    let disabledOnlyToolId:
      string;

    let retiredOnlyToolId:
      string;

    let immutableTool:
      SavedDefinition;

    let disabledFallback:
      SavedDefinition;

    let retiredFallback:
      SavedDefinition;

    function db(): PoolClient {
      if (!client) {
        throw new Error(
          'PostgreSQL integration client is not initialized.',
        );
      }

      return client;
    }

    async function insertDefinition(
      toolId: string,
      scopedTenantId: string | null,
      scopedFactoryId: string | null,
      status: 'ACTIVE' | 'DISABLED' | 'RETIRED',
    ): Promise<SavedDefinition> {
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
            'B15 temporary registry lifecycle integration fixture',
        });

      const result =
        await db().query<RegistryRow>(
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
            $6,
            $7::jsonb
          )
          RETURNING id::text AS id
          `,
          [
            scopedTenantId,
            scopedFactoryId,
            toolId,
            inputSchema,
            outputSchema,
            status,
            metadata,
          ],
        );

      const row =
        result.rows[0];

      if (!row) {
        throw new Error(
          `Failed to insert ${status} fixture for ${toolId}.`,
        );
      }

      return {
        id:
          row.id,

        tenantId:
          scopedTenantId,

        factoryId:
          scopedFactoryId,

        status,
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
          const adminResult =
            await db().query<{
              is_superuser: boolean;
            }>(
              `
              SELECT
                rolsuper AS is_superuser
              FROM pg_roles
              WHERE rolname = current_user
              `,
            );

          if (
            adminResult.rows[0]?.is_superuser !==
            true
          ) {
            throw new Error(
              'TEST_ADMIN_DATABASE_URL must use a PostgreSQL superuser for isolated fixture setup.',
            );
          }

          const appRoleResult =
            await db().query<AppRoleRow>(
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
              'factoryos_app must exist without superuser or BYPASSRLS privileges.',
            );
          }

          const factoryResult =
            await db().query<TenantFactoryRow>(
              `
              SELECT
                t.id::text AS tenant_id,
                f.id::text AS factory_id
              FROM public.tenants t
              INNER JOIN public.factories f
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
            factoryResult.rows[0];

          if (!context) {
            throw new Error(
              'No active tenant/factory exists for the lifecycle integration suite.',
            );
          }

          tenantId =
            context.tenant_id;

          factoryId =
            context.factory_id;

          const suffix =
            randomUUID();

          disabledFallbackToolId =
            `AI.REGISTRY.B15.DISABLED.${suffix}`;

          retiredFallbackToolId =
            `AI.REGISTRY.B15.RETIRED.${suffix}`;

          disabledOnlyToolId =
            `AI.REGISTRY.B15.DISABLED_ONLY.${suffix}`;

          retiredOnlyToolId =
            `AI.REGISTRY.B15.RETIRED_ONLY.${suffix}`;

          await db().query(
            'BEGIN',
          );

          transactionOpen =
            true;

          /*
           * Scenario A:
           * A disabled tenant definition must not shadow
           * an active global definition.
           */
          const disabledFallbackGlobal =
            await insertDefinition(
              disabledFallbackToolId,
              null,
              null,
              'ACTIVE',
            );

          await insertDefinition(
            disabledFallbackToolId,
            tenantId,
            null,
            'DISABLED',
          );

          disabledFallback = {
            ...disabledFallbackGlobal,
          };

          /*
           * Scenario B:
           * A retired factory definition must not shadow
           * the active tenant definition.
           */
          await insertDefinition(
            retiredFallbackToolId,
            null,
            null,
            'ACTIVE',
          );

          const retiredFallbackTenant =
            await insertDefinition(
              retiredFallbackToolId,
              tenantId,
              null,
              'ACTIVE',
            );

          await insertDefinition(
            retiredFallbackToolId,
            tenantId,
            factoryId,
            'RETIRED',
          );

          retiredFallback = {
            ...retiredFallbackTenant,
          };

          /*
           * Scenario C:
           * Disabled-only and retired-only tools must
           * remain unavailable for execution.
           */
          await insertDefinition(
            disabledOnlyToolId,
            null,
            null,
            'DISABLED',
          );

          await insertDefinition(
            retiredOnlyToolId,
            null,
            null,
            'RETIRED',
          );

          /*
           * Scenario D:
           * The immutable trigger must reject UPDATE and DELETE.
           */
          immutableTool =
            await insertDefinition(
              `AI.REGISTRY.B15.IMMUTABLE.${suffix}`,
              null,
              null,
              'ACTIVE',
            );

          /*
           * All test lookups use the application role.
           * FORCE ROW LEVEL SECURITY must therefore apply.
           */
          await db().query(
            'SET LOCAL ROLE factoryos_app',
          );

          const databaseAdapter = {
            query: async <
              T extends QueryResultRow = QueryResultRow,
            >(
              sql: string,
              values: unknown[] = [],
              context?: TestQueryContext,
            ): Promise<QueryResult<T>> => {
              if (
                context?.tenantId !==
                undefined
              ) {
                await db().query(
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
                await db().query(
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

              return db().query<T>(
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
          if (
            client &&
            transactionOpen
          ) {
            try {
              await client.query(
                'ROLLBACK',
              );

              transactionOpen =
                false;
            } catch {
              // Preserve the original setup failure.
            }
          }

          if (client) {
            client.release();
            client = undefined;
          }

          if (pool) {
            await pool.end();
            pool = undefined;
          }

          throw error;
        }
      },
      30000,
    );

    afterAll(
      async () => {
        if (client) {
          if (transactionOpen) {
            try {
              await client.query(
                'ROLLBACK',
              );

              transactionOpen =
                false;
            } catch {
              /*
               * Releasing the connection closes any
               * remaining failed transaction.
               */
            }
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
      'falls back to the active global definition when the tenant definition is disabled',
      async () => {
        const resolved =
          await registry.getTool(
            tenantId,
            factoryId,
            disabledFallbackToolId,
            '1.0.0',
          );

        expect(
          resolved.id,
        ).toBe(
          disabledFallback.id,
        );

        expect(
          resolved.tenantId,
        ).toBeNull();

        expect(
          resolved.factoryId,
        ).toBeNull();

        expect(
          resolved.status,
        ).toBe(
          'ACTIVE',
        );
      },
    );

    it(
      'falls back to the active tenant definition when the factory definition is retired',
      async () => {
        const resolved =
          await registry.getTool(
            tenantId,
            factoryId,
            retiredFallbackToolId,
            '1.0.0',
          );

        expect(
          resolved.id,
        ).toBe(
          retiredFallback.id,
        );

        expect(
          resolved.tenantId,
        ).toBe(
          tenantId,
        );

        expect(
          resolved.factoryId,
        ).toBeNull();

        expect(
          resolved.status,
        ).toBe(
          'ACTIVE',
        );
      },
    );

    it(
      'does not resolve a disabled-only tool',
      async () => {
        await expect(
          registry.getTool(
            tenantId,
            factoryId,
            disabledOnlyToolId,
            '1.0.0',
          ),
        ).rejects.toBeInstanceOf(
          NotFoundException,
        );
      },
    );

    it(
      'does not resolve a retired-only tool',
      async () => {
        await expect(
          registry.getTool(
            tenantId,
            factoryId,
            retiredOnlyToolId,
            '1.0.0',
          ),
        ).rejects.toBeInstanceOf(
          NotFoundException,
        );
      },
    );

    it(
      'does not resolve a version that is not registered',
      async () => {
        await expect(
          registry.getTool(
            tenantId,
            factoryId,
            disabledFallbackToolId,
            '99.0.0',
          ),
        ).rejects.toBeInstanceOf(
          NotFoundException,
        );
      },
    );

    it(
      'rejects immutable registry UPDATE and DELETE operations',
      async () => {
        /*
         * Return to the setup superuser so this test specifically
         * exercises the immutable trigger rather than failing
         * earlier because of missing application-role privileges.
         */
        await db().query(
          'RESET ROLE',
        );

        const updateSavepoint =
          'b15_immutable_update';

        await db().query(
          `SAVEPOINT ${updateSavepoint}`,
        );

        let updateError:
          unknown;

        try {
          await db().query(
            `
            UPDATE public.ai_tool_registry
            SET metadata = '{"unexpected":true}'::jsonb
            WHERE id = $1::uuid
            `,
            [
              immutableTool.id,
            ],
          );
        } catch (error) {
          updateError =
            error;
        }

        await db().query(
          `ROLLBACK TO SAVEPOINT ${updateSavepoint}`,
        );

        await db().query(
          `RELEASE SAVEPOINT ${updateSavepoint}`,
        );

        expect(
          updateError,
        ).toBeDefined();

        const updateMessage =
          updateError instanceof Error
            ? updateError.message
            : String(updateError);

        expect(
          updateMessage,
        ).toContain(
          'AI tool registry history is immutable',
        );

        const deleteSavepoint =
          'b15_immutable_delete';

        await db().query(
          `SAVEPOINT ${deleteSavepoint}`,
        );

        let deleteError:
          unknown;

        try {
          await db().query(
            `
            DELETE FROM public.ai_tool_registry
            WHERE id = $1::uuid
            `,
            [
              immutableTool.id,
            ],
          );
        } catch (error) {
          deleteError =
            error;
        }

        await db().query(
          `ROLLBACK TO SAVEPOINT ${deleteSavepoint}`,
        );

        await db().query(
          `RELEASE SAVEPOINT ${deleteSavepoint}`,
        );

        expect(
          deleteError,
        ).toBeDefined();

        const deleteMessage =
          deleteError instanceof Error
            ? deleteError.message
            : String(deleteError);

        expect(
          deleteMessage,
        ).toContain(
          'AI tool registry history is immutable',
        );
      },
    );
  },
);