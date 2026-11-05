import { ConflictException } from '@nestjs/common';
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
  const traceabilityUnitIds: string[] = [];
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

  const createComponentBin = async (componentItemId: string): Promise<{ unassignedId: string; binId: string }> => {
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
      "SELECT id::text AS id FROM inventory_locations WHERE tenant_id=$1 AND factory_id=$2 AND is_default=TRUE AND status='ACTIVE' AND location_type='VIRTUAL' LIMIT 1",
      [tenantId, factoryId],
    );
    const unassignedId = defaultLocation.rows[0]?.id;
    if (!unassignedId) throw new Error('Factory UNASSIGNED location is missing');

    // The inventory_stock_balances INSERT already seeds this UNASSIGNED location
    // through migration 064. Migration 160 then binds the registered lot identity
    // to that real location quantity; this fixture must not manufacture a second balance.
    return { unassignedId, binId };
  };

  const registerAndPutAwayMaterialLot = async (
    componentItemId: string,
    locations: { unassignedId: string; binId: string },
  ): Promise<string> => {
    const lot = await traceabilityService.createUnit(
      TEST_USER_ID,
      tenantId,
      factoryId,
      {
        unit_type: 'LOT',
        product_role: 'MATERIAL',
        unit_code: 'WO-MULTI-LOT-' + randomUUID().slice(0, 8),
        inventory_item_id: componentItemId,
        quantity: 10,
        unit: 'PCS',
        manufactured_at: new Date().toISOString(),
        attributes: { fixture: 'three-step-work-order-material-lot' },
      },
      'wo-multi-material-lot-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );
    traceabilityUnitIds.push(lot.id);

    await locationService.transferStock(
      TEST_USER_ID,
      tenantId,
      factoryId,
      componentItemId,
      {
        movement_purpose: 'PUT_AWAY',
        source_location_id: locations.unassignedId,
        destination_location_id: locations.binId,
        traceability_unit_id: lot.id,
        quantity: 10,
        notes: 'Put away the registered material lot for the three-step work order fixture',
      },
      'wo-multi-lot-putaway-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );
    return lot.id;
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
    traceabilityService = new TraceabilityService(database as never);
    service = new ProductionWorkOrdersService(database as never, audit, inventory);
  });

  afterAll(async () => {
    if (!adminPool) return;
    const mutableTables = [
      'work_order_events',
      'production_output_postings',
      'order_production_reports',
      'product_genealogy_events',
      'traceability_units',
      'inventory_traceability_location_balances',
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
        const outputIdentityRows = await client.query<{ traceability_unit_id: string | null; scrap_traceability_unit_id: string | null }>(
          'SELECT traceability_unit_id::text AS traceability_unit_id, scrap_traceability_unit_id::text AS scrap_traceability_unit_id FROM production_output_postings WHERE work_order_id = ANY($1::uuid[])',
          [workOrderIds],
        );
        const trackedUnitIds = [...new Set([
          ...traceabilityUnitIds,
          ...outputIdentityRows.rows.flatMap((row) => [row.traceability_unit_id, row.scrap_traceability_unit_id].filter((id): id is string => Boolean(id))),
        ])];
        await client.query('DELETE FROM production_output_postings WHERE work_order_id = ANY($1::uuid[])', [workOrderIds]);

        let genealogyEventIds: string[] = [];
        if (trackedUnitIds.length > 0) {
          const genealogyRows = await client.query<{ id: string }>(
            'SELECT id::text AS id FROM product_genealogy_events WHERE source_unit_id = ANY($1::uuid[]) OR target_unit_id = ANY($1::uuid[])',
            [trackedUnitIds],
          );
          genealogyEventIds = genealogyRows.rows.map((row) => row.id);
          await client.query(
            'DELETE FROM product_genealogy_events WHERE source_unit_id = ANY($1::uuid[]) OR target_unit_id = ANY($1::uuid[])',
            [trackedUnitIds],
          );
          await client.query(
            'DELETE FROM audit_events WHERE resource_id = ANY($1::uuid[])',
            [[...trackedUnitIds, ...genealogyEventIds]],
          );
          await client.query(
            'DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])',
            [[...trackedUnitIds, ...genealogyEventIds]],
          );
          await client.query(
            'DELETE FROM inventory_traceability_location_balances WHERE item_id = ANY($1::uuid[])',
            [inventoryItemIds],
          );
        }

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
        if (trackedUnitIds.length > 0) {
          await client.query('DELETE FROM traceability_units WHERE id = ANY($1::uuid[])', [trackedUnitIds]);
        }
        await client.query('DELETE FROM order_production_reports WHERE work_order_id = ANY($1::uuid[])', [workOrderIds]);
        await client.query('DELETE FROM work_order_events WHERE work_order_id = ANY($1::uuid[])', [workOrderIds]);
        await client.query('DELETE FROM work_order_operations WHERE work_order_id = ANY($1::uuid[])', [workOrderIds]);
        await client.query('DELETE FROM work_order_material_reservations WHERE work_order_id = ANY($1::uuid[])', [workOrderIds]);
        await client.query('DELETE FROM work_order_material_requirements WHERE work_order_id = ANY($1::uuid[])', [workOrderIds]);
        await client.query('DELETE FROM work_orders WHERE id = ANY($1::uuid[])', [workOrderIds]);
      }

      if (workOrderIds.length === 0 && traceabilityUnitIds.length > 0) {
        await client.query(
          'DELETE FROM product_genealogy_events WHERE source_unit_id = ANY($1::uuid[]) OR target_unit_id = ANY($1::uuid[])',
          [traceabilityUnitIds],
        );
        await client.query('DELETE FROM audit_events WHERE resource_id = ANY($1::uuid[])', [traceabilityUnitIds]);
        await client.query('DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])', [traceabilityUnitIds]);
        await client.query('DELETE FROM inventory_traceability_location_balances WHERE item_id = ANY($1::uuid[])', [inventoryItemIds]);
        await client.query('DELETE FROM traceability_units WHERE id = ANY($1::uuid[])', [traceabilityUnitIds]);
      }

      if (inventoryItemIds.length > 0) {
        await client.query('DELETE FROM inventory_reservation_consumption_traceability_allocations WHERE tenant_id=$1 AND factory_id=$2 AND consumption_id IN (SELECT id FROM inventory_reservation_consumptions WHERE item_id = ANY($3::uuid[]))', [tenantId, factoryId, inventoryItemIds]);
        await client.query('DELETE FROM inventory_reservation_consumptions WHERE item_id = ANY($1::uuid[])', [inventoryItemIds]);
        await client.query('DELETE FROM inventory_reservation_traceability_allocations WHERE item_id = ANY($1::uuid[])', [inventoryItemIds]);
        await client.query('DELETE FROM inventory_location_transfers WHERE item_id = ANY($1::uuid[])', [inventoryItemIds]);
        await client.query('DELETE FROM inventory_traceability_location_balances WHERE item_id = ANY($1::uuid[])', [inventoryItemIds]);
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
      const outboxAggregateIds = [...workOrderIds, ...orderIds, ...productIds, ...productVersionIds, ...workCentreIds, ...routingStepIds, ...warehouseIds, ...binIds, ...traceabilityUnitIds];
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

  it('routes one work order through three operations with conserved WIP, next-step transfer and row-versioned events', async () => {
    const finishedItemId = await createItem('Three-step finished good', '0.0000');
    const componentItemId = await createItem('Three-step BOM component', '10.0000');
    const componentLocations = await createComponentBin(componentItemId);
    const sourceMaterialLotId = await registerAndPutAwayMaterialLot(componentItemId, componentLocations);
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

    const reservedMaterial = await adminPool.query<{
      unit_code: string;
      allocated_quantity: string;
      consumed_quantity: string;
      released_quantity: string;
    }>(
      `SELECT tu.unit_code, a.allocated_quantity::text AS allocated_quantity,
         a.consumed_quantity::text AS consumed_quantity, a.released_quantity::text AS released_quantity
       FROM work_order_material_reservations mr
       JOIN inventory_reservations ir ON ir.id = mr.reservation_id AND ir.tenant_id = mr.tenant_id AND ir.factory_id = mr.factory_id
       JOIN inventory_reservation_traceability_allocations a ON a.reservation_id = ir.id AND a.tenant_id = ir.tenant_id AND a.factory_id = ir.factory_id
       JOIN traceability_units tu ON tu.id = a.traceability_unit_id AND tu.tenant_id = a.tenant_id AND tu.factory_id = a.factory_id
       WHERE mr.work_order_id = $1 AND a.traceability_unit_id = $2`,
      [draft.id, sourceMaterialLotId],
    );
    expect(reservedMaterial.rows).toEqual([{
      unit_code: expect.any(String),
      allocated_quantity: '3.0000',
      consumed_quantity: '0.0000',
      released_quantity: '0.0000',
    }]);

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

    const outputDto = {
      operation_id: third.id,
      expected_work_order_version: state.row_version,
      expected_operation_version: state.operations[2]!.row_version,
      good_quantity: 2,
      scrap_quantity: 1,
      scrap_reason: 'Three-step integration fixture scrap',
      notes: 'Post two good units and one scrap unit from the final operation',
      occurred_at: new Date().toISOString(),
    };
    const outputKey = 'wo-multi-final-output-' + randomUUID();
    const output = await service.reportOutput(
      TEST_USER_ID, tenantId, factoryId, draft.id, outputDto,
      outputKey, randomUUID(), randomUUID(),
    );
    expect(output.replayed).toBe(false);
    expect(output.finished_good_traceability_unit_id).toEqual(expect.any(String));
    expect(output.scrap_traceability_unit_id).toEqual(expect.any(String));

    const outputReplay = await service.reportOutput(
      TEST_USER_ID, tenantId, factoryId, draft.id, outputDto,
      outputKey, randomUUID(), randomUUID(),
    );
    expect(outputReplay.replayed).toBe(true);
    expect(outputReplay.production_report_id).toBe(output.production_report_id);
    expect(outputReplay.finished_good_traceability_unit_id).toBe(output.finished_good_traceability_unit_id);

    await sendOperationEvent(draft.id, third.id, { command: 'WIP_REPORTED', quantity: 0 }, 'wo-multi-clear-final-wip-' + randomUUID());
    await sendOperationEvent(draft.id, third.id, { command: 'COMPLETE' }, 'wo-multi-complete-3-' + randomUUID());

    state = await readState(draft.id);
    expect(state.operations.map((operation) => operation.status)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED']);
    expect(state.operations.map((operation) => operation.wip_quantity)).toEqual(['0.0000', '0.0000', '0.0000']);

    const completed = await service.transitionWorkOrder(
      TEST_USER_ID,
      tenantId,
      factoryId,
      draft.id,
      'COMPLETE',
      { expected_version: state.row_version },
      'wo-multi-work-order-complete-' + randomUUID(),
      randomUUID(),
      randomUUID(),
    );
    expect(completed.status).toBe('COMPLETED');

    const completionEvidence = await adminPool.query<{
      genealogy_count: string;
      consumption_count: string;
      allocated_quantity: string;
      consumed_quantity: string;
      traced_consumption_quantity: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM product_genealogy_events e
          WHERE e.source_unit_id = $2
            AND e.target_unit_id = ANY(ARRAY[$3::uuid, $4::uuid])) AS genealogy_count,
         (SELECT count(*)::text FROM inventory_reservation_consumptions c
          JOIN inventory_reservations r ON r.id = c.reservation_id AND r.tenant_id = c.tenant_id AND r.factory_id = c.factory_id
          WHERE r.reference_type='WORK_ORDER_MATERIAL' AND r.reference_id=$1) AS consumption_count,
         (SELECT COALESCE(SUM(a.allocated_quantity), 0)::text FROM inventory_reservation_traceability_allocations a
          JOIN inventory_reservations r ON r.id = a.reservation_id AND r.tenant_id = a.tenant_id AND r.factory_id = a.factory_id
          WHERE r.reference_type='WORK_ORDER_MATERIAL' AND r.reference_id=$1) AS allocated_quantity,
         (SELECT COALESCE(SUM(a.consumed_quantity), 0)::text FROM inventory_reservation_traceability_allocations a
          JOIN inventory_reservations r ON r.id = a.reservation_id AND r.tenant_id = a.tenant_id AND r.factory_id = a.factory_id
          WHERE r.reference_type='WORK_ORDER_MATERIAL' AND r.reference_id=$1) AS consumed_quantity,
         (SELECT COALESCE(SUM(ca.quantity), 0)::text FROM inventory_reservation_consumption_traceability_allocations ca
          JOIN inventory_reservation_consumptions c ON c.id = ca.consumption_id AND c.tenant_id = ca.tenant_id AND c.factory_id = ca.factory_id
          JOIN inventory_reservations r ON r.id = c.reservation_id AND r.tenant_id = c.tenant_id AND r.factory_id = c.factory_id
          WHERE r.reference_type='WORK_ORDER_MATERIAL' AND r.reference_id=$1) AS traced_consumption_quantity`,
      [draft.id, sourceMaterialLotId, output.finished_good_traceability_unit_id, output.scrap_traceability_unit_id],
    );
    expect(completionEvidence.rows[0]).toEqual({
      genealogy_count: '2',
      consumption_count: '1',
      allocated_quantity: '3.0000',
      consumed_quantity: '3.0000',
      traced_consumption_quantity: '3.0000',
    });

    const genealogy = await adminPool.query<{
      relationship_type: string;
      quantity: string;
      target_unit_id: string;
    }>(
      `SELECT relationship_type, quantity::text AS quantity, target_unit_id::text AS target_unit_id
       FROM product_genealogy_events
       WHERE source_unit_id=$1 AND target_unit_id=ANY(ARRAY[$2::uuid,$3::uuid])
       ORDER BY relationship_type, target_unit_id`,
      [sourceMaterialLotId, output.finished_good_traceability_unit_id, output.scrap_traceability_unit_id],
    );
    expect(genealogy.rows).toEqual([
      { relationship_type: 'CONSUMED_INTO', quantity: '2.0000', target_unit_id: output.finished_good_traceability_unit_id },
      { relationship_type: 'PROCESSED_INTO', quantity: '1.0000', target_unit_id: output.scrap_traceability_unit_id },
    ]);

    const materialState = await adminPool.query<{
      aggregate_on_hand: string;
      aggregate_reserved: string;
      lot_on_hand: string;
      lot_reserved: string;
      location_on_hand: string;
    }>(
      `SELECT sb.quantity_on_hand::text AS aggregate_on_hand,
         sb.quantity_reserved::text AS aggregate_reserved,
         tlb.quantity_on_hand::text AS lot_on_hand,
         tlb.quantity_reserved::text AS lot_reserved,
         lb.quantity_on_hand::text AS location_on_hand
       FROM inventory_stock_balances sb
       JOIN inventory_traceability_location_balances tlb
         ON tlb.tenant_id=sb.tenant_id AND tlb.factory_id=sb.factory_id AND tlb.item_id=sb.item_id
       JOIN inventory_location_balances lb
         ON lb.tenant_id=tlb.tenant_id AND lb.factory_id=tlb.factory_id
        AND lb.item_id=tlb.item_id AND lb.location_id=tlb.location_id
       WHERE sb.tenant_id=$1 AND sb.factory_id=$2 AND sb.item_id=$3
         AND tlb.traceability_unit_id=$4 AND tlb.location_id=$5`,
      [tenantId, factoryId, componentItemId, sourceMaterialLotId, componentLocations.binId],
    );
    expect(materialState.rows[0]).toEqual({
      aggregate_on_hand: '7.0000',
      aggregate_reserved: '0.0000',
      lot_on_hand: '7.0000',
      lot_reserved: '0.0000',
      location_on_hand: '7.0000',
    });

    const finishedStock = await adminPool.query<{ quantity_on_hand: string; lot_quantity: string }>(
      `SELECT sb.quantity_on_hand::text AS quantity_on_hand, tu.quantity::text AS lot_quantity
       FROM inventory_stock_balances sb
       JOIN traceability_units tu ON tu.inventory_item_id=sb.item_id AND tu.tenant_id=sb.tenant_id AND tu.factory_id=sb.factory_id
       WHERE sb.tenant_id=$1 AND sb.factory_id=$2 AND sb.item_id=$3
         AND tu.id=$4 AND tu.product_role='FINISHED_GOOD'`,
      [tenantId, factoryId, finishedItemId, output.finished_good_traceability_unit_id],
    );
    expect(finishedStock.rows[0]).toEqual({ quantity_on_hand: '2.0000', lot_quantity: '2.0000' });

    const completionEvent = await adminPool.query<{ genealogy_count: number; traceability_count: number }>(
      `SELECT (payload->>'production_output_genealogy_event_count')::int AS genealogy_count,
         (payload->>'traceability_material_allocation_count')::int AS traceability_count
       FROM work_order_events
       WHERE work_order_id=$1 AND payload ? 'production_output_genealogy_event_count'`,
      [draft.id],
    );
    expect(completionEvent.rows).toEqual([{ genealogy_count: 2, traceability_count: 1 }]);

    const evidence = await adminPool.query<{ transfer_count: string; operation_ready_count: string }>(
      "SELECT (SELECT count(*)::text FROM work_order_events WHERE work_order_id=$1 AND event_type='WIP_TRANSFERRED') AS transfer_count, (SELECT count(*)::text FROM work_order_events WHERE work_order_id=$1 AND event_type='OPERATION_READY') AS operation_ready_count",
      [draft.id],
    );
    expect(evidence.rows[0]).toEqual({ transfer_count: '2', operation_ready_count: '3' });
  });
});
