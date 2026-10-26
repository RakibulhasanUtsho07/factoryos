import { jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { createIntegrationDatabase } from '../database/integration-database.adapter';
import { InventoryLocationService } from '../inventory/inventory.location.service';
import { InventoryReservationService } from '../inventory/inventory.reservation.service';
import { TraceabilityService } from '../inventory/traceability.service';
import { OrderIdempotencyService } from '../orders/order-idempotency.service';
import { OrdersService } from '../orders/orders.service';
import { ProductDefinitionsService } from '../products/products.service';
import { GoodsReceiptService } from '../procurement/goods-receipt.service';
import { ProcurementService } from '../procurement/procurement.service';
import { QualityService } from '../quality/quality.service';
import { ProductionWorkOrdersService } from './production-work-orders.service';

describe('persisted manufacturing order-to-genealogy acceptance', () => {
  jest.setTimeout(120_000);

  const TEST_USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
  const runKey = randomUUID();
  const correlationId = randomUUID();
  const orderNumber = 'MFG-E2E-' + runKey;
  const productCode = 'MFG-E2E-PRODUCT-' + runKey;
  const workCentreCode = 'MFG-E2E-WC-' + runKey;
  const workOrderKey = 'mfg-e2e-work-order-' + runKey;
  const outputKey = 'mfg-e2e-output-' + runKey;
  const supplierCode = ('MFG-E2E-SUP-' + runKey).toUpperCase();
  const purchaseOrderNumber = ('MFG-E2E-PO-' + runKey).toUpperCase();
  const goodsReceiptKey = 'mfg-e2e-grn-' + runKey;
  const qualityInspectionKey = 'mfg-e2e-inspection-' + runKey;

  let adminPool: Pool | null = null;
  let appPool: Pool | null = null;
  let database: DatabaseService;
  let tenantId = '';
  let factoryId = '';
  let approverUserId = '';
  let today = '';
  let finishedItemId = '';
  let materialItemId = '';
  let productId = '';
  let productVersionId = '';
  let workCentreId = '';
  let warehouseId = '';
  let binId = '';
  let orderId = '';
  let orderLineId = '';
  let workOrderId = '';
  let materialTraceabilityUnitId = '';
  let supplierId = '';
  let purchaseOrderId = '';
  let goodsReceiptId = '';
  let goodsReceiptLineId = '';
  let qualityInspectionId = '';

  let inventoryReservationService: InventoryReservationService;
  let inventoryLocationService: InventoryLocationService;
  let traceabilityService: TraceabilityService;
  let ordersService: OrdersService;
  let productService: ProductDefinitionsService;
  let productionService: ProductionWorkOrdersService;
  let goodsReceiptService: GoodsReceiptService;
  let procurementService: ProcurementService;
  let qualityService: QualityService;

  const auditService = {
    record: async () => undefined,
  } as unknown as AuditService;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const adminDatabaseUrl = process.env.TEST_ADMIN_DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required for persisted manufacturing acceptance.');
    if (!adminDatabaseUrl) throw new Error('TEST_ADMIN_DATABASE_URL is required for persisted manufacturing acceptance.');

    adminPool = new Pool({ connectionString: adminDatabaseUrl });
    appPool = new Pool({ connectionString: databaseUrl });

    const context = await adminPool.query<{
      tenant_id: string;
      factory_id: string;
      today: string;
    }>(
      'SELECT t.id::text AS tenant_id, f.id::text AS factory_id, CURRENT_DATE::text AS today ' +
        'FROM tenants t JOIN factories f ON f.tenant_id = t.id ' +
        "WHERE t.status = 'ACTIVE' AND f.status = 'ACTIVE' " +
        'ORDER BY t.created_at, f.created_at LIMIT 1',
    );
    if (!context.rows[0]) throw new Error('An active tenant/factory fixture is required.');
    tenantId = context.rows[0].tenant_id;
    factoryId = context.rows[0].factory_id;
    today = context.rows[0].today;

    const users = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM users WHERE id <> $1::uuid ORDER BY id LIMIT 1',
      [TEST_USER_ID],
    );
    if (!users.rows[0]) throw new Error('A second user is required to verify separated product-version approval.');
    approverUserId = users.rows[0].id;

    const actor = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM users WHERE id = $1::uuid LIMIT 1',
      [TEST_USER_ID],
    );
    if (!actor.rows[0]) throw new Error('The shared integration actor is missing.');

    database = createIntegrationDatabase(appPool) as unknown as DatabaseService;
    inventoryReservationService = new InventoryReservationService(database, auditService);
    inventoryLocationService = new InventoryLocationService(database, auditService);
    traceabilityService = new TraceabilityService(database);
    ordersService = new OrdersService(
      database,
      auditService,
      new OrderIdempotencyService(database),
      inventoryReservationService,
    );
    productService = new ProductDefinitionsService(database, auditService);
    productionService = new ProductionWorkOrdersService(
      database,
      auditService,
      inventoryReservationService,
    );
    goodsReceiptService = new GoodsReceiptService(database);
    procurementService = new ProcurementService(database);
    qualityService = new QualityService(database);
  });

  afterAll(async () => {
    if (adminPool && tenantId && factoryId) {
      const mutableTables = [
        'quality_audit_events',
        'quality_inspection_events',
        'quality_defect_events',
        'quality_defects',
        'quality_dispositions',
        'quality_holds',
        'quality_ncr_actions',
        'quality_ncrs',
        'quality_inspection_results',
        'quality_inspections',
        'goods_receipt_lines',
        'goods_receipts',
        'purchase_order_status_history',
        'purchase_order_lines',
        'purchase_orders',
        'suppliers',
        'product_genealogy_events',
        'work_order_events',
        'production_output_postings',
        'order_production_reports',
        'inventory_reservation_consumption_traceability_allocations',
        'inventory_reservation_consumptions',
        'product_definition_idempotency',
        'inventory_reservation_traceability_allocations',
        'work_order_material_reservations',
        'inventory_reservations',
        'inventory_location_transfers',
        'inventory_traceability_location_balances',
        'inventory_locations',
        'traceability_units',
        'inventory_movements',
        'inventory_location_balances',
        'inventory_stock_balances',
        'work_order_operations',
        'work_order_material_requirements',
        'work_orders',
        'order_lines',
        'orders',
        'product_bom_lines',
        'product_routing_steps',
        'product_versions',
        'product_definitions',
        'manufacturing_work_centres',
        'inventory_items',
        'outbox_events',
      ];

      try {
        for (const table of mutableTables) {
          await adminPool.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER');
        }

        const itemIds = [finishedItemId, materialItemId].filter(Boolean);
        const productIds: string[] = [];
        if (productId) productIds.push(productId);
        const workOrderIds: string[] = [];
        if (workOrderId) workOrderIds.push(workOrderId);
        if (!workOrderId) {
          const foundWorkOrder = await adminPool.query<{ id: string }>(
            'SELECT id::text AS id FROM work_orders WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 LIMIT 1',
            [tenantId, factoryId, workOrderKey],
          );
          if (foundWorkOrder.rows[0]) workOrderIds.push(foundWorkOrder.rows[0].id);
        }

        const foundOrderId = orderId
          ? { rows: [{ id: orderId }] }
          : await adminPool.query<{ id: string }>(
              'SELECT id::text AS id FROM orders WHERE tenant_id=$1 AND factory_id=$2 AND order_number=$3 LIMIT 1',
              [tenantId, factoryId, orderNumber],
            );
        const cleanupOrderId = foundOrderId.rows[0]?.id ?? '';
        const idsForOutbox = [...itemIds, ...productIds, productVersionId, workCentreId, warehouseId, binId, cleanupOrderId, supplierId, purchaseOrderId, goodsReceiptId, goodsReceiptLineId, qualityInspectionId, ...workOrderIds].filter(Boolean);
        if (idsForOutbox.length > 0) {
          await adminPool.query(
            'DELETE FROM outbox_events WHERE tenant_id=$1 AND factory_id=$2 ' +
              'AND (aggregate_id = ANY($3::uuid[]) OR payload::text LIKE $4 OR payload::text LIKE $5)',
            [tenantId, factoryId, idsForOutbox, '%' + (cleanupOrderId || orderNumber) + '%', '%' + (workOrderIds[0] || workOrderKey) + '%'],
          );
        }

        const inspectionKey = qualityInspectionKey;
        await adminPool.query(
          'DELETE FROM quality_audit_events WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id IN ' +
            '(SELECT id FROM quality_inspections WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3)',
          [tenantId, factoryId, inspectionKey],
        );
        await adminPool.query(
          'DELETE FROM quality_defect_events WHERE tenant_id=$1 AND factory_id=$2 AND defect_id IN ' +
            '(SELECT id FROM quality_defects WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id IN ' +
            '(SELECT id FROM quality_inspections WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3))',
          [tenantId, factoryId, inspectionKey],
        );
        await adminPool.query(
          'DELETE FROM quality_inspection_events WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id IN ' +
            '(SELECT id FROM quality_inspections WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3)',
          [tenantId, factoryId, inspectionKey],
        );
        await adminPool.query(
          'DELETE FROM quality_inspection_results WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id IN ' +
            '(SELECT id FROM quality_inspections WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3)',
          [tenantId, factoryId, inspectionKey],
        );
        await adminPool.query(
          'DELETE FROM quality_ncr_actions WHERE tenant_id=$1 AND factory_id=$2 AND ncr_id IN ' +
            '(SELECT id FROM quality_ncrs WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id IN ' +
            '(SELECT id FROM quality_inspections WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3))',
          [tenantId, factoryId, inspectionKey],
        );
        await adminPool.query(
          'DELETE FROM quality_dispositions WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id IN ' +
            '(SELECT id FROM quality_inspections WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3)',
          [tenantId, factoryId, inspectionKey],
        );
        await adminPool.query(
          'DELETE FROM quality_defects WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id IN ' +
            '(SELECT id FROM quality_inspections WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3)',
          [tenantId, factoryId, inspectionKey],
        );
        await adminPool.query(
          'DELETE FROM quality_ncrs WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id IN ' +
            '(SELECT id FROM quality_inspections WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3)',
          [tenantId, factoryId, inspectionKey],
        );
        await adminPool.query(
          'DELETE FROM quality_holds WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id IN ' +
            '(SELECT id FROM quality_inspections WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3)',
          [tenantId, factoryId, inspectionKey],
        );
        await adminPool.query(
          'DELETE FROM quality_inspections WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3',
          [tenantId, factoryId, inspectionKey],
        );

        const poNumber = purchaseOrderNumber;
        await adminPool.query(
          'DELETE FROM goods_receipt_lines WHERE tenant_id=$1 AND factory_id=$2 AND purchase_order_id IN ' +
            '(SELECT id FROM purchase_orders WHERE tenant_id=$1 AND factory_id=$2 AND upper(po_number)=upper($3))',
          [tenantId, factoryId, poNumber],
        );
        await adminPool.query(
          'DELETE FROM goods_receipts WHERE tenant_id=$1 AND factory_id=$2 AND purchase_order_id IN ' +
            '(SELECT id FROM purchase_orders WHERE tenant_id=$1 AND factory_id=$2 AND upper(po_number)=upper($3))',
          [tenantId, factoryId, poNumber],
        );
        await adminPool.query(
          'DELETE FROM purchase_order_status_history WHERE tenant_id=$1 AND factory_id=$2 AND purchase_order_id IN ' +
            '(SELECT id FROM purchase_orders WHERE tenant_id=$1 AND factory_id=$2 AND upper(po_number)=upper($3))',
          [tenantId, factoryId, poNumber],
        );
        await adminPool.query(
          'DELETE FROM purchase_order_lines WHERE tenant_id=$1 AND factory_id=$2 AND purchase_order_id IN ' +
            '(SELECT id FROM purchase_orders WHERE tenant_id=$1 AND factory_id=$2 AND upper(po_number)=upper($3))',
          [tenantId, factoryId, poNumber],
        );
        await adminPool.query(
          'DELETE FROM purchase_orders WHERE tenant_id=$1 AND factory_id=$2 AND upper(po_number)=upper($3)',
          [tenantId, factoryId, poNumber],
        );
        await adminPool.query(
          'DELETE FROM suppliers WHERE tenant_id=$1 AND upper(code)=upper($2)',
          [tenantId, supplierCode],
        );

        if (itemIds.length > 0) {
          await adminPool.query(
            'DELETE FROM product_genealogy_events WHERE tenant_id=$1 AND factory_id=$2 ' +
              'AND (source_unit_id IN (SELECT id FROM traceability_units WHERE inventory_item_id = ANY($3::uuid[]) ' +
              'OR production_report_id IN (SELECT id FROM order_production_reports WHERE work_order_id = ANY($4::uuid[]))) ' +
              'OR target_unit_id IN (SELECT id FROM traceability_units WHERE inventory_item_id = ANY($3::uuid[]) ' +
              'OR production_report_id IN (SELECT id FROM order_production_reports WHERE work_order_id = ANY($4::uuid[]))))',
            [tenantId, factoryId, itemIds, workOrderIds.length > 0 ? workOrderIds : ['00000000-0000-0000-0000-000000000000']],
          );
        }
        if (workOrderIds.length > 0) {
          await adminPool.query(
            'DELETE FROM work_order_events WHERE tenant_id=$1 AND factory_id=$2 AND work_order_id = ANY($3::uuid[])',
            [tenantId, factoryId, workOrderIds],
          );
          await adminPool.query(
            'DELETE FROM production_output_postings WHERE tenant_id=$1 AND factory_id=$2 AND work_order_id = ANY($3::uuid[])',
            [tenantId, factoryId, workOrderIds],
          );
        }
        if (itemIds.length > 0) {
          await adminPool.query(
            'DELETE FROM inventory_reservation_consumption_traceability_allocations WHERE tenant_id=$1 AND factory_id=$2 ' +
              'AND consumption_id IN (SELECT id FROM inventory_reservation_consumptions WHERE tenant_id=$1 AND factory_id=$2 AND item_id = ANY($3::uuid[]))',
            [tenantId, factoryId, itemIds],
          );
          await adminPool.query(
            'DELETE FROM inventory_reservation_consumptions WHERE tenant_id=$1 AND factory_id=$2 AND item_id = ANY($3::uuid[])',
            [tenantId, factoryId, itemIds],
          );
          await adminPool.query(
            'DELETE FROM inventory_reservation_traceability_allocations WHERE tenant_id=$1 AND factory_id=$2 AND item_id = ANY($3::uuid[])',
            [tenantId, factoryId, itemIds],
          );
          if (workOrderIds.length > 0) {
            await adminPool.query(
              'DELETE FROM work_order_material_reservations WHERE tenant_id=$1 AND factory_id=$2 AND work_order_id = ANY($3::uuid[])',
              [tenantId, factoryId, workOrderIds],
            );
          }
          await adminPool.query(
            'DELETE FROM inventory_reservations WHERE tenant_id=$1 AND factory_id=$2 AND item_id = ANY($3::uuid[])',
            [tenantId, factoryId, itemIds],
          );
          await adminPool.query(
            'DELETE FROM inventory_location_transfers WHERE tenant_id=$1 AND factory_id=$2 AND item_id = ANY($3::uuid[])',
            [tenantId, factoryId, itemIds],
          );
          await adminPool.query(
            'DELETE FROM inventory_traceability_location_balances WHERE tenant_id=$1 AND factory_id=$2 AND item_id = ANY($3::uuid[])',
            [tenantId, factoryId, itemIds],
          );
          await adminPool.query(
            'DELETE FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2 ' +
              'AND (inventory_item_id = ANY($3::uuid[]) OR production_report_id IN ' +
              '(SELECT id FROM order_production_reports WHERE work_order_id = ANY($4::uuid[])))',
            [tenantId, factoryId, itemIds, workOrderIds.length > 0 ? workOrderIds : ['00000000-0000-0000-0000-000000000000']],
          );
          if (workOrderIds.length > 0) {
            await adminPool.query(
              'DELETE FROM order_production_reports WHERE tenant_id=$1 AND factory_id=$2 AND work_order_id = ANY($3::uuid[])',
              [tenantId, factoryId, workOrderIds],
            );
            await adminPool.query(
              'DELETE FROM work_order_operations WHERE tenant_id=$1 AND factory_id=$2 AND work_order_id = ANY($3::uuid[])',
              [tenantId, factoryId, workOrderIds],
            );
            await adminPool.query(
              'DELETE FROM work_order_material_requirements WHERE tenant_id=$1 AND factory_id=$2 AND work_order_id = ANY($3::uuid[])',
              [tenantId, factoryId, workOrderIds],
            );
            await adminPool.query(
              'DELETE FROM work_orders WHERE tenant_id=$1 AND factory_id=$2 AND id = ANY($3::uuid[])',
              [tenantId, factoryId, workOrderIds],
            );
          }

          if (cleanupOrderId) {
            await adminPool.query(
              'DELETE FROM order_lines WHERE tenant_id=$1 AND factory_id=$2 AND order_id=$3::uuid',
              [tenantId, factoryId, cleanupOrderId],
            );
            await adminPool.query(
              'DELETE FROM orders WHERE tenant_id=$1 AND factory_id=$2 AND id=$3::uuid',
              [tenantId, factoryId, cleanupOrderId],
            );
          }

          await adminPool.query(
            'DELETE FROM product_bom_lines WHERE tenant_id=$1 AND factory_id=$2 ' +
              'AND product_id IN (SELECT id FROM product_definitions WHERE inventory_item_id = ANY($3::uuid[]))',
            [tenantId, factoryId, itemIds],
          );
          await adminPool.query(
            'DELETE FROM product_routing_steps WHERE tenant_id=$1 AND factory_id=$2 ' +
              'AND product_id IN (SELECT id FROM product_definitions WHERE inventory_item_id = ANY($3::uuid[]))',
            [tenantId, factoryId, itemIds],
          );
          await adminPool.query(
            'DELETE FROM product_versions WHERE tenant_id=$1 AND factory_id=$2 ' +
              'AND product_id IN (SELECT id FROM product_definitions WHERE inventory_item_id = ANY($3::uuid[]))',
            [tenantId, factoryId, itemIds],
          );
          await adminPool.query(
            'DELETE FROM product_definition_idempotency WHERE tenant_id=$1 AND factory_id=$2 AND product_id IN ' +
              '(SELECT id FROM product_definitions WHERE inventory_item_id = ANY($3::uuid[]))',
            [tenantId, factoryId, itemIds],
          );
          await adminPool.query(
            'DELETE FROM product_definitions WHERE tenant_id=$1 AND factory_id=$2 AND inventory_item_id = ANY($3::uuid[])',
            [tenantId, factoryId, itemIds],
          );
          if (workCentreId) {
            await adminPool.query(
              'DELETE FROM manufacturing_work_centres WHERE tenant_id=$1 AND factory_id=$2 AND id=$3::uuid',
              [tenantId, factoryId, workCentreId],
            );
          } else {
            await adminPool.query(
              'DELETE FROM manufacturing_work_centres WHERE tenant_id=$1 AND factory_id=$2 AND code=$3',
              [tenantId, factoryId, workCentreCode],
            );
          }

          await adminPool.query(
            'DELETE FROM inventory_movements WHERE tenant_id=$1 AND factory_id=$2 AND item_id = ANY($3::uuid[])',
            [tenantId, factoryId, itemIds],
          );
          await adminPool.query(
            'DELETE FROM inventory_location_balances WHERE tenant_id=$1 AND factory_id=$2 AND item_id = ANY($3::uuid[])',
            [tenantId, factoryId, itemIds],
          );
          if (binId) {
            await adminPool.query('DELETE FROM inventory_locations WHERE tenant_id=$1 AND factory_id=$2 AND id=$3::uuid', [tenantId, factoryId, binId]);
          }
          if (warehouseId) {
            await adminPool.query('DELETE FROM inventory_locations WHERE tenant_id=$1 AND factory_id=$2 AND id=$3::uuid', [tenantId, factoryId, warehouseId]);
          }
          await adminPool.query(
            'DELETE FROM inventory_stock_balances WHERE tenant_id=$1 AND factory_id=$2 AND item_id = ANY($3::uuid[])',
            [tenantId, factoryId, itemIds],
          );
          await adminPool.query(
            'DELETE FROM inventory_items WHERE tenant_id=$1 AND factory_id=$2 AND id = ANY($3::uuid[])',
            [tenantId, factoryId, itemIds],
          );
        }
      } finally {
        for (const table of mutableTables.slice().reverse()) {
          await adminPool.query('ALTER TABLE ' + table + ' ENABLE TRIGGER USER');
        }
      }
    }
    if (appPool) await appPool.end();
    if (adminPool) await adminPool.end();
  });

  it('persists one linked sales-order → material-consumption → operation → output → genealogy journey', async () => {
    if (!adminPool) throw new Error('The admin database pool is not initialized.');

    const createItem = async (sku: string, name: string, quantity: string): Promise<string> => {
      const item = await adminPool!.query<{ id: string }>(
        'INSERT INTO inventory_items (tenant_id, factory_id, sku, name, unit, created_by_user_id) ' +
          "VALUES ($1, $2, $3, $4, 'PCS', $5) RETURNING id::text AS id",
        [tenantId, factoryId, sku, name, TEST_USER_ID],
      );
      const id = item.rows[0]?.id;
      if (!id) throw new Error('Could not create the integration inventory item.');
      if (!finishedItemId) finishedItemId = id;
      else materialItemId = id;
      await adminPool!.query(
        'INSERT INTO inventory_stock_balances (tenant_id, factory_id, item_id, quantity_on_hand) ' +
          'VALUES ($1, $2, $3, $4::numeric)',
        [tenantId, factoryId, id, quantity],
      );
      return id;
    };

    finishedItemId = await createItem('MFG-E2E-FG-' + runKey, 'Acceptance finished good', '4.0000');
    materialItemId = await createItem('MFG-E2E-MAT-' + runKey, 'Acceptance raw material', '0.0000');

    await procurementService.createSupplier(
      TEST_USER_ID,
      tenantId,
      {
        code: supplierCode,
        name: 'Manufacturing acceptance supplier',
        country_code: 'BD',
        currency: 'BDT',
      },
      correlationId,
      correlationId,
    );
    const supplierRow = await adminPool.query<{ id: string; status: string }>(
      'SELECT id::text AS id, status FROM suppliers WHERE tenant_id=$1 AND upper(code)=upper($2)',
      [tenantId, supplierCode],
    );
    supplierId = supplierRow.rows[0]?.id ?? '';
    if (!supplierId) throw new Error('Supplier fixture was not persisted.');
    expect(supplierRow.rows[0]?.status).toBe('ACTIVE');

    await procurementService.createPurchaseOrder(
      TEST_USER_ID,
      tenantId,
      factoryId,
      {
        supplier_id: supplierId,
        po_number: purchaseOrderNumber,
        order_date: today,
        expected_delivery_date: today,
        currency: 'BDT',
        lines: [{
          line_number: 1,
          inventory_item_id: materialItemId,
          description: 'Traceable acceptance raw material',
          quantity: 4,
          unit: 'PCS',
          unit_price: 1,
        }],
      },
      'mfg-e2e-purchase-order-' + runKey,
      correlationId,
      correlationId,
    );
    const purchaseOrderRow = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM purchase_orders WHERE tenant_id=$1 AND factory_id=$2 AND upper(po_number)=upper($3)',
      [tenantId, factoryId, purchaseOrderNumber],
    );
    purchaseOrderId = purchaseOrderRow.rows[0]?.id ?? '';
    if (!purchaseOrderId) throw new Error('Purchase order was not persisted.');

    let purchaseOrder = await procurementService.getPurchaseOrder(tenantId, factoryId, purchaseOrderId);
    expect(purchaseOrder.status).toBe('DRAFT');
    await procurementService.transitionPurchaseOrder(
      TEST_USER_ID, tenantId, factoryId, purchaseOrderId, 'SUBMITTED',
      Number(purchaseOrder.version), undefined, correlationId, correlationId,
    );
    purchaseOrder = await procurementService.getPurchaseOrder(tenantId, factoryId, purchaseOrderId);
    expect(purchaseOrder.status).toBe('SUBMITTED');
    await procurementService.transitionPurchaseOrder(
      approverUserId, tenantId, factoryId, purchaseOrderId, 'APPROVED',
      Number(purchaseOrder.version), undefined, correlationId, correlationId,
    );
    purchaseOrder = await procurementService.getPurchaseOrder(tenantId, factoryId, purchaseOrderId);
    expect(purchaseOrder.status).toBe('APPROVED');

    const purchaseOrderLine = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM purchase_order_lines WHERE tenant_id=$1 AND factory_id=$2 AND purchase_order_id=$3 AND inventory_item_id=$4',
      [tenantId, factoryId, purchaseOrderId, materialItemId],
    );
    const purchaseOrderLineId = purchaseOrderLine.rows[0]?.id;
    if (!purchaseOrderLineId) throw new Error('Purchase-order material line was not persisted.');

    const postedReceipt = await goodsReceiptService.postGoodsReceipt(
      TEST_USER_ID,
      tenantId,
      factoryId,
      purchaseOrderId,
      {
        supplier_delivery_reference: 'MFG-E2E-DELIVERY-' + runKey,
        notes: 'Accepted material receipt for persisted manufacturing journey',
        lines: [{ purchase_order_line_id: purchaseOrderLineId, received_quantity: 4, rejected_quantity: 0 }],
      },
      goodsReceiptKey,
      correlationId,
      correlationId,
    );
    goodsReceiptId = postedReceipt.id;
    expect(postedReceipt.status).toBe('POSTED');
    const goodsReceiptLine = await adminPool.query<{ id: string; accepted_quantity: string }>(
      'SELECT id::text AS id, accepted_quantity::text AS accepted_quantity FROM goods_receipt_lines ' +
        'WHERE tenant_id=$1 AND factory_id=$2 AND goods_receipt_id=$3',
      [tenantId, factoryId, goodsReceiptId],
    );
    goodsReceiptLineId = goodsReceiptLine.rows[0]?.id ?? '';
    if (!goodsReceiptLineId) throw new Error('Posted goods-receipt line was not persisted.');
    expect(goodsReceiptLine.rows[0]?.accepted_quantity).toBe('4.0000');

    const receivedStock = await adminPool.query<{ quantity_on_hand: string }>(
      'SELECT quantity_on_hand::text AS quantity_on_hand FROM inventory_stock_balances ' +
        'WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3',
      [tenantId, factoryId, materialItemId],
    );
    expect(receivedStock.rows[0]?.quantity_on_hand).toBe('4.0000');

    const materialUnit = await traceabilityService.createUnit(
      TEST_USER_ID,
      tenantId,
      factoryId,
      {
        unit_type: 'LOT',
        product_role: 'MATERIAL',
        unit_code: 'MFG-LOT-' + runKey,
        inventory_item_id: materialItemId,
        quantity: 4,
        unit: 'PCS',
        external_reference: 'manufacturing-lifecycle-acceptance-' + runKey,
      },
      'mfg-e2e-material-lot-' + runKey,
      correlationId,
      correlationId,
    );
    materialTraceabilityUnitId = materialUnit.id;

    const defaultLocation = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM inventory_locations WHERE tenant_id=$1 AND factory_id=$2 AND is_default=TRUE LIMIT 1',
      [tenantId, factoryId],
    );
    const defaultLocationId = defaultLocation.rows[0]?.id;
    if (!defaultLocationId) throw new Error('Factory UNASSIGNED inventory location is missing.');

    const warehouse = await inventoryLocationService.createLocation(
      TEST_USER_ID, tenantId, factoryId,
      { location_code: 'MFG-E2E-WH-' + runKey, name: 'Acceptance warehouse', location_type: 'WAREHOUSE' },
      correlationId, correlationId,
    );
    warehouseId = warehouse.id;
    const bin = await inventoryLocationService.createLocation(
      TEST_USER_ID, tenantId, factoryId,
      { location_code: 'MFG-E2E-BIN-' + runKey, name: 'Acceptance raw-material bin', location_type: 'BIN', parent_location_id: warehouseId },
      correlationId, correlationId,
    );
    binId = bin.id;
    const putAway = await inventoryLocationService.transferStock(
      TEST_USER_ID, tenantId, factoryId, materialItemId,
      {
        movement_purpose: 'PUT_AWAY',
        source_location_id: defaultLocationId,
        destination_location_id: binId,
        traceability_unit_id: materialTraceabilityUnitId,
        quantity: 4,
        notes: 'Put acceptance material lot away before production reservation',
      },
      'mfg-e2e-put-away-' + runKey,
      correlationId,
      correlationId,
    );
    expect(putAway.movement_purpose).toBe('PUT_AWAY');
    expect(putAway.traceability_unit_id).toBe(materialTraceabilityUnitId);

    const qualityContext = {
      userId: TEST_USER_ID,
      tenantId,
      factoryId,
      requestId: correlationId,
      traceId: correlationId,
    };
    const incomingInspection = await qualityService.createInspection(
      qualityContext,
      {
        inspection_type: 'SUPPLIER',
        target_type: 'GOODS_RECEIPT_LINE',
        target_id: goodsReceiptLineId,
        sample_quantity: 1,
        notes: 'Supplier material quality gate for manufacturing acceptance',
      },
      qualityInspectionKey,
    );
    qualityInspectionId = incomingInspection.id;
    const heldInspection = await qualityService.decideInspection(
      qualityContext,
      qualityInspectionId,
      {
        expected_version: Number(incomingInspection.row_version),
        action: 'HOLD',
        reason: 'Hold supplier material until incoming quality disposition',
      },
      'mfg-e2e-inspection-hold-' + runKey,
    );
    expect(heldInspection.status).toBe('ON_HOLD');

    await productService.createProduct(
      TEST_USER_ID,
      tenantId,
      factoryId,
      {
        inventory_item_id: finishedItemId,
        product_code: productCode,
        product_name: 'Acceptance manufactured product',
        product_type: 'STANDARD',
        base_unit: 'PCS',
      },
      'mfg-e2e-product-' + runKey,
      correlationId,
      correlationId,
    );
    const productRow = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM product_definitions WHERE tenant_id=$1 AND factory_id=$2 AND product_code=$3',
      [tenantId, factoryId, productCode],
    );
    productId = productRow.rows[0]?.id ?? '';
    if (!productId) throw new Error('Product definition was not persisted.');

    const workCentre = await productService.createWorkCentre(
      TEST_USER_ID,
      tenantId,
      factoryId,
      { code: workCentreCode, name: 'Acceptance assembly cell', capacity_units_per_hour: 60 },
      'mfg-e2e-work-centre-' + runKey,
      correlationId,
      correlationId,
    );
    workCentreId = workCentre.work_centre.id;

    await productService.createVersion(
      TEST_USER_ID,
      tenantId,
      factoryId,
      productId,
      {
        effective_from: today,
        expected_yield_percent: 100,
        change_summary: 'Persisted order-to-genealogy acceptance revision',
      },
      'mfg-e2e-version-' + runKey,
      correlationId,
      correlationId,
    );
    const versionRow = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM product_versions WHERE tenant_id=$1 AND factory_id=$2 AND product_id=$3 ORDER BY version_number DESC LIMIT 1',
      [tenantId, factoryId, productId],
    );
    productVersionId = versionRow.rows[0]?.id ?? '';
    if (!productVersionId) throw new Error('Product version was not persisted.');

    await productService.replaceBom(
      TEST_USER_ID,
      tenantId,
      factoryId,
      productId,
      productVersionId,
      {
        expected_version: 1,
        lines: [{ line_number: 1, component_item_id: materialItemId, quantity_per: 1, unit: 'PCS', wastage_percent: 0 }],
      },
      correlationId,
      correlationId,
    );
    await productService.replaceRouting(
      TEST_USER_ID,
      tenantId,
      factoryId,
      productId,
      productVersionId,
      {
        expected_version: 2,
        steps: [{
          step_number: 1,
          operation_code: 'ASSEMBLE',
          operation_name: 'Assemble acceptance product',
          work_centre_id: workCentreId,
          setup_minutes: 1,
          run_minutes_per_unit: 1,
          queue_minutes: 0,
          transfer_minutes: 0,
          is_quality_gate: false,
        }],
      },
      correlationId,
      correlationId,
    );
    await productService.approveVersion(
      approverUserId,
      tenantId,
      factoryId,
      productId,
      productVersionId,
      { expected_version: 3 },
      'mfg-e2e-approve-version-' + runKey,
      correlationId,
      correlationId,
    );

    await ordersService.createOrder(
      TEST_USER_ID,
      tenantId,
      {
        factory_id: factoryId,
        order_number: orderNumber,
        customer_name: 'Manufacturing acceptance customer',
        order_date: today,
        currency: 'BDT',
        lines: [{
          line_number: 1,
          product_code: productCode,
          product_name: 'Acceptance manufactured product',
          quantity: 4,
          unit: 'PCS',
          inventory_item_id: finishedItemId,
          unit_price: 1,
        }],
      },
      correlationId,
      correlationId,
      null,
    );
    const orderRow = await adminPool.query<{ id: string; version: string }>(
      'SELECT id::text AS id, version::text AS version FROM orders WHERE tenant_id=$1 AND factory_id=$2 AND order_number=$3',
      [tenantId, factoryId, orderNumber],
    );
    orderId = orderRow.rows[0]?.id ?? '';
    if (!orderId) throw new Error('Sales order was not persisted.');
    const lineRow = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM order_lines WHERE tenant_id=$1 AND factory_id=$2 AND order_id=$3',
      [tenantId, factoryId, orderId],
    );
    orderLineId = lineRow.rows[0]?.id ?? '';
    if (!orderLineId) throw new Error('Sales-order line was not persisted.');

    await ordersService.transitionOrderStatus(
      TEST_USER_ID, tenantId, orderId, 'CONFIRMED', correlationId, correlationId, Number(orderRow.rows[0]?.version),
    );
    const confirmedOrder = await adminPool.query<{ version: string }>(
      'SELECT version::text AS version FROM orders WHERE tenant_id=$1 AND factory_id=$2 AND id=$3',
      [tenantId, factoryId, orderId],
    );
    await ordersService.transitionOrderStatus(
      TEST_USER_ID, tenantId, orderId, 'IN_PROGRESS', correlationId, correlationId, Number(confirmedOrder.rows[0]?.version),
    );

    await productionService.createWorkOrder(
      TEST_USER_ID,
      tenantId,
      factoryId,
      { order_line_id: orderLineId, target_quantity: 4, planned_start_date: today, due_date: today },
      workOrderKey,
      correlationId,
      correlationId,
    );
    const createdWorkOrder = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM work_orders WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3',
      [tenantId, factoryId, workOrderKey],
    );
    workOrderId = createdWorkOrder.rows[0]?.id ?? '';
    if (!workOrderId) throw new Error('Work order was not persisted.');

    let workOrder = await productionService.getWorkOrder(TEST_USER_ID, tenantId, factoryId, workOrderId);
    await expect(
      productionService.transitionWorkOrder(
        TEST_USER_ID,
        tenantId,
        factoryId,
        workOrderId,
        'RELEASE',
        { expected_version: Number(workOrder.row_version) },
        'mfg-e2e-release-held-' + runKey,
        correlationId,
        correlationId,
      ),
    ).rejects.toThrow(/quality hold/i);

    const blockedByQualityHold = await adminPool.query<{ active_hold_count: number }>(
      'SELECT count(*)::int AS active_hold_count FROM quality_holds ' +
        'WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id=$3 AND status=\'ACTIVE\'',
      [tenantId, factoryId, qualityInspectionId],
    );
    expect(blockedByQualityHold.rows[0]?.active_hold_count).toBe(1);

    const inspectionBeforeRelease = await qualityService.getInspection(qualityContext, qualityInspectionId);
    expect(inspectionBeforeRelease.status).toBe('ON_HOLD');
    const releasedInspection = await qualityService.disposeInspection(
      qualityContext,
      qualityInspectionId,
      {
        expected_version: Number(inspectionBeforeRelease.row_version),
        action: 'RELEASE',
        reason: 'Incoming quality review accepted the supplier lot',
      },
      'mfg-e2e-disposition-release-' + runKey,
    );
    expect(releasedInspection.disposition.action).toBe('RELEASE');

    const afterDispositionHold = await adminPool.query<{ active_hold_count: number; released_hold_count: number }>(
      'SELECT count(*) FILTER (WHERE status=\'ACTIVE\')::int AS active_hold_count, ' +
        'count(*) FILTER (WHERE status=\'RELEASED\')::int AS released_hold_count ' +
        'FROM quality_holds WHERE tenant_id=$1 AND factory_id=$2 AND inspection_id=$3',
      [tenantId, factoryId, qualityInspectionId],
    );
    expect(afterDispositionHold.rows[0]?.active_hold_count).toBe(0);
    expect(afterDispositionHold.rows[0]?.released_hold_count).toBe(1);

    workOrder = await productionService.getWorkOrder(TEST_USER_ID, tenantId, factoryId, workOrderId);
    await productionService.transitionWorkOrder(
      TEST_USER_ID,
      tenantId,
      factoryId,
      workOrderId,
      'RELEASE',
      { expected_version: Number(workOrder.row_version) },
      'mfg-e2e-release-' + runKey,
      correlationId,
      correlationId,
    );
    workOrder = await productionService.getWorkOrder(TEST_USER_ID, tenantId, factoryId, workOrderId);

    const blockedCompletionOrderVersion = await adminPool.query<{ version: string }>(
      'SELECT version::text AS version FROM orders WHERE tenant_id=$1 AND factory_id=$2 AND id=$3',
      [tenantId, factoryId, orderId],
    );
    await expect(
      ordersService.transitionOrderStatus(
        TEST_USER_ID,
        tenantId,
        orderId,
        'COMPLETED',
        correlationId,
        correlationId,
        Number(blockedCompletionOrderVersion.rows[0]?.version),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const reservationBeforeOutput = await adminPool.query<{ status: string; quantity: string }>(
      'SELECT r.status, r.quantity::text AS quantity FROM work_order_material_reservations mr ' +
        'JOIN inventory_reservations r ON r.id=mr.reservation_id AND r.tenant_id=mr.tenant_id AND r.factory_id=mr.factory_id ' +
        'WHERE mr.tenant_id=$1 AND mr.factory_id=$2 AND mr.work_order_id=$3',
      [tenantId, factoryId, workOrderId],
    );
    expect(reservationBeforeOutput.rows).toHaveLength(1);
    expect(reservationBeforeOutput.rows[0]?.status).toBe('RESERVED');
    expect(reservationBeforeOutput.rows[0]?.quantity).toBe('4.0000');

    let operation = workOrder.operations[0] as { id: string; row_version: number | string };
    await productionService.reportOperationEvent(
      TEST_USER_ID,
      tenantId,
      factoryId,
      workOrderId,
      operation.id,
      {
        command: 'START',
        expected_work_order_version: Number(workOrder.row_version),
        expected_operation_version: Number(operation.row_version),
      },
      'mfg-e2e-operation-start-' + runKey,
      correlationId,
      correlationId,
    );

    workOrder = await productionService.getWorkOrder(TEST_USER_ID, tenantId, factoryId, workOrderId);
    operation = workOrder.operations[0] as { id: string; row_version: number | string };
    const outputInput = {
      operation_id: operation.id,
      expected_work_order_version: Number(workOrder.row_version),
      expected_operation_version: Number(operation.row_version),
      good_quantity: 4,
      scrap_quantity: 0,
      notes: 'Single persisted production output for lifecycle acceptance',
    };
    const output = await productionService.reportOutput(
      TEST_USER_ID,
      tenantId,
      factoryId,
      workOrderId,
      outputInput,
      outputKey,
      correlationId,
      correlationId,
    );
    const replayedOutput = await productionService.reportOutput(
      TEST_USER_ID,
      tenantId,
      factoryId,
      workOrderId,
      outputInput,
      outputKey,
      correlationId,
      correlationId,
    );
    expect(replayedOutput.replayed).toBe(true);
    expect(replayedOutput.productionReportId).toBe(output.productionReportId);
    expect(replayedOutput.productionOutputPostingId).toBe(output.productionOutputPostingId);

    await expect(
      productionService.reportOutput(
        TEST_USER_ID,
        tenantId,
        factoryId,
        workOrderId,
        { ...outputInput, good_quantity: 3, scrap_quantity: 1, scrap_reason: 'changed replay payload' },
        outputKey,
        correlationId,
        correlationId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    workOrder = await productionService.getWorkOrder(TEST_USER_ID, tenantId, factoryId, workOrderId);
    operation = workOrder.operations[0] as { id: string; row_version: number | string };
    await productionService.reportOperationEvent(
      TEST_USER_ID,
      tenantId,
      factoryId,
      workOrderId,
      operation.id,
      {
        command: 'COMPLETE',
        expected_work_order_version: Number(workOrder.row_version),
        expected_operation_version: Number(operation.row_version),
      },
      'mfg-e2e-operation-complete-' + runKey,
      correlationId,
      correlationId,
    );

    workOrder = await productionService.getWorkOrder(TEST_USER_ID, tenantId, factoryId, workOrderId);
    await productionService.transitionWorkOrder(
      TEST_USER_ID,
      tenantId,
      factoryId,
      workOrderId,
      'COMPLETE',
      { expected_version: Number(workOrder.row_version) },
      'mfg-e2e-complete-work-order-' + runKey,
      correlationId,
      correlationId,
    );

    const inProgressOrder = await adminPool.query<{ version: string }>(
      'SELECT version::text AS version FROM orders WHERE tenant_id=$1 AND factory_id=$2 AND id=$3',
      [tenantId, factoryId, orderId],
    );
    await ordersService.transitionOrderStatus(
      TEST_USER_ID,
      tenantId,
      orderId,
      'COMPLETED',
      correlationId,
      correlationId,
      Number(inProgressOrder.rows[0]?.version),
    );

    const finalState = await adminPool.query<{
      order_status: string;
      work_order_status: string;
      material_reservation_status: string;
      consumed_quantity: string;
      report_count: number;
      output_posting_count: number;
      reported_good_quantity: string;
      posted_good_quantity: string;
      material_balance: string;
      finished_balance: string;
      genealogy_edge_count: number;
      genealogy_quantity: string;
      genealogy_source_count: number;
      genealogy_target_count: number;
    }>(
      'SELECT ' +
        '(SELECT status FROM orders WHERE id=$3 AND tenant_id=$1 AND factory_id=$2) AS order_status, ' +
        '(SELECT status FROM work_orders WHERE id=$4 AND tenant_id=$1 AND factory_id=$2) AS work_order_status, ' +
        '(SELECT r.status FROM work_order_material_reservations mr JOIN inventory_reservations r ' +
        ' ON r.id=mr.reservation_id AND r.tenant_id=mr.tenant_id AND r.factory_id=mr.factory_id ' +
        ' WHERE mr.work_order_id=$4 AND mr.tenant_id=$1 AND mr.factory_id=$2 LIMIT 1) AS material_reservation_status, ' +
        '(SELECT COALESCE(SUM(c.quantity),0)::text FROM inventory_reservation_consumptions c ' +
        ' JOIN work_order_material_reservations mr ON mr.reservation_id=c.reservation_id ' +
        ' WHERE mr.work_order_id=$4 AND c.tenant_id=$1 AND c.factory_id=$2) AS consumed_quantity, ' +
        '(SELECT count(*)::int FROM order_production_reports r WHERE r.work_order_id=$4 AND r.tenant_id=$1 AND r.factory_id=$2) AS report_count, ' +
        '(SELECT count(*)::int FROM production_output_postings p WHERE p.work_order_id=$4 AND p.tenant_id=$1 AND p.factory_id=$2) AS output_posting_count, ' +
        '(SELECT COALESCE(SUM(r.good_quantity),0)::text FROM order_production_reports r WHERE r.work_order_id=$4 AND r.tenant_id=$1 AND r.factory_id=$2) AS reported_good_quantity, ' +
        '(SELECT COALESCE(SUM(p.good_quantity),0)::text FROM production_output_postings p WHERE p.work_order_id=$4 AND p.tenant_id=$1 AND p.factory_id=$2) AS posted_good_quantity, ' +
        '(SELECT quantity_on_hand::text FROM inventory_stock_balances WHERE item_id=$5 AND tenant_id=$1 AND factory_id=$2) AS material_balance, ' +
        '(SELECT quantity_on_hand::text FROM inventory_stock_balances WHERE item_id=$6 AND tenant_id=$1 AND factory_id=$2) AS finished_balance, ' +
        '(SELECT count(*)::int FROM product_genealogy_events e WHERE e.tenant_id=$1 AND e.factory_id=$2 ' +
        " AND e.evidence->>'work_order_id'=$4::text AND e.evidence->>'source'='WORK_ORDER_MATERIAL_CONSUMPTION') AS genealogy_edge_count, " +
        '(SELECT COALESCE(SUM(e.quantity),0)::text FROM product_genealogy_events e WHERE e.tenant_id=$1 AND e.factory_id=$2 ' +
        " AND e.evidence->>'work_order_id'=$4::text AND e.evidence->>'source'='WORK_ORDER_MATERIAL_CONSUMPTION') AS genealogy_quantity, " +
        '(SELECT count(DISTINCT e.source_unit_id)::int FROM product_genealogy_events e WHERE e.tenant_id=$1 AND e.factory_id=$2 ' +
        " AND e.evidence->>'work_order_id'=$4::text AND e.evidence->>'source'='WORK_ORDER_MATERIAL_CONSUMPTION') AS genealogy_source_count, " +
        '(SELECT count(DISTINCT e.target_unit_id)::int FROM product_genealogy_events e WHERE e.tenant_id=$1 AND e.factory_id=$2 ' +
        " AND e.evidence->>'work_order_id'=$4::text AND e.evidence->>'source'='WORK_ORDER_MATERIAL_CONSUMPTION') AS genealogy_target_count",
      [tenantId, factoryId, orderId, workOrderId, materialItemId, finishedItemId],
    );
    const row = finalState.rows[0];
    expect(row).toBeDefined();
    expect(row?.order_status).toBe('COMPLETED');
    expect(row?.work_order_status).toBe('COMPLETED');
    expect(row?.material_reservation_status).toBe('CONSUMED');
    expect(row?.consumed_quantity).toBe('4.0000');
    expect(row?.report_count).toBe(1);
    expect(row?.output_posting_count).toBe(1);
    expect(row?.reported_good_quantity).toBe('4.0000');
    expect(row?.posted_good_quantity).toBe('4.0000');
    expect(row?.material_balance).toBe('0.0000');
    expect(row?.finished_balance).toBe('4.0000');
    expect(row?.genealogy_edge_count).toBe(1);
    expect(row?.genealogy_quantity).toBe('4.0000');
    expect(row?.genealogy_source_count).toBe(1);
    expect(row?.genealogy_target_count).toBe(1);

    const intakeQualityProof = await adminPool.query<{
      purchase_order_status: string;
      goods_receipt_status: string;
      received_quantity: string;
      accepted_quantity: string;
      inspection_status: string;
      active_hold_count: number;
      released_hold_count: number;
      release_disposition_count: number;
    }>(
      'SELECT ' +
        '(SELECT status FROM purchase_orders WHERE id=$3 AND tenant_id=$1 AND factory_id=$2) AS purchase_order_status, ' +
        '(SELECT status FROM goods_receipts WHERE id=$4 AND tenant_id=$1 AND factory_id=$2) AS goods_receipt_status, ' +
        '(SELECT received_quantity::text FROM goods_receipt_lines WHERE goods_receipt_id=$4 AND tenant_id=$1 AND factory_id=$2 LIMIT 1) AS received_quantity, ' +
        '(SELECT accepted_quantity::text FROM goods_receipt_lines WHERE goods_receipt_id=$4 AND tenant_id=$1 AND factory_id=$2 LIMIT 1) AS accepted_quantity, ' +
        '(SELECT status FROM quality_inspections WHERE id=$5 AND tenant_id=$1 AND factory_id=$2) AS inspection_status, ' +
        '(SELECT count(*)::int FROM quality_holds WHERE inspection_id=$5 AND tenant_id=$1 AND factory_id=$2 AND status=\'ACTIVE\') AS active_hold_count, ' +
        '(SELECT count(*)::int FROM quality_holds WHERE inspection_id=$5 AND tenant_id=$1 AND factory_id=$2 AND status=\'RELEASED\') AS released_hold_count, ' +
        '(SELECT count(*)::int FROM quality_dispositions WHERE inspection_id=$5 AND tenant_id=$1 AND factory_id=$2 AND action=\'RELEASE\' AND status=\'RECORDED\') AS release_disposition_count',
      [tenantId, factoryId, purchaseOrderId, goodsReceiptId, qualityInspectionId],
    );
    expect(intakeQualityProof.rows[0]?.purchase_order_status).toBe('APPROVED');
    expect(intakeQualityProof.rows[0]?.goods_receipt_status).toBe('POSTED');
    expect(intakeQualityProof.rows[0]?.received_quantity).toBe('4.0000');
    expect(intakeQualityProof.rows[0]?.accepted_quantity).toBe('4.0000');
    expect(intakeQualityProof.rows[0]?.inspection_status).toBe('DISPOSITIONED');
    expect(intakeQualityProof.rows[0]?.active_hold_count).toBe(0);
    expect(intakeQualityProof.rows[0]?.released_hold_count).toBe(1);
    expect(intakeQualityProof.rows[0]?.release_disposition_count).toBe(1);
    expect(materialTraceabilityUnitId).toBeTruthy();
  });
});
