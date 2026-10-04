import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { InboxService } from './inbox.service';

import {
  OrderCreatedConsumer,
} from './order-created.consumer';

import {
  OutboxConsumerRegistry,
} from './outbox.consumer.registry';

import {
  OutboxDispatcherService,
} from './outbox.dispatcher.service';

import {
  OutboxEvent,
  OutboxPublisher,
} from './outbox.publisher';

describe(
  'ORDER.CREATED outbox pipeline',
  () => {
    const runId =
      randomUUID();

    let pool: Pool;

    let orderId: string;
    let tenantId: string;
    let eventId: string;

    async function transaction<T>(
      callback: (
        client: import('pg').PoolClient,
      ) => Promise<T>,
    ): Promise<T> {
      const client =
        await pool.connect();

      try {
        await client.query(
          'BEGIN',
        );

        const result =
          await callback(client);

        await client.query(
          'COMMIT',
        );

        return result;
      } catch (error) {
        await client.query(
          'ROLLBACK',
        );

        throw error;
      } finally {
        client.release();
      }
    }

    beforeAll(async () => {
      if (
        process.env
          .OUTBOX_TEST_FORCE_FAILURE ===
        'true'
      ) {
        throw new Error(
          'Disable OUTBOX_TEST_FORCE_FAILURE before running pipeline integration tests.',
        );
      }

      const databaseUrl =
        process.env.DATABASE_URL;

      if (!databaseUrl) {
        throw new Error(
          'DATABASE_URL is required.',
        );
      }

      pool = new Pool({
        connectionString:
          databaseUrl,
      });

      const orderResult =
        await pool.query(
          `
          SELECT
            id::text AS id,
            tenant_id::text AS tenant_id
          FROM orders
          ORDER BY created_at DESC
          LIMIT 1
          `,
        );

      if (
        orderResult.rowCount !== 1
      ) {
        throw new Error(
          'No order available for pipeline integration test.',
        );
      }

      orderId =
        orderResult.rows[0].id;

      tenantId =
        orderResult.rows[0]
          .tenant_id;

      eventId =
        randomUUID();

      await pool.query(
        `
        INSERT INTO outbox_events (
          id,
          tenant_id,
          factory_id,
          aggregate_type,
          aggregate_id,
          event_type,
          event_version,
          payload,
          status,
          attempts,
          next_attempt_at
        )

        SELECT
          $1,
          o.tenant_id,
          o.factory_id,
          'ORDER',
          o.id,
          'ORDER.CREATED',
          1,

          jsonb_build_object(
            'order',
            jsonb_build_object(
              'id',
              o.id,

              'tenant_id',
              o.tenant_id,

              'factory_id',
              o.factory_id,

              'order_number',
              o.order_number,

              'status',
              o.status
            )
          ),

          'PENDING',
          0,
          now()

        FROM orders o

        WHERE o.id = $2
          AND o.tenant_id = $3
        `,
        [
          eventId,
          orderId,
          tenantId,
        ],
      );
    });

    afterAll(async () => {
      if (!pool) {
        return;
      }

      await pool.query(
        `
        DELETE FROM inbox_events
        WHERE event_id = $1
        `,
        [eventId],
      );

      await pool.query(
        `
        DELETE FROM order_event_projections
        WHERE event_id = $1
        `,
        [eventId],
      );

      await pool.query(
        `
        DELETE FROM outbox_events
        WHERE id = $1
        `,
        [eventId],
      );

      await pool.end();
    });

    it(
      'should publish and consume ORDER.CREATED exactly once',
      async () => {
        const database = {
          transaction,
          query:
            pool.query.bind(pool),
        };

        const inboxService =
          new InboxService(
            database as never,
          );

        const orderConsumer =
          new OrderCreatedConsumer(
            inboxService,
          );

        const registry =
          new OutboxConsumerRegistry(
            orderConsumer,
          );

        const publisher =
          new OutboxPublisher();

        const dispatcher =
          new OutboxDispatcherService(
            database as never,
            publisher,
            registry,
          );

        const result =
          await dispatcher.dispatchOnce();

        expect(
          result.claimed,
        ).toBeGreaterThanOrEqual(1);

        const outboxResult =
          await pool.query(
            `
            SELECT
              status,
              attempts,
              published_at,
              last_error

            FROM outbox_events

            WHERE id = $1
            `,
            [eventId],
          );

        expect(
          outboxResult.rowCount,
        ).toBe(1);

        expect(
          outboxResult.rows[0]
            .status,
        ).toBe('PUBLISHED');

        expect(
          Number(
            outboxResult.rows[0]
              .attempts,
          ),
        ).toBe(1);

        expect(
          outboxResult.rows[0]
            .published_at,
        ).toBeTruthy();

        expect(
          outboxResult.rows[0]
            .last_error,
        ).toBeNull();

        const inboxResult =
          await pool.query(
            `
            SELECT
              consumer_name,
              event_id,
              processed_at

            FROM inbox_events

            WHERE event_id = $1
            `,
            [eventId],
          );

        expect(
          inboxResult.rowCount,
        ).toBe(1);

        expect(
          inboxResult.rows[0]
            .consumer_name,
        ).toBe(
          'order-created-projection-v1',
        );

        expect(
          inboxResult.rows[0]
            .processed_at,
        ).toBeTruthy();

        const projectionResult =
          await pool.query(
            `
            SELECT
              event_id,
              order_id,
              tenant_id,
              factory_id,
              order_number,
              status,
              event_version

            FROM order_event_projections

            WHERE event_id = $1
            `,
            [eventId],
          );

        expect(
          projectionResult.rowCount,
        ).toBe(1);

        expect(
          projectionResult.rows[0]
            .event_id,
        ).toBe(eventId);

        expect(
          projectionResult.rows[0]
            .order_id,
        ).toBe(orderId);

        expect(
          projectionResult.rows[0]
            .tenant_id,
        ).toBe(tenantId);

        expect(
          projectionResult.rows[0]
            .order_number,
        ).toBeTruthy();

        expect(
          projectionResult.rows[0]
            .event_version,
        ).toBe(1);
      },
    );

    it(
      'should skip a duplicate ORDER.CREATED delivery',
      async () => {
        const database = {
          transaction,
          query:
            pool.query.bind(pool),
        };

        const inboxService =
          new InboxService(
            database as never,
          );

        const orderConsumer =
          new OrderCreatedConsumer(
            inboxService,
          );

        const eventResult =
          await pool.query(
            `
            SELECT
              id::text AS id,
              tenant_id::text AS tenant_id,
              factory_id::text AS factory_id,
              aggregate_type,
              aggregate_id::text AS aggregate_id,
              event_type,
              event_version,
              payload

            FROM outbox_events

            WHERE id = $1
            `,
            [eventId],
          );

        expect(
          eventResult.rowCount,
        ).toBe(1);

        const row =
          eventResult.rows[0];

        const event: OutboxEvent = {
          id: row.id,

          tenantId:
            row.tenant_id,

          factoryId:
            row.factory_id,

          aggregateType:
            row.aggregate_type,

          aggregateId:
            row.aggregate_id,

          eventType:
            row.event_type,

          eventVersion:
            row.event_version,

          payload:
            row.payload,
        };

        const result =
          await orderConsumer.consume(
            event,
          );

        expect(
          result.duplicate,
        ).toBe(true);

        expect(
          result.result,
        ).toBeNull();

        const inboxResult =
          await pool.query(
            `
            SELECT
              COUNT(*)::int AS count

            FROM inbox_events

            WHERE event_id = $1
              AND consumer_name =
                'order-created-projection-v1'
            `,
            [eventId],
          );

        expect(
          inboxResult.rows[0]
            .count,
        ).toBe(1);

        const projectionResult =
          await pool.query(
            `
            SELECT
              COUNT(*)::int AS count

            FROM order_event_projections

            WHERE event_id = $1
            `,
            [eventId],
          );

        expect(
          projectionResult.rows[0]
            .count,
        ).toBe(1);
      },
    );
  },
);