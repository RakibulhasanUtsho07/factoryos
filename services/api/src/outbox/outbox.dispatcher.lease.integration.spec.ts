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
  OutboxPublisher,
} from './outbox.publisher';

import {
  createIntegrationDatabase,
} from '../database/integration-database.adapter';

describe(
  'Outbox dispatcher stale lease recovery',
  () => {
    const runId =
      randomUUID();

    let pool!: Pool;

    let appPool!: Pool;

    let eventId: string;
    let orderId: string;
    let tenantId: string;

    beforeAll(async () => {
      const databaseUrl =
        process.env.DATABASE_URL;

      const testAdminDatabaseUrl =
        process.env.TEST_ADMIN_DATABASE_URL;

      if (!databaseUrl) {
        throw new Error(
          'DATABASE_URL is required.',
        );
      }

      if (!testAdminDatabaseUrl) {
        throw new Error(
          'TEST_ADMIN_DATABASE_URL is required.',
        );
      }

      pool =
        new Pool({
          connectionString:
            testAdminDatabaseUrl,
        });

      appPool =
        new Pool({
          connectionString:
            databaseUrl,
        });

      const orderResult =
        await pool.query<{
          id: string;
          tenant_id: string;
        }>(
          `
          SELECT
            id::text AS id,
            tenant_id::text AS tenant_id

          FROM orders

          ORDER BY
            created_at DESC

          LIMIT 1
          `,
        );

      if (
        orderResult.rowCount !== 1
      ) {
        throw new Error(
          'No order available for stale lease test.',
        );
      }

      const selectedOrder =
        orderResult.rows[0];

      if (!selectedOrder) {
        throw new Error(
          'Stale lease test order row is missing.',
        );
      }

      orderId =
        selectedOrder.id;

      tenantId =
        selectedOrder.tenant_id;

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
          locked_at,
          locked_by,
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

          'PROCESSING',
          3,

          now() -
            interval '2 minutes',

          'api-outbox-dead-worker-test',

          now() +
            interval '5 minutes'

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
      if (pool) {
        await pool.query(
          `
          DELETE FROM inbox_events
          WHERE event_id = $1
          `,
          [
            eventId,
          ],
        );

        await pool.query(
          `
          DELETE FROM order_event_projections
          WHERE event_id = $1
          `,
          [
            eventId,
          ],
        );

        await pool.query(
          `
          DELETE FROM outbox_events
          WHERE id = $1
          `,
          [
            eventId,
          ],
        );

        await pool.end();
      }

      if (appPool) {
        await appPool.end();
      }
    });

    it(
      'should reclaim a stale PROCESSING event based on locked_at',
      async () => {
        const database =
          createIntegrationDatabase(
            appPool,
          );

        const inboxService =
          new InboxService(
            database as never,
          );

        const consumer =
          new OrderCreatedConsumer(
            inboxService,
          );

        const registry =
          new OutboxConsumerRegistry(
            consumer,
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
              locked_at,
              locked_by,
              next_attempt_at,
              published_at,
              last_error

            FROM outbox_events

            WHERE id = $1
            `,
            [
              eventId,
            ],
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
        ).toBe(4);

        expect(
          outboxResult.rows[0]
            .locked_at,
        ).toBeNull();

        expect(
          outboxResult.rows[0]
            .locked_by,
        ).toBeNull();

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
              COUNT(*)::int AS count

            FROM inbox_events

            WHERE event_id = $1
              AND consumer_name =
                'order-created-projection-v1'
            `,
            [
              eventId,
            ],
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
            [
              eventId,
            ],
          );

        expect(
          projectionResult.rows[0]
            .count,
        ).toBe(1);
      },
    );
  },
);