import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { jest } from '@jest/globals';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { InventoryService } from './inventory.service';
import { InventoryLocationService } from './inventory.location.service';
import { InventoryReservationService } from './inventory.reservation.service';
import { TraceabilityService } from './traceability.service';
import { WmsFulfillmentService } from './wms-fulfillment.service';

const postgresDescribe = process.env.TEST_ADMIN_DATABASE_URL ? describe : describe.skip;

postgresDescribe('Inventory locations and bin balances PostgreSQL integration', () => {
  const tenantId = randomUUID();
  const userId = randomUUID();
  let adminPool!: Pool;
  let database!: DatabaseService;
  let locationService!: InventoryLocationService;
  let inventoryService!: InventoryService;
  let reservationService!: InventoryReservationService;
  let traceabilityService!: TraceabilityService;
  let fulfillmentService!: WmsFulfillmentService;
  const factoryIds: string[] = [];
  const traceId = randomUUID();
  const requestId = randomUUID();

  beforeAll(async () => {
    const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
    const appUrl = process.env.DATABASE_URL;
    if (!adminUrl) throw new Error('TEST_ADMIN_DATABASE_URL is required');
    if (!appUrl) throw new Error('DATABASE_URL is required');

    adminPool = new Pool({ connectionString: adminUrl });
    const config = {
      get: (key: string) => key === 'DATABASE_URL' ? appUrl : undefined,
    } as ConfigService;
    database = new DatabaseService(config);
    await database.onModuleInit();

    await adminPool.query(
      `INSERT INTO tenants (id, slug, name, status) VALUES ($1, $2, 'Inventory location test tenant', 'ACTIVE')`,
      [tenantId, 'inventory-location-' + tenantId.slice(0, 8)],
    );
    await adminPool.query(
      `INSERT INTO users (id, external_subject, email, display_name, status)
       VALUES ($1, $2, $3, 'Inventory location test actor', 'ACTIVE')`,
      [userId, 'inventory-location-' + userId, 'inventory-location-' + userId + '@factoryos.test'],
    );

    const audit = { record: async () => randomUUID() } as unknown as AuditService;
    locationService = new InventoryLocationService(database, audit);
    inventoryService = new InventoryService(database, audit);
    reservationService = new InventoryReservationService(database, audit);
    traceabilityService = new TraceabilityService(database);
    fulfillmentService = new WmsFulfillmentService(database);
  }, 60_000);

  afterAll(async () => {
    if (adminPool && factoryIds.length) {
      for (const factoryId of factoryIds) {
        await adminPool.query(
          'ALTER TABLE inventory_reservations DISABLE TRIGGER USER',
        );
        await adminPool.query('ALTER TABLE inventory_reservation_consumptions DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE inventory_reservation_consumption_traceability_allocations DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE inventory_reservation_traceability_allocations DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE inventory_traceability_location_balances DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE traceability_units DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE product_genealogy_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE traceability_unit_status_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE wms_shipment_delivery_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE wms_shipments DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE order_lines DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE orders DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE wms_packing_contents DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE wms_packing_containers DISABLE TRIGGER USER');
        await adminPool.query(
          'ALTER TABLE inventory_location_transfers DISABLE TRIGGER USER',
        );
        await adminPool.query(
          'ALTER TABLE inventory_movements DISABLE TRIGGER USER',
        );
        await adminPool.query(
          'ALTER TABLE inventory_locations DISABLE TRIGGER USER',
        );
        try {
          await adminPool.query(
            'DELETE FROM inventory_location_transfers WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            `DELETE FROM inventory_reservation_consumption_traceability_allocations
             WHERE tenant_id=$1 AND factory_id=$2 AND consumption_id IN (
               SELECT id FROM inventory_reservation_consumptions WHERE tenant_id=$1 AND factory_id=$2
             )`,
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_reservation_consumptions WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_reservation_traceability_allocations WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_traceability_location_balances WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM wms_shipment_delivery_events WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM wms_shipments WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM order_lines WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM orders WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM wms_packing_contents WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM product_genealogy_events WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM traceability_unit_status_events WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM wms_packing_containers WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_material_allocation_policies WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_reservations WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_movements WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM outbox_events WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_location_balances WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_stock_balances WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_items WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            `DELETE FROM inventory_locations WHERE tenant_id = $1 AND factory_id = $2 AND location_type = 'BIN'`,
            [tenantId, factoryId],
          );
          await adminPool.query(
            `DELETE FROM inventory_locations WHERE tenant_id = $1 AND factory_id = $2 AND location_type IN ('WAREHOUSE', 'STAGING')`,
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM inventory_locations WHERE tenant_id = $1 AND factory_id = $2 AND is_default = TRUE',
            [tenantId, factoryId],
          );
          // location/transfer audit records hold a restrictive FK to the factory.
          // Remove only this isolated test factory's evidence before deleting its fixture.
          await adminPool.query(
            'DELETE FROM audit_events WHERE tenant_id = $1 AND factory_id = $2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM factories WHERE tenant_id = $1 AND id = $2',
            [tenantId, factoryId],
          );
        } finally {
          await adminPool.query('ALTER TABLE inventory_traceability_location_balances ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE traceability_units ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE product_genealogy_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE traceability_unit_status_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE wms_shipment_delivery_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE wms_shipments ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE order_lines ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE orders ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE wms_packing_contents ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE wms_packing_containers ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_reservation_traceability_allocations ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_reservation_consumption_traceability_allocations ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_reservation_consumptions ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_reservations ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_location_transfers ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_movements ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE inventory_locations ENABLE TRIGGER USER');
        }
      }
    }
    if (adminPool) {
      await adminPool.query('DELETE FROM users WHERE id = $1', [userId]);
      await adminPool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    await database?.onModuleDestroy();
    await adminPool?.end();
  }, 60_000);

  async function createStockFixture(quantity = '12.0000') {
    const factoryResult = await adminPool.query<{ id: string }>(
      `
      INSERT INTO factories (tenant_id, code, name, status)
      VALUES ($1, $2, 'Location test factory', 'ACTIVE')
      RETURNING id::text AS id
      `,
      [tenantId, 'LOC-' + randomUUID().slice(0, 8)],
    );
    const factoryId = factoryResult.rows[0]?.id;
    if (!factoryId) throw new Error('Location test factory fixture missing');
    factoryIds.push(factoryId);

    const itemResult = await adminPool.query<{ id: string }>(
      `
      INSERT INTO inventory_items (tenant_id, factory_id, sku, name, unit, created_by_user_id)
      VALUES ($1, $2, $3, 'Location test item', 'PCS', $4)
      RETURNING id::text AS id
      `,
      [tenantId, factoryId, 'LOC-SKU-' + randomUUID().slice(0, 8), userId],
    );
    const itemId = itemResult.rows[0]?.id;
    if (!itemId) throw new Error('Location test item fixture missing');

    await adminPool.query(
      `
      INSERT INTO inventory_stock_balances (tenant_id, factory_id, item_id, quantity_on_hand)
      VALUES ($1, $2, $3, $4::numeric)
      `,
      [tenantId, factoryId, itemId, quantity],
    );

    const defaultResult = await adminPool.query<{ id: string }>(
      `
      SELECT id::text AS id FROM inventory_locations
      WHERE tenant_id = $1 AND factory_id = $2 AND is_default = TRUE
      `,
      [tenantId, factoryId],
    );
    if (!defaultResult.rows[0]) throw new Error('New factory did not receive the default location');
    return { factoryId, itemId, defaultLocationId: defaultResult.rows[0].id };
  }

  async function createWarehouseAndBins(factoryId: string) {
    const warehouse = await locationService.createLocation(
      userId, tenantId, factoryId,
      { location_code: 'WH-' + randomUUID().slice(0, 8), name: 'Main warehouse', location_type: 'WAREHOUSE' },
      requestId, traceId,
    );
    const binA = await locationService.createLocation(
      userId, tenantId, factoryId,
      { location_code: 'BIN-A-' + randomUUID().slice(0, 8), name: 'Fabric bin A', location_type: 'BIN', parent_location_id: warehouse.id },
      requestId, traceId,
    );
    const binB = await locationService.createLocation(
      userId, tenantId, factoryId,
      { location_code: 'BIN-B-' + randomUUID().slice(0, 8), name: 'Fabric bin B', location_type: 'BIN', parent_location_id: warehouse.id },
      requestId, traceId,
    );
    return { warehouse, binA, binB };
  }

  async function readAggregate(factoryId: string, itemId: string) {
    const result = await adminPool.query<{ quantity_on_hand: string; quantity_reserved: string }>(
      `
      SELECT quantity_on_hand::text AS quantity_on_hand,
             quantity_reserved::text AS quantity_reserved
      FROM inventory_stock_balances
      WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
      `,
      [tenantId, factoryId, itemId],
    );
    return result.rows[0];
  }

  async function readBinTotals(factoryId: string, itemId: string) {
    const result = await adminPool.query<{ sum: string; count: number }>(
      `
      SELECT COALESCE(SUM(quantity_on_hand), 0)::text AS sum, COUNT(*)::int AS count
      FROM inventory_location_balances
      WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3
      `,
      [tenantId, factoryId, itemId],
    );
    return result.rows[0];
  }

  it('seeds new factories with a default location and maintains bin totals across idempotent transfers', async () => {
    const fixture = await createStockFixture();
    const { binA, binB } = await createWarehouseAndBins(fixture.factoryId);

    const locationEvent = await adminPool.query<{ aggregate_type: string }>(
      `
      SELECT aggregate_type FROM outbox_events
      WHERE tenant_id = $1 AND factory_id = $2
        AND aggregate_id = $3 AND event_type = 'INVENTORY.LOCATION_CREATED'
      ORDER BY created_at DESC LIMIT 1
      `,
      [tenantId, fixture.factoryId, binA.id],
    );
    expect(locationEvent.rows[0]?.aggregate_type).toBe('INVENTORY_LOCATION');

    const payload = {
      source_location_id: fixture.defaultLocationId,
      destination_location_id: binA.id,
      quantity: 7,
      notes: 'Put stock away after receiving',
    };
    const moved = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      payload, 'location-transfer-001', requestId, traceId,
    );
    expect(moved.quantity).toBe('7.0000');
    expect(moved.source_quantity_after).toBe('5.0000');
    expect(moved.destination_quantity_after).toBe('7.0000');
    expect(moved.replayed).toBe(false);

    const transferEvent = await adminPool.query<{ aggregate_type: string }>(
      `
      SELECT aggregate_type FROM outbox_events
      WHERE tenant_id = $1 AND factory_id = $2
        AND aggregate_id = $3 AND event_type = 'INVENTORY.STOCK_LOCATION_TRANSFERRED'
      ORDER BY created_at DESC LIMIT 1
      `,
      [tenantId, fixture.factoryId, fixture.itemId],
    );
    expect(transferEvent.rows[0]?.aggregate_type).toBe('INVENTORY_ITEM');

    const replay = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      payload, 'location-transfer-001', requestId, traceId,
    );
    expect(replay.id).toBe(moved.id);
    expect(replay.replayed).toBe(true);
    await expect(locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      { ...payload, quantity: 6 }, 'location-transfer-001', requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const bins = await locationService.listItemBalances(
      tenantId, fixture.factoryId, fixture.itemId,
    );
    const binAResult = bins.find((row) => row.location_id === binA.id);
    const defaultResult = bins.find((row) => row.location_id === fixture.defaultLocationId);
    expect(binAResult?.quantity_on_hand).toBe('7.0000');
    expect(defaultResult?.quantity_on_hand).toBe('5.0000');
    expect(bins.find((row) => row.location_id === binB.id)?.quantity_on_hand).toBe('0.0000');

    const aggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    const totals = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(aggregate?.quantity_on_hand).toBe('12.0000');
    expect(totals?.sum).toBe(aggregate?.quantity_on_hand);
    expect(totals?.count).toBe(2);

    const transfers = await locationService.listTransfers(
      tenantId, fixture.factoryId, fixture.itemId,
    );
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.id).toBe(moved.id);

    const metadata = await adminPool.query<{ rls: boolean; forced: boolean }>(
      `
      SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c
      WHERE c.oid = 'inventory_location_balances'::regclass
      `,
    );
    expect(metadata.rows[0]).toEqual({ rls: true, forced: true });

    await expect(adminPool.query(
      'UPDATE inventory_location_transfers SET notes = $1 WHERE id = $2',
      ['tampered', moved.id],
    )).rejects.toMatchObject({ code: '55000' });
  });

  it('pins a reservation to a BIN, prevents transfers through reserved stock and consumes from the same BIN', async () => {
    const fixture = await createStockFixture('12.0000');
    const { binA, binB } = await createWarehouseAndBins(fixture.factoryId);

    await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 7,
      },
      'bin-reservation-seed-transfer', requestId, traceId,
    );

    const reservePayload = { quantity: 5, location_id: binA.id };
    const reservation = await reservationService.createReservation(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      reservePayload, 'bin-reservation-create', requestId, traceId,
    );
    expect(reservation).toMatchObject({
      status: 'RESERVED',
      location_id: binA.id,
      quantity: '5.0000',
      replayed: false,
    });

    const replay = await reservationService.createReservation(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      reservePayload, 'bin-reservation-create', requestId, traceId,
    );
    expect(replay).toMatchObject({ id: reservation.id, replayed: true, location_id: binA.id });

    const beforeTransfer = await locationService.listItemBalances(
      tenantId, fixture.factoryId, fixture.itemId,
    );
    expect(beforeTransfer.find((row) => row.location_id === binA.id)).toMatchObject({
      quantity_on_hand: '7.0000',
      location_quantity_reserved: '5.0000',
      location_quantity_available: '2.0000',
    });

    await expect(locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: binA.id,
        destination_location_id: binB.id,
        quantity: 3,
      },
      'bin-reservation-blocked-transfer', requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const consumed = await reservationService.transitionReservation(
      userId, tenantId, fixture.factoryId, fixture.itemId, reservation.id,
      { target_status: 'CONSUMED' },
      'bin-reservation-consume', requestId, traceId,
    );
    expect(consumed).toMatchObject({
      status: 'CONSUMED',
      location_id: binA.id,
      consumed_movement_id: expect.any(String),
    });

    const movement = await adminPool.query<{ location_id: string | null }>(
      'SELECT location_id::text AS location_id FROM inventory_movements WHERE id = $1',
      [consumed.consumed_movement_id],
    );
    expect(movement.rows[0]?.location_id).toBe(binA.id);

    const releasedReservation = await reservationService.createReservation(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      { quantity: 1, location_id: binA.id }, 'bin-reservation-release-create', requestId, traceId,
    );
    const released = await reservationService.transitionReservation(
      userId, tenantId, fixture.factoryId, fixture.itemId, releasedReservation.id,
      { target_status: 'RELEASED' },
      'bin-reservation-release', requestId, traceId,
    );
    expect(released.status).toBe('RELEASED');

    const aggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    const totals = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(aggregate).toMatchObject({
      quantity_on_hand: '7.0000',
      quantity_reserved: '0.0000',
    });
    expect(totals?.sum).toBe(aggregate?.quantity_on_hand);

    const after = await locationService.listItemBalances(
      tenantId, fixture.factoryId, fixture.itemId,
    );
    expect(after.find((row) => row.location_id === binA.id)).toMatchObject({
      quantity_on_hand: '2.0000',
      location_quantity_reserved: '0.0000',
      location_quantity_available: '2.0000',
    });
  });

  it('rejects direct bin reserved-balance drift that has no matching active reservation', async () => {
    const fixture = await createStockFixture('12.0000');
    const { binA } = await createWarehouseAndBins(fixture.factoryId);

    await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 7,
      },
      'reserved-balance-guard-' + randomUUID(), requestId, traceId,
    );

    await expect(adminPool.query(
      `UPDATE inventory_location_balances
       SET quantity_reserved = quantity_reserved + 1
       WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3 AND location_id = $4`,
      [tenantId, fixture.factoryId, fixture.itemId, binA.id],
    )).rejects.toMatchObject({ code: '23514' });

    const balance = await adminPool.query<{ quantity_reserved: string }>(
      `SELECT quantity_reserved::text AS quantity_reserved
       FROM inventory_location_balances
       WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3 AND location_id = $4`,
      [tenantId, fixture.factoryId, fixture.itemId, binA.id],
    );
    expect(balance.rows[0]?.quantity_reserved).toBe('0.0000');
  });

  it('keeps location balances aligned when receipts/issues target a bin or use the legacy aggregate path', async () => {
    const fixture = await createStockFixture();
    const { binA, binB } = await createWarehouseAndBins(fixture.factoryId);

    await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 7,
      },
      'location-transfer-002', requestId, traceId,
    );

    const issued = await inventoryService.createStockMovement(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      { movement_type: 'ISSUE', quantity: 2, location_id: binA.id },
      'bin-issue-001', requestId, traceId,
    );
    expect(issued.location_id).toBe(binA.id);
    expect(issued.quantity_after).toBe('10.0000');

    const receipt = await inventoryService.createStockMovement(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      { movement_type: 'RECEIPT', quantity: 1.5, location_id: binB.id },
      'bin-receipt-001', requestId, traceId,
    );
    expect(receipt.location_id).toBe(binB.id);
    expect(receipt.quantity_after).toBe('11.5000');

    await inventoryService.createStockMovement(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      { movement_type: 'ISSUE', quantity: 3 },
      'aggregate-issue-001', requestId, traceId,
    );

    const aggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    const totals = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(aggregate?.quantity_on_hand).toBe('8.5000');
    expect(totals?.sum).toBe(aggregate?.quantity_on_hand);

    const binRows = await locationService.listItemBalances(
      tenantId, fixture.factoryId, fixture.itemId,
    );
    expect(binRows.find((row) => row.location_id === binA.id)?.quantity_on_hand).toBe('5.0000');
    expect(binRows.find((row) => row.location_id === binB.id)?.quantity_on_hand).toBe('1.5000');
    expect(binRows.find((row) => row.location_id === fixture.defaultLocationId)?.quantity_on_hand).toBe('2.0000');
  });

  it('rejects invalid parent scope, insufficient source stock, and transfers that would encroach on reserved stock', async () => {
    const fixture = await createStockFixture('12.0000');
    const otherFactoryResult = await adminPool.query<{ id: string }>(
      `
      INSERT INTO factories (tenant_id, code, name, status)
      VALUES ($1, $2, 'Other location test factory', 'ACTIVE')
      RETURNING id::text AS id
      `,
      [tenantId, 'LOC-OTHER-' + randomUUID().slice(0, 8)],
    );
    const otherFactoryId = otherFactoryResult.rows[0]?.id;
    if (!otherFactoryId) throw new Error('Cross-scope factory fixture missing');
    factoryIds.push(otherFactoryId);

    const otherWarehouse = await locationService.createLocation(
      userId, tenantId, otherFactoryId,
      { location_code: 'OTHER-WH-' + randomUUID().slice(0, 8), name: 'Other warehouse', location_type: 'WAREHOUSE' },
      requestId, traceId,
    );
    await expect(locationService.createLocation(
      userId, tenantId, fixture.factoryId,
      { location_code: 'BAD-BIN-' + randomUUID().slice(0, 8), name: 'Cross-factory bin', location_type: 'BIN', parent_location_id: otherWarehouse.id },
      requestId, traceId,
    )).rejects.toBeInstanceOf(BadRequestException);

    const { binA } = await createWarehouseAndBins(fixture.factoryId);
    await expect(locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 13,
      },
      'location-overdraw-001', requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    await adminPool.query(
      'UPDATE inventory_stock_balances SET quantity_reserved = 10 WHERE tenant_id = $1 AND factory_id = $2 AND item_id = $3',
      [tenantId, fixture.factoryId, fixture.itemId],
    );
    await expect(locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 3,
      },
      'location-reserved-001', requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);
  });
  it('enforces directed put-away/pick policies without stealing reserved stock', async () => {
    const fixture = await createStockFixture('12.0000');
    const { warehouse, binA, binB } = await createWarehouseAndBins(fixture.factoryId);
    const staging = await locationService.createLocation(
      userId, tenantId, fixture.factoryId,
      {
        location_code: 'STAGE-' + randomUUID().slice(0, 8),
        name: 'Production staging',
        location_type: 'STAGING',
      },
      requestId, traceId,
    );

    expect(warehouse).toMatchObject({ putaway_enabled: false, picking_enabled: false });
    expect(binA).toMatchObject({ putaway_enabled: true, picking_enabled: true });
    await locationService.updateLocationPolicy(
      userId, tenantId, fixture.factoryId, binA.id,
      { putaway_priority: 50 }, requestId, traceId,
    );
    await locationService.updateLocationPolicy(
      userId, tenantId, fixture.factoryId, binB.id,
      { putaway_priority: 10, picking_priority: 5 }, requestId, traceId,
    );

    const targets = await locationService.listPutawayTargets(tenantId, fixture.factoryId, fixture.itemId);
    expect(targets[0]).toMatchObject({ location_id: binB.id, putaway_priority: 10 });

    const putawayKey = 'directed-putaway-' + randomUUID();
    const putaway = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 7,
        movement_purpose: 'PUT_AWAY',
        notes: 'Directed put-away after receipt',
      },
      putawayKey, requestId, traceId,
    );
    expect(putaway).toMatchObject({
      movement_purpose: 'PUT_AWAY',
      source_quantity_after: '5.0000',
      destination_quantity_after: '7.0000',
    });
    const putawayReplay = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 7,
        movement_purpose: 'PUT_AWAY',
        notes: 'Directed put-away after receipt',
      },
      putawayKey, requestId, traceId,
    );
    expect(putawayReplay).toMatchObject({ id: putaway.id, replayed: true, movement_purpose: 'PUT_AWAY' });
    await expect(locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 7,
        notes: 'Directed put-away after receipt',
      },
      putawayKey, requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const reservation = await reservationService.createReservation(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      { quantity: 5, location_id: binA.id },
      'directed-pick-reserve-' + randomUUID(), requestId, traceId,
    );
    const sources = await locationService.listPickSources(tenantId, fixture.factoryId, fixture.itemId);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      location_id: binA.id,
      quantity_on_hand: '7.0000',
      quantity_reserved: '5.0000',
      quantity_available: '2.0000',
    });

    await expect(locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: binA.id,
        destination_location_id: staging.id,
        quantity: 3,
        movement_purpose: 'PICK',
      },
      'directed-pick-over-reservation-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const picked = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: binA.id,
        destination_location_id: staging.id,
        quantity: 2,
        movement_purpose: 'PICK',
        notes: 'Move only unreserved stock to staging',
      },
      'directed-pick-' + randomUUID(), requestId, traceId,
    );
    expect(picked).toMatchObject({
      movement_purpose: 'PICK',
      source_quantity_after: '5.0000',
      destination_quantity_after: '2.0000',
    });

    await expect(locationService.updateLocationPolicy(
      userId, tenantId, fixture.factoryId, binA.id,
      { picking_enabled: false }, requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(adminPool.query(
      `UPDATE inventory_locations SET status = 'DISABLED'
       WHERE tenant_id = $1 AND factory_id = $2 AND id = $3`,
      [tenantId, fixture.factoryId, binA.id],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(inventoryService.createStockMovement(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      { movement_type: 'RECEIPT', quantity: 1, location_id: warehouse.id },
      'warehouse-direct-receipt-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const consumed = await reservationService.transitionReservation(
      userId, tenantId, fixture.factoryId, fixture.itemId, reservation.id,
      { target_status: 'CONSUMED' },
      'directed-pick-consume-' + randomUUID(), requestId, traceId,
    );
    expect(consumed).toMatchObject({ status: 'CONSUMED', location_id: binA.id });

    const aggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    const totals = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(aggregate).toMatchObject({
      quantity_on_hand: '7.0000',
      quantity_reserved: '0.0000',
    });
    expect(totals?.sum).toBe(aggregate?.quantity_on_hand);

    const after = await locationService.listItemBalances(
      tenantId, fixture.factoryId, fixture.itemId,
    );
    expect(after.find((row) => row.location_id === fixture.defaultLocationId)?.quantity_on_hand).toBe('5.0000');
    expect(after.find((row) => row.location_id === binA.id)).toMatchObject({
      quantity_on_hand: '0.0000',
      location_quantity_reserved: '0.0000',
    });
    expect(after.find((row) => row.location_id === staging.id)?.quantity_on_hand).toBe('2.0000');

    const moves = await locationService.listTransfers(tenantId, fixture.factoryId, fixture.itemId);
    expect(moves.filter((move) => move.movement_purpose === 'PUT_AWAY')).toHaveLength(1);
    expect(moves.filter((move) => move.movement_purpose === 'PICK')).toHaveLength(1);
  });


  it('puts away, transfers and picks finished-good lots without losing location-level identity', async () => {
    const fixture = await createStockFixture('5.0000');
    const { binA, binB } = await createWarehouseAndBins(fixture.factoryId);
    const staging = await locationService.createLocation(
      userId, tenantId, fixture.factoryId,
      {
        location_code: 'FG-STAGE-' + randomUUID().slice(0, 8),
        name: 'Finished goods staging',
        location_type: 'STAGING',
      },
      requestId, traceId,
    );

    const createdLot = await traceabilityService.createUnit(
      userId, tenantId, fixture.factoryId,
      {
        unit_type: 'LOT',
        product_role: 'FINISHED_GOOD',
        unit_code: 'FG-LOT-' + randomUUID().slice(0, 8),
        inventory_item_id: fixture.itemId,
        quantity: 5,
        unit: 'PCS',
        external_reference: 'wms-finished-good-putaway-test',
      } as never,
      'fg-lot-register-' + randomUUID(), requestId, traceId,
    );
    const finishedLotId = createdLot.id;
    await adminPool.query(
      `INSERT INTO inventory_traceability_location_balances
         (tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand)
       VALUES ($1, $2, $3, $4, $5, 5.0000)`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLotId, fixture.defaultLocationId],
    );

    await expect(locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 1,
        movement_purpose: 'PUT_AWAY',
      },
      'fg-lot-missing-id-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    await expect(adminPool.query(
      `INSERT INTO inventory_location_transfers (
         tenant_id, factory_id, item_id, source_location_id, destination_location_id,
         quantity, source_quantity_before, source_quantity_after,
         destination_quantity_before, destination_quantity_after,
         idempotency_key, request_hash, created_by_user_id, correlation_id,
         movement_purpose
       ) VALUES ($1,$2,$3,$4,$5,1,5,4,0,1,$6,$7,$8,$9,'PUT_AWAY')`,
      [
        tenantId, fixture.factoryId, fixture.itemId, fixture.defaultLocationId, binA.id,
        'fg-lot-db-bypass-' + randomUUID(), 'a'.repeat(64), userId, traceId,
      ],
    )).rejects.toMatchObject({ code: '23514' });

    const putAwayPayload = {
      source_location_id: fixture.defaultLocationId,
      destination_location_id: binA.id,
      quantity: 3,
      movement_purpose: 'PUT_AWAY' as const,
      traceability_unit_id: finishedLotId,
    };
    const putAwayKey = 'fg-lot-putaway-' + randomUUID();
    const putAway = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      putAwayPayload, putAwayKey, requestId, traceId,
    );
    expect(putAway).toMatchObject({
      movement_purpose: 'PUT_AWAY',
      traceability_unit_id: finishedLotId,
      source_quantity_after: '2.0000',
      destination_quantity_after: '3.0000',
      replayed: false,
    });
    const putAwayReplay = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      putAwayPayload, putAwayKey, requestId, traceId,
    );
    expect(putAwayReplay).toMatchObject({ id: putAway.id, traceability_unit_id: finishedLotId, replayed: true });

    const moved = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: binA.id,
        destination_location_id: binB.id,
        quantity: 1,
        traceability_unit_id: finishedLotId,
      },
      'fg-lot-bin-transfer-' + randomUUID(), requestId, traceId,
    );
    expect(moved.traceability_unit_id).toBe(finishedLotId);

    const picked = await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: binA.id,
        destination_location_id: staging.id,
        quantity: 1,
        movement_purpose: 'PICK',
        traceability_unit_id: finishedLotId,
      },
      'fg-lot-pick-' + randomUUID(), requestId, traceId,
    );
    expect(picked).toMatchObject({ movement_purpose: 'PICK', traceability_unit_id: finishedLotId });

    const identityBalances = await adminPool.query<{
      location_id: string; quantity_on_hand: string; quantity_reserved: string;
    }>(
      `SELECT location_id::text AS location_id, quantity_on_hand::text AS quantity_on_hand,
              quantity_reserved::text AS quantity_reserved
       FROM inventory_traceability_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND traceability_unit_id=$4
       ORDER BY location_id`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLotId],
    );
    expect(identityBalances.rows).toHaveLength(4);
    expect(identityBalances.rows.reduce((sum, row) => sum + Number(row.quantity_on_hand), 0)).toBeCloseTo(5, 4);
    expect(identityBalances.rows.every((row) => row.quantity_reserved === '0.0000')).toBe(true);
    expect(identityBalances.rows.find((row) => row.location_id === fixture.defaultLocationId)?.quantity_on_hand).toBe('2.0000');
    expect(identityBalances.rows.find((row) => row.location_id === binA.id)?.quantity_on_hand).toBe('1.0000');
    expect(identityBalances.rows.find((row) => row.location_id === binB.id)?.quantity_on_hand).toBe('1.0000');
    expect(identityBalances.rows.find((row) => row.location_id === staging.id)?.quantity_on_hand).toBe('1.0000');

    const aggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    const totals = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(aggregate?.quantity_on_hand).toBe('5.0000');
    expect(totals?.sum).toBe(aggregate?.quantity_on_hand);

    const movements = await locationService.listTransfers(tenantId, fixture.factoryId, fixture.itemId);
    expect(movements.filter((move) => move.traceability_unit_id === finishedLotId)).toHaveLength(3);
  });


  it('packs a finished-good lot into a carton and pallet, then dispatches once with stock and customer traceability', async () => {
    const fixture = await createStockFixture('5.0000');
    const { binA } = await createWarehouseAndBins(fixture.factoryId);
    const finishedLot = await traceabilityService.createUnit(
      userId, tenantId, fixture.factoryId,
      {
        unit_type: 'LOT',
        product_role: 'FINISHED_GOOD',
        unit_code: 'FG-SHIP-' + randomUUID().slice(0, 8),
        inventory_item_id: fixture.itemId,
        quantity: 5,
        unit: 'PCS',
        external_reference: 'wms-finished-good-putaway-test',
      } as never,
      'fg-ship-register-' + randomUUID(), requestId, traceId,
    );
    await adminPool.query(
      `INSERT INTO inventory_traceability_location_balances
         (tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand)
       VALUES ($1,$2,$3,$4,$5,5.0000)`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLot.id, fixture.defaultLocationId],
    );
    await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 5,
        movement_purpose: 'PUT_AWAY',
        traceability_unit_id: finishedLot.id,
      },
      'fg-ship-putaway-' + randomUUID(), requestId, traceId,
    );

    const carton = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'CARTON',
        container_code: 'CARTON-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId,
        location_id: binA.id,
        capacity_quantity: 3,
      },
      'wms-carton-create-' + randomUUID(), requestId, traceId,
    );
    const cartonId = carton.container.container_unit_id as string;
    await fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, cartonId,
      { source_unit_id: finishedLot.id, quantity: 3 },
      'wms-carton-content-' + randomUUID(), requestId, traceId,
    );
    const duplicateCarton = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'CARTON',
        container_code: 'CARTON-DUP-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId,
        location_id: binA.id,
        capacity_quantity: 3,
      },
      'wms-carton-dup-create-' + randomUUID(), requestId, traceId,
    );
    await expect(fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, duplicateCarton.container.container_unit_id as string,
      { source_unit_id: finishedLot.id, quantity: 3 },
      'wms-carton-dup-content-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    // Container capacity is an independent guard from available stock.
    await expect(fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, cartonId,
      { source_unit_id: finishedLot.id, quantity: 0.1 },
      'wms-carton-over-capacity-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);
    const packingCommitmentClient = await adminPool.connect();
    try {
      await packingCommitmentClient.query('BEGIN');
      await packingCommitmentClient.query(
        `UPDATE inventory_traceability_location_balances
         SET quantity_on_hand=2.0000, version=version+1, updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3
           AND traceability_unit_id=$4 AND location_id=$5`,
        [tenantId, fixture.factoryId, fixture.itemId, finishedLot.id, binA.id],
      );
      await expect(packingCommitmentClient.query('COMMIT'))
        .rejects.toThrow(/active carton packing commitments/i);
      await packingCommitmentClient.query('ROLLBACK').catch(() => undefined);
    } finally {
      packingCommitmentClient.release();
    }
    const afterRejectedIssue = await adminPool.query<{ quantity_on_hand: string }>(
      `SELECT quantity_on_hand::text AS quantity_on_hand
       FROM inventory_traceability_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3
         AND traceability_unit_id=$4 AND location_id=$5`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLot.id, binA.id],
    );
    expect(afterRejectedIssue.rows[0]?.quantity_on_hand).toBe('5.0000');
    const cartonSealKey = 'wms-carton-seal-' + randomUUID();
    await fulfillmentService.sealContainer(
      userId, tenantId, fixture.factoryId, cartonId, cartonSealKey, requestId, traceId,
    );
    const cartonSealReplay = await fulfillmentService.sealContainer(
      userId, tenantId, fixture.factoryId, cartonId, cartonSealKey, requestId, traceId,
    );
    expect(cartonSealReplay.replayed).toBe(true);

    const pallet = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'PALLET',
        container_code: 'PALLET-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId,
        location_id: binA.id,
        capacity_quantity: 3,
      },
      'wms-pallet-create-' + randomUUID(), requestId, traceId,
    );
    const palletId = pallet.container.container_unit_id as string;
    await fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, palletId,
      { source_unit_id: cartonId, quantity: 3 },
      'wms-pallet-content-' + randomUUID(), requestId, traceId,
    );
    await fulfillmentService.sealContainer(
      userId, tenantId, fixture.factoryId, palletId, 'wms-pallet-seal-' + randomUUID(), requestId, traceId,
    );
    await expect(fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, cartonId,
      {
        shipment_code: 'SHIP-CARTON-BLOCK-' + randomUUID().slice(0, 5),
        customer_name: 'Acceptance Customer',
        customer_order_reference: 'ORDER-CARTON-BLOCK-' + randomUUID().slice(0, 5),
      },
      'wms-carton-dispatch-block-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const dispatchKey = 'wms-dispatch-' + randomUUID();
    const dispatchPayload = {
      shipment_code: 'SHIP-' + randomUUID().slice(0, 8),
      customer_name: 'Acceptance Customer',
      customer_order_reference: 'CUSTOMER-ORDER-' + randomUUID().slice(0, 8),
      carrier_name: 'Acceptance Carrier',
      tracking_reference: 'TRACK-' + randomUUID().slice(0, 8),
    };
    const dispatched = await fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, palletId, dispatchPayload,
      dispatchKey, requestId, traceId,
    );
    expect(dispatched).toMatchObject({ replayed: false, shipment: {
      container_unit_id: palletId,
      item_id: fixture.itemId,
      quantity: '3.0000',
      customer_name: dispatchPayload.customer_name,
      customer_order_reference: dispatchPayload.customer_order_reference,
      status: 'DISPATCHED',
    }});
    const replayed = await fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, palletId, dispatchPayload,
      dispatchKey, requestId, traceId,
    );
    expect(replayed).toMatchObject({ replayed: true, shipment: { shipment_unit_id: dispatched.shipment.shipment_unit_id } });
    await expect(fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, palletId,
      { ...dispatchPayload, shipment_code: 'SHIP-REPLAY-BLOCK' },
      'wms-dispatch-duplicate-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const aggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    const locationTotals = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(aggregate?.quantity_on_hand).toBe('2.0000');
    expect(locationTotals?.sum).toBe(aggregate?.quantity_on_hand);
    const identityBalance = await adminPool.query<{ quantity_on_hand: string }>(
      `SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_traceability_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND traceability_unit_id=$4 AND location_id=$5`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLot.id, binA.id],
    );
    expect(identityBalance.rows[0]?.quantity_on_hand).toBe('2.0000');

    const shipmentRow = await adminPool.query<{
      status: string; customer_order_reference: string; quantity: string; inventory_movement_id: string;
    }>(
      `SELECT status, customer_order_reference, quantity::text AS quantity, inventory_movement_id::text AS inventory_movement_id
       FROM wms_shipments WHERE tenant_id=$1 AND factory_id=$2 AND shipment_unit_id=$3`,
      [tenantId, fixture.factoryId, dispatched.shipment.shipment_unit_id],
    );
    expect(shipmentRow.rows[0]).toMatchObject({
      status: 'DISPATCHED',
      customer_order_reference: dispatchPayload.customer_order_reference,
      quantity: '3.0000',
      inventory_movement_id: dispatched.shipment.inventory_movement_id,
    });
    const shipmentList = await fulfillmentService.listShipments(
      userId, tenantId, fixture.factoryId, { search: dispatchPayload.customer_order_reference },
    );
    expect(shipmentList.shipments).toHaveLength(1);
    expect(shipmentList.shipments[0]).toMatchObject({
      shipment_unit_id: dispatched.shipment.shipment_unit_id,
      shipment_code: dispatchPayload.shipment_code.toUpperCase(),
      customer_name: dispatchPayload.customer_name,
      customer_order_reference: dispatchPayload.customer_order_reference,
      quantity: '3.0000',
      status: 'DISPATCHED',
      traceability_status: 'SHIPPED',
    });
    const movement = await adminPool.query<{
      movement_type: string; quantity_delta: string; reference_type: string; reference_id: string;
    }>(
      `SELECT movement_type, quantity_delta::text AS quantity_delta, reference_type, reference_id::text AS reference_id
       FROM inventory_movements WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [dispatched.shipment.inventory_movement_id, tenantId, fixture.factoryId],
    );
    expect(movement.rows[0]).toMatchObject({
      movement_type: 'ISSUE', quantity_delta: '-3.0000', reference_type: 'WMS_SHIPMENT',
      reference_id: dispatched.shipment.shipment_unit_id,
    });
    const genealogy = await adminPool.query(
      `SELECT relationship_type FROM product_genealogy_events
       WHERE tenant_id=$1 AND factory_id=$2 AND source_unit_id=$3 AND target_unit_id=$4`,
      [tenantId, fixture.factoryId, palletId, dispatched.shipment.shipment_unit_id],
    );
    expect(genealogy.rows.map(row => row.relationship_type)).toContain('SHIPPED_AS');
    const statuses = await adminPool.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM traceability_units
       WHERE tenant_id=$1 AND factory_id=$2 AND id=ANY($3::uuid[])`,
      [tenantId, fixture.factoryId, [palletId, cartonId, dispatched.shipment.shipment_unit_id, finishedLot.id]],
    );
    expect(statuses.rows.find(row => row.id === palletId)?.status).toBe('SHIPPED');
    expect(statuses.rows.find(row => row.id === cartonId)?.status).toBe('SHIPPED');
    expect(statuses.rows.find(row => row.id === dispatched.shipment.shipment_unit_id)?.status).toBe('SHIPPED');
    expect(statuses.rows.find(row => row.id === finishedLot.id)?.status).toBe('ACTIVE');
    const packageStatuses = await adminPool.query<{ container_unit_id: string; status: string }>(
      `SELECT container_unit_id::text AS container_unit_id, status FROM wms_packing_containers
       WHERE tenant_id=$1 AND factory_id=$2 AND container_unit_id=ANY($3::uuid[])`,
      [tenantId, fixture.factoryId, [palletId, cartonId]],
    );
    expect(packageStatuses.rows.find(row => row.container_unit_id === palletId)?.status).toBe('DISPATCHED');
    expect(packageStatuses.rows.find(row => row.container_unit_id === cartonId)?.status).toBe('DISPATCHED');

    // A caller from another tenant must not learn container or customer shipment details.
    const foreignTenantId = randomUUID();
    await expect(fulfillmentService.getContainer(
      userId, foreignTenantId, fixture.factoryId, palletId,
    )).rejects.toThrow(/not found in this factory/i);
    const foreignShipments = await fulfillmentService.listShipments(
      userId, foreignTenantId, fixture.factoryId, { search: dispatchPayload.customer_order_reference },
    );
    expect(foreignShipments.shipments).toHaveLength(0);

    await expect(fulfillmentService.dispatchContainer(
      userId, foreignTenantId, fixture.factoryId, palletId,
      dispatchPayload, 'wms-foreign-dispatch-' + randomUUID(), requestId, traceId,
    )).rejects.toThrow(/not found in this factory/i);

    const emptyCarton = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'CARTON',
        container_code: 'CARTON-EMPTY-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId,
        location_id: binA.id,
        capacity_quantity: 1,
      },
      'wms-carton-empty-create-' + randomUUID(), requestId, traceId,
    );
    await expect(fulfillmentService.sealContainer(
      userId, tenantId, fixture.factoryId,
      emptyCarton.container.container_unit_id as string,
      'wms-carton-empty-seal-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId,
      emptyCarton.container.container_unit_id as string,
      {
        shipment_code: 'SHIP-EMPTY-' + randomUUID().slice(0, 8),
        customer_name: 'Acceptance Customer',
        customer_order_reference: 'ORDER-EMPTY-' + randomUUID().slice(0, 8),
      },
      'wms-carton-empty-dispatch-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    // The previously packed lot has exactly two units left. Exercise the late-failure
    // path after stock and shipment rows have been written, and prove transaction rollback.
    const remainderCarton = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'CARTON',
        container_code: 'CARTON-REMAINDER-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId,
        location_id: binA.id,
        capacity_quantity: 2,
      },
      'wms-carton-remainder-create-' + randomUUID(), requestId, traceId,
    );
    const remainderCartonId = remainderCarton.container.container_unit_id as string;
    await fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, remainderCartonId,
      { source_unit_id: finishedLot.id, quantity: 2 },
      'wms-carton-remainder-content-' + randomUUID(), requestId, traceId,
    );
    await fulfillmentService.sealContainer(
      userId, tenantId, fixture.factoryId, remainderCartonId,
      'wms-carton-remainder-seal-' + randomUUID(), requestId, traceId,
    );

    const rollbackPayload = {
      shipment_code: 'SHIP-ROLLBACK-' + randomUUID().slice(0, 8),
      customer_name: 'Rollback Acceptance Customer',
      customer_order_reference: 'ORDER-ROLLBACK-' + randomUUID().slice(0, 8),
    };
    const fulfillmentInternals = fulfillmentService as unknown as {
      insertOutbox: (...args: unknown[]) => Promise<void>;
    };
    const originalInsertOutbox = fulfillmentInternals.insertOutbox.bind(fulfillmentService);
    const outboxSpy = jest.spyOn(fulfillmentInternals, 'insertOutbox').mockImplementation(async (...args: unknown[]) => {
      if (args[5] === 'WMS.SHIPMENT_DISPATCHED') {
        throw new Error('forced WMS shipment outbox failure for rollback acceptance');
      }
      return originalInsertOutbox(...args);
    });
    try {
      await expect(fulfillmentService.dispatchContainer(
        userId, tenantId, fixture.factoryId, remainderCartonId, rollbackPayload,
        'wms-dispatch-rollback-' + randomUUID(), requestId, traceId,
      )).rejects.toThrow(/forced WMS shipment outbox failure/i);
    } finally {
      outboxSpy.mockRestore();
    }

    const afterRollbackAggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    expect(afterRollbackAggregate?.quantity_on_hand).toBe('2.0000');
    const afterRollbackLotBalance = await adminPool.query<{ quantity_on_hand: string }>(
      `SELECT quantity_on_hand::text AS quantity_on_hand
       FROM inventory_traceability_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3
         AND traceability_unit_id=$4 AND location_id=$5`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLot.id, binA.id],
    );
    expect(afterRollbackLotBalance.rows[0]?.quantity_on_hand).toBe('2.0000');
    const afterRollbackContainer = await adminPool.query<{ status: string }>(
      `SELECT status FROM wms_packing_containers
       WHERE tenant_id=$1 AND factory_id=$2 AND container_unit_id=$3`,
      [tenantId, fixture.factoryId, remainderCartonId],
    );
    expect(afterRollbackContainer.rows[0]?.status).toBe('SEALED');
    const rolledBackShipmentCount = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM wms_shipments
       WHERE tenant_id=$1 AND factory_id=$2
         AND (container_unit_id=$3 OR shipment_code=$4)`,
      [tenantId, fixture.factoryId, remainderCartonId, rollbackPayload.shipment_code],
    );
    expect(rolledBackShipmentCount.rows[0]?.count).toBe('0');
    const rolledBackMovementCount = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_movements
       WHERE tenant_id=$1 AND factory_id=$2 AND reference_type='WMS_SHIPMENT'
         AND notes=$3`,
      [tenantId, fixture.factoryId, 'WMS customer dispatch ' + rollbackPayload.shipment_code],
    );
    expect(rolledBackMovementCount.rows[0]?.count).toBe('0');

    // Partial-quantity fulfilment can continue as a second shipment, but it must
    // consume only the remaining two units and leave the stock ledger at zero.
    const remainderPayload = {
      shipment_code: 'SHIP-REMAINDER-' + randomUUID().slice(0, 8),
      customer_name: 'Acceptance Customer',
      customer_order_reference: 'CUSTOMER-ORDER-REMAINDER-' + randomUUID().slice(0, 8),
    };
    const remainderKey = 'wms-dispatch-remainder-' + randomUUID();
    const remainderDispatch = await fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, remainderCartonId,
      remainderPayload, remainderKey, requestId, traceId,
    );
    expect(remainderDispatch).toMatchObject({
      replayed: false,
      shipment: { container_unit_id: remainderCartonId, quantity: '2.0000', status: 'DISPATCHED' },
    });
    const remainderReplay = await fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, remainderCartonId,
      remainderPayload, remainderKey, requestId, traceId,
    );
    expect(remainderReplay).toMatchObject({
      replayed: true, shipment: { shipment_unit_id: remainderDispatch.shipment.shipment_unit_id },
    });

    const finalAggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    const finalLocationTotals = await readBinTotals(fixture.factoryId, fixture.itemId);
    expect(finalAggregate?.quantity_on_hand).toBe('0.0000');
    expect(finalLocationTotals?.sum).toBe(finalAggregate?.quantity_on_hand);
    const finalLotBalance = await adminPool.query<{ quantity_on_hand: string }>(
      `SELECT COALESCE(sum(quantity_on_hand),0)::text AS quantity_on_hand
       FROM inventory_traceability_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND traceability_unit_id=$4`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLot.id],
    );
    expect(finalLotBalance.rows[0]?.quantity_on_hand).toBe('0.0000');
    const allShipments = await adminPool.query<{ quantity: string }>(
      `SELECT quantity::text AS quantity FROM wms_shipments
       WHERE tenant_id=$1 AND factory_id=$2
         AND container_unit_id=ANY($3::uuid[])`,
      [tenantId, fixture.factoryId, [palletId, remainderCartonId]],
    );
    expect(allShipments.rows.map(row => Number(row.quantity)).reduce((sum, q) => sum + q, 0)).toBe(5);
    const finalLotStatus = await adminPool.query<{ status: string }>(
      `SELECT status FROM traceability_units WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [finishedLot.id, tenantId, fixture.factoryId],
    );
    expect(finalLotStatus.rows[0]?.status).toBe('SHIPPED');
  });

  it('binds shipment to the exact customer order line and records immutable proof-of-delivery events', async () => {
    const fixture = await createStockFixture('2.0000');
    const { binA } = await createWarehouseAndBins(fixture.factoryId);
    const finishedLot = await traceabilityService.createUnit(
      userId, tenantId, fixture.factoryId,
      {
        unit_type: 'LOT', product_role: 'FINISHED_GOOD',
        unit_code: 'FG-ORDER-POD-' + randomUUID().slice(0, 8),
        inventory_item_id: fixture.itemId, quantity: 2, unit: 'PCS',
        external_reference: 'wms-order-pod-acceptance',
      } as never,
      'fg-order-pod-register-' + randomUUID(), requestId, traceId,
    );
    await adminPool.query(
      `INSERT INTO inventory_traceability_location_balances
         (tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand)
       VALUES ($1,$2,$3,$4,$5,2.0000)`,
      [tenantId, fixture.factoryId, fixture.itemId, finishedLot.id, fixture.defaultLocationId],
    );
    await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId, destination_location_id: binA.id,
        quantity: 2, movement_purpose: 'PUT_AWAY', traceability_unit_id: finishedLot.id,
      },
      'fg-order-pod-putaway-' + randomUUID(), requestId, traceId,
    );
    const carton = await fulfillmentService.createContainer(
      userId, tenantId, fixture.factoryId,
      {
        container_type: 'CARTON', container_code: 'CARTON-ORDER-POD-' + randomUUID().slice(0, 8),
        item_id: fixture.itemId, location_id: binA.id, capacity_quantity: 2,
      },
      'wms-order-pod-carton-create-' + randomUUID(), requestId, traceId,
    );
    const cartonId = carton.container.container_unit_id as string;
    await fulfillmentService.addContent(
      userId, tenantId, fixture.factoryId, cartonId,
      { source_unit_id: finishedLot.id, quantity: 2 },
      'wms-order-pod-content-' + randomUUID(), requestId, traceId,
    );
    await fulfillmentService.sealContainer(
      userId, tenantId, fixture.factoryId, cartonId,
      'wms-order-pod-seal-' + randomUUID(), requestId, traceId,
    );

    const itemResult = await adminPool.query<{ sku: string; name: string; unit: string }>(
      `SELECT sku, name, unit FROM inventory_items
       WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [fixture.itemId, tenantId, fixture.factoryId],
    );
    const item = itemResult.rows[0];
    expect(item).toBeDefined();
    const createOrderLine = async (quantity: number, reference: string) => {
      const orderNumber = 'SO-WMS-POD-' + randomUUID().slice(0, 8);
      const order = await adminPool.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, factory_id, order_number, customer_name, customer_reference, status, order_date, currency, created_by_user_id)
         VALUES ($1,$2,$3,'Acceptance Customer',$4,'CONFIRMED',CURRENT_DATE,'BDT',$5)
         RETURNING id::text AS id`,
        [tenantId, fixture.factoryId, orderNumber, reference, userId],
      );
      const orderId = order.rows[0]?.id;
      if (!orderId) throw new Error('WMS shipment acceptance order was not created');
      const line = await adminPool.query<{ id: string }>(
        `INSERT INTO order_lines (tenant_id, factory_id, order_id, line_number, product_code, product_name, inventory_item_id, quantity, unit)
         VALUES ($1,$2,$3,1,$4,$5,$6,$7::numeric,$8) RETURNING id::text AS id`,
        [tenantId, fixture.factoryId, orderId, item!.sku, item!.name, fixture.itemId, quantity.toFixed(4), item!.unit],
      );
      const orderLineId = line.rows[0]?.id;
      if (!orderLineId) throw new Error('WMS shipment acceptance order line was not created');
      return { orderId, orderLineId, orderNumber, reference };
    };

    const tooSmallReference = 'CUSTOMER-ORDER-TOO-SMALL-' + randomUUID().slice(0, 8);
    const tooSmallOrder = await createOrderLine(1, tooSmallReference);
    const tooSmallPayload = {
      shipment_code: 'SHIP-ORDER-TOO-SMALL-' + randomUUID().slice(0, 8),
      customer_name: 'Acceptance Customer', customer_order_reference: tooSmallReference,
      order_id: tooSmallOrder.orderId, order_line_id: tooSmallOrder.orderLineId,
    };
    await expect(fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, cartonId, tooSmallPayload,
      'wms-order-pod-overship-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);
    const balanceAfterRejectedOrder = await readAggregate(fixture.factoryId, fixture.itemId);
    expect(balanceAfterRejectedOrder?.quantity_on_hand).toBe('2.0000');

    const validReference = 'CUSTOMER-ORDER-VALID-' + randomUUID().slice(0, 8);
    const validOrder = await createOrderLine(2, validReference);
    const invalidCustomerPayload = {
      shipment_code: 'SHIP-ORDER-CUSTOMER-MISMATCH-' + randomUUID().slice(0, 8),
      customer_name: 'Different Customer', customer_order_reference: validReference,
      order_id: validOrder.orderId, order_line_id: validOrder.orderLineId,
    };
    await expect(fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, cartonId, invalidCustomerPayload,
      'wms-order-pod-customer-mismatch-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const payload = {
      shipment_code: 'SHIP-ORDER-POD-' + randomUUID().slice(0, 8),
      customer_name: 'Acceptance Customer', customer_order_reference: validReference,
      order_id: validOrder.orderId, order_line_id: validOrder.orderLineId,
    };
    const dispatch = await fulfillmentService.dispatchContainer(
      userId, tenantId, fixture.factoryId, cartonId, payload,
      'wms-order-pod-dispatch-' + randomUUID(), requestId, traceId,
    );
    expect(dispatch).toMatchObject({
      replayed: false,
      shipment: { order_id: validOrder.orderId, order_line_id: validOrder.orderLineId, quantity: '2.0000', status: 'DISPATCHED' },
    });
    const storedOrderBinding = await adminPool.query<{ order_id: string; order_line_id: string; customer_order_reference: string }>(
      `SELECT order_id::text AS order_id, order_line_id::text AS order_line_id, customer_order_reference
       FROM wms_shipments WHERE shipment_unit_id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [dispatch.shipment.shipment_unit_id, tenantId, fixture.factoryId],
    );
    expect(storedOrderBinding.rows[0]).toEqual({
      order_id: validOrder.orderId, order_line_id: validOrder.orderLineId, customer_order_reference: validReference,
    });

    // The server assigns event_at once; an identical retry with the timestamp omitted must replay.
    const transitPayload = { event_type: 'IN_TRANSIT' as const, notes: 'Shipment handed to carrier' };
    const transitKey = 'wms-delivery-transit-' + randomUUID();
    const transit = await fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      transitPayload, transitKey, requestId, traceId,
    );
    expect(transit).toMatchObject({ replayed: false, event: { event_type: 'IN_TRANSIT', source_system: 'MANUAL' } });
    const transitReplay = await fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      transitPayload, transitKey, requestId, traceId,
    );
    expect(transitReplay).toMatchObject({ replayed: true, event: { id: transit.event.id } });
    expect(transitReplay.event.event_at).toBe(transit.event.event_at);
    await expect(fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      { ...transitPayload, notes: 'Changed payload must not replay' },
      transitKey, requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    await expect(fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      { event_type: 'DELIVERED', event_at: new Date().toISOString() },
      'wms-delivery-no-proof-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(BadRequestException);

    const deliveredAt = new Date().toISOString();
    const signedAt = new Date(Date.now() - 60_000).toISOString();
    const proofPayload = {
      event_type: 'DELIVERED' as const, event_at: deliveredAt,
      recipient_name: 'Acceptance Recipient', proof_type: 'SIGNATURE' as const,
      proof_reference: 'pod/' + dispatch.shipment.shipment_unit_id + '/signature.png',
      proof_sha256: 'a'.repeat(64), signed_at: signedAt, notes: 'POD acceptance evidence',
    };
    const proofKey = 'wms-delivery-proof-' + randomUUID();
    const proof = await fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      proofPayload, proofKey, requestId, traceId,
    );
    expect(proof).toMatchObject({
      replayed: false,
      event: {
        event_type: 'DELIVERED', recipient_name: 'Acceptance Recipient', proof_type: 'SIGNATURE',
        proof_reference: proofPayload.proof_reference, proof_sha256: 'a'.repeat(64),
      },
    });
    expect(new Date(proof.event.signed_at as string).getTime()).toBe(new Date(signedAt).getTime());
    const proofReplay = await fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      proofPayload, proofKey, requestId, traceId,
    );
    expect(proofReplay).toMatchObject({ replayed: true, event: { id: proof.event.id } });
    await expect(fulfillmentService.recordDeliveryEvent(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
      { event_type: 'IN_TRANSIT', event_at: new Date().toISOString() },
      'wms-delivery-terminal-' + randomUUID(), requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const deliveryHistory = await fulfillmentService.listDeliveryEvents(
      userId, tenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
    );
    expect(deliveryHistory.events).toHaveLength(2);
    expect(deliveryHistory.events.map((event: { event_type: string }) => event.event_type)).toEqual(['IN_TRANSIT', 'DELIVERED']);
    expect(deliveryHistory.events[1]).toMatchObject({
      proof_reference: proofPayload.proof_reference, proof_sha256: 'a'.repeat(64), recipient_name: 'Acceptance Recipient',
    });
    const shipmentList = await fulfillmentService.listShipments(
      userId, tenantId, fixture.factoryId, { search: validReference },
    );
    expect(shipmentList.shipments[0]).toMatchObject({
      order_id: validOrder.orderId, order_line_id: validOrder.orderLineId,
      latest_delivery_event_type: 'DELIVERED',
    });
    const foreignTenantId = randomUUID();
    await expect(fulfillmentService.listDeliveryEvents(
      userId, foreignTenantId, fixture.factoryId, dispatch.shipment.shipment_unit_id,
    )).rejects.toThrow(/not found in this factory/i);
  });

});
