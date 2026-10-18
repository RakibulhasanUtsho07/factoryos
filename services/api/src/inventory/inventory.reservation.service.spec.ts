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
    return {
      id: RESERVATION_ID,
      tenant_id: TENANT_ID,
      factory_id: FACTORY_ID,
      item_id: ITEM_ID,
      location_id: null,
      quantity: '2.0000',
      status: 'RESERVED',
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
      .mockResolvedValueOnce(queryRows([{ quantity_on_hand: '10.0000', quantity_reserved: '2.0000' }]))
      .mockResolvedValueOnce(queryRows([row()]))
      .mockResolvedValueOnce(queryRows([]));

    const result = await service.createReservation(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID,
      { quantity: 2 } as CreateInventoryReservationDto,
      'reserve-1', TRACE_ID, TRACE_ID,
    );

    expect(result).toMatchObject({ id: RESERVATION_ID, status: 'RESERVED', quantity: '2.0000', replayed: false });
    expect(String(client.query.mock.calls[3]?.[0])).toContain('quantity_on_hand - quantity_reserved >= $1::numeric');
    expect(String(client.query.mock.calls[4]?.[0])).toContain('INSERT INTO inventory_reservations');
    expect(String(client.query.mock.calls[5]?.[0])).toContain('INSERT INTO outbox_events');
    expect(client.query.mock.calls[5]?.[1]).toContain('INVENTORY.STOCK_RESERVED');
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

  it('consumes a reservation atomically with an ISSUE movement and outbox events', async () => {
    const consumedMovementId = randomUUID();
    client.query
      .mockResolvedValueOnce(queryRows([{ id: ITEM_ID, status: 'ACTIVE' }]))
      .mockResolvedValueOnce(queryRows([row()]))
      .mockResolvedValueOnce(queryRows([{ quantity_on_hand: '8.0000', quantity_reserved: '0.0000' }]))
      .mockResolvedValueOnce(queryRows([{ id: consumedMovementId, quantity_after: '8.0000' }]))
      .mockResolvedValueOnce(queryRows([]))
      .mockResolvedValueOnce(queryRows([row({
        status: 'CONSUMED',
        transition_idempotency_key: 'consume-1',
        transition_request_hash: createHash('sha256').update(JSON.stringify({
          reservationId: RESERVATION_ID,
          targetStatus: 'CONSUMED',
        })).digest('hex'),
        consumed_movement_id: consumedMovementId,
      })]))
      .mockResolvedValueOnce(queryRows([]));

    const result = await service.transitionReservation(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID, RESERVATION_ID,
      { target_status: 'CONSUMED' } as TransitionInventoryReservationDto,
      'consume-1', TRACE_ID, TRACE_ID,
    );

    expect(result).toMatchObject({
      id: RESERVATION_ID, status: 'CONSUMED',
      consumed_movement_id: consumedMovementId, replayed: false,
    });
    expect(String(client.query.mock.calls[2]?.[0])).toContain('quantity_on_hand = quantity_on_hand - $1::numeric');
    expect(String(client.query.mock.calls[3]?.[0])).toContain("'ISSUE'");
    expect(client.query.mock.calls[4]?.[1]).toContain('INVENTORY.STOCK_ISSUED');
    expect(String(client.query.mock.calls[5]?.[0])).toContain("status = 'RESERVED'");
    expect(client.query.mock.calls[6]?.[1]).toContain('INVENTORY.STOCK_RESERVATION_CONSUMED');
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('releases a reservation without reducing quantity on hand', async () => {
    client.query
      .mockResolvedValueOnce(queryRows([{ id: ITEM_ID, status: 'ACTIVE' }]))
      .mockResolvedValueOnce(queryRows([row()]))
      .mockResolvedValueOnce(queryRows([{ quantity_on_hand: '10.0000', quantity_reserved: '0.0000' }]))
      .mockResolvedValueOnce(queryRows([row({
        status: 'RELEASED',
        transition_idempotency_key: 'release-1',
        transition_request_hash: createHash('sha256').update(JSON.stringify({
          reservationId: RESERVATION_ID,
          targetStatus: 'RELEASED',
        })).digest('hex'),
      })]))
      .mockResolvedValueOnce(queryRows([]));

    const result = await service.transitionReservation(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID, RESERVATION_ID,
      { target_status: 'RELEASED' } as TransitionInventoryReservationDto,
      'release-1', TRACE_ID, TRACE_ID,
    );

    expect(result.status).toBe('RELEASED');
    expect(String(client.query.mock.calls[2]?.[0])).toContain('quantity_reserved = quantity_reserved - $1::numeric');
    expect(String(client.query.mock.calls[2]?.[0])).not.toContain('quantity_on_hand = quantity_on_hand -');
    expect(client.query.mock.calls[4]?.[1]).toContain('INVENTORY.STOCK_RESERVATION_RELEASED');
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

    const result = await service.postWorkOrderFinishedGoodsReceipt(client as never, {
      userId: USER_ID,
      tenantId: TENANT_ID,
      factoryId: FACTORY_ID,
      workOrderId,
      workOrderNumber: 'WO-OUTPUT-001',
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
    expect(client.query.mock.calls[4]?.[1]).toContain('INVENTORY.STOCK_RECEIVED');
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
    const result = await service.postWorkOrderFinishedGoodsReceipt(client as never, {
      userId: USER_ID,
      tenantId: TENANT_ID,
      factoryId: FACTORY_ID,
      workOrderId: randomUUID(),
      workOrderNumber: 'WO-SCRAP-ONLY',
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

    await expect(service.postWorkOrderFinishedGoodsReceipt(client as never, {
      userId: USER_ID,
      tenantId: TENANT_ID,
      factoryId: FACTORY_ID,
      workOrderId: randomUUID(),
      workOrderNumber: 'WO-DISABLED-FG',
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
      })]));

    await expect(service.transitionReservation(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID, RESERVATION_ID,
      { target_status: 'CONSUMED' } as TransitionInventoryReservationDto,
      'consume-after-release', TRACE_ID, TRACE_ID,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(client.query).toHaveBeenCalledTimes(2);
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
