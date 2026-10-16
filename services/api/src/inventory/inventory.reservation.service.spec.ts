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
      quantity: '2.0000',
      status: 'RESERVED',
      idempotency_key: 'reserve-1',
      request_hash: createHash('sha256').update(JSON.stringify({
        itemId: ITEM_ID,
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
});
