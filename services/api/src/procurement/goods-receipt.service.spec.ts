import 'reflect-metadata';

import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

import { DatabaseService } from '../database/database.service';
import { CreateGoodsReceiptDto } from './dto/create-goods-receipt.dto';
import { GoodsReceiptService } from './goods-receipt.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const PURCHASE_ORDER_ID = '9c130a30-a5ab-4dd8-a7f4-8e7f0c817da3';
const PURCHASE_ORDER_LINE_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';
const REQUEST_ID = 'f7168be2-1b73-42b3-a930-72c31b2d6050';
const TRACE_ID = '522ecb02-3e23-4416-9d13-ed9dcd780b81';

type QueryResponse = { rows: unknown[] };

describe('GoodsReceiptService', () => {
  let service: GoodsReceiptService;
  let client: { query: Mock };
  let database: { transaction: Mock; query: Mock };

  const validDto = (): CreateGoodsReceiptDto => ({
    supplier_delivery_reference: ' DELIVERY-4821 ',
    notes: ' First partial delivery ',
    lines: [{
      purchase_order_line_id: PURCHASE_ORDER_LINE_ID,
      received_quantity: 6,
      rejected_quantity: 1,
      rejection_reason: ' Two units damaged ',
    }],
  });

  const requestHash = (dto: CreateGoodsReceiptDto) => createHash('sha256').update(JSON.stringify({
    operation: 'GOODS_RECEIPT.POST',
    tenant_id: TENANT_ID,
    factory_id: FACTORY_ID,
    purchase_order_id: PURCHASE_ORDER_ID.toLowerCase(),
    location_id: null,
    supplier_delivery_reference: dto.supplier_delivery_reference?.trim() || null,
    received_at: null,
    notes: dto.notes?.trim() || null,
    lines: [{
      purchase_order_line_id: PURCHASE_ORDER_LINE_ID.toLowerCase(),
      received_quantity: '6.0000',
      rejected_quantity: '1.0000',
      rejection_reason: 'Two units damaged',
    }],
  })).digest('hex');

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
    service = new GoodsReceiptService(database as unknown as DatabaseService);
  });

  it('requires an idempotency key before starting a database transaction', async () => {
    await expect(service.postGoodsReceipt(
      USER_ID, TENANT_ID, FACTORY_ID, PURCHASE_ORDER_ID,
      validDto(), null, REQUEST_ID, TRACE_ID,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects duplicate PO lines in one receipt before opening a transaction', async () => {
    const dto = validDto();
    dto.lines = [...dto.lines, { ...dto.lines[0], received_quantity: 1, rejected_quantity: 0 }];

    await expect(service.postGoodsReceipt(
      USER_ID, TENANT_ID, FACTORY_ID, PURCHASE_ORDER_ID,
      dto, 'grn-duplicate-line', REQUEST_ID, TRACE_ID,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a reason for rejected quantity and rejects precision beyond four decimals', async () => {
    const noReason = validDto();
    noReason.lines[0].rejection_reason = '   ';
    await expect(service.postGoodsReceipt(
      USER_ID, TENANT_ID, FACTORY_ID, PURCHASE_ORDER_ID,
      noReason, 'grn-no-reason', REQUEST_ID, TRACE_ID,
    )).rejects.toBeInstanceOf(BadRequestException);

    const excessPrecision = validDto();
    excessPrecision.lines[0].received_quantity = 1.00001;
    await expect(service.postGoodsReceipt(
      USER_ID, TENANT_ID, FACTORY_ID, PURCHASE_ORDER_ID,
      excessPrecision, 'grn-excess-precision', REQUEST_ID, TRACE_ID,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('replays the original posted receipt for the same key and normalized request without posting stock twice', async () => {
    const dto = validDto();
    const receiptId = randomUUID();
    const expectedHeader = {
      id: receiptId,
      tenant_id: TENANT_ID,
      factory_id: FACTORY_ID,
      purchase_order_id: PURCHASE_ORDER_ID,
      po_number: 'PO-REPLAY-001',
      receipt_number: 'GRN-20261017-REPLAY01',
      status: 'POSTED',
      supplier_delivery_reference: 'DELIVERY-4821',
      received_at: '2026-10-17T10:00:00.000Z',
      notes: 'First partial delivery',
      created_by_user_id: USER_ID,
      request_id: REQUEST_ID,
      trace_id: TRACE_ID,
      correlation_id: TRACE_ID,
      created_at: '2026-10-17T10:00:00.000Z',
      posted_at: '2026-10-17T10:00:01.000Z',
    };
    const expectedLine = {
      id: randomUUID(),
      goods_receipt_id: receiptId,
      purchase_order_id: PURCHASE_ORDER_ID,
      purchase_order_line_id: PURCHASE_ORDER_LINE_ID,
      po_line_number: 1,
      inventory_item_id: randomUUID(),
      description: 'Material',
      unit: 'PCS',
      ordered_quantity: '10.0000',
      received_quantity: '6.0000',
      rejected_quantity: '1.0000',
      accepted_quantity: '5.0000',
      rejection_reason: 'Two units damaged',
      stock_quantity_after: '15.0000',
    };

    client.query
      .mockResolvedValueOnce({ rows: [] } as QueryResponse)
      .mockResolvedValueOnce({ rows: [{ id: receiptId, request_hash: requestHash(dto) }] } as QueryResponse);
    database.query
      .mockResolvedValueOnce({ rows: [expectedHeader] } as QueryResponse)
      .mockResolvedValueOnce({ rows: [expectedLine] } as QueryResponse);

    const result = await service.postGoodsReceipt(
      USER_ID, TENANT_ID, FACTORY_ID, PURCHASE_ORDER_ID,
      dto, 'grn-replay-key', REQUEST_ID, TRACE_ID,
    );

    expect(result.id).toBe(receiptId);
    expect(result.replayed).toBe(true);
    expect(result.lines).toEqual([expectedLine]);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(client.query.mock.calls[1][0]).toContain('FROM goods_receipts');
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).includes('UPDATE inventory_stock_balances') ||
      String(sql).includes('INSERT INTO inventory_movements'),
    )).toBe(false);
  });

  it('returns a conflict when an idempotency key is reused with changed quantities', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] } as QueryResponse)
      .mockResolvedValueOnce({ rows: [{ id: randomUUID(), request_hash: '0'.repeat(64) }] } as QueryResponse);

    await expect(service.postGoodsReceipt(
      USER_ID, TENANT_ID, FACTORY_ID, PURCHASE_ORDER_ID,
      validDto(), 'grn-reused-key', REQUEST_ID, TRACE_ID,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(database.query).not.toHaveBeenCalled();
  });
});
