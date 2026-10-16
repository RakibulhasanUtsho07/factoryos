import { ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

import { AiRuntimeService } from './ai.runtime.service';

const testDatabaseUrl = process.env.TEST_APP_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const actorUserId = '921382b8-e83f-43ab-a576-e3db6a06b70c';

type ScopedContext = {
  tenantId?: string;
  userId?: string;
};

type QueryObserver = (sql: string, rowCount: number) => void;

function canonicalHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

async function applyContext(
  client: PoolClient,
  context?: ScopedContext,
): Promise<void> {
  if (context?.tenantId) {
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true)",
      [context.tenantId],
    );
  }

  if (context?.userId) {
    await client.query(
      "SELECT set_config('app.user_id', $1, true)",
      [context.userId],
    );
  }
}

/**
 * This suite uses the real PostgreSQL claim table and the runtime service.
 * TEST_APP_DATABASE_URL must point at the disposable, migrated CI test DB.
 * Fixture rows are append-only by design; claim/execution records demonstrate
 * the persisted result of the race and are intentionally not deleted.
 */
integrationDescribe(
  'AI action execution concurrency (PostgreSQL integration)',
  () => {
    let pool!: Pool;

    beforeAll(async () => {
      pool = new Pool({
        connectionString: testDatabaseUrl,
        max: 8,
        connectionTimeoutMillis: 5000,
      });

      const roleResult = await pool.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        'SELECT r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user',
      );
      const role = roleResult.rows[0];

      if (!role || role.rolsuper || role.rolbypassrls) {
        throw new Error(
          'TEST_APP_DATABASE_URL must use a non-superuser PostgreSQL role without BYPASSRLS',
        );
      }

      const tableResult = await pool.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        "SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ai_execution_claims'",
      );
      const table = tableResult.rows[0];

      if (!table?.relrowsecurity || !table.relforcerowsecurity) {
        throw new Error(
          'ai_execution_claims must exist with ENABLE and FORCE ROW LEVEL SECURITY; apply migrations first',
        );
      }

      const indexResult = await pool.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ai_execution_claims' AND indexname IN ('uq_ai_execution_claim_action_once', 'uq_ai_execution_claim_execution_key')",
      );
      const indexNames = new Set(
        indexResult.rows.map((row) => row.indexname),
      );

      if (
        !indexNames.has('uq_ai_execution_claim_action_once') ||
        !indexNames.has('uq_ai_execution_claim_execution_key')
      ) {
        throw new Error(
          'The unique per-action and per-execution-key claim indexes are missing',
        );
      }
    }, 15_000);

    afterAll(async () => {
      if (pool) {
        await pool.end();
      }
    });

    async function createAuthorizedActionFixture(): Promise<{
      actionId: string;
      decisionId: string;
      actionToken: string;
    }> {
      const client = await pool.connect();
      const decisionId = randomUUID();
      const actionId = randomUUID();
      const actionToken = `ai-concurrency-${randomUUID()}`;
      const payload = {};
      const payloadHash = canonicalHash(payload);

      try {
        await client.query('BEGIN');
        await applyContext(client, {
          tenantId,
          userId: actorUserId,
        });

        await client.query(
          `
          INSERT INTO ai_decision_envelopes (
            id,
            tenant_id,
            factory_id,
            request_id,
            trace_id,
            actor_id,
            objective,
            reasoning_mode,
            risk_class,
            output_state,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{}'::jsonb)
          `,
          [
            decisionId,
            tenantId,
            factoryId,
            randomUUID(),
            randomUUID(),
            actorUserId,
            'Verify concurrent AI action execution',
            'DETERMINISTIC',
            'L0',
            'READY',
          ],
        );

        await client.query(
          `
          INSERT INTO ai_action_intents (
            id,
            tenant_id,
            factory_id,
            decision_id,
            action_type,
            target,
            resource_type,
            resource_id,
            payload,
            payload_hash,
            risk_class,
            authorization_status,
            "authorization",
            action_token_hash,
            token_expires_at,
            idempotency_key,
            created_by,
            tool_id,
            tool_version
          )
          VALUES (
            $1, $2, $3, $4, 'AI.RUNTIME.NOOP', '{}'::jsonb,
            'AI_CONCURRENCY_TEST', $5, $6::jsonb, $7, 'L0',
            'AUTHORIZED', '{}'::jsonb, $8, NOW() + INTERVAL '10 minutes',
            NULL, $9, 'AI.RUNTIME.NOOP', '1.0.0'
          )
          `,
          [
            actionId,
            tenantId,
            factoryId,
            decisionId,
            actionId,
            JSON.stringify(payload),
            payloadHash,
            canonicalHash(actionToken),
            actorUserId,
          ],
        );

        await client.query('COMMIT');

        return {
          actionId,
          decisionId,
          actionToken,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    function createScopedDatabaseAdapter(observer: QueryObserver) {
      return {
        query: async (
          sql: string,
          values: unknown[] = [],
          context?: ScopedContext,
        ) => {
          const client = await pool.connect();

          try {
            await client.query('BEGIN');
            await applyContext(client, context);
            const result = await client.query(sql, values as never[]);
            await client.query('COMMIT');

            const isClaimInsert =
              /INSERT\s+INTO\s+ai_execution_claims/i.test(sql);
            const isCompetingClaimLookup =
              /FROM\s+ai_execution_claims/i.test(sql) &&
              /action_intent_id\s*=\s*\$3/i.test(sql);

            if (isClaimInsert || isCompetingClaimLookup) {
              observer(sql, result.rows.length);
            }

            return result;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        },

        transaction: async (
          callback: (client: unknown) => Promise<unknown>,
          context?: ScopedContext,
        ) => {
          const client = await pool.connect();

          try {
            await client.query('BEGIN');
            await applyContext(client, context);

            const transactionClient = {
              query: (sql: string, values: unknown[] = []) =>
                client.query(sql, values as never[]),
            };

            const result = await callback(transactionClient);
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        },
      };
    }

    it(
      'invokes the tool gateway once when two requests race for the same action claim',
      async () => {
        const fixture = await createAuthorizedActionFixture();

        let claimInsertCount = 0;
        const claimInsertRowCounts: number[] = [];
        let resolveBothClaimInserts!: () => void;
        const bothClaimInsertsObserved = new Promise<void>((resolve) => {
          resolveBothClaimInserts = resolve;
        });
        let resolveCompetingClaimRead!: () => void;
        const competingClaimReadObserved = new Promise<void>((resolve) => {
          resolveCompetingClaimRead = resolve;
        });

        const database = createScopedDatabaseAdapter((sql, rowCount) => {
          if (/INSERT\s+INTO\s+ai_execution_claims/i.test(sql)) {
            claimInsertCount += 1;
            claimInsertRowCounts.push(rowCount);

            if (claimInsertCount === 2) {
              resolveBothClaimInserts();
            }
          }

          if (
            /FROM\s+ai_execution_claims/i.test(sql) &&
            /action_intent_id\s*=\s*\$3/i.test(sql)
          ) {
            resolveCompetingClaimRead();
          }
        });

        let gatewayCalls = 0;
        let releaseGateway!: () => void;
        const gatewayGate = new Promise<void>((resolve) => {
          releaseGateway = resolve;
        });

        const aiToolGateway = {
          execute: async (action: Record<string, unknown>) => {
            gatewayCalls += 1;
            await gatewayGate;

            return {
              status: 'SUCCEEDED',
              result: { committed: false },
              error: {},
              executorType: action.executorType,
              toolVersion: action.toolVersion,
              inputsHash: action.payloadHash,
            };
          },
        };

        const service = new AiRuntimeService(
          database as never,
          { record: async () => 'audit-event-id' } as never,
          { authorize: async () => undefined } as never,
          {} as never,
          {} as never,
          {} as never,
          aiToolGateway as never,
        );

        const input = {
          action_token: fixture.actionToken,
          execution_key: `execution-${randomUUID()}`,
          tool_version: '1.0.0',
        };

        const firstRequest = service.executeAction(
          tenantId,
          factoryId,
          actorUserId,
          input,
        );
        const secondRequest = service.executeAction(
          tenantId,
          factoryId,
          actorUserId,
          input,
        );
        const settledRequests = Promise.allSettled([
          firstRequest,
          secondRequest,
        ]);

        try {
          await bothClaimInsertsObserved;

          // One INSERT wins; the competing INSERT must return no claim.
          expect([...claimInsertRowCounts].sort()).toEqual([0, 1]);

          // Hold the winning gateway call until the loser has read the
          // still-CLAIMED row, so the assertion exercises the in-flight race.
          await competingClaimReadObserved;
          releaseGateway();

          const results = await settledRequests;
          const success = results.find(
            (
              result,
            ): result is PromiseFulfilledResult<{
              idempotent: boolean;
              execution: { actionIntentId: string; status: string };
            }> => result.status === 'fulfilled',
          );
          const failure = results.find(
            (result) => result.status === 'rejected',
          );

          expect(gatewayCalls).toBe(1);
          expect(success).toBeDefined();
          expect(failure).toBeDefined();

          if (!success || failure?.status !== 'rejected') {
            throw new Error(
              'Expected one successful execution request and one rejected competing request',
            );
          }

          expect(failure.reason).toBeInstanceOf(ConflictException);
          expect(success.value.idempotent).toBe(false);
          expect(success.value.execution.actionIntentId).toBe(
            fixture.actionId,
          );
          expect(success.value.execution.status).toBe('SUCCEEDED');

          const storedState = await database.query(
            `
            SELECT
              (SELECT COUNT(*) FROM ai_execution_claims
                WHERE tenant_id = $1 AND factory_id = $2 AND action_intent_id = $3) AS claim_count,
              (SELECT COUNT(*) FROM ai_execution_records
                WHERE tenant_id = $1 AND factory_id = $2 AND action_intent_id = $3) AS execution_count
            `,
            [tenantId, factoryId, fixture.actionId],
            { tenantId, userId: actorUserId },
          );

          expect(Number(storedState.rows[0]?.claim_count)).toBe(1);
          expect(Number(storedState.rows[0]?.execution_count)).toBe(1);
        } finally {
          releaseGateway();
          await settledRequests;
        }
      },
      20_000,
    );

    it(
      'keeps an ambiguous gateway failure claimed and blocks automatic replay',
      async () => {
        const fixture = await createAuthorizedActionFixture();
        const database = createScopedDatabaseAdapter(() => undefined);
        let gatewayCalls = 0;

        const aiToolGateway = {
          execute: async () => {
            gatewayCalls += 1;
            throw new Error('SIMULATED_AMBIGUOUS_GATEWAY_TIMEOUT');
          },
        };

        const service = new AiRuntimeService(
          database as never,
          { record: async () => 'audit-event-id' } as never,
          { authorize: async () => undefined } as never,
          {} as never,
          {} as never,
          {} as never,
          aiToolGateway as never,
        );

        const input = {
          action_token: fixture.actionToken,
          execution_key: `ambiguous-${randomUUID()}`,
          tool_version: '1.0.0',
        };

        await expect(
          service.executeAction(
            tenantId,
            factoryId,
            actorUserId,
            input,
          ),
        ).rejects.toThrow('SIMULATED_AMBIGUOUS_GATEWAY_TIMEOUT');

        const stateAfterTimeout = await database.query(
          `
          SELECT
            c.status AS claim_status,
            c.failure_code,
            (SELECT COUNT(*) FROM ai_execution_records e
              WHERE e.tenant_id = $1 AND e.factory_id = $2
                AND e.action_intent_id = $3) AS execution_count
          FROM ai_execution_claims c
          WHERE c.tenant_id = $1 AND c.factory_id = $2
            AND c.action_intent_id = $3
          `,
          [tenantId, factoryId, fixture.actionId],
          { tenantId, userId: actorUserId },
        );

        expect(stateAfterTimeout.rows).toHaveLength(1);
        expect(stateAfterTimeout.rows[0]?.claim_status).toBe('CLAIMED');
        expect(stateAfterTimeout.rows[0]?.failure_code).toBeNull();
        expect(Number(stateAfterTimeout.rows[0]?.execution_count)).toBe(0);

        await expect(
          service.executeAction(
            tenantId,
            factoryId,
            actorUserId,
            input,
          ),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(gatewayCalls).toBe(1);

        const stateAfterReplay = await database.query(
          'SELECT status FROM ai_execution_claims WHERE tenant_id = $1 AND factory_id = $2 AND action_intent_id = $3',
          [tenantId, factoryId, fixture.actionId],
          { tenantId, userId: actorUserId },
        );
        expect(stateAfterReplay.rows[0]?.status).toBe('CLAIMED');
      },
      20_000,
    );

    it(
      'replays a recorded tool failure without invoking the gateway twice',
      async () => {
        const fixture = await createAuthorizedActionFixture();
        const database = createScopedDatabaseAdapter(() => undefined);
        let gatewayCalls = 0;

        const aiToolGateway = {
          execute: async (action: Record<string, unknown>) => {
            gatewayCalls += 1;
            return {
              status: 'FAILED' as const,
              result: {},
              error: { code: 'SIMULATED_TOOL_FAILURE' },
              executorType: action.executorType,
              toolVersion: action.toolVersion,
              inputsHash: action.payloadHash,
            };
          },
        };

        const service = new AiRuntimeService(
          database as never,
          { record: async () => 'audit-event-id' } as never,
          { authorize: async () => undefined } as never,
          {} as never,
          {} as never,
          {} as never,
          aiToolGateway as never,
        );

        const input = {
          action_token: fixture.actionToken,
          execution_key: `failed-${randomUUID()}`,
          tool_version: '1.0.0',
        };

        const first = await service.executeAction(
          tenantId,
          factoryId,
          actorUserId,
          input,
        );
        expect(first.idempotent).toBe(false);
        expect(first.execution.status).toBe('FAILED');
        expect(first.execution.error).toEqual({
          code: 'SIMULATED_TOOL_FAILURE',
        });

        const replay = await service.executeAction(
          tenantId,
          factoryId,
          actorUserId,
          input,
        );
        expect(replay.idempotent).toBe(true);
        expect(replay.execution.id).toBe(first.execution.id);
        expect(replay.execution.status).toBe('FAILED');
        expect(gatewayCalls).toBe(1);

        const state = await database.query(
          `
          SELECT
            c.status AS claim_status,
            c.failure_code,
            (SELECT COUNT(*) FROM ai_execution_records e
              WHERE e.tenant_id = $1 AND e.factory_id = $2
                AND e.action_intent_id = $3) AS execution_count
          FROM ai_execution_claims c
          WHERE c.tenant_id = $1 AND c.factory_id = $2
            AND c.action_intent_id = $3
          `,
          [tenantId, factoryId, fixture.actionId],
          { tenantId, userId: actorUserId },
        );

        expect(state.rows[0]?.claim_status).toBe('FAILED');
        expect(state.rows[0]?.failure_code).toBe('TOOL_EXECUTION_FAILED');
        expect(Number(state.rows[0]?.execution_count)).toBe(1);
      },
      20_000,
    );

  },
);
