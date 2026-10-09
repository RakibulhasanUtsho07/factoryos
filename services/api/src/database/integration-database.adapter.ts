import {
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow,
} from 'pg';

import type {
  DatabaseContext,
} from './database.service';

type TransactionCallback<T> = (
  client: PoolClient,
) => Promise<T>;

/**
 * Integration-test PostgreSQL adapter.
 *
 * This intentionally mirrors the production DatabaseService
 * contract:
 *
 *   query(sql, values?, context?)
 *   transaction(callback, context?)
 *
 * It guarantees that tenant/user context is installed on the
 * SAME PostgreSQL connection used by the query/transaction.
 */
export class IntegrationDatabaseAdapter {
  constructor(
    private readonly pool: Pool,
  ) {}

  // ==========================================================
  // QUERY
  // ==========================================================

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
     * Global/control-plane query.
     */
    if (!hasContext) {
      return this.pool.query<T>(
        text,
        values,
      );
    }

    /*
     * Context-aware query.
     *
     * Run it inside a transaction so PostgreSQL RLS sees:
     *
     *   app.tenant_id
     *   app.user_id
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

  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  // ==========================================================
  // TRANSACTION OVERLOADS
  // ==========================================================

  async transaction<T>(
    callback: TransactionCallback<T>,
  ): Promise<T>;

  async transaction<T>(
    callback: TransactionCallback<T>,
    context: DatabaseContext,
  ): Promise<T>;

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
      | null =
      null;

    let context:
      | DatabaseContext
      | undefined;

    /*
     * Preferred:
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
     * Backward-compatible:
     *
     * transaction(context, callback)
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

    if (!callback) {
      throw new TypeError(
        'IntegrationDatabaseAdapter.transaction requires a callback function',
      );
    }

    const client =
      await this.pool.connect();

    try {
      await client.query(
        'BEGIN',
      );

      const hasContext =
        context?.tenantId !==
          undefined ||
        context?.userId !==
          undefined;

      if (hasContext) {
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

      const result =
        await callback(
          client,
        );

      await client.query(
        'COMMIT',
      );

      return result;
    } catch (
      error
    ) {
      try {
        await client.query(
          'ROLLBACK',
        );
      } catch {
        /*
         * Preserve original error.
         */
      }

      throw error;
    } finally {
      client.release();
    }
  }
}

export function createIntegrationDatabase(
  pool: Pool,
): IntegrationDatabaseAdapter {
  return new IntegrationDatabaseAdapter(
    pool,
  );
}