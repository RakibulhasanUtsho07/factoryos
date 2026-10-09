import {
  Injectable,
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
    private readonly configService:
      ConfigService,
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
      return this.pool.query<T>(
        text,
        values,
      );
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
    first:
      | TransactionCallback<T>
      | DatabaseContext,

    second?:
      | TransactionCallback<T>
      | DatabaseContext,
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

    try {
      // --------------------------------------------------------
      // BEGIN
      // --------------------------------------------------------

      await client.query(
        'BEGIN',
      );

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
            )
          `,
          [
            context?.tenantId ??
              '',

            context?.userId ??
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
      /*
       * Always return the connection to pg.Pool.
       */
      client.release();
    }
  }
}