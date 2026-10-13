import { jest } from '@jest/globals';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { createIntegrationDatabase } from '../database/integration-database.adapter';
import { DatabaseService } from '../database/database.service';
import {
  CreateInventoryItemDto,
  CreateInventoryMovementDto,
  InventoryMovementType,
} from './inventory.dto';
import { InventoryService } from './inventory.service';

describe('InventoryService PostgreSQL integration', () => {
  const TEST_USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
  let adminPool: Pool;
  let appPool: Pool;
  let database: DatabaseService;
  let inventory: InventoryService;
  let tenantId: string;
  let factoryAId: string;
  let factoryBId: string;

  async function createItem() {
    const dto: CreateInventoryItemDto = {
      item_code: 'ITEM-' + randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase(),
      item_name: 'Inventory Integration Test Item',
      base_unit: 'pcs',
    };
    return inventory.createItem(TEST_USER_ID, tenantId, factoryAId, dto, randomUUID(), randomUUID());
  }

  async function movement(
    itemId: string,
    movementType: InventoryMovementType,
    quantityDelta: number,
    idempotencyKey = 'inv-' + randomUUID(),
  ) {
    const dto: CreateInventoryMovementDto = {
      item_id: itemId,
      location_code: 'MAIN',
      movement_type: movementType,
      quantity_delta: quantityDelta,
      reason: 'Integration test movement',
    };
    return inventory.createMovement(
      TEST_USER_ID, tenantId, factoryAId, dto, idempotencyKey, randomUUID(), randomUUID(),
    );
  }

  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL;
    const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
    if (!appUrl || !adminUrl) {
      throw new Error('DATABASE_URL and TEST_ADMIN_DATABASE_URL are required for inventory integration tests');
    }

    adminPool = new Pool({ connectionString: adminUrl });
    appPool = new Pool({ connectionString: appUrl });
    const factories = await adminPool.query<{ tenant_id: string; factory_id: string }>(
      `
      SELECT f.tenant_id::text AS tenant_id, f.id::text AS factory_id
      FROM factories f
      INNER JOIN tenants t ON t.id = f.tenant_id
      WHERE t.status = 'ACTIVE' AND f.status = 'ACTIVE'
      ORDER BY f.created_at, f.id
      LIMIT 100
      `,
    );
    const sameTenant = factories.rows.filter((row) => row.tenant_id === factories.rows[0]?.tenant_id);
    if (sameTenant.length < 2) {
      throw new Error('Inventory integration tests require two active factories in the same tenant');
    }
    tenantId = sameTenant[0]!.tenant_id;
    factoryAId = sameTenant[0]!.factory_id;
    factoryBId = sameTenant.find((row) => row.factory_id !== factoryAId)!.factory_id;

    const user = await adminPool.query('SELECT 1 FROM users WHERE id = $1', [TEST_USER_ID]);
    if (user.rowCount !== 1) throw new Error('Inventory test user is missing: ' + TEST_USER_ID);

    database = createIntegrationDatabase(appPool) as never;
    inventory = new InventoryService(
      database,
      { record: jest.fn().mockResolvedValue('audit-id') } as unknown as AuditService,
    );
  });

  afterAll(async () => {
    if (appPool) await appPool.end();
    if (adminPool) await adminPool.end();
  });

  it('records a receipt as an immutable movement, updates stock and emits the outbox event', async () => {
    const item = await createItem();
    const result = await movement(item.id, InventoryMovementType.RECEIPT, 25.5);
    expect(result.replayed).toBe(false);
    expect(result.movement.item_id).toBe(item.id);
    expect(result.movement.quantity_delta).toBe('25.500000');
    expect(result.movement.on_hand_after).toBe('25.500000');

    const balance = await inventory.listBalances(tenantId, factoryAId, { item_id: item.id });
    expect(balance.balances).toHaveLength(1);
    expect(balance.balances[0]).toMatchObject({ item_id: item.id, on_hand_quantity: '25.500000' });

    const event = await adminPool.query(
      `
      SELECT event_type, payload
      FROM outbox_events
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event_type = 'INVENTORY.MOVEMENT_RECORDED'
      `,
      [tenantId, result.movement.id],
    );
    expect(event.rowCount).toBe(1);
    expect(event.rows[0]?.payload).toMatchObject({ movement_id: result.movement.id, item_id: item.id });
  });

  it('replays the same idempotency key without applying stock or emitting another event', async () => {
    const item = await createItem();
    const key = 'retry-' + randomUUID();
    const first = await movement(item.id, InventoryMovementType.RECEIPT, 6, key);
    const retry = await movement(item.id, InventoryMovementType.RECEIPT, 6, key);
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.movement.id).toBe(first.movement.id);

    const balance = await inventory.listBalances(tenantId, factoryAId, { item_id: item.id });
    expect(balance.balances[0]?.on_hand_quantity).toBe('6.000000');

    const count = await adminPool.query(
      'SELECT COUNT(*)::int AS count FROM inventory_movements WHERE tenant_id = $1 AND item_id = $2 AND idempotency_key = $3',
      [tenantId, item.id, key],
    );
    expect(count.rows[0]?.count).toBe(1);
    const events = await adminPool.query(
      "SELECT COUNT(*)::int AS count FROM outbox_events WHERE tenant_id = $1 AND aggregate_id = $2 AND event_type = 'INVENTORY.MOVEMENT_RECORDED'",
      [tenantId, first.movement.id],
    );
    expect(events.rows[0]?.count).toBe(1);
  });

  it('rejects reusing an idempotency key with a changed movement payload', async () => {
    const item = await createItem();
    const key = 'different-payload-' + randomUUID();
    await movement(item.id, InventoryMovementType.RECEIPT, 4, key);
    await expect(movement(item.id, InventoryMovementType.RECEIPT, 5, key))
      .rejects.toThrow('Idempotency-Key was already used for a different inventory movement');
    const balance = await inventory.listBalances(tenantId, factoryAId, { item_id: item.id });
    expect(balance.balances[0]?.on_hand_quantity).toBe('4.000000');
  });

  it('rejects issues that would make stock negative without changing the ledger or balance', async () => {
    const item = await createItem();
    await movement(item.id, InventoryMovementType.RECEIPT, 5);
    await expect(movement(item.id, InventoryMovementType.ISSUE, -6))
      .rejects.toThrow('Inventory movement would make the stock balance negative');

    const balance = await inventory.listBalances(tenantId, factoryAId, { item_id: item.id });
    expect(balance.balances[0]?.on_hand_quantity).toBe('5.000000');
    const movements = await inventory.listMovements(tenantId, factoryAId, { item_id: item.id });
    expect(movements.movements).toHaveLength(1);
  });

  it('serializes concurrent issues to prevent overselling a balance', async () => {
    const item = await createItem();
    await movement(item.id, InventoryMovementType.RECEIPT, 5);
    const attempts = await Promise.allSettled([
      movement(item.id, InventoryMovementType.ISSUE, -4),
      movement(item.id, InventoryMovementType.ISSUE, -4),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    const balance = await inventory.listBalances(tenantId, factoryAId, { item_id: item.id });
    expect(balance.balances[0]?.on_hand_quantity).toBe('1.000000');
  });

  it('does not expose balances from another factory in the same tenant', async () => {
    const item = await createItem();
    await movement(item.id, InventoryMovementType.RECEIPT, 3);
    const otherFactory = await inventory.listBalances(tenantId, factoryBId, { item_id: item.id });
    expect(otherFactory.balances).toHaveLength(0);
  });

  it('rejects mutation of the immutable movement ledger at the database boundary', async () => {
    const item = await createItem();
    const result = await movement(item.id, InventoryMovementType.RECEIPT, 1);
    await expect(
      adminPool.query('UPDATE inventory_movements SET reason = $1 WHERE id = $2', ['Tampered ledger row', result.movement.id]),
    ).rejects.toThrow('Inventory movement ledger is append-only');
  });
});
