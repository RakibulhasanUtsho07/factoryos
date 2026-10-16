import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { CreateInventoryItemDto } from './dto/create-inventory-item.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { InventoryService } from './inventory.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const ITEM_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';
const TRACE_ID = '522ecb02-3e23-4416-9d13-ed9dcd780b81';
const REQUEST_ID = 'f7168be2-1b73-42b3-a930-72c31b2d6050';

type QueryResponse = { rows: unknown[] };

describe('InventoryService', () => {
  let service: InventoryService;
  let client: { query: Mock };
  let database: {
    transaction: Mock;
    query: Mock;
  };
  let audit: { record: Mock };

  beforeEach(() => {
    client = { query: jest.fn() };
    database = {
      transaction: jest.fn(async (first: unknown, second?: unknown) => {
        const callback = typeof first === 'function' ? first : second;
        if (typeof callback !== 'function') throw new Error('test transaction callback missing');
        return (callback as (clientArg: unknown) => Promise<unknown>)(client);
      }),
      query: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(randomUUID()) };
    service = new InventoryService(
      database as unknown as DatabaseService,
      audit as unknown as AuditService,
    );
  });

  it('creates a normalized item, its zero balance and an outbox event in one transaction', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ id: FACTORY_ID }] } as QueryResponse)
      .mockResolvedValueOnce({
        rows: [{
          id: ITEM_ID,
          tenant_id: TENANT_ID,
          factory_id: FACTORY_ID,
          sku: 'FABRIC-01',
          name: 'Cotton Fabric',
          unit: 'M',
          status: 'ACTIVE',
          version: '1',
          created_at: '2026-10-11T00:00:00.000Z',
        }],
      } as QueryResponse)
      .mockResolvedValueOnce({ rows: [{ quantity_on_hand: '0.0000' }] } as QueryResponse)
      .mockResolvedValueOnce({ rows: [] } as QueryResponse);

    const item = await service.createItem(
      USER_ID,
      TENANT_ID,
      FACTORY_ID,
      { sku: ' fabric-01 ', name: ' Cotton Fabric ', unit: ' m ' } as CreateInventoryItemDto,
      REQUEST_ID,
      TRACE_ID,
    );

    expect(item.sku).toBe('FABRIC-01');
    expect(item.unit).toBe('M');
    expect(item.quantity_on_hand).toBe('0.0000');
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query.mock.calls[1][0]).toContain('INSERT INTO inventory_items');
    expect(client.query.mock.calls[2][0]).toContain('INSERT INTO inventory_stock_balances');
    expect(client.query.mock.calls[3][0]).toContain('INSERT INTO outbox_events');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      factoryId: FACTORY_ID,
      resourceId: ITEM_ID,
      action: 'ITEM_CREATE',
    }));
  });

  it('requires an idempotency key before any stock movement transaction starts', async () => {
    await expect(service.createStockMovement(
      USER_ID,
      TENANT_ID,
      FACTORY_ID,
      ITEM_ID,
      { movement_type: 'RECEIPT', quantity: 1 } as CreateStockMovementDto,
      null,
      REQUEST_ID,
      TRACE_ID,
    )).rejects.toMatchObject({
      status: 400,
    });

    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('applies a stock receipt with the balance, immutable ledger row and outbox event', async () => {
    const movementId = randomUUID();
    const input = { movement_type: 'RECEIPT', quantity: 2.5 } as CreateStockMovementDto;
    client.query
      .mockResolvedValueOnce({ rows: [] } as QueryResponse)
      .mockResolvedValueOnce({ rows: [{ id: ITEM_ID, sku: 'FABRIC-01', name: 'Cotton', status: 'ACTIVE' }] } as QueryResponse)
      .mockResolvedValueOnce({ rows: [] } as QueryResponse)
      .mockResolvedValueOnce({ rows: [{ quantity_on_hand: '2.5000' }] } as QueryResponse)
      .mockResolvedValueOnce({
        rows: [{
          id: movementId,
          tenant_id: TENANT_ID,
          factory_id: FACTORY_ID,
          item_id: ITEM_ID,
          movement_type: 'RECEIPT',
          quantity: '2.5000',
          quantity_delta: '2.5000',
          quantity_after: '2.5000',
          request_hash: 'test-hash',
          reference_type: null,
          reference_id: null,
          notes: null,
          created_by_user_id: USER_ID,
          correlation_id: TRACE_ID,
          created_at: '2026-10-11T00:00:00.000Z',
        }],
      } as QueryResponse)
      .mockResolvedValueOnce({ rows: [] } as QueryResponse);

    const result = await service.createStockMovement(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID, input,
      'receipt-1', REQUEST_ID, TRACE_ID,
    );

    expect(result.id).toBe(movementId);
    expect(result.quantity_after).toBe('2.5000');
    expect(result.replayed).toBe(false);
    expect(result).not.toHaveProperty('request_hash');
    expect(client.query.mock.calls[3][0]).toContain('UPDATE inventory_stock_balances');
    expect(client.query.mock.calls[4][0]).toContain('INSERT INTO inventory_movements');
    expect(client.query.mock.calls[5][0]).toContain('INSERT INTO outbox_events');
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('replays the stored result for the same key and identical request without touching stock again', async () => {
    const input = { movement_type: 'RECEIPT', quantity: 2.5 } as CreateStockMovementDto;
    const expectedHash = createHash('sha256')
      .update(JSON.stringify({
        itemId: ITEM_ID,
        movementType: 'RECEIPT',
        quantity: '2.5000',
        referenceType: null,
        referenceId: null,
        notes: null,
      }))
      .digest('hex');
    const movementId = randomUUID();

    client.query.mockResolvedValueOnce({
      rows: [{
        id: movementId,
        tenant_id: TENANT_ID,
        factory_id: FACTORY_ID,
        item_id: ITEM_ID,
        movement_type: 'RECEIPT',
        quantity: '2.5000',
        quantity_delta: '2.5000',
        quantity_after: '2.5000',
        request_hash: expectedHash,
        reference_type: null,
        reference_id: null,
        notes: null,
        created_by_user_id: USER_ID,
        correlation_id: TRACE_ID,
        created_at: '2026-10-11T00:00:00.000Z',
      }],
    } as QueryResponse);

    const result = await service.createStockMovement(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID, input,
      'receipt-1', REQUEST_ID, TRACE_ID,
    );

    expect(result.id).toBe(movementId);
    expect(result.replayed).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects an idempotency key reused for a different stock movement', async () => {
    client.query.mockResolvedValueOnce({
      rows: [{
        id: randomUUID(),
        tenant_id: TENANT_ID,
        factory_id: FACTORY_ID,
        item_id: ITEM_ID,
        movement_type: 'RECEIPT',
        quantity: '2.5000',
        quantity_delta: '2.5000',
        quantity_after: '2.5000',
        request_hash: '0'.repeat(64),
        reference_type: null,
        reference_id: null,
        notes: null,
        created_by_user_id: USER_ID,
        correlation_id: TRACE_ID,
        created_at: '2026-10-11T00:00:00.000Z',
      }],
    } as QueryResponse);

    await expect(service.createStockMovement(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID,
      { movement_type: 'RECEIPT', quantity: 2.5 } as CreateStockMovementDto,
      'receipt-1', REQUEST_ID, TRACE_ID,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('fails closed when an issue would make stock negative', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] } as QueryResponse)
      .mockResolvedValueOnce({ rows: [{ id: ITEM_ID, sku: 'FABRIC-01', name: 'Cotton', status: 'ACTIVE' }] } as QueryResponse)
      .mockResolvedValueOnce({ rows: [] } as QueryResponse)
      .mockResolvedValueOnce({ rows: [] } as QueryResponse);

    await expect(service.createStockMovement(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID,
      { movement_type: 'ISSUE', quantity: 1 } as CreateStockMovementDto,
      'issue-too-much', REQUEST_ID, TRACE_ID,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(client.query).toHaveBeenCalledTimes(4);
    expect(String(client.query.mock.calls[3]?.[0])).toContain(
      'quantity_on_hand + $1::numeric >= quantity_reserved',
    );
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO inventory_movements'))).toBe(false);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
