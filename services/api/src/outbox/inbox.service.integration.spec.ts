import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';

import { InboxService } from './inbox.service';

type TestDatabase = {
  transaction<T>(
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T>;
};

type EventRow = {
  id: string;
  tenant_id: string;
};

describe('InboxService PostgreSQL integration', () => {
  const runId = randomUUID();

  let pool: Pool;
  let service: InboxService;
  let event: EventRow;
  let secondTenantId: string;

  const businessTable = 'inbox_integration_business_effects';

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL is required to run InboxService PostgreSQL integration tests.',
      );
    }

    pool = new Pool({
      connectionString: databaseUrl,
    });

    const database: TestDatabase = {
      async transaction<T>(
        callback: (client: PoolClient) => Promise<T>,
      ): Promise<T> {
        const client = await pool.connect();

        try {
          await client.query('BEGIN');

          const result = await callback(client);

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

    service = new InboxService(database as never);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${businessTable} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id UUID NOT NULL,
        marker VARCHAR(100) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await pool.query(
      `
        DELETE FROM ${businessTable}
        WHERE run_id = $1
      `,
      [runId],
    );

    const eventResult = await pool.query<EventRow>(
      `
        SELECT
          id,
          tenant_id
        FROM outbox_events
        WHERE status = 'PUBLISHED'
        ORDER BY created_at DESC
        LIMIT 1
      `,
    );

    if (eventResult.rowCount !== 1) {
      throw new Error(
        'No PUBLISHED outbox event exists for integration testing.',
      );
    }

    event = eventResult.rows[0];

    /*
     * Temporary second tenant used only for the cross-tenant
     * foreign-key isolation test.
     */
    secondTenantId = randomUUID();

    await pool.query(
      `
        INSERT INTO tenants (
          id,
          slug,
          name,
          status,
          timezone,
          default_locale
        )
        VALUES (
          $1,
          $2,
          $3,
          'ACTIVE',
          'Asia/Dhaka',
          'en-BD'
        )
      `,
      [
        secondTenantId,
        `inbox-test-${runId}`,
        'Inbox Integration Test Tenant',
      ],
    );
  });

  afterAll(async () => {
    if (!pool) {
      return;
    }

    await pool.query(
      `
        DELETE FROM ${businessTable}
        WHERE run_id = $1
      `,
      [runId],
    );

    await pool.query(
      `
        DELETE FROM tenants
        WHERE id = $1
      `,
      [secondTenantId],
    );

    await pool.end();
  });

  it('should persist inbox event and business side effect on first delivery', async () => {
    const consumerName = `integration-first-${runId}`;

    const result = await service.executeOnce(
      event.tenant_id,
      consumerName,
      event.id,
      async (client) => {
        await client.query(
          `
            INSERT INTO ${businessTable} (
              run_id,
              marker
            )
            VALUES ($1, $2)
          `,
          [runId, 'first-delivery'],
        );

        return {
          processed: true,
        };
      },
    );

    expect(result).toEqual({
      duplicate: false,
      result: {
        processed: true,
      },
    });

    const inboxResult = await pool.query(
      `
        SELECT
          consumer_name,
          event_id,
          processed_at
        FROM inbox_events
        WHERE consumer_name = $1
          AND event_id = $2
      `,
      [consumerName, event.id],
    );

    expect(inboxResult.rowCount).toBe(1);
    expect(inboxResult.rows[0].processed_at).toBeTruthy();

    const businessResult = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM ${businessTable}
        WHERE run_id = $1
          AND marker = $2
      `,
      [runId, 'first-delivery'],
    );

    expect(businessResult.rows[0].count).toBe(1);
  });

  it('should skip duplicate delivery and execute the handler zero times', async () => {
    const consumerName = `integration-first-${runId}`;

    let handlerCalls = 0;

    const result = await service.executeOnce(
      event.tenant_id,
      consumerName,
      event.id,
      async () => {
        handlerCalls += 1;

        return {
          processed: true,
        };
      },
    );

    expect(result).toEqual({
      duplicate: true,
      result: null,
    });

    expect(handlerCalls).toBe(0);

    const inboxResult = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM inbox_events
        WHERE consumer_name = $1
          AND event_id = $2
      `,
      [consumerName, event.id],
    );

    expect(inboxResult.rows[0].count).toBe(1);

    const businessResult = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM ${businessTable}
        WHERE run_id = $1
          AND marker = $2
      `,
      [runId, 'first-delivery'],
    );

    expect(businessResult.rows[0].count).toBe(1);
  });

  it('should rollback inbox and business side effect when the handler fails', async () => {
    const consumerName = `integration-failure-${runId}`;

    await expect(
      service.executeOnce(
        event.tenant_id,
        consumerName,
        event.id,
        async (client) => {
          await client.query(
            `
              INSERT INTO ${businessTable} (
                run_id,
                marker
              )
              VALUES ($1, $2)
            `,
            [runId, 'failed-delivery'],
          );

          throw new Error('INTEGRATION_HANDLER_FAILED');
        },
      ),
    ).rejects.toThrow('INTEGRATION_HANDLER_FAILED');

    const inboxResult = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM inbox_events
        WHERE consumer_name = $1
          AND event_id = $2
      `,
      [consumerName, event.id],
    );

    expect(inboxResult.rows[0].count).toBe(0);

    const businessResult = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM ${businessTable}
        WHERE run_id = $1
          AND marker = $2
      `,
      [runId, 'failed-delivery'],
    );

    expect(businessResult.rows[0].count).toBe(0);
  });

  it('should reject cross-tenant event binding and execute no handler', async () => {
    const consumerName = `integration-cross-tenant-${runId}`;

    let handlerCalls = 0;

    await expect(
      service.executeOnce(
        secondTenantId,
        consumerName,
        event.id,
        async () => {
          handlerCalls += 1;

          return {
            processed: true,
          };
        },
      ),
    ).rejects.toThrow();

    expect(handlerCalls).toBe(0);

    const inboxResult = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM inbox_events
        WHERE consumer_name = $1
          AND event_id = $2
      `,
      [consumerName, event.id],
    );

    expect(inboxResult.rows[0].count).toBe(0);
  });
});