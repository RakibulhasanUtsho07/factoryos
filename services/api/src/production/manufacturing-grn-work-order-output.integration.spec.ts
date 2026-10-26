import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { createIntegrationDatabase } from '../database/integration-database.adapter';
import { DatabaseService } from '../database/database.service';
import { InventoryLocationService } from '../inventory/inventory.location.service';
import { InventoryReservationService } from '../inventory/inventory.reservation.service';
import { OrderIdempotencyService } from '../orders/order-idempotency.service';
import { OrdersService } from '../orders/orders.service';
import { ProductDefinitionsService } from '../products/products.service';
import { ProductionWorkOrdersService } from './production-work-orders.service';

describe('Manufacturing GRN → make-to-order work-order output PostgreSQL acceptance', () => {
  const TEST_USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
  const audit = { record: async () => 'integration-audit-id' } as unknown as AuditService;

  let adminPool!: Pool;
  let appPool!: Pool;
  let database!: DatabaseService;
  let inventory!: InventoryReservationService;
  let locationService!: InventoryLocationService;
  let productService!: ProductDefinitionsService;
  let ordersService!: OrdersService;
  let productionService!: ProductionWorkOrdersService;
  let tenantId!: string;
  let factoryId!: string;
  let approvalUserId!: string;
  let createdApprovalUser = false;
  let defaultLocationId!: string;

  let materialItemId: string | null = null;
  let finishedItemId: string | null = null;
  let supplierId: string | null = null;
  let purchaseOrderId: string | null = null;
  let purchaseOrderLineId: string | null = null;
  let receiptId: string | null = null;
  let receiptLineId: string | null = null;
  let sourceLotId: string | null = null;
  let warehouseId: string | null = null;
  let binId: string | null = null;
  let workCentreId: string | null = null;
  let productId: string | null = null;
  let productVersionId: string | null = null;
  let orderId: string | null = null;
  let orderLineId: string | null = null;
  let workOrderId: string | null = null;
  let outputLotId: string | null = null;
  let outputReportId: string | null = null;
  let requestId = randomUUID();
  const correlationId = randomUUID();
  const suffix = randomUUID().slice(0, 10).toUpperCase();
  let currentDate = '';

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
    if (!databaseUrl || !adminUrl) {
      throw new Error('DATABASE_URL and TEST_ADMIN_DATABASE_URL are required');
    }

    adminPool = new Pool({ connectionString: adminUrl });
    appPool = new Pool({ connectionString: databaseUrl });

    const context = await adminPool.query<{ tenant_id: string; factory_id: string; default_location_id: string; today: string }>(`
      SELECT t.id::text AS tenant_id, f.id::text AS factory_id,
        l.id::text AS default_location_id, CURRENT_DATE::text AS today
      FROM tenants t
      JOIN factories f ON f.tenant_id = t.id
      JOIN inventory_locations l
        ON l.tenant_id = t.id AND l.factory_id = f.id
       AND l.is_default = TRUE AND l.location_type = 'VIRTUAL' AND l.status = 'ACTIVE'
      WHERE t.status = 'ACTIVE' AND f.status = 'ACTIVE'
      ORDER BY t.created_at, f.created_at
      LIMIT 1
    `);
    const first = context.rows[0];
    if (!first) throw new Error('No active tenant/factory/default inventory location is available');
    tenantId = first.tenant_id;
    factoryId = first.factory_id;
    defaultLocationId = first.default_location_id;
    currentDate = first.today;

    const actor = await adminPool.query('SELECT 1 FROM users WHERE id = $1', [TEST_USER_ID]);
    if (actor.rowCount !== 1) throw new Error('Manufacturing acceptance actor is missing');
    const approver = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM users WHERE id <> $1 LIMIT 1',
      [TEST_USER_ID],
    );
    approvalUserId = approver.rows[0]?.id ?? randomUUID();
    if (!approver.rows[0]) {
      await adminPool.query('INSERT INTO users (id, display_name) VALUES ($1, $2)', [
        approvalUserId, 'Manufacturing Independent Approver',
      ]);
      createdApprovalUser = true;
    }

    database = createIntegrationDatabase(appPool) as unknown as DatabaseService;
    inventory = new InventoryReservationService(database, audit);
    locationService = new InventoryLocationService(database, audit);
    productService = new ProductDefinitionsService(database, audit);
    ordersService = new OrdersService(
      database,
      audit,
      new OrderIdempotencyService(database),
      inventory,
    );
    productionService = new ProductionWorkOrdersService(database, audit, inventory);

    await seedPostedGrnMaterial();
    await seedWorkCentreAndPickingBin();
  });

  afterAll(async () => {
    if (!adminPool) return;
    const tables = [
      'product_genealogy_events',
      'work_order_events',
      'work_order_material_reservations',
      'work_order_material_requirements',
      'work_order_operations',
      'work_orders',
      'production_output_postings',
      'order_production_reports',
      'traceability_units',
      'inventory_reservation_consumption_traceability_allocations',
      'inventory_reservation_consumptions',
      'inventory_reservation_traceability_allocations',
      'inventory_reservations',
      'inventory_location_transfers',
      'inventory_movements',
      'inventory_traceability_location_balances',
      'inventory_location_balances',
      'inventory_stock_balances',
      'order_lines',
      'orders',
      'goods_receipt_lines',
      'goods_receipts',
      'purchase_order_status_history',
      'purchase_order_lines',
      'purchase_orders',
      'product_routing_steps',
      'product_bom_lines',
      'product_versions',
      'product_definition_idempotency',
      'product_definitions',
      'manufacturing_work_centres',
    ];
    try {
      for (const table of tables) {
        await adminPool.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER');
      }

      if (orderId) {
        await adminPool.query('DELETE FROM order_event_projections WHERE order_id = $1', [orderId]);
        await adminPool.query('DELETE FROM order_idempotency_keys WHERE tenant_id = $1 AND idempotency_key = $2', [
          tenantId, `mto-order-${suffix}`,
        ]);
      }
      const relatedIds = [
        materialItemId, finishedItemId, supplierId, purchaseOrderId, purchaseOrderLineId,
        receiptId, receiptLineId, sourceLotId, warehouseId, binId, workCentreId,
        productId, productVersionId, orderId, orderLineId, workOrderId, outputLotId, outputReportId,
      ].filter((id): id is string => id !== null);
      await adminPool.query(
        `DELETE FROM audit_events WHERE tenant_id = $1 AND factory_id = $2
           AND (correlation_id = $3 OR resource_id = ANY($4::uuid[]))`,
        [tenantId, factoryId, correlationId, relatedIds],
      );
      await adminPool.query(
        `DELETE FROM outbox_events WHERE tenant_id = $1 AND factory_id = $2
           AND (correlation_id = $3 OR aggregate_id = ANY($4::uuid[]))`,
        [tenantId, factoryId, correlationId, relatedIds],
      );

      if (materialItemId || finishedItemId) {
        const items = [materialItemId, finishedItemId].filter((id): id is string => id !== null);
        await adminPool.query(
          `DELETE FROM product_genealogy_events
           WHERE tenant_id = $1 AND factory_id = $2
             AND (source_unit_id = ANY($3::uuid[]) OR target_unit_id = ANY($3::uuid[]))`,
          [tenantId, factoryId, [sourceLotId, outputLotId].filter((id): id is string => id !== null)],
        );
        await adminPool.query(
          `DELETE FROM inventory_reservation_consumption_traceability_allocations
           WHERE tenant_id = $1 AND factory_id = $2
             AND consumption_id IN (
               SELECT id FROM inventory_reservation_consumptions WHERE item_id = ANY($3::uuid[])
             )`,
          [tenantId, factoryId, items],
        );
        await adminPool.query(
          'DELETE FROM inventory_reservation_consumptions WHERE tenant_id = $1 AND factory_id = $2 AND item_id = ANY($3::uuid[])',
          [tenantId, factoryId, items],
        );
        await adminPool.query(
          'DELETE FROM inventory_reservation_traceability_allocations WHERE tenant_id = $1 AND factory_id = $2 AND item_id = ANY($3::uuid[])',
          [tenantId, factoryId, items],
        );
        await adminPool.query(
          'DELETE FROM work_order_material_reservations WHERE tenant_id = $1 AND factory_id = $2 AND work_order_id = $3',
          [tenantId, factoryId, workOrderId],
        );
        await adminPool.query(
          'DELETE FROM inventory_reservations WHERE tenant_id = $1 AND factory_id = $2 AND item_id = ANY($3::uuid[])',
          [tenantId, factoryId, items],
        );
        await adminPool.query(
          'DELETE FROM production_output_postings WHERE tenant_id = $1 AND factory_id = $2 AND work_order_id = $3',
          [tenantId, factoryId, workOrderId],
        );
        await adminPool.query(
          'DELETE FROM work_order_events WHERE tenant_id = $1 AND factory_id = $2 AND work_order_id = $3',
          [tenantId, factoryId, workOrderId],
        );
        await adminPool.query(
          'DELETE FROM traceability_units WHERE tenant_id = $1 AND factory_id = $2 AND id = ANY($3::uuid[])',
          [tenantId, factoryId, [sourceLotId, outputLotId].filter((id): id is string => id !== null)],
        );
        await adminPool.query(
          'DELETE FROM order_production_reports WHERE tenant_id = $1 AND factory_id = $2 AND order_id = $3',
          [tenantId, factoryId, orderId],
        );
        await adminPool.query(
          'DELETE FROM inventory_location_transfers WHERE tenant_id = $1 AND factory_id = $2 AND item_id = ANY($3::uuid[])',
          [tenantId, factoryId, items],
        );
        await adminPool.query(
          'DELETE FROM inventory_movements WHERE tenant_id = $1 AND factory_id = $2 AND item_id = ANY($3::uuid[])',
          [tenantId, factoryId, items],
        );
        await adminPool.query(
          'DELETE FROM inventory_traceability_location_balances WHERE tenant_id = $1 AND factory_id = $2 AND item_id = ANY($3::uuid[])',
          [tenantId, factoryId, items],
        );
        await adminPool.query(
          'DELETE FROM inventory_location_balances WHERE tenant_id = $1 AND factory_id = $2 AND item_id = ANY($3::uuid[])',
          [tenantId, factoryId, items],
        );
        await adminPool.query(
          'DELETE FROM inventory_stock_balances WHERE tenant_id = $1 AND factory_id = $2 AND item_id = ANY($3::uuid[])',
          [tenantId, factoryId, items],
        );
      }

      if (workOrderId) {
        await adminPool.query('DELETE FROM work_order_material_requirements WHERE tenant_id = $1 AND factory_id = $2 AND work_order_id = $3', [tenantId, factoryId, workOrderId]);
        await adminPool.query('DELETE FROM work_order_operations WHERE tenant_id = $1 AND factory_id = $2 AND work_order_id = $3', [tenantId, factoryId, workOrderId]);
        await adminPool.query('DELETE FROM work_orders WHERE tenant_id = $1 AND factory_id = $2 AND id = $3', [tenantId, factoryId, workOrderId]);
      }
      if (orderId) {
        await adminPool.query('DELETE FROM order_lines WHERE tenant_id = $1 AND factory_id = $2 AND order_id = $3', [tenantId, factoryId, orderId]);
        await adminPool.query('DELETE FROM orders WHERE tenant_id = $1 AND factory_id = $2 AND id = $3', [tenantId, factoryId, orderId]);
      }
      if (productVersionId) {
        await adminPool.query('DELETE FROM product_bom_lines WHERE tenant_id = $1 AND factory_id = $2 AND product_version_id = $3', [tenantId, factoryId, productVersionId]);
        await adminPool.query('DELETE FROM product_routing_steps WHERE tenant_id = $1 AND factory_id = $2 AND product_version_id = $3', [tenantId, factoryId, productVersionId]);
        await adminPool.query('DELETE FROM product_versions WHERE tenant_id = $1 AND factory_id = $2 AND id = $3', [tenantId, factoryId, productVersionId]);
      }
      if (productId) {
        await adminPool.query('DELETE FROM product_definition_idempotency WHERE tenant_id = $1 AND factory_id = $2 AND product_id = $3', [tenantId, factoryId, productId]);
        await adminPool.query('DELETE FROM product_definitions WHERE tenant_id = $1 AND factory_id = $2 AND id = $3', [tenantId, factoryId, productId]);
      }
      if (receiptId) {
        await adminPool.query('DELETE FROM goods_receipt_lines WHERE tenant_id = $1 AND factory_id = $2 AND goods_receipt_id = $3', [tenantId, factoryId, receiptId]);
        await adminPool.query('DELETE FROM goods_receipts WHERE tenant_id = $1 AND factory_id = $2 AND id = $3', [tenantId, factoryId, receiptId]);
      }
      if (purchaseOrderId) {
        await adminPool.query('DELETE FROM purchase_order_status_history WHERE tenant_id = $1 AND factory_id = $2 AND purchase_order_id = $3', [tenantId, factoryId, purchaseOrderId]);
        await adminPool.query('DELETE FROM purchase_order_lines WHERE tenant_id = $1 AND factory_id = $2 AND purchase_order_id = $3', [tenantId, factoryId, purchaseOrderId]);
        await adminPool.query('DELETE FROM purchase_orders WHERE tenant_id = $1 AND factory_id = $2 AND id = $3', [tenantId, factoryId, purchaseOrderId]);
      }
      if (supplierId) {
        await adminPool.query('DELETE FROM suppliers WHERE tenant_id = $1 AND id = $2', [tenantId, supplierId]);
      }
      if (binId) await adminPool.query('DELETE FROM inventory_locations WHERE tenant_id = $1 AND factory_id = $2 AND id = $3', [tenantId, factoryId, binId]);
      if (warehouseId) await adminPool.query('DELETE FROM inventory_locations WHERE tenant_id = $1 AND factory_id = $2 AND id = $3', [tenantId, factoryId, warehouseId]);
      if (workCentreId) await adminPool.query('DELETE FROM manufacturing_work_centres WHERE tenant_id = $1 AND factory_id = $2 AND id = $3', [tenantId, factoryId, workCentreId]);
      const items = [materialItemId, finishedItemId].filter((id): id is string => id !== null);
      if (items.length) await adminPool.query('DELETE FROM inventory_items WHERE tenant_id = $1 AND factory_id = $2 AND id = ANY($3::uuid[])', [tenantId, factoryId, items]);
      if (createdApprovalUser && approvalUserId) {
        await adminPool.query('DELETE FROM users WHERE id = $1', [approvalUserId]);
      }
    } finally {
      for (const table of tables.reverse()) {
        await adminPool.query('ALTER TABLE ' + table + ' ENABLE TRIGGER USER');
      }
      await appPool?.end();
      await adminPool.end();
    }
  });

  it('connects a posted GRN lot through order confirmation, BOM consumption, accepted output, genealogy and work-order completion', async () => {
    const material = materialItemId!;
    const finished = finishedItemId!;

    await locationService.transferStock(
      TEST_USER_ID, tenantId, factoryId, material,
      {
        movement_purpose: 'PUT_AWAY',
        source_location_id: defaultLocationId,
        destination_location_id: binId!,
        traceability_unit_id: sourceLotId!,
        quantity: 5,
        notes: 'Put away the exact GRN source lot for production acceptance',
      },
      `mto-putaway-${suffix}`, randomUUID(), correlationId,
    );

    const product = await productService.createProduct(
      TEST_USER_ID, tenantId, factoryId,
      {
        inventory_item_id: finished,
        product_code: `MTO-FG-${suffix}`,
        product_name: 'Make-to-order finished good',
        product_type: 'STANDARD',
        base_unit: 'PCS',
      },
      `mto-product-${suffix}`, randomUUID(), correlationId,
    );
    productId = product.product.id;

    const version = await productService.createVersion(
      TEST_USER_ID, tenantId, factoryId, productId!,
      {
        effective_from: currentDate,
        expected_yield_percent: 100,
        change_summary: 'Manufacturing GRN acceptance product revision',
      },
      `mto-version-${suffix}`, randomUUID(), correlationId,
    );
    productVersionId = version.version.id;

    await productService.replaceBom(
      TEST_USER_ID, tenantId, factoryId, productId!, productVersionId!,
      {
        expected_version: 1,
        lines: [{ line_number: 1, component_item_id: material, quantity_per: 1, unit: 'PCS', wastage_percent: 0 }],
      },
      randomUUID(), correlationId,
    );
    await productService.replaceRouting(
      TEST_USER_ID, tenantId, factoryId, productId!, productVersionId!,
      {
        expected_version: 2,
        steps: [{
          step_number: 1,
          operation_code: 'ASSEMBLE',
          operation_name: 'Assemble finished good',
          work_centre_id: workCentreId!,
          run_minutes_per_unit: 1,
          is_quality_gate: false,
        }],
      },
      randomUUID(), correlationId,
    );
    await productService.approveVersion(
      approvalUserId, tenantId, factoryId, productId!, productVersionId!,
      { expected_version: 3 },
      `mto-approve-${suffix}`, randomUUID(), correlationId,
    );

    const createdOrder = await ordersService.createOrder(
      TEST_USER_ID, tenantId,
      {
        factory_id: factoryId,
        order_number: `MTO-ORDER-${suffix}`,
        customer_name: 'Manufacturing acceptance customer',
        currency: 'BDT',
        lines: [{
          line_number: 1,
          product_code: `MTO-FG-${suffix}`,
          product_name: 'Make-to-order finished good',
          quantity: 4,
          unit: 'PCS',
          inventory_item_id: finished,
          unit_price: 0,
        }],
      },
      randomUUID(), correlationId, `mto-order-${suffix}`,
    );
    orderId = createdOrder.id;
    const orderLine = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM order_lines WHERE tenant_id = $1 AND factory_id = $2 AND order_id = $3',
      [tenantId, factoryId, orderId],
    );
    orderLineId = orderLine.rows[0]?.id ?? null;
    if (!orderLineId) throw new Error('Make-to-order line was not created');

    // Plan before confirmation so the confirmed order does not reserve finished stock
    // that does not exist yet. The work order's BOM is the raw-material reservation boundary.
    const planned = await productionService.createWorkOrder(
      TEST_USER_ID, tenantId, factoryId,
      { order_line_id: orderLineId!, target_quantity: 4, planned_start_date: currentDate, due_date: currentDate },
      `mto-work-order-${suffix}`, randomUUID(), correlationId,
    );
    workOrderId = planned.id;

    const confirmed = await ordersService.transitionOrderStatus(
      TEST_USER_ID, tenantId, orderId!, 'CONFIRMED', randomUUID(), correlationId, 1,
    );
    expect(confirmed.status).toBe('CONFIRMED');
    let state = await adminPool.query<{ status: string; reserved: string; reservation_count: string }>(`
      SELECT o.status,
        b.quantity_reserved::text AS reserved,
        (SELECT count(*)::text FROM inventory_reservations r
          WHERE r.tenant_id = ol.tenant_id AND r.factory_id = ol.factory_id
            AND r.reference_type = 'ORDER_LINE' AND r.reference_id = ol.id) AS reservation_count
      FROM orders o
      JOIN order_lines ol ON ol.order_id = o.id AND ol.tenant_id = o.tenant_id AND ol.factory_id = o.factory_id
      JOIN inventory_stock_balances b ON b.item_id = ol.inventory_item_id
        AND b.tenant_id = ol.tenant_id AND b.factory_id = ol.factory_id
      WHERE o.id = $1 AND o.tenant_id = $2 AND o.factory_id = $3
    `, [orderId, tenantId, factoryId]);
    expect(state.rows[0]).toEqual({ status: 'CONFIRMED', reserved: '0.0000', reservation_count: '0' });

    const inProgress = await ordersService.transitionOrderStatus(
      TEST_USER_ID, tenantId, orderId!, 'IN_PROGRESS', randomUUID(), correlationId,
      Number(confirmed.version),
    );
    expect(inProgress.status).toBe('IN_PROGRESS');

    const released = await productionService.transitionWorkOrder(
      TEST_USER_ID, tenantId, factoryId, workOrderId!, 'RELEASE',
      { expected_version: Number(planned.row_version) },
      `mto-release-${suffix}`, randomUUID(), correlationId,
    );
    expect(released.status).toBe('RELEASED');
    expect(released.materials).toHaveLength(1);
    expect(released.materials[0]?.required_quantity).toBe('4.0000');
    expect(released.materials[0]?.reservations).toHaveLength(1);

    const firstOperation = released.operations[0];
    if (!firstOperation) throw new Error('Released work order has no routing operation');
    const started = await productionService.reportOperationEvent(
      TEST_USER_ID, tenantId, factoryId, workOrderId!, firstOperation.id,
      {
        command: 'START',
        expected_work_order_version: Number(released.row_version),
        expected_operation_version: Number(firstOperation.row_version),
      },
      `mto-start-${suffix}`, randomUUID(), correlationId,
    );

    const outputKey = `mto-output-${suffix}`;
    const outputDto = {
      operation_id: firstOperation.id,
      expected_work_order_version: Number(started.row_version),
      expected_operation_version: Number(started.operations[0]?.row_version),
      good_quantity: 4,
      scrap_quantity: 0,
      notes: 'Accepted make-to-order output from the posted GRN material lot',
    };
    const output = await productionService.reportOutput(
      TEST_USER_ID, tenantId, factoryId, workOrderId!, outputDto,
      outputKey, randomUUID(), correlationId,
    );
    expect(output.good_quantity).toBe('4.0000');
    expect(output.finished_good_traceability_unit_id).toBeTruthy();
    outputReportId = output.production_report_id;
    outputLotId = output.finished_good_traceability_unit_id;

    const replay = await productionService.reportOutput(
      TEST_USER_ID, tenantId, factoryId, workOrderId!, outputDto,
      outputKey, randomUUID(), correlationId,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.production_report_id).toBe(output.production_report_id);
    expect(replay.production_output_posting_id).toBe(output.production_output_posting_id);

    const activeOperation = output.operations[0];
    if (!activeOperation) throw new Error('Output response has no routing operation');
    const operationCompleted = await productionService.reportOperationEvent(
      TEST_USER_ID, tenantId, factoryId, workOrderId!, activeOperation.id,
      {
        command: 'COMPLETE',
        expected_work_order_version: Number(output.row_version),
        expected_operation_version: Number(activeOperation.row_version),
      },
      `mto-operation-complete-${suffix}`, randomUUID(), correlationId,
    );
    const completed = await productionService.transitionWorkOrder(
      TEST_USER_ID, tenantId, factoryId, workOrderId!, 'COMPLETE',
      { expected_version: Number(operationCompleted.row_version) },
      `mto-complete-${suffix}`, randomUUID(), correlationId,
    );
    expect(completed.status).toBe('COMPLETED');

    const persisted = await adminPool.query<{
      order_status: string;
      work_order_status: string;
      receipt_status: string;
      receipt_quantity: string;
      lot_receipt_id: string;
      lot_receipt_line_id: string;
      source_stock: string;
      source_reserved: string;
      finished_stock: string;
      finished_lot_quantity: string;
      output_count: string;
      output_quantity: string;
      genealogy_count: string;
      genealogy_quantity: string;
      consumption_count: string;
      consumed_quantity: string;
      order_line_reservation_count: string;
    }>(`
      SELECT o.status AS order_status, wo.status AS work_order_status,
        gr.status AS receipt_status, grl.received_quantity::text AS receipt_quantity,
        source.goods_receipt_id::text AS lot_receipt_id,
        source.goods_receipt_line_id::text AS lot_receipt_line_id,
        material_balance.quantity_on_hand::text AS source_stock,
        material_balance.quantity_reserved::text AS source_reserved,
        finished_balance.quantity_on_hand::text AS finished_stock,
        output_lot.quantity::text AS finished_lot_quantity,
        (SELECT count(*)::text FROM production_output_postings p
          WHERE p.work_order_id = wo.id AND p.tenant_id = wo.tenant_id AND p.factory_id = wo.factory_id) AS output_count,
        (SELECT COALESCE(sum(p.good_quantity), 0)::text FROM production_output_postings p
          WHERE p.work_order_id = wo.id AND p.tenant_id = wo.tenant_id AND p.factory_id = wo.factory_id) AS output_quantity,
        (SELECT count(*)::text FROM product_genealogy_events g
          WHERE g.source_unit_id = source.id AND g.target_unit_id = output_lot.id
            AND g.tenant_id = wo.tenant_id AND g.factory_id = wo.factory_id
            AND g.relationship_type = 'CONSUMED_INTO') AS genealogy_count,
        (SELECT COALESCE(sum(g.quantity), 0)::text FROM product_genealogy_events g
          WHERE g.source_unit_id = source.id AND g.target_unit_id = output_lot.id
            AND g.tenant_id = wo.tenant_id AND g.factory_id = wo.factory_id
            AND g.relationship_type = 'CONSUMED_INTO') AS genealogy_quantity,
        (SELECT count(*)::text FROM inventory_reservation_consumptions c
          JOIN work_order_material_reservations mr ON mr.reservation_id = c.reservation_id
            AND mr.tenant_id = c.tenant_id AND mr.factory_id = c.factory_id
          WHERE mr.work_order_id = wo.id AND c.item_id = source.inventory_item_id
            AND c.tenant_id = wo.tenant_id AND c.factory_id = wo.factory_id) AS consumption_count,
        (SELECT COALESCE(sum(c.quantity), 0)::text FROM inventory_reservation_consumptions c
          JOIN work_order_material_reservations mr ON mr.reservation_id = c.reservation_id
            AND mr.tenant_id = c.tenant_id AND mr.factory_id = c.factory_id
          WHERE mr.work_order_id = wo.id AND c.item_id = source.inventory_item_id
            AND c.tenant_id = wo.tenant_id AND c.factory_id = wo.factory_id) AS consumed_quantity,
        (SELECT count(*)::text FROM inventory_reservations r
          WHERE r.tenant_id = ol.tenant_id AND r.factory_id = ol.factory_id
            AND r.reference_type = 'ORDER_LINE' AND r.reference_id = ol.id) AS order_line_reservation_count
      FROM orders o
      JOIN order_lines ol ON ol.order_id = o.id AND ol.tenant_id = o.tenant_id AND ol.factory_id = o.factory_id
      JOIN work_orders wo ON wo.source_order_id = o.id AND wo.source_order_line_id = ol.id
        AND wo.tenant_id = o.tenant_id AND wo.factory_id = o.factory_id
      JOIN goods_receipts gr ON gr.id = $4 AND gr.tenant_id = wo.tenant_id AND gr.factory_id = wo.factory_id
      JOIN goods_receipt_lines grl ON grl.id = $5 AND grl.goods_receipt_id = gr.id
        AND grl.tenant_id = gr.tenant_id AND grl.factory_id = gr.factory_id
      JOIN traceability_units source ON source.id = $6
        AND source.tenant_id = wo.tenant_id AND source.factory_id = wo.factory_id
      JOIN traceability_units output_lot ON output_lot.id = $7
        AND output_lot.tenant_id = wo.tenant_id AND output_lot.factory_id = wo.factory_id
      JOIN inventory_stock_balances material_balance ON material_balance.item_id = source.inventory_item_id
        AND material_balance.tenant_id = wo.tenant_id AND material_balance.factory_id = wo.factory_id
      JOIN inventory_stock_balances finished_balance ON finished_balance.item_id = wo.finished_item_id
        AND finished_balance.tenant_id = wo.tenant_id AND finished_balance.factory_id = wo.factory_id
      WHERE o.id = $1 AND wo.id = $2 AND ol.id = $3
        AND o.tenant_id = $8 AND o.factory_id = $9
    `, [
      orderId, workOrderId, orderLineId, receiptId, receiptLineId, sourceLotId,
      outputLotId, tenantId, factoryId,
    ]);

    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({
      order_status: 'IN_PROGRESS',
      work_order_status: 'COMPLETED',
      receipt_status: 'POSTED',
      receipt_quantity: '5.0000',
      lot_receipt_id: receiptId,
      lot_receipt_line_id: receiptLineId,
      source_stock: '1.0000',
      source_reserved: '0.0000',
      finished_stock: '4.0000',
      finished_lot_quantity: '4.0000',
      output_count: '1',
      output_quantity: '4.0000',
      genealogy_count: '1',
      genealogy_quantity: '4.0000',
      consumption_count: '1',
      consumed_quantity: '4.0000',
      order_line_reservation_count: '0',
    });
    expect(output.production_output_posting_id).toBeTruthy();
    expect(output.finished_good_movement_id).toBeTruthy();
    expect(operationCompleted.replayed).toBe(false);

    // The deferred completion guard has already run at COMMIT. Force any remaining
    // deferred fixture constraints while all identities are still visible.
  });

  async function seedPostedGrnMaterial(): Promise<void> {
    materialItemId = randomUUID();
    finishedItemId = randomUUID();
    supplierId = randomUUID();
    purchaseOrderId = randomUUID();
    purchaseOrderLineId = randomUUID();
    receiptId = randomUUID();
    sourceLotId = randomUUID();

    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', TEST_USER_ID]);
      await client.query('SELECT set_config($1, $2, true)', ['app.request_id', requestId]);
      await client.query('SELECT set_config($1, $2, true)', ['app.trace_id', correlationId]);

      await client.query(`
        INSERT INTO inventory_items (id, tenant_id, factory_id, sku, name, unit, status, created_by_user_id)
        VALUES ($1,$2,$3,$4,'GRN-sourced production material','PCS','ACTIVE',$5),
               ($6,$2,$3,$7,'Make-to-order finished good','PCS','ACTIVE',$5)
      `, [
        materialItemId, tenantId, factoryId, `MTO-MAT-${suffix}`, TEST_USER_ID,
        finishedItemId, `MTO-FG-${suffix}`,
      ]);
      await client.query(`
        INSERT INTO inventory_stock_balances (tenant_id, factory_id, item_id, quantity_on_hand, quantity_reserved)
        VALUES ($1,$2,$3,0,0),($1,$2,$4,0,0)
      `, [tenantId, factoryId, materialItemId, finishedItemId]);

      await client.query(`
        INSERT INTO suppliers (id, tenant_id, code, name, created_by_user_id)
        VALUES ($1,$2,$3,'Manufacturing acceptance supplier',$4)
      `, [supplierId, tenantId, `MTO-SUP-${suffix}`, TEST_USER_ID]);
      await client.query(`
        INSERT INTO purchase_orders (id,tenant_id,factory_id,supplier_id,po_number,status,created_by_user_id)
        VALUES ($1,$2,$3,$4,$5,'DRAFT',$6)
      `, [purchaseOrderId, tenantId, factoryId, supplierId, `MTO-PO-${suffix}`, TEST_USER_ID]);
      await client.query(`
        INSERT INTO purchase_order_lines (
          id,tenant_id,factory_id,purchase_order_id,line_number,inventory_item_id,
          description,quantity,unit,unit_price
        ) VALUES ($1,$2,$3,$4,1,$5,'Material consumed by the make-to-order fixture',5,'PCS',4)
      `, [purchaseOrderLineId, tenantId, factoryId, purchaseOrderId, materialItemId]);
      await client.query(`
        INSERT INTO purchase_order_status_history (
          tenant_id,factory_id,purchase_order_id,from_status,to_status,version,actor_user_id,reason
        ) VALUES ($1,$2,$3,NULL,'DRAFT',1,$4,'Create manufacturing integration purchase order')
      `, [tenantId, factoryId, purchaseOrderId, TEST_USER_ID]);

      await client.query(`
        UPDATE purchase_orders SET status='SUBMITTED',submitted_by_user_id=$1,
          submitted_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1
        WHERE id=$2 AND tenant_id=$3 AND factory_id=$4
      `, [TEST_USER_ID, purchaseOrderId, tenantId, factoryId]);
      await client.query(`
        INSERT INTO purchase_order_status_history (
          tenant_id,factory_id,purchase_order_id,from_status,to_status,version,actor_user_id,
          reason,request_id,trace_id
        ) VALUES ($1,$2,$3,'DRAFT','SUBMITTED',2,$4,'Submit manufacturing acceptance PO',$5,$6)
      `, [tenantId, factoryId, purchaseOrderId, TEST_USER_ID, requestId, correlationId]);

      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', approvalUserId]);
      await client.query(`
        UPDATE purchase_orders SET status='APPROVED',approved_by_user_id=$1,
          approved_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1
        WHERE id=$2 AND tenant_id=$3 AND factory_id=$4
      `, [approvalUserId, purchaseOrderId, tenantId, factoryId]);
      await client.query(`
        INSERT INTO purchase_order_status_history (
          tenant_id,factory_id,purchase_order_id,from_status,to_status,version,actor_user_id,
          reason,request_id,trace_id
        ) VALUES ($1,$2,$3,'SUBMITTED','APPROVED',3,$4,'Independently approve manufacturing acceptance PO',$5,$6)
      `, [tenantId, factoryId, purchaseOrderId, approvalUserId, requestId, correlationId]);

      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', TEST_USER_ID]);
      await client.query('SELECT set_config($1, $2, true)', ['app.inventory_location_id', defaultLocationId]);
      await client.query(`
        INSERT INTO goods_receipts (
          id,tenant_id,factory_id,purchase_order_id,location_id,receipt_number,status,
          supplier_delivery_reference,notes,created_by_user_id,idempotency_key,request_hash,
          request_id,trace_id,correlation_id
        ) VALUES ($1,$2,$3,$4,$5,$6,'POSTING',$7,
          'Posted GRN material used by the manufacturing acceptance', $8,$9,$10,$11,$12,$13)
      `, [
        receiptId, tenantId, factoryId, purchaseOrderId, defaultLocationId,
        `MTO-GRN-${suffix}`, `MTO-DELIVERY-${suffix}`, TEST_USER_ID,
        `mto-grn-${suffix}`, 'a'.repeat(64), requestId, correlationId, correlationId,
      ]);
      const receiptLine = await client.query<{ id: string }>(`
        INSERT INTO goods_receipt_lines (
          tenant_id,factory_id,goods_receipt_id,purchase_order_id,purchase_order_line_id,
          inventory_item_id,received_quantity,rejected_quantity
        ) VALUES ($1,$2,$3,$4,$5,$6,5,0)
        RETURNING id::text AS id
      `, [tenantId, factoryId, receiptId, purchaseOrderId, purchaseOrderLineId, materialItemId]);
      receiptLineId = receiptLine.rows[0]?.id ?? null;
      if (!receiptLineId) throw new Error('GRN line fixture was not created');
      await client.query(`
        UPDATE inventory_stock_balances
        SET quantity_on_hand=quantity_on_hand+5,version=version+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND factory_id=$2 AND item_id=$3
      `, [tenantId, factoryId, materialItemId]);
      await client.query(`
        INSERT INTO inventory_movements (
          tenant_id,factory_id,item_id,location_id,movement_type,quantity,quantity_delta,quantity_after,
          idempotency_key,request_hash,reference_type,reference_id,notes,created_by_user_id,correlation_id
        ) VALUES ($1,$2,$3,$4,'RECEIPT',5,5,5,$5,$6,'GOODS_RECEIPT',$7,
          'Accepted material receipt for make-to-order production',$8,$9)
      `, [
        tenantId, factoryId, materialItemId, defaultLocationId, `MTO-GRN-MOVE-${suffix}`,
        'b'.repeat(64), receiptId, approvalUserId, correlationId,
      ]);
      await client.query(`
        INSERT INTO audit_events (
          tenant_id,factory_id,actor_user_id,event_type,action,resource_type,resource_id,
          correlation_id,request_id,data_class,payload
        ) VALUES ($1,$2,$3,'PROCUREMENT','POSTED','GOODS_RECEIPT',$4,$5,$6,'INTERNAL',$7::jsonb)
      `, [
        tenantId, factoryId, approvalUserId, receiptId, correlationId, requestId,
        JSON.stringify({ accepted_quantity: 5, rejected_quantity: 0, purchase_order_id: purchaseOrderId }),
      ]);
      await client.query(`
        INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload,correlation_id)
        VALUES ($1,$2,'GOODS_RECEIPT',$3,'PROCUREMENT.GOODS_RECEIPT_POSTED',$4::jsonb,$5)
      `, [
        tenantId, factoryId, receiptId,
        JSON.stringify({ receipt_id: receiptId, accepted_quantity: 5, rejected_quantity: 0 }),
        correlationId,
      ]);
      await client.query(`
        UPDATE goods_receipts SET status='POSTED',posted_at=clock_timestamp()
        WHERE id=$1 AND tenant_id=$2 AND factory_id=$3
      `, [receiptId, tenantId, factoryId]);

      await client.query(`
        INSERT INTO traceability_units (
          id,tenant_id,factory_id,unit_type,product_role,unit_code,barcode_value,inventory_item_id,
          quantity,unit,supplier_id,goods_receipt_id,goods_receipt_line_id,
          external_reference,status,attributes,idempotency_key,request_hash,version,
          created_by_user_id,correlation_id
        ) VALUES ($1,$2,$3,'LOT','MATERIAL',$4,$5,$6,5,'PCS',$7,$8,$9,$10,'ACTIVE',$11::jsonb,$12,$13,1,$14,$15)
      `, [
        sourceLotId, tenantId, factoryId, `MTO-SOURCE-${suffix}`, `MTO-SOURCE-BAR-${suffix}`,
        materialItemId, supplierId, receiptId, receiptLineId,
        `mto-grn-lot-${suffix}`, JSON.stringify({ origin: 'posted-grn', fixture: 'make-to-order-production' }),
        `mto-source-lot-${suffix}`, 'c'.repeat(64), TEST_USER_ID, correlationId,
      ]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function seedWorkCentreAndPickingBin(): Promise<void> {
    warehouseId = randomUUID();
    binId = randomUUID();
    workCentreId = randomUUID();
    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', TEST_USER_ID]);
      await client.query(`
        INSERT INTO inventory_locations (
          id,tenant_id,factory_id,location_code,name,location_type,
          putaway_enabled,picking_enabled,created_by_user_id
        ) VALUES ($1,$2,$3,$4,'MTO acceptance warehouse','WAREHOUSE',FALSE,FALSE,$5)
      `, [warehouseId, tenantId, factoryId, `MTO-WH-${suffix}`, TEST_USER_ID]);
      await client.query(`
        INSERT INTO inventory_locations (
          id,tenant_id,factory_id,parent_location_id,location_code,name,location_type,
          putaway_enabled,picking_enabled,created_by_user_id
        ) VALUES ($1,$2,$3,$4,$5,'MTO acceptance pick bin','BIN',TRUE,TRUE,$6)
      `, [binId, tenantId, factoryId, warehouseId, `MTO-BIN-${suffix}`, TEST_USER_ID]);
      await client.query(`
        INSERT INTO manufacturing_work_centres (
          id,tenant_id,factory_id,code,name,status,capacity_units_per_hour,version,
          idempotency_key,request_hash,created_by_user_id,updated_by_user_id
        ) VALUES ($1,$2,$3,$4,'MTO acceptance assembly centre','ACTIVE',100,1,$5,$6,$7,$7)
      `, [workCentreId, tenantId, factoryId, `MTO-WC-${suffix}`, `mto-wc-${suffix}`, 'd'.repeat(64), TEST_USER_ID]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
});
