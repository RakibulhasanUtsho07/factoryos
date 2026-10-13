import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';

const testDatabaseUrl = process.env.TEST_ADMIN_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe : describe.skip;

interface ScopeFixture {
  tenantId: string;
  factoryId: string;
  actorUserId: string;
}

interface ForecastMetrics {
  absoluteError: string;
  absolutePercentageError: string | null;
}

postgresDescribe('AI operational forecast numeric consistency PostgreSQL invariants', () => {
  let pool: Pool | undefined;
  let client: PoolClient | undefined;
  let scope: ScopeFixture;
  let decisionId: string;
  let outcomeId: string;
  const modelVersion = 'forecast-integrity-it-model';

  function db(): PoolClient {
    if (!client) {
      throw new Error('PostgreSQL integrity-test client is not initialized.');
    }
    return client;
  }

  async function deriveMetrics(
    predictedValue: string,
    actualValue: string,
  ): Promise<ForecastMetrics> {
    const result = await db().query<ForecastMetrics>(
      `
      SELECT
        ABS($1::numeric - $2::numeric)::text AS "absoluteError",
        CASE
          WHEN $2::numeric = 0 THEN NULL
          ELSE (
            ABS($1::numeric - $2::numeric) / ABS($2::numeric)
          )::text
        END AS "absolutePercentageError"
      `,
      [predictedValue, actualValue],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to derive PostgreSQL forecast metrics.');
    return row;
  }

  async function insertEvaluation(input: {
    evaluationKey?: string;
    predictedValue?: string;
    actualValue?: string;
    absoluteError: string;
    absolutePercentageError: string | null;
    tolerance?: string;
    predictionCorrect: boolean;
    sourceOutcomeId?: string;
  }): Promise<void> {
    const predictedValue = input.predictedValue ?? '10';
    const actualValue = input.actualValue ?? '10.2';
    await db().query(
      `
      INSERT INTO ai_operational_evaluation_records (
        id,
        tenant_id,
        factory_id,
        decision_id,
        evaluation_key,
        domain,
        metric_key,
        model_version,
        confidence,
        prediction_correct,
        request_hash,
        created_by,
        source_outcome_id,
        predicted_value,
        actual_value,
        absolute_error,
        absolute_percentage_error,
        tolerance
      )
      VALUES (
        $1, $2, $3, $4, $5, 'QUALITY', 'defect-rate', $6, 0.8,
        $7, $8, $9, $10, $11::numeric, $12::numeric, $13::numeric,
        $14::numeric, $15::numeric
      )
      `,
      [
        randomUUID(),
        scope.tenantId,
        scope.factoryId,
        decisionId,
        input.evaluationKey ?? `forecast-consistency-${randomUUID()}`,
        modelVersion,
        input.predictionCorrect,
        'a'.repeat(64),
        scope.actorUserId,
        input.sourceOutcomeId ?? outcomeId,
        predictedValue,
        actualValue,
        input.absoluteError,
        input.absolutePercentageError,
        input.tolerance ?? '0.3',
      ],
    );
  }

  async function expectCheckViolation(
    input: Parameters<typeof insertEvaluation>[0],
  ): Promise<void> {
    await db().query('SAVEPOINT forecast_numeric_check');
    await expect(insertEvaluation(input)).rejects.toMatchObject({ code: '23514' });
    await db().query('ROLLBACK TO SAVEPOINT forecast_numeric_check');
    await db().query('RELEASE SAVEPOINT forecast_numeric_check');
  }

  beforeAll(async () => {
    if (!testDatabaseUrl) return;

    pool = new Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();

    try {
      const role = await db().query<{ is_superuser: boolean }>(
        `
        SELECT r.rolsuper AS is_superuser
        FROM pg_roles r
        WHERE r.rolname = current_user
        `,
      );
      if (role.rows[0]?.is_superuser !== true) {
        throw new Error(
          'TEST_ADMIN_DATABASE_URL must connect with a PostgreSQL superuser for isolated fixture setup.',
        );
      }

      const context = await db().query<{
        tenant_id: string;
        factory_id: string;
        actor_user_id: string;
      }>(
        `
        SELECT
          t.id::text AS tenant_id,
          f.id::text AS factory_id,
          u.id::text AS actor_user_id
        FROM tenants t
        INNER JOIN factories f ON f.tenant_id = t.id
        INNER JOIN users u ON u.status = 'ACTIVE'
        WHERE t.status = 'ACTIVE'
          AND f.status = 'ACTIVE'
        ORDER BY t.created_at, f.created_at, u.created_at
        LIMIT 1
        `,
      );
      const row = context.rows[0];
      if (!row) {
        throw new Error('No active tenant, factory and user seed was found.');
      }

      scope = {
        tenantId: row.tenant_id,
        factoryId: row.factory_id,
        actorUserId: row.actor_user_id,
      };
      decisionId = randomUUID();
      outcomeId = randomUUID();

      // All fixtures are isolated in a transaction and rolled back in afterAll.
      await db().query('BEGIN');
      await db().query(
        `
        INSERT INTO ai_decision_envelopes (
          id, tenant_id, factory_id, request_id, trace_id, actor_id,
          objective, reasoning_mode, output_state, metadata
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          'Forecast numeric invariant integration test',
          'DETERMINISTIC',
          'TEST',
          jsonb_build_object('model_version', $7)
        )
        `,
        [
          decisionId,
          scope.tenantId,
          scope.factoryId,
          randomUUID(),
          randomUUID(),
          scope.actorUserId,
          modelVersion,
        ],
      );
      await db().query(
        `
        INSERT INTO ai_outcome_links (
          id, tenant_id, factory_id, decision_id,
          expected_metric, actual_metric, status, created_by
        )
        VALUES (
          $1, $2, $3, $4,
          '{"defect-rate": 10}'::jsonb,
          '{"defect-rate": 10.2}'::jsonb,
          'OBSERVED',
          $5
        )
        `,
        [
          outcomeId,
          scope.tenantId,
          scope.factoryId,
          decisionId,
          scope.actorUserId,
        ],
      );
    } catch (error) {
      try {
        await db().query('ROLLBACK');
      } catch {
        // Preserve the fixture/setup error.
      }
      client.release();
      client = undefined;
      await pool.end();
      pool = undefined;
      throw error;
    }
  }, 30_000);

  afterAll(async () => {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Connection close remains necessary after a failed test.
      }
      client.release();
      client = undefined;
    }
    if (pool) {
      await pool.end();
      pool = undefined;
    }
  }, 30_000);

  it('accepts decimal metrics when the saved numeric fields are consistent', async () => {
    const metrics = await deriveMetrics('10', '10.2');
    await insertEvaluation({
      absoluteError: metrics.absoluteError,
      absolutePercentageError: metrics.absolutePercentageError,
      predictionCorrect: true,
    });

    const saved = await db().query<{
      predicted_value: string;
      actual_value: string;
      absolute_error: string;
      absolute_percentage_error: string;
      prediction_correct: boolean;
    }>(
      `
      SELECT
        predicted_value::text,
        actual_value::text,
        absolute_error::text,
        absolute_percentage_error::text,
        prediction_correct
      FROM ai_operational_evaluation_records
      WHERE tenant_id = $1
        AND factory_id = $2
        AND source_outcome_id = $3
        AND model_version = $4
        AND evaluation_key LIKE 'forecast-consistency-%'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [scope.tenantId, scope.factoryId, outcomeId, modelVersion],
    );

    expect(saved.rows[0]).toMatchObject({
      predicted_value: '10',
      actual_value: '10.2',
      absolute_error: metrics.absoluteError,
      absolute_percentage_error: metrics.absolutePercentageError,
      prediction_correct: true,
    });
  });

  it('rejects an absolute error that differs from the source metric delta', async () => {
    const metrics = await deriveMetrics('10', '10.2');
    await expectCheckViolation({
      absoluteError: '0.3',
      absolutePercentageError: metrics.absolutePercentageError,
      predictionCorrect: true,
    });
  });

  it('rejects an absolute percentage error inconsistent with the absolute error', async () => {
    const metrics = await deriveMetrics('10', '10.2');
    await expectCheckViolation({
      absoluteError: metrics.absoluteError,
      absolutePercentageError: '0.03',
      predictionCorrect: true,
    });
  });

  it('rejects a correctness label inconsistent with the configured tolerance', async () => {
    const metrics = await deriveMetrics('10', '10.2');
    await expectCheckViolation({
      absoluteError: metrics.absoluteError,
      absolutePercentageError: metrics.absolutePercentageError,
      predictionCorrect: false,
    });
  });

  it('requires a null percentage error when the authoritative actual value is zero', async () => {
    const zeroOutcomeId = randomUUID();
    await db().query(
      `
      INSERT INTO ai_outcome_links (
        id, tenant_id, factory_id, decision_id,
        expected_metric, actual_metric, status, created_by
      )
      VALUES (
        $1, $2, $3, $4,
        '{"defect-rate": 1}'::jsonb,
        '{"defect-rate": 0}'::jsonb,
        'OBSERVED',
        $5
      )
      `,
      [zeroOutcomeId, scope.tenantId, scope.factoryId, decisionId, scope.actorUserId],
    );

    await insertEvaluation({
      sourceOutcomeId: zeroOutcomeId,
      predictedValue: '1',
      actualValue: '0',
      absoluteError: '1',
      absolutePercentageError: null,
      tolerance: '0',
      predictionCorrect: false,
      evaluationKey: `forecast-zero-actual-${randomUUID()}`,
    });
  });
});
