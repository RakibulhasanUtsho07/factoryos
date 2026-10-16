import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';

import {
  createIntegrationDatabase,
} from '../database/integration-database.adapter';

import { OrdersService } from './orders.service';
import { InventoryReservationService } from '../inventory/inventory.reservation.service';

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

    const reservationOrderIds: string[] = [];
    const reservationItemIds: string[] = [];

    let orderId!: string;
    let tenantId!: string;
    let factoryId!: string;


    const createBoundInventoryOrder = async (
      stockQuantity: number,
      lineQuantities: number[],
    ): Promise<{ orderId: string; itemId: string; lineIds: string[] }> => {
      const itemResult = await pool.query<{ id: string }>(
        `
        INSERT INTO inventory_items (
          tenant_id, factory_id, sku, name, unit, created_by_user_id
        )
        VALUES ($1, $2, $3, $4, 'PCS', $5)
        RETURNING id::text AS id
        `,
        [
          tenantId,
          factoryId,
          'ORDER-RES-' + randomUUID(),
          'Order reservation fixture',
          TEST_USER_ID,
        ],
      );
      const itemId = itemResult.rows[0]?.id;
      if (!itemId) throw new Error('Inventory item fixture was not created');
      reservationItemIds.push(itemId);

      await pool.query(
        `
        INSERT INTO inventory_stock_balances (
          tenant_id, factory_id, item_id, quantity_on_hand
        )
        VALUES ($1, $2, $3, $4::numeric)
        `,
        [tenantId, factoryId, itemId, stockQuantity.toFixed(4)],
      );

      const orderResult = await pool.query<{ id: string }>(
        `
        INSERT INTO orders (
          tenant_id, factory_id, order_number, status, order_date,
          currency, created_by_user_id
        )
        VALUES ($1, $2, $3, 'DRAFT', CURRENT_DATE, 'BDT', $4)
        RETURNING id::text AS id
        `,
        [tenantId, factoryId, 'ORDER-RES-' + randomUUID(), TEST_USER_ID],
      );
      const orderId = orderResult.rows[0]?.id;
      if (!orderId) throw new Error('Inventory order fixture was not created');
      reservationOrderIds.push(orderId);

      const lineIds: string[] = [];
      for (let index = 0; index < lineQuantities.length; index += 1) {
        const quantity = lineQuantities[index];
        if (quantity === undefined) throw new Error('Missing fixture line quantity');
        const lineResult = await pool.query<{ id: string }>(
          `
          INSERT INTO order_lines (
            tenant_id, factory_id, order_id, line_number,
            product_code, product_name, inventory_item_id, quantity, unit
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, 'PCS')
          RETURNING id::text AS id
          `,
          [
            tenantId,
            factoryId,
            orderId,
            index + 1,
            'SKU-' + (index + 1),
            'Order reservation line ' + (index + 1),
            itemId,
            quantity.toFixed(4),
          ],
        );
        const lineId = lineResult.rows[0]?.id;
        if (!lineId) throw new Error('Order line fixture was not created');
        lineIds.push(lineId);
      }
      return { orderId, itemId, lineIds };
    };

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
          new InventoryReservationService(database, auditService),
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

        if (reservationItemIds.length > 0) {
          await pool.query('ALTER TABLE inventory_reservations DISABLE TRIGGER USER');
          await pool.query('ALTER TABLE inventory_movements DISABLE TRIGGER USER');
          try {
            await pool.query(
              'DELETE FROM inventory_reservations WHERE tenant_id = $1 AND factory_id = $2 AND item_id = ANY($3::uuid[])',
              [tenantId, factoryId, reservationItemIds],
            );
            await pool.query(
              'DELETE FROM inventory_movements WHERE tenant_id = $1 AND factory_id = $2 AND item_id = ANY($3::uuid[])',
              [tenantId, factoryId, reservationItemIds],
            );
            await pool.query(
              'DELETE FROM outbox_events WHERE tenant_id = $1 AND factory_id = $2 AND (aggregate_id = ANY($3::uuid[]) OR aggregate_id = ANY($4::uuid[]))',
              [tenantId, factoryId, reservationItemIds, reservationOrderIds],
            );
            await pool.query(
              'DELETE FROM order_lines WHERE tenant_id = $1 AND factory_id = $2 AND order_id = ANY($3::uuid[])',
              [tenantId, factoryId, reservationOrderIds],
            );
            await pool.query(
              'DELETE FROM orders WHERE tenant_id = $1 AND factory_id = $2 AND id = ANY($3::uuid[])',
              [tenantId, factoryId, reservationOrderIds],
            );
            await pool.query(
              'DELETE FROM inventory_stock_balances WHERE tenant_id = $1 AND factory_id = $2 AND item_id = ANY($3::uuid[])',
              [tenantId, factoryId, reservationItemIds],
            );
            await pool.query(
              'DELETE FROM inventory_items WHERE tenant_id = $1 AND factory_id = $2 AND id = ANY($3::uuid[])',
              [tenantId, factoryId, reservationItemIds],
            );
          } finally {
            await pool.query('ALTER TABLE inventory_movements ENABLE TRIGGER USER');
            await pool.query('ALTER TABLE inventory_reservations ENABLE TRIGGER USER');
          }
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
      'should reserve bound order lines atomically on confirmation and consume them on completion',
      async () => {
        const fixture = await createBoundInventoryOrder(10, [3, 2]);

        const confirmed = await ordersService.transitionOrderStatus(
          TEST_USER_ID, tenantId, fixture.orderId, 'CONFIRMED', null, randomUUID(), 1,
        );
        expect(confirmed.status).toBe('CONFIRMED');
        expect(confirmed.inventory.reservations_created).toBe(2);

        const reservedRows = await pool.query<{ status: string; quantity: string }>(
          `
          SELECT status, quantity::text AS quantity
          FROM inventory_reservations
          WHERE tenant_id = $1 AND factory_id = $2
            AND reference_type = 'ORDER_LINE'
            AND reference_id = ANY($3::uuid[])
          ORDER BY reference_id
          `,
          [tenantId, factoryId, fixture.lineIds],
        );
        expect(reservedRows.rows).toHaveLength(2);
        expect(reservedRows.rows.every((row) => row.status === 'RESERVED')).toBe(true);

        const afterReserve = await pool.query<{ on_hand: string; reserved: string }>(
          `
          SELECT quantity_on_hand::text AS on_hand, quantity_reserved::text AS reserved
          FROM inventory_stock_balances
          WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
          `,
          [tenantId, factoryId, fixture.itemId],
        );
        expect(afterReserve.rows[0]?.on_hand).toBe('10.0000');
        expect(afterReserve.rows[0]?.reserved).toBe('5.0000');

        const inProgress = await ordersService.transitionOrderStatus(
          TEST_USER_ID, tenantId, fixture.orderId, 'IN_PROGRESS', null, randomUUID(), 2,
        );
        expect(inProgress.inventory.reservations_created).toBe(0);

        const completed = await ordersService.transitionOrderStatus(
          TEST_USER_ID, tenantId, fixture.orderId, 'COMPLETED', null, randomUUID(), 3,
        );
        expect(completed.status).toBe('COMPLETED');
        expect(completed.inventory.reservations_consumed).toBe(2);

        const finalBalance = await pool.query<{ on_hand: string; reserved: string }>(
          `
          SELECT quantity_on_hand::text AS on_hand, quantity_reserved::text AS reserved
          FROM inventory_stock_balances
          WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
          `,
          [tenantId, factoryId, fixture.itemId],
        );
        expect(finalBalance.rows[0]?.on_hand).toBe('5.0000');
        expect(finalBalance.rows[0]?.reserved).toBe('0.0000');

        const finalReservations = await pool.query<{ status: string; count: number }>(
          `
          SELECT status, COUNT(*)::int AS count
          FROM inventory_reservations
          WHERE tenant_id = $1 AND factory_id = $2
            AND reference_type = 'ORDER_LINE'
            AND reference_id = ANY($3::uuid[])
          GROUP BY status
          `,
          [tenantId, factoryId, fixture.lineIds],
        );
        expect(finalReservations.rows).toEqual([{ status: 'CONSUMED', count: 2 }]);

        const movementResult = await pool.query<{ count: number }>(
          `
          SELECT COUNT(*)::int AS count
          FROM inventory_movements
          WHERE tenant_id = $1 AND factory_id = $2
            AND item_id = $3 AND reference_type = 'RESERVATION'
          `,
          [tenantId, factoryId, fixture.itemId],
        );
        expect(movementResult.rows[0]?.count).toBe(2);
      },
    );

    it(
      'should roll back confirmation completely when bound-line stock is insufficient',
      async () => {
        const fixture = await createBoundInventoryOrder(4, [5]);

        await expect(
          ordersService.transitionOrderStatus(
            TEST_USER_ID, tenantId, fixture.orderId, 'CONFIRMED', null, randomUUID(), 1,
          ),
        ).rejects.toThrow('Insufficient available stock');

        const orderResult = await pool.query<{ status: string; version: string }>(
          `
          SELECT status, version::text AS version
          FROM orders WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
          `,
          [fixture.orderId, tenantId, factoryId],
        );
        expect(orderResult.rows[0]?.status).toBe('DRAFT');
        expect(orderResult.rows[0]?.version).toBe('1');

        const balance = await pool.query<{ reserved: string }>(
          `
          SELECT quantity_reserved::text AS reserved
          FROM inventory_stock_balances
          WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
          `,
          [tenantId, factoryId, fixture.itemId],
        );
        expect(balance.rows[0]?.reserved).toBe('0.0000');

        const reservations = await pool.query<{ count: number }>(
          `
          SELECT COUNT(*)::int AS count
          FROM inventory_reservations
          WHERE tenant_id = $1 AND factory_id = $2
            AND reference_id = ANY($3::uuid[])
          `,
          [tenantId, factoryId, fixture.lineIds],
        );
        expect(reservations.rows[0]?.count).toBe(0);
      },
    );

    it(
      'should release order reservations on cancellation without changing on-hand stock',
      async () => {
        const fixture = await createBoundInventoryOrder(8, [3, 2]);
        await ordersService.transitionOrderStatus(
          TEST_USER_ID, tenantId, fixture.orderId, 'CONFIRMED', null, randomUUID(), 1,
        );

        const cancelled = await ordersService.transitionOrderStatus(
          TEST_USER_ID, tenantId, fixture.orderId, 'CANCELLED', null, randomUUID(), 2,
        );
        expect(cancelled.status).toBe('CANCELLED');
        expect(cancelled.inventory.reservations_released).toBe(2);

        const balance = await pool.query<{ on_hand: string; reserved: string }>(
          `
          SELECT quantity_on_hand::text AS on_hand, quantity_reserved::text AS reserved
          FROM inventory_stock_balances
          WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
          `,
          [tenantId, factoryId, fixture.itemId],
        );
        expect(balance.rows[0]?.on_hand).toBe('8.0000');
        expect(balance.rows[0]?.reserved).toBe('0.0000');

        const statuses = await pool.query<{ status: string; count: number }>(
          `
          SELECT status, COUNT(*)::int AS count
          FROM inventory_reservations
          WHERE tenant_id = $1 AND factory_id = $2
            AND reference_type = 'ORDER_LINE'
            AND reference_id = ANY($3::uuid[])
          GROUP BY status
          `,
          [tenantId, factoryId, fixture.lineIds],
        );
        expect(statuses.rows).toEqual([{ status: 'RELEASED', count: 2 }]);
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