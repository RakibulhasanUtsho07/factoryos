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
    )).rejects.toThrow('quantity is required for WIP and rework events');
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
});
