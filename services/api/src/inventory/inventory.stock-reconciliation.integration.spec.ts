import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import {
  createIntegrationDatabase,
} from '../database/integration-database.adapter';
import { InventoryStockReconciliationService } from './inventory.stock-reconciliation.service';

describe('InventoryStockReconciliationService PostgreSQL integration', () => {
  const TEST_USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';

  let adminPool!: Pool;
  let appPool!: Pool;
  let service!: InventoryStockReconciliationService;
  let tenantId!: string;
  let factoryId!: string;
  const itemIds: string[] = [];

  const createItem = async (
    quantityOnHand: string,
    quantityReserved: string,
  ): Promise<string> => {
    const itemResult = await adminPool.query<{ id: string }>(
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
        'RECON-' + randomUUID(),
        'Stock reconciliation integration fixture',
        TEST_USER_ID,
      ],
    );
    const itemId = itemResult.rows[0]?.id;
    if (!itemId) throw new Error('Reconciliation item fixture was not created');
    itemIds.push(itemId);

    await adminPool.query(
      `
      INSERT INTO inventory_stock_balances (
        tenant_id, factory_id, item_id, quantity_on_hand, quantity_reserved
      )
      VALUES ($1, $2, $3, $4::numeric, $5::numeric)
      `,
      [tenantId, factoryId, itemId, quantityOnHand, quantityReserved],
    );
    return itemId;
  };

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const adminDatabaseUrl = process.env.TEST_ADMIN_DATABASE_URL;
    if (!databaseUrl || !adminDatabaseUrl) {
      throw new Error('DATABASE_URL and TEST_ADMIN_DATABASE_URL are required');
    }

    adminPool = new Pool({ connectionString: adminDatabaseUrl });
    appPool = new Pool({ connectionString: databaseUrl });

    const context = await adminPool.query<{
      tenant_id: string;
      factory_id: string;
    }>(
      `
      SELECT t.id::text AS tenant_id, f.id::text AS factory_id
      FROM tenants t
      INNER JOIN factories f ON f.tenant_id = t.id
      WHERE t.status = 'ACTIVE' AND f.status = 'ACTIVE'
      ORDER BY t.created_at ASC, f.created_at ASC
      LIMIT 1
      `,
    );
    const row = context.rows[0];
    if (!row) throw new Error('No active tenant/factory exists for integration testing');
    tenantId = row.tenant_id;
    factoryId = row.factory_id;

    const actor = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM users WHERE id = $1 LIMIT 1',
      [TEST_USER_ID],
    );
    if (!actor.rows[0]) throw new Error('Stock reconciliation test user does not exist');

    const database = createIntegrationDatabase(appPool);
    const audit = { record: async () => undefined } as unknown as AuditService;
    service = new InventoryStockReconciliationService(database as never, audit);
  });

  afterAll(async () => {
    try {
      if (adminPool && itemIds.length > 0) {
        await adminPool.query(
          'ALTER TABLE inventory_stock_reconciliations DISABLE TRIGGER USER',
        );
        await adminPool.query('ALTER TABLE inventory_movements DISABLE TRIGGER USER');
        try {
          await adminPool.query(
            'DELETE FROM inventory_stock_reconciliations WHERE item_id = ANY($1::uuid[])',
            [itemIds],
          );
          await adminPool.query(
            'DELETE FROM inventory_movements WHERE item_id = ANY($1::uuid[])',
            [itemIds],
          );
          await adminPool.query(
            'DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])',
            [itemIds],
          );
          await adminPool.query(
            'DELETE FROM inventory_stock_balances WHERE item_id = ANY($1::uuid[])',
            [itemIds],
          );
          await adminPool.query(
            'DELETE FROM inventory_items WHERE id = ANY($1::uuid[])',
            [itemIds],
          );
        } finally {
          await adminPool.query(
            'ALTER TABLE inventory_movements ENABLE TRIGGER USER',
          );
          await adminPool.query(
            'ALTER TABLE inventory_stock_reconciliations ENABLE TRIGGER USER',
          );
        }
      }
    } finally {
      if (appPool) await appPool.end();
      if (adminPool) await adminPool.end();
    }
  });

  it('writes a matching receipt for positive variance and safely replays the same key', async () => {
    const itemId = await createItem('8.0000', '2.0000');
    const input = {
      counted_quantity: 9.5,
      reason_code: 'CYCLE_COUNT' as const,
      notes: 'Verified count in storage aisle A',
    };
    const first = await service.recordReconciliation(
      TEST_USER_ID,
      tenantId,
      factoryId,
      itemId,
      input,
      'reconcile-positive-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );

    expect(first.replayed).toBe(false);
    expect(first.quantity_before).toBe('8.0000');
    expect(first.counted_quantity).toBe('9.5000');
    expect(first.quantity_delta).toBe('1.5000');
    expect(first.quantity_after).toBe('9.5000');
    expect(first.adjustment_movement_id).toBeTruthy();

    const sameKey = 'reconcile-replay-' + randomUUID();
    // A different key means a new count; the actual replay below deliberately
    // keeps the exact key for the same request.
    const replayFirst = await service.recordReconciliation(
      TEST_USER_ID,
      tenantId,
      factoryId,
      itemId,
      input,
      sameKey,
      randomUUID(),
      randomUUID(),
    );
    const replay = await service.recordReconciliation(
      TEST_USER_ID,
      tenantId,
      factoryId,
      itemId,
      input,
      sameKey,
      randomUUID(),
      randomUUID(),
    );
    expect(replayFirst.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(replayFirst.id);

    const balance = await adminPool.query<{ quantity_on_hand: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_stock_balances WHERE item_id = $1',
      [itemId],
    );
    expect(balance.rows[0]?.quantity_on_hand).toBe('9.5000');

    const movement = await adminPool.query<{
      movement_type: string;
      quantity_delta: string;
      reference_type: string;
      reference_id: string;
    }>(
      `
      SELECT movement_type, quantity_delta::text AS quantity_delta,
             reference_type, reference_id::text AS reference_id
      FROM inventory_movements
      WHERE id = $1
      `,
      [replayFirst.adjustment_movement_id],
    );
    expect(movement.rows[0]).toMatchObject({
      movement_type: 'RECEIPT',
      quantity_delta: '1.5000',
      reference_type: 'STOCK_RECONCILIATION',
      reference_id: replayFirst.id,
    });

    await expect(
      service.recordReconciliation(
        TEST_USER_ID,
        tenantId,
        factoryId,
        itemId,
        { ...input, counted_quantity: 10 },
        sameKey,
        randomUUID(),
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('writes an issue for negative variance and refuses a count below reserved stock', async () => {
    const itemId = await createItem('10.0000', '2.0000');
    const result = await service.recordReconciliation(
      TEST_USER_ID,
      tenantId,
      factoryId,
      itemId,
      { counted_quantity: 3, reason_code: 'CYCLE_COUNT' },
      'reconcile-negative-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );

    expect(result.quantity_delta).toBe('-7.0000');
    expect(result.adjustment_movement_id).toBeTruthy();
    const movement = await adminPool.query<{ movement_type: string }>(
      'SELECT movement_type FROM inventory_movements WHERE id = $1',
      [result.adjustment_movement_id],
    );
    expect(movement.rows[0]?.movement_type).toBe('ISSUE');

    await expect(
      service.recordReconciliation(
        TEST_USER_ID,
        tenantId,
        factoryId,
        itemId,
        { counted_quantity: 1.5, reason_code: 'LOSS' },
        'reconcile-below-reserved-' + randomUUID(),
        randomUUID(),
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const balance = await adminPool.query<{ quantity_on_hand: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_stock_balances WHERE item_id = $1',
      [itemId],
    );
    expect(balance.rows[0]?.quantity_on_hand).toBe('3.0000');

    const records = await service.listReconciliations(tenantId, factoryId, itemId, 10);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe(result.id);
  });

  it('records zero variance without creating a no-op movement', async () => {
    const itemId = await createItem('4.0000', '1.0000');
    const result = await service.recordReconciliation(
      TEST_USER_ID,
      tenantId,
      factoryId,
      itemId,
      { counted_quantity: 4, reason_code: 'CYCLE_COUNT' },
      'reconcile-zero-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );

    expect(result.quantity_delta).toBe('0.0000');
    expect(result.adjustment_movement_id).toBeNull();

    const movementCount = await adminPool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM inventory_movements WHERE item_id = $1',
      [itemId],
    );
    expect(movementCount.rows[0]?.count).toBe('0');

    const records = await service.listReconciliations(tenantId, factoryId, itemId, 10);
    expect(records).toHaveLength(1);
    expect(records[0]?.adjustment_movement_id).toBeNull();
  });
});
