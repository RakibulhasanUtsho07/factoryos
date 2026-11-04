import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

import { AuditService } from '../audit/audit.service';
import { createIntegrationDatabase } from '../database/integration-database.adapter';
import { InventoryLocationService } from './inventory.location.service';
import { InventoryService } from './inventory.service';
import { InventoryReservationService } from './inventory.reservation.service';

describe('Inventory WMS reservation and first production work-order PostgreSQL integration', () => {
  const TEST_USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';

  let adminPool: Pool;
  let appPool: Pool;
  let database: ReturnType<typeof createIntegrationDatabase>;
  let reservationService: InventoryReservationService;
  let locationService: InventoryLocationService;
  let inventoryService: InventoryService;
  let tenantId: string;
  let factoryId: string;

  const itemIds: string[] = [];
  const warehouseIds: string[] = [];
  const binIds: string[] = [];

  const audit = { record: async () => undefined } as unknown as AuditService;

  const createItem = async (quantityOnHand: string): Promise<string> => {
    const created = await adminPool.query<{ id: string }>(
      'INSERT INTO inventory_items (tenant_id, factory_id, sku, name, unit, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text AS id',
      [tenantId, factoryId, 'WMS-INT-' + randomUUID(), 'WMS reservation integration fixture', 'PCS', TEST_USER_ID],
    );
    const itemId = created.rows[0]?.id;
    if (!itemId) throw new Error('WMS integration item fixture was not created');
    itemIds.push(itemId);
    await adminPool.query(
      'INSERT INTO inventory_stock_balances (tenant_id, factory_id, item_id, quantity_on_hand, quantity_reserved) VALUES ($1, $2, $3, $4::numeric, 0)',
      [tenantId, factoryId, itemId, quantityOnHand],
    );
    return itemId;
  };

  const createWarehouseAndBins = async (): Promise<{ unassignedId: string; binA: string; binB: string }> => {
    const suffix = randomUUID().slice(0, 8);
    const warehouse = await adminPool.query<{ id: string }>(
      "INSERT INTO inventory_locations (tenant_id, factory_id, location_code, name, location_type, putaway_enabled, picking_enabled, created_by_user_id) VALUES ($1, $2, $3, $4, 'WAREHOUSE', FALSE, FALSE, $5) RETURNING id::text AS id",
      [tenantId, factoryId, 'WMS-WH-' + suffix, 'WMS integration warehouse', TEST_USER_ID],
    );
    const warehouseId = warehouse.rows[0]?.id;
    if (!warehouseId) throw new Error('WMS warehouse fixture was not created');
    warehouseIds.push(warehouseId);

    const createBin = async (code: string): Promise<string> => {
      const row = await adminPool.query<{ id: string }>(
        "INSERT INTO inventory_locations (tenant_id, factory_id, parent_location_id, location_code, name, location_type, putaway_enabled, picking_enabled, created_by_user_id) VALUES ($1, $2, $3, $4, $5, 'BIN', TRUE, TRUE, $6) RETURNING id::text AS id",
        [tenantId, factoryId, warehouseId, 'WMS-' + code + '-' + suffix, 'WMS integration bin ' + code, TEST_USER_ID],
      );
      const id = row.rows[0]?.id;
      if (!id) throw new Error('WMS bin fixture was not created');
      binIds.push(id);
      return id;
    };

    const binA = await createBin('A');
    const binB = await createBin('B');
    const defaultLocation = await adminPool.query<{ id: string }>(
      "SELECT id::text AS id FROM inventory_locations WHERE tenant_id=$1 AND factory_id=$2 AND is_default=TRUE AND status='ACTIVE' LIMIT 1",
      [tenantId, factoryId],
    );
    const unassignedId = defaultLocation.rows[0]?.id;
    if (!unassignedId) throw new Error('Factory UNASSIGNED location is missing');
    return { unassignedId, binA, binB };
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
      "SELECT t.id::text AS tenant_id, f.id::text AS factory_id FROM tenants t JOIN factories f ON f.tenant_id=t.id WHERE t.status='ACTIVE' AND f.status='ACTIVE' ORDER BY t.created_at, f.created_at LIMIT 1",
    );
    const first = context.rows[0];
    if (!first) throw new Error('No active tenant/factory is available for WMS integration tests');
    tenantId = first.tenant_id;
    factoryId = first.factory_id;

    const actor = await adminPool.query<{ id: string }>('SELECT id::text AS id FROM users WHERE id=$1', [TEST_USER_ID]);
    if (!actor.rows[0]) throw new Error('WMS integration actor is missing');

    database = createIntegrationDatabase(appPool);
    reservationService = new InventoryReservationService(database as never, audit);
    locationService = new InventoryLocationService(database as never, audit);
    inventoryService = new InventoryService(database as never, audit);
  });

  afterAll(async () => {
    if (!adminPool) return;
    const mutableTables = [
      'inventory_reservation_consumption_traceability_allocations',
      'inventory_reservation_consumptions',
      'inventory_reservation_traceability_allocations',
      'inventory_reservations',
      'inventory_movements',
      'inventory_location_transfers',
      'inventory_location_balances',
      'inventory_stock_balances',
    ];
    try {
      for (const table of mutableTables) {
        await adminPool.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER');
      }
      if (itemIds.length > 0) {
        await adminPool.query(
          'DELETE FROM inventory_reservation_consumption_traceability_allocations WHERE tenant_id=$1 AND factory_id=$2 AND consumption_id IN (SELECT id FROM inventory_reservation_consumptions WHERE item_id = ANY($3::uuid[]))',
          [tenantId, factoryId, itemIds],
        );
        await adminPool.query('DELETE FROM inventory_reservation_consumptions WHERE item_id = ANY($1::uuid[])', [itemIds]);
        await adminPool.query('DELETE FROM inventory_reservation_traceability_allocations WHERE item_id = ANY($1::uuid[])', [itemIds]);
        await adminPool.query('DELETE FROM inventory_reservations WHERE item_id = ANY($1::uuid[])', [itemIds]);
        await adminPool.query('DELETE FROM inventory_movements WHERE item_id = ANY($1::uuid[])', [itemIds]);
        await adminPool.query('DELETE FROM inventory_location_transfers WHERE item_id = ANY($1::uuid[])', [itemIds]);
        await adminPool.query('DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])', [itemIds]);
        await adminPool.query('DELETE FROM inventory_location_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
        await adminPool.query('DELETE FROM inventory_stock_balances WHERE item_id = ANY($1::uuid[])', [itemIds]);
      }
      if (binIds.length > 0) {
        await adminPool.query('DELETE FROM inventory_locations WHERE id = ANY($1::uuid[])', [binIds]);
      }
      if (warehouseIds.length > 0) {
        await adminPool.query('DELETE FROM inventory_locations WHERE id = ANY($1::uuid[])', [warehouseIds]);
      }
      if (itemIds.length > 0) {
        await adminPool.query('DELETE FROM inventory_items WHERE id = ANY($1::uuid[])', [itemIds]);
      }
    } finally {
      for (const table of mutableTables) {
        await adminPool.query('ALTER TABLE ' + table + ' ENABLE TRIGGER USER');
      }
      if (appPool) await appPool.end();
      await adminPool.end();
    }
  });

  it('serializes concurrent over-reservations on PostgreSQL item locks', async () => {
    const itemId = await createItem('5.0000');
    const attempts = await Promise.allSettled([
      reservationService.createReservation(
        TEST_USER_ID, tenantId, factoryId, itemId, { quantity: 4 },
        'wms-race-a-' + randomUUID(), randomUUID(), randomUUID(),
      ),
      reservationService.createReservation(
        TEST_USER_ID, tenantId, factoryId, itemId, { quantity: 4 },
        'wms-race-b-' + randomUUID(), randomUUID(), randomUUID(),
      ),
    ]);

    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(ConflictException);
    }

    const state = await adminPool.query<{ quantity_reserved: string; reservation_count: string }>(
      "SELECT b.quantity_reserved::text AS quantity_reserved, (SELECT count(*)::text FROM inventory_reservations r WHERE r.item_id=b.item_id AND r.status='RESERVED') AS reservation_count FROM inventory_stock_balances b WHERE b.item_id=$1",
      [itemId],
    );
    expect(state.rows[0]).toEqual({ quantity_reserved: '4.0000', reservation_count: '1' });
  });

  it('projects allocated, quality-quarantined, and outstanding approved-PO quantities from PostgreSQL', async () => {
    const itemId = await createItem('10.0000');
    const supplierId = randomUUID();
    const purchaseOrderId = randomUUID();
    const purchaseOrderLineId = randomUUID();
    const goodsReceiptId = randomUUID();
    const goodsReceiptLineId = randomUUID();
    const inspectionId = randomUUID();
    const qualityHoldId = randomUUID();
    const fixtureKey = randomUUID();
    const receiptLocationResult = await adminPool.query<{ id: string }>(
      "SELECT id::text AS id FROM inventory_locations WHERE tenant_id=$1 AND factory_id=$2 AND is_default=TRUE AND status='ACTIVE' LIMIT 1",
      [tenantId, factoryId],
    );
    const receiptLocationId = receiptLocationResult.rows[0]?.id;
    if (!receiptLocationId) throw new Error('Factory UNASSIGNED location is missing for the GRN availability fixture');

    const mutableTables = [
      'quality_holds',
      'quality_inspections',
      'goods_receipt_lines',
      'goods_receipts',
      'purchase_order_lines',
      'purchase_orders',
      'suppliers',
    ];

    try {
      await reservationService.createReservation(
        TEST_USER_ID,
        tenantId,
        factoryId,
        itemId,
        { quantity: 2, reference_type: 'WMS_TEST' },
        'availability-allocated-' + fixtureKey,
        randomUUID(),
        randomUUID(),
      );

      for (const table of mutableTables) {
        await adminPool.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER');
      }

      await adminPool.query(
        `
        INSERT INTO suppliers (id, tenant_id, code, name, status, country_code, currency, created_by_user_id)
        VALUES ($1, $2, $3, 'Availability projection supplier', 'ACTIVE', 'BD', 'BDT', $4)
        `,
        [supplierId, tenantId, 'AVAIL-' + fixtureKey.slice(0, 12), TEST_USER_ID],
      );

      await adminPool.query(
        `
        INSERT INTO purchase_orders (
          id, tenant_id, factory_id, supplier_id, po_number, status, order_date,
          expected_delivery_date, currency, payment_terms_days, created_by_user_id,
          submitted_by_user_id, submitted_at, approved_by_user_id, approved_at,
          idempotency_key, request_hash, version
        )
        VALUES (
          $1, $2, $3, $4, $5, 'APPROVED', CURRENT_DATE, CURRENT_DATE + 5,
          'BDT', 0, $6, $6, clock_timestamp(), $6, clock_timestamp(), $7, $8, 3
        )
        `,
        [
          purchaseOrderId,
          tenantId,
          factoryId,
          supplierId,
          'PO-AVAIL-' + fixtureKey.slice(0, 12),
          TEST_USER_ID,
          'po-availability-' + fixtureKey,
          'a'.repeat(64),
        ],
      );

      await adminPool.query(
        `
        INSERT INTO purchase_order_lines (
          id, tenant_id, factory_id, purchase_order_id, line_number,
          inventory_item_id, description, quantity, unit, unit_price
        )
        VALUES ($1, $2, $3, $4, 1, $5, 'Expected stock projection fixture', 10, 'PCS', 1)
        `,
        [purchaseOrderLineId, tenantId, factoryId, purchaseOrderId, itemId],
      );

      await adminPool.query(
        `
        INSERT INTO goods_receipts (
          id, tenant_id, factory_id, purchase_order_id, location_id, receipt_number, status,
          created_by_user_id, idempotency_key, request_hash, correlation_id, posted_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'POSTED', $7, $8, $9, $10, clock_timestamp())
        `,
        [
          goodsReceiptId,
          tenantId,
          factoryId,
          purchaseOrderId,
          receiptLocationId,
          'GRN-AVAIL-' + fixtureKey.slice(0, 12),
          TEST_USER_ID,
          'grn-availability-' + fixtureKey,
          'b'.repeat(64),
          randomUUID(),
        ],
      );

      await adminPool.query(
        `
        INSERT INTO goods_receipt_lines (
          id, tenant_id, factory_id, goods_receipt_id, purchase_order_id,
          purchase_order_line_id, inventory_item_id, received_quantity,
          rejected_quantity, rejection_reason
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 5, 1, 'One unit rejected in availability fixture')
        `,
        [
          goodsReceiptLineId,
          tenantId,
          factoryId,
          goodsReceiptId,
          purchaseOrderId,
          purchaseOrderLineId,
          itemId,
        ],
      );

      await adminPool.query(
        `
        INSERT INTO quality_inspections (
          id, tenant_id, factory_id, inspection_type, target_type, target_id,
          inventory_item_id, status, row_version, idempotency_key, request_hash,
          created_by_user_id, updated_by_user_id, correlation_id
        )
        VALUES ($1, $2, $3, 'INVENTORY', 'INVENTORY_ITEM', $4, $4, 'ON_HOLD',
                1, $5, $6, $7, $7, $8)
        `,
        [
          inspectionId,
          tenantId,
          factoryId,
          itemId,
          'inspection-availability-' + fixtureKey,
          'c'.repeat(64),
          TEST_USER_ID,
          randomUUID(),
        ],
      );

      await adminPool.query(
        `
        INSERT INTO quality_holds (
          id, tenant_id, factory_id, inspection_id, inventory_item_id,
          status, quarantined_by_quality, reason, created_by_user_id, correlation_id
        )
        VALUES ($1, $2, $3, $4, $5, 'ACTIVE', TRUE,
                'Inventory-wide quality quarantine fixture', $6, $7)
        `,
        [qualityHoldId, tenantId, factoryId, inspectionId, itemId, TEST_USER_ID, randomUUID()],
      );

      const availability = await inventoryService.getAvailabilitySummary(
        TEST_USER_ID, tenantId, factoryId, itemId,
      );

      expect(availability).toMatchObject({
        quantity_on_hand: '10.0000',
        quantity_reserved: '2.0000',
        quantity_allocated: '2.0000',
        quantity_available: '0.0000',
        quantity_quarantined: '10.0000',
        quantity_quality_held: '10.0000',
        quantity_damaged: '0.0000',
        quantity_expired: '0.0000',
        quantity_expected: '6.0000',
        first_affected_production_order: null,
      });
    } finally {
      for (const table of mutableTables) {
        await adminPool.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER');
      }
      try {
        await adminPool.query('DELETE FROM quality_holds WHERE id = $1', [qualityHoldId]);
        await adminPool.query('DELETE FROM quality_inspections WHERE id = $1', [inspectionId]);
        await adminPool.query('DELETE FROM goods_receipt_lines WHERE id = $1', [goodsReceiptLineId]);
        await adminPool.query('DELETE FROM goods_receipts WHERE id = $1', [goodsReceiptId]);
        await adminPool.query('DELETE FROM purchase_order_lines WHERE id = $1', [purchaseOrderLineId]);
        await adminPool.query('DELETE FROM purchase_orders WHERE id = $1', [purchaseOrderId]);
        await adminPool.query('DELETE FROM suppliers WHERE id = $1', [supplierId]);
      } finally {
        for (const table of mutableTables) {
          await adminPool.query('ALTER TABLE ' + table + ' ENABLE TRIGGER USER');
        }
      }
    }
  });

  it('excludes damaged, expired and non-active tracked stock from availability without double-counting', async () => {
    const itemId = await createItem('10.0000');
    const damagedExpiredUnitId = randomUUID();
    const recalledUnitId = randomUUID();
    const fixtureKey = randomUUID();
    const defaultLocation = await adminPool.query<{ id: string }>(
      "SELECT id::text AS id FROM inventory_locations WHERE tenant_id=$1 AND factory_id=$2 AND is_default=TRUE AND status='ACTIVE' LIMIT 1",
      [tenantId, factoryId],
    );
    const locationId = defaultLocation.rows[0]?.id;
    if (!locationId) throw new Error('Factory UNASSIGNED location is missing for availability fixture');

    const mutableTables = [
      'inventory_traceability_location_balances',
      'traceability_units',
    ];

    try {
      for (const table of mutableTables) {
        await adminPool.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER');
      }

      await adminPool.query(
        `
        INSERT INTO traceability_units (
          id, tenant_id, factory_id, unit_type, product_role, unit_code,
          barcode_value, inventory_item_id, quantity, unit, expires_at, status,
          attributes, idempotency_key, request_hash, created_by_user_id,
          correlation_id
        )
        VALUES (
          $1, $2, $3, 'LOT', 'MATERIAL', $4, $5, $6, 3, 'PCS',
          CURRENT_DATE - 1, 'ACTIVE', '{"damaged":true}'::jsonb,
          $7, $8, $9, $10
        )
        `,
        [
          damagedExpiredUnitId,
          tenantId,
          factoryId,
          'DAMAGED-EXPIRED-' + fixtureKey.slice(0, 10),
          'DAMAGED-EXPIRED-BARCODE-' + fixtureKey.slice(0, 10),
          itemId,
          'traceability-damaged-expired-' + fixtureKey,
          'f'.repeat(64),
          TEST_USER_ID,
          randomUUID(),
        ],
      );

      await adminPool.query(
        `
        INSERT INTO traceability_units (
          id, tenant_id, factory_id, unit_type, product_role, unit_code,
          barcode_value, inventory_item_id, quantity, unit, status,
          attributes, idempotency_key, request_hash, created_by_user_id,
          correlation_id
        )
        VALUES (
          $1, $2, $3, 'LOT', 'MATERIAL', $4, $5, $6, 2, 'PCS',
          'RECALLED', '{}'::jsonb, $7, $8, $9, $10
        )
        `,
        [
          recalledUnitId,
          tenantId,
          factoryId,
          'RECALLED-' + fixtureKey.slice(0, 10),
          'RECALLED-BARCODE-' + fixtureKey.slice(0, 10),
          itemId,
          'traceability-recalled-' + fixtureKey,
          'a'.repeat(64),
          TEST_USER_ID,
          randomUUID(),
        ],
      );

      await adminPool.query(
        `
        INSERT INTO inventory_traceability_location_balances (
          tenant_id, factory_id, item_id, traceability_unit_id, location_id,
          quantity_on_hand, quantity_reserved
        )
        VALUES ($1, $2, $3, $4, $5, 3, 0), ($1, $2, $3, $6, $5, 2, 0)
        `,
        [tenantId, factoryId, itemId, damagedExpiredUnitId, locationId, recalledUnitId],
      );

      const availability = await inventoryService.getAvailabilitySummary(
        TEST_USER_ID, tenantId, factoryId, itemId,
      );

      expect(availability).toMatchObject({
        quantity_on_hand: '10.0000',
        quantity_allocated: '0.0000',
        quantity_available: '5.0000',
        quantity_quarantined: '0.0000',
        quantity_quality_held: '0.0000',
        quantity_damaged: '3.0000',
        quantity_expired: '3.0000',
        quantity_status_blocked: '2.0000',
      });
    } finally {
      for (const table of mutableTables) {
        await adminPool.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER');
      }
      try {
        await adminPool.query(
          'DELETE FROM inventory_traceability_location_balances WHERE traceability_unit_id = ANY($1::uuid[])',
          [[damagedExpiredUnitId, recalledUnitId]],
        );
        await adminPool.query(
          'DELETE FROM traceability_units WHERE id = ANY($1::uuid[])',
          [[damagedExpiredUnitId, recalledUnitId]],
        );
      } finally {
        for (const table of mutableTables) {
          await adminPool.query('ALTER TABLE ' + table + ' ENABLE TRIGGER USER');
        }
      }
    }
  });

  it('identifies the first scheduled production work order whose material demand exceeds usable stock', async () => {
    const componentItemId = await createItem('10.0000');
    const finishedItemId = await createItem('0.0000');
    const orderId = randomUUID();
    const orderLineId = randomUUID();
    const productId = randomUUID();
    const productVersionId = randomUUID();
    const bomLineId = randomUUID();
    const workOrderId = randomUUID();
    const requirementId = randomUUID();
    const suffix = randomUUID().slice(0, 12);
    const approverUserId = randomUUID();
    const approverSuffix = randomUUID().slice(0, 12);

    const mutableTables = [
      'work_order_material_requirements',
      'work_order_material_reservations',
      'work_orders',
      'product_bom_lines',
      'product_versions',
      'product_definitions',
      'order_lines',
      'orders',
    ];

    try {
      await adminPool.query(
        `INSERT INTO users (id, external_subject, email, display_name, status)
         VALUES ($1, $2, $3, 'Availability integration approver', 'ACTIVE')`,
        [
          approverUserId,
          'availability-approver-' + approverSuffix,
          'availability-approver-' + approverSuffix + '@factoryos.test',
        ],
      );

      await reservationService.createReservation(
        TEST_USER_ID, tenantId, factoryId, componentItemId, { quantity: 2 },
        'availability-first-wo-' + suffix, randomUUID(), randomUUID(),
      );

      for (const table of mutableTables) {
        await adminPool.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER');
      }

      await adminPool.query(
        `
        INSERT INTO orders (
          id, tenant_id, factory_id, order_number, status, order_date,
          currency, created_by_user_id
        )
        VALUES ($1, $2, $3, $4, 'DRAFT', CURRENT_DATE, 'BDT', $5)
        `,
        [orderId, tenantId, factoryId, 'SO-AVAIL-' + suffix, TEST_USER_ID],
      );

      await adminPool.query(
        `
        INSERT INTO order_lines (
          id, tenant_id, factory_id, order_id, line_number, product_code,
          product_name, inventory_item_id, quantity, unit
        )
        VALUES ($1, $2, $3, $4, 1, $5, 'Availability finished product', $6, 12, 'PCS')
        `,
        [orderLineId, tenantId, factoryId, orderId, 'FG-AVAIL-' + suffix, finishedItemId],
      );

      await adminPool.query(
        `
        INSERT INTO product_definitions (
          id, tenant_id, factory_id, inventory_item_id, product_code,
          product_name, product_type, base_unit, status, version,
          created_by_user_id, updated_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, 'Availability finished product',
                'STANDARD', 'PCS', 'ACTIVE', 1, $6, $6)
        `,
        [productId, tenantId, factoryId, finishedItemId, 'PRD-AVAIL-' + suffix, TEST_USER_ID],
      );

      await adminPool.query(
        `
        INSERT INTO product_versions (
          id, tenant_id, factory_id, product_id, version_number, state,
          effective_from, expected_yield_percent, change_summary, row_version,
          idempotency_key, request_hash, created_by_user_id, updated_by_user_id,
          approved_by_user_id, approved_at
        )
        VALUES ($1, $2, $3, $4, 1, 'APPROVED', CURRENT_DATE, 100,
                'Availability first-affected work-order fixture', 1, $5, $6,
                $7, $7, $8, clock_timestamp())
        `,
        [
          productVersionId,
          tenantId,
          factoryId,
          productId,
          'product-version-availability-' + suffix,
          'd'.repeat(64),
          TEST_USER_ID,
          approverUserId,
        ],
      );

      await adminPool.query(
        `
        INSERT INTO product_bom_lines (
          id, tenant_id, factory_id, product_id, product_version_id,
          line_number, component_item_id, quantity_per, unit, wastage_percent,
          inventory_base_unit, base_quantity_per, uom_factor_numerator,
          uom_factor_denominator, uom_rounding_mode, created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, 1, $6, 1, 'PCS', 0,
                'PCS', 1, 1, 1, 'REJECT', $7)
        `,
        [bomLineId, tenantId, factoryId, productId, productVersionId, componentItemId, TEST_USER_ID],
      );

      await adminPool.query(
        `
        INSERT INTO work_orders (
          id, tenant_id, factory_id, work_order_number, source_order_id,
          source_order_line_id, product_id, product_version_id, finished_item_id,
          target_quantity, planned_start_date, due_date, priority, status,
          row_version, idempotency_key, request_hash, created_by_user_id, updated_by_user_id
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          12, CURRENT_DATE + 2, CURRENT_DATE + 7, 1, 'DRAFT',
          1, $10, $11, $12, $12
        )
        `,
        [
          workOrderId,
          tenantId,
          factoryId,
          'WO-AVAIL-' + suffix,
          orderId,
          orderLineId,
          productId,
          productVersionId,
          finishedItemId,
          'work-order-availability-' + suffix,
          'e'.repeat(64),
          TEST_USER_ID,
        ],
      );

      await adminPool.query(
        `
        INSERT INTO work_order_material_requirements (
          id, tenant_id, factory_id, work_order_id, product_id,
          product_version_id, bom_line_id, component_item_id, line_number,
          component_sku, component_name, component_unit, base_quantity_per,
          expected_yield_percent, wastage_percent, required_quantity
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1,
                $9, 'Availability component', 'PCS', 1, 100, 0, 12)
        `,
        [
          requirementId,
          tenantId,
          factoryId,
          workOrderId,
          productId,
          productVersionId,
          bomLineId,
          componentItemId,
          'WMS-INT-' + suffix,
        ],
      );

      const availability = await inventoryService.getAvailabilitySummary(
        TEST_USER_ID, tenantId, factoryId, componentItemId,
      );

      expect(availability).toMatchObject({
        quantity_on_hand: '10.0000',
        quantity_allocated: '2.0000',
        quantity_available: '8.0000',
        quantity_expected: '0.0000',
        first_affected_production_order: {
          work_order_id: workOrderId,
          work_order_number: 'WO-AVAIL-' + suffix,
          source_order_id: orderId,
          source_order_number: 'SO-AVAIL-' + suffix,
          status: 'DRAFT',
          priority: 1,
          outstanding_material_quantity: '12.0000',
          shortfall_quantity: '4.0000',
        },
      });
    } finally {
      for (const table of mutableTables) {
        await adminPool.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER');
      }
      try {
        await adminPool.query('DELETE FROM work_order_material_requirements WHERE id = $1', [requirementId]);
        await adminPool.query('DELETE FROM work_order_material_reservations WHERE work_order_id = $1', [workOrderId]);
        await adminPool.query('DELETE FROM work_orders WHERE id = $1', [workOrderId]);
        await adminPool.query('DELETE FROM product_bom_lines WHERE id = $1', [bomLineId]);
        await adminPool.query('DELETE FROM product_versions WHERE id = $1', [productVersionId]);
        await adminPool.query('DELETE FROM product_definitions WHERE id = $1', [productId]);
        await adminPool.query('DELETE FROM order_lines WHERE id = $1', [orderLineId]);
        await adminPool.query('DELETE FROM orders WHERE id = $1', [orderId]);
        await adminPool.query('DELETE FROM users WHERE id = $1', [approverUserId]);
      } finally {
        for (const table of mutableTables) {
          await adminPool.query('ALTER TABLE ' + table + ' ENABLE TRIGGER USER');
        }
      }
    }
  });

  it('replays concurrent duplicate requests and conserves partial/full consumption balances', async () => {
    const itemId = await createItem('10.0000');
    const idempotencyKey = 'wms-duplicate-create-' + randomUUID();
    const created = await Promise.all([
      reservationService.createReservation(
        TEST_USER_ID, tenantId, factoryId, itemId, { quantity: 4 },
        idempotencyKey, randomUUID(), randomUUID(),
      ),
      reservationService.createReservation(
        TEST_USER_ID, tenantId, factoryId, itemId, { quantity: 4 },
        idempotencyKey, randomUUID(), randomUUID(),
      ),
    ]);
    expect(created.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(created[0]?.id).toBe(created[1]?.id);

    const reservationId = created[0]!.id;
    const issueKey = 'wms-partial-issue-' + randomUUID();
    const partial = await Promise.all([
      reservationService.transitionReservation(
        TEST_USER_ID, tenantId, factoryId, itemId, reservationId,
        { target_status: 'CONSUMED', quantity: 1.5 },
        issueKey, randomUUID(), randomUUID(),
      ),
      reservationService.transitionReservation(
        TEST_USER_ID, tenantId, factoryId, itemId, reservationId,
        { target_status: 'CONSUMED', quantity: 1.5 },
        issueKey, randomUUID(), randomUUID(),
      ),
    ]);
    expect(partial.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(partial[0]?.consumption_movement_id).toBe(partial[1]?.consumption_movement_id);

    let state = await adminPool.query<{ quantity_on_hand: string; quantity_reserved: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand, quantity_reserved::text AS quantity_reserved FROM inventory_stock_balances WHERE item_id=$1',
      [itemId],
    );
    expect(state.rows[0]).toEqual({ quantity_on_hand: '8.5000', quantity_reserved: '2.5000' });

    const complete = await reservationService.transitionReservation(
      TEST_USER_ID, tenantId, factoryId, itemId, reservationId,
      { target_status: 'CONSUMED', quantity: 2.5 },
      'wms-final-issue-' + randomUUID(), randomUUID(), randomUUID(),
    );
    expect(complete.status).toBe('CONSUMED');
    expect(complete.remaining_quantity).toBe('0.0000');
    expect(complete.consumed_quantity).toBe('4.0000');

    state = await adminPool.query(
      'SELECT quantity_on_hand::text AS quantity_on_hand, quantity_reserved::text AS quantity_reserved FROM inventory_stock_balances WHERE item_id=$1',
      [itemId],
    );
    expect(state.rows[0]).toEqual({ quantity_on_hand: '6.0000', quantity_reserved: '0.0000' });

    const evidence = await adminPool.query<{ consumption_count: string; issue_count: string }>(
      "SELECT (SELECT count(*)::text FROM inventory_reservation_consumptions WHERE reservation_id=$2) AS consumption_count, (SELECT count(*)::text FROM inventory_movements WHERE item_id=$1 AND movement_type='ISSUE') AS issue_count",
      [itemId, reservationId],
    );
    expect(evidence.rows[0]).toEqual({ consumption_count: '2', issue_count: '2' });
  });

  it('reserves and consumes the first production work-order BOM across physical bins', async () => {
    const itemId = await createItem('5.0000');
    const { unassignedId, binA, binB } = await createWarehouseAndBins();
    await locationService.transferStock(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { movement_purpose: 'PUT_AWAY', source_location_id: unassignedId, destination_location_id: binA, quantity: 2 },
      'wms-first-wo-putaway-a-' + randomUUID(), randomUUID(), randomUUID(),
    );
    await locationService.transferStock(
      TEST_USER_ID, tenantId, factoryId, itemId,
      { movement_purpose: 'PUT_AWAY', source_location_id: unassignedId, destination_location_id: binB, quantity: 3 },
      'wms-first-wo-putaway-b-' + randomUUID(), randomUUID(), randomUUID(),
    );

    const workOrderId = randomUUID();
    const requirementId = randomUUID();
    const bomLineId = randomUUID();
    const context = {
      userId: TEST_USER_ID, tenantId, factoryId,
      workOrderId, workOrderNumber: 'WO-WMS-FIRST-' + workOrderId.slice(0, 8),
      requirementId, bomLineId, itemId, itemUnit: 'PCS',
      lineNumber: 1, quantity: '4.0000', correlationId: randomUUID(),
    };
    const allocated = await database.transaction(
      { tenantId, userId: TEST_USER_ID },
      (client: PoolClient) => reservationService.reserveWorkOrderMaterialRequirement(client, context),
    );
    expect(allocated.map((entry) => entry.quantity)).toEqual(['2.0000', '2.0000']);
    expect(allocated.map((entry) => entry.locationId)).toEqual([binA, binB]);

    const consumed = await database.transaction(
      { tenantId, userId: TEST_USER_ID },
      (client: PoolClient) => reservationService.transitionWorkOrderMaterialReservations(
        client,
        {
          userId: TEST_USER_ID, tenantId, factoryId, workOrderId,
          workOrderNumber: context.workOrderNumber, correlationId: randomUUID(),
        },
        'CONSUMED',
      ),
    );
    expect(consumed.reservationCount).toBe(2);
    expect(consumed.quantityByItem).toEqual([{ item_id: itemId, quantity: '4.0000' }]);

    const state = await adminPool.query<{ quantity_on_hand: string; quantity_reserved: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand, quantity_reserved::text AS quantity_reserved FROM inventory_stock_balances WHERE item_id=$1',
      [itemId],
    );
    expect(state.rows[0]).toEqual({ quantity_on_hand: '1.0000', quantity_reserved: '0.0000' });

    const bins = await adminPool.query<{ location_id: string; quantity_on_hand: string; quantity_reserved: string }>(
      'SELECT location_id::text AS location_id, quantity_on_hand::text AS quantity_on_hand, quantity_reserved::text AS quantity_reserved FROM inventory_location_balances WHERE item_id=$1 AND location_id = ANY($2::uuid[]) ORDER BY location_id',
      [itemId, [binA, binB]],
    );
    expect(bins.rows).toHaveLength(2);
    expect(bins.rows.reduce((sum, bin) => sum + Number(bin.quantity_on_hand), 0)).toBe(1);
    expect(bins.rows.reduce((sum, bin) => sum + Number(bin.quantity_reserved), 0)).toBe(0);
    const reservations = await adminPool.query<{ status: string; remaining_quantity: string; consumed_quantity: string }>(
      "SELECT status, remaining_quantity::text AS remaining_quantity, consumed_quantity::text AS consumed_quantity FROM inventory_reservations WHERE item_id=$1 AND reference_type='WORK_ORDER_MATERIAL' AND reference_id=$2 ORDER BY id",
      [itemId, workOrderId],
    );
    expect(reservations.rows).toHaveLength(2);
    expect(reservations.rows.every((row) => row.status === 'CONSUMED' && row.remaining_quantity === '0.0000' && row.consumed_quantity === '2.0000')).toBe(true);
  });
});
