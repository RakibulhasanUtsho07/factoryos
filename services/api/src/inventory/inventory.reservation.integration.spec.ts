import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { createIntegrationDatabase } from '../database/integration-database.adapter';
import { CreateInventoryReservationDto } from './dto/create-inventory-reservation.dto';
import { TransitionInventoryReservationDto } from './dto/transition-inventory-reservation.dto';
import { InventoryReservationService } from './inventory.reservation.service';

describe('Inventory reservation FEFO/partial issue PostgreSQL integration', () => {
  const TEST_USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';

  let adminPool!: Pool;
  let appPool!: Pool;
  let service!: InventoryReservationService;
  let tenantId!: string;
  let factoryId!: string;
  const itemIds: string[] = [];

  const createItem = async (quantityOnHand: string): Promise<string> => {
    const created = await adminPool.query<{ id: string }>(
      `
      INSERT INTO inventory_items (
        tenant_id, factory_id, sku, name, unit, created_by_user_id
      )
      VALUES ($1, $2, $3, $4, 'PCS', $5)
      RETURNING id::text AS id
      `,
      [tenantId, factoryId, 'WMS-ALLOC-' + randomUUID(), 'WMS allocation integration item', TEST_USER_ID],
    );
    const itemId = created.rows[0]?.id;
    if (!itemId) throw new Error('WMS allocation test item was not created');
    itemIds.push(itemId);

    await adminPool.query(
      `
      INSERT INTO inventory_stock_balances (
        tenant_id, factory_id, item_id, quantity_on_hand, quantity_reserved
      )
      VALUES ($1, $2, $3, $4::numeric, 0)
      `,
      [tenantId, factoryId, itemId, quantityOnHand],
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

    const context = await adminPool.query<{ tenant_id: string; factory_id: string }>(
      `
      SELECT t.id::text AS tenant_id, f.id::text AS factory_id
      FROM tenants t
      JOIN factories f ON f.tenant_id = t.id
      WHERE t.status = 'ACTIVE' AND f.status = 'ACTIVE'
      ORDER BY t.created_at, f.created_at
      LIMIT 1
      `,
    );
    if (!context.rows[0]) throw new Error('No active tenant/factory exists for WMS integration tests');
    tenantId = context.rows[0].tenant_id;
    factoryId = context.rows[0].factory_id;

    const actor = await adminPool.query('SELECT id FROM users WHERE id = $1 LIMIT 1', [TEST_USER_ID]);
    if (!actor.rows[0]) throw new Error('WMS integration test actor is missing');

    const db = createIntegrationDatabase(appPool);
    const audit = { record: async () => undefined } as unknown as AuditService;
    service = new InventoryReservationService(db as never, audit);
  });

  afterAll(async () => {
    try {
      if (adminPool && itemIds.length > 0) {
        // Test-only cleanup bypasses append-only/lifecycle triggers after all assertions.
        const triggerTables = [
          'inventory_reservation_consumption_traceability_allocations',
          'inventory_reservation_consumptions',
          'inventory_reservation_traceability_allocations',
          'inventory_reservations',
          'inventory_movements',
          'inventory_location_balances',
          'inventory_stock_balances',
        ];
        for (const table of triggerTables) {
          await adminPool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
        }
        try {
          await adminPool.query(
            `
            DELETE FROM outbox_events
            WHERE aggregate_id = ANY($1::uuid[])
               OR aggregate_id IN (
                 SELECT id FROM inventory_reservations WHERE item_id = ANY($1::uuid[])
                 UNION SELECT id FROM inventory_reservation_consumptions WHERE item_id = ANY($1::uuid[])
               )
            `,
            [itemIds],
          );
          await adminPool.query(
            'DELETE FROM inventory_reservation_consumption_traceability_allocations WHERE consumption_id IN (SELECT id FROM inventory_reservation_consumptions WHERE item_id = ANY($1::uuid[]))',
            [itemIds],
          );
          await adminPool.query('DELETE FROM inventory_reservation_consumptions WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_reservation_traceability_allocations WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_reservations WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_movements WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_location_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_stock_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_items WHERE id = ANY($1::uuid[])', [itemIds]);
        } finally {
          for (const table of triggerTables.reverse()) {
            await adminPool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
          }
        }
      }
    } finally {
      if (appPool) await appPool.end();
      if (adminPool) await adminPool.end();
    }
  });

  it('serializes concurrent reservations and never over-reserves aggregate stock', async () => {
    const itemId = await createItem('10.0000');
    const request = (key: string) => service.createReservation(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { quantity: 7 } as CreateInventoryReservationDto,
      key, null, null,
    );

    const results = await Promise.allSettled([
      request('wms-concurrent-' + randomUUID()),
      request('wms-concurrent-' + randomUUID()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const balances = await adminPool.query<{ quantity_on_hand: string; quantity_reserved: string }>(
      'SELECT quantity_on_hand::text, quantity_reserved::text FROM inventory_stock_balances WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3',
      [tenantId, factoryId, itemId],
    );
    expect(balances.rows[0]).toMatchObject({ quantity_on_hand: '10.0000', quantity_reserved: '7.0000' });

    const reservationTotals = await adminPool.query<{ remaining: string; count: string }>(
      `SELECT COALESCE(SUM(remaining_quantity),0)::text AS remaining, count(*)::text AS count
       FROM inventory_reservations WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND status='RESERVED'`,
      [tenantId, factoryId, itemId],
    );
    expect(reservationTotals.rows[0]).toMatchObject({ remaining: '7.0000', count: '1' });
  });

  it('replays duplicate create and partial-issue keys without duplicating reservations or movements', async () => {
    const itemId = await createItem('6.0000');
    const reservationKey = 'wms-duplicate-reserve-' + randomUUID();
    const createRequest = () => service.createReservation(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { quantity: 5 } as CreateInventoryReservationDto,
      reservationKey, null, null,
    );
    const concurrentCreates = await Promise.all([createRequest(), createRequest()]);
    expect(concurrentCreates.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(new Set(concurrentCreates.map((result) => result.id)).size).toBe(1);

    const reservationId = concurrentCreates[0]!.id;
    const transition = (key: string, quantity: number) => service.transitionReservation(
      TEST_USER_ID, tenantId, factoryId, itemId, reservationId,
      { target_status: 'CONSUMED', quantity } as TransitionInventoryReservationDto,
      key, null, null,
    );

    const issueKey = 'wms-partial-issue-' + randomUUID();
    const partial = await transition(issueKey, 2);
    const replay = await transition(issueKey, 2);
    expect(partial).toMatchObject({
      status: 'RESERVED', quantity: '5.0000',
      remaining_quantity: '3.0000', consumed_quantity: '2.0000',
      released_quantity: '0.0000', replayed: false,
    });
    expect(replay).toMatchObject({
      id: reservationId, replayed: true,
      consumed_quantity_this_request: '2.0000',
      remaining_quantity: '3.0000', consumed_quantity: '2.0000',
    });

    const completed = await transition('wms-final-issue-' + randomUUID(), 3);
    expect(completed).toMatchObject({
      status: 'CONSUMED', remaining_quantity: '0.0000',
      consumed_quantity: '5.0000', released_quantity: '0.0000',
    });

    const evidence = await adminPool.query<{
      consumption_count: string; movement_count: string; consumed_quantity: string;
    }>(
      `
      SELECT count(c.id)::text AS consumption_count,
             count(DISTINCT m.id)::text AS movement_count,
             COALESCE(sum(c.quantity),0)::text AS consumed_quantity
      FROM inventory_reservation_consumptions c
      JOIN inventory_movements m
        ON m.id = c.movement_id AND m.tenant_id = c.tenant_id AND m.factory_id = c.factory_id
      WHERE c.tenant_id=$1 AND c.factory_id=$2 AND c.item_id=$3 AND c.reservation_id=$4
      `,
      [tenantId, factoryId, itemId, reservationId],
    );
    expect(evidence.rows[0]).toMatchObject({
      consumption_count: '2', movement_count: '2', consumed_quantity: '5.0000',
    });

    const finalState = await adminPool.query<{
      quantity_on_hand: string; quantity_reserved: string;
      status: string; remaining_quantity: string; consumed_quantity: string;
    }>(
      `
      SELECT b.quantity_on_hand::text, b.quantity_reserved::text,
             r.status, r.remaining_quantity::text, r.consumed_quantity::text
      FROM inventory_stock_balances b
      JOIN inventory_reservations r
        ON r.item_id=b.item_id AND r.tenant_id=b.tenant_id AND r.factory_id=b.factory_id
      WHERE b.tenant_id=$1 AND b.factory_id=$2 AND b.item_id=$3 AND r.id=$4
      `,
      [tenantId, factoryId, itemId, reservationId],
    );
    expect(finalState.rows[0]).toMatchObject({
      quantity_on_hand: '1.0000', quantity_reserved: '0.0000',
      status: 'CONSUMED', remaining_quantity: '0.0000', consumed_quantity: '5.0000',
    });
  });
});
