
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type {
  PoolClient,
  QueryResult,
  QueryResultRow,
} from 'pg';

import { AiRuntimeService } from './ai.runtime.service';
import type { ReconcileAiExecutionClaimDto } from './dto/reconcile-ai-execution-claim.dto';

interface ActiveContextRow extends QueryResultRow {
  tenant_id: string;
  factory_id: string;
  actor_user_id: string;
}

interface RecoveryFixture {
  claimId: string;
}

interface QueryContext {
  tenantId?: string | null;
  userId?: string | null;
}

const testDatabaseUrl =
  process.env.B19_TEST_ADMIN_DATABASE_URL;

const describeWithPostgres = testDatabaseUrl
  ? describe
  : describe.skip;

describeWithPostgres(
  'AI execution claim recovery PostgreSQL integration',
  () => {
    let pool: Pool | undefined;
    let client: PoolClient | undefined;
    let service: AiRuntimeService;

    let tenantId: string;
    let factoryId: string;
    let actorUserId: string;

    let successFixture: RecoveryFixture;
    let rollbackFixture: RecoveryFixture;

    const getClient = (): PoolClient => {
      if (!client) {
        throw new Error(
          'PostgreSQL integration client is not initialized.',
        );
      }

      return client;
    };

    async function queryAsApp<
      T extends QueryResultRow = QueryResultRow,
    >(
      sql: string,
      values: unknown[] = [],
      context?: QueryContext,
    ): Promise<QueryResult<T>> {
      const db = getClient();

      if (context?.tenantId !== undefined) {
        await db.query(
          `SELECT set_config('app.tenant_id', $1, true)`,
          [context.tenantId ?? ''],
        );
      }

      if (context?.userId !== undefined) {
        await db.query(
          `SELECT set_config('app.user_id', $1, true)`,
          [context.userId ?? ''],
        );
      }

      return db.query<T>(sql, values as never);
    }

    async function createClaimFixture(): Promise<RecoveryFixture> {
      const db = getClient();

      const decisionId = randomUUID();
      const actionIntentId = randomUUID();
      const claimId = randomUUID();
      const actionType = `AI.B19.IT.${randomUUID()}`;
      const tokenHash = randomUUID()
        .replace(/-/g, '')
        .repeat(2);

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
          'B19 recovery integration fixture',
          'DETERMINISTIC',
          'TEST',
          '{}'::jsonb
        )
        `,
        [
          decisionId,
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
          $1, $2, $3, $4, $5, $5, '1.0.0',
          '{}'::jsonb, NULL, NULL, '{}'::jsonb,
          $6, 'L0', 'AUTHORIZED', '{}'::jsonb,
          NULL, $7, NOW() + INTERVAL '1 hour',
          NULL, $8
        )
        `,
        [
          actionIntentId,
          tenantId,
          factoryId,
          decisionId,
          actionType,
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
          $1, $2, $3, $4, $5, '1.0.0',
          $6, 'CLAIMED', NOW() - INTERVAL '20 minutes'
        )
        `,
        [
          claimId,
          tenantId,
          factoryId,
          actionIntentId,
          `B19.IT.${randomUUID()}`,
          'b'.repeat(64),
        ],
      );

      return { claimId };
    }

    async function countForClaim(
      table: 'ai_execution_claim_reconciliations' | 'audit_events',
      claimId: string,
    ): Promise<number> {
      const query =
        table === 'audit_events'
          ? `
            SELECT COUNT(*)::int AS count
            FROM public.audit_events
            WHERE tenant_id = $1
              AND factory_id = $2
              AND resource_id = $3
              AND action = 'RECONCILE_EXECUTION_CLAIM'
          `
          : `
            SELECT COUNT(*)::int AS count
            FROM public.ai_execution_claim_reconciliations
            WHERE tenant_id = $1
              AND factory_id = $2
              AND claim_id = $3
          `;

      const result = await queryAsApp<{ count: number }>(
        query,
        [tenantId, factoryId, claimId],
        { tenantId, userId: actorUserId },
      );

      return Number(result.rows[0]?.count ?? 0);
    }

    const reconciliationInput: ReconcileAiExecutionClaimDto = {
      decision: 'CONFIRMED_FAILED',
      reason:
        'Integration test confirms the stale execution was investigated.',
      evidence_ref: 'B19-POSTGRES-IT-INCIDENT-1042',
    };

    beforeAll(async () => {
      if (!testDatabaseUrl) {
        return;
      }

      const parsedUrl = new URL(testDatabaseUrl);
      const databaseName = decodeURIComponent(
        parsedUrl.pathname.replace(/^\//, ''),
      );

      if (
        !['localhost', '127.0.0.1', '::1', '[::1]'].includes(
          parsedUrl.hostname,
        ) ||
        !databaseName.startsWith('factoryos_b19_restore_test_')
      ) {
        throw new Error(
          'B19 integration tests require a local factoryos_b19_restore_test_* database.',
        );
      }

      pool = new Pool({
        connectionString: testDatabaseUrl,
      });

      client = await pool.connect();

      try {
        const db = getClient();

        const roleResult = await db.query<{
          is_superuser: boolean;
        }>(
          `
          SELECT r.rolsuper AS is_superuser
          FROM pg_roles r
          WHERE r.rolname = current_user
          `,
        );

        if (roleResult.rows[0]?.is_superuser !== true) {
          throw new Error(
            'B19_TEST_ADMIN_DATABASE_URL must use a local PostgreSQL superuser.',
          );
        }

        const schemaResult = await db.query<{
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
          !schemaResult.rows[0]?.migration_installed ||
          !schemaResult.rows[0]?.ledger_exists
        ) {
          throw new Error(
            'Migration 028 must be applied to the isolated test database first.',
          );
        }

        const appRoleResult = await db.query<{
          rolsuper: boolean;
          rolbypassrls: boolean;
        }>(
          `
          SELECT rolsuper, rolbypassrls
          FROM pg_roles
          WHERE rolname = 'factoryos_app'
          `,
        );

        const appRole = appRoleResult.rows[0];

        if (
          !appRole ||
          appRole.rolsuper ||
          appRole.rolbypassrls
        ) {
          throw new Error(
            'factoryos_app must exist without superuser or BYPASSRLS privileges.',
          );
        }

        const contextResult =
          await db.query<ActiveContextRow>(
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

        const context = contextResult.rows[0];

        if (!context) {
          throw new Error(
            'No active tenant, factory, and user membership found for integration testing.',
          );
        }

        tenantId = context.tenant_id;
        factoryId = context.factory_id;
        actorUserId = context.actor_user_id;

        /*
         * Test fixtures and the temporary failure trigger are all
         * rolled back in afterAll. No production DB is targeted.
         */
        await db.query('BEGIN');

        successFixture = await createClaimFixture();
        rollbackFixture = await createClaimFixture();

        const suffix = randomUUID().replace(/-/g, '');
        const functionName = `b19_it_fail_audit_${suffix}`;
        const triggerName = `trg_${functionName}`;

        await db.query(`
          CREATE FUNCTION public.${functionName}()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $function$
          BEGIN
            IF NEW.action = 'RECONCILE_EXECUTION_CLAIM'
               AND NEW.resource_id =
                 '${rollbackFixture.claimId}'::uuid THEN
              RAISE EXCEPTION
                'B19 integration test forced audit insert failure';
            END IF;

            RETURN NEW;
          END;
          $function$;
        `);

        await db.query(`
          CREATE TRIGGER ${triggerName}
          BEFORE INSERT ON public.audit_events
          FOR EACH ROW
          EXECUTE FUNCTION public.${functionName}();
        `);

        await db.query('SET LOCAL ROLE factoryos_app');

        const iamService = {
          authorize: async () => undefined,
        };

        service = new AiRuntimeService(
          { query: queryAsApp } as never,
          {} as never,
          iamService as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
        );
      } catch (error) {
        try {
          await getClient().query('ROLLBACK');
        } catch {
          // Preserve the original setup error.
        }

        client.release();
        client = undefined;

        await pool.end();
        pool = undefined;

        throw error;
      }
    }, 30000);

    afterAll(async () => {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Connection cleanup remains necessary after a failed test.
        }

        client.release();
        client = undefined;
      }

      if (pool) {
        await pool.end();
        pool = undefined;
      }
    }, 30000);

    it('updates the claim and writes its reconciliation and audit records', async () => {
      const result = await service.reconcileExecutionClaim(
        tenantId,
        factoryId,
        actorUserId,
        successFixture.claimId,
        reconciliationInput,
      );

      expect(result).toMatchObject({
        claimId: successFixture.claimId,
        decision: 'CONFIRMED_FAILED',
        resultingStatus: 'FAILED',
        automaticRetryAllowed: false,
        evidenceRef: reconciliationInput.evidence_ref,
      });

      const claimResult = await queryAsApp<{
        status: string;
        failure_code: string | null;
      }>(
        `
        SELECT status, failure_code
        FROM public.ai_execution_claims
        WHERE id = $1
          AND tenant_id = $2
          AND factory_id = $3
        `,
        [successFixture.claimId, tenantId, factoryId],
        { tenantId, userId: actorUserId },
      );

      expect(claimResult.rows[0]).toMatchObject({
        status: 'FAILED',
        failure_code: 'OPERATOR_CONFIRMED_FAILED',
      });

      expect(
        await countForClaim(
          'ai_execution_claim_reconciliations',
          successFixture.claimId,
        ),
      ).toBe(1);

      expect(
        await countForClaim(
          'audit_events',
          successFixture.claimId,
        ),
      ).toBe(1);
    });

    it('rolls back the claim and reconciliation when the audit insert fails', async () => {
      const db = getClient();

      await db.query('SAVEPOINT b19_audit_failure');

      await expect(
        service.reconcileExecutionClaim(
          tenantId,
          factoryId,
          actorUserId,
          rollbackFixture.claimId,
          reconciliationInput,
        ),
      ).rejects.toThrow(
        'B19 integration test forced audit insert failure',
      );

      /*
       * The failed SQL statement aborts the current transaction
       * until we roll back to the savepoint.
       */
      await db.query('ROLLBACK TO SAVEPOINT b19_audit_failure');

      const claimResult = await queryAsApp<{
        status: string;
        failure_code: string | null;
      }>(
        `
        SELECT status, failure_code
        FROM public.ai_execution_claims
        WHERE id = $1
          AND tenant_id = $2
          AND factory_id = $3
        `,
        [rollbackFixture.claimId, tenantId, factoryId],
        { tenantId, userId: actorUserId },
      );

      expect(claimResult.rows[0]).toMatchObject({
        status: 'CLAIMED',
        failure_code: null,
      });

      expect(
        await countForClaim(
          'ai_execution_claim_reconciliations',
          rollbackFixture.claimId,
        ),
      ).toBe(0);

      expect(
        await countForClaim(
          'audit_events',
          rollbackFixture.claimId,
        ),
      ).toBe(0);
    });
  },
);