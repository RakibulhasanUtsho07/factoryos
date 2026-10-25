import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { InventoryService } from './inventory.service';
import { InventoryLocationService } from './inventory.location.service';
import { InventoryReservationService } from './inventory.reservation.service';
import { TraceabilityService } from './traceability.service';

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
        await adminPool.query('ALTER TABLE traceability_unit_status_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE product_genealogy_events DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE traceability_shipment_dispatch_lines DISABLE TRIGGER USER');
        await adminPool.query('ALTER TABLE traceability_shipment_dispatches DISABLE TRIGGER USER');
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
            'DELETE FROM traceability_shipment_dispatch_lines WHERE tenant_id=$1 AND factory_id=$2',
            [tenantId, factoryId],
          );
          await adminPool.query(
            'DELETE FROM traceability_shipment_dispatches WHERE tenant_id=$1 AND factory_id=$2',
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
          await adminPool.query('ALTER TABLE traceability_unit_status_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE product_genealogy_events ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE traceability_shipment_dispatch_lines ENABLE TRIGGER USER');
          await adminPool.query('ALTER TABLE traceability_shipment_dispatches ENABLE TRIGGER USER');
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


  it('dispatches packed finished-good stock atomically and replays without duplicate issue', async () => {
    const fixture = await createStockFixture('5.0000');
    const { binA } = await createWarehouseAndBins(fixture.factoryId);
    const staging = await locationService.createLocation(
      userId, tenantId, fixture.factoryId,
      {
        location_code: 'SHIP-STAGE-' + randomUUID().slice(0, 8),
        name: 'Customer dispatch staging',
        location_type: 'STAGING',
      },
      requestId, traceId,
    );

    const lot = await traceabilityService.createUnit(
      userId, tenantId, fixture.factoryId,
      {
        unit_type: 'LOT',
        product_role: 'FINISHED_GOOD',
        unit_code: 'SHIP-FG-' + randomUUID().slice(0, 8),
        inventory_item_id: fixture.itemId,
        quantity: 5,
        unit: 'PCS',
        external_reference: 'wms-transactional-shipment-dispatch-test',
      } as never,
      'ship-test-fg-' + randomUUID(), requestId, traceId,
    );
    const lotId = String(lot.id);
    await adminPool.query(
      `INSERT INTO inventory_traceability_location_balances
         (tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand)
       VALUES ($1,$2,$3,$4,$5,5.0000)`,
      [tenantId, fixture.factoryId, fixture.itemId, lotId, fixture.defaultLocationId],
    );

    await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 2,
        movement_purpose: 'PUT_AWAY',
        traceability_unit_id: lotId,
      },
      'ship-test-putaway-2-' + randomUUID(), requestId, traceId,
    );
    await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: binA.id,
        destination_location_id: staging.id,
        quantity: 2,
        movement_purpose: 'PICK',
        traceability_unit_id: lotId,
      },
      'ship-test-pick-2-' + randomUUID(), requestId, traceId,
    );

    const carton = await traceabilityService.createUnit(
      userId, tenantId, fixture.factoryId,
      {
        unit_type: 'CARTON', product_role: 'PACKAGING',
        unit_code: 'SHIP-CARTON-' + randomUUID().slice(0, 8),
        quantity: 1, unit: 'EA',
        external_reference: 'wms-transactional-shipment-dispatch-test',
      } as never,
      'ship-test-carton-' + randomUUID(), requestId, traceId,
    );
    const pallet = await traceabilityService.createUnit(
      userId, tenantId, fixture.factoryId,
      {
        unit_type: 'PALLET', product_role: 'PACKAGING',
        unit_code: 'SHIP-PALLET-' + randomUUID().slice(0, 8),
        quantity: 1, unit: 'EA',
        external_reference: 'wms-transactional-shipment-dispatch-test',
      } as never,
      'ship-test-pallet-' + randomUUID(), requestId, traceId,
    );
    const shipment = await traceabilityService.createUnit(
      userId, tenantId, fixture.factoryId,
      {
        unit_type: 'SHIPMENT', product_role: 'SHIPMENT',
        unit_code: 'SHIP-ORDER-' + randomUUID().slice(0, 8),
        quantity: 1, unit: 'EA',
        external_reference: 'wms-transactional-shipment-dispatch-test',
        attributes: {
          customer_reference: 'CUST-' + randomUUID().slice(0, 8),
          customer_order_reference: 'ORDER-' + randomUUID().slice(0, 8),
          shipment_reference: 'SHIP-' + randomUUID().slice(0, 8),
        },
      } as never,
      'ship-test-shipment-' + randomUUID(), requestId, traceId,
    );
    const shipmentId = String(shipment.id);

    await traceabilityService.recordGenealogyEvent(
      userId, tenantId, fixture.factoryId,
      {
        source_unit_id: lotId, target_unit_id: String(carton.id),
        relationship_type: 'PACKED_INTO', quantity: 5, notes: 'Five finished units in carton',
        evidence: { acceptance: 'shipment-dispatch-integration' },
      } as never,
      'ship-test-edge-lot-carton-' + randomUUID(), requestId, traceId,
    );
    await traceabilityService.recordGenealogyEvent(
      userId, tenantId, fixture.factoryId,
      {
        source_unit_id: String(carton.id), target_unit_id: String(pallet.id),
        relationship_type: 'PACKED_INTO', quantity: 1, notes: 'Carton nested on pallet',
        evidence: { acceptance: 'shipment-dispatch-integration' },
      } as never,
      'ship-test-edge-carton-pallet-' + randomUUID(), requestId, traceId,
    );
    await traceabilityService.recordGenealogyEvent(
      userId, tenantId, fixture.factoryId,
      {
        source_unit_id: String(pallet.id), target_unit_id: shipmentId,
        relationship_type: 'SHIPPED_AS', quantity: 1, notes: 'Pallet assigned to customer shipment',
        evidence: { acceptance: 'shipment-dispatch-integration' },
      } as never,
      'ship-test-edge-pallet-shipment-' + randomUUID(), requestId, traceId,
    );

    const idempotencyKey = 'ship-test-dispatch-' + randomUUID();
    const dispatchInput = { source_location_id: staging.id, notes: 'Dispatch from integration test' };
    await expect(traceabilityService.dispatchShipment(
      userId, tenantId, fixture.factoryId, shipmentId, dispatchInput,
      idempotencyKey, requestId, traceId,
    )).rejects.toBeInstanceOf(ConflictException);

    const afterRejectedDispatch = await readAggregate(fixture.factoryId, fixture.itemId);
    expect(afterRejectedDispatch?.quantity_on_hand).toBe('5.0000');
    expect((await adminPool.query(
      'SELECT count(*)::int AS count FROM traceability_shipment_dispatches WHERE tenant_id=$1 AND factory_id=$2 AND shipment_unit_id=$3',
      [tenantId, fixture.factoryId, shipmentId],
    )).rows[0].count).toBe(0);
    expect((await adminPool.query(
      "SELECT count(*)::int AS count FROM inventory_movements WHERE tenant_id=$1 AND factory_id=$2 AND reference_type='SHIPMENT_DISPATCH'",
      [tenantId, fixture.factoryId],
    )).rows[0].count).toBe(0);
    expect((await traceabilityService.getUnit(userId, tenantId, fixture.factoryId, shipmentId)).status).toBe('ACTIVE');

    await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: fixture.defaultLocationId,
        destination_location_id: binA.id,
        quantity: 3,
        movement_purpose: 'PUT_AWAY',
        traceability_unit_id: lotId,
      },
      'ship-test-putaway-3-' + randomUUID(), requestId, traceId,
    );
    await locationService.transferStock(
      userId, tenantId, fixture.factoryId, fixture.itemId,
      {
        source_location_id: binA.id,
        destination_location_id: staging.id,
        quantity: 3,
        movement_purpose: 'PICK',
        traceability_unit_id: lotId,
      },
      'ship-test-pick-3-' + randomUUID(), requestId, traceId,
    );

    const dispatch = await traceabilityService.dispatchShipment(
      userId, tenantId, fixture.factoryId, shipmentId, dispatchInput,
      idempotencyKey, requestId, traceId,
    );
    expect(dispatch).toMatchObject({ shipment_unit_id: shipmentId, status: 'DISPATCHED', replayed: false });
    expect(dispatch.lines).toHaveLength(1);
    expect(dispatch.lines[0]).toMatchObject({
      item_id: fixture.itemId, traceability_unit_id: lotId,
      source_location_id: staging.id, quantity: '5.0000', unit: 'PCS',
    });

    const replay = await traceabilityService.dispatchShipment(
      userId, tenantId, fixture.factoryId, shipmentId, dispatchInput,
      idempotencyKey, requestId, traceId,
    );
    expect(replay.id).toBe(dispatch.id);
    expect(replay.replayed).toBe(true);

    const aggregate = await readAggregate(fixture.factoryId, fixture.itemId);
    expect(aggregate?.quantity_on_hand).toBe('0.0000');
    const locationBalances = await adminPool.query<{
      location_code: string; quantity_on_hand: string;
    }>(
      `SELECT l.location_code, b.quantity_on_hand::text AS quantity_on_hand
       FROM inventory_location_balances b
       JOIN inventory_locations l ON l.id=b.location_id AND l.tenant_id=b.tenant_id AND l.factory_id=b.factory_id
       WHERE b.tenant_id=$1 AND b.factory_id=$2 AND b.item_id=$3`,
      [tenantId, fixture.factoryId, fixture.itemId],
    );
    expect(locationBalances.rows.every(row => row.quantity_on_hand === '0.0000')).toBe(true);
    const identityBalance = await adminPool.query<{ quantity_on_hand: string }>(
      `SELECT COALESCE(SUM(quantity_on_hand),0)::text AS quantity_on_hand
       FROM inventory_traceability_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND traceability_unit_id=$4`,
      [tenantId, fixture.factoryId, fixture.itemId, lotId],
    );
    expect(identityBalance.rows[0].quantity_on_hand).toBe('0.0000');

    const movement = await adminPool.query<{
      id: string; movement_type: string; quantity: string; location_id: string; reference_id: string;
    }>(
      `SELECT id::text AS id, movement_type, quantity::text AS quantity,
         location_id::text AS location_id, reference_id::text AS reference_id
       FROM inventory_movements
       WHERE tenant_id=$1 AND factory_id=$2 AND reference_type='SHIPMENT_DISPATCH'`,
      [tenantId, fixture.factoryId],
    );
    expect(movement.rows).toHaveLength(1);
    expect(movement.rows[0]).toMatchObject({
      movement_type: 'ISSUE', quantity: '5.0000', location_id: staging.id, reference_id: dispatch.id,
    });

    const dispatchLine = await adminPool.query<{ inventory_movement_id: string; quantity: string }>(
      `SELECT inventory_movement_id::text AS inventory_movement_id, quantity::text AS quantity
       FROM traceability_shipment_dispatch_lines
       WHERE tenant_id=$1 AND factory_id=$2 AND dispatch_id=$3`,
      [tenantId, fixture.factoryId, dispatch.id],
    );
    expect(dispatchLine.rows).toHaveLength(1);
    expect(dispatchLine.rows[0]).toMatchObject({ inventory_movement_id: movement.rows[0].id, quantity: '5.0000' });
    expect((await traceabilityService.getUnit(userId, tenantId, fixture.factoryId, shipmentId)).status).toBe('SHIPPED');
    expect((await adminPool.query(
      "SELECT count(*)::int AS count FROM audit_events WHERE tenant_id=$1 AND factory_id=$2 AND resource_type='TRACEABILITY_SHIPMENT_DISPATCH' AND resource_id=$3 AND action='DISPATCHED'",
      [tenantId, fixture.factoryId, dispatch.id],
    )).rows[0].count).toBe(1);
    expect((await adminPool.query(
      "SELECT count(*)::int AS count FROM outbox_events WHERE tenant_id=$1 AND factory_id=$2 AND aggregate_type='TRACEABILITY_SHIPMENT_DISPATCH' AND aggregate_id=$3 AND event_type='TRACEABILITY.SHIPMENT_DISPATCHED'",
      [tenantId, fixture.factoryId, dispatch.id],
    )).rows[0].count).toBe(1);
  });

});
