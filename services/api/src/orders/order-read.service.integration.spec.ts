import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';

import { OrdersService } from './orders.service';

describe(
  'OrdersService read queries',
  () => {
    const TEST_USER_ID =
      '921382b8-e83f-43ab-a576-e3db6a06b70c';

    let pool: Pool;

    let database: DatabaseService;
    let auditService: AuditService;
    let ordersService: OrdersService;

    let tenantId: string;
    let factoryAId: string;
    let factoryBId: string;

    let orderAId: string;
    let orderBId: string;

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
      // Resolve one active tenant with two active factories.
      // --------------------------------------------------------

      const factoryResult =
        await pool.query<{
          tenant_id: string;
          factory_id: string;
        }>(
          `
          SELECT
            f.tenant_id::text AS tenant_id,
            f.id::text AS factory_id

          FROM factories f

          INNER JOIN tenants t
            ON t.id = f.tenant_id

          WHERE
            t.status = 'ACTIVE'
            AND f.status = 'ACTIVE'

          ORDER BY
            f.created_at ASC

          LIMIT 2
          `,
        );

      if (
        factoryResult.rows.length !== 2
      ) {
        throw new Error(
          'Read test requires at least two active factories in the same tenant.',
        );
      }

      tenantId =
        factoryResult.rows[0]
          .tenant_id;

      const differentTenant =
        factoryResult.rows.some(
          (row) =>
            row.tenant_id !==
            tenantId,
        );

      if (differentTenant) {
        throw new Error(
          'Read test factory selection unexpectedly spans multiple tenants.',
        );
      }

      factoryAId =
        factoryResult.rows[0]
          .factory_id;

      factoryBId =
        factoryResult.rows[1]
          .factory_id;

      // --------------------------------------------------------
      // Verify test actor exists.
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
      // Create isolated order in Factory A.
      // --------------------------------------------------------

      const orderANumber =
        `READ-TEST-A-${randomUUID()}`;

      const orderAResult =
        await pool.query<{
          id: string;
        }>(
          `
          INSERT INTO orders (
            tenant_id,
            factory_id,
            order_number,
            customer_name,
            customer_reference,
            status,
            order_date,
            requested_delivery_date,
            currency,
            notes,
            created_by_user_id
          )

          VALUES (
            $1,
            $2,
            $3,
            'Read Test Customer A',
            'READ-REF-A',
            'CONFIRMED',
            CURRENT_DATE,
            CURRENT_DATE + INTERVAL '7 days',
            'BDT',
            'Read query integration test A',
            $4
          )

          RETURNING
            id::text AS id
          `,
          [
            tenantId,
            factoryAId,
            orderANumber,
            TEST_USER_ID,
          ],
        );

      if (
        orderAResult.rowCount !== 1
      ) {
        throw new Error(
          'Factory A read test order could not be created.',
        );
      }

      orderAId =
        orderAResult.rows[0].id;

      // --------------------------------------------------------
      // Create order line for Factory A order.
      // --------------------------------------------------------

      await pool.query(
        `
        INSERT INTO order_lines (
          tenant_id,
          order_id,
          line_number,
          product_code,
          product_name,
          quantity,
          unit,
          unit_price,
          requested_delivery_date,
          notes
        )

        VALUES (
          $1,
          $2,
          1,
          'READ-A-001',
          'Read Test Product A',
          12.5,
          'pcs',
          125.50,
          CURRENT_DATE + INTERVAL '5 days',
          'Read test line A'
        )
        `,
        [
          tenantId,
          orderAId,
        ],
      );

      // --------------------------------------------------------
      // Create isolated order in Factory B.
      // --------------------------------------------------------

      const orderBNumber =
        `READ-TEST-B-${randomUUID()}`;

      const orderBResult =
        await pool.query<{
          id: string;
        }>(
          `
          INSERT INTO orders (
            tenant_id,
            factory_id,
            order_number,
            customer_name,
            customer_reference,
            status,
            order_date,
            requested_delivery_date,
            currency,
            notes,
            created_by_user_id
          )

          VALUES (
            $1,
            $2,
            $3,
            'Read Test Customer B',
            'READ-REF-B',
            'DRAFT',
            CURRENT_DATE,
            NULL,
            'USD',
            'Read query integration test B',
            $4
          )

          RETURNING
            id::text AS id
          `,
          [
            tenantId,
            factoryBId,
            orderBNumber,
            TEST_USER_ID,
          ],
        );

      if (
        orderBResult.rowCount !== 1
      ) {
        throw new Error(
          'Factory B read test order could not be created.',
        );
      }

      orderBId =
        orderBResult.rows[0].id;

      // --------------------------------------------------------
      // Create order line for Factory B order.
      // --------------------------------------------------------

      await pool.query(
        `
        INSERT INTO order_lines (
          tenant_id,
          order_id,
          line_number,
          product_code,
          product_name,
          quantity,
          unit,
          unit_price
        )

        VALUES (
          $1,
          $2,
          1,
          'READ-B-001',
          'Read Test Product B',
          8,
          'kg',
          80
        )
        `,
        [
          tenantId,
          orderBId,
        ],
      );

      // --------------------------------------------------------
      // Real PostgreSQL adapter.
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
      // Audit is irrelevant to pure read queries.
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

      if (orderAId) {
        await pool.query(
          `
          DELETE FROM orders

          WHERE
            id = $1
          `,
          [
            orderAId,
          ],
        );
      }

      if (orderBId) {
        await pool.query(
          `
          DELETE FROM orders

          WHERE
            id = $1
          `,
          [
            orderBId,
          ],
        );
      }

      await pool.end();
    });

    it(
      'should return an order with its lines',
      async () => {
        const result =
          await ordersService.getOrderById(
            tenantId,
            factoryAId,
            orderAId,
          );

        expect(
          result.id,
        ).toBe(orderAId);

        expect(
          result.tenant_id,
        ).toBe(tenantId);

        expect(
          result.factory_id,
        ).toBe(factoryAId);

        expect(
          result.status,
        ).toBe('CONFIRMED');

        expect(
          result.order_number,
        ).toContain(
          'READ-TEST-A-',
        );

        expect(
          result.customer_name,
        ).toBe(
          'Read Test Customer A',
        );

        expect(
          result.lines,
        ).toHaveLength(1);

        expect(
          result.lines[0].line_number,
        ).toBe(1);

        expect(
          result.lines[0].product_code,
        ).toBe(
          'READ-A-001',
        );

        expect(
          result.lines[0].quantity,
        ).toBe('12.5000');

        expect(
          result.lines[0].unit_price,
        ).toBe('125.5000');
      },
    );

    it(
      'should reject an order from another factory',
      async () => {
        await expect(
          ordersService.getOrderById(
            tenantId,
            factoryBId,
            orderAId,
          ),
        ).rejects.toThrow(
          'Order not found',
        );
      },
    );

    it(
      'should reject an order from another tenant',
      async () => {
        await expect(
          ordersService.getOrderById(
            randomUUID(),
            factoryAId,
            orderAId,
          ),
        ).rejects.toThrow(
          'Order not found',
        );
      },
    );

    it(
      'should return paginated orders only from the selected factory',
      async () => {
        const result =
          await ordersService.listOrders(
            tenantId,
            factoryAId,
            {
              page: 1,
              limit: 20,
            },
          );

        expect(
          result.pagination.page,
        ).toBe(1);

        expect(
          result.pagination.limit,
        ).toBe(20);

        expect(
          result.pagination.total,
        ).toBeGreaterThanOrEqual(1);

        expect(
          result.items.some(
            (item) =>
              item.id === orderAId,
          ),
        ).toBe(true);

        expect(
          result.items.some(
            (item) =>
              item.id === orderBId,
          ),
        ).toBe(false);

        for (
          const item of
            result.items
        ) {
          expect(
            item.tenant_id,
          ).toBe(tenantId);

          expect(
            item.factory_id,
          ).toBe(factoryAId);
        }
      },
    );

    it(
      'should filter orders by status',
      async () => {
        const confirmed =
          await ordersService.listOrders(
            tenantId,
            factoryAId,
            {
              page: 1,
              limit: 20,
              status:
                'CONFIRMED',
            },
          );

        expect(
          confirmed.items.length,
        ).toBeGreaterThanOrEqual(1);

        expect(
          confirmed.items.some(
            (item) =>
              item.id === orderAId,
          ),
        ).toBe(true);

        for (
          const item of
            confirmed.items
        ) {
          expect(
            item.status,
          ).toBe(
            'CONFIRMED',
          );

          expect(
            item.factory_id,
          ).toBe(factoryAId);
        }

        const drafts =
          await ordersService.listOrders(
            tenantId,
            factoryAId,
            {
              page: 1,
              limit: 20,
              status:
                'DRAFT',
            },
          );

        expect(
          drafts.items.some(
            (item) =>
              item.id === orderAId,
          ),
        ).toBe(false);
      },
    );

    it(
      'should search order number and customer fields',
      async () => {
        const searchByCustomer =
          await ordersService.listOrders(
            tenantId,
            factoryAId,
            {
              page: 1,
              limit: 20,
              search:
                'Read Test Customer A',
            },
          );

        expect(
          searchByCustomer.items,
        ).toHaveLength(1);

        expect(
          searchByCustomer.items[0]
            .id,
        ).toBe(orderAId);

        const orderNumber =
          searchByCustomer.items[0]
            .order_number;

        const searchByOrderNumber =
          await ordersService.listOrders(
            tenantId,
            factoryAId,
            {
              page: 1,
              limit: 20,
              search:
                orderNumber,
            },
          );

        expect(
          searchByOrderNumber.items,
        ).toHaveLength(1);

        expect(
          searchByOrderNumber.items[0]
            .id,
        ).toBe(orderAId);
      },
    );

    it(
      'should return no records when another factory is selected',
      async () => {
        const result =
          await ordersService.listOrders(
            tenantId,
            factoryBId,
            {
              page: 1,
              limit: 20,
              search:
                'Read Test Customer A',
            },
          );

        expect(
          result.items,
        ).toHaveLength(0);

        expect(
          result.pagination.total,
        ).toBe(0);
      },
    );
  },
);