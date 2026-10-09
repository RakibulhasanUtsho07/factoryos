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
  'Outbox dispatcher restart/idempotency boundary',
  () => {
    let pool!: Pool;

    let appPool!: Pool;

    let orderId: string;

    let tenantId: string;

    let eventId: string;

    beforeAll(async () => {
      if (
        process.env
          .OUTBOX_TEST_FORCE_FAILURE ===
        'true'
      ) {
        throw new Error(
          'Disable OUTBOX_TEST_FORCE_FAILURE before running restart integration tests.',
        );
      }

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
          'No order available for restart integration test.',
        );
      }

      const selectedOrder =
        orderResult.rows[0];

      if (!selectedOrder) {
        throw new Error(
          'Restart integration test order row is missing.',
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

        WHERE
          o.id = $2
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
      'should retry after failure between consumer success and markPublished without duplicating the consumer effect',
      async () => {
        const database =
          createIntegrationDatabase(
            appPool,
          );

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

        const dispatcherInternal =
          dispatcher as unknown as {
            markPublished: (
              eventId: string,
              tenantId: string,
            ) => Promise<void>;
          };

        const originalMarkPublished =
          dispatcherInternal.markPublished.bind(
            dispatcher,
          );

        let injectedFailure =
          true;

        dispatcherInternal.markPublished =
          async (
            currentEventId: string,
            currentTenantId: string,
          ) => {
            if (injectedFailure) {
              injectedFailure =
                false;

              throw new Error(
                'TEST_CRASH_BEFORE_MARK_PUBLISHED',
              );
            }

            await originalMarkPublished(
              currentEventId,
              currentTenantId,
            );
          };

        // ------------------------------------------------------
        // Attempt 1:
        // publisher succeeds
        // consumer succeeds
        // markPublished fails
        // dispatcher must move event to FAILED
        // ------------------------------------------------------

        const firstResult =
          await dispatcher.dispatchOnce();

        expect(
          firstResult.claimed,
        ).toBe(1);

        expect(
          firstResult.published,
        ).toBe(0);

        expect(
          firstResult.failed,
        ).toBe(1);

        const firstOutboxResult =
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
            [
              eventId,
            ],
          );

        expect(
          firstOutboxResult.rowCount,
        ).toBe(1);

        expect(
          firstOutboxResult.rows[0]
            .status,
        ).toBe('FAILED');

        expect(
          Number(
            firstOutboxResult.rows[0]
              .attempts,
          ),
        ).toBe(1);

        expect(
          firstOutboxResult.rows[0]
            .published_at,
        ).toBeNull();

        expect(
          firstOutboxResult.rows[0]
            .last_error,
        ).toContain(
          'TEST_CRASH_BEFORE_MARK_PUBLISHED',
        );

        const firstInboxResult =
          await pool.query(
            `
            SELECT
              COUNT(*)::int AS count

            FROM inbox_events

            WHERE
              event_id = $1
              AND consumer_name =
                'order-created-projection-v1'
            `,
            [
              eventId,
            ],
          );

        expect(
          firstInboxResult.rows[0]
            .count,
        ).toBe(1);

        const firstProjectionResult =
          await pool.query(
            `
            SELECT
              COUNT(*)::int AS count

            FROM order_event_projections

            WHERE
              event_id = $1
            `,
            [
              eventId,
            ],
          );

        expect(
          firstProjectionResult.rows[0]
            .count,
        ).toBe(1);

        // ------------------------------------------------------
        // Make retry immediately eligible rather than waiting
        // 5 seconds.
        // ------------------------------------------------------

        await pool.query(
          `
          UPDATE outbox_events

          SET
            next_attempt_at = now()

          WHERE
            id = $1
          `,
          [
            eventId,
          ],
        );

        // ------------------------------------------------------
        // Attempt 2:
        // event is retried
        // Inbox detects duplicate
        // projection remains exactly one row
        // outbox becomes PUBLISHED
        // ------------------------------------------------------

        const secondResult =
          await dispatcher.dispatchOnce();

        expect(
          secondResult.claimed,
        ).toBe(1);

        expect(
          secondResult.published,
        ).toBe(1);

        expect(
          secondResult.failed,
        ).toBe(0);

        const secondOutboxResult =
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
            [
              eventId,
            ],
          );

        expect(
          secondOutboxResult.rowCount,
        ).toBe(1);

        expect(
          secondOutboxResult.rows[0]
            .status,
        ).toBe('PUBLISHED');

        expect(
          Number(
            secondOutboxResult.rows[0]
              .attempts,
          ),
        ).toBe(2);

        expect(
          secondOutboxResult.rows[0]
            .published_at,
        ).toBeTruthy();

        expect(
          secondOutboxResult.rows[0]
            .last_error,
        ).toBeNull();

        const finalInboxResult =
          await pool.query(
            `
            SELECT
              COUNT(*)::int AS count,
              MIN(processed_at)
                AS processed_at

            FROM inbox_events

            WHERE
              event_id = $1
              AND consumer_name =
                'order-created-projection-v1'
            `,
            [
              eventId,
            ],
          );

        expect(
          finalInboxResult.rows[0]
            .count,
        ).toBe(1);

        expect(
          finalInboxResult.rows[0]
            .processed_at,
        ).toBeTruthy();

        const finalProjectionResult =
          await pool.query(
            `
            SELECT
              COUNT(*)::int AS count,
              MIN(order_id::text)
                AS order_id

            FROM order_event_projections

            WHERE
              event_id = $1
            `,
            [
              eventId,
            ],
          );

        expect(
          finalProjectionResult.rows[0]
            .count,
        ).toBe(1);

        expect(
          finalProjectionResult.rows[0]
            .order_id,
        ).toBe(orderId);
      },
    );
  },
);