import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';

const postgresDescribe = process.env.TEST_ADMIN_DATABASE_URL ? describe : describe.skip;

postgresDescribe('Inventory ledger PostgreSQL invariants', () => {
  let database: DatabaseService;
  const tenantId = randomUUID();
  const userId = randomUUID();
  const traceId = randomUUID();

  beforeAll(async () => {
    const config = {
      get: (key: string) => {
        if (key === 'DATABASE_URL') return process.env.DATABASE_URL;
        return undefined;
      },
    } as ConfigService;

    database = new DatabaseService(config);
    await database.onModuleInit();

    await database.query(
      `
      INSERT INTO tenants (id, slug, name, status)
      VALUES ($1, $2, 'Inventory ledger test tenant', 'ACTIVE')
      `,
      [tenantId, 'inventory-ledger-' + tenantId.slice(0, 8)],
    );

    await database.query(
      `
      INSERT INTO users (id, external_subject, email, display_name, status)
      VALUES ($1, $2, $3, 'Inventory ledger test actor', 'ACTIVE')
      `,
      [
        userId,
        'inventory-ledger-' + userId,
        'inventory-ledger-' + userId + '@factoryos.test',
      ],
    );
  }, 60_000);

  afterAll(async () => {
    if (!database) return;
    await database.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    await database.query('DELETE FROM users WHERE id = $1', [userId]);
    await database.onModuleDestroy();
  }, 60_000);

  async function withFixture(
    test: (client: PoolClient, fixture: {
      factoryId: string;
      otherFactoryId: string;
      itemId: string;
      movementId: string;
    }) => Promise<void>,
  ): Promise<void> {
    const rollbackMarker = 'INVENTORY_FIXTURE_ROLLBACK';
    await expect(database.transaction(
      { tenantId, userId },
      async (client) => {
        const factoryA = await client.query<{ id: string }>(
          `
          INSERT INTO factories (tenant_id, code, name, status)
          VALUES ($1, $2, 'Inventory test factory A', 'ACTIVE')
          RETURNING id::text AS id
          `,
          [tenantId, 'INV-A-' + randomUUID().slice(0, 8)],
        );
        const factoryB = await client.query<{ id: string }>(
          `
          INSERT INTO factories (tenant_id, code, name, status)
          VALUES ($1, $2, 'Inventory test factory B', 'ACTIVE')
          RETURNING id::text AS id
          `,
          [tenantId, 'INV-B-' + randomUUID().slice(0, 8)],
        );
        const factoryId = factoryA.rows[0].id;
        const otherFactoryId = factoryB.rows[0].id;

        const item = await client.query<{ id: string }>(
          `
          INSERT INTO inventory_items (
            tenant_id, factory_id, sku, name, unit, created_by_user_id
          )
          VALUES ($1, $2, $3, 'Test item', 'PCS', $4)
          RETURNING id::text AS id
          `,
          [tenantId, factoryId, 'SKU-' + randomUUID().slice(0, 8), userId],
        );
        const itemId = item.rows[0].id;

        await client.query(
          `
          INSERT INTO inventory_stock_balances (
            tenant_id, factory_id, item_id, quantity_on_hand
          )
          VALUES ($1, $2, $3, 0)
          `,
          [tenantId, factoryId, itemId],
        );

        const movement = await client.query<{ id: string }>(
          `
          INSERT INTO inventory_movements (
            tenant_id, factory_id, item_id, movement_type, quantity,
            quantity_delta, quantity_after, idempotency_key, request_hash,
            created_by_user_id, correlation_id
          )
          VALUES ($1, $2, $3, 'RECEIPT', 1, 1, 1, $4, $5, $6, $7)
          RETURNING id::text AS id
          `,
          [tenantId, factoryId, itemId, 'test-' + randomUUID(), 'a'.repeat(64), userId, traceId],
        );

        await test(client, {
          factoryId,
          otherFactoryId,
          itemId,
          movementId: movement.rows[0].id,
        });
        throw new Error(rollbackMarker);
      },
    )).rejects.toThrow(rollbackMarker);
  }

  it('rejects edits to stock movement evidence', async () => {
    await withFixture(async (client, fixture) => {
      await client.query('SAVEPOINT protect_movement');
      await expect(client.query(
        'UPDATE inventory_movements SET notes = $1 WHERE id = $2',
        ['tampered', fixture.movementId],
      )).rejects.toMatchObject({ code: '55000' });
      await client.query('ROLLBACK TO SAVEPOINT protect_movement');
    });
  });

  it('rejects a movement that binds an item to a different factory', async () => {
    await withFixture(async (client, fixture) => {
      await client.query('SAVEPOINT protect_factory_scope');
      await expect(client.query(
        `
        INSERT INTO inventory_movements (
          tenant_id, factory_id, item_id, movement_type, quantity,
          quantity_delta, quantity_after, idempotency_key, request_hash,
          created_by_user_id, correlation_id
        )
        VALUES ($1, $2, $3, 'RECEIPT', 1, 1, 1, $4, $5, $6, $7)
        `,
        [
          tenantId,
          fixture.otherFactoryId,
          fixture.itemId,
          'cross-factory-' + randomUUID(),
          'b'.repeat(64),
          userId,
          traceId,
        ],
      )).rejects.toMatchObject({ code: '23503' });
      await client.query('ROLLBACK TO SAVEPOINT protect_factory_scope');
    });
  });

  it('rejects a negative stock balance at the database boundary', async () => {
    await withFixture(async (client, fixture) => {
      await client.query('SAVEPOINT protect_nonnegative_balance');
      await expect(client.query(
        'UPDATE inventory_stock_balances SET quantity_on_hand = -1 WHERE item_id = $1',
        [fixture.itemId],
      )).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT protect_nonnegative_balance');
    });
  });
  it('rejects a reserved balance above on-hand stock and prevents reopening terminal reservations', async () => {
    await withFixture(async (client, fixture) => {
      await client.query('SAVEPOINT protect_reserved_balance');
      await expect(client.query(
        'UPDATE inventory_stock_balances SET quantity_reserved = 1 WHERE item_id = $1',
        [fixture.itemId],
      )).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT protect_reserved_balance');

      const reservationId = randomUUID();
      const reservationKey = 'reservation-' + randomUUID();
      await client.query(
        `
        UPDATE inventory_stock_balances
        SET quantity_on_hand = 3, quantity_reserved = 1
        WHERE item_id = $1
        `,
        [fixture.itemId],
      );
      await client.query(
        `
        INSERT INTO inventory_reservations (
          id, tenant_id, factory_id, item_id, quantity, status,
          idempotency_key, request_hash, created_by_user_id, correlation_id
        )
        VALUES ($1, $2, $3, $4, 1, 'RESERVED', $5, $6, $7, $8)
        `,
        [
          reservationId, tenantId, fixture.factoryId, fixture.itemId,
          reservationKey, 'a'.repeat(64), userId, traceId,
        ],
      );

      await client.query('SAVEPOINT protect_reservation_balance_consistency');
      await client.query(
        `
        UPDATE inventory_reservations
        SET status = 'RELEASED',
            transition_idempotency_key = $1,
            transition_request_hash = $2,
            updated_at = clock_timestamp()
        WHERE id = $3
        `,
        ['release-invalid-' + randomUUID(), 'b'.repeat(64), reservationId],
      );
      await expect(client.query(
        'SET CONSTRAINTS ctr_inventory_reservation_balance_consistency IMMEDIATE',
      )).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT protect_reservation_balance_consistency');
      await client.query('SET CONSTRAINTS ctr_inventory_reservation_balance_consistency DEFERRED');

      // The valid lifecycle transition releases the reserved balance in the same transaction.
      await client.query(
        'UPDATE inventory_stock_balances SET quantity_reserved = 0 WHERE item_id = $1',
        [fixture.itemId],
      );
      await client.query(
        `
        UPDATE inventory_reservations
        SET status = 'RELEASED',
            transition_idempotency_key = $1,
            transition_request_hash = $2,
            updated_at = clock_timestamp()
        WHERE id = $3
        `,
        ['release-' + randomUUID(), 'c'.repeat(64), reservationId],
      );
      await client.query('SET CONSTRAINTS ctr_inventory_reservation_balance_consistency IMMEDIATE');

      await client.query('SAVEPOINT protect_reservation_reopen');
      await expect(client.query(
        "UPDATE inventory_reservations SET status = 'RESERVED' WHERE id = $1",
        [reservationId],
      )).rejects.toMatchObject({ code: '55000' });
      await client.query('ROLLBACK TO SAVEPOINT protect_reservation_reopen');

      await client.query('SAVEPOINT protect_reservation_payload');
      await expect(client.query(
        'UPDATE inventory_reservations SET quantity = 2 WHERE id = $1',
        [reservationId],
      )).rejects.toMatchObject({ code: '55000' });
      await client.query('ROLLBACK TO SAVEPOINT protect_reservation_payload');
    });
  });

});
