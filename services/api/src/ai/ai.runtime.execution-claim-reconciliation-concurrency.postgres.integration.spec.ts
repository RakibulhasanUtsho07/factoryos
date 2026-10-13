import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

import { AiRuntimeService } from './ai.runtime.service';
import type { ReconcileAiExecutionClaimDto } from './dto/reconcile-ai-execution-claim.dto';

const testDatabaseUrl = process.env.B19_TEST_ADMIN_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

type Scope = {
  tenantId: string;
  factoryId: string;
  actorUserId: string;
};

type Fixture = {
  decisionId: string;
  actionIntentId: string;
  claimId: string;
  executionKey: string;
  toolVersion: string;
  inputsHash: string;
};

const failedDecision: ReconcileAiExecutionClaimDto = {
  decision: 'CONFIRMED_FAILED',
  reason: 'Concurrent reconciliation regression test investigated the claim.',
  evidence_ref: 'B19-CONCURRENT-RECONCILIATION-TEST',
};

integrationDescribe(
  'AI execution claim reconciliation concurrency PostgreSQL integration',
  () => {
    let adminPool: Pool;
    let appPool: Pool;
    let scope: Scope;

    beforeAll(async () => {
      const url = new URL(testDatabaseUrl!);
      const databaseName = decodeURIComponent(
        url.pathname.replace(/^\//, ''),
      );

      if (
        !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname) ||
        !databaseName.startsWith('factoryos_b19_restore_test_')
      ) {
        throw new Error(
          'B19_TEST_ADMIN_DATABASE_URL must target an isolated local factoryos_b19_restore_test_* database.',
        );
      }

      adminPool = new Pool({
        connectionString: testDatabaseUrl,
        max: 6,
        connectionTimeoutMillis: 5000,
      });
      appPool = adminPool;

      const db = await adminPool.connect();
      try {
        const role = await db.query<{ rolsuper: boolean }>(
          'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
        );
        if (!role.rows[0]?.rolsuper) {
          throw new Error(
            'The reconciliation race test requires the isolated test database admin role.',
          );
        }

        const schema = await db.query<{
          migrationInstalled: boolean;
          appRoleAvailable: boolean;
        }>(
          `
          SELECT
            EXISTS (
              SELECT 1 FROM public.schema_migrations
              WHERE version = '028_ai_execution_claim_reconciliation'
            ) AS "migrationInstalled",
            EXISTS (
              SELECT 1 FROM pg_roles
              WHERE rolname = 'factoryos_app'
                AND rolsuper = false
                AND rolbypassrls = false
            ) AS "appRoleAvailable"
          `,
        );

        if (
          !schema.rows[0]?.migrationInstalled ||
          !schema.rows[0]?.appRoleAvailable
        ) {
          throw new Error(
            'Migration 028 and the non-superuser factoryos_app role are required.',
          );
        }

        const active = await db.query<Scope>(
          `
          SELECT
            t.id::text AS "tenantId",
            f.id::text AS "factoryId",
            u.id::text AS "actorUserId"
          FROM public.tenants t
          JOIN public.factories f ON f.tenant_id = t.id
          JOIN public.tenant_memberships tm
            ON tm.tenant_id = t.id AND tm.status = 'ACTIVE'
          JOIN public.users u
            ON u.id = tm.user_id AND u.status = 'ACTIVE'
          WHERE t.status = 'ACTIVE' AND f.status = 'ACTIVE'
          ORDER BY t.created_at, f.created_at
          LIMIT 1
          `,
        );
        if (!active.rows[0]) {
          throw new Error(
            'No active tenant/factory/user context is available in the isolated integration database.',
          );
        }
        scope = active.rows[0];
      } finally {
        db.release();
      }
    }, 15_000);

    afterAll(async () => {
      if (adminPool) {
        await adminPool.end();
      }
    });

    async function createFixture(
      withSuccessfulExecution = false,
    ): Promise<Fixture> {
      const db = await adminPool.connect();
      const fixture: Fixture = {
        decisionId: randomUUID(),
        actionIntentId: randomUUID(),
        claimId: randomUUID(),
        executionKey: `B19.CONCURRENT.${randomUUID()}`,
        toolVersion: '1.0.0',
        inputsHash: 'b'.repeat(64),
      };

      try {
        await db.query('BEGIN');
        await db.query(
          `
          INSERT INTO public.ai_decision_envelopes (
            id, tenant_id, factory_id, request_id, trace_id, actor_id,
            objective, reasoning_mode, output_state, metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'DETERMINISTIC', 'TEST', '{}'::jsonb)
          `,
          [
            fixture.decisionId,
            scope.tenantId,
            scope.factoryId,
            randomUUID(),
            randomUUID(),
            scope.actorUserId,
            'Verify reconciliation cannot be finalized twice',
          ],
        );

        await db.query(
          `
          INSERT INTO public.ai_action_intents (
            id, tenant_id, factory_id, decision_id, action_type, tool_id,
            tool_version, target, resource_type, resource_id, payload,
            payload_hash, risk_class, authorization_status, "authorization",
            action_token_hash, token_expires_at, created_by
          )
          VALUES (
            $1, $2, $3, $4, 'AI.RECONCILIATION.TEST', 'AI.RECONCILIATION.TEST',
            $5, '{}'::jsonb, 'RECONCILIATION_TEST', $6, '{}'::jsonb,
            $7, 'L0', 'AUTHORIZED', '{}'::jsonb, $8,
            NOW() + INTERVAL '1 hour', $9
          )
          `,
          [
            fixture.actionIntentId,
            scope.tenantId,
            scope.factoryId,
            fixture.decisionId,
            fixture.toolVersion,
            fixture.actionIntentId,
            fixture.inputsHash,
            randomUUID().replace(/-/g, '').repeat(2),
            scope.actorUserId,
          ],
        );

        await db.query(
          `
          INSERT INTO public.ai_execution_claims (
            id, tenant_id, factory_id, action_intent_id, execution_key,
            tool_version, inputs_hash, status, claimed_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'CLAIMED', NOW() - INTERVAL '20 minutes')
          `,
          [
            fixture.claimId,
            scope.tenantId,
            scope.factoryId,
            fixture.actionIntentId,
            fixture.executionKey,
            fixture.toolVersion,
            fixture.inputsHash,
          ],
        );

        if (withSuccessfulExecution) {
          await db.query(
            `
            INSERT INTO public.ai_execution_records (
              id, tenant_id, factory_id, decision_id, action_intent_id,
              execution_key, executor_type, tool_version, inputs_hash,
              result, error, status, finished_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, 'AI_TOOL_GATEWAY', $7, $8,
              '{}'::jsonb, '{}'::jsonb, 'SUCCEEDED', NOW()
            )
            `,
            [
              randomUUID(),
              scope.tenantId,
              scope.factoryId,
              fixture.decisionId,
              fixture.actionIntentId,
              fixture.executionKey,
              fixture.toolVersion,
              fixture.inputsHash,
            ],
          );
        }

        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      } finally {
        db.release();
      }

      return fixture;
    }

    function createScopedDatabase(
      afterPreflight?: () => Promise<void>,
    ) {
      return {
        query: async <T extends QueryResultRow = QueryResultRow>(
          sql: string,
          values: unknown[] = [],
          context?: { tenantId?: string; userId?: string },
        ): Promise<QueryResult<T>> => {
          const db = await appPool.connect();
          try {
            await db.query('BEGIN');
            if (context?.tenantId) {
              await db.query(
                "SELECT set_config('app.tenant_id', $1, true)",
                [context.tenantId],
              );
            }
            if (context?.userId) {
              await db.query(
                "SELECT set_config('app.user_id', $1, true)",
                [context.userId],
              );
            }
            await db.query('SET LOCAL ROLE factoryos_app');
            const result = await db.query<T>(sql, values as never[]);
            await db.query('COMMIT');

            const isPreflight =
              /^\s*SELECT/i.test(sql) &&
              /FROM\s+ai_execution_claims c/i.test(sql) &&
              /LEFT JOIN\s+ai_execution_records e/i.test(sql) &&
              /c\.claimed_at <= NOW\(\) - INTERVAL '5 minutes'/i.test(sql);

            if (isPreflight && afterPreflight) {
              await afterPreflight();
            }
            return result;
          } catch (error) {
            await db.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            db.release();
          }
        },
      };
    }

    function createService(database: ReturnType<typeof createScopedDatabase>) {
      return new AiRuntimeService(
        database as never,
        {} as never,
        { authorize: async () => undefined } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
    }

    async function readState(fixture: Fixture) {
      const db = await adminPool.connect();
      try {
        const result = await db.query<{
          status: string;
          reconciliationCount: number;
          auditCount: number;
        }>(
          `
          SELECT
            c.status,
            (
              SELECT COUNT(*)::int
              FROM public.ai_execution_claim_reconciliations r
              WHERE r.claim_id = c.id
            ) AS "reconciliationCount",
            (
              SELECT COUNT(*)::int
              FROM public.audit_events a
              WHERE a.tenant_id = c.tenant_id
                AND a.factory_id = c.factory_id
                AND a.resource_id = c.id
                AND a.action = 'RECONCILE_EXECUTION_CLAIM'
            ) AS "auditCount"
          FROM public.ai_execution_claims c
          WHERE c.id = $1
          `,
          [fixture.claimId],
        );
        return result.rows[0];
      } finally {
        db.release();
      }
    }

    it(
      'allows only one of two concurrent reconciliation requests to finalize a claim',
      async () => {
        const fixture = await createFixture();
        let preflightCount = 0;
        let releasePreflight!: () => void;
        const bothPreflightsReady = new Promise<void>((resolve) => {
          releasePreflight = resolve;
        });

        const database = createScopedDatabase(async () => {
          preflightCount += 1;
          if (preflightCount === 2) {
            releasePreflight();
          }
          await bothPreflightsReady;
        });
        const service = createService(database);

        const requests = await Promise.allSettled([
          service.reconcileExecutionClaim(
            scope.tenantId,
            scope.factoryId,
            scope.actorUserId,
            fixture.claimId,
            failedDecision,
          ),
          service.reconcileExecutionClaim(
            scope.tenantId,
            scope.factoryId,
            scope.actorUserId,
            fixture.claimId,
            failedDecision,
          ),
        ]);

        expect(preflightCount).toBe(2);
        expect(requests.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = requests.find((r) => r.status === 'rejected');
        expect(rejected?.status).toBe('rejected');
        if (rejected?.status === 'rejected') {
          expect(rejected.reason).toBeInstanceOf(ConflictException);
        }

        const state = await readState(fixture);
        expect(state).toMatchObject({
          status: 'FAILED',
          reconciliationCount: 1,
          auditCount: 1,
        });
      },
      20_000,
    );

    it(
      'rejects a reconciliation decision that contradicts the stored execution result',
      async () => {
        const fixture = await createFixture(true);
        const service = createService(createScopedDatabase());

        await expect(
          service.reconcileExecutionClaim(
            scope.tenantId,
            scope.factoryId,
            scope.actorUserId,
            fixture.claimId,
            failedDecision,
          ),
        ).rejects.toBeInstanceOf(ConflictException);

        const state = await readState(fixture);
        expect(state).toMatchObject({
          status: 'CLAIMED',
          reconciliationCount: 0,
          auditCount: 0,
        });
      },
      20_000,
    );
  },
);
