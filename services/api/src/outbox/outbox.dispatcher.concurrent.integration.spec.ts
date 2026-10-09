import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import {
  OutboxEvent,
} from './outbox.publisher';

import {
  OutboxDispatcherService,
} from './outbox.dispatcher.service';

import {
  createIntegrationDatabase,
} from '../database/integration-database.adapter';

type DispatcherDatabase =
  ReturnType<
    typeof createIntegrationDatabase
  >;

describe(
  'Outbox dispatcher concurrent claiming',
  () => {
    const eventCount = 40;

    let pool!: Pool;

    let appPool!: Pool;

    let eventIds: string[] = [];

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

      const eligibleResult =
        await pool.query<{
          count: number;
        }>(
          `
          SELECT
            COUNT(*)::int AS count

          FROM outbox_events

          WHERE
            (
              status IN (
                'PENDING',
                'FAILED'
              )

              AND next_attempt_at <= now()
            )

            OR

            (
              status = 'PROCESSING'

              AND (
                locked_at IS NULL

                OR locked_at <=
                  now() -
                  interval '60 seconds'
              )
            )
          `,
        );

      if (
        Number(
          eligibleResult.rows[0].count,
        ) !== 0
      ) {
        throw new Error(
          'Concurrent claim test requires no pre-existing eligible outbox events.',
        );
      }

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
          'No order available for concurrent claim test.',
        );
      }

      const selectedOrder =
        orderResult.rows[0];

      if (!selectedOrder) {
        throw new Error(
          'Concurrent claim test order row is missing.',
        );
      }

      orderId =
        selectedOrder.id;

      tenantId =
        selectedOrder.tenant_id;

      eventIds =
        Array.from(
          {
            length:
              eventCount,
          },
          () =>
            randomUUID(),
        );

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
          event_id,
          o.tenant_id,
          o.factory_id,
          'ORDER',
          o.id,
          'ORDER.CONCURRENT_TEST',
          1,

          jsonb_build_object(
            'test',
            true,
            'order',
            jsonb_build_object(
              'id',
              o.id,
              'tenant_id',
              o.tenant_id,
              'factory_id',
              o.factory_id,
              'order_number',
              o.order_number
            )
          ),

          'PENDING',
          0,
          now()

        FROM
          orders o

        CROSS JOIN
          UNNEST(
            $1::uuid[]
          ) AS ids(event_id)

        WHERE
          o.id = $2
          AND o.tenant_id = $3
        `,
        [
          eventIds,
          orderId,
          tenantId,
        ],
      );
    });

    afterAll(async () => {
      if (pool) {
        if (
          eventIds.length > 0
        ) {
          await pool.query(
            `
            DELETE FROM outbox_events

            WHERE id = ANY(
              $1::uuid[]
            )
            `,
            [
              eventIds,
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
      'should distribute events across concurrent workers without duplicate claims',
      async () => {
        const database:
          DispatcherDatabase =
          createIntegrationDatabase(
            appPool,
          );

        const publishedByWorkerA:
          string[] = [];

        const publishedByWorkerB:
          string[] = [];

        const publisherA = {
          publish: async (
            event: OutboxEvent,
          ): Promise<void> => {
            publishedByWorkerA.push(
              event.id,
            );
          },
        };

        const publisherB = {
          publish: async (
            event: OutboxEvent,
          ): Promise<void> => {
            publishedByWorkerB.push(
              event.id,
            );
          },
        };

        const registry = {
          dispatch: async (
            _event: OutboxEvent,
          ) => ({
            handled: false,
            consumerName: null,
          }),
        };

        const dispatcherA =
          new OutboxDispatcherService(
            database as never,
            publisherA as never,
            registry as never,
          );

        const dispatcherB =
          new OutboxDispatcherService(
            database as never,
            publisherB as never,
            registry as never,
          );

        const [
          resultA,
          resultB,
        ] =
          await Promise.all([
            dispatcherA.dispatchOnce(),
            dispatcherB.dispatchOnce(),
          ]);

        expect(
          resultA.failed,
        ).toBe(0);

        expect(
          resultB.failed,
        ).toBe(0);

        expect(
          resultA.published,
        ).toBe(
          resultA.claimed,
        );

        expect(
          resultB.published,
        ).toBe(
          resultB.claimed,
        );

        expect(
          resultA.claimed +
            resultB.claimed,
        ).toBe(
          eventCount,
        );

        const allPublishedIds =
          [
            ...publishedByWorkerA,
            ...publishedByWorkerB,
          ];

        expect(
          allPublishedIds.length,
        ).toBe(
          eventCount,
        );

        expect(
          new Set(
            allPublishedIds,
          ).size,
        ).toBe(
          eventCount,
        );

        expect(
          new Set(
            allPublishedIds,
          ),
        ).toEqual(
          new Set(eventIds),
        );

        const outboxResult =
          await pool.query<{
            total: number;
            published: number;
            attempts_one: number;
            processing: number;
            pending: number;
            failed: number;
          }>(
            `
            SELECT
              COUNT(*)::int AS total,

              COUNT(*) FILTER (
                WHERE status = 'PUBLISHED'
              )::int AS published,

              COUNT(*) FILTER (
                WHERE attempts = 1
              )::int AS attempts_one,

              COUNT(*) FILTER (
                WHERE status = 'PROCESSING'
              )::int AS processing,

              COUNT(*) FILTER (
                WHERE status = 'PENDING'
              )::int AS pending,

              COUNT(*) FILTER (
                WHERE status = 'FAILED'
              )::int AS failed

            FROM outbox_events

            WHERE id = ANY(
              $1::uuid[]
            )
            `,
            [
              eventIds,
            ],
          );

        expect(
          outboxResult.rowCount,
        ).toBe(1);

        expect(
          Number(
            outboxResult.rows[0]
              .total,
          ),
        ).toBe(
          eventCount,
        );

        expect(
          Number(
            outboxResult.rows[0]
              .published,
          ),
        ).toBe(
          eventCount,
        );

        expect(
          Number(
            outboxResult.rows[0]
              .attempts_one,
          ),
        ).toBe(
          eventCount,
        );

        expect(
          Number(
            outboxResult.rows[0]
              .processing,
          ),
        ).toBe(0);

        expect(
          Number(
            outboxResult.rows[0]
              .pending,
          ),
        ).toBe(0);

        expect(
          Number(
            outboxResult.rows[0]
              .failed,
          ),
        ).toBe(0);
      },
    );
  },
);