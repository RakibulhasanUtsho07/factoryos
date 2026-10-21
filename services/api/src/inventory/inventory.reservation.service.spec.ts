import { ConflictException } from '@nestjs/common';
import { jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { CreateInventoryReservationDto } from './dto/create-inventory-reservation.dto';
import { TransitionInventoryReservationDto } from './dto/transition-inventory-reservation.dto';
import { InventoryReservationService } from './inventory.reservation.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const ITEM_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';
const RESERVATION_ID = '522ecb02-3e23-4416-9d13-ed9dcd780b81';
const ORDER_ID = '0f2e4f11-d513-4c27-8c0b-e2c4ab55e1f1';
const ORDER_LINE_ID = '27c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a';
const BIN_A_ID = '06a4aacf-09f7-43af-8f18-f65a3c0e14b4';
const BIN_B_ID = 'bf84203c-5b31-43f3-8e6a-dc2bcbf2a2a2';
const TRACE_ID = 'f7168be2-1b73-42b3-a930-72c31b2d6050';

type QueryResponse = { rows: QueryResultRow[] };

describe('InventoryReservationService', () => {
  let service: InventoryReservationService;
  let client: { query: ReturnType<typeof jest.fn> };
  let database: { transaction: ReturnType<typeof jest.fn>; query: ReturnType<typeof jest.fn> };
  let audit: { record: ReturnType<typeof jest.fn> };

  beforeEach(() => {
    client = { query: jest.fn() };
    database = {
      transaction: jest.fn(async (first: unknown, second?: unknown) => {
        const callback = typeof first === 'function' ? first : second;
        if (typeof callback !== 'function') throw new Error('transaction callback missing');
        return (callback as (clientArg: typeof client) => Promise<unknown>)(client);
      }),
      query: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue('audit-id') };
    service = new InventoryReservationService(
      database as unknown as DatabaseService,
      audit as unknown as AuditService,
    );
  });

  function row(overrides: Record<string, unknown> = {}) {
    const status = String(overrides.status ?? 'RESERVED');
    const quantity = String(overrides.quantity ?? '2.0000');
    return {
      id: RESERVATION_ID,
      tenant_id: TENANT_ID,
      factory_id: FACTORY_ID,
      item_id: ITEM_ID,
      location_id: null,
      quantity,
      remaining_quantity: status === 'RESERVED' ? quantity : '0.0000',
      consumed_quantity: status === 'CONSUMED' ? quantity : '0.0000',
      released_quantity: status === 'RELEASED' ? quantity : '0.0000',
      status,
      idempotency_key: 'reserve-1',
      request_hash: createHash('sha256').update(JSON.stringify({
        itemId: ITEM_ID,
        locationId: null,
        quantity: '2.0000',
        referenceType: null,
        referenceId: null,
        notes: null,
      })).digest('hex'),
      reference_type: null,
      reference_id: null,
      notes: null,
      transition_idempotency_key: null,
      transition_request_hash: null,
      consumed_movement_id: null,
      created_by_user_id: USER_ID,
      correlation_id: TRACE_ID,
      created_at: '2026-10-16T00:00:00.000Z',
      updated_at: '2026-10-16T00:00:00.000Z',
      ...overrides,
    } as unknown as QueryResultRow;
  }

  const queryRows = (rows: unknown[]): QueryResponse => ({
    rows: rows as QueryResultRow[],
  });

  it('reserves only available stock and writes a durable outbox event', async () => {
    client.query
      .mockResolvedValueOnce(queryRows([]))
      .mockResolvedValueOnce(queryRows([{ id: ITEM_ID, status: 'ACTIVE' }]))
      .mockResolvedValueOnce(queryRows([]))
      .mockResolvedValueOnce(queryRows([{ allocation_policy: 'FIFO', has_lot: false, has_serial: false, has_identity: false }]))
      .mockResolvedValueOnce(queryRows([{ quantity_on_hand: '10.0000', quantity_reserved: '2.0000' }]))
      .mockResolvedValueOnce(queryRows([row()]))
      .mockResolvedValueOnce(queryRows([]));

    const result = await service.createReservation(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID,
      { quantity: 2 } as CreateInventoryReservationDto,
      'reserve-1', TRACE_ID, TRACE_ID,
    );

    expect(result).toMatchObject({ id: RESERVATION_ID, status: 'RESERVED', quantity: '2.0000', replayed: false });
    expect(String(client.query.mock.calls[4]?.[0])).toContain('quantity_on_hand - quantity_reserved >= $1::numeric');
    expect(String(client.query.mock.calls[5]?.[0])).toContain('INSERT INTO inventory_reservations');
    expect(String(client.query.mock.calls[6]?.[0])).toContain('INSERT INTO outbox_events');
    expect(client.query.mock.calls[6]?.[1]).toContain('INVENTORY.STOCK_RESERVED');
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('rejects a reservation larger than available stock without inserting a reservation', async () => {
    client.query
      .mockResolvedValueOnce(queryRows([]))
      .mockResolvedValueOnce(queryRows([{ id: ITEM_ID, status: 'ACTIVE' }]))
      .mockResolvedValueOnce(queryRows([]))
      .mockResolvedValueOnce(queryRows([]));

    await expect(service.createReservation(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID,
      { quantity: 11 } as CreateInventoryReservationDto,
      'reserve-too-much', TRACE_ID, TRACE_ID,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO inventory_reservations'))).toBe(false);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('replays the same create request but rejects key reuse with a different payload', async () => {
    const expectedHash = createHash('sha256').update(JSON.stringify({
      itemId: ITEM_ID,
      locationId: null,
      quantity: '2.0000',
      referenceType: null,
      referenceId: null,
      notes: null,
    })).digest('hex');
    client.query.mockResolvedValueOnce(queryRows([row({ request_hash: expectedHash })]));

    const replay = await service.createReservation(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID,
      { quantity: 2 } as CreateInventoryReservationDto,
      'reserve-1', TRACE_ID, TRACE_ID,
    );
    expect(replay.replayed).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();

    client.query.mockReset();
    client.query.mockResolvedValueOnce(queryRows([row({ request_hash: 'f'.repeat(64) })]));
    await expect(service.createReservation(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID,
      { quantity: 2 } as CreateInventoryReservationDto,
      'reserve-1', TRACE_ID, TRACE_ID,
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('consumes a reservation atomically with an ISSUE movement and durable consumption evidence', async () => {
    const consumedMovementId = randomUUID();
    const consumptionId = randomUUID();
    client.query
      .mockResolvedValueOnce(queryRows([{ id: ITEM_ID, status: 'ACTIVE' }]))
      .mockResolvedValueOnce(queryRows([row()]))
      .mockResolvedValueOnce(queryRows([])) // no prior issue with this idempotency key
      .mockResolvedValueOnce(queryRows([])) // clear the transaction-local location
      .mockResolvedValueOnce(queryRows([{ quantity_on_hand: '8.0000', quantity_reserved: '0.0000' }]))
      .mockResolvedValueOnce(queryRows([{ id: consumedMovementId, quantity_after: '8.0000' }]))
      .mockResolvedValueOnce(queryRows([{ id: consumptionId }]))
      .mockResolvedValueOnce(queryRows([])) // no traceability allocation on the legacy test fixture
      .mockResolvedValueOnce(queryRows([{ present: false }])) // no tracked material identity
      .mockResolvedValueOnce(queryRows([])) // issue outbox
      .mockResolvedValueOnce(queryRows([row({
        status: 'CONSUMED', remaining_quantity: '0.0000', consumed_quantity: '2.0000',
        transition_idempotency_key: 'consume-1',
        transition_request_hash: createHash('sha256').update(JSON.stringify({
          reservationId: RESERVATION_ID, targetStatus: 'CONSUMED',
        })).digest('hex'),
        consumed_movement_id: consumedMovementId,
      })]));

    const result = await service.transitionReservation(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID, RESERVATION_ID,
      { target_status: 'CONSUMED' } as TransitionInventoryReservationDto,
      'consume-1', TRACE_ID, TRACE_ID,
    );

    expect(result).toMatchObject({
      id: RESERVATION_ID, status: 'CONSUMED',
      consumed_movement_id: consumedMovementId, replayed: false,
      remaining_quantity: '0.0000', consumed_quantity: '2.0000',
    });
    expect(String(client.query.mock.calls[4]?.[0])).toContain('quantity_on_hand = quantity_on_hand - $1::numeric');
    expect(String(client.query.mock.calls[5]?.[0])).toContain("'ISSUE'");
    expect(String(client.query.mock.calls[6]?.[0])).toContain('INSERT INTO inventory_reservation_consumptions');
    expect(String(client.query.mock.calls[9]?.[0])).toContain('INSERT INTO outbox_events');
    expect(String(client.query.mock.calls[10]?.[0])).toContain("status = 'RESERVED'");
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('releases only the remaining reservation quantity without reducing on-hand stock', async () => {
    client.query
      .mockResolvedValueOnce(queryRows([{ id: ITEM_ID, status: 'ACTIVE' }]))
      .mockResolvedValueOnce(queryRows([row({ quantity: '5.0000', remaining_quantity: '3.0000', consumed_quantity: '2.0000' })]))
      .mockResolvedValueOnce(queryRows([{ quantity_on_hand: '8.0000', quantity_reserved: '3.0000' }]))
      .mockResolvedValueOnce(queryRows([])) // untracked legacy reservation has no trace allocations
      .mockResolvedValueOnce(queryRows([row({
        quantity: '5.0000', status: 'RELEASED', remaining_quantity: '0.0000',
        consumed_quantity: '2.0000', released_quantity: '3.0000',
        transition_idempotency_key: 'release-1',
        transition_request_hash: createHash('sha256').update(JSON.stringify({
          reservationId: RESERVATION_ID, targetStatus: 'RELEASED',
        })).digest('hex'),
      })]))
      .mockResolvedValueOnce(queryRows([])); // release outbox

    const result = await service.transitionReservation(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID, RESERVATION_ID,
      { target_status: 'RELEASED' } as TransitionInventoryReservationDto,
      'release-1', TRACE_ID, TRACE_ID,
    );

    expect(result).toMatchObject({ status: 'RELEASED', remaining_quantity: '0.0000', consumed_quantity: '2.0000', released_quantity: '3.0000' });
    expect(String(client.query.mock.calls[2]?.[0])).toContain('quantity_reserved = quantity_reserved - $1::numeric');
    expect(client.query.mock.calls[2]?.[1]?.[0]).toBe('3.0000');
    expect(String(client.query.mock.calls[2]?.[0])).not.toContain('quantity_on_hand = quantity_on_hand -');
    expect(String(client.query.mock.calls[5]?.[0])).toContain('INSERT INTO outbox_events');
  });

  it('partially consumes a reservation once and keeps the remainder reserved', async () => {
    const movementId = randomUUID();
    const consumptionId = randomUUID();
    const requestHash = createHash('sha256').update(JSON.stringify({
      reservationId: RESERVATION_ID.toLowerCase(),
      targetStatus: 'CONSUMED',
      quantity: '2.0000',
    })).digest('hex');
    client.query
      .mockResolvedValueOnce(queryRows([{ id: ITEM_ID, status: 'ACTIVE' }]))
      .mockResolvedValueOnce(queryRows([row({ quantity: '5.0000', remaining_quantity: '5.0000' })]))
      .mockResolvedValueOnce(queryRows([]))
      .mockResolvedValueOnce(queryRows([])) // transaction-local location
      .mockResolvedValueOnce(queryRows([{ quantity_on_hand: '8.0000', quantity_reserved: '3.0000' }]))
      .mockResolvedValueOnce(queryRows([{ id: movementId, quantity_after: '8.0000' }]))
      .mockResolvedValueOnce(queryRows([{ id: consumptionId }]))
      .mockResolvedValueOnce(queryRows([])) // no lot mapping on this untracked fixture
      .mockResolvedValueOnce(queryRows([{ present: false }]))
      .mockResolvedValueOnce(queryRows([])) // issue outbox
      .mockResolvedValueOnce(queryRows([row({
        quantity: '5.0000', remaining_quantity: '3.0000', consumed_quantity: '2.0000',
        status: 'RESERVED', transition_idempotency_key: 'consume-partial-1',
        transition_request_hash: requestHash, consumed_movement_id: null,
      })]));

    const result = await service.transitionReservation(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID, RESERVATION_ID,
      { target_status: 'CONSUMED', quantity: 2 } as TransitionInventoryReservationDto,
      'consume-partial-1', TRACE_ID, TRACE_ID,
    );

    expect(result).toMatchObject({
      status: 'RESERVED',
      quantity: '5.0000',
      remaining_quantity: '3.0000',
      consumed_quantity: '2.0000',
      released_quantity: '0.0000',
      consumed_quantity_this_request: '2.0000',
      consumption_movement_id: movementId,
    });
    expect(String(client.query.mock.calls[6]?.[0])).toContain('inventory_reservation_consumptions');
    expect(client.query.mock.calls[6]?.[1]).toContain('2.0000');
    expect(String(client.query.mock.calls[10]?.[0])).toContain('UPDATE inventory_reservations');
    expect(client.query.mock.calls[10]?.[1]).toContain('3.0000');
  });

  it('replays duplicate partial issue requests without touching the stock ledger again', async () => {
    const movementId = randomUUID();
    const quantity = '2.0000';
    const requestHash = createHash('sha256').update(JSON.stringify({
      reservationId: RESERVATION_ID.toLowerCase(),
      targetStatus: 'CONSUMED',
      quantity,
    })).digest('hex');
    client.query
      .mockResolvedValueOnce(queryRows([{ id: ITEM_ID, status: 'ACTIVE' }]))
      .mockResolvedValueOnce(queryRows([row({
        quantity: '5.0000', remaining_quantity: '3.0000', consumed_quantity: '2.0000',
        status: 'RESERVED', transition_idempotency_key: 'consume-partial-1',
        transition_request_hash: requestHash,
      })]))
      .mockResolvedValueOnce(queryRows([{
        id: randomUUID(), request_hash: requestHash, movement_id: movementId, quantity,
      }]));

    const result = await service.transitionReservation(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID, RESERVATION_ID,
      { target_status: 'CONSUMED', quantity: 2 } as TransitionInventoryReservationDto,
      'consume-partial-1', TRACE_ID, TRACE_ID,
    );

    expect(result).toMatchObject({
      status: 'RESERVED', remaining_quantity: '3.0000',
      consumed_quantity: '2.0000', replayed: true,
      consumption_movement_id: movementId, consumed_quantity_this_request: quantity,
    });
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(String(client.query.mock.calls[0]?.[0])).toContain('inventory_items');
    expect(String(client.query.mock.calls[1]?.[0])).toContain('inventory_reservations');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('parses four-decimal quantities without floating-point rounding drift', () => {
    const parser = (service as unknown as { decimalToUnits(value: string): bigint }).decimalToUnits.bind(service);
    const formatter = (service as unknown as { unitsToDecimal(value: bigint): string }).unitsToDecimal.bind(service);
    expect(parser('123456789.0123')).toBe(1234567890123n);
    expect(formatter(1234567890123n)).toBe('123456789.0123');
    expect(() => parser('0.00001')).toThrow('four-decimal value');
  });

  it('allocates FEFO from the earliest unexpired lot and excludes held stock', async () => {
    const earliestLot = randomUUID();
    const laterLot = randomUUID();
    client.query
      .mockResolvedValueOnce(queryRows([{
        allocation_policy: 'FEFO', has_lot: true, has_serial: false, has_identity: true,
      }]))
      .mockResolvedValueOnce(queryRows([
        {
          traceability_unit_id: earliestLot, location_id: BIN_A_ID,
          unit_type: 'LOT', unit_code: 'LOT-EARLY', expires_at: '2026-11-01',
          received_at: '2026-10-01', quantity_on_hand: '2.0000', quantity_reserved: '0.0000',
        },
        {
          traceability_unit_id: laterLot, location_id: BIN_B_ID,
          unit_type: 'LOT', unit_code: 'LOT-LATER', expires_at: '2027-01-01',
          received_at: '2026-10-02', quantity_on_hand: '6.0000', quantity_reserved: '0.0000',
        },
      ]));

    const plan = await (service as unknown as {
      planTraceabilityAllocations(clientArg: typeof client, input: {
        tenantId: string; factoryId: string; itemId: string; quantity: string;
      }): Promise<{ enforced: boolean; policy: string; allocations: Array<{ traceabilityUnitId: string; quantity: string }> }>;
    }).planTraceabilityAllocations(client as never, {
      tenantId: TENANT_ID, factoryId: FACTORY_ID, itemId: ITEM_ID, quantity: '3.0000',
    });

    expect(plan).toMatchObject({
      enforced: true, policy: 'FEFO',
      allocations: [
        { traceabilityUnitId: earliestLot, quantity: '2.0000' },
        { traceabilityUnitId: laterLot, quantity: '1.0000' },
      ],
    });
    const eligibilitySql = String(client.query.mock.calls[1]?.[0]);
    expect(eligibilitySql).toContain("tu.expires_at >= CURRENT_DATE");
    expect(eligibilitySql).toContain("'QUARANTINED'");
    expect(eligibilitySql).toContain("'DAMAGED'");
    expect(eligibilitySql).toContain("qh.status = 'ACTIVE'");
  });

  it('allocates the first released production work-order BOM requirement by FEFO across eligible bins', async () => {
    const workOrderId = randomUUID();
    const requirementId = randomUUID();
    const bomLineId = randomUUID();
    const lotA = randomUUID();
    const lotB = randomUUID();
    const reservationA = randomUUID();
    const reservationB = randomUUID();
    const notes = 'Reserved for work order WO-FIRST-FEFO BOM line 1';
    client.query
      .mockResolvedValueOnce(queryRows([{ id: ITEM_ID, status: 'ACTIVE', unit: 'EA' }]))
      .mockResolvedValueOnce(queryRows([{ quantity_on_hand: '10.0000', quantity_reserved: '0.0000' }]))
      .mockResolvedValueOnce(queryRows([{
        allocation_policy: 'FEFO', require_traceability: true,
        has_lot: true, has_serial: false, has_identity: true,
      }]))
      .mockResolvedValueOnce(queryRows([
        {
          traceability_unit_id: lotA, location_id: BIN_A_ID,
          unit_type: 'LOT', unit_code: 'LOT-EXPIRING-FIRST', expires_at: '2026-11-01',
          received_at: '2026-10-01', quantity_on_hand: '2.0000', quantity_reserved: '0.0000',
        },
        {
          traceability_unit_id: lotB, location_id: BIN_B_ID,
          unit_type: 'LOT', unit_code: 'LOT-EXPIRING-LATER', expires_at: '2027-01-01',
          received_at: '2026-10-02', quantity_on_hand: '4.0000', quantity_reserved: '0.0000',
        },
      ]))
      .mockResolvedValueOnce(queryRows([
        {
          location_id: BIN_A_ID, location_code: 'A-01', is_default: false,
          location_type: 'BIN', quantity_on_hand: '2.0000', quantity_reserved: '0.0000',
        },
        {
          location_id: BIN_B_ID, location_code: 'A-02', is_default: false,
          location_type: 'BIN', quantity_on_hand: '4.0000', quantity_reserved: '0.0000',
        },
      ]))
      .mockResolvedValueOnce(queryRows([{ quantity_on_hand: '10.0000', quantity_reserved: '3.0000' }]))
      .mockResolvedValueOnce(queryRows([{ location_id: BIN_A_ID }]))
      .mockResolvedValueOnce(queryRows([row({
        id: reservationA, location_id: BIN_A_ID, quantity: '2.0000',
        reference_type: 'WORK_ORDER_MATERIAL', reference_id: workOrderId,
        notes, idempotency_key: `work-order:${workOrderId}:bom:${bomLineId}:bin:${BIN_A_ID}:reserve:v1`,
      })]))
      .mockResolvedValueOnce(queryRows([{ id: randomUUID() }])) // reserve lot A quantity
      .mockResolvedValueOnce(queryRows([])) // bind lot A to reservation A
      .mockResolvedValueOnce(queryRows([])) // work-order reservation outbox
      .mockResolvedValueOnce(queryRows([{ location_id: BIN_B_ID }]))
      .mockResolvedValueOnce(queryRows([row({
        id: reservationB, location_id: BIN_B_ID, quantity: '1.0000',
        reference_type: 'WORK_ORDER_MATERIAL', reference_id: workOrderId,
        notes, idempotency_key: `work-order:${workOrderId}:bom:${bomLineId}:bin:${BIN_B_ID}:reserve:v1`,
      })]))
      .mockResolvedValueOnce(queryRows([{ id: randomUUID() }])) // reserve lot B quantity
      .mockResolvedValueOnce(queryRows([])) // bind lot B to reservation B
      .mockResolvedValueOnce(queryRows([])); // work-order reservation outbox

    const result = await service.reserveWorkOrderMaterialRequirement(client as never, {
      userId: USER_ID, tenantId: TENANT_ID, factoryId: FACTORY_ID,
      workOrderId, workOrderNumber: 'WO-FIRST-FEFO',
      requirementId, bomLineId, itemId: ITEM_ID, itemUnit: 'EA',
      lineNumber: 1, quantity: '3.0000', correlationId: TRACE_ID,
    });

    expect(result).toEqual([
      { reservationId: reservationA, locationId: BIN_A_ID, quantity: '2.0000' },
      { reservationId: reservationB, locationId: BIN_B_ID, quantity: '1.0000' },
    ]);
    expect(client.query.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO inventory_reservation_traceability_allocations'))).toHaveLength(2);
    expect(client.query.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO inventory_reservations'))).toHaveLength(2);
    expect(String(client.query.mock.calls[2]?.[0])).toContain('inventory_material_allocation_policies');
    expect(String(client.query.mock.calls[3]?.[0])).toContain("tu.expires_at >= CURRENT_DATE");
  });

  it('posts accepted finished goods as an inventory receipt with durable outbox evidence', async () => {
    const workOrderId = randomUUID();
    const reportId = randomUUID();
    const movementId = randomUUID();
    client.query
      .mockResolvedValueOnce(queryRows([{ id: ITEM_ID, unit: 'EA', status: 'ACTIVE' }]))
      .mockResolvedValueOnce(queryRows([])) // reset the transaction-local location to UNASSIGNED
      .mockResolvedValueOnce(queryRows([{ quantity_on_hand: '62.5000' }]))
      .mockResolvedValueOnce(queryRows([{ id: movementId, quantity_after: '62.5000' }]))
      .mockResolvedValueOnce(queryRows([])); // inventory outbox event

    const result = await service.postFinishedGoodsOutputReceipt(client as never, {
      userId: USER_ID,
      tenantId: TENANT_ID,
      factoryId: FACTORY_ID,
      workOrderId,
      workOrderNumber: 'WO-OUTPUT-001',
      orderId: randomUUID(),
      orderNumber: 'ORD-OUTPUT-001',
      orderLineId: ORDER_LINE_ID,
      finishedItemId: ITEM_ID,
      productionReportId: reportId,
      goodQuantity: '12.5000',
      scrapQuantity: '1.0000',
      yieldPercentage: '92.5926',
      cumulativeYieldPercentage: '92.5926',
      correlationId: TRACE_ID,
    });

    expect(result).toEqual({ movementId, quantityAfter: '62.5000' });
    expect(String(client.query.mock.calls[2]?.[0])).toContain('UPDATE inventory_stock_balances');
    expect(client.query.mock.calls[2]?.[1]).toContain('12.5000');
    expect(String(client.query.mock.calls[3]?.[0])).toContain('INSERT INTO inventory_movements');
    expect(String(client.query.mock.calls[3]?.[0])).toContain("'PRODUCTION_OUTPUT'");
    expect(client.query.mock.calls[4]?.[1]?.[3]).toBe('INVENTORY.STOCK_RECEIVED');
    const outboxPayload = JSON.parse(String(client.query.mock.calls[4]?.[1]?.[7])) as {
      purpose: string;
      good_quantity: string;
      scrap_quantity: string;
      yield_percentage: string;
      movement: { quantity: string; reference_id: string };
    };
    expect(outboxPayload).toMatchObject({
      purpose: 'PRODUCTION_OUTPUT',
      good_quantity: '12.5000',
      scrap_quantity: '1.0000',
      yield_percentage: '92.5926',
      movement: { quantity: '12.5000', reference_id: reportId },
    });
  });

  it('does not create a finished-good stock receipt when reported output is entirely scrap', async () => {
    const result = await service.postFinishedGoodsOutputReceipt(client as never, {
      userId: USER_ID,
      tenantId: TENANT_ID,
      factoryId: FACTORY_ID,
      workOrderId: randomUUID(),
      workOrderNumber: 'WO-SCRAP-ONLY',
      orderId: randomUUID(),
      orderNumber: 'ORD-SCRAP-ONLY',
      orderLineId: ORDER_LINE_ID,
      finishedItemId: ITEM_ID,
      productionReportId: randomUUID(),
      goodQuantity: '0.0000',
      scrapQuantity: '2.0000',
      yieldPercentage: '0.0000',
      cumulativeYieldPercentage: '0.0000',
      correlationId: TRACE_ID,
    });

    expect(result).toEqual({ movementId: null, quantityAfter: null });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('fails closed when the finished-good inventory item is disabled', async () => {
    client.query.mockResolvedValueOnce(queryRows([{ id: ITEM_ID, unit: 'EA', status: 'DISABLED' }]));

    await expect(service.postFinishedGoodsOutputReceipt(client as never, {
      userId: USER_ID,
      tenantId: TENANT_ID,
      factoryId: FACTORY_ID,
      workOrderId: randomUUID(),
      workOrderNumber: 'WO-DISABLED-FG',
      orderId: randomUUID(),
      orderNumber: 'ORD-DISABLED-FG',
      orderLineId: ORDER_LINE_ID,
      finishedItemId: ITEM_ID,
      productionReportId: randomUUID(),
      goodQuantity: '1.0000',
      scrapQuantity: '0.0000',
      yieldPercentage: '100.0000',
      cumulativeYieldPercentage: '100.0000',
      correlationId: TRACE_ID,
    })).rejects.toThrow('Finished-good inventory item must remain active');

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE inventory_stock_balances'))).toBe(false);
  });

  it('requires an idempotency key for reservation creation', async () => {
    await expect(service.createReservation(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID,
      { quantity: 1 } as CreateInventoryReservationDto,
      '   ', TRACE_ID, TRACE_ID,
    )).rejects.toThrow('Idempotency-Key is required');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('does not permit another transition after a reservation is terminal', async () => {
    client.query
      .mockResolvedValueOnce(queryRows([{ id: ITEM_ID, status: 'ACTIVE' }]))
      .mockResolvedValueOnce(queryRows([row({
        status: 'RELEASED',
        transition_idempotency_key: 'release-1',
        transition_request_hash: createHash('sha256').update(JSON.stringify({
          reservationId: RESERVATION_ID,
          targetStatus: 'RELEASED',
        })).digest('hex'),
      })]))
      .mockResolvedValueOnce(queryRows([])); // idempotency replay lookup precedes terminal-state rejection

    await expect(service.transitionReservation(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID, RESERVATION_ID,
      { target_status: 'CONSUMED' } as TransitionInventoryReservationDto,
      'consume-after-release', TRACE_ID, TRACE_ID,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('replays the same terminal transition without touching stock twice', async () => {
    const transitionHash = createHash('sha256').update(JSON.stringify({
      reservationId: RESERVATION_ID,
      targetStatus: 'RELEASED',
    })).digest('hex');
    client.query
      .mockResolvedValueOnce(queryRows([{ id: ITEM_ID, status: 'ACTIVE' }]))
      .mockResolvedValueOnce(queryRows([row({
        status: 'RELEASED',
        transition_idempotency_key: 'release-1',
        transition_request_hash: transitionHash,
      })]));

    const result = await service.transitionReservation(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID, RESERVATION_ID,
      { target_status: 'RELEASED' } as TransitionInventoryReservationDto,
      'release-1', TRACE_ID, TRACE_ID,
    );

    expect(result).toMatchObject({ status: 'RELEASED', replayed: true });
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(audit.record).not.toHaveBeenCalled();
  });
  it('splits an order-line reservation across multiple bins atomically', async () => {
    const notes = 'Reserved for order ORD-MULTI-BIN (line 1)';
    const hashFor = (locationId: string, quantity: string) => createHash('sha256').update(JSON.stringify({
      itemId: ITEM_ID, locationId, quantity, referenceType: 'ORDER_LINE', referenceId: ORDER_LINE_ID, notes,
    })).digest('hex');

    client.query
      .mockResolvedValueOnce(queryRows([{
        id: ORDER_LINE_ID, line_number: 1, item_id: ITEM_ID, quantity: '5.0000', unit: 'EA',
      }]))
      .mockResolvedValueOnce(queryRows([{ id: ITEM_ID, status: 'ACTIVE', unit: 'EA' }]))
      .mockResolvedValueOnce(queryRows([])) // legacy v1 key
      .mockResolvedValueOnce(queryRows([])) // no pre-existing active allocations
      .mockResolvedValueOnce(queryRows([{ quantity_on_hand: '7.0000', quantity_reserved: '0.0000' }]))
      .mockResolvedValueOnce(queryRows([{ allocation_policy: 'FIFO', has_lot: false, has_serial: false, has_identity: false }]))
      .mockResolvedValueOnce(queryRows([
        {
          location_id: BIN_A_ID, location_code: 'A-01', is_default: false,
          location_type: 'BIN', quantity_on_hand: '3.0000', quantity_reserved: '0.0000',
        },
        {
          location_id: BIN_B_ID, location_code: 'A-02', is_default: false,
          location_type: 'BIN', quantity_on_hand: '4.0000', quantity_reserved: '0.0000',
        },
      ]))
      .mockResolvedValueOnce(queryRows([{ quantity_on_hand: '7.0000', quantity_reserved: '5.0000' }]))
      .mockResolvedValueOnce(queryRows([{ location_id: BIN_A_ID }]))
      .mockResolvedValueOnce(queryRows([row({
        id: randomUUID(), location_id: BIN_A_ID, quantity: '3.0000',
        idempotency_key: `order:${ORDER_ID}:line:${ORDER_LINE_ID}:bin:${BIN_A_ID}:reserve:v2`,
        request_hash: hashFor(BIN_A_ID, '3.0000'),
        reference_type: 'ORDER_LINE', reference_id: ORDER_LINE_ID, notes,
      })]))
      .mockResolvedValueOnce(queryRows([])) // first allocation outbox
      .mockResolvedValueOnce(queryRows([{ location_id: BIN_B_ID }]))
      .mockResolvedValueOnce(queryRows([row({
        id: randomUUID(), location_id: BIN_B_ID, quantity: '2.0000',
        idempotency_key: `order:${ORDER_ID}:line:${ORDER_LINE_ID}:bin:${BIN_B_ID}:reserve:v2`,
        request_hash: hashFor(BIN_B_ID, '2.0000'),
        reference_type: 'ORDER_LINE', reference_id: ORDER_LINE_ID, notes,
      })]))
      .mockResolvedValueOnce(queryRows([])); // second allocation outbox

    const result = await service.applyOrderTransition(client as never, {
      userId: USER_ID, tenantId: TENANT_ID, factoryId: FACTORY_ID,
      orderId: ORDER_ID, orderNumber: 'ORD-MULTI-BIN',
      previousStatus: 'DRAFT', targetStatus: 'CONFIRMED',
      requestId: TRACE_ID, traceId: TRACE_ID,
    });

    expect(result.reservations_created).toBe(2);
    expect(client.query.mock.calls[6]?.[1]).toContain('5.0000');
    expect(client.query.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO inventory_reservations'))).toHaveLength(2);
    expect(client.query.mock.calls.filter((call) => String(call[0]).includes('UPDATE inventory_location_balances'))).toHaveLength(2);
    expect(client.query.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO outbox_events'))).toHaveLength(2);
  });

  it('replays complete multi-bin allocation without reserving stock twice', async () => {
    const notes = 'Reserved for order ORD-MULTI-BIN (line 1)';
    const hashFor = (locationId: string, quantity: string) => createHash('sha256').update(JSON.stringify({
      itemId: ITEM_ID, locationId, quantity, referenceType: 'ORDER_LINE', referenceId: ORDER_LINE_ID, notes,
    })).digest('hex');

    client.query
      .mockResolvedValueOnce(queryRows([{
        id: ORDER_LINE_ID, line_number: 1, item_id: ITEM_ID, quantity: '5.0000', unit: 'EA',
      }]))
      .mockResolvedValueOnce(queryRows([{ id: ITEM_ID, status: 'ACTIVE', unit: 'EA' }]))
      .mockResolvedValueOnce(queryRows([]))
      .mockResolvedValueOnce(queryRows([
        row({
          id: randomUUID(), location_id: BIN_A_ID, quantity: '3.0000',
          idempotency_key: `order:${ORDER_ID}:line:${ORDER_LINE_ID}:bin:${BIN_A_ID}:reserve:v2`,
          request_hash: hashFor(BIN_A_ID, '3.0000'),
          reference_type: 'ORDER_LINE', reference_id: ORDER_LINE_ID, notes,
        }),
        row({
          id: randomUUID(), location_id: BIN_B_ID, quantity: '2.0000',
          idempotency_key: `order:${ORDER_ID}:line:${ORDER_LINE_ID}:bin:${BIN_B_ID}:reserve:v2`,
          request_hash: hashFor(BIN_B_ID, '2.0000'),
          reference_type: 'ORDER_LINE', reference_id: ORDER_LINE_ID, notes,
        }),
      ]));

    const result = await service.applyOrderTransition(client as never, {
      userId: USER_ID, tenantId: TENANT_ID, factoryId: FACTORY_ID,
      orderId: ORDER_ID, orderNumber: 'ORD-MULTI-BIN',
      previousStatus: 'DRAFT', targetStatus: 'CONFIRMED',
      requestId: TRACE_ID, traceId: TRACE_ID,
    });

    expect(result.reservations_created).toBe(0);
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query.mock.calls.some((call) => String(call[0]).includes('UPDATE inventory_stock_balances'))).toBe(false);
    expect(client.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO inventory_reservations'))).toBe(false);
  });

});
