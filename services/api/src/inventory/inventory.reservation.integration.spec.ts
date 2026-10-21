import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { createIntegrationDatabase } from '../database/integration-database.adapter';
import { CreateInventoryReservationDto } from './dto/create-inventory-reservation.dto';
import { TransitionInventoryReservationDto } from './dto/transition-inventory-reservation.dto';
import { InventoryLocationService } from './inventory.location.service';
import { InventoryReservationService } from './inventory.reservation.service';
import { TraceabilityService } from './traceability.service';

describe('Inventory reservation FEFO/partial issue PostgreSQL integration', () => {
  const TEST_USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';

  let adminPool!: Pool;
  let appPool!: Pool;
  let service!: InventoryReservationService;
  let locationService!: InventoryLocationService;
  let traceabilityService!: TraceabilityService;
  let integrationDatabase!: ReturnType<typeof createIntegrationDatabase>;
  let tenantId!: string;
  let factoryId!: string;
  const itemIds: string[] = [];
  const locationIds: string[] = [];

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

    integrationDatabase = createIntegrationDatabase(appPool);
    const audit = { record: async () => undefined } as unknown as AuditService;
    service = new InventoryReservationService(integrationDatabase as never, audit);
    locationService = new InventoryLocationService(integrationDatabase as never, audit);
    traceabilityService = new TraceabilityService(integrationDatabase as never);
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
          'inventory_location_transfers',
          'inventory_traceability_location_balances',
          'traceability_unit_status_events',
          'traceability_units',
          'inventory_material_allocation_policies',
          'inventory_movements',
          'inventory_location_balances',
          'inventory_stock_balances',
          'inventory_locations',
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
                 UNION SELECT id FROM traceability_units WHERE inventory_item_id = ANY($1::uuid[])
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
          await adminPool.query('DELETE FROM inventory_traceability_location_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_location_transfers WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_reservations WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_movements WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query(
            'DELETE FROM traceability_unit_status_events WHERE unit_id IN (SELECT id FROM traceability_units WHERE inventory_item_id = ANY($1::uuid[]))',
            [itemIds],
          );
          await adminPool.query('DELETE FROM traceability_units WHERE inventory_item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_material_allocation_policies WHERE inventory_item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_location_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_stock_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_items WHERE id = ANY($1::uuid[])', [itemIds]);
          if (locationIds.length > 0) {
            await adminPool.query("DELETE FROM inventory_locations WHERE id = ANY($1::uuid[]) AND location_type = 'BIN'", [locationIds]);
            await adminPool.query("DELETE FROM inventory_locations WHERE id = ANY($1::uuid[]) AND location_type IN ('WAREHOUSE','STAGING')", [locationIds]);
          }
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

  it('allocates the first released production BOM requirement FEFO across bins, then issues the earliest lot idempotently', async () => {
    const itemId = await createItem('10.0000');
    const defaultResult = await adminPool.query<{ id: string }>(
      `SELECT id::text AS id FROM inventory_locations
       WHERE tenant_id=$1 AND factory_id=$2 AND is_default=TRUE AND status='ACTIVE'`,
      [tenantId, factoryId],
    );
    const defaultLocationId = defaultResult.rows[0]?.id;
    if (!defaultLocationId) throw new Error('Factory UNASSIGNED location missing');

    const warehouse = await locationService.createLocation(
      TEST_USER_ID, tenantId, factoryId,
      { location_code: 'WMS-WH-' + randomUUID().slice(0, 8), name: 'FEFO integration warehouse', location_type: 'WAREHOUSE' } as never,
      null, randomUUID(),
    );
    const binA = await locationService.createLocation(
      TEST_USER_ID, tenantId, factoryId,
      { location_code: 'WMS-BIN-A-' + randomUUID().slice(0, 8), name: 'Earliest-expiry bin', location_type: 'BIN', parent_location_id: warehouse.id } as never,
      null, randomUUID(),
    );
    const binB = await locationService.createLocation(
      TEST_USER_ID, tenantId, factoryId,
      { location_code: 'WMS-BIN-B-' + randomUUID().slice(0, 8), name: 'Later-expiry bin', location_type: 'BIN', parent_location_id: warehouse.id } as never,
      null, randomUUID(),
    );
    locationIds.push(warehouse.id, binA.id, binB.id);

    const createLot = async (
      code: string,
      quantity: string,
      expiry: string,
      key: string,
      options: { attributes?: Record<string, unknown> } = {},
    ) => {
      const inserted = await adminPool.query<{ id: string }>(
        `
        INSERT INTO traceability_units (
          tenant_id, factory_id, unit_type, product_role, unit_code, barcode_value,
          inventory_item_id, quantity, unit, external_reference, expires_at, status, attributes,
          idempotency_key, request_hash, created_by_user_id, correlation_id
        )
        VALUES ($1,$2,'LOT','MATERIAL',$3,$4,$5,$6::numeric,'PCS',$7,$8::date,'ACTIVE',$9::jsonb,$10,$11,$12,$13::uuid)
        RETURNING id::text AS id
        `,
        [tenantId, factoryId, code, 'BAR-' + code, itemId, quantity, 'SUPPLIER-' + code,
          expiry, JSON.stringify(options.attributes ?? {}),
          key, 'a'.repeat(64), TEST_USER_ID, randomUUID()],
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error('FEFO traceability lot fixture was not created');
      return id;
    };

    const earlyLotId = await createLot('LOT-EARLIEST-' + randomUUID().slice(0, 6), '3.0000', '2026-11-01', 'wms-fefo-early-' + randomUUID());
    const lateLotId = await createLot('LOT-LATER-' + randomUUID().slice(0, 6), '4.0000', '2027-01-01', 'wms-fefo-late-' + randomUUID());
    const expiredLotId = await createLot('LOT-EXPIRED-' + randomUUID().slice(0, 6), '0.5000', '2026-10-20', 'wms-fefo-expired-' + randomUUID());
    const damagedLotId = await createLot('LOT-DAMAGED-' + randomUUID().slice(0, 6), '0.5000', '2027-01-01', 'wms-fefo-damaged-' + randomUUID(), {
      attributes: { damaged: true, condition: 'DAMAGED' },
    });
    const heldLotId = await createLot('LOT-HELD-' + randomUUID().slice(0, 6), '0.5000', '2027-01-01', 'wms-fefo-held-' + randomUUID(), {
      attributes: { held: true, condition: 'HELD' },
    });
    const quarantinedLotId = await createLot('LOT-QUARANTINED-' + randomUUID().slice(0, 6), '0.5000', '2027-01-01', 'wms-fefo-quarantine-' + randomUUID(), {
      attributes: { quarantined: true, condition: 'QUARANTINED' },
    });
    // New traceability identities must begin ACTIVE. Exercise quarantine through
    // the audited lifecycle so the candidate query excludes a real quarantined unit.
    await traceabilityService.changeUnitStatus(
      TEST_USER_ID, tenantId, factoryId, quarantinedLotId,
      { target_status: 'QUARANTINED', reason: 'WMS FEFO exclusion integration fixture' } as never,
      'wms-fefo-quarantine-status-' + randomUUID(), randomUUID(), randomUUID(),
    );

    await adminPool.query(
      `
      INSERT INTO inventory_material_allocation_policies (
        tenant_id, factory_id, policy_scope, inventory_item_id, allocation_policy,
        require_traceability, created_by_user_id, updated_by_user_id
      )
      VALUES ($1,$2,'MATERIAL',$3,'FEFO',TRUE,$4,$4)
      `,
      [tenantId, factoryId, itemId, TEST_USER_ID],
    );

    await locationService.transferStock(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { movement_purpose: 'PUT_AWAY', source_location_id: defaultLocationId,
        destination_location_id: binA.id, traceability_unit_id: earlyLotId, quantity: 3 } as never,
      'wms-putaway-early-' + randomUUID(), null, randomUUID(),
    );
    await locationService.transferStock(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { movement_purpose: 'PUT_AWAY', source_location_id: defaultLocationId,
        destination_location_id: binB.id, traceability_unit_id: lateLotId, quantity: 4 } as never,
      'wms-putaway-late-' + randomUUID(), null, randomUUID(),
    );

    const workOrderId = randomUUID();
    const bomLineId = randomUUID();
    const requirementId = randomUUID();
    const correlationId = randomUUID();
    const allocations = await integrationDatabase.transaction(
      { tenantId, userId: TEST_USER_ID },
      async (client) => service.reserveWorkOrderMaterialRequirement(client, {
        userId: TEST_USER_ID, tenantId, factoryId, workOrderId,
        workOrderNumber: 'WO-FIRST-FEFO-' + workOrderId.slice(0, 6),
        requirementId, bomLineId, itemId, itemUnit: 'PCS',
        lineNumber: 1, quantity: '4.0000', correlationId,
      }),
    );
    expect(allocations).toHaveLength(2);
    expect(allocations).toEqual([
      { reservationId: allocations[0]!.reservationId, locationId: binA.id, quantity: '3.0000' },
      { reservationId: allocations[1]!.reservationId, locationId: binB.id, quantity: '1.0000' },
    ]);

    const actualLotReservations = await adminPool.query<{
      traceability_unit_id: string; unit_code: string; allocated_quantity: string; allocation_sequence: number;
    }>(
      `
      SELECT a.traceability_unit_id::text AS traceability_unit_id,
             tu.unit_code, a.allocated_quantity::text, a.allocation_sequence
      FROM inventory_reservation_traceability_allocations a
      JOIN traceability_units tu ON tu.id=a.traceability_unit_id
      WHERE a.tenant_id=$1 AND a.factory_id=$2 AND a.item_id=$3
        AND a.reservation_id = ANY($4::uuid[])
      ORDER BY a.allocation_sequence
      `,
      [tenantId, factoryId, itemId, allocations.map((allocation) => allocation.reservationId)],
    );
    expect(actualLotReservations.rows.map((row) => row.allocated_quantity)).toEqual(['3.0000', '1.0000']);
    expect(actualLotReservations.rows[0]?.unit_code).toContain('LOT-EARLIEST');
    expect(actualLotReservations.rows[1]?.unit_code).toContain('LOT-LATER');
    expect(actualLotReservations.rows.some((row) =>
      [expiredLotId, damagedLotId, heldLotId, quarantinedLotId].includes(row.traceability_unit_id),
    )).toBe(false);
    const excludedAllocations = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM inventory_reservation_traceability_allocations
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3
         AND traceability_unit_id = ANY($4::uuid[])`,
      [tenantId, factoryId, itemId, [expiredLotId, damagedLotId, heldLotId, quarantinedLotId]],
    );
    expect(excludedAllocations.rows[0]?.count).toBe('0');

    const firstReservationId = allocations[0]!.reservationId;
    const issueKey = 'wms-first-order-partial-issue-' + randomUUID();
    const issueDto = { target_status: 'CONSUMED', quantity: 1 } as TransitionInventoryReservationDto;
    const partial = await service.transitionReservation(
      TEST_USER_ID, tenantId, factoryId, itemId, firstReservationId, issueDto, issueKey, null, randomUUID(),
    );
    const replay = await service.transitionReservation(
      TEST_USER_ID, tenantId, factoryId, itemId, firstReservationId, issueDto, issueKey, null, randomUUID(),
    );
    expect(partial).toMatchObject({
      status: 'RESERVED', quantity: '3.0000', remaining_quantity: '2.0000',
      consumed_quantity: '1.0000', released_quantity: '0.0000', replayed: false,
    });
    expect(replay).toMatchObject({
      status: 'RESERVED', remaining_quantity: '2.0000', consumed_quantity: '1.0000',
      replayed: true, consumed_quantity_this_request: '1.0000',
    });

    // Exercise the same inventory path invoked when the first production work order
    // issues its released BOM material. The partial issue above must not be charged
    // a second time: only the two remaining units in BIN A and one in BIN B are issued.
    const workOrderIssue = await integrationDatabase.transaction(
      { tenantId, userId: TEST_USER_ID },
      async (client) => service.transitionWorkOrderMaterialReservations(
        client,
        {
          userId: TEST_USER_ID, tenantId, factoryId, workOrderId,
          workOrderNumber: 'WO-FIRST-FEFO-' + workOrderId.slice(0, 6),
          correlationId: randomUUID(),
        },
        'CONSUMED',
      ),
    );
    expect(workOrderIssue).toMatchObject({
      reservationCount: 2,
      quantityByItem: [{ item_id: itemId, quantity: '4.0000' }],
    });

    const stock = await adminPool.query<{
      quantity_on_hand: string; quantity_reserved: string;
    }>(
      `SELECT quantity_on_hand::text, quantity_reserved::text FROM inventory_stock_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3`,
      [tenantId, factoryId, itemId],
    );
    expect(stock.rows[0]).toMatchObject({ quantity_on_hand: '6.0000', quantity_reserved: '0.0000' });
    const locationA = await adminPool.query<{ quantity_on_hand: string; quantity_reserved: string }>(
      `SELECT quantity_on_hand::text, quantity_reserved::text FROM inventory_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND location_id=$4`,
      [tenantId, factoryId, itemId, binA.id],
    );
    expect(locationA.rows[0]).toMatchObject({ quantity_on_hand: '0.0000', quantity_reserved: '0.0000' });
    const lotBalance = await adminPool.query<{ quantity_on_hand: string; quantity_reserved: string }>(
      `SELECT quantity_on_hand::text, quantity_reserved::text FROM inventory_traceability_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND traceability_unit_id=$4 AND location_id=$5`,
      [tenantId, factoryId, itemId, earlyLotId, binA.id],
    );
    expect(lotBalance.rows[0]).toMatchObject({ quantity_on_hand: '0.0000', quantity_reserved: '0.0000' });

    const consumptionEvidence = await adminPool.query<{ issue_count: string; issued_quantity: string }>(
      `SELECT count(*)::text AS issue_count, COALESCE(sum(quantity),0)::text AS issued_quantity
       FROM inventory_reservation_consumptions
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND reservation_id = ANY($4::uuid[])`,
      [tenantId, factoryId, itemId, allocations.map((allocation) => allocation.reservationId)],
    );
    expect(consumptionEvidence.rows[0]).toMatchObject({ issue_count: '3', issued_quantity: '4.0000' });
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
