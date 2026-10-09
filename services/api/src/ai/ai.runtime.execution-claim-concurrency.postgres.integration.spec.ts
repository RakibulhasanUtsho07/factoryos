import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Pool } from 'pg';

import type {
  PoolClient,
  QueryResult,
  QueryResultRow,
} from 'pg';

import { AiRuntimeService } from './ai.runtime.service';
import type {
  ReconcileAiExecutionClaimDto,
} from './dto/reconcile-ai-execution-claim.dto';

interface QueryContext {
  tenantId?: string | null;
  userId?: string | null;
}

interface ActiveContextRow extends QueryResultRow {
  tenant_id: string;
  factory_id: string;
  actor_user_id: string;
}

interface ClaimFixture {
  decisionId: string;
  actionIntentId: string;
  claimId: string;
  executionKey: string;
  toolVersion: string;
  inputsHash: string;
}

type RuntimeQuery = <
  T extends QueryResultRow = QueryResultRow,
>(
  sql: string,
  values?: unknown[],
  context?: QueryContext,
) => Promise<QueryResult<T>>;

const sourceDatabaseUrl =
  process.env.B19_TEST_ADMIN_DATABASE_URL;

const describeWithPostgres = sourceDatabaseUrl
  ? describe
  : describe.skip;

function quoteIdentifier(value: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) {
    throw new Error('Unexpected PostgreSQL identifier.');
  }

  return `"${value}"`;
}

describeWithPostgres(
  'B19 execution/reconciliation concurrency PostgreSQL integration',
  () => {
    let adminPool: Pool | undefined;
    let testPool: Pool | undefined;
    let cloneDatabaseName: string | undefined;

    let tenantId: string;
    let factoryId: string;
    let actorUserId: string;

    function getAdminPool(): Pool {
      if (!adminPool) {
        throw new Error('Admin connection is not initialized.');
      }

      return adminPool;
    }

    function getTestPool(): Pool {
      if (!testPool) {
        throw new Error('Test database is not initialized.');
      }

      return testPool;
    }

    async function applyAppContext(
      client: PoolClient,
      contextTenantId: string,
      contextUserId: string,
      applicationName: string,
    ): Promise<void> {
      await client.query('SET LOCAL ROLE factoryos_app');

      await client.query(
        `SELECT set_config('application_name', $1, true)`,
        [applicationName],
      );

      await client.query(
        `SELECT set_config('app.tenant_id', $1, true)`,
        [contextTenantId],
      );

      await client.query(
        `SELECT set_config('app.user_id', $1, true)`,
        [contextUserId],
      );
    }

    /**
     * Models DatabaseService.query() for tenant-scoped operations:
     * each query uses its own transaction and a real pooled connection.
     */
    function createPoolQueryAdapter(
      applicationName: string,
    ): RuntimeQuery {
      return async function query<
        T extends QueryResultRow = QueryResultRow,
      >(
        sql: string,
        values: unknown[] = [],
        context?: QueryContext,
      ): Promise<QueryResult<T>> {
        const db = await getTestPool().connect();

        try {
          await db.query('BEGIN');

          await applyAppContext(
            db,
            context?.tenantId ?? '',
            context?.userId ?? '',
            applicationName,
          );

          const result = await db.query<T>(
            sql,
            values as never,
          );

          await db.query('COMMIT');

          return result;
        } catch (error) {
          try {
            await db.query('ROLLBACK');
          } catch {
            // Keep the original database error.
          }

          throw error;
        } finally {
          db.release();
        }
      };
    }

    /**
     * Uses a caller-owned transaction. This lets the test hold a row
     * lock while a second, genuinely separate PostgreSQL connection waits.
     */
    function createPinnedQueryAdapter(
      client: PoolClient,
      applicationName: string,
    ): RuntimeQuery {
      return async function query<
        T extends QueryResultRow = QueryResultRow,
      >(
        sql: string,
        values: unknown[] = [],
        context?: QueryContext,
      ): Promise<QueryResult<T>> {
        await client.query(
          `SELECT set_config('application_name', $1, true)`,
          [applicationName],
        );

        await client.query(
          `SELECT set_config('app.tenant_id', $1, true)`,
          [context?.tenantId ?? ''],
        );

        await client.query(
          `SELECT set_config('app.user_id', $1, true)`,
          [context?.userId ?? ''],
        );

        return client.query<T>(
          sql,
          values as never,
        );
      };
    }

    function createService(query: RuntimeQuery): AiRuntimeService {
      return new AiRuntimeService(
        { query } as never,
        {} as never,
        { authorize: async () => undefined } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
    }

    async function createClaimFixture(): Promise<ClaimFixture> {
      const db = await getTestPool().connect();

      const fixture: ClaimFixture = {
        decisionId: randomUUID(),
        actionIntentId: randomUUID(),
        claimId: randomUUID(),
        executionKey: `B19.CONCURRENCY.${randomUUID()}`,
        toolVersion: '1.0.0',
        inputsHash: 'b'.repeat(64),
      };

      const actionType = `AI.B19.CONCURRENCY.${randomUUID()}`;
      const tokenHash = randomUUID()
        .replace(/-/g, '')
        .repeat(2);

      try {
        await db.query('BEGIN');

        await db.query(
          `
          INSERT INTO public.ai_decision_envelopes (
            id,
            tenant_id,
            factory_id,
            request_id,
            trace_id,
            actor_id,
            objective,
            reasoning_mode,
            output_state,
            metadata
          )
          VALUES (
            $1, $2, $3, $4, $5, $6,
            'B19 concurrency integration fixture',
            'DETERMINISTIC',
            'TEST',
            '{}'::jsonb
          )
          `,
          [
            fixture.decisionId,
            tenantId,
            factoryId,
            randomUUID(),
            randomUUID(),
            actorUserId,
          ],
        );

        await db.query(
          `
          INSERT INTO public.ai_action_intents (
            id,
            tenant_id,
            factory_id,
            decision_id,
            action_type,
            tool_id,
            tool_version,
            target,
            resource_type,
            resource_id,
            payload,
            payload_hash,
            risk_class,
            authorization_status,
            "authorization",
            approval_id,
            action_token_hash,
            token_expires_at,
            idempotency_key,
            created_by
          )
          VALUES (
            $1, $2, $3, $4, $5, $5, $6,
            '{}'::jsonb, NULL, NULL, '{}'::jsonb,
            $7, 'L0', 'AUTHORIZED', '{}'::jsonb,
            NULL, $8, NOW() + INTERVAL '1 hour',
            NULL, $9
          )
          `,
          [
            fixture.actionIntentId,
            tenantId,
            factoryId,
            fixture.decisionId,
            actionType,
            fixture.toolVersion,
            'a'.repeat(64),
            tokenHash,
            actorUserId,
          ],
        );

        await db.query(
          `
          INSERT INTO public.ai_execution_claims (
            id,
            tenant_id,
            factory_id,
            action_intent_id,
            execution_key,
            tool_version,
            inputs_hash,
            status,
            claimed_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            'CLAIMED',
            NOW() - INTERVAL '20 minutes'
          )
          `,
          [
            fixture.claimId,
            tenantId,
            factoryId,
            fixture.actionIntentId,
            fixture.executionKey,
            fixture.toolVersion,
            fixture.inputsHash,
          ],
        );

        // Commit so both competing connections can see the fixture.
        await db.query('COMMIT');

        return fixture;
      } catch (error) {
        try {
          await db.query('ROLLBACK');
        } catch {
          // Preserve the original error.
        }

        throw error;
      } finally {
        db.release();
      }
    }

    function reconciliationInput(): ReconcileAiExecutionClaimDto {
      return {
        decision: 'CONFIRMED_FAILED',
        reason:
          'Concurrency integration test verified the claim state.',
        evidence_ref: `B19-CONCURRENCY-${randomUUID()}`,
      };
    }

    async function waitForLockWait(
      applicationName: string,
      timeoutMs = 10_000,
    ): Promise<void> {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const result = await getAdminPool().query<{
          waiting: boolean;
        }>(
          `
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity
            WHERE datname = $1
              AND application_name = $2
              AND state = 'active'
              AND wait_event_type = 'Lock'
          ) AS waiting
          `,
          [
            cloneDatabaseName,
            applicationName,
          ],
        );

        if (result.rows[0]?.waiting) {
          return;
        }

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }

      throw new Error(
        `Timed out waiting for PostgreSQL lock wait: ${applicationName}`,
      );
    }

    async function readClaimStatus(
      claimId: string,
    ): Promise<string> {
      const result = await getTestPool().query<{
        status: string;
      }>(
        `
        SELECT status
        FROM public.ai_execution_claims
        WHERE id = $1
        `,
        [claimId],
      );

      if (!result.rows[0]) {
        throw new Error(`Claim ${claimId} was not found.`);
      }

      return result.rows[0].status;
    }

    async function countLedgerRows(
      claimId: string,
    ): Promise<number> {
      const result = await getTestPool().query<{
        count: number;
      }>(
        `
        SELECT COUNT(*)::int AS count
        FROM public.ai_execution_claim_reconciliations
        WHERE tenant_id = $1
          AND factory_id = $2
          AND claim_id = $3
        `,
        [tenantId, factoryId, claimId],
      );

      return Number(result.rows[0]?.count ?? 0);
    }

    async function countReconciliationAuditRows(
      claimId: string,
    ): Promise<number> {
      const result = await getTestPool().query<{
        count: number;
      }>(
        `
        SELECT COUNT(*)::int AS count
        FROM public.audit_events
        WHERE tenant_id = $1
          AND factory_id = $2
          AND resource_id = $3
          AND action = 'RECONCILE_EXECUTION_CLAIM'
        `,
        [tenantId, factoryId, claimId],
      );

      return Number(result.rows[0]?.count ?? 0);
    }

    async function finishSuccessfulExecution(
      client: PoolClient,
      claimId: string,
    ): Promise<void> {
      const inserted = await client.query(
        `
        INSERT INTO public.ai_execution_records (
          id,
          tenant_id,
          factory_id,
          decision_id,
          action_intent_id,
          execution_key,
          executor_type,
          tool_version,
          inputs_hash,
          result,
          error,
          status,
          finished_at
        )
        SELECT
          gen_random_uuid(),
          c.tenant_id,
          c.factory_id,
          a.decision_id,
          c.action_intent_id,
          c.execution_key,
          'AI_TOOL_GATEWAY',
          c.tool_version,
          c.inputs_hash,
          '{}'::jsonb,
          '{}'::jsonb,
          'SUCCEEDED',
          NOW()
        FROM public.ai_execution_claims c
        INNER JOIN public.ai_action_intents a
          ON a.id = c.action_intent_id
         AND a.tenant_id = c.tenant_id
         AND a.factory_id = c.factory_id
        WHERE c.id = $1
          AND c.status = 'CLAIMED'
        RETURNING id
        `,
        [claimId],
      );

      if (inserted.rowCount !== 1) {
        throw new Error(
          'Execution fixture could not insert its execution record.',
        );
      }

      const updated = await client.query(
        `
        UPDATE public.ai_execution_claims
        SET
          status = 'COMPLETED',
          failure_code = NULL,
          completed_at = NOW()
        WHERE id = $1
          AND status = 'CLAIMED'
        RETURNING id
        `,
        [claimId],
      );

      if (updated.rowCount !== 1) {
        throw new Error(
          'Execution fixture could not complete its claim.',
        );
      }
    }

    beforeAll(async () => {
      if (!sourceDatabaseUrl) {
        return;
      }

      const sourceUrl = new URL(sourceDatabaseUrl);
      const sourceDatabaseName = decodeURIComponent(
        sourceUrl.pathname.replace(/^\//, ''),
      );

      if (
        !['localhost', '127.0.0.1', '::1', '[::1]'].includes(
          sourceUrl.hostname,
        ) ||
        !sourceDatabaseName.startsWith(
          'factoryos_b19_restore_test_',
        )
      ) {
        throw new Error(
          'B19 concurrency tests require a local factoryos_b19_restore_test_* database.',
        );
      }

      // The template must be idle while PostgreSQL clones the database.
      const controlUrl = new URL(sourceDatabaseUrl);
      controlUrl.pathname = '/postgres';

      adminPool = new Pool({
        connectionString: controlUrl.toString(),
        max: 4,
      });

      const adminRole = await getAdminPool().query<{
        is_superuser: boolean;
      }>(
        `
        SELECT rolsuper AS is_superuser
        FROM pg_roles
        WHERE rolname = current_user
        `,
      );

      if (adminRole.rows[0]?.is_superuser !== true) {
        throw new Error(
          'B19_TEST_ADMIN_DATABASE_URL must use a local PostgreSQL superuser.',
        );
      }

      const activeConnections =
        await getAdminPool().query<{ count: number }>(
          `
          SELECT COUNT(*)::int AS count
          FROM pg_stat_activity
          WHERE datname = $1
          `,
          [sourceDatabaseName],
        );

      if (Number(activeConnections.rows[0]?.count ?? 0) !== 0) {
        throw new Error(
          'Close connections to the isolated template database before running the B19 concurrency test.',
        );
      }

      cloneDatabaseName =
        `factoryos_b19_restore_test_concurrency_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

      await getAdminPool().query(
        `CREATE DATABASE ${quoteIdentifier(cloneDatabaseName)} TEMPLATE ${quoteIdentifier(sourceDatabaseName)}`,
      );

      const testUrl = new URL(sourceDatabaseUrl);
      testUrl.pathname = `/${cloneDatabaseName}`;

      testPool = new Pool({
        connectionString: testUrl.toString(),
        max: 12,
      });

      const schema = await getTestPool().query<{
        migration_installed: boolean;
        ledger_exists: boolean;
      }>(
        `
        SELECT
          EXISTS (
            SELECT 1
            FROM public.schema_migrations
            WHERE version = '028_ai_execution_claim_reconciliation'
          ) AS migration_installed,
          to_regclass(
            'public.ai_execution_claim_reconciliations'
          ) IS NOT NULL AS ledger_exists
        `,
      );

      if (
        !schema.rows[0]?.migration_installed ||
        !schema.rows[0]?.ledger_exists
      ) {
        throw new Error(
          'The source test database must already contain migration 028.',
        );
      }

      const appRole = await getTestPool().query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        `
        SELECT rolsuper, rolbypassrls
        FROM pg_roles
        WHERE rolname = 'factoryos_app'
        `,
      );

      if (
        !appRole.rows[0] ||
        appRole.rows[0].rolsuper ||
        appRole.rows[0].rolbypassrls
      ) {
        throw new Error(
          'factoryos_app must exist without superuser or BYPASSRLS privileges.',
        );
      }

      const context = await getTestPool().query<ActiveContextRow>(
        `
        SELECT
          t.id::text AS tenant_id,
          f.id::text AS factory_id,
          u.id::text AS actor_user_id
        FROM public.tenants t
        INNER JOIN public.factories f
          ON f.tenant_id = t.id
        INNER JOIN public.tenant_memberships tm
          ON tm.tenant_id = t.id
         AND tm.status = 'ACTIVE'
        INNER JOIN public.users u
          ON u.id = tm.user_id
         AND u.status = 'ACTIVE'
        WHERE t.status = 'ACTIVE'
          AND f.status = 'ACTIVE'
        ORDER BY t.created_at, f.created_at
        LIMIT 1
        `,
      );

      const active = context.rows[0];

      if (!active) {
        throw new Error(
          'The test database has no active tenant/factory/user membership.',
        );
      }

      tenantId = active.tenant_id;
      factoryId = active.factory_id;
      actorUserId = active.actor_user_id;
    }, 30_000);

    afterAll(async () => {
      if (testPool) {
        await testPool.end();
        testPool = undefined;
      }

      try {
        if (adminPool && cloneDatabaseName) {
          await adminPool.query(
            `DROP DATABASE IF EXISTS ${quoteIdentifier(cloneDatabaseName)}`,
          );
        }
      } finally {
        if (adminPool) {
          await adminPool.end();
          adminPool = undefined;
        }
      }
    }, 30_000);

    it(
      'does not reconcile a claim after the execution transaction completes it',
      async () => {
        const fixture = await createClaimFixture();
        const executor = await getTestPool().connect();

        let executorTransactionOpen = false;

        let reconciliationOutcome:
          | Promise<
              | { kind: 'resolved'; result: unknown }
              | { kind: 'rejected'; error: unknown }
            >
          | undefined;

        try {
          await executor.query('BEGIN');
          executorTransactionOpen = true;

          await applyAppContext(
            executor,
            tenantId,
            actorUserId,
            'b19_execution_holder',
          );

          const locked = await executor.query<{
            status: string;
          }>(
            `
            SELECT status
            FROM public.ai_execution_claims
            WHERE id = $1
            FOR UPDATE
            `,
            [fixture.claimId],
          );

          expect(locked.rows[0]?.status).toBe('CLAIMED');

          const service = createService(
            createPoolQueryAdapter('b19_reconciliation_waiter'),
          );

          reconciliationOutcome =
            service.reconcileExecutionClaim(
              tenantId,
              factoryId,
              actorUserId,
              fixture.claimId,
              reconciliationInput(),
            ).then(
              (result) => ({
                kind: 'resolved' as const,
                result,
              }),
              (error: unknown) => ({
                kind: 'rejected' as const,
                error,
              }),
            );

          // The reconciler must reach its final SQL and block on our row lock.
          await waitForLockWait('b19_reconciliation_waiter');

          // Simulate execution finalization while the row lock is held.
          await finishSuccessfulExecution(
            executor,
            fixture.claimId,
          );

          await executor.query('COMMIT');
          executorTransactionOpen = false;

          const outcome = await reconciliationOutcome;

          expect(outcome.kind).toBe('rejected');

          if (outcome.kind !== 'rejected') {
            throw new Error(
              'Reconciliation unexpectedly succeeded after execution completed.',
            );
          }

          expect(outcome.error).toBeInstanceOf(ConflictException);

          expect(
            await readClaimStatus(fixture.claimId),
          ).toBe('COMPLETED');

          expect(
            await countLedgerRows(fixture.claimId),
          ).toBe(0);

          expect(
            await countReconciliationAuditRows(fixture.claimId),
          ).toBe(0);
        } finally {
          if (executorTransactionOpen) {
            await executor.query('ROLLBACK').catch(() => undefined);
          }

          if (reconciliationOutcome) {
            await reconciliationOutcome.catch(() => undefined);
          }

          executor.release();
        }
      },
      30_000,
    );

    it(
      'prevents execution from proceeding when reconciliation wins the claim lock',
      async () => {
        const fixture = await createClaimFixture();

        const reconciler = await getTestPool().connect();
        const executor = await getTestPool().connect();

        let reconcilerTransactionOpen = false;
        let executorTransactionOpen = false;

        let executionLockResult:
          | Promise<QueryResult<{ status: string }>>
          | undefined;

        try {
          await reconciler.query('BEGIN');
          reconcilerTransactionOpen = true;

          await applyAppContext(
            reconciler,
            tenantId,
            actorUserId,
            'b19_reconciliation_holder',
          );

          const locked = await reconciler.query<{
            status: string;
          }>(
            `
            SELECT status
            FROM public.ai_execution_claims
            WHERE id = $1
            FOR UPDATE
            `,
            [fixture.claimId],
          );

          expect(locked.rows[0]?.status).toBe('CLAIMED');

          await executor.query('BEGIN');
          executorTransactionOpen = true;

          await applyAppContext(
            executor,
            tenantId,
            actorUserId,
            'b19_execution_waiter',
          );

          executionLockResult = executor.query<{
            status: string;
          }>(
            `
            SELECT status
            FROM public.ai_execution_claims
            WHERE id = $1
            FOR UPDATE
            `,
            [fixture.claimId],
          );

          // Confirm the executor is really waiting in PostgreSQL.
          await waitForLockWait('b19_execution_waiter');

          /*
           * Run the actual reconciliation service on the transaction
           * that owns the lock. The executor cannot pass its status
           * check until this transaction commits.
           */
          const service = createService(
            createPinnedQueryAdapter(
              reconciler,
              'b19_reconciliation_holder',
            ),
          );

          const result = await service.reconcileExecutionClaim(
            tenantId,
            factoryId,
            actorUserId,
            fixture.claimId,
            reconciliationInput(),
          );

          expect(result).toMatchObject({
            claimId: fixture.claimId,
            decision: 'CONFIRMED_FAILED',
            resultingStatus: 'FAILED',
            automaticRetryAllowed: false,
          });

          await reconciler.query('COMMIT');
          reconcilerTransactionOpen = false;

          const executionRead = await executionLockResult;

          // SELECT FOR UPDATE must return the latest, reconciled row.
          expect(executionRead.rows[0]?.status).toBe('FAILED');

          await executor.query('COMMIT');
          executorTransactionOpen = false;

          expect(
            await readClaimStatus(fixture.claimId),
          ).toBe('FAILED');

          expect(
            await countLedgerRows(fixture.claimId),
          ).toBe(1);

          expect(
            await countReconciliationAuditRows(fixture.claimId),
          ).toBe(1);
        } finally {
          if (reconcilerTransactionOpen) {
            await reconciler.query('ROLLBACK').catch(() => undefined);
          }

          if (executionLockResult) {
            await executionLockResult.catch(() => undefined);
          }

          if (executorTransactionOpen) {
            await executor.query('ROLLBACK').catch(() => undefined);
          }

          reconciler.release();
          executor.release();
        }
      },
      30_000,
    );
  },
);