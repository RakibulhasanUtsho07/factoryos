import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';

import { OrdersService } from './orders.service';

describe(
  'OrdersService lifecycle',
  () => {
    const TEST_USER_ID =
      '921382b8-e83f-43ab-a576-e3db6a06b70c';

    let pool: Pool;

    let database: DatabaseService;
    let auditService: AuditService;

    let ordersService: OrdersService;

    let orderId: string;
    let tenantId: string;
    let factoryId: string;

    beforeAll(async () => {
      const databaseUrl =
        process.env.DATABASE_URL;

      if (!databaseUrl) {
        throw new Error(
          'DATABASE_URL is required.',
        );
      }

      pool =
        new Pool({
          connectionString:
            databaseUrl,
        });

      // --------------------------------------------------------
      // Resolve an active tenant + factory.
      // User membership is NOT inferred from users.tenant_id
      // because the actual local schema does not have that column.
      // --------------------------------------------------------

      const contextResult =
        await pool.query<{
          tenant_id: string;
          factory_id: string;
        }>(
          `
          SELECT
            t.id::text AS tenant_id,
            f.id::text AS factory_id

          FROM tenants t

          JOIN factories f
            ON f.tenant_id = t.id

          WHERE
            t.status = 'ACTIVE'
            AND f.status = 'ACTIVE'

          ORDER BY
            t.created_at ASC,
            f.created_at ASC

          LIMIT 1
          `,
        );

      if (
        contextResult.rowCount !== 1
      ) {
        throw new Error(
          'No active tenant/factory available for lifecycle test.',
        );
      }

      tenantId =
        contextResult.rows[0]
          .tenant_id;

      factoryId =
        contextResult.rows[0]
          .factory_id;

      // --------------------------------------------------------
      // Verify the local test actor exists.
      // Do NOT assume users.tenant_id exists.
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

          LIMIT 1
          `,
          [TEST_USER_ID],
        );

      if (
        userResult.rowCount !== 1
      ) {
        throw new Error(
          `Test user does not exist: ${TEST_USER_ID}`,
        );
      }

      // --------------------------------------------------------
      // Create isolated lifecycle test order.
      // --------------------------------------------------------

      const orderNumber =
        `LIFECYCLE-TEST-${randomUUID()}`;

      const orderResult =
        await pool.query<{
          id: string;
          status: string;
        }>(
          `
          INSERT INTO orders (
            tenant_id,
            factory_id,
            order_number,
            status,
            order_date,
            currency,
            created_by_user_id
          )

          VALUES (
            $1,
            $2,
            $3,
            'DRAFT',
            CURRENT_DATE,
            'BDT',
            $4
          )

          RETURNING
            id::text AS id,
            status
          `,
          [
            tenantId,
            factoryId,
            orderNumber,
            TEST_USER_ID,
          ],
        );

      if (
        orderResult.rowCount !== 1
      ) {
        throw new Error(
          'Lifecycle test order could not be created.',
        );
      }

      orderId =
        orderResult.rows[0].id;

      // --------------------------------------------------------
      // Lightweight real PostgreSQL database adapter.
      // --------------------------------------------------------

      database =
        {
          transaction:
            async <T>(
              callback: (
                client: import('pg').PoolClient,
              ) => Promise<T>,
            ): Promise<T> => {
              const client =
                await pool.connect();

              try {
                await client.query(
                  'BEGIN',
                );

                const value =
                  await callback(
                    client,
                  );

                await client.query(
                  'COMMIT',
                );

                return value;
              } catch (error) {
                await client.query(
                  'ROLLBACK',
                );

                throw error;
              } finally {
                client.release();
              }
            },

          query:
            pool.query.bind(pool),
        } as never;

      // --------------------------------------------------------
      // Audit is intentionally mocked for this service test.
      // Database lifecycle + outbox are tested against real PG.
      // --------------------------------------------------------

      auditService =
        {
          record:
            async () =>
              undefined,
        } as never;

      ordersService =
        new OrdersService(
          database,
          auditService,
          {} as never,
        );
    });

    afterAll(async () => {
      if (!pool) {
        return;
      }

      if (orderId) {
        await pool.query(
          `
          DELETE FROM outbox_events

          WHERE
            aggregate_id = $1
          `,
          [orderId],
        );

        await pool.query(
          `
          DELETE FROM orders

          WHERE
            id = $1
          `,
          [orderId],
        );
      }

      await pool.end();
    });

    it(
      'should enforce the complete valid lifecycle',
      async () => {
        const traceId =
          randomUUID();

        const confirmed =
          await ordersService.transitionOrderStatus(
            TEST_USER_ID,
            tenantId,
            orderId,
            'CONFIRMED',
            null,
            traceId,
          );

        expect(
          confirmed.previous_status,
        ).toBe('DRAFT');

        expect(
          confirmed.status,
        ).toBe('CONFIRMED');

        const inProgress =
          await ordersService.transitionOrderStatus(
            TEST_USER_ID,
            tenantId,
            orderId,
            'IN_PROGRESS',
            null,
            traceId,
          );

        expect(
          inProgress.previous_status,
        ).toBe('CONFIRMED');

        expect(
          inProgress.status,
        ).toBe('IN_PROGRESS');

        const completed =
          await ordersService.transitionOrderStatus(
            TEST_USER_ID,
            tenantId,
            orderId,
            'COMPLETED',
            null,
            traceId,
          );

        expect(
          completed.previous_status,
        ).toBe('IN_PROGRESS');

        expect(
          completed.status,
        ).toBe('COMPLETED');

        // ------------------------------------------------------
        // Verify authoritative DB state.
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

        expect(
          orderResult.rows[0]
            .status,
        ).toBe(
          'COMPLETED',
        );

        // ------------------------------------------------------
        // Verify exactly one event for each transition.
        // ------------------------------------------------------

        const outboxResult =
          await pool.query<{
            event_type: string;
            count: number;
          }>(
            `
            SELECT
              event_type,
              COUNT(*)::int AS count

            FROM outbox_events

            WHERE
              aggregate_id = $1
              AND tenant_id = $2
              AND event_type IN (
                'ORDER.CONFIRMED',
                'ORDER.IN_PROGRESS',
                'ORDER.COMPLETED'
              )

            GROUP BY
              event_type

            ORDER BY
              event_type
            `,
            [
              orderId,
              tenantId,
            ],
          );

        expect(
          outboxResult.rows,
        ).toHaveLength(3);

        for (
          const row of
            outboxResult.rows
        ) {
          expect(
            Number(row.count),
          ).toBe(1);
        }
      },
    );

    it(
      'should reject an invalid backward transition',
      async () => {
        await expect(
          ordersService.transitionOrderStatus(
            TEST_USER_ID,
            tenantId,
            orderId,
            'IN_PROGRESS',
            null,
            randomUUID(),
          ),
        ).rejects.toThrow(
          'Invalid order status transition',
        );
      },
    );

    it(
      'should reject a terminal-state transition',
      async () => {
        await expect(
          ordersService.transitionOrderStatus(
            TEST_USER_ID,
            tenantId,
            orderId,
            'CANCELLED',
            null,
            randomUUID(),
          ),
        ).rejects.toThrow(
          'Invalid order status transition',
        );
      },
    );
  },
);