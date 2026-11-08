import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { AuditService } from '../audit/audit.service';
import { createIntegrationDatabase } from '../database/integration-database.adapter';
import { InventoryLocationService } from '../inventory/inventory.location.service';
import { InventoryReservationService } from '../inventory/inventory.reservation.service';
import { TraceabilityService } from '../inventory/traceability.service';
import { ProductionWorkOrdersService } from './production-work-orders.service';

const TEST_USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TARGET_QUANTITY = 3;

type OperationState = {
  id: string;
  step_number: number;
  operation_code: string;
  status: string;
  row_version: number;
  wip_quantity: string;
};

type WorkOrderState = {
  id: string;
  status: string;
  row_version: number;
  operations: OperationState[];
};

describe('ProductionWorkOrdersService three-step PostgreSQL lifecycle', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let service: ProductionWorkOrdersService;
  let locationService: InventoryLocationService;
  let traceabilityService: TraceabilityService;
  let tenantId: string;
  let factoryId: string;
  let approverUserId: string;

  const inventoryItemIds: string[] = [];
  const productIds: string[] = [];
  const productVersionIds: string[] = [];
  const workCentreIds: string[] = [];
  const routingStepIds: string[] = [];
  const orderIds: string[] = [];
  const warehouseIds: string[] = [];
  const binIds: string[] = [];
  const workOrderIds: string[] = [];

  const audit = { record: async () => undefined } as unknown as AuditService;

  const createItem = async (name: string, quantityOnHand: string): Promise<string> => {
    const result = await adminPool.query<{ id: string }>(
      'INSERT INTO inventory_items (tenant_id, factory_id, sku, name, unit, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text AS id',
      [tenantId, factoryId, 'WO-MULTI-' + randomUUID(), name, 'PCS', TEST_USER_ID],
    );
    const itemId = result.rows[0]?.id;
    if (!itemId) throw new Error('Multi-operation inventory item fixture was not created');
    inventoryItemIds.push(itemId);
    await adminPool.query(
      'INSERT INTO inventory_stock_balances (tenant_id, factory_id, item_id, quantity_on_hand, quantity_reserved) VALUES ($1, $2, $3, $4::numeric, 0)',
      [tenantId, factoryId, itemId, quantityOnHand],
    );
    return itemId;
  };

  const createComponentBin = async (componentItemId: string, quantity: number = 10): Promise<string> => {
    const suffix = randomUUID().slice(0, 8);
    const warehouse = await adminPool.query<{ id: string }>(
      "INSERT INTO inventory_locations (tenant_id, factory_id, location_code, name, location_type, putaway_enabled, picking_enabled, created_by_user_id) VALUES ($1, $2, $3, $4, 'WAREHOUSE', FALSE, FALSE, $5) RETURNING id::text AS id",
      [tenantId, factoryId, 'WO-MULTI-WH-' + suffix, 'Multi-operation integration warehouse', TEST_USER_ID],
    );
    const warehouseId = warehouse.rows[0]?.id;
    if (!warehouseId) throw new Error('Multi-operation warehouse fixture was not created');
    warehouseIds.push(warehouseId);

    const bin = await adminPool.query<{ id: string }>(
      "INSERT INTO inventory_locations (tenant_id, factory_id, parent_location_id, location_code, name, location_type, putaway_enabled, picking_enabled, created_by_user_id) VALUES ($1, $2, $3, $4, $5, 'BIN', TRUE, TRUE, $6) RETURNING id::text AS id",
      [tenantId, factoryId, warehouseId, 'WO-MULTI-BIN-' + suffix, 'Multi-operation picking bin', TEST_USER_ID],
    );
    const binId = bin.rows[0]?.id;
    if (!binId) throw new Error('Multi-operation bin fixture was not created');
    binIds.push(binId);

    const defaultLocation = await adminPool.query<{ id: string }>(
      "SELECT id::text AS id FROM inventory_locations WHERE tenant_id=$1 AND factory_id=$2 AND is_default=TRUE AND status='ACTIVE' LIMIT 1",
      [tenantId, factoryId],
    );
    const unassignedId = defaultLocation.rows[0]?.id;
    if (!unassignedId) throw new Error('Factory UNASSIGNED location is missing');

    await locationService.transferStock(
      TEST_USER_ID,
      tenantId,
      factoryId,
      componentItemId,
      {
        movement_purpose: 'PUT_AWAY',
        source_location_id: unassignedId,
        destination_location_id: binId,
        quantity,
      },
      'wo-multi-putaway-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );
    return binId;
  };

  const createProductRevisionAndRouting = async (
    finishedItemId: string,
    componentItemId: string,
  ): Promise<{ productId: string; versionId: string }> => {
    const productId = randomUUID();
    const versionId = randomUUID();
    const workCentreId = randomUUID();
    const bomLineId = randomUUID();
    productIds.push(productId);
    productVersionIds.push(versionId);
    workCentreIds.push(workCentreId);

    await adminPool.query(
      "INSERT INTO product_definitions (id, tenant_id, factory_id, inventory_item_id, product_code, product_name, product_type, base_unit, status, version, created_by_user_id, updated_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, 'STANDARD', 'PCS', 'ACTIVE', 1, $7, $7)",
      [productId, tenantId, factoryId, finishedItemId, 'WO-MULTI-PRODUCT-' + randomUUID(), 'Three-step lifecycle finished good', TEST_USER_ID],
    );

    await adminPool.query(
      "INSERT INTO product_versions (id, tenant_id, factory_id, product_id, version_number, state, effective_from, expected_yield_percent, change_summary, row_version, idempotency_key, request_hash, created_by_user_id, updated_by_user_id) VALUES ($1, $2, $3, $4, 1, 'DRAFT', DATE '2020-01-01', 100, 'Three-step manufacturing integration fixture', 1, $5, repeat('a', 64), $6, $6)",
      [versionId, tenantId, factoryId, productId, 'wo-multi-version-' + randomUUID(), TEST_USER_ID],
    );

    await adminPool.query(
      "INSERT INTO manufacturing_work_centres (id, tenant_id, factory_id, code, name, status, version, idempotency_key, request_hash, created_by_user_id, updated_by_user_id) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 1, $6, repeat('b', 64), $7, $7)",
      [workCentreId, tenantId, factoryId, 'WO-MULTI-CENTRE-' + randomUUID().slice(0, 8), 'Three-step integration work centre', 'wo-multi-centre-' + randomUUID(), TEST_USER_ID],
    );

    await adminPool.query(
      "INSERT INTO product_bom_lines (id, tenant_id, factory_id, product_id, product_version_id, line_number, component_item_id, quantity_per, unit, wastage_percent, created_by_user_id, inventory_base_unit, base_quantity_per, uom_factor_numerator, uom_factor_denominator, uom_rounding_mode) VALUES ($1, $2, $3, $4, $5, 1, $6, 1, 'PCS', 0, $7, 'PCS', 1, 1, 1, 'REJECT')",
      [bomLineId, tenantId, factoryId, productId, versionId, componentItemId, TEST_USER_ID],
    );

    const routeNames = [
      { code: 'CUT', name: 'Cutting' },
      { code: 'ASSEMBLE', name: 'Assembly' },
      { code: 'FINISH', name: 'Finishing' },
    ];
    for (let index = 0; index < routeNames.length; index += 1) {
      const routeId = randomUUID();
      routingStepIds.push(routeId);
      const route = routeNames[index];
      if (!route) throw new Error('Missing route fixture definition');
      await adminPool.query(
        "INSERT INTO product_routing_steps (id, tenant_id, factory_id, product_id, product_version_id, step_number, operation_code, operation_name, work_centre_id, setup_minutes, run_minutes_per_unit, queue_minutes, transfer_minutes, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 1, 1, 1, $10)",
        [routeId, tenantId, factoryId, productId, versionId, index + 1, route.code, route.name, workCentreId, TEST_USER_ID],
      );
    }

    await adminPool.query(
      "UPDATE product_versions SET state='APPROVED', row_version=row_version+1, approved_by_user_id=$1, approved_at=clock_timestamp(), approval_idempotency_key=$2, approval_request_hash=repeat('c', 64), updated_at=clock_timestamp() WHERE id=$3 AND tenant_id=$4 AND factory_id=$5",
      [approverUserId, 'wo-multi-approval-' + randomUUID(), versionId, tenantId, factoryId],
    );

    return { productId, versionId };
  };

  const readState = async (workOrderId: string): Promise<WorkOrderState> => {
    const workOrder = await adminPool.query<{ id: string; status: string; row_version: number }>(
      'SELECT id::text AS id, status, row_version::int AS row_version FROM work_orders WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
      [workOrderId, tenantId, factoryId],
    );
    const row = workOrder.rows[0];
    if (!row) throw new Error('Multi-operation work order disappeared during the integration scenario');
    const operations = await adminPool.query<OperationState>(
      'SELECT id::text AS id, step_number, operation_code, status, row_version::int AS row_version, wip_quantity::text AS wip_quantity FROM work_order_operations WHERE work_order_id=$1 AND tenant_id=$2 AND factory_id=$3 ORDER BY step_number',
      [workOrderId, tenantId, factoryId],
    );
    return { ...row, operations: operations.rows };
  };

  const sendOperationEvent = async (
    workOrderId: string,
    operationId: string,
    input: { command: string; quantity?: number; target_operation_id?: string; reason?: string },
    idempotencyKey: string,
    expected?: { workOrderVersion: number; operationVersion: number },
  ) => {
    const state = await readState(workOrderId);
    const operation = state.operations.find((entry) => entry.id === operationId);
    if (!operation) throw new Error('Operation fixture was not found');
    return service.reportOperationEvent(
      TEST_USER_ID,
      tenantId,
      factoryId,
      workOrderId,
      operationId,
      {
        ...input,
        expected_work_order_version: expected?.workOrderVersion ?? state.row_version,
        expected_operation_version: expected?.operationVersion ?? operation.row_version,
      } as never,
      idempotencyKey,
      randomUUID(),
      randomUUID(),
    );
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
    if (!first) throw new Error('No active tenant/factory is available for production integration tests');
    tenantId = first.tenant_id;
    factoryId = first.factory_id;

    const actor = await adminPool.query('SELECT 1 FROM users WHERE id=$1', [TEST_USER_ID]);
    if (actor.rowCount !== 1) throw new Error('Multi-operation integration actor is missing');
    const approver = await adminPool.query<{ id: string }>(
      'SELECT id::text AS id FROM users WHERE id <> $1 ORDER BY created_at, id LIMIT 1',
      [TEST_USER_ID],
    );
    if (!approver.rows[0]) throw new Error('An independent product-version approver is required for this integration fixture');
    approverUserId = approver.rows[0].id;

    const database = createIntegrationDatabase(appPool);
    const inventory = new InventoryReservationService(database as never, audit);
    locationService = new InventoryLocationService(database as never, audit);
    service = new ProductionWorkOrdersService(database as never, audit, inventory);
    traceabilityService = new TraceabilityService(database as never);
  });

  afterAll(async () => {
    if (!adminPool) return;
    const mutableTables = [
      'product_genealogy_events',
      'production_output_postings',
      'order_production_reports',
      'traceability_unit_status_events',
      'inventory_traceability_location_balances',
      'traceability_units',
      'work_order_events',
      'work_order_operations',
      'work_order_material_reservations',
      'work_order_material_requirements',
      'work_orders',
      'inventory_reservation_consumption_traceability_allocations',
      'inventory_reservation_consumptions',
      'inventory_reservation_traceability_allocations',
      'inventory_reservations',
      'inventory_movements',
      'inventory_location_transfers',
      'inventory_location_balances',
      'inventory_stock_balances',
      'product_routing_steps',
      'product_bom_lines',
      'product_versions',
      'product_definitions',
      'manufacturing_work_centres',
    ];
    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');
      for (const table of mutableTables) {
        await client.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER');
      }

      if (workOrderIds.length > 0) {
        const reservationRows = await client.query<{ id: string }>(
          "SELECT id::text AS id FROM inventory_reservations WHERE reference_type='WORK_ORDER_MATERIAL' AND reference_id = ANY($1::uuid[])",
          [workOrderIds],
        );
        const reservationIds = reservationRows.rows.map((row) => row.id);
        if (reservationIds.length > 0) {
          await client.query(
            'DELETE FROM inventory_reservation_consumption_traceability_allocations WHERE tenant_id=$1 AND factory_id=$2 AND consumption_id IN (SELECT id FROM inventory_reservation_consumptions WHERE reservation_id = ANY($3::uuid[]))',
            [tenantId, factoryId, reservationIds],
          );
          await client.query(
            'DELETE FROM inventory_reservation_consumptions WHERE reservation_id = ANY($1::uuid[])',
            [reservationIds],
          );
          await client.query(
            'DELETE FROM inventory_reservation_traceability_allocations WHERE reservation_id = ANY($1::uuid[])',
            [reservationIds],
          );
          await client.query(
            'DELETE FROM work_order_material_reservations WHERE reservation_id = ANY($1::uuid[])',
            [reservationIds],
          );
          await client.query('DELETE FROM inventory_reservations WHERE id = ANY($1::uuid[])', [reservationIds]);
        }
        await client.query(
          `DELETE FROM outbox_events
           WHERE aggregate_type='PRODUCT_GENEALOGY_EVENT'
             AND aggregate_id IN (
               SELECT id FROM product_genealogy_events
               WHERE tenant_id=$1 AND factory_id=$2
                 AND (source_unit_id IN (
                   SELECT id FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2
                     AND inventory_item_id = ANY($3::uuid[])
                 ) OR target_unit_id IN (
                   SELECT id FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2
                     AND inventory_item_id = ANY($3::uuid[])
                 ))
             )`,
          [tenantId, factoryId, inventoryItemIds],
        );
        await client.query(
          `DELETE FROM product_genealogy_events
           WHERE tenant_id=$1 AND factory_id=$2
             AND (source_unit_id IN (
               SELECT id FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2
                 AND inventory_item_id = ANY($3::uuid[])
             ) OR target_unit_id IN (
               SELECT id FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2
                 AND inventory_item_id = ANY($3::uuid[])
             ))`,
          [tenantId, factoryId, inventoryItemIds],
        );
        await client.query('DELETE FROM production_output_postings WHERE tenant_id=$1 AND factory_id=$2 AND work_order_id = ANY($3::uuid[])', [tenantId, factoryId, workOrderIds]);
        await client.query(
          'DELETE FROM traceability_unit_status_events WHERE tenant_id=$1 AND factory_id=$2 AND unit_id IN (SELECT id FROM traceability_units WHERE inventory_item_id = ANY($3::uuid[]))',
          [tenantId, factoryId, inventoryItemIds],
        );
        await client.query('DELETE FROM inventory_traceability_location_balances WHERE tenant_id=$1 AND factory_id=$2 AND item_id = ANY($3::uuid[])', [tenantId, factoryId, inventoryItemIds]);
        await client.query(
          'DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2 AND inventory_item_id = ANY($3::uuid[]))',
          [tenantId, factoryId, inventoryItemIds],
        );
        await client.query('DELETE FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2 AND inventory_item_id = ANY($3::uuid[])', [tenantId, factoryId, inventoryItemIds]);
        await client.query('DELETE FROM order_production_reports WHERE tenant_id=$1 AND factory_id=$2 AND work_order_id = ANY($3::uuid[])', [tenantId, factoryId, workOrderIds]);
        await client.query('DELETE FROM work_order_events WHERE work_order_id = ANY($1::uuid[])', [workOrderIds]);
        await client.query('DELETE FROM work_order_operations WHERE work_order_id = ANY($1::uuid[])', [workOrderIds]);
        await client.query('DELETE FROM work_order_material_reservations WHERE work_order_id = ANY($1::uuid[])', [workOrderIds]);
        await client.query('DELETE FROM work_order_material_requirements WHERE work_order_id = ANY($1::uuid[])', [workOrderIds]);
        await client.query('DELETE FROM work_orders WHERE id = ANY($1::uuid[])', [workOrderIds]);
      }

      if (inventoryItemIds.length > 0) {
        await client.query('DELETE FROM inventory_reservation_consumption_traceability_allocations WHERE tenant_id=$1 AND factory_id=$2 AND consumption_id IN (SELECT id FROM inventory_reservation_consumptions WHERE item_id = ANY($3::uuid[]))', [tenantId, factoryId, inventoryItemIds]);
        await client.query('DELETE FROM inventory_reservation_consumptions WHERE item_id = ANY($1::uuid[])', [inventoryItemIds]);
        await client.query('DELETE FROM inventory_reservation_traceability_allocations WHERE item_id = ANY($1::uuid[])', [inventoryItemIds]);
        await client.query(
          `DELETE FROM outbox_events
           WHERE aggregate_type='PRODUCT_GENEALOGY_EVENT'
             AND aggregate_id IN (
               SELECT id FROM product_genealogy_events
               WHERE tenant_id=$1 AND factory_id=$2
                 AND (source_unit_id IN (
                   SELECT id FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2
                     AND inventory_item_id = ANY($3::uuid[])
                 ) OR target_unit_id IN (
                   SELECT id FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2
                     AND inventory_item_id = ANY($3::uuid[])
                 ))
             )`,
          [tenantId, factoryId, inventoryItemIds],
        );
        await client.query(
          `DELETE FROM product_genealogy_events
           WHERE tenant_id=$1 AND factory_id=$2
             AND (source_unit_id IN (
               SELECT id FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2
                 AND inventory_item_id = ANY($3::uuid[])
             ) OR target_unit_id IN (
               SELECT id FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2
                 AND inventory_item_id = ANY($3::uuid[])
             ))`,
          [tenantId, factoryId, inventoryItemIds],
        );
        await client.query(
          'DELETE FROM traceability_unit_status_events WHERE tenant_id=$1 AND factory_id=$2 AND unit_id IN (SELECT id FROM traceability_units WHERE inventory_item_id = ANY($3::uuid[]))',
          [tenantId, factoryId, inventoryItemIds],
        );
        await client.query('DELETE FROM inventory_traceability_location_balances WHERE tenant_id=$1 AND factory_id=$2 AND item_id = ANY($3::uuid[])', [tenantId, factoryId, inventoryItemIds]);
        await client.query(
          'DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2 AND inventory_item_id = ANY($3::uuid[]))',
          [tenantId, factoryId, inventoryItemIds],
        );
        await client.query('DELETE FROM traceability_units WHERE tenant_id=$1 AND factory_id=$2 AND inventory_item_id = ANY($3::uuid[])', [tenantId, factoryId, inventoryItemIds]);
        await client.query('DELETE FROM inventory_location_transfers WHERE item_id = ANY($1::uuid[])', [inventoryItemIds]);
        await client.query('DELETE FROM inventory_movements WHERE item_id = ANY($1::uuid[])', [inventoryItemIds]);
        await client.query('DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])', [inventoryItemIds]);
        await client.query('DELETE FROM inventory_location_balances WHERE item_id = ANY($1::uuid[])', [inventoryItemIds]);
        await client.query('DELETE FROM inventory_stock_balances WHERE item_id = ANY($1::uuid[])', [inventoryItemIds]);
      }

      if (warehouseIds.length > 0) {
        await client.query('DELETE FROM inventory_locations WHERE id = ANY($1::uuid[])', [binIds]);
        await client.query('DELETE FROM inventory_locations WHERE id = ANY($1::uuid[])', [warehouseIds]);
      }
      if (orderIds.length > 0) {
        await client.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [orderIds]);
      }
      if (routingStepIds.length > 0) {
        await client.query('DELETE FROM product_routing_steps WHERE id = ANY($1::uuid[])', [routingStepIds]);
      }
      if (productVersionIds.length > 0) {
        await client.query('DELETE FROM product_bom_lines WHERE product_version_id = ANY($1::uuid[])', [productVersionIds]);
        await client.query('DELETE FROM product_versions WHERE id = ANY($1::uuid[])', [productVersionIds]);
      }
      if (productIds.length > 0) {
        await client.query('DELETE FROM product_definitions WHERE id = ANY($1::uuid[])', [productIds]);
      }
      if (workCentreIds.length > 0) {
        await client.query('DELETE FROM manufacturing_work_centres WHERE id = ANY($1::uuid[])', [workCentreIds]);
      }
      if (inventoryItemIds.length > 0) {
        await client.query('DELETE FROM inventory_items WHERE id = ANY($1::uuid[])', [inventoryItemIds]);
      }
      const outboxAggregateIds = [...workOrderIds, ...orderIds, ...productIds, ...productVersionIds, ...workCentreIds, ...routingStepIds, ...warehouseIds, ...binIds];
      if (outboxAggregateIds.length > 0) {
        await client.query('DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])', [outboxAggregateIds]);
      }

      for (const table of mutableTables) {
        await client.query('ALTER TABLE ' + table + ' ENABLE TRIGGER USER');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      if (appPool) await appPool.end();
      await adminPool.end();
    }
  });

  it('completes a three-operation work order with tracked LOT output, conserved WIP and material genealogy', async () => {
    const finishedItemId = await createItem('Three-step finished good', '0.0000');
    const componentItemId = await createItem('Three-step BOM component', '10.0000');
    const componentBinId = await createComponentBin(componentItemId);
    const materialLot = await traceabilityService.createUnit(
      TEST_USER_ID,
      tenantId,
      factoryId,
      {
        unit_type: 'LOT',
        product_role: 'MATERIAL',
        unit_code: 'WO-MULTI-MATERIAL-' + randomUUID().slice(0, 8),
        inventory_item_id: componentItemId,
        quantity: 10,
        unit: 'PCS',
        external_reference: 'three-step-final-output-genealogy',
      } as never,
      'wo-multi-material-lot-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );
    await adminPool.query(
      `INSERT INTO inventory_traceability_location_balances
         (tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand)
       VALUES ($1, $2, $3, $4, $5, 10.0000)`,
      [tenantId, factoryId, componentItemId, materialLot.id, componentBinId],
    );
    await createProductRevisionAndRouting(finishedItemId, componentItemId);

    const orderResult = await adminPool.query<{ id: string; line_id: string }>(
      "WITH created_order AS (INSERT INTO orders (tenant_id, factory_id, order_number, status, order_date, currency, created_by_user_id) VALUES ($1, $2, $3, 'IN_PROGRESS', CURRENT_DATE, 'BDT', $4) RETURNING id) INSERT INTO order_lines (tenant_id, factory_id, order_id, line_number, product_code, product_name, quantity, unit, inventory_item_id) SELECT $1, $2, id, 1, 'WO-MULTI-FG', 'Three-step finished good', $5::numeric, 'PCS', $6 FROM created_order RETURNING order_id::text AS id, id::text AS line_id",
      [tenantId, factoryId, 'WO-MULTI-ORDER-' + randomUUID(), TEST_USER_ID, TARGET_QUANTITY, finishedItemId],
    );
    const orderId = orderResult.rows[0]?.id;
    const orderLineId = orderResult.rows[0]?.line_id;
    if (!orderId || !orderLineId) throw new Error('Multi-operation source order fixture was not created');
    orderIds.push(orderId);

    const draft = await service.createWorkOrder(
      TEST_USER_ID,
      tenantId,
      factoryId,
      { order_line_id: orderLineId, target_quantity: TARGET_QUANTITY },
      'wo-multi-create-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );
    workOrderIds.push(draft.id);

    const beforeReleaseRadar = await service.getMaterialShortageRadar(TEST_USER_ID, tenantId, factoryId, 100);
    const beforeReleaseMaterial = (beforeReleaseRadar.items as Array<Record<string, unknown>>)
      .find((entry) => entry.work_order_id === draft.id && entry.component_item_id === componentItemId);
    expect(beforeReleaseMaterial).toMatchObject({
      required_quantity: '3.0000',
      allocated_quantity: '0.0000',
      consumed_quantity: '0.0000',
      eligible_on_hand_pool_quantity: '10.0000',
      projected_on_hand_quantity: '3.0000',
      projected_incoming_quantity: '0.0000',
      projected_shortage_quantity: '0.0000',
    });

    const released = await service.transitionWorkOrder(
      TEST_USER_ID,
      tenantId,
      factoryId,
      draft.id,
      'RELEASE',
      { expected_version: draft.row_version },
      'wo-multi-release-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );
    expect(released.status).toBe('RELEASED');

    const afterReleaseRadar = await service.getMaterialShortageRadar(TEST_USER_ID, tenantId, factoryId, 100);
    const afterReleaseMaterial = (afterReleaseRadar.items as Array<Record<string, unknown>>)
      .find((entry) => entry.work_order_id === draft.id && entry.component_item_id === componentItemId);
    expect(afterReleaseMaterial).toMatchObject({
      allocated_quantity: '3.0000',
      consumed_quantity: '0.0000',
      unfulfilled_quantity: '0.0000',
      projected_on_hand_quantity: '0.0000',
      projected_shortage_quantity: '0.0000',
    });

    const initial = await readState(draft.id);
    expect(initial.operations.map((operation) => operation.status)).toEqual(['READY', 'PLANNED', 'PLANNED']);
    const [first, second, third] = initial.operations;
    if (!first || !second || !third) throw new Error('Three-step routing snapshot was incomplete');

    await sendOperationEvent(draft.id, first.id, { command: 'START' }, 'wo-multi-start-1-' + randomUUID());
    await sendOperationEvent(draft.id, first.id, { command: 'WIP_REPORTED', quantity: TARGET_QUANTITY }, 'wo-multi-wip-1-' + randomUUID());

    await expect(
      sendOperationEvent(
        draft.id,
        first.id,
        { command: 'WIP_REPORTED', quantity: TARGET_QUANTITY + 1 },
        'wo-multi-wip-over-target-' + randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    await expect(
      sendOperationEvent(
        draft.id,
        second.id,
        { command: 'SKIP', reason: 'Cannot bypass an unfinished predecessor' },
        'wo-multi-skip-predecessor-' + randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const transferState = await readState(draft.id);
    const firstTransferDto = {
      command: 'WIP_TRANSFERRED',
      quantity: TARGET_QUANTITY,
      target_operation_id: third.id,
      expected_work_order_version: transferState.row_version,
      expected_operation_version: transferState.operations[0]!.row_version,
    };
    await expect(
      service.reportOperationEvent(
        TEST_USER_ID,
        tenantId,
        factoryId,
        draft.id,
        first.id,
        firstTransferDto as never,
        'wo-multi-invalid-skip-transfer-' + randomUUID(),
        randomUUID(),
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const validTransferDto = {
      ...firstTransferDto,
      target_operation_id: second.id,
    };
    const transferKey = 'wo-multi-transfer-1-' + randomUUID();
    const transfer = await service.reportOperationEvent(
      TEST_USER_ID,
      tenantId,
      factoryId,
      draft.id,
      first.id,
      validTransferDto as never,
      transferKey,
      randomUUID(),
      randomUUID(),
    );
    expect(transfer.replayed).toBe(false);
    const replay = await service.reportOperationEvent(
      TEST_USER_ID,
      tenantId,
      factoryId,
      draft.id,
      first.id,
      validTransferDto as never,
      transferKey,
      randomUUID(),
      randomUUID(),
    );
    expect(replay.replayed).toBe(true);

    await sendOperationEvent(draft.id, first.id, { command: 'COMPLETE' }, 'wo-multi-complete-1-' + randomUUID());
    let state = await readState(draft.id);
    expect(state.operations.map((operation) => operation.status)).toEqual(['COMPLETED', 'READY', 'PLANNED']);
    expect(state.operations.map((operation) => operation.wip_quantity)).toEqual(['0.0000', '3.0000', '0.0000']);

    await sendOperationEvent(draft.id, second.id, { command: 'START' }, 'wo-multi-start-2-' + randomUUID());
    await sendOperationEvent(
      draft.id,
      second.id,
      { command: 'WIP_TRANSFERRED', quantity: TARGET_QUANTITY, target_operation_id: third.id },
      'wo-multi-transfer-2-' + randomUUID(),
    );
    await sendOperationEvent(draft.id, second.id, { command: 'COMPLETE' }, 'wo-multi-complete-2-' + randomUUID());
    state = await readState(draft.id);
    expect(state.operations.map((operation) => operation.status)).toEqual(['COMPLETED', 'COMPLETED', 'READY']);
    expect(state.operations.map((operation) => operation.wip_quantity)).toEqual(['0.0000', '0.0000', '3.0000']);

    await sendOperationEvent(draft.id, third.id, { command: 'START' }, 'wo-multi-start-3-' + randomUUID());
    await sendOperationEvent(draft.id, third.id, { command: 'WIP_REPORTED', quantity: TARGET_QUANTITY }, 'wo-multi-wip-3-' + randomUUID());
    state = await readState(draft.id);

    expect(state.status).toBe('IN_PROGRESS');
    expect(state.operations.map((operation) => operation.status)).toEqual(['COMPLETED', 'COMPLETED', 'IN_PROGRESS']);
    expect(state.operations.map((operation) => operation.wip_quantity)).toEqual(['0.0000', '0.0000', '3.0000']);

    const outputState = await readState(draft.id);
    const finalOperation = outputState.operations[2];
    if (!finalOperation) throw new Error('Final operation was not found');
    const outputInput = {
      operation_id: finalOperation.id,
      expected_work_order_version: outputState.row_version,
      expected_operation_version: finalOperation.row_version,
      good_quantity: TARGET_QUANTITY,
      scrap_quantity: 0,
      notes: 'Three-step final finished-good output',
    };
    const outputKey = 'wo-multi-final-output-' + randomUUID();
    const outputAttempts = await Promise.all([
      service.reportOutput(
        TEST_USER_ID, tenantId, factoryId, draft.id,
        outputInput as never, outputKey, randomUUID(), randomUUID(),
      ),
      service.reportOutput(
        TEST_USER_ID, tenantId, factoryId, draft.id,
        outputInput as never, outputKey, randomUUID(), randomUUID(),
      ),
    ]);
    expect(outputAttempts.map((attempt) => attempt.replayed).sort()).toEqual([false, true]);
    expect(new Set(outputAttempts.map((attempt) => attempt.production_report_id)).size).toBe(1);
    expect(new Set(outputAttempts.map((attempt) => attempt.production_output_posting_id)).size).toBe(1);
    const output = outputAttempts.find((attempt) => !attempt.replayed);
    if (!output?.finished_good_traceability_unit_id || !output.production_output_posting_id || !output.production_report_id) {
      throw new Error('Final output did not produce its canonical report, posting and finished-good identity');
    }

    await sendOperationEvent(
      draft.id, third.id, { command: 'WIP_REPORTED', quantity: 0 },
      'wo-multi-final-wip-zero-' + randomUUID(),
    );
    await sendOperationEvent(
      draft.id, third.id, { command: 'COMPLETE' },
      'wo-multi-final-operation-complete-' + randomUUID(),
    );
    state = await readState(draft.id);
    expect(state.operations.map((operation) => operation.status)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED']);
    expect(state.operations.map((operation) => operation.wip_quantity)).toEqual(['0.0000', '0.0000', '0.0000']);

    const completed = await service.transitionWorkOrder(
      TEST_USER_ID, tenantId, factoryId, draft.id, 'COMPLETE',
      { expected_version: state.row_version } as never,
      'wo-multi-final-work-order-complete-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );
    expect(completed.status).toBe('COMPLETED');

    const persisted = await adminPool.query<{
      work_order_status: string;
      reservation_status: string;
      reserved_quantity: string;
      material_on_hand: string;
      material_reserved: string;
      material_bin_on_hand: string;
      material_bin_reserved: string;
      material_lot_on_hand: string;
      material_lot_reserved: string;
      finished_on_hand: string;
      report_count: string;
      output_count: string;
      output_quantity: string;
      consumption_count: string;
      consumed_quantity: string;
      consumption_allocation_count: string;
      genealogy_count: string;
      genealogy_quantity: string;
    }>(
      `SELECT wo.status AS work_order_status,
          ir.status AS reservation_status,
          ir.quantity::text AS reserved_quantity,
          material_balance.quantity_on_hand::text AS material_on_hand,
          material_balance.quantity_reserved::text AS material_reserved,
          material_bin_balance.quantity_on_hand::text AS material_bin_on_hand,
          material_bin_balance.quantity_reserved::text AS material_bin_reserved,
          material_lot_balance.quantity_on_hand::text AS material_lot_on_hand,
          material_lot_balance.quantity_reserved::text AS material_lot_reserved,
          finished_balance.quantity_on_hand::text AS finished_on_hand,
          (SELECT count(*)::text FROM order_production_reports r
            WHERE r.work_order_id=wo.id AND r.tenant_id=wo.tenant_id AND r.factory_id=wo.factory_id
              AND r.id=$8) AS report_count,
          (SELECT count(*)::text FROM production_output_postings p
            WHERE p.work_order_id=wo.id AND p.tenant_id=wo.tenant_id AND p.factory_id=wo.factory_id
              AND p.id=$5) AS output_count,
          (SELECT COALESCE(sum(p.good_quantity),0)::text FROM production_output_postings p
            WHERE p.work_order_id=wo.id AND p.tenant_id=wo.tenant_id AND p.factory_id=wo.factory_id
              AND p.id=$5) AS output_quantity,
          (SELECT count(*)::text FROM inventory_reservation_consumptions c
            WHERE c.reservation_id=ir.id AND c.tenant_id=wo.tenant_id AND c.factory_id=wo.factory_id) AS consumption_count,
          (SELECT COALESCE(sum(a.quantity),0)::text FROM inventory_reservation_consumption_traceability_allocations a
            JOIN inventory_reservation_consumptions c ON c.id=a.consumption_id AND c.tenant_id=a.tenant_id AND c.factory_id=a.factory_id
            WHERE c.reservation_id=ir.id AND a.traceability_unit_id=$6
              AND a.tenant_id=wo.tenant_id AND a.factory_id=wo.factory_id) AS consumed_quantity,
          (SELECT count(*)::text FROM inventory_reservation_consumption_traceability_allocations a
            JOIN inventory_reservation_consumptions c ON c.id=a.consumption_id AND c.tenant_id=a.tenant_id AND c.factory_id=a.factory_id
            WHERE c.reservation_id=ir.id AND a.traceability_unit_id=$6
              AND a.tenant_id=wo.tenant_id AND a.factory_id=wo.factory_id) AS consumption_allocation_count,
          (SELECT count(*)::text FROM product_genealogy_events g
            WHERE g.source_unit_id=$6 AND g.target_unit_id=$7
              AND g.tenant_id=wo.tenant_id AND g.factory_id=wo.factory_id
              AND g.relationship_type='CONSUMED_INTO'
              AND g.evidence->>'source'='WORK_ORDER_MATERIAL_CONSUMPTION'
              AND g.evidence->>'production_report_id'=$8::text
              AND g.evidence->>'production_output_posting_id'=$5::text) AS genealogy_count,
          (SELECT COALESCE(sum(g.quantity),0)::text FROM product_genealogy_events g
            WHERE g.source_unit_id=$6 AND g.target_unit_id=$7
              AND g.tenant_id=wo.tenant_id AND g.factory_id=wo.factory_id
              AND g.relationship_type='CONSUMED_INTO'
              AND g.evidence->>'source'='WORK_ORDER_MATERIAL_CONSUMPTION'
              AND g.evidence->>'production_report_id'=$8::text
              AND g.evidence->>'production_output_posting_id'=$5::text) AS genealogy_quantity
       FROM work_orders wo
       JOIN work_order_material_reservations mr
         ON mr.work_order_id=wo.id AND mr.tenant_id=wo.tenant_id AND mr.factory_id=wo.factory_id
       JOIN inventory_reservations ir
         ON ir.id=mr.reservation_id AND ir.tenant_id=mr.tenant_id AND ir.factory_id=mr.factory_id
       JOIN inventory_stock_balances material_balance
         ON material_balance.item_id=$2 AND material_balance.tenant_id=wo.tenant_id AND material_balance.factory_id=wo.factory_id
       JOIN inventory_location_balances material_bin_balance
         ON material_bin_balance.item_id=$2 AND material_bin_balance.location_id=$3
           AND material_bin_balance.tenant_id=wo.tenant_id AND material_bin_balance.factory_id=wo.factory_id
       JOIN inventory_traceability_location_balances material_lot_balance
         ON material_lot_balance.item_id=$2 AND material_lot_balance.traceability_unit_id=$6
           AND material_lot_balance.location_id=$3
           AND material_lot_balance.tenant_id=wo.tenant_id AND material_lot_balance.factory_id=wo.factory_id
       JOIN inventory_stock_balances finished_balance
         ON finished_balance.item_id=wo.finished_item_id AND finished_balance.tenant_id=wo.tenant_id AND finished_balance.factory_id=wo.factory_id
       WHERE wo.id=$1 AND wo.tenant_id=$4 AND wo.factory_id=$9`,
      [
        draft.id,
        componentItemId,
        componentBinId,
        tenantId,
        output.production_output_posting_id,
        materialLot.id,
        output.finished_good_traceability_unit_id,
        output.production_report_id,
        factoryId,
      ],
    );
    expect(persisted.rows).toEqual([{
      work_order_status: 'COMPLETED',
      reservation_status: 'CONSUMED',
      reserved_quantity: '3.0000',
      material_on_hand: '7.0000',
      material_reserved: '0.0000',
      material_bin_on_hand: '7.0000',
      material_bin_reserved: '0.0000',
      material_lot_on_hand: '7.0000',
      material_lot_reserved: '0.0000',
      finished_on_hand: '3.0000',
      report_count: '1',
      output_count: '1',
      output_quantity: '3.0000',
      consumption_count: '1',
      consumed_quantity: '3.0000',
      consumption_allocation_count: '1',
      genealogy_count: '1',
      genealogy_quantity: '3.0000',
    }]);

    const evidence = await adminPool.query<{ transfer_count: string; operation_ready_count: string }>(
      "SELECT (SELECT count(*)::text FROM work_order_events WHERE work_order_id=$1 AND event_type='WIP_TRANSFERRED') AS transfer_count, (SELECT count(*)::text FROM work_order_events WHERE work_order_id=$1 AND event_type='OPERATION_READY') AS operation_ready_count",
      [draft.id],
    );
    expect(evidence.rows[0]).toEqual({ transfer_count: '2', operation_ready_count: '3' });
  });

  it('completes a three-operation work order with one tracked SERIAL input and rejects a competing release', async () => {
    const serialTarget = 1;
    const finishedItemA = await createItem('Serial-source finished good A', '0.0000');
    const finishedItemB = await createItem('Serial-source finished good B', '0.0000');
    const componentItemId = await createItem('Single-unit serialized component', '1.0000');
    const componentBinId = await createComponentBin(componentItemId, serialTarget);

    const serialCode = 'WO-MULTI-SERIAL-' + randomUUID().slice(0, 12).toUpperCase();
    const materialSerial = await traceabilityService.createUnit(
      TEST_USER_ID,
      tenantId,
      factoryId,
      {
        unit_type: 'SERIAL',
        product_role: 'MATERIAL',
        unit_code: serialCode,
        barcode_value: 'BAR-' + serialCode,
        inventory_item_id: componentItemId,
        quantity: serialTarget,
        unit: 'PCS',
        external_reference: 'three-step-serial-material-genealogy',
        attributes: {},
      } as never,
      'wo-multi-material-serial-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );
    if (!materialSerial.id) throw new Error('Serial-controlled component identity was not created');
    await adminPool.query(
      `INSERT INTO inventory_traceability_location_balances
         (tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand)
       VALUES ($1, $2, $3, $4, $5, 1.0000)`,
      [tenantId, factoryId, componentItemId, materialSerial.id, componentBinId],
    );

    const createSerialWorkOrder = async (finishedItemId: string, label: string) => {
      await createProductRevisionAndRouting(finishedItemId, componentItemId);
      const orderResult = await adminPool.query<{ id: string; line_id: string }>(
        "WITH created_order AS (INSERT INTO orders (tenant_id, factory_id, order_number, status, order_date, currency, created_by_user_id) VALUES ($1, $2, $3, 'IN_PROGRESS', CURRENT_DATE, 'BDT', $4) RETURNING id) INSERT INTO order_lines (tenant_id, factory_id, order_id, line_number, product_code, product_name, quantity, unit, inventory_item_id) SELECT $1, $2, id, 1, $5, $6, $7::numeric, 'PCS', $8 FROM created_order RETURNING order_id::text AS id, id::text AS line_id",
        [
          tenantId,
          factoryId,
          'WO-MULTI-SERIAL-ORDER-' + label + '-' + randomUUID(),
          TEST_USER_ID,
          'WO-MULTI-SERIAL-FG-' + label,
          'Serial-source finished good ' + label,
          serialTarget,
          finishedItemId,
        ],
      );
      const orderId = orderResult.rows[0]?.id;
      const orderLineId = orderResult.rows[0]?.line_id;
      if (!orderId || !orderLineId) throw new Error('Serial work-order source order was not created');
      orderIds.push(orderId);

      const draft = await service.createWorkOrder(
        TEST_USER_ID,
        tenantId,
        factoryId,
        { order_line_id: orderLineId, target_quantity: serialTarget },
        'wo-multi-serial-create-' + label + '-' + randomUUID(),
        randomUUID(),
        randomUUID(),
      );
      workOrderIds.push(draft.id);
      return { draft, finishedItemId, orderId };
    };

    const candidates = await Promise.all([
      createSerialWorkOrder(finishedItemA, 'A'),
      createSerialWorkOrder(finishedItemB, 'B'),
    ]);
    const releaseAttempts = await Promise.allSettled(
      candidates.map((candidate, index) => service.transitionWorkOrder(
        TEST_USER_ID,
        tenantId,
        factoryId,
        candidate.draft.id,
        'RELEASE',
        { expected_version: candidate.draft.row_version },
        'wo-multi-serial-release-' + index + '-' + randomUUID(),
        randomUUID(),
        randomUUID(),
      )),
    );
    const winnerIndexes = releaseAttempts.flatMap((attempt, index) =>
      attempt.status === 'fulfilled' ? [index] : [],
    );
    const loserIndexes = releaseAttempts.flatMap((attempt, index) =>
      attempt.status === 'rejected' ? [index] : [],
    );
    expect(winnerIndexes).toHaveLength(1);
    expect(loserIndexes).toHaveLength(1);
    const winnerIndex = winnerIndexes[0]!;
    const loserIndex = loserIndexes[0]!;
    const loserAttempt = releaseAttempts[loserIndex];
    if (!loserAttempt || loserAttempt.status !== 'rejected') {
      throw new Error('The competing work-order release unexpectedly succeeded');
    }
    expect(loserAttempt.reason).toBeInstanceOf(ConflictException);
    const winner = candidates[winnerIndex]!;
    const loser = candidates[loserIndex]!;

    const reserved = await adminPool.query<{
      reservation_id: string;
      reservation_status: string;
      reservation_quantity: string;
      allocated_quantity: string;
      allocation_count: string;
    }>(
      `SELECT ir.id::text AS reservation_id,
              ir.status AS reservation_status,
              ir.quantity::text AS reservation_quantity,
              min(a.allocated_quantity)::text AS allocated_quantity,
              count(a.id)::text AS allocation_count
       FROM work_order_material_reservations mr
       JOIN inventory_reservations ir
         ON ir.id=mr.reservation_id AND ir.tenant_id=mr.tenant_id AND ir.factory_id=mr.factory_id
       LEFT JOIN inventory_reservation_traceability_allocations a
         ON a.reservation_id=ir.id AND a.tenant_id=ir.tenant_id AND a.factory_id=ir.factory_id
       WHERE mr.work_order_id=$1 AND mr.tenant_id=$2 AND mr.factory_id=$3
       GROUP BY ir.id`,
      [winner.draft.id, tenantId, factoryId],
    );
    expect(reserved.rows).toHaveLength(1);
    expect(reserved.rows[0]).toMatchObject({
      reservation_status: 'RESERVED',
      reservation_quantity: '1.0000',
      allocated_quantity: '1.0000',
      allocation_count: '1',
    });

    const noLoserReservation = await adminPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM work_order_material_reservations WHERE work_order_id=$1 AND tenant_id=$2 AND factory_id=$3',
      [loser.draft.id, tenantId, factoryId],
    );
    expect(noLoserReservation.rows[0]?.count).toBe('0');

    const initial = await readState(winner.draft.id);
    expect(initial.operations.map((operation) => operation.status)).toEqual(['READY', 'PLANNED', 'PLANNED']);
    const [first, second, third] = initial.operations;
    if (!first || !second || !third) throw new Error('Serial work-order routing snapshot was incomplete');

    await sendOperationEvent(winner.draft.id, first.id, { command: 'START' }, 'wo-multi-serial-start-1-' + randomUUID());
    await sendOperationEvent(winner.draft.id, first.id, { command: 'WIP_REPORTED', quantity: serialTarget }, 'wo-multi-serial-wip-1-' + randomUUID());
    await sendOperationEvent(
      winner.draft.id,
      first.id,
      { command: 'WIP_TRANSFERRED', quantity: serialTarget, target_operation_id: second.id },
      'wo-multi-serial-transfer-1-' + randomUUID(),
    );
    await sendOperationEvent(winner.draft.id, first.id, { command: 'COMPLETE' }, 'wo-multi-serial-complete-1-' + randomUUID());

    await sendOperationEvent(winner.draft.id, second.id, { command: 'START' }, 'wo-multi-serial-start-2-' + randomUUID());
    await sendOperationEvent(
      winner.draft.id,
      second.id,
      { command: 'WIP_TRANSFERRED', quantity: serialTarget, target_operation_id: third.id },
      'wo-multi-serial-transfer-2-' + randomUUID(),
    );
    await sendOperationEvent(winner.draft.id, second.id, { command: 'COMPLETE' }, 'wo-multi-serial-complete-2-' + randomUUID());

    await sendOperationEvent(winner.draft.id, third.id, { command: 'START' }, 'wo-multi-serial-start-3-' + randomUUID());
    await sendOperationEvent(winner.draft.id, third.id, { command: 'WIP_REPORTED', quantity: serialTarget }, 'wo-multi-serial-wip-3-' + randomUUID());
    const outputState = await readState(winner.draft.id);
    const finalOperation = outputState.operations[2];
    if (!finalOperation) throw new Error('Serial work-order final operation was not found');
    const requestedFinishedGoodSerialCode = 'vendor/fg-' + randomUUID().slice(0, 12).toLowerCase();
    const finishedGoodSerialCode = requestedFinishedGoodSerialCode.toUpperCase();
    const outputInput = {
      operation_id: finalOperation.id,
      expected_work_order_version: outputState.row_version,
      expected_operation_version: finalOperation.row_version,
      good_quantity: serialTarget,
      scrap_quantity: 0,
      finished_good_serial_code: requestedFinishedGoodSerialCode,
      notes: 'Three-step finished-good SERIAL output from one serialized material identity',
    };
    await expect(service.reportOutput(
      TEST_USER_ID, tenantId, factoryId, winner.draft.id,
      { ...outputInput, good_quantity: 2 } as never,
      'wo-multi-serial-invalid-output-' + randomUUID(), randomUUID(), randomUUID(),
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.reportOutput(
      TEST_USER_ID, tenantId, factoryId, winner.draft.id,
      { ...outputInput, finished_good_serial_code: 'invalid\nserial code' } as never,
      'wo-multi-serial-invalid-code-' + randomUUID(), randomUUID(), randomUUID(),
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.reportOutput(
      TEST_USER_ID, tenantId, factoryId, winner.draft.id,
      { ...outputInput, finished_good_serial_code: '   ' } as never,
      'wo-multi-serial-blank-code-' + randomUUID(), randomUUID(), randomUUID(),
    )).rejects.toBeInstanceOf(BadRequestException);
    const duplicateFinishedGoodSerialCode = 'DUPLICATE-FG-SERIAL-' + randomUUID().slice(0, 8).toUpperCase();
    await traceabilityService.createUnit(
      TEST_USER_ID,
      tenantId,
      factoryId,
      {
        unit_type: 'LOT',
        product_role: 'OTHER',
        unit_code: duplicateFinishedGoodSerialCode,
        barcode_value: 'BAR-' + duplicateFinishedGoodSerialCode,
        inventory_item_id: componentItemId,
        quantity: 1,
        unit: 'PCS',
        external_reference: 'finished-good-serial-code-conflict-regression',
        attributes: {},
      } as never,
      'wo-multi-existing-output-code-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );
    await expect(service.reportOutput(
      TEST_USER_ID, tenantId, factoryId, winner.draft.id,
      { ...outputInput, finished_good_serial_code: duplicateFinishedGoodSerialCode } as never,
      'wo-multi-serial-existing-code-' + randomUUID(), randomUUID(), randomUUID(),
    )).rejects.toBeInstanceOf(ConflictException);
    const outputKey = 'wo-multi-serial-final-output-' + randomUUID();
    const outputAttempts = await Promise.all([
      service.reportOutput(
        TEST_USER_ID, tenantId, factoryId, winner.draft.id,
        outputInput as never, outputKey, randomUUID(), randomUUID(),
      ),
      service.reportOutput(
        TEST_USER_ID, tenantId, factoryId, winner.draft.id,
        outputInput as never, outputKey, randomUUID(), randomUUID(),
      ),
    ]);
    expect(outputAttempts.map((attempt) => attempt.replayed).sort()).toEqual([false, true]);
    expect(new Set(outputAttempts.map((attempt) => attempt.production_report_id)).size).toBe(1);
    expect(new Set(outputAttempts.map((attempt) => attempt.production_output_posting_id)).size).toBe(1);
    await expect(service.reportOutput(
      TEST_USER_ID, tenantId, factoryId, winner.draft.id,
      { ...outputInput, finished_good_serial_code: 'FG-SERIAL-ALTERNATE-' + randomUUID().slice(0, 8).toUpperCase() } as never,
      outputKey, randomUUID(), randomUUID(),
    )).rejects.toBeInstanceOf(ConflictException);
    const output = outputAttempts.find((attempt) => !attempt.replayed);
    if (!output?.finished_good_traceability_unit_id || !output.production_output_posting_id || !output.production_report_id) {
      throw new Error('Serial input output did not produce its canonical report, posting and finished-good SERIAL identity');
    }

    await sendOperationEvent(
      winner.draft.id, third.id, { command: 'WIP_REPORTED', quantity: 0 },
      'wo-multi-serial-final-wip-zero-' + randomUUID(),
    );
    await sendOperationEvent(
      winner.draft.id, third.id, { command: 'COMPLETE' },
      'wo-multi-serial-final-operation-complete-' + randomUUID(),
    );
    const finalState = await readState(winner.draft.id);
    expect(finalState.operations.map((operation) => operation.status)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED']);
    expect(finalState.operations.map((operation) => operation.wip_quantity)).toEqual(['0.0000', '0.0000', '0.0000']);

    const completed = await service.transitionWorkOrder(
      TEST_USER_ID, tenantId, factoryId, winner.draft.id, 'COMPLETE',
      { expected_version: finalState.row_version } as never,
      'wo-multi-serial-final-work-order-complete-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );
    expect(completed.status).toBe('COMPLETED');

    await expect(service.transitionWorkOrder(
      TEST_USER_ID,
      tenantId,
      factoryId,
      loser.draft.id,
      'RELEASE',
      { expected_version: loser.draft.row_version },
      'wo-multi-serial-release-retry-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    )).rejects.toBeInstanceOf(ConflictException);

    const reservation = await adminPool.query<{
      status: string;
      quantity: string;
      consumed_quantity: string;
      released_quantity: string;
    }>(
      `SELECT ir.status, ir.quantity::text AS quantity,
              ir.consumed_quantity::text AS consumed_quantity,
              ir.released_quantity::text AS released_quantity
       FROM work_order_material_reservations mr
       JOIN inventory_reservations ir
         ON ir.id=mr.reservation_id AND ir.tenant_id=mr.tenant_id AND ir.factory_id=mr.factory_id
       WHERE mr.work_order_id=$1 AND mr.tenant_id=$2 AND mr.factory_id=$3`,
      [winner.draft.id, tenantId, factoryId],
    );
    expect(reservation.rows).toEqual([{
      status: 'CONSUMED',
      quantity: '1.0000',
      consumed_quantity: '1.0000',
      released_quantity: '0.0000',
    }]);

    const sourceBalances = await adminPool.query<{
      unit_type: string;
      identity_quantity: string;
      serial_on_hand: string;
      serial_reserved: string;
      serial_total_on_hand: string;
      serial_total_reserved: string;
      aggregate_on_hand: string;
      aggregate_reserved: string;
      bin_on_hand: string;
      bin_reserved: string;
    }>(
      `SELECT tu.unit_type, tu.quantity::text AS identity_quantity,
              tlb.quantity_on_hand::text AS serial_on_hand,
              tlb.quantity_reserved::text AS serial_reserved,
              (SELECT COALESCE(sum(all_locations.quantity_on_hand), 0)::text
               FROM inventory_traceability_location_balances all_locations
               WHERE all_locations.traceability_unit_id=tu.id
                 AND all_locations.tenant_id=tu.tenant_id AND all_locations.factory_id=tu.factory_id) AS serial_total_on_hand,
              (SELECT COALESCE(sum(all_locations.quantity_reserved), 0)::text
               FROM inventory_traceability_location_balances all_locations
               WHERE all_locations.traceability_unit_id=tu.id
                 AND all_locations.tenant_id=tu.tenant_id AND all_locations.factory_id=tu.factory_id) AS serial_total_reserved,
              sb.quantity_on_hand::text AS aggregate_on_hand,
              sb.quantity_reserved::text AS aggregate_reserved,
              lb.quantity_on_hand::text AS bin_on_hand,
              lb.quantity_reserved::text AS bin_reserved
       FROM traceability_units tu
       JOIN inventory_traceability_location_balances tlb
         ON tlb.traceability_unit_id=tu.id AND tlb.tenant_id=tu.tenant_id AND tlb.factory_id=tu.factory_id
       JOIN inventory_stock_balances sb
         ON sb.item_id=tu.inventory_item_id AND sb.tenant_id=tu.tenant_id AND sb.factory_id=tu.factory_id
       JOIN inventory_location_balances lb
         ON lb.item_id=tu.inventory_item_id AND lb.location_id=tlb.location_id
          AND lb.tenant_id=tu.tenant_id AND lb.factory_id=tu.factory_id
       WHERE tu.id=$1 AND tu.tenant_id=$2 AND tu.factory_id=$3 AND tlb.location_id=$4`,
      [materialSerial.id, tenantId, factoryId, componentBinId],
    );
    expect(sourceBalances.rows).toEqual([{
      unit_type: 'SERIAL',
      identity_quantity: '1.0000',
      serial_on_hand: '0.0000',
      serial_reserved: '0.0000',
      serial_total_on_hand: '0.0000',
      serial_total_reserved: '0.0000',
      aggregate_on_hand: '0.0000',
      aggregate_reserved: '0.0000',
      bin_on_hand: '0.0000',
      bin_reserved: '0.0000',
    }]);

    const genealogy = await adminPool.query<{
      relationship_type: string;
      quantity: string;
      source: string;
      allocation_method: string;
      source_unit_type: string;
      target_unit_type: string;
      target_product_role: string;
    }>(
      `SELECT g.relationship_type, g.quantity::text AS quantity,
              g.evidence->>'source' AS source,
              g.evidence->>'allocation_method' AS allocation_method,
              source_unit.unit_type AS source_unit_type,
              target_unit.unit_type AS target_unit_type,
              target_unit.product_role AS target_product_role
       FROM product_genealogy_events g
       JOIN traceability_units source_unit
         ON source_unit.id=g.source_unit_id AND source_unit.tenant_id=g.tenant_id AND source_unit.factory_id=g.factory_id
       JOIN traceability_units target_unit
         ON target_unit.id=g.target_unit_id AND target_unit.tenant_id=g.tenant_id AND target_unit.factory_id=g.factory_id
       WHERE g.tenant_id=$1 AND g.factory_id=$2
         AND g.source_unit_id=$3 AND g.target_unit_id=$4`,
      [tenantId, factoryId, materialSerial.id, output.finished_good_traceability_unit_id],
    );
    expect(genealogy.rows).toEqual([{
      relationship_type: 'CONSUMED_INTO',
      quantity: '1.0000',
      source: 'WORK_ORDER_MATERIAL_CONSUMPTION',
      allocation_method: 'SERIAL_IDENTITY_ASSIGNED_TO_SINGLE_OUTPUT_BY_WEIGHTED_MIDPOINT_V1',
      source_unit_type: 'SERIAL',
      target_unit_type: 'SERIAL',
      target_product_role: 'FINISHED_GOOD',
    }]);

    const finished = await adminPool.query<{
      quantity_on_hand: string;
      target_identity_quantity: string;
      target_identity_type: string;
      target_identity_code: string;
      target_identity_role: string;
      report_count: string;
      tracked_location_count: string;
      tracked_location_row_count: string;
      tracked_location_on_hand: string;
      tracked_location_reserved: string;
      posting_count: string;
    }>(
      `SELECT sb.quantity_on_hand::text AS quantity_on_hand,
              tu.quantity::text AS target_identity_quantity,
              tu.unit_type AS target_identity_type,
              tu.unit_code AS target_identity_code,
              tu.product_role AS target_identity_role,
              (SELECT count(*)::text FROM inventory_traceability_location_balances tlb
               WHERE tlb.tenant_id=$2 AND tlb.factory_id=$3
                 AND tlb.item_id=$4 AND tlb.traceability_unit_id=tu.id
                 AND tlb.quantity_on_hand=1.0000 AND tlb.quantity_reserved=0.0000) AS tracked_location_count,
              (SELECT count(*)::text FROM inventory_traceability_location_balances tlb
               WHERE tlb.tenant_id=$2 AND tlb.factory_id=$3
                 AND tlb.item_id=$4 AND tlb.traceability_unit_id=tu.id) AS tracked_location_row_count,
              (SELECT COALESCE(sum(tlb.quantity_on_hand),0)::text FROM inventory_traceability_location_balances tlb
               WHERE tlb.tenant_id=$2 AND tlb.factory_id=$3
                 AND tlb.item_id=$4 AND tlb.traceability_unit_id=tu.id) AS tracked_location_on_hand,
              (SELECT COALESCE(sum(tlb.quantity_reserved),0)::text FROM inventory_traceability_location_balances tlb
               WHERE tlb.tenant_id=$2 AND tlb.factory_id=$3
                 AND tlb.item_id=$4 AND tlb.traceability_unit_id=tu.id) AS tracked_location_reserved,
              (SELECT count(*)::text FROM order_production_reports r
               WHERE r.work_order_id=$1 AND r.tenant_id=$2 AND r.factory_id=$3) AS report_count,
              (SELECT count(*)::text FROM production_output_postings p
               WHERE p.work_order_id=$1 AND p.tenant_id=$2 AND p.factory_id=$3) AS posting_count
       FROM inventory_stock_balances sb
       JOIN traceability_units tu
         ON tu.inventory_item_id=sb.item_id AND tu.tenant_id=sb.tenant_id AND tu.factory_id=sb.factory_id
       WHERE sb.tenant_id=$2 AND sb.factory_id=$3
         AND sb.item_id=$4 AND tu.id=$5`,
      [winner.draft.id, tenantId, factoryId, winner.finishedItemId, output.finished_good_traceability_unit_id],
    );
    expect(finished.rows).toEqual([{
      quantity_on_hand: '1.0000',
      target_identity_quantity: '1.0000',
      target_identity_type: 'SERIAL',
      target_identity_code: finishedGoodSerialCode,
      target_identity_role: 'FINISHED_GOOD',
      tracked_location_count: '1',
      tracked_location_row_count: '1',
      tracked_location_on_hand: '1.0000',
      tracked_location_reserved: '0.0000',
      report_count: '1',
      posting_count: '1',
    }]);
  });

});
