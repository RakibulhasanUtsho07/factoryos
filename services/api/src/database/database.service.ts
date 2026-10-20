import {
  Injectable,
  Optional,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import {
  ConfigService,
} from '@nestjs/config';

import {
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow,
} from 'pg';
import { performance } from 'node:perf_hooks';
import { currentTraceContext } from '../common/trace-context.store';
import { HttpMetricsService } from '../observability/http-metrics.service';
import { OtlpTraceExporter } from '../observability/otlp-trace-exporter.service';

/**
 * Transaction-local database context.
 *
 * tenantId:
 *   PostgreSQL RLS tenant boundary.
 *
 * userId:
 *   Authenticated application user identity.
 *
 * Both values are stored with PostgreSQL set_config(..., true),
 * where TRUE means transaction-local scope.
 */
export interface DatabaseContext {
  tenantId?:
    | string
    | null;

  userId?:
    | string
    | null;

  requestId?: string | null;

  traceId?: string | null;

  /** Optional per-operation isolation; default transaction behavior is unchanged. */
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

  /** Acquire a session advisory lock before BEGIN/snapshot creation, then release it. */
  advisoryLockKey?: string | null;
}

type TransactionCallback<T> = (
  client: PoolClient,
) => Promise<T>;

@Injectable()
export class DatabaseService
  implements
    OnModuleInit,
    OnModuleDestroy
{
  private readonly pool: Pool;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: HttpMetricsService,
    @Optional() private readonly traceExporter?: OtlpTraceExporter,
  ) {
    const connectionString =
      this.configService.get<string>(
        'DATABASE_URL',
      );

    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not configured',
      );
    }

    this.pool =
      new Pool({
        connectionString,

        max: 20,

        idleTimeoutMillis:
          30_000,

        connectionTimeoutMillis:
          5_000,
      });
  }

  // ==========================================================
  // MODULE LIFECYCLE
  // ==========================================================

  async onModuleInit(): Promise<void> {
    /*
     * Health/connectivity check.
     *
     * This query intentionally has no tenant context because
     * it only verifies database connectivity.
     */
    await this.query(
      'SELECT 1',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  // ==========================================================
  // QUERY
  // ==========================================================

  /**
   * Execute a normal database query without tenant context.
   *
   * This preserves the original behavior for global/control-plane
   * tables such as:
   *
   *   tenants
   *   users
   *   permissions
   *   auth_identities
   *
   * When a DatabaseContext is supplied, the query runs inside a
   * transaction so RLS can read transaction-local settings.
   */
  async query<
    T extends QueryResultRow =
      QueryResultRow,
  >(
    text: string,
    values: unknown[] = [],
    context?: DatabaseContext,
  ): Promise<
    QueryResult<T>
  > {
    const hasContext =
      context?.tenantId !==
        undefined ||
      context?.userId !==
        undefined;

    /*
     * --------------------------------------------------------
     * GLOBAL / CONTROL-PLANE QUERY
     * --------------------------------------------------------
     */
    if (!hasContext) {
      const startedAt = performance.now();
      const startedAtUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();
      try {
        const result = await this.pool.query<T>(text, values);
        this.recordDatabaseOperation(this.classifySqlOperation(text), 'success', startedAt, startedAtUnixNano);
        return result;
      } catch (error) {
        this.recordDatabaseOperation(this.classifySqlOperation(text), 'error', startedAt, startedAtUnixNano);
        throw error;
      }
    }

    /*
     * --------------------------------------------------------
     * TENANT / USER CONTEXT QUERY
     * --------------------------------------------------------
     *
     * We deliberately execute contextual queries through the
     * transaction helper so app.tenant_id and app.user_id are
     * established on the SAME PostgreSQL connection that executes
     * the actual query.
     */
    return this.transaction(
      async (
        client,
      ) => {
        return client.query<T>(
          text,
          values,
        );
      },
      context,
    );
  }

  // ==========================================================
  // RAW CLIENT
  // ==========================================================

  /**
   * Return a raw pooled client.
   *
   * Existing code that explicitly manages its own client can
   * continue using this method.
   *
   * IMPORTANT:
   *
   * Tenant-scoped application work should prefer:
   *
   *   transaction(callback, context)
   *
   * so PostgreSQL RLS context is established safely on the same
   * connection.
   */
  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  private classifySqlOperation(statement: string): 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER' {
    const leading = statement.trimStart().match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
    if (leading === 'SELECT' || leading === 'INSERT' || leading === 'UPDATE' || leading === 'DELETE') return leading;
    return 'OTHER';
  }

  private recordDatabaseOperation(
    operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER' | 'TRANSACTION',
    status: 'success' | 'error',
    startedAt: number,
    startTimeUnixNano: string,
  ): void {
    const durationSeconds = Math.max(0, (performance.now() - startedAt) / 1000);
    this.metrics?.recordDatabaseOperation(operation, status, durationSeconds, {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    });
    const context = currentTraceContext();
    if (!context) return;
    this.traceExporter?.exportDatabaseOperation({
      context,
      operation,
      status,
      startTimeUnixNano,
      endTimeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(),
      durationMs: durationSeconds * 1000,
    });
  }

  // ==========================================================
  // TRANSACTION OVERLOADS
  // ==========================================================

  /**
   * Existing/original API:
   *
   * transaction(callback)
   */
  async transaction<T>(
    callback: TransactionCallback<T>,
  ): Promise<T>;

  /**
   * Preferred production API:
   *
   * transaction(callback, context)
   */
  async transaction<T>(
    callback: TransactionCallback<T>,
    context: DatabaseContext,
  ): Promise<T>;

  /**
   * Backward-compatible API:
   *
   * transaction(context, callback)
   *
   * This is intentionally supported because existing integration
   * tests and older call sites may still use the original context
   * first form.
   *
   * Supporting both forms prevents unnecessary breaking changes
   * while the codebase migrates to the canonical callback-first
   * form.
   */
  async transaction<T>(
    context: DatabaseContext,
    callback: TransactionCallback<T>,
  ): Promise<T>;

  // ==========================================================
  // TRANSACTION IMPLEMENTATION
  // ==========================================================

  async transaction<T>(
    first: TransactionCallback<T> | DatabaseContext,
    second?: TransactionCallback<T> | DatabaseContext,
  ): Promise<T> {
    const startedAt = performance.now();
    const startedAtUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();
    try {
      const result = await this.executeTransaction(first, second);
      this.recordDatabaseOperation('TRANSACTION', 'success', startedAt, startedAtUnixNano);
      return result;
    } catch (error) {
      this.recordDatabaseOperation('TRANSACTION', 'error', startedAt, startedAtUnixNano);
      throw error;
    }
  }

  private async executeTransaction<T>(
    first: TransactionCallback<T> | DatabaseContext,
    second?: TransactionCallback<T> | DatabaseContext,
  ): Promise<T> {
    let callback:
      | TransactionCallback<T>
      | null = null;

    let context:
      | DatabaseContext
      | undefined;

    /*
     * --------------------------------------------------------
     * FORM 1 / FORM 2
     * --------------------------------------------------------
     *
     * transaction(callback)
     * transaction(callback, context)
     */
    if (
      typeof first ===
      'function'
    ) {
      callback =
        first;

      if (
        second &&
        typeof second !==
          'function'
      ) {
        context =
          second;
      }
    }

    /*
     * --------------------------------------------------------
     * FORM 3
     * --------------------------------------------------------
     *
     * transaction(context, callback)
     *
     * Backward-compatible support for older tests/call sites.
     */
    else {
      context =
        first;

      if (
        typeof second ===
        'function'
      ) {
        callback =
          second;
      }
    }

    /*
     * Defensive runtime validation.
     *
     * This makes an invalid transaction invocation fail with an
     * explicit message instead of the much less useful:
     *
     *   callback is not a function
     */
    if (!callback) {
      throw new TypeError(
        'DatabaseService.transaction requires a callback function',
      );
    }

    const client =
      await this.pool.connect();
    let sessionAdvisoryLockAcquired = false;
    let destroyClientOnRelease = false;

    try {
      // Acquire request-specific advisory locks outside the transaction.
      // This keeps a waiting REPEATABLE READ transaction from pinning a
      // snapshot before the previous idempotent request has committed.
      const advisoryLockKey = context?.advisoryLockKey?.trim();
      if (advisoryLockKey) {
        await client.query(
          'SELECT pg_advisory_lock(hashtextextended($1, 0))',
          [advisoryLockKey],
        );
        sessionAdvisoryLockAcquired = true;
      }

      // --------------------------------------------------------
      // BEGIN
      // --------------------------------------------------------

      const isolationLevel = context?.isolationLevel;
      const beginStatement = isolationLevel
        ? `BEGIN ISOLATION LEVEL ${isolationLevel}`
        : 'BEGIN';

      await client.query(beginStatement);

      // --------------------------------------------------------
      // TRANSACTION-LOCAL RLS CONTEXT
      // --------------------------------------------------------

      const hasContext =
        context?.tenantId !==
          undefined ||
        context?.userId !==
          undefined;

      if (hasContext) {
        /*
         * set_config(..., true)
         *
         * TRUE makes both settings transaction-local.
         *
         * This is critical with pg.Pool because the physical
         * connection will later return to the pool and may be
         * reused by another tenant.
         */
        await client.query(
          `
          SELECT
            set_config(
              'app.tenant_id',
              $1,
              true
            ),

            set_config(
              'app.user_id',
              $2,
              true
            ),

            set_config(
              'app.request_id',
              $3,
              true
            ),

            set_config(
              'app.trace_id',
              $4,
              true
            )
          `,
          [
            context?.tenantId ??
              '',

            context?.userId ??
              '',

            context?.requestId ??
              '',

            context?.traceId ??
              '',
          ],
        );
      }

      // --------------------------------------------------------
      // EXECUTE CALLBACK
      // --------------------------------------------------------

      const result =
        await callback(
          client,
        );

      // --------------------------------------------------------
      // COMMIT
      // --------------------------------------------------------

      await client.query(
        'COMMIT',
      );

      return result;
    } catch (
      error
    ) {
      // ------------------------------------------------------
      // ROLLBACK
      // ------------------------------------------------------

      try {
        await client.query(
          'ROLLBACK',
        );
      } catch {
        /*
         * Do not replace the original business/database error
         * with a rollback error.
         */
      }

      throw error;
    } finally {
      if (sessionAdvisoryLockAcquired) {
        try {
          const unlock = await client.query<{ pg_advisory_unlock: boolean }>(
            'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
            [context?.advisoryLockKey?.trim()],
          );
          destroyClientOnRelease = unlock.rows[0]?.pg_advisory_unlock !== true;
        } catch {
          // Never return a connection holding a session advisory lock to the pool.
          destroyClientOnRelease = true;
        }
      }

      client.release(destroyClientOnRelease);
    }
  }
}