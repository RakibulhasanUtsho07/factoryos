import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { InventoryReservationService } from '../inventory/inventory.reservation.service';
import { ProductionWorkOrdersService } from './production-work-orders.service';

const USER = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const WORK_ORDER = 'a4f159c0-4a80-4b27-b3ac-e5c311fe6cf8';
const OPERATION = 'f6530381-74ad-4f2b-b1bd-3126c2c3a4bc';

describe('ProductionWorkOrdersService request contracts', () => {
  let service: ProductionWorkOrdersService;
  let database: { transaction: ReturnType<typeof jest.fn>; query: ReturnType<typeof jest.fn> };
  let audit: { record: ReturnType<typeof jest.fn> };
  let inventory: { reserveWorkOrderMaterialRequirement: ReturnType<typeof jest.fn>; transitionWorkOrderMaterialReservations: ReturnType<typeof jest.fn> };

  beforeEach(() => {
    database = { transaction: jest.fn(), query: jest.fn() };
    audit = { record: jest.fn() };
    inventory = { reserveWorkOrderMaterialRequirement: jest.fn(), transitionWorkOrderMaterialReservations: jest.fn() };
    service = new ProductionWorkOrdersService(
      database as unknown as DatabaseService,
      audit as unknown as AuditService,
      inventory as unknown as InventoryReservationService,
    );
  });

  it('rejects malformed authenticated scope before touching the database', async () => {
    await expect(service.listWorkOrders('bad-user', TENANT, FACTORY)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('requires idempotency on work-order creation before reading source order data', async () => {
    await expect(service.createWorkOrder(
      USER, TENANT, FACTORY,
      { order_line_id: OPERATION, target_quantity: 12 },
      null, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects impossible planned-start calendar dates before reading production data', async () => {
    await expect(service.createWorkOrder(
      USER, TENANT, FACTORY,
      { order_line_id: OPERATION, target_quantity: 12, planned_start_date: '2026-02-30' },
      'wo-key', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects quantities with more than four decimal places without opening a transaction', async () => {
    await expect(service.createWorkOrder(
      USER, TENANT, FACTORY,
      { order_line_id: OPERATION, target_quantity: 1.00001 },
      'wo-key', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires an idempotency key for operation commands', async () => {
    await expect(service.reportOperationEvent(
      USER, TENANT, FACTORY, WORK_ORDER, OPERATION,
      {
        command: 'START',
        expected_work_order_version: 1,
        expected_operation_version: 1,
      } as never,
      null, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a device identifier for HMI operation commands before opening a transaction', async () => {
    await expect(service.reportOperationEvent(
      USER, TENANT, FACTORY, WORK_ORDER, OPERATION,
      {
        command: 'START',
        source: 'HMI',
        expected_work_order_version: 1,
        expected_operation_version: 1,
      } as never,
      'hmi-start-42', null, null,
    )).rejects.toThrow('device_id is required when event source is HMI');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires downtime reasons before recording the start of a downtime interval', async () => {
    await expect(service.reportOperationEvent(
      USER, TENANT, FACTORY, WORK_ORDER, OPERATION,
      {
        command: 'DOWNTIME_START',
        expected_work_order_version: 1,
        expected_operation_version: 1,
      } as never,
      'downtime-key', null, null,
    )).rejects.toThrow('reason is required for skip, hold, downtime start and rework events');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires quantity for WIP snapshots before opening a transaction', async () => {
    await expect(service.reportOperationEvent(
      USER, TENANT, FACTORY, WORK_ORDER, OPERATION,
      {
        command: 'WIP_REPORTED',
        expected_work_order_version: 1,
        expected_operation_version: 1,
      } as never,
      'wip-key', null, null,
    )).rejects.toThrow('quantity is required for WIP, WIP transfer and rework events');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires an explicit target operation and positive quantity before starting WIP transfer', async () => {
    await expect(service.reportOperationEvent(
      USER, TENANT, FACTORY, WORK_ORDER, OPERATION,
      {
        command: 'WIP_TRANSFERRED',
        quantity: 4,
        expected_work_order_version: 1,
        expected_operation_version: 1,
      } as never,
      'wip-transfer-missing-target', null, null,
    )).rejects.toThrow('target_operation_id is required for WIP transfer');

    await expect(service.reportOperationEvent(
      USER, TENANT, FACTORY, WORK_ORDER, OPERATION,
      {
        command: 'WIP_TRANSFERRED',
        quantity: 0,
        target_operation_id: '7ffb7604-2066-4e94-8b9f-7bfb1cbef115',
        expected_work_order_version: 1,
        expected_operation_version: 1,
      } as never,
      'wip-transfer-zero', null, null,
    )).rejects.toThrow('WIP transfer quantity must be greater than zero');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects zero quantity as rework while zero remains a valid WIP-clear value', async () => {
    await expect(service.reportOperationEvent(
      USER, TENANT, FACTORY, WORK_ORDER, OPERATION,
      {
        command: 'REWORK_REPORTED',
        quantity: 0,
        reason: 'Rework verification',
        expected_work_order_version: 1,
        expected_operation_version: 1,
      } as never,
      'rework-key', null, null,
    )).rejects.toThrow('rework quantity must be greater than zero');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('does not accept a zero-quantity output report as production evidence', async () => {
    await expect(service.reportOutput(
      USER, TENANT, FACTORY, WORK_ORDER,
      {
        operation_id: OPERATION,
        expected_work_order_version: 1,
        expected_operation_version: 1,
        good_quantity: 0,
        scrap_quantity: 0,
      } as never,
      'output-key', null, null,
    )).rejects.toThrow('good_quantity and scrap_quantity cannot both be zero');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires device evidence for machine-originated production output reports', async () => {
    await expect(service.reportOutput(
      USER, TENANT, FACTORY, WORK_ORDER,
      {
        operation_id: OPERATION,
        expected_work_order_version: 1,
        expected_operation_version: 1,
        good_quantity: 10,
        scrap_quantity: 0,
        source: 'PLC',
      } as never,
      'plc-output-42', null, null,
    )).rejects.toThrow('device_id is required when event source is PLC');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a cancellation reason even for an unstarted work order', async () => {
    await expect(service.transitionWorkOrder(
      USER, TENANT, FACTORY, WORK_ORDER, 'CANCEL',
      { expected_version: 1 }, 'cancel-key', null, null,
    )).rejects.toThrow('reason is required to cancel a work order');
    expect(database.transaction).not.toHaveBeenCalled();
  });


  it('allocates shared eligible stock and approved PO supply once by order priority without floating-point arithmetic', async () => {
    const firstWorkOrder = '11111111-1111-4111-8111-111111111111';
    const secondWorkOrder = '22222222-2222-4222-8222-222222222222';
    const requirementOne = '33333333-3333-4333-8333-333333333333';
    const requirementTwo = '44444444-4444-4444-8444-444444444444';
    const itemId = '55555555-5555-4555-8555-555555555555';
    const query = jest.fn();
    query.mockResolvedValueOnce({ rows: [
      {
        work_order_id: firstWorkOrder, work_order_number: 'WO-001', work_order_status: 'IN_PROGRESS',
        due_date: '2026-11-10', planned_start_date: '2026-11-08', priority: 1, created_at: '2026-11-08T08:00:00Z',
        requirement_id: requirementOne, bom_line_id: '66666666-6666-4666-8666-666666666666',
        line_number: 1, component_item_id: itemId, component_sku: 'MAT-1', component_name: 'Material',
        component_unit: 'PCS', required_quantity: '5.0000', allocated_quantity: '1.0000', consumed_quantity: '1.0000',
      },
      {
        work_order_id: secondWorkOrder, work_order_number: 'WO-002', work_order_status: 'RELEASED',
        due_date: '2026-11-12', planned_start_date: '2026-11-09', priority: 2, created_at: '2026-11-08T09:00:00Z',
        requirement_id: requirementTwo, bom_line_id: '77777777-7777-4777-8777-777777777777',
        line_number: 1, component_item_id: itemId, component_sku: 'MAT-1', component_name: 'Material',
        component_unit: 'PCS', required_quantity: '4.0000', allocated_quantity: '0.0000', consumed_quantity: '0.0000',
      },
    ] });
    query.mockResolvedValueOnce({ rows: [{
      item_id: itemId, inventory_unit: 'PCS', status: 'ACTIVE', allocation_policy: 'FIFO',
      require_traceability: false, has_identity: false, eligible_on_hand_free_quantity: '4.0000',
      as_of_date: '2026-11-08',
    }] });
    query.mockResolvedValueOnce({ rows: [
      { item_id: itemId, inventory_unit: 'PCS', purchase_order_id: '88888888-8888-4888-8888-888888888888',
        purchase_order_number: 'PO-001', purchase_order_line_id: '99999999-9999-4999-8999-999999999991',
        expected_delivery_date: '2026-11-09', open_quantity: '2.0000', unit_compatible: true },
      { item_id: itemId, inventory_unit: 'PCS', purchase_order_id: '88888888-8888-4888-8888-888888888888',
        purchase_order_number: 'PO-002', purchase_order_line_id: '99999999-9999-4999-8999-999999999992',
        expected_delivery_date: '2026-11-15', open_quantity: '3.0000', unit_compatible: true },
      { item_id: itemId, inventory_unit: 'PCS', purchase_order_id: '88888888-8888-4888-8888-888888888888',
        purchase_order_number: 'PO-003', purchase_order_line_id: '99999999-9999-4999-8999-999999999993',
        expected_delivery_date: null, open_quantity: '2.0000', unit_compatible: true },
      { item_id: itemId, inventory_unit: 'PCS', purchase_order_id: '88888888-8888-4888-8888-888888888888',
        purchase_order_number: 'PO-004', purchase_order_line_id: '99999999-9999-4999-8999-999999999994',
        expected_delivery_date: '2026-11-10', open_quantity: '9.0000', unit_compatible: false },
    ] });
    const client = { query };
    database.transaction.mockImplementation(async (...args: unknown[]) => {
      const callback = args[1] as (db: typeof client) => Promise<unknown>;
      return callback(client);
    });

    const result = await service.getMaterialShortageRadar(USER, TENANT, FACTORY, 50);
    const rows = result.items as Array<Record<string, unknown>>;
    expect(database.transaction).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: USER, isolationLevel: 'REPEATABLE READ', readOnly: true },
      expect.any(Function),
    );
    expect(query).toHaveBeenCalledTimes(3);
    expect(result.work_order_count).toBe(2);
    expect(result.requirement_count).toBe(2);
    expect(rows[0]).toMatchObject({
      work_order_id: firstWorkOrder,
      required_quantity: '5.0000',
      allocated_quantity: '1.0000',
      consumed_quantity: '1.0000',
      unfulfilled_quantity: '3.0000',
      eligible_on_hand_pool_quantity: '4.0000',
      projected_on_hand_quantity: '3.0000',
      approved_po_open_pool_quantity: '7.0000',
      projected_incoming_quantity: '0.0000',
      projected_shortage_quantity: '0.0000',
      material_ready_basis: 'ELIGIBLE_ON_HAND_AND_EXISTING_RESERVATIONS',
      projected_material_ready_date: '2026-11-08',
    });
    expect(rows[1]).toMatchObject({
      work_order_id: secondWorkOrder,
      required_quantity: '4.0000',
      unfulfilled_quantity: '4.0000',
      projected_on_hand_quantity: '1.0000',
      projected_incoming_quantity: '3.0000',
      projected_shortage_quantity: '0.0000',
      incoming_unit_mismatch_line_count: 1,
      shortage_by_due_date_quantity: '1.0000',
      shortage_date: '2026-11-12',
      projected_material_ready_date: '2026-11-15',
      material_ready_basis: 'DATED_APPROVED_PO_SUPPLY',
    });
  });

  it('preserves four-decimal quantities and excludes late or undated PO supply from earlier due-date exposure', async () => {
    const higherPriorityWorkOrder = '11111111-1111-4111-8111-111111111111';
    const earlierDueWorkOrder = '22222222-2222-4222-8222-222222222222';
    const itemId = '55555555-5555-4555-8555-555555555555';
    const query = jest.fn();
    query.mockResolvedValueOnce({ rows: [
      {
        work_order_id: higherPriorityWorkOrder, work_order_number: 'WO-PRIORITY',
        work_order_status: 'IN_PROGRESS', due_date: '2026-11-20',
        planned_start_date: '2026-11-08', priority: 1, created_at: '2026-11-08T08:00:00Z',
        requirement_id: '33333333-3333-4333-8333-333333333333',
        bom_line_id: '66666666-6666-4666-8666-666666666666',
        line_number: 1, component_item_id: itemId, component_sku: 'MAT-DEC',
        component_name: 'Decimal material', component_unit: 'KG',
        required_quantity: '0.3001', allocated_quantity: '0.0001', consumed_quantity: '0.1000',
      },
      {
        work_order_id: earlierDueWorkOrder, work_order_number: 'WO-EARLIER-DUE',
        work_order_status: 'RELEASED', due_date: '2026-11-10',
        planned_start_date: '2026-11-09', priority: 2, created_at: '2026-11-08T09:00:00Z',
        requirement_id: '44444444-4444-4444-8444-444444444444',
        bom_line_id: '77777777-7777-4777-8777-777777777777',
        line_number: 1, component_item_id: itemId, component_sku: 'MAT-DEC',
        component_name: 'Decimal material', component_unit: 'KG',
        required_quantity: '0.4000', allocated_quantity: '0.0000', consumed_quantity: '0.0000',
      },
    ] });
    query.mockResolvedValueOnce({ rows: [{
      item_id: itemId, inventory_unit: 'KG', status: 'ACTIVE', allocation_policy: 'FIFO',
      require_traceability: false, has_identity: false,
      eligible_on_hand_free_quantity: '0.1501', as_of_date: '2026-11-08',
    }] });
    query.mockResolvedValueOnce({ rows: [
      {
        item_id: itemId, inventory_unit: 'KG',
        purchase_order_id: '88888888-8888-4888-8888-888888888888',
        purchase_order_number: 'PO-LATE', purchase_order_line_id: '99999999-9999-4999-8999-999999999991',
        expected_delivery_date: '2026-11-15', open_quantity: '0.1001', unit_compatible: true,
      },
      {
        item_id: itemId, inventory_unit: 'KG',
        purchase_order_id: '88888888-8888-4888-8888-888888888888',
        purchase_order_number: 'PO-UNDATED', purchase_order_line_id: '99999999-9999-4999-8999-999999999992',
        expected_delivery_date: null, open_quantity: '0.0500', unit_compatible: true,
      },
    ] });
    const client = { query };
    database.transaction.mockImplementation(async (...args: unknown[]) => {
      const callback = args[1] as (db: typeof client) => Promise<unknown>;
      return callback(client);
    });

    const result = await service.getMaterialShortageRadar(USER, TENANT, FACTORY, 50);
    const rows = result.items as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      work_order_id: higherPriorityWorkOrder,
      unfulfilled_quantity: '0.2000',
      eligible_on_hand_pool_quantity: '0.1501',
      projected_on_hand_quantity: '0.1501',
      projected_incoming_quantity: '0.0499',
      projected_shortage_quantity: '0.0000',
      shortage_by_due_date_quantity: '0.0000',
      projected_material_ready_date: '2026-11-15',
      material_ready_basis: 'DATED_APPROVED_PO_SUPPLY',
    });
    expect(rows[1]).toMatchObject({
      work_order_id: earlierDueWorkOrder,
      unfulfilled_quantity: '0.4000',
      projected_on_hand_quantity: '0.0000',
      projected_incoming_quantity: '0.1002',
      projected_shortage_quantity: '0.2998',
      shortage_by_due_date_quantity: '0.4000',
      shortage_date: '2026-11-10',
      projected_material_ready_date: null,
      material_ready_basis: 'PROJECTED_SHORTAGE',
    });
    expect(database.transaction).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: USER, isolationLevel: 'REPEATABLE READ', readOnly: true },
      expect.any(Function),
    );
  });

  it('rejects material radar limits outside the supported 1–100 range before opening a transaction', async () => {
    await expect(service.getMaterialShortageRadar(USER, TENANT, FACTORY, 0))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getMaterialShortageRadar(USER, TENANT, FACTORY, 101))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects malformed factory scope before opening a read-only radar transaction', async () => {
    await expect(service.getMaterialShortageRadar('bad-user', TENANT, FACTORY)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

});
