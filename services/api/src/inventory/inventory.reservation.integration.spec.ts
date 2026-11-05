import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { createIntegrationDatabase } from '../database/integration-database.adapter';
import { CreateInventoryReservationDto } from './dto/create-inventory-reservation.dto';
import { TransitionInventoryReservationDto } from './dto/transition-inventory-reservation.dto';
import { InventoryLocationService } from './inventory.location.service';
import { InventoryReservationService } from './inventory.reservation.service';
import { GoodsReceiptService } from '../procurement/goods-receipt.service';
import { ProcurementService } from '../procurement/procurement.service';
import { TraceabilityService } from './traceability.service';

describe('Inventory reservation FEFO/partial issue PostgreSQL integration', () => {
  const TEST_USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';

  let adminPool!: Pool;
  let appPool!: Pool;
  let service!: InventoryReservationService;
  let locationService!: InventoryLocationService;
  let traceabilityService!: TraceabilityService;
  let procurementService!: ProcurementService;
  let goodsReceiptService!: GoodsReceiptService;
  let integrationDatabase!: ReturnType<typeof createIntegrationDatabase>;
  let tenantId!: string;
  let factoryId!: string;
  const itemIds: string[] = [];
  const locationIds: string[] = [];
  const factoryIds: string[] = [];
  const policyIds: string[] = [];
  const sectorCodes: string[] = [];
  const supplierIds: string[] = [];
  const purchaseOrderIds: string[] = [];
  const goodsReceiptIds: string[] = [];
  const approverIds: string[] = [];

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
    procurementService = new ProcurementService(integrationDatabase as never);
    goodsReceiptService = new GoodsReceiptService(integrationDatabase as never);
  });

  afterAll(async () => {
    try {
      if (adminPool && (itemIds.length > 0 || supplierIds.length > 0 || purchaseOrderIds.length > 0 || goodsReceiptIds.length > 0 || approverIds.length > 0 || factoryIds.length > 0 || policyIds.length > 0)) {
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
          'goods_receipt_lines',
          'goods_receipts',
          'purchase_order_status_history',
          'purchase_order_lines',
          'purchase_orders',
          'suppliers',
          'audit_events',
        ];
        for (const table of triggerTables) {
          await adminPool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
        }
        try {
          await adminPool.query(
            `
            DELETE FROM outbox_events
            WHERE aggregate_id = ANY($1::uuid[])
               OR aggregate_id = ANY($2::uuid[])
               OR aggregate_id = ANY($3::uuid[])
               OR aggregate_id IN (
                 SELECT id FROM inventory_reservations WHERE item_id = ANY($1::uuid[])
                 UNION SELECT id FROM inventory_reservation_consumptions WHERE item_id = ANY($1::uuid[])
                 UNION SELECT id FROM traceability_units WHERE inventory_item_id = ANY($1::uuid[])
               )
            `,
            [itemIds, [...supplierIds, ...purchaseOrderIds, ...goodsReceiptIds], locationIds],
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
          await adminPool.query('DELETE FROM goods_receipt_lines WHERE goods_receipt_id = ANY($1::uuid[])', [goodsReceiptIds]);
          await adminPool.query('DELETE FROM goods_receipts WHERE id = ANY($1::uuid[])', [goodsReceiptIds]);
          await adminPool.query('DELETE FROM purchase_order_status_history WHERE purchase_order_id = ANY($1::uuid[])', [purchaseOrderIds]);
          await adminPool.query('DELETE FROM purchase_order_lines WHERE purchase_order_id = ANY($1::uuid[])', [purchaseOrderIds]);
          await adminPool.query('DELETE FROM purchase_orders WHERE id = ANY($1::uuid[])', [purchaseOrderIds]);
          await adminPool.query('DELETE FROM suppliers WHERE id = ANY($1::uuid[])', [supplierIds]);
          await adminPool.query('DELETE FROM audit_events WHERE actor_user_id = ANY($1::uuid[]) OR resource_id = ANY($2::uuid[]) OR factory_id = ANY($3::uuid[]) OR resource_id = ANY($4::uuid[])', [approverIds, [...supplierIds, ...purchaseOrderIds, ...goodsReceiptIds], factoryIds, locationIds]);
          if (approverIds.length > 0) await adminPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [approverIds]);
          await adminPool.query('DELETE FROM inventory_material_allocation_policies WHERE inventory_item_id = ANY($1::uuid[])', [itemIds]);
          if (sectorCodes.length > 0) {
            await adminPool.query(
              "DELETE FROM inventory_material_allocation_policies WHERE tenant_id=$1 AND factory_id=$2 AND policy_scope='SECTOR' AND lower(sector_code)=ANY($3::text[])",
              [tenantId, factoryId, sectorCodes.map((code) => code.toLowerCase())],
            );
          }
          if (policyIds.length > 0) {
            await adminPool.query('DELETE FROM inventory_material_allocation_policies WHERE id = ANY($1::uuid[])', [policyIds]);
          }
          await adminPool.query('DELETE FROM inventory_location_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_stock_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
          await adminPool.query('DELETE FROM inventory_items WHERE id = ANY($1::uuid[])', [itemIds]);
          if (locationIds.length > 0) {
            await adminPool.query("DELETE FROM inventory_locations WHERE id = ANY($1::uuid[]) AND location_type = 'BIN'", [locationIds]);
            await adminPool.query("DELETE FROM inventory_locations WHERE id = ANY($1::uuid[]) AND location_type IN ('WAREHOUSE','STAGING')", [locationIds]);
            await adminPool.query("DELETE FROM inventory_locations WHERE id = ANY($1::uuid[]) AND location_type = 'VIRTUAL'", [locationIds]);
          }
          if (factoryIds.length > 0) {
            await adminPool.query('DELETE FROM factories WHERE id = ANY($1::uuid[])', [factoryIds]);
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
      const unit = await traceabilityService.createUnit(
        TEST_USER_ID, tenantId, factoryId,
        {
          unit_type: 'LOT',
          product_role: 'MATERIAL',
          unit_code: code,
          barcode_value: 'BAR-' + code,
          inventory_item_id: itemId,
          quantity: Number(quantity),
          unit: 'PCS',
          external_reference: 'SUPPLIER-' + code,
          expires_at: expiry,
          attributes: options.attributes ?? {},
        } as never,
        key, randomUUID(), randomUUID(),
      );
      if (!unit.id) throw new Error('FEFO traceability lot fixture was not created');
      return unit.id;
    };

    const databaseDateResult = await adminPool.query<{ current_date: string }>(
      'SELECT CURRENT_DATE::text AS current_date',
    );
    const databaseCurrentDate = databaseDateResult.rows[0]?.current_date;
    if (!databaseCurrentDate || !/^\d{4}-\d{2}-\d{2}$/.test(databaseCurrentDate)) {
      throw new Error('PostgreSQL CURRENT_DATE is unavailable for FEFO expiry fixtures');
    }
    const expiryFromDatabaseDate = (offsetDays: number): string => {
      const date = new Date(databaseCurrentDate + 'T00:00:00.000Z');
      date.setUTCDate(date.getUTCDate() + offsetDays);
      return date.toISOString().slice(0, 10);
    };
    const earlyLotId = await createLot('LOT-EARLIEST-' + randomUUID().slice(0, 6), '3.0000', expiryFromDatabaseDate(30), 'wms-fefo-early-' + randomUUID());
    const lateLotId = await createLot('LOT-LATER-' + randomUUID().slice(0, 6), '4.0000', expiryFromDatabaseDate(90), 'wms-fefo-late-' + randomUUID());
    const expiredLotId = await createLot('LOT-EXPIRED-' + randomUUID().slice(0, 6), '0.5000', expiryFromDatabaseDate(-1), 'wms-fefo-expired-' + randomUUID());
    const damagedLotId = await createLot('LOT-DAMAGED-' + randomUUID().slice(0, 6), '0.5000', expiryFromDatabaseDate(90), 'wms-fefo-damaged-' + randomUUID(), {
      attributes: { damaged: true, condition: 'DAMAGED' },
    });
    const heldLotId = await createLot('LOT-HELD-' + randomUUID().slice(0, 6), '0.5000', expiryFromDatabaseDate(90), 'wms-fefo-held-' + randomUUID(), {
      attributes: { held: true, condition: 'HELD' },
    });
    const quarantinedLotId = await createLot('LOT-QUARANTINED-' + randomUUID().slice(0, 6), '0.5000', expiryFromDatabaseDate(90), 'wms-fefo-quarantine-' + randomUUID());
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

  it('applies material FIFO ahead of sector FEFO and serializes competing lot reservations', async () => {
    const itemId = await createItem('6.0000');
    const defaultResult = await adminPool.query<{ id: string }>(
      `SELECT id::text AS id FROM inventory_locations
       WHERE tenant_id=$1 AND factory_id=$2 AND is_default=TRUE AND status='ACTIVE'`,
      [tenantId, factoryId],
    );
    const defaultLocationId = defaultResult.rows[0]?.id;
    if (!defaultLocationId) throw new Error('Factory UNASSIGNED location missing');

    const warehouse = await locationService.createLocation(
      TEST_USER_ID, tenantId, factoryId,
      { location_code: 'WMS-FIFO-WH-' + randomUUID().slice(0, 8), name: 'FIFO integration warehouse', location_type: 'WAREHOUSE' } as never,
      null, randomUUID(),
    );
    const bin = await locationService.createLocation(
      TEST_USER_ID, tenantId, factoryId,
      { location_code: 'WMS-FIFO-BIN-' + randomUUID().slice(0, 8), name: 'FIFO competing-demand bin', location_type: 'BIN', parent_location_id: warehouse.id } as never,
      null, randomUUID(),
    );
    locationIds.push(warehouse.id, bin.id);

    const testSectorCode = 'FIFO-' + randomUUID().slice(0, 12).toUpperCase();
    sectorCodes.push(testSectorCode);
    await adminPool.query(
      'UPDATE inventory_items SET sector_code=$4 WHERE tenant_id=$1 AND factory_id=$2 AND id=$3',
      [tenantId, factoryId, itemId, testSectorCode],
    );
    // The more-specific material policy must win over the sector-level FEFO policy.
    await adminPool.query(
      `INSERT INTO inventory_material_allocation_policies (
         tenant_id, factory_id, policy_scope, sector_code, inventory_item_id,
         allocation_policy, require_traceability, created_by_user_id, updated_by_user_id
       )
       VALUES
         ($1,$2,'SECTOR',$3,NULL,'FEFO',TRUE,$5,$5),
         ($1,$2,'MATERIAL',NULL,$4,'FIFO',TRUE,$5,$5)`,
      [tenantId, factoryId, testSectorCode, itemId, TEST_USER_ID],
    );

    const databaseDateResult = await adminPool.query<{ current_date: string }>(
      "SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS current_date",
    );
    const databaseCurrentDate = databaseDateResult.rows[0]?.current_date;
    if (!databaseCurrentDate) {
      throw new Error('PostgreSQL CURRENT_DATE is unavailable for FIFO expiry fixtures');
    }
    const expiryFromDatabaseDate = (offsetDays: number): string => {
      const date = new Date(databaseCurrentDate + 'T00:00:00.000Z');
      date.setUTCDate(date.getUTCDate() + offsetDays);
      return date.toISOString().slice(0, 10);
    };
    const createLot = async (code: string, expiry: string, key: string): Promise<string> => {
      const unit = await traceabilityService.createUnit(
        TEST_USER_ID, tenantId, factoryId,
        {
          unit_type: 'LOT',
          product_role: 'MATERIAL',
          unit_code: code,
          barcode_value: 'BAR-' + code,
          inventory_item_id: itemId,
          quantity: 3,
          unit: 'PCS',
          external_reference: 'SUPPLIER-' + code,
          expires_at: expiry,
          attributes: {},
        } as never,
        key, randomUUID(), randomUUID(),
      );
      if (!unit.id) throw new Error('FIFO traceability lot fixture was not created');
      return unit.id;
    };

    // The first-received lot deliberately expires later. FIFO must not silently
    // become FEFO merely because the second lot has the earlier expiry date.
    const firstReceivedLotId = await createLot(
      'LOT-FIFO-RECEIVED-FIRST-' + randomUUID().slice(0, 6),
      expiryFromDatabaseDate(90),
      'wms-fifo-first-' + randomUUID(),
    );
    await adminPool.query('SELECT pg_sleep(0.02)');
    const secondReceivedLotId = await createLot(
      'LOT-FIFO-RECEIVED-SECOND-' + randomUUID().slice(0, 6),
      expiryFromDatabaseDate(30),
      'wms-fifo-second-' + randomUUID(),
    );
    const receiptOrder = await adminPool.query<{
      id: string; unit_code: string; received_at: string; expires_at: string;
    }>(
      `SELECT tu.id::text AS id, tu.unit_code,
              COALESCE(gr.posted_at, gr.received_at, tu.created_at)::text AS received_at,
              tu.expires_at::text AS expires_at
       FROM traceability_units tu
       LEFT JOIN goods_receipts gr
         ON gr.id=tu.goods_receipt_id AND gr.tenant_id=tu.tenant_id AND gr.factory_id=tu.factory_id
       WHERE tu.tenant_id=$1 AND tu.factory_id=$2
         AND tu.id = ANY($3::uuid[])
       ORDER BY COALESCE(gr.posted_at, gr.received_at, tu.created_at), tu.id`,
      [tenantId, factoryId, [firstReceivedLotId, secondReceivedLotId]],
    );
    expect(receiptOrder.rows.map((row) => row.id)).toEqual([firstReceivedLotId, secondReceivedLotId]);
    expect(new Date(receiptOrder.rows[0]!.received_at).getTime())
      .toBeLessThan(new Date(receiptOrder.rows[1]!.received_at).getTime());
    expect(new Date(receiptOrder.rows[0]!.expires_at).getTime())
      .toBeGreaterThan(new Date(receiptOrder.rows[1]!.expires_at).getTime());

    await locationService.transferStock(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { movement_purpose: 'PUT_AWAY', source_location_id: defaultLocationId,
        destination_location_id: bin.id, traceability_unit_id: firstReceivedLotId, quantity: 3 } as never,
      'wms-fifo-putaway-first-' + randomUUID(), null, randomUUID(),
    );
    await locationService.transferStock(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { movement_purpose: 'PUT_AWAY', source_location_id: defaultLocationId,
        destination_location_id: bin.id, traceability_unit_id: secondReceivedLotId, quantity: 3 } as never,
      'wms-fifo-putaway-second-' + randomUUID(), null, randomUUID(),
    );

    const reserve = (key: string) => service.createReservation(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { quantity: 4, location_id: bin.id } as CreateInventoryReservationDto,
      key, null, randomUUID(),
    );
    const competing = await Promise.allSettled([
      reserve('wms-fifo-competitor-a-' + randomUUID()),
      reserve('wms-fifo-competitor-b-' + randomUUID()),
    ]);
    expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = competing.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(String(rejected?.reason?.message ?? rejected?.reason))
      .toContain('Insufficient eligible FIFO lot/serial stock');

    const reservations = await adminPool.query<{
      id: string; quantity: string; status: string;
    }>(
      `SELECT id::text AS id, quantity::text AS quantity, status
       FROM inventory_reservations
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3
       ORDER BY created_at, id`,
      [tenantId, factoryId, itemId],
    );
    expect(reservations.rows).toHaveLength(1);
    expect(reservations.rows[0]).toMatchObject({ quantity: '4.0000', status: 'RESERVED' });

    const allocations = await adminPool.query<{
      traceability_unit_id: string; unit_code: string;
      allocation_sequence: number; allocated_quantity: string;
    }>(
      `SELECT a.traceability_unit_id::text AS traceability_unit_id, tu.unit_code,
              a.allocation_sequence, a.allocated_quantity::text AS allocated_quantity
       FROM inventory_reservation_traceability_allocations a
       JOIN traceability_units tu ON tu.id=a.traceability_unit_id
       WHERE a.tenant_id=$1 AND a.factory_id=$2 AND a.item_id=$3
         AND a.reservation_id=$4
       ORDER BY a.allocation_sequence`,
      [tenantId, factoryId, itemId, reservations.rows[0]!.id],
    );
    expect(allocations.rows).toEqual([
      expect.objectContaining({
        traceability_unit_id: firstReceivedLotId,
        allocation_sequence: 1,
        allocated_quantity: '3.0000',
      }),
      expect.objectContaining({
        traceability_unit_id: secondReceivedLotId,
        allocation_sequence: 2,
        allocated_quantity: '1.0000',
      }),
    ]);

    const persistedBalances = await adminPool.query<{
      unit_id: string; quantity_on_hand: string; quantity_reserved: string;
    }>(
      `SELECT traceability_unit_id::text AS unit_id,
              quantity_on_hand::text AS quantity_on_hand,
              quantity_reserved::text AS quantity_reserved
       FROM inventory_traceability_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND location_id=$4
       ORDER BY traceability_unit_id`,
      [tenantId, factoryId, itemId, bin.id],
    );
    expect(persistedBalances.rows).toHaveLength(2);
    expect(persistedBalances.rows).toEqual(expect.arrayContaining([
      { unit_id: firstReceivedLotId, quantity_on_hand: '3.0000', quantity_reserved: '3.0000' },
      { unit_id: secondReceivedLotId, quantity_on_hand: '3.0000', quantity_reserved: '1.0000' },
    ]));

    const aggregate = await adminPool.query<{
      stock_on_hand: string; stock_reserved: string;
      bin_on_hand: string; bin_reserved: string;
    }>(
      `SELECT s.quantity_on_hand::text AS stock_on_hand,
              s.quantity_reserved::text AS stock_reserved,
              b.quantity_on_hand::text AS bin_on_hand,
              b.quantity_reserved::text AS bin_reserved
       FROM inventory_stock_balances s
       JOIN inventory_location_balances b
         ON b.tenant_id=s.tenant_id AND b.factory_id=s.factory_id AND b.item_id=s.item_id
       WHERE s.tenant_id=$1 AND s.factory_id=$2 AND s.item_id=$3 AND b.location_id=$4`,
      [tenantId, factoryId, itemId, bin.id],
    );
    expect(aggregate.rows[0]).toEqual({
      stock_on_hand: '6.0000', stock_reserved: '4.0000',
      bin_on_hand: '6.0000', bin_reserved: '4.0000',
    });
  });

  it('uses the effective receipt timestamp as the FEFO tie-break for equal-expiry lots under competing reservations', async () => {
    const itemId = await createItem('6.0000');
    const defaultResult = await adminPool.query<{ id: string }>(
      `SELECT id::text AS id FROM inventory_locations
       WHERE tenant_id=$1 AND factory_id=$2 AND is_default=TRUE AND status='ACTIVE'`,
      [tenantId, factoryId],
    );
    const defaultLocationId = defaultResult.rows[0]?.id;
    if (!defaultLocationId) throw new Error('Factory UNASSIGNED location missing');

    const warehouse = await locationService.createLocation(
      TEST_USER_ID, tenantId, factoryId,
      { location_code: 'WMS-FEFO-TIE-WH-' + randomUUID().slice(0, 8), name: 'FEFO tie-break warehouse', location_type: 'WAREHOUSE' } as never,
      null, randomUUID(),
    );
    const bin = await locationService.createLocation(
      TEST_USER_ID, tenantId, factoryId,
      { location_code: 'WMS-FEFO-TIE-BIN-' + randomUUID().slice(0, 8), name: 'FEFO tie-break competing-demand bin', location_type: 'BIN', parent_location_id: warehouse.id } as never,
      null, randomUUID(),
    );
    locationIds.push(warehouse.id, bin.id);

    await adminPool.query(
      `INSERT INTO inventory_material_allocation_policies (
         tenant_id, factory_id, policy_scope, inventory_item_id, allocation_policy,
         require_traceability, created_by_user_id, updated_by_user_id
       )
       VALUES ($1,$2,'MATERIAL',$3,'FEFO',TRUE,$4,$4)`,
      [tenantId, factoryId, itemId, TEST_USER_ID],
    );

    const databaseDateResult = await adminPool.query<{ current_date: string }>(
      "SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS current_date",
    );
    const databaseCurrentDate = databaseDateResult.rows[0]?.current_date;
    if (!databaseCurrentDate) throw new Error('PostgreSQL CURRENT_DATE is unavailable for FEFO tie-break fixtures');
    const date = new Date(databaseCurrentDate + 'T00:00:00.000Z');
    date.setUTCDate(date.getUTCDate() + 60);
    const sharedExpiry = date.toISOString().slice(0, 10);

    const createLot = async (label: string): Promise<string> => {
      const unitCode = 'LOT-FEFO-EQUAL-EXPIRY-' + label + '-' + randomUUID().slice(0, 6);
      const unit = await traceabilityService.createUnit(
        TEST_USER_ID, tenantId, factoryId,
        {
          unit_type: 'LOT',
          product_role: 'MATERIAL',
          unit_code: unitCode,
          barcode_value: 'BAR-' + unitCode,
          inventory_item_id: itemId,
          quantity: 3,
          unit: 'PCS',
          external_reference: 'SUPPLIER-' + unitCode,
          expires_at: sharedExpiry,
          attributes: {},
        } as never,
        'wms-fefo-equal-expiry-' + label + '-' + randomUUID(), randomUUID(), randomUUID(),
      );
      if (!unit.id) throw new Error('FEFO equal-expiry traceability lot fixture was not created');
      return unit.id;
    };

    // With no GRN-line association, the allocator's documented receipt-time
    // fallback is traceability_units.created_at. Separate commits establish an
    // unambiguous order while both identities retain the exact same expiry.
    const firstReceivedLotId = await createLot('FIRST-RECEIVED');
    await adminPool.query('SELECT pg_sleep(0.04)');
    const secondReceivedLotId = await createLot('SECOND-RECEIVED');
    const receivedOrder = await adminPool.query<{
      id: string; unit_code: string; expires_at: string; received_at: string;
    }>(
      `SELECT tu.id::text AS id, tu.unit_code, tu.expires_at::text AS expires_at,
              COALESCE(gr.posted_at, gr.received_at, tu.created_at)::text AS received_at
       FROM traceability_units tu
       LEFT JOIN goods_receipts gr
         ON gr.id=tu.goods_receipt_id AND gr.tenant_id=tu.tenant_id AND gr.factory_id=tu.factory_id
       WHERE tu.tenant_id=$1 AND tu.factory_id=$2 AND tu.id=ANY($3::uuid[])
       ORDER BY COALESCE(gr.posted_at, gr.received_at, tu.created_at), lower(tu.unit_code), tu.id`,
      [tenantId, factoryId, [firstReceivedLotId, secondReceivedLotId]],
    );
    expect(receivedOrder.rows.map((row) => row.id)).toEqual([firstReceivedLotId, secondReceivedLotId]);
    expect(receivedOrder.rows[0]?.expires_at).toBe(receivedOrder.rows[1]?.expires_at);
    expect(new Date(receivedOrder.rows[0]!.received_at).getTime())
      .toBeLessThan(new Date(receivedOrder.rows[1]!.received_at).getTime());

    await locationService.transferStock(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { movement_purpose: 'PUT_AWAY', source_location_id: defaultLocationId,
        destination_location_id: bin.id, traceability_unit_id: firstReceivedLotId, quantity: 3 } as never,
      'wms-fefo-tie-putaway-first-' + randomUUID(), null, randomUUID(),
    );
    await locationService.transferStock(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { movement_purpose: 'PUT_AWAY', source_location_id: defaultLocationId,
        destination_location_id: bin.id, traceability_unit_id: secondReceivedLotId, quantity: 3 } as never,
      'wms-fefo-tie-putaway-second-' + randomUUID(), null, randomUUID(),
    );

    const reserve = (key: string) => service.createReservation(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { quantity: 4, location_id: bin.id } as CreateInventoryReservationDto,
      key, null, randomUUID(),
    );
    const competing = await Promise.allSettled([
      reserve('wms-fefo-tie-competitor-a-' + randomUUID()),
      reserve('wms-fefo-tie-competitor-b-' + randomUUID()),
    ]);
    expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = competing.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(String(rejected?.reason?.message ?? rejected?.reason))
      .toContain('Insufficient eligible FEFO lot/serial stock');

    const reservations = await adminPool.query<{ id: string; quantity: string; status: string }>(
      `SELECT id::text AS id, quantity::text AS quantity, status
       FROM inventory_reservations
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3
       ORDER BY created_at, id`,
      [tenantId, factoryId, itemId],
    );
    expect(reservations.rows).toHaveLength(1);
    expect(reservations.rows[0]).toMatchObject({ quantity: '4.0000', status: 'RESERVED' });

    const allocations = await adminPool.query<{
      traceability_unit_id: string; allocation_sequence: number; allocated_quantity: string;
    }>(
      `SELECT a.traceability_unit_id::text AS traceability_unit_id,
              a.allocation_sequence, a.allocated_quantity::text AS allocated_quantity
       FROM inventory_reservation_traceability_allocations a
       WHERE a.tenant_id=$1 AND a.factory_id=$2 AND a.item_id=$3
         AND a.reservation_id=$4
       ORDER BY a.allocation_sequence`,
      [tenantId, factoryId, itemId, reservations.rows[0]!.id],
    );
    expect(allocations.rows).toEqual([
      { traceability_unit_id: firstReceivedLotId, allocation_sequence: 1, allocated_quantity: '3.0000' },
      { traceability_unit_id: secondReceivedLotId, allocation_sequence: 2, allocated_quantity: '1.0000' },
    ]);

    const lotBalances = await adminPool.query<{
      unit_id: string; quantity_on_hand: string; quantity_reserved: string;
    }>(
      `SELECT traceability_unit_id::text AS unit_id,
              quantity_on_hand::text AS quantity_on_hand,
              quantity_reserved::text AS quantity_reserved
       FROM inventory_traceability_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND location_id=$4
       ORDER BY traceability_unit_id`,
      [tenantId, factoryId, itemId, bin.id],
    );
    expect(lotBalances.rows).toHaveLength(2);
    expect(lotBalances.rows).toEqual(expect.arrayContaining([
      { unit_id: firstReceivedLotId, quantity_on_hand: '3.0000', quantity_reserved: '3.0000' },
      { unit_id: secondReceivedLotId, quantity_on_hand: '3.0000', quantity_reserved: '1.0000' },
    ]));

    const reconciled = await adminPool.query<{
      stock_on_hand: string; stock_reserved: string; bin_on_hand: string; bin_reserved: string;
    }>(
      `SELECT s.quantity_on_hand::text AS stock_on_hand,
              s.quantity_reserved::text AS stock_reserved,
              b.quantity_on_hand::text AS bin_on_hand,
              b.quantity_reserved::text AS bin_reserved
       FROM inventory_stock_balances s
       JOIN inventory_location_balances b
         ON b.tenant_id=s.tenant_id AND b.factory_id=s.factory_id AND b.item_id=s.item_id
       WHERE s.tenant_id=$1 AND s.factory_id=$2 AND s.item_id=$3 AND b.location_id=$4`,
      [tenantId, factoryId, itemId, bin.id],
    );
    expect(reconciled.rows[0]).toEqual({
      stock_on_hand: '6.0000', stock_reserved: '4.0000',
      bin_on_hand: '6.0000', bin_reserved: '4.0000',
    });
  });

  it('uses actual posted-GRN time ahead of received_at and identity creation order for equal-expiry FEFO lots under contention', async () => {
    const itemId = await createItem('0.0000');
    const approverId = randomUUID();
    await adminPool.query('INSERT INTO users (id, display_name) VALUES ($1, $2)', [
      approverId, 'FEFO posted-GRN integration approver',
    ]);
    approverIds.push(approverId);

    const supplier = await procurementService.createSupplier(
      TEST_USER_ID, tenantId,
      { code: 'WMS-FEFO-GRN-SUP-' + randomUUID().slice(0, 8), name: 'FEFO posted-GRN supplier', country_code: 'BD', currency: 'BDT' } as never,
      null, null,
    );
    supplierIds.push(supplier.id);
    const po = await procurementService.createPurchaseOrder(
      TEST_USER_ID, tenantId, factoryId,
      {
        supplier_id: supplier.id,
        po_number: 'WMS-FEFO-GRN-PO-' + randomUUID().slice(0, 8),
        currency: 'BDT',
        lines: [{
          line_number: 1, inventory_item_id: itemId,
          description: 'FEFO posted-GRN timestamp material',
          quantity: 6, unit: 'PCS', unit_price: 1,
        }],
      } as never,
      'wms-fefo-grn-po-' + randomUUID(), null, null,
    );
    purchaseOrderIds.push(po.id);
    await procurementService.transitionPurchaseOrder(
      TEST_USER_ID, tenantId, factoryId, po.id,
      'SUBMITTED', 1, 'Submit FEFO GRN fixture PO', null, null,
    );
    const approved = await procurementService.transitionPurchaseOrder(
      approverId, tenantId, factoryId, po.id,
      'APPROVED', 2, 'Approve FEFO GRN fixture PO', null, null,
    );
    expect(approved.status).toBe('APPROVED');

    const poLine = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM purchase_order_lines WHERE tenant_id=$1 AND factory_id=$2 AND purchase_order_id=$3 AND line_number=1',
      [tenantId, factoryId, po.id],
    );
    const poLineId = poLine.rows[0]?.id;
    if (!poLineId) throw new Error('FEFO GRN fixture PO line missing');

    // First posted GRN has later received_at. posted_at alone should still
    // rank its LOT ahead of the second receipt.
    const clock = await adminPool.query<{ now: string }>('SELECT clock_timestamp()::text AS now');
    const now = clock.rows[0]?.now;
    if (!now) throw new Error('PostgreSQL clock_timestamp unavailable');
    const firstReceivedAt = new Date(new Date(now).getTime() - 60 * 60 * 1000).toISOString();
    const secondReceivedAt = new Date(new Date(now).getTime() - 2 * 60 * 60 * 1000).toISOString();
    const postGrn = (receivedAt: string, label: string) => goodsReceiptService.postGoodsReceipt(
      TEST_USER_ID, tenantId, factoryId, po.id,
      {
        received_at: receivedAt,
        supplier_delivery_reference: 'FEFO-GRN-' + label + '-' + randomUUID().slice(0, 6),
        notes: 'Real GRN-backed FEFO receipt-time precedence integration fixture',
        lines: [{ purchase_order_line_id: poLineId, received_quantity: 3, rejected_quantity: 0 }],
      } as never,
      'wms-fefo-grn-' + label + '-' + randomUUID(), null, randomUUID(),
    );

    const firstReceipt = await postGrn(firstReceivedAt, 'FIRST-POSTED');
    goodsReceiptIds.push(firstReceipt.id);
    await adminPool.query('SELECT pg_sleep(0.05)');
    const secondReceipt = await postGrn(secondReceivedAt, 'SECOND-POSTED');
    goodsReceiptIds.push(secondReceipt.id);
    expect(firstReceipt.status).toBe('POSTED');
    expect(secondReceipt.status).toBe('POSTED');
    const firstLineId = firstReceipt.lines[0]?.id;
    const secondLineId = secondReceipt.lines[0]?.id;
    if (!firstLineId || !secondLineId) throw new Error('Posted GRN line identity missing');
    expect(firstReceipt.lines[0]?.accepted_quantity).toBe('3.0000');
    expect(secondReceipt.lines[0]?.accepted_quantity).toBe('3.0000');

    const receipts = await adminPool.query<{
      id: string; status: string; line_id: string; accepted_quantity: string;
      received_at: string; posted_at: string; location_id: string; location_type: string;
    }>(
      `SELECT gr.id::text AS id, gr.status, gl.id::text AS line_id,
              gl.accepted_quantity::text AS accepted_quantity,
              gr.received_at::text AS received_at, gr.posted_at::text AS posted_at,
              gr.location_id::text AS location_id, l.location_type
       FROM goods_receipts gr
       JOIN goods_receipt_lines gl ON gl.goods_receipt_id=gr.id
         AND gl.tenant_id=gr.tenant_id AND gl.factory_id=gr.factory_id
       JOIN inventory_locations l ON l.id=gr.location_id
         AND l.tenant_id=gr.tenant_id AND l.factory_id=gr.factory_id
       WHERE gr.tenant_id=$1 AND gr.factory_id=$2 AND gr.id=ANY($3::uuid[])
       ORDER BY gr.posted_at, gr.id`,
      [tenantId, factoryId, [firstReceipt.id, secondReceipt.id]],
    );
    expect(receipts.rows).toHaveLength(2);
    expect(receipts.rows.map(row => row.id)).toEqual([firstReceipt.id, secondReceipt.id]);
    expect(receipts.rows.map(row => row.status)).toEqual(['POSTED', 'POSTED']);
    expect(receipts.rows.map(row => row.line_id)).toEqual([firstLineId, secondLineId]);
    expect(receipts.rows.every(row => row.accepted_quantity === '3.0000')).toBe(true);
    expect(receipts.rows[0]?.location_type).toBe('VIRTUAL');
    expect(new Date(receipts.rows[0]!.posted_at).getTime()).toBeLessThan(new Date(receipts.rows[1]!.posted_at).getTime());
    expect(new Date(receipts.rows[0]!.received_at).getTime()).toBeGreaterThan(new Date(receipts.rows[1]!.received_at).getTime());
    const unassignedLocationId = receipts.rows[0]?.location_id;
    if (!unassignedLocationId || receipts.rows[1]?.location_id !== unassignedLocationId) {
      throw new Error('Both GRNs must post into the same factory UNASSIGNED bucket');
    }

    const dateResult = await adminPool.query<{ current_date: string }>("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS current_date");
    const currentDate = dateResult.rows[0]?.current_date;
    if (!currentDate) throw new Error('PostgreSQL CURRENT_DATE unavailable');
    const expiry = new Date(currentDate + 'T00:00:00.000Z');
    expiry.setUTCDate(expiry.getUTCDate() + 60);
    const sharedExpiry = expiry.toISOString().slice(0, 10);

    const createLot = async (label: string, lineId: string): Promise<string> => {
      const code = 'LOT-FEFO-POSTED-GRN-' + label + '-' + randomUUID().slice(0, 6);
      const unit = await traceabilityService.createUnit(
        TEST_USER_ID, tenantId, factoryId,
        {
          unit_type: 'LOT', product_role: 'MATERIAL',
          unit_code: code, barcode_value: 'BAR-' + code,
          inventory_item_id: itemId, goods_receipt_line_id: lineId,
          quantity: 3, unit: 'PCS', expires_at: sharedExpiry, attributes: {},
        } as never,
        'wms-fefo-posted-grn-' + label + '-' + randomUUID(), randomUUID(), randomUUID(),
      );
      if (!unit.id) throw new Error('GRN-linked FEFO lot was not created');
      return unit.id;
    };

    // Create the second GRN identity first. A sort on received_at or created_at
    // would incorrectly select this LOT before the first-posted GRN LOT.
    const secondPostedLotId = await createLot('SECOND-POSTED', secondLineId);
    await adminPool.query('SELECT pg_sleep(0.05)');
    const firstPostedLotId = await createLot('FIRST-POSTED', firstLineId);
    const provenance = await adminPool.query<{
      id: string; expiry: string; identity_created_at: string; receipt_status: string;
      received_at: string; posted_at: string; accepted_quantity: string; effective_receipt_at: string;
    }>(
      `SELECT tu.id::text AS id, tu.expires_at::text AS expiry,
              tu.created_at::text AS identity_created_at, gr.status AS receipt_status,
              gr.received_at::text AS received_at, gr.posted_at::text AS posted_at,
              gl.accepted_quantity::text AS accepted_quantity,
              COALESCE(gr.posted_at, gr.received_at, tu.created_at)::text AS effective_receipt_at
       FROM traceability_units tu
       JOIN goods_receipt_lines gl ON gl.id=tu.goods_receipt_line_id
         AND gl.tenant_id=tu.tenant_id AND gl.factory_id=tu.factory_id
       JOIN goods_receipts gr ON gr.id=gl.goods_receipt_id
         AND gr.tenant_id=gl.tenant_id AND gr.factory_id=gl.factory_id
       WHERE tu.tenant_id=$1 AND tu.factory_id=$2 AND tu.id=ANY($3::uuid[])
       ORDER BY COALESCE(gr.posted_at, gr.received_at, tu.created_at), lower(tu.unit_code), tu.id`,
      [tenantId, factoryId, [firstPostedLotId, secondPostedLotId]],
    );
    expect(provenance.rows).toHaveLength(2);
    expect(provenance.rows.map(row => row.id)).toEqual([firstPostedLotId, secondPostedLotId]);
    expect(provenance.rows.every(row => row.receipt_status === 'POSTED' && row.accepted_quantity === '3.0000')).toBe(true);
    expect(provenance.rows[0]?.expiry).toBe(provenance.rows[1]?.expiry);
    expect(new Date(provenance.rows[0]!.posted_at).getTime()).toBeLessThan(new Date(provenance.rows[1]!.posted_at).getTime());
    expect(new Date(provenance.rows[0]!.received_at).getTime()).toBeGreaterThan(new Date(provenance.rows[1]!.received_at).getTime());
    expect(new Date(provenance.rows[0]!.identity_created_at).getTime()).toBeGreaterThan(new Date(provenance.rows[1]!.identity_created_at).getTime());
    expect(new Date(provenance.rows[0]!.effective_receipt_at).getTime()).toBeLessThan(new Date(provenance.rows[1]!.effective_receipt_at).getTime());

    const warehouse = await locationService.createLocation(
      TEST_USER_ID, tenantId, factoryId,
      { location_code: 'WMS-FEFO-GRN-WH-' + randomUUID().slice(0, 8), name: 'FEFO posted-GRN warehouse', location_type: 'WAREHOUSE' } as never,
      null, randomUUID(),
    );
    const bin = await locationService.createLocation(
      TEST_USER_ID, tenantId, factoryId,
      { location_code: 'WMS-FEFO-GRN-BIN-' + randomUUID().slice(0, 8), name: 'FEFO posted-GRN competing-demand bin', location_type: 'BIN', parent_location_id: warehouse.id } as never,
      null, randomUUID(),
    );
    locationIds.push(warehouse.id, bin.id);
    await adminPool.query(
      `INSERT INTO inventory_material_allocation_policies (
         tenant_id, factory_id, policy_scope, inventory_item_id, allocation_policy,
         require_traceability, created_by_user_id, updated_by_user_id
       ) VALUES ($1,$2,'MATERIAL',$3,'FEFO',TRUE,$4,$4)`,
      [tenantId, factoryId, itemId, TEST_USER_ID],
    );

    await locationService.transferStock(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { movement_purpose: 'PUT_AWAY', source_location_id: unassignedLocationId, destination_location_id: bin.id,
        traceability_unit_id: firstPostedLotId, quantity: 3 } as never,
      'wms-fefo-grn-putaway-first-' + randomUUID(), null, randomUUID(),
    );
    await locationService.transferStock(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { movement_purpose: 'PUT_AWAY', source_location_id: unassignedLocationId, destination_location_id: bin.id,
        traceability_unit_id: secondPostedLotId, quantity: 3 } as never,
      'wms-fefo-grn-putaway-second-' + randomUUID(), null, randomUUID(),
    );

    const reserve = (key: string) => service.createReservation(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { quantity: 4, location_id: bin.id } as CreateInventoryReservationDto,
      key, null, randomUUID(),
    );
    const competing = await Promise.allSettled([
      reserve('wms-fefo-grn-competitor-a-' + randomUUID()),
      reserve('wms-fefo-grn-competitor-b-' + randomUUID()),
    ]);
    expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(competing.filter(result => result.status === 'rejected')).toHaveLength(1);
    const rejected = competing.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(String(rejected?.reason?.message ?? rejected?.reason)).toContain('Insufficient eligible FEFO lot/serial stock');

    const reservations = await adminPool.query<{ id: string; quantity: string; status: string }>(
      `SELECT id::text AS id, quantity::text AS quantity, status
       FROM inventory_reservations WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3
       ORDER BY created_at, id`,
      [tenantId, factoryId, itemId],
    );
    expect(reservations.rows).toHaveLength(1);
    expect(reservations.rows[0]).toMatchObject({ quantity: '4.0000', status: 'RESERVED' });
    const allocations = await adminPool.query<{
      traceability_unit_id: string; allocation_sequence: number; allocated_quantity: string;
    }>(
      `SELECT traceability_unit_id::text AS traceability_unit_id, allocation_sequence,
              allocated_quantity::text AS allocated_quantity
       FROM inventory_reservation_traceability_allocations
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND reservation_id=$4
       ORDER BY allocation_sequence`,
      [tenantId, factoryId, itemId, reservations.rows[0]!.id],
    );
    expect(allocations.rows).toEqual([
      { traceability_unit_id: firstPostedLotId, allocation_sequence: 1, allocated_quantity: '3.0000' },
      { traceability_unit_id: secondPostedLotId, allocation_sequence: 2, allocated_quantity: '1.0000' },
    ]);

    const lotBalances = await adminPool.query<{
      unit_id: string; quantity_on_hand: string; quantity_reserved: string;
    }>(
      `SELECT traceability_unit_id::text AS unit_id,
              quantity_on_hand::text AS quantity_on_hand,
              quantity_reserved::text AS quantity_reserved
       FROM inventory_traceability_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND location_id=$4`,
      [tenantId, factoryId, itemId, bin.id],
    );
    expect(lotBalances.rows).toHaveLength(2);
    expect(lotBalances.rows).toEqual(expect.arrayContaining([
      { unit_id: firstPostedLotId, quantity_on_hand: '3.0000', quantity_reserved: '3.0000' },
      { unit_id: secondPostedLotId, quantity_on_hand: '3.0000', quantity_reserved: '1.0000' },
    ]));
    const reconciled = await adminPool.query<{
      stock_on_hand: string; stock_reserved: string; bin_on_hand: string; bin_reserved: string;
    }>(
      `SELECT s.quantity_on_hand::text AS stock_on_hand, s.quantity_reserved::text AS stock_reserved,
              b.quantity_on_hand::text AS bin_on_hand, b.quantity_reserved::text AS bin_reserved
       FROM inventory_stock_balances s
       JOIN inventory_location_balances b ON b.tenant_id=s.tenant_id
         AND b.factory_id=s.factory_id AND b.item_id=s.item_id
       WHERE s.tenant_id=$1 AND s.factory_id=$2 AND s.item_id=$3 AND b.location_id=$4`,
      [tenantId, factoryId, itemId, bin.id],
    );
    expect(reconciled.rows[0]).toEqual({
      stock_on_hand: '6.0000', stock_reserved: '4.0000',
      bin_on_hand: '6.0000', bin_reserved: '4.0000',
    });
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

  it('allocates concurrent FIFO reservations to successive oldest-received lots without double-claiming a lot', async () => {
    const itemId = await createItem('6.0000');
    const defaultResult = await adminPool.query<{ id: string }>(
      `SELECT id::text AS id FROM inventory_locations
       WHERE tenant_id=$1 AND factory_id=$2 AND is_default=TRUE AND status='ACTIVE'`,
      [tenantId, factoryId],
    );
    const defaultLocationId = defaultResult.rows[0]?.id;
    if (!defaultLocationId) throw new Error('Factory UNASSIGNED location missing');

    const warehouse = await locationService.createLocation(
      TEST_USER_ID, tenantId, factoryId,
      { location_code: 'WMS-FIFO-WH-' + randomUUID().slice(0, 8), name: 'FIFO concurrency warehouse', location_type: 'WAREHOUSE' } as never,
      null, randomUUID(),
    );
    const bin = await locationService.createLocation(
      TEST_USER_ID, tenantId, factoryId,
      { location_code: 'WMS-FIFO-BIN-' + randomUUID().slice(0, 8), name: 'FIFO concurrency bin', location_type: 'BIN', parent_location_id: warehouse.id } as never,
      null, randomUUID(),
    );
    locationIds.push(warehouse.id, bin.id);

    const dateResult = await adminPool.query<{ current_date: string }>(
      "SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS current_date",
    );
    const currentDate = dateResult.rows[0]?.current_date;
    if (!currentDate || !/^\d{4}-\d{2}-\d{2}$/.test(currentDate)) {
      throw new Error('PostgreSQL CURRENT_DATE is unavailable for FIFO lot fixtures');
    }
    const futureExpiry = new Date(currentDate + 'T00:00:00.000Z');
    futureExpiry.setUTCDate(futureExpiry.getUTCDate() + 90);
    const expiry = futureExpiry.toISOString().slice(0, 10);

    const createLot = async (label: string, key: string): Promise<string> => {
      const unitCode = 'LOT-FIFO-' + label + '-' + randomUUID().slice(0, 6);
      const unit = await traceabilityService.createUnit(
        TEST_USER_ID, tenantId, factoryId,
        {
          unit_type: 'LOT',
          product_role: 'MATERIAL',
          unit_code: unitCode,
          barcode_value: 'BAR-' + unitCode,
          inventory_item_id: itemId,
          quantity: 3,
          unit: 'PCS',
          external_reference: 'SUPPLIER-' + unitCode,
          expires_at: expiry,
          attributes: {},
        } as never,
        key, randomUUID(), randomUUID(),
      );
      if (!unit.id) throw new Error('FIFO traceability lot fixture was not created');
      return unit.id;
    };

    const olderLotId = await createLot('OLDER', 'wms-fifo-older-' + randomUUID());
    // Keep receipt timestamps distinct so the test proves receipt ordering, not the
    // final unit-code/location/id tie-breakers.
    await adminPool.query('SELECT pg_sleep(0.02)');
    const newerLotId = await createLot('NEWER', 'wms-fifo-newer-' + randomUUID());

    await adminPool.query(
      `INSERT INTO inventory_material_allocation_policies (
         tenant_id, factory_id, policy_scope, inventory_item_id, allocation_policy,
         require_traceability, created_by_user_id, updated_by_user_id
       ) VALUES ($1,$2,'MATERIAL',$3,'FIFO',TRUE,$4,$4)`,
      [tenantId, factoryId, itemId, TEST_USER_ID],
    );

    await locationService.transferStock(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { movement_purpose: 'PUT_AWAY', source_location_id: defaultLocationId,
        destination_location_id: bin.id, traceability_unit_id: olderLotId, quantity: 3 } as never,
      'wms-fifo-putaway-older-' + randomUUID(), null, randomUUID(),
    );
    await locationService.transferStock(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { movement_purpose: 'PUT_AWAY', source_location_id: defaultLocationId,
        destination_location_id: bin.id, traceability_unit_id: newerLotId, quantity: 3 } as never,
      'wms-fifo-putaway-newer-' + randomUUID(), null, randomUUID(),
    );

    const createCompetingReservation = (key: string) => service.createReservation(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { quantity: 3, location_id: bin.id } as CreateInventoryReservationDto,
      key, null, randomUUID(),
    );
    const concurrent = await Promise.all([
      createCompetingReservation('wms-fifo-demand-a-' + randomUUID()),
      createCompetingReservation('wms-fifo-demand-b-' + randomUUID()),
    ]);
    expect(concurrent).toHaveLength(2);
    expect(concurrent.every((reservation) => reservation.status === 'RESERVED')).toBe(true);

    const persisted = await adminPool.query<{
      reservation_id: string; quantity: string; unit_code: string;
      allocated_quantity: string; received_at: string; created_at: string;
    }>(
      `
      SELECT r.id::text AS reservation_id, r.quantity::text AS quantity,
             tu.unit_code, a.allocated_quantity::text AS allocated_quantity,
             COALESCE(gr.posted_at, gr.received_at, tu.created_at)::text AS received_at,
             r.created_at::text AS created_at
      FROM inventory_reservations r
      JOIN inventory_reservation_traceability_allocations a
        ON a.reservation_id=r.id AND a.tenant_id=r.tenant_id AND a.factory_id=r.factory_id
      JOIN traceability_units tu
        ON tu.id=a.traceability_unit_id AND tu.tenant_id=a.tenant_id AND tu.factory_id=a.factory_id
      LEFT JOIN goods_receipts gr
        ON gr.id=tu.goods_receipt_id AND gr.tenant_id=tu.tenant_id AND gr.factory_id=tu.factory_id
      WHERE r.tenant_id=$1 AND r.factory_id=$2 AND r.item_id=$3
        AND r.id = ANY($4::uuid[])
      ORDER BY r.created_at, r.id, a.allocation_sequence
      `,
      [tenantId, factoryId, itemId, concurrent.map((reservation) => reservation.id)],
    );
    expect(persisted.rows).toHaveLength(2);
    expect(persisted.rows.map((row) => row.quantity)).toEqual(['3.0000', '3.0000']);
    expect(persisted.rows.map((row) => row.allocated_quantity)).toEqual(['3.0000', '3.0000']);
    expect(persisted.rows[0]?.unit_code).toContain('LOT-FIFO-OLDER');
    expect(persisted.rows[1]?.unit_code).toContain('LOT-FIFO-NEWER');
    expect(new Date(persisted.rows[0]!.received_at).getTime())
      .toBeLessThan(new Date(persisted.rows[1]!.received_at).getTime());

    const aggregate = await adminPool.query<{ quantity_on_hand: string; quantity_reserved: string }>(
      `SELECT quantity_on_hand::text, quantity_reserved::text
       FROM inventory_stock_balances WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3`,
      [tenantId, factoryId, itemId],
    );
    expect(aggregate.rows[0]).toMatchObject({ quantity_on_hand: '6.0000', quantity_reserved: '6.0000' });

    const binBalance = await adminPool.query<{ quantity_on_hand: string; quantity_reserved: string }>(
      `SELECT quantity_on_hand::text, quantity_reserved::text
       FROM inventory_location_balances
       WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND location_id=$4`,
      [tenantId, factoryId, itemId, bin.id],
    );
    expect(binBalance.rows[0]).toMatchObject({ quantity_on_hand: '6.0000', quantity_reserved: '6.0000' });

    const lotBalances = await adminPool.query<{
      unit_code: string; quantity_on_hand: string; quantity_reserved: string;
    }>(
      `SELECT tu.unit_code, tlb.quantity_on_hand::text, tlb.quantity_reserved::text
       FROM inventory_traceability_location_balances tlb
       JOIN traceability_units tu ON tu.id=tlb.traceability_unit_id
       WHERE tlb.tenant_id=$1 AND tlb.factory_id=$2 AND tlb.item_id=$3
         AND tlb.traceability_unit_id = ANY($4::uuid[])
         AND tlb.location_id=$5
       ORDER BY tu.unit_code`,
      [tenantId, factoryId, itemId, [olderLotId, newerLotId], bin.id],
    );
    expect(lotBalances.rows).toHaveLength(2);
    expect(lotBalances.rows.every((row) =>
      row.quantity_on_hand === '3.0000' && row.quantity_reserved === '3.0000',
    )).toBe(true);
  });


  it('enforces FEFO/FIFO policy per factory and sector across supplier-backed posted GRNs under competing demand', async () => {
    const approverId = randomUUID();
    await adminPool.query('INSERT INTO users (id, display_name) VALUES ($1, $2)', [
      approverId, 'WP02 provider-site acceptance approver',
    ]);
    approverIds.push(approverId);

    const createSite = async (label: string): Promise<{ id: string; unassignedLocationId: string }> => {
      const created = await adminPool.query<{ id: string }>(
        `INSERT INTO factories (tenant_id, code, name, status)
         VALUES ($1,$2,$3,'ACTIVE') RETURNING id::text AS id`,
        [tenantId, 'WP02-SITE-' + label + '-' + randomUUID().slice(0, 8), 'WP02 representative site ' + label],
      );
      const id = created.rows[0]?.id;
      if (!id) throw new Error('WP02 representative factory was not created');
      factoryIds.push(id);
      const location = await adminPool.query<{ id: string }>(
        `SELECT id::text AS id FROM inventory_locations
         WHERE tenant_id=$1 AND factory_id=$2 AND is_default=TRUE AND status='ACTIVE'`,
        [tenantId, id],
      );
      const unassignedLocationId = location.rows[0]?.id;
      if (!unassignedLocationId) throw new Error('WP02 site default UNASSIGNED location was not seeded');
      locationIds.push(unassignedLocationId);
      return { id, unassignedLocationId };
    };

    const siteA = await createSite('A');
    const siteB = await createSite('B');

    const createPolicy = async (
      targetFactoryId: string,
      scope: 'FACTORY' | 'SECTOR',
      allocationPolicy: 'FIFO' | 'FEFO',
      sectorCode: string | null = null,
    ) => {
      const result = await adminPool.query<{ id: string }>(
        `INSERT INTO inventory_material_allocation_policies (
           tenant_id, factory_id, policy_scope, sector_code, inventory_item_id,
           allocation_policy, require_traceability, created_by_user_id, updated_by_user_id
         ) VALUES ($1,$2,$3,$4,NULL,$5,TRUE,$6,$6)
         RETURNING id::text AS id`,
        [tenantId, targetFactoryId, scope, sectorCode, allocationPolicy, TEST_USER_ID],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('WP02 site allocation policy was not created');
      policyIds.push(id);
    };

    // Site A defaults to FEFO; its APPAREL sector overrides that policy with FIFO.
    // Site B uses FIFO for the same FOOD sector code used at Site A.
    await createPolicy(siteA.id, 'FACTORY', 'FEFO');
    await createPolicy(siteA.id, 'SECTOR', 'FIFO', 'APPAREL');
    await createPolicy(siteB.id, 'FACTORY', 'FIFO');

    const supplierA = await procurementService.createSupplier(
      TEST_USER_ID, tenantId,
      {
        code: 'WP02-SOURCE-A-' + randomUUID().slice(0, 8),
        name: 'WP02 Supplier Source A ' + randomUUID().slice(0, 6),
        country_code: 'BD', currency: 'BDT',
      } as never,
      null, null,
    );
    supplierIds.push(supplierA.id);
    const supplierB = await procurementService.createSupplier(
      TEST_USER_ID, tenantId,
      {
        code: 'WP02-SOURCE-B-' + randomUUID().slice(0, 8),
        name: 'WP02 Supplier Source B ' + randomUUID().slice(0, 6),
        country_code: 'BD', currency: 'BDT',
      } as never,
      null, null,
    );
    supplierIds.push(supplierB.id);

    const createItemAtSite = async (targetFactoryId: string, sectorCode: string): Promise<string> => {
      const result = await adminPool.query<{ id: string }>(
        `INSERT INTO inventory_items (
           tenant_id, factory_id, sku, name, unit, sector_code, created_by_user_id
         ) VALUES ($1,$2,$3,$4,'PCS',$5,$6)
         RETURNING id::text AS id`,
        [
          tenantId, targetFactoryId, 'WP02-PROVIDER-SITE-' + randomUUID().slice(0, 10),
          'WP02 provider/site FEFO acceptance material', sectorCode, TEST_USER_ID,
        ],
      );
      const itemId = result.rows[0]?.id;
      if (!itemId) throw new Error('WP02 site allocation item was not created');
      itemIds.push(itemId);
      await adminPool.query(
        `INSERT INTO inventory_stock_balances (
           tenant_id, factory_id, item_id, quantity_on_hand, quantity_reserved
         ) VALUES ($1,$2,$3,0,0)`,
        [tenantId, targetFactoryId, itemId],
      );
      return itemId;
    };

    const createBin = async (targetFactoryId: string, label: string): Promise<string> => {
      const warehouse = await locationService.createLocation(
        TEST_USER_ID, tenantId, targetFactoryId,
        {
          location_code: 'WP02-' + label + '-WH-' + randomUUID().slice(0, 8),
          name: 'WP02 representative warehouse ' + label,
          location_type: 'WAREHOUSE',
        } as never,
        null, randomUUID(),
      );
      const bin = await locationService.createLocation(
        TEST_USER_ID, tenantId, targetFactoryId,
        {
          location_code: 'WP02-' + label + '-BIN-' + randomUUID().slice(0, 8),
          name: 'WP02 representative picking bin ' + label,
          location_type: 'BIN',
          parent_location_id: warehouse.id,
        } as never,
        null, randomUUID(),
      );
      locationIds.push(warehouse.id, bin.id);
      return bin.id;
    };
    const siteABinId = await createBin(siteA.id, 'SITE-A');
    const siteBBinId = await createBin(siteB.id, 'SITE-B');

    const dateResult = await adminPool.query<{ current_date: string }>(
      `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS current_date`,
    );
    const databaseDate = dateResult.rows[0]?.current_date;
    if (!databaseDate) throw new Error('PostgreSQL CURRENT_DATE unavailable for WP02 fixture');
    const expiryAt = (offsetDays: number): string => {
      const date = new Date(databaseDate + 'T00:00:00.000Z');
      date.setUTCDate(date.getUTCDate() + offsetDays);
      return date.toISOString().slice(0, 10);
    };
    const laterExpiry = expiryAt(60);
    const earlierExpiry = expiryAt(30);

    const createSupplierBackedLot = async (
      label: string,
      targetFactoryId: string,
      itemId: string,
      supplierId: string,
      expiresAt: string,
    ): Promise<{ lotId: string; receiptId: string; supplierId: string; expiry: string }> => {
      const po = await procurementService.createPurchaseOrder(
        TEST_USER_ID, tenantId, targetFactoryId,
        {
          supplier_id: supplierId,
          po_number: 'WP02-PROVIDER-SITE-PO-' + randomUUID().slice(0, 8),
          currency: 'BDT',
          lines: [{
            line_number: 1,
            inventory_item_id: itemId,
            description: 'Supplier-originated representative FEFO/FIFO material',
            quantity: 3,
            unit: 'PCS',
            unit_price: 1,
          }],
        } as never,
        'wp02-provider-site-po-' + randomUUID(), null, randomUUID(),
      );
      purchaseOrderIds.push(po.id);
      await procurementService.transitionPurchaseOrder(
        TEST_USER_ID, tenantId, targetFactoryId, po.id,
        'SUBMITTED', 1, 'Submit representative provider/site FEFO/FIFO PO', null, randomUUID(),
      );
      const approved = await procurementService.transitionPurchaseOrder(
        approverId, tenantId, targetFactoryId, po.id,
        'APPROVED', 2, 'Independent approval for representative provider/site FEFO/FIFO PO', null, randomUUID(),
      );
      expect(approved.status).toBe('APPROVED');

      const poLine = await adminPool.query<{ id: string }>(
        `SELECT id::text AS id FROM purchase_order_lines
         WHERE tenant_id=$1 AND factory_id=$2 AND purchase_order_id=$3 AND line_number=1`,
        [tenantId, targetFactoryId, po.id],
      );
      const poLineId = poLine.rows[0]?.id;
      if (!poLineId) throw new Error('WP02 representative supplier PO line missing');

      const receipt = await goodsReceiptService.postGoodsReceipt(
        TEST_USER_ID, tenantId, targetFactoryId, po.id,
        {
          supplier_delivery_reference: 'WP02-SITE-DELIVERY-' + label + '-' + randomUUID().slice(0, 6),
          notes: 'Supplier-backed representative multi-site allocation evidence',
          lines: [{ purchase_order_line_id: poLineId, received_quantity: 3, rejected_quantity: 0 }],
        } as never,
        'wp02-provider-site-grn-' + randomUUID(), null, randomUUID(),
      );
      goodsReceiptIds.push(receipt.id);
      expect(receipt.status).toBe('POSTED');
      expect(receipt.lines[0]?.accepted_quantity).toBe('3.0000');
      const lineId = receipt.lines[0]?.id;
      if (!lineId) throw new Error('WP02 supplier-backed GRN line missing');

      const unitCode = 'LOT-WP02-' + label + '-' + randomUUID().slice(0, 8);
      const unit = await traceabilityService.createUnit(
        TEST_USER_ID, tenantId, targetFactoryId,
        {
          unit_type: 'LOT',
          product_role: 'MATERIAL',
          unit_code: unitCode,
          barcode_value: 'BAR-' + unitCode,
          inventory_item_id: itemId,
          goods_receipt_line_id: lineId,
          quantity: 3,
          unit: 'PCS',
          expires_at: expiresAt,
          attributes: {},
        } as never,
        'wp02-provider-site-lot-' + randomUUID(), randomUUID(), randomUUID(),
      );
      if (!unit.id) throw new Error('WP02 supplier-backed material LOT was not created');
      return { lotId: unit.id, receiptId: receipt.id, supplierId, expiry: expiresAt };
    };

    const scenarios = [
      {
        label: 'SITE-A-FOOD-FACTORY-FEFO',
        factoryId: siteA.id,
        unassignedLocationId: siteA.unassignedLocationId,
        binId: siteABinId,
        sectorCode: 'FOOD',
        expectedPolicy: 'FEFO' as const,
      },
      {
        label: 'SITE-A-APPAREL-SECTOR-FIFO',
        factoryId: siteA.id,
        unassignedLocationId: siteA.unassignedLocationId,
        binId: siteABinId,
        sectorCode: 'APPAREL',
        expectedPolicy: 'FIFO' as const,
      },
      {
        label: 'SITE-B-FOOD-FACTORY-FIFO',
        factoryId: siteB.id,
        unassignedLocationId: siteB.unassignedLocationId,
        binId: siteBBinId,
        sectorCode: 'FOOD',
        expectedPolicy: 'FIFO' as const,
      },
    ];

    for (const scenario of scenarios) {
      const itemId = await createItemAtSite(scenario.factoryId, scenario.sectorCode);
      // The first source posts first but expires later. The second source posts
      // later but expires sooner: FEFO and FIFO must therefore choose opposite lots.
      const firstPostedLot = await createSupplierBackedLot(
        scenario.label + '-FIRST-POSTED', scenario.factoryId, itemId, supplierA.id, laterExpiry,
      );
      await adminPool.query('SELECT pg_sleep(0.05)');
      const secondPostedLot = await createSupplierBackedLot(
        scenario.label + '-SECOND-POSTED', scenario.factoryId, itemId, supplierB.id, earlierExpiry,
      );

      const receiptProvenance = await adminPool.query<{
        id: string;
        status: string;
        factory_id: string;
        supplier_id: string;
        supplier_name: string;
        posted_at: string;
        received_at: string;
        accepted_quantity: string;
      }>(
        `SELECT gr.id::text AS id, gr.status, gr.factory_id::text AS factory_id,
                po.supplier_id::text AS supplier_id, s.name AS supplier_name,
                gr.posted_at::text AS posted_at, gr.received_at::text AS received_at,
                gl.accepted_quantity::text AS accepted_quantity
         FROM goods_receipts gr
         JOIN purchase_orders po ON po.id=gr.purchase_order_id
           AND po.tenant_id=gr.tenant_id AND po.factory_id=gr.factory_id
         JOIN suppliers s ON s.id=po.supplier_id AND s.tenant_id=po.tenant_id
         JOIN goods_receipt_lines gl ON gl.goods_receipt_id=gr.id
           AND gl.tenant_id=gr.tenant_id AND gl.factory_id=gr.factory_id
         WHERE gr.tenant_id=$1 AND gr.factory_id=$2
           AND gr.id=ANY($3::uuid[])
         ORDER BY gr.posted_at, gr.id`,
        [tenantId, scenario.factoryId, [firstPostedLot.receiptId, secondPostedLot.receiptId]],
      );
      expect(receiptProvenance.rows).toHaveLength(2);
      expect(receiptProvenance.rows.map((row) => row.id)).toEqual([
        firstPostedLot.receiptId, secondPostedLot.receiptId,
      ]);
      expect(receiptProvenance.rows.every((row) =>
        row.status === 'POSTED' && row.factory_id === scenario.factoryId && row.accepted_quantity === '3.0000',
      )).toBe(true);
      expect(receiptProvenance.rows.map((row) => row.supplier_id)).toEqual([supplierA.id, supplierB.id]);
      expect(new Date(receiptProvenance.rows[0]!.posted_at).getTime())
        .toBeLessThan(new Date(receiptProvenance.rows[1]!.posted_at).getTime());

      for (const lot of [firstPostedLot, secondPostedLot]) {
        await locationService.transferStock(
          TEST_USER_ID, tenantId, scenario.factoryId, itemId,
          {
            movement_purpose: 'PUT_AWAY',
            source_location_id: scenario.unassignedLocationId,
            destination_location_id: scenario.binId,
            traceability_unit_id: lot.lotId,
            quantity: 3,
          } as never,
          'wp02-provider-site-putaway-' + randomUUID(), null, randomUUID(),
        );
      }

      const expectedLotOrder = scenario.expectedPolicy === 'FEFO'
        ? [secondPostedLot, firstPostedLot]
        : [firstPostedLot, secondPostedLot];
      const reserve = (key: string) => service.createReservation(
        TEST_USER_ID, tenantId, scenario.factoryId, itemId,
        { quantity: 4, location_id: scenario.binId } as CreateInventoryReservationDto,
        key, null, randomUUID(),
      );
      const competing = await Promise.allSettled([
        reserve('wp02-provider-site-contender-a-' + randomUUID()),
        reserve('wp02-provider-site-contender-b-' + randomUUID()),
      ]);
      expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const rejected = competing.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(String(rejected?.reason?.message ?? rejected?.reason))
        .toContain('Insufficient eligible ' + scenario.expectedPolicy + ' lot/serial stock');

      const reservations = await adminPool.query<{ id: string; quantity: string; status: string }>(
        `SELECT id::text AS id, quantity::text AS quantity, status
         FROM inventory_reservations
         WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3
         ORDER BY created_at, id`,
        [tenantId, scenario.factoryId, itemId],
      );
      expect(reservations.rows).toHaveLength(1);
      expect(reservations.rows[0]).toMatchObject({ quantity: '4.0000', status: 'RESERVED' });

      const allocations = await adminPool.query<{
        traceability_unit_id: string;
        allocation_sequence: number;
        allocated_quantity: string;
        supplier_id: string;
        supplier_name: string;
        receipt_status: string;
        posted_at: string;
        expires_at: string;
        accepted_quantity: string;
      }>(
        `SELECT a.traceability_unit_id::text AS traceability_unit_id,
                a.allocation_sequence, a.allocated_quantity::text AS allocated_quantity,
                s.id::text AS supplier_id, s.name AS supplier_name,
                gr.status AS receipt_status, gr.posted_at::text AS posted_at,
                tu.expires_at::text AS expires_at,
                gl.accepted_quantity::text AS accepted_quantity
         FROM inventory_reservation_traceability_allocations a
         JOIN traceability_units tu ON tu.id=a.traceability_unit_id
           AND tu.tenant_id=a.tenant_id AND tu.factory_id=a.factory_id
         JOIN goods_receipt_lines gl ON gl.id=tu.goods_receipt_line_id
           AND gl.tenant_id=tu.tenant_id AND gl.factory_id=tu.factory_id
         JOIN goods_receipts gr ON gr.id=gl.goods_receipt_id
           AND gr.tenant_id=gl.tenant_id AND gr.factory_id=gl.factory_id
         JOIN purchase_orders po ON po.id=gr.purchase_order_id
           AND po.tenant_id=gr.tenant_id AND po.factory_id=gr.factory_id
         JOIN suppliers s ON s.id=po.supplier_id AND s.tenant_id=po.tenant_id
         WHERE a.tenant_id=$1 AND a.factory_id=$2 AND a.item_id=$3
           AND a.reservation_id=$4
         ORDER BY a.allocation_sequence`,
        [tenantId, scenario.factoryId, itemId, reservations.rows[0]!.id],
      );
      expect(allocations.rows).toHaveLength(2);
      expect(allocations.rows.map((row) => row.traceability_unit_id))
        .toEqual(expectedLotOrder.map((lot) => lot.lotId));
      expect(allocations.rows.map((row) => row.allocated_quantity)).toEqual(['3.0000', '1.0000']);
      expect(allocations.rows.map((row) => row.supplier_id)).toEqual(
        expectedLotOrder.map((lot) => lot.supplierId),
      );
      expect(allocations.rows.every((row) =>
        row.receipt_status === 'POSTED' && row.accepted_quantity === '3.0000',
      )).toBe(true);
      expect(allocations.rows.map((row) => row.expires_at)).toEqual(
        expectedLotOrder.map((lot) => lot.expiry),
      );

      const effectivePolicy = await adminPool.query<{ allocation_policy: string }>(
        `SELECT COALESCE(
           (SELECT p.allocation_policy FROM inventory_material_allocation_policies p
            WHERE p.tenant_id=i.tenant_id AND p.factory_id=i.factory_id
              AND p.policy_scope='MATERIAL' AND p.inventory_item_id=i.id),
           (SELECT p.allocation_policy FROM inventory_material_allocation_policies p
            WHERE p.tenant_id=i.tenant_id AND p.factory_id=i.factory_id
              AND p.policy_scope='SECTOR' AND lower(p.sector_code)=lower(i.sector_code)),
           (SELECT p.allocation_policy FROM inventory_material_allocation_policies p
            WHERE p.tenant_id=i.tenant_id AND p.factory_id=i.factory_id
              AND p.policy_scope='FACTORY'),
           'FIFO'
         ) AS allocation_policy
         FROM inventory_items i
         WHERE i.tenant_id=$1 AND i.factory_id=$2 AND i.id=$3`,
        [tenantId, scenario.factoryId, itemId],
      );
      expect(effectivePolicy.rows[0]?.allocation_policy).toBe(scenario.expectedPolicy);

      const lotBalances = await adminPool.query<{
        unit_id: string;
        quantity_on_hand: string;
        quantity_reserved: string;
      }>(
        `SELECT traceability_unit_id::text AS unit_id,
                quantity_on_hand::text AS quantity_on_hand,
                quantity_reserved::text AS quantity_reserved
         FROM inventory_traceability_location_balances
         WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3 AND location_id=$4`,
        [tenantId, scenario.factoryId, itemId, scenario.binId],
      );
      expect(lotBalances.rows).toHaveLength(2);
      const balancesByLot = new Map(lotBalances.rows.map((row) => [row.unit_id, row]));
      expect(balancesByLot.get(expectedLotOrder[0]!.lotId)).toMatchObject({
        quantity_on_hand: '3.0000', quantity_reserved: '3.0000',
      });
      expect(balancesByLot.get(expectedLotOrder[1]!.lotId)).toMatchObject({
        quantity_on_hand: '3.0000', quantity_reserved: '1.0000',
      });

      const reconciled = await adminPool.query<{
        stock_on_hand: string;
        stock_reserved: string;
        bin_on_hand: string;
        bin_reserved: string;
      }>(
        `SELECT s.quantity_on_hand::text AS stock_on_hand,
                s.quantity_reserved::text AS stock_reserved,
                b.quantity_on_hand::text AS bin_on_hand,
                b.quantity_reserved::text AS bin_reserved
         FROM inventory_stock_balances s
         JOIN inventory_location_balances b ON b.tenant_id=s.tenant_id
           AND b.factory_id=s.factory_id AND b.item_id=s.item_id
         WHERE s.tenant_id=$1 AND s.factory_id=$2 AND s.item_id=$3
           AND b.location_id=$4`,
        [tenantId, scenario.factoryId, itemId, scenario.binId],
      );
      expect(reconciled.rows).toEqual([{
        stock_on_hand: '6.0000',
        stock_reserved: '4.0000',
        bin_on_hand: '6.0000',
        bin_reserved: '4.0000',
      }]);
    }
  }, 30000);


});
