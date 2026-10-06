import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';

import {
  createIntegrationDatabase,
} from '../database/integration-database.adapter';

import { OrdersService } from './orders.service';

describe(
  'OrdersService lifecycle',
  () => {
    const TEST_USER_ID =
      '921382b8-e83f-43ab-a576-e3db6a06b70c';

    let pool!: Pool;

    let appPool!: Pool;

    let database: DatabaseService;
    let auditService: AuditService;
    let ordersService: OrdersService;

    let orderId!: string;
    let tenantId!: string;
    let factoryId!: string;

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

      /*
       * --------------------------------------------------------
       * Admin/test-fixture connection.
       *
       * This connection is intentionally privileged and is used
       * only to create/read/clean integration-test fixtures.
       *
       * Production application code NEVER receives this pool.
       * --------------------------------------------------------
       */
      pool =
        new Pool({
          connectionString:
            testAdminDatabaseUrl,
        });

      /*
       * --------------------------------------------------------
       * Production-like application connection.
       *
       * This must use the non-superuser factoryos_app role so
       * PostgreSQL RLS is actually enforced during service tests.
       * --------------------------------------------------------
       */
      appPool =
        new Pool({
          connectionString:
            databaseUrl,
        });

      // --------------------------------------------------------
      // Resolve one active tenant + factory.
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

          INNER JOIN factories f
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

      const context =
        contextResult.rows[0];

      if (!context) {
        throw new Error(
          'Lifecycle test context is missing.',
        );
      }

      tenantId =
        context.tenant_id;

      factoryId =
        context.factory_id;

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
          `Test user does not exist: ${TEST_USER_ID}`,
        );
      }

      // --------------------------------------------------------
      // Create isolated test order.
      // --------------------------------------------------------

      const orderNumber =
        `LIFECYCLE-TEST-${randomUUID()}`;

      const orderResult =
        await pool.query<{
          id: string;
          status: string;
          updated_at: string;
          version: string;
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
            status,
            updated_at::text AS updated_at,
            version::text AS version
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

      const createdOrder =
        orderResult.rows[0];

      if (!createdOrder) {
        throw new Error(
          'Created lifecycle order row is missing.',
        );
      }

      orderId =
        createdOrder.id;

      expect(
        createdOrder.status,
      ).toBe('DRAFT');

      expect(
        Number(
          createdOrder.version,
        ),
      ).toBe(1);

      // --------------------------------------------------------
      // Real PostgreSQL adapter.
      //
      // Important:
      // service operations use appPool so RLS is enforced.
      // --------------------------------------------------------

      database =
        createIntegrationDatabase(
          appPool,
        ) as never;

      // --------------------------------------------------------
      // Audit mocked for service-level lifecycle test.
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
      if (pool) {
        if (orderId) {
          await pool.query(
            `
            DELETE FROM outbox_events

            WHERE
              aggregate_id = $1
            `,
            [
              orderId,
            ],
          );

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
      'should enforce the complete valid lifecycle and increment version',
      async () => {
        // ------------------------------------------------------
        // Initial state.
        // ------------------------------------------------------

        const initialResult =
          await pool.query<{
            status: string;
            updated_at: string;
            version: string;
          }>(
            `
            SELECT
              status,
              updated_at::text AS updated_at,
              version::text AS version

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
          initialResult.rowCount,
        ).toBe(1);

        const initial =
          initialResult.rows[0];

        if (!initial) {
          throw new Error(
            'Initial lifecycle order state is missing.',
          );
        }

        expect(
          initial.status,
        ).toBe('DRAFT');

        expect(
          Number(
            initial.version,
          ),
        ).toBe(1);

        const initialUpdatedAt =
          new Date(
            initial.updated_at,
          );

        // ------------------------------------------------------
        // DRAFT -> CONFIRMED
        // ------------------------------------------------------

        const confirmed =
          await ordersService.transitionOrderStatus(
            TEST_USER_ID,
            tenantId,
            orderId,
            'CONFIRMED',
            null,
            randomUUID(),
            1,
          );

        expect(
          confirmed.previous_status,
        ).toBe('DRAFT');

        expect(
          confirmed.status,
        ).toBe('CONFIRMED');

        expect(
          confirmed.version,
        ).toBe(2);

        expect(
          new Date(
            confirmed.updated_at,
          ).getTime(),
        ).toBeGreaterThan(
          initialUpdatedAt.getTime(),
        );

        // ------------------------------------------------------
        // CONFIRMED -> IN_PROGRESS
        // ------------------------------------------------------

        const confirmedUpdatedAt =
          new Date(
            confirmed.updated_at,
          );

        const inProgress =
          await ordersService.transitionOrderStatus(
            TEST_USER_ID,
            tenantId,
            orderId,
            'IN_PROGRESS',
            null,
            randomUUID(),
            2,
          );

        expect(
          inProgress.previous_status,
        ).toBe('CONFIRMED');

        expect(
          inProgress.status,
        ).toBe('IN_PROGRESS');

        expect(
          inProgress.version,
        ).toBe(3);

        expect(
          new Date(
            inProgress.updated_at,
          ).getTime(),
        ).toBeGreaterThan(
          confirmedUpdatedAt.getTime(),
        );

        // ------------------------------------------------------
        // IN_PROGRESS -> COMPLETED
        // ------------------------------------------------------

        const inProgressUpdatedAt =
          new Date(
            inProgress.updated_at,
          );

        const completed =
          await ordersService.transitionOrderStatus(
            TEST_USER_ID,
            tenantId,
            orderId,
            'COMPLETED',
            null,
            randomUUID(),
            3,
          );

        expect(
          completed.previous_status,
        ).toBe('IN_PROGRESS');

        expect(
          completed.status,
        ).toBe('COMPLETED');

        expect(
          completed.version,
        ).toBe(4);

        expect(
          new Date(
            completed.updated_at,
          ).getTime(),
        ).toBeGreaterThan(
          inProgressUpdatedAt.getTime(),
        );

        // ------------------------------------------------------
        // Verify authoritative DB state.
        // ------------------------------------------------------

        const finalResult =
          await pool.query<{
            status: string;
            updated_at: string;
            version: string;
          }>(
            `
            SELECT
              status,
              updated_at::text AS updated_at,
              version::text AS version

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
          finalResult.rowCount,
        ).toBe(1);

        const finalOrder =
          finalResult.rows[0];

        if (!finalOrder) {
          throw new Error(
            'Final lifecycle order state is missing.',
          );
        }

        expect(
          finalOrder.status,
        ).toBe('COMPLETED');

        expect(
          Number(
            finalOrder.version,
          ),
        ).toBe(4);

        expect(
          new Date(
            finalOrder.updated_at,
          ).getTime(),
        ).toBeGreaterThan(
          initialUpdatedAt.getTime(),
        );

        // ------------------------------------------------------
        // Verify exactly one event per transition.
        // ------------------------------------------------------

        const outboxResult =
          await pool.query<{
            event_type: string;
            count: number;
            version: number | null;
          }>(
            `
            SELECT
              event_type,
              COUNT(*)::int AS count,

              MAX(
                (
                  payload->'order'->>'version'
                )::bigint
              )::int AS version

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
            Number(
              row.count,
            ),
          ).toBe(1);
        }

        const confirmedEvent =
          outboxResult.rows.find(
            (row) =>
              row.event_type ===
              'ORDER.CONFIRMED',
          );

        const inProgressEvent =
          outboxResult.rows.find(
            (row) =>
              row.event_type ===
              'ORDER.IN_PROGRESS',
          );

        const completedEvent =
          outboxResult.rows.find(
            (row) =>
              row.event_type ===
              'ORDER.COMPLETED',
          );

        expect(
          confirmedEvent?.version,
        ).toBe(2);

        expect(
          inProgressEvent?.version,
        ).toBe(3);

        expect(
          completedEvent?.version,
        ).toBe(4);
      },
    );

    it(
      'should reject an invalid backward transition without changing version or timestamp',
      async () => {
        const beforeResult =
          await pool.query<{
            status: string;
            updated_at: string;
            version: string;
          }>(
            `
            SELECT
              status,
              updated_at::text AS updated_at,
              version::text AS version

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
          beforeResult.rowCount,
        ).toBe(1);

        const before =
          beforeResult.rows[0];

        if (!before) {
          throw new Error(
            'Order state before invalid transition is missing.',
          );
        }

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

        const afterResult =
          await pool.query<{
            status: string;
            updated_at: string;
            version: string;
          }>(
            `
            SELECT
              status,
              updated_at::text AS updated_at,
              version::text AS version

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
          afterResult.rowCount,
        ).toBe(1);

        const after =
          afterResult.rows[0];

        if (!after) {
          throw new Error(
            'Order state after invalid transition is missing.',
          );
        }

        expect(
          after.status,
        ).toBe(
          before.status,
        );

        expect(
          Number(
            after.version,
          ),
        ).toBe(
          Number(
            before.version,
          ),
        );

        expect(
          after.updated_at,
        ).toBe(
          before.updated_at,
        );
      },
    );

    it(
      'should reject a terminal-state transition without changing version or timestamp',
      async () => {
        const beforeResult =
          await pool.query<{
            status: string;
            updated_at: string;
            version: string;
          }>(
            `
            SELECT
              status,
              updated_at::text AS updated_at,
              version::text AS version

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
          beforeResult.rowCount,
        ).toBe(1);

        const before =
          beforeResult.rows[0];

        if (!before) {
          throw new Error(
            'Terminal-state precondition state is missing.',
          );
        }

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

        const afterResult =
          await pool.query<{
            status: string;
            updated_at: string;
            version: string;
          }>(
            `
            SELECT
              status,
              updated_at::text AS updated_at,
              version::text AS version

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
          afterResult.rowCount,
        ).toBe(1);

        const after =
          afterResult.rows[0];

        if (!after) {
          throw new Error(
            'Terminal-state postcondition state is missing.',
          );
        }

        expect(
          after.status,
        ).toBe(
          before.status,
        );

        expect(
          Number(
            after.version,
          ),
        ).toBe(
          Number(
            before.version,
          ),
        );

        expect(
          after.updated_at,
        ).toBe(
          before.updated_at,
        );
      },
    );

    it(
      'should reject a stale expected version',
      async () => {
        // ------------------------------------------------------
        // Create an isolated order for the concurrency test.
        // ------------------------------------------------------

        const concurrencyOrderNumber =
          `CONCURRENCY-TEST-${randomUUID()}`;

        const createResult =
          await pool.query<{
            id: string;
            version: string;
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
              version::text AS version,
              status
            `,
            [
              tenantId,
              factoryId,
              concurrencyOrderNumber,
              TEST_USER_ID,
            ],
          );

        expect(
          createResult.rowCount,
        ).toBe(1);

        const testOrder =
          createResult.rows[0];

        if (!testOrder) {
          throw new Error(
            'Concurrency test order could not be created.',
          );
        }

        const concurrencyOrderId =
          testOrder.id;

        try {
          expect(
            Number(testOrder.version),
          ).toBe(1);

          expect(
            testOrder.status,
          ).toBe('DRAFT');

          // ----------------------------------------------------
          // First client succeeds with version 1.
          // ----------------------------------------------------

          const confirmed =
            await ordersService.transitionOrderStatus(
              TEST_USER_ID,
              tenantId,
              concurrencyOrderId,
              'CONFIRMED',
              null,
              randomUUID(),
              1,
            );

          expect(
            confirmed.status,
          ).toBe('CONFIRMED');

          expect(
            confirmed.version,
          ).toBe(2);

          // ----------------------------------------------------
          // Second stale client still believes version = 1.
          // ----------------------------------------------------

          await expect(
            ordersService.transitionOrderStatus(
              TEST_USER_ID,
              tenantId,
              concurrencyOrderId,
              'IN_PROGRESS',
              null,
              randomUUID(),
              1,
            ),
          ).rejects.toThrow(
            'Order version conflict',
          );

          // ----------------------------------------------------
          // Authoritative state must remain unchanged.
          // ----------------------------------------------------

          const finalResult =
            await pool.query<{
              status: string;
              version: string;
            }>(
              `
              SELECT
                status,
                version::text AS version

              FROM orders

              WHERE
                id = $1
                AND tenant_id = $2
              `,
              [
                concurrencyOrderId,
                tenantId,
              ],
            );

          expect(
            finalResult.rowCount,
          ).toBe(1);

          const finalOrder =
            finalResult.rows[0];

          if (!finalOrder) {
            throw new Error(
              'Concurrency test final state is missing.',
            );
          }

          expect(
            finalOrder.status,
          ).toBe('CONFIRMED');

          expect(
            Number(finalOrder.version),
          ).toBe(2);
        } finally {
          await pool.query(
            `
            DELETE FROM outbox_events

            WHERE
              aggregate_id = $1
            `,
            [concurrencyOrderId],
          );

          await pool.query(
            `
            DELETE FROM orders

            WHERE
              id = $1
            `,
            [concurrencyOrderId],
          );
        }
      },
    );
  },
);