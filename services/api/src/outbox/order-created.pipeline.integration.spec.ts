import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { InboxService } from './inbox.service';

import {
  OrderCreatedConsumer,
} from './order-created.consumer';

import {
  createIntegrationDatabase,
} from '../database/integration-database.adapter';

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

    const TEST_USER_ID =
      '921382b8-e83f-43ab-a576-e3db6a06b70c';

    let pool!: Pool;

    let appPool!: Pool;

    let orderId!: string;
    let tenantId!: string;
    let factoryId!: string;
    let orderNumber!: string;
    let eventId!: string;

    async function createDispatcher() {
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

      return new OutboxDispatcherService(
        database as never,
        publisher,
        registry,
      );
    }

    async function dispatchUntilPublished(
      targetEventId: string,
      maxAttempts = 10,
    ): Promise<void> {
      for (
        let attempt = 0;
        attempt < maxAttempts;
        attempt += 1
      ) {
        const current =
          await pool.query<{
            status: string;
          }>(
            `
            SELECT
              status

            FROM outbox_events

            WHERE
              id = $1
            `,
            [
              targetEventId,
            ],
          );

        if (
          current.rowCount === 1 &&
          current.rows[0]?.status ===
            'PUBLISHED'
        ) {
          return;
        }

        const dispatcher =
          await createDispatcher();

        await dispatcher.dispatchOnce();
      }

      throw new Error(
        `ORDER.CREATED test event was not published after ${maxAttempts} dispatcher attempts: ${targetEventId}`,
      );
    }

    beforeAll(async () => {
      // --------------------------------------------------------
      // Test-only failure injection must be disabled.
      // --------------------------------------------------------

      if (
        process.env
          .OUTBOX_TEST_FORCE_FAILURE ===
        'true'
      ) {
        throw new Error(
          'Disable OUTBOX_TEST_FORCE_FAILURE before running pipeline integration tests.',
        );
      }

      // --------------------------------------------------------
      // Database configuration.
      // --------------------------------------------------------

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

      /*
       * Admin fixture pool.
       */
      pool =
        new Pool({
          connectionString:
            testAdminDatabaseUrl,
        });

      /*
       * Runtime/application pool.
       */
      appPool =
        new Pool({
          connectionString:
            databaseUrl,
        });

      // --------------------------------------------------------
      // Verify test actor.
      // --------------------------------------------------------

      const userResult =
        await pool.query<{
          id: string;
        }>(
          `
          SELECT
            id::text AS id

          FROM users

          WHERE
            id = $1
            AND status = 'ACTIVE'

          LIMIT 1
          `,
          [
            TEST_USER_ID,
          ],
        );

      if (
        userResult.rowCount !== 1
      ) {
        throw new Error(
          `Test user does not exist or is inactive: ${TEST_USER_ID}`,
        );
      }

      // --------------------------------------------------------
      // IMPORTANT:
      // orderNumber is declared at describe scope and assigned
      // here, so it is available in all test cases.
      // --------------------------------------------------------

      orderNumber =
        `OUTBOX-PROJECTION-TEST-${runId}`;

      // --------------------------------------------------------
      // Create isolated DRAFT order.
      // --------------------------------------------------------

      const orderResult =
        await pool.query<{
          id: string;
          tenant_id: string;
          factory_id: string;
        }>(
          `
          INSERT INTO orders (
            tenant_id,
            factory_id,
            order_number,
            customer_name,
            status,
            order_date,
            currency,
            created_by_user_id
          )

          SELECT
            t.id,
            f.id,
            $1,
            'ORDER.CREATED Projection Test',
            'DRAFT',
            CURRENT_DATE,
            'BDT',
            u.id

          FROM tenants t

          INNER JOIN factories f
            ON f.tenant_id = t.id

          INNER JOIN users u
            ON u.id = $2

          WHERE
            t.status = 'ACTIVE'
            AND f.status = 'ACTIVE'
            AND u.status = 'ACTIVE'

          ORDER BY
            t.created_at ASC,
            f.created_at ASC

          LIMIT 1

          RETURNING
            id::text AS id,
            tenant_id::text AS tenant_id,
            factory_id::text AS factory_id
          `,
          [
            orderNumber,
            TEST_USER_ID,
          ],
        );

      if (
        orderResult.rowCount !== 1
      ) {
        throw new Error(
          'Could not create isolated ORDER.CREATED pipeline test order.',
        );
      }

      const createdOrder =
        orderResult.rows[0];

      if (!createdOrder) {
        throw new Error(
          'Created order row is missing.',
        );
      }

      orderId =
        createdOrder.id;

      tenantId =
        createdOrder.tenant_id;

      factoryId =
        createdOrder.factory_id;

      eventId =
        randomUUID();

      // --------------------------------------------------------
      // Persist immutable ORDER.CREATED event.
      //
      // Event snapshot = DRAFT.
      // --------------------------------------------------------

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

        VALUES (
          $1,
          $2,
          $3,
          'ORDER',
          $4,
          'ORDER.CREATED',
          1,
          $5::jsonb,
          'PENDING',
          0,
          now()
        )
        `,
        [
          eventId,
          tenantId,
          factoryId,
          orderId,
          JSON.stringify({
            order: {
              id:
                orderId,

              tenant_id:
                tenantId,

              factory_id:
                factoryId,

              order_number:
                orderNumber,

              status:
                'DRAFT',
            },
          }),
        ],
      );

      // --------------------------------------------------------
      // Regression setup:
      //
      // Event already contains historical DRAFT snapshot.
      // Current aggregate then moves to COMPLETED.
      // --------------------------------------------------------

      const updateResult =
        await pool.query(
          `
          UPDATE orders

          SET
            status = 'COMPLETED'

          WHERE
            id = $1
            AND tenant_id = $2
          `,
          [
            orderId,
            tenantId,
          ],
        );

      if (
        updateResult.rowCount !== 1
      ) {
        throw new Error(
          'Could not move test order to COMPLETED.',
        );
      }

      // --------------------------------------------------------
      // Verify test setup.
      // --------------------------------------------------------

      const setupResult =
        await pool.query<{
          order_status: string;
          payload_status:
            | string
            | null;
          payload_order_number:
            | string
            | null;
        }>(
          `
          SELECT
            o.status AS order_status,

            oe.payload->'order'->>'status'
              AS payload_status,

            oe.payload->'order'->>'order_number'
              AS payload_order_number

          FROM orders o

          INNER JOIN outbox_events oe
            ON oe.aggregate_id = o.id

          WHERE
            o.id = $1
            AND oe.id = $2
            AND o.tenant_id = $3
          `,
          [
            orderId,
            eventId,
            tenantId,
          ],
        );

      expect(
        setupResult.rowCount,
      ).toBe(1);

      const setup =
        setupResult.rows[0];

      if (!setup) {
        throw new Error(
          'Regression setup row is missing.',
        );
      }

      expect(
        setup.order_status,
      ).toBe('COMPLETED');

      expect(
        setup.payload_status,
      ).toBe('DRAFT');

      expect(
        setup.payload_order_number,
      ).toBe(orderNumber);
    });

    afterAll(async () => {
      if (pool) {
        // ------------------------------------------------------
        // Delete inbox first.
        // ------------------------------------------------------

        if (eventId) {
          await pool.query(
            `
            DELETE FROM inbox_events

            WHERE
              event_id = $1
            `,
            [
              eventId,
            ],
          );

          // ----------------------------------------------------
          // Delete projection.
          // ----------------------------------------------------

          await pool.query(
            `
            DELETE FROM order_event_projections

            WHERE
              event_id = $1
            `,
            [
              eventId,
            ],
          );

          // ----------------------------------------------------
          // Delete outbox event.
          // ----------------------------------------------------

          await pool.query(
            `
            DELETE FROM outbox_events

            WHERE
              id = $1
            `,
            [
              eventId,
            ],
          );
        }

        // ------------------------------------------------------
        // Delete isolated order.
        // ------------------------------------------------------

        if (orderId) {
          await pool.query(
            `
            DELETE FROM orders

            WHERE
              id = $1
            `,
            [
              orderId,
            ],
          );
        }

        await pool.end();
      }

      if (appPool) {
        await appPool.end();
      }
    });

    it(
      'should publish and consume ORDER.CREATED using the immutable event snapshot',
      async () => {
        await dispatchUntilPublished(
          eventId,
        );

        // ------------------------------------------------------
        // Verify outbox.
        // ------------------------------------------------------

        const outboxResult =
          await pool.query<{
            status: string;
            attempts: number;
            published_at:
              | string
              | null;
            last_error:
              | string
              | null;
            payload_status:
              | string
              | null;
            payload_order_number:
              | string
              | null;
          }>(
            `
            SELECT
              status,
              attempts,
              published_at,
              last_error,

              payload->'order'->>'status'
                AS payload_status,

              payload->'order'->>'order_number'
                AS payload_order_number

            FROM outbox_events

            WHERE
              id = $1
            `,
            [
              eventId,
            ],
          );

        expect(
          outboxResult.rowCount,
        ).toBe(1);

        const outbox =
          outboxResult.rows[0];

        if (!outbox) {
          throw new Error(
            'Outbox test event row is missing.',
          );
        }

        expect(
          outbox.status,
        ).toBe('PUBLISHED');

        expect(
          Number(
            outbox.attempts,
          ),
        ).toBe(1);

        expect(
          outbox.published_at,
        ).toBeTruthy();

        expect(
          outbox.last_error,
        ).toBeNull();

        expect(
          outbox.payload_status,
        ).toBe('DRAFT');

        expect(
          outbox.payload_order_number,
        ).toBe(orderNumber);

        // ------------------------------------------------------
        // Verify current aggregate is COMPLETED.
        // ------------------------------------------------------

        const orderResult =
          await pool.query<{
            status: string;
          }>(
            `
            SELECT
              status

            FROM orders

            WHERE
              id = $1
              AND tenant_id = $2
            `,
            [
              orderId,
              tenantId,
            ],
          );

        expect(
          orderResult.rowCount,
        ).toBe(1);

        const currentOrder =
          orderResult.rows[0];

        if (!currentOrder) {
          throw new Error(
            'Current order row is missing.',
          );
        }

        expect(
          currentOrder.status,
        ).toBe('COMPLETED');

        // ------------------------------------------------------
        // Verify inbox exactly once.
        // ------------------------------------------------------

        const inboxResult =
          await pool.query<{
            consumer_name: string;
            event_id: string;
            processed_at:
              | string
              | null;
          }>(
            `
            SELECT
              consumer_name,
              event_id,
              processed_at

            FROM inbox_events

            WHERE
              event_id = $1
            `,
            [
              eventId,
            ],
          );

        expect(
          inboxResult.rowCount,
        ).toBe(1);

        const inbox =
          inboxResult.rows[0];

        if (!inbox) {
          throw new Error(
            'Inbox row is missing.',
          );
        }

        expect(
          inbox.consumer_name,
        ).toBe(
          'order-created-projection-v1',
        );

        expect(
          inbox.event_id,
        ).toBe(eventId);

        expect(
          inbox.processed_at,
        ).toBeTruthy();

        // ------------------------------------------------------
        // Verify projection.
        // ------------------------------------------------------

        const projectionResult =
          await pool.query<{
            event_id: string;
            order_id: string;
            tenant_id: string;
            factory_id: string;
            order_number: string;
            status: string;
            event_version: number;
          }>(
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

            WHERE
              event_id = $1
            `,
            [
              eventId,
            ],
          );

        expect(
          projectionResult.rowCount,
        ).toBe(1);

        const projection =
          projectionResult.rows[0];

        if (!projection) {
          throw new Error(
            'Projection row is missing.',
          );
        }

        expect(
          projection.event_id,
        ).toBe(eventId);

        expect(
          projection.order_id,
        ).toBe(orderId);

        expect(
          projection.tenant_id,
        ).toBe(tenantId);

        expect(
          projection.factory_id,
        ).toBe(factoryId);

        expect(
          projection.order_number,
        ).toBe(orderNumber);

        // ------------------------------------------------------
        // Critical regression assertion.
        //
        // Current aggregate = COMPLETED
        // Historical event = DRAFT
        // Projection = DRAFT
        // ------------------------------------------------------

        expect(
          projection.status,
        ).toBe('DRAFT');

        expect(
          projection.status,
        ).not.toBe(
          currentOrder.status,
        );

        expect(
          Number(
            projection.event_version,
          ),
        ).toBe(1);
      },
    );

    it(
      'should skip a duplicate ORDER.CREATED delivery',
      async () => {
        // ------------------------------------------------------
        // Read exact persisted event.
        // ------------------------------------------------------

        const eventResult =
          await pool.query<{
            id: string;
            tenant_id: string;
            factory_id:
              | string
              | null;
            aggregate_type: string;
            aggregate_id: string;
            event_type: string;
            event_version: number;
            payload: Record<
              string,
              unknown
            >;
          }>(
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

            WHERE
              id = $1
            `,
            [
              eventId,
            ],
          );

        expect(
          eventResult.rowCount,
        ).toBe(1);

        const row =
          eventResult.rows[0];

        if (!row) {
          throw new Error(
            'Outbox event row is missing.',
          );
        }

        const event: OutboxEvent = {
          id:
            row.id,

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

        // ------------------------------------------------------
        // Deliver same event again.
        // ------------------------------------------------------

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

        // ------------------------------------------------------
        // Inbox remains exactly once.
        // ------------------------------------------------------

        const inboxCountResult =
          await pool.query<{
            count: number;
          }>(
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
          inboxCountResult.rowCount,
        ).toBe(1);

        expect(
          Number(
            inboxCountResult.rows[0]
              ?.count ?? 0,
          ),
        ).toBe(1);

        // ------------------------------------------------------
        // Projection remains exactly once.
        // ------------------------------------------------------

        const projectionCountResult =
          await pool.query<{
            count: number;
          }>(
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
          projectionCountResult.rowCount,
        ).toBe(1);

        expect(
          Number(
            projectionCountResult.rows[0]
              ?.count ?? 0,
          ),
        ).toBe(1);

        // ------------------------------------------------------
        // Duplicate delivery must not change snapshot.
        // ------------------------------------------------------

        const projectionStatusResult =
          await pool.query<{
            status: string;
          }>(
            `
            SELECT
              status

            FROM order_event_projections

            WHERE
              event_id = $1
            `,
            [
              eventId,
            ],
          );

        expect(
          projectionStatusResult.rowCount,
        ).toBe(1);

        expect(
          projectionStatusResult.rows[0]
            ?.status,
        ).toBe('DRAFT');
      },
    );
  },
);