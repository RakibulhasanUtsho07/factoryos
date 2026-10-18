import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { QueryResultRow } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { InventoryReservationService } from '../inventory/inventory.reservation.service';
import { CreateOrderProductionReportDto } from './dto/create-order-production-report.dto';
import { OrderProductionReportService } from './order-production-report.service';

const USER = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const ORDER = '0f2e4f11-d513-4c27-8c0b-e2c4ab55e1f1';
const ORDER_LINE = '27c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a';
const FINISHED_ITEM = '69ef2a43-8157-4d91-aa59-7b4260ef1778';
const REPORT = '522ecb02-3e23-4416-9d13-ed9dcd780b81';
const POSTING = 'eac3a958-a13d-4fca-9746-45f1d7f8b7a6';
const MOVEMENT = 'c81f1485-5824-458e-b237-3230e8c3f905';
const TRACE = 'f7168be2-1b73-42b3-a930-72c31b2d6050';

type Rows = { rows: QueryResultRow[] };

describe('OrderProductionReportService', () => {
  let service: OrderProductionReportService;
  let client: { query: ReturnType<typeof jest.fn> };
  let database: { transaction: ReturnType<typeof jest.fn>; query: ReturnType<typeof jest.fn> };
  let audit: { record: ReturnType<typeof jest.fn> };
  let inventory: { postFinishedGoodsOutputReceipt: ReturnType<typeof jest.fn> };

  const rows = (items: unknown[] = []): Rows => ({ rows: items as QueryResultRow[] });

  const reportRow = (overrides: Record<string, unknown> = {}) => ({
    id: REPORT,
    tenant_id: TENANT,
    factory_id: FACTORY,
    order_id: ORDER,
    order_line_id: ORDER_LINE,
    good_quantity: '9.0000',
    scrap_quantity: '1.0000',
    cumulative_good_quantity: '9.0000',
    cumulative_scrap_quantity: '1.0000',
    scrap_reason: 'Failed final inspection',
    notes: null,
    idempotency_key: 'report-001',
    request_hash: 'a'.repeat(64),
    created_by_user_id: USER,
    correlation_id: TRACE,
    created_at: '2026-10-18T00:00:00.000Z',
    yield_percent: '90.0000',
    report_yield_percent: null,
    production_output_posting_id: null,
    inventory_movement_id: null,
    ...overrides,
  } as unknown as QueryResultRow);

  beforeEach(() => {
    client = { query: jest.fn() };
    database = {
      transaction: jest.fn(async (_context: unknown, callback: (client: unknown) => Promise<unknown>) =>
        callback(client)),
      query: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue('audit-id') };
    inventory = { postFinishedGoodsOutputReceipt: jest.fn() };
    service = new OrderProductionReportService(
      database as unknown as DatabaseService,
      audit as unknown as AuditService,
      inventory as unknown as InventoryReservationService,
    );
  });

  it('does not report production when the order line lacks a finished-good inventory mapping', async () => {
    client.query
      .mockResolvedValueOnce(rows([])) // scoped advisory lock
      .mockResolvedValueOnce(rows([])) // idempotency key not used
      .mockResolvedValueOnce(rows([{ id: ORDER, order_number: 'ORD-100', status: 'IN_PROGRESS' }]))
      .mockResolvedValueOnce(rows([{
        id: ORDER_LINE,
        quantity: '10.0000',
        product_code: 'SKU-100',
        inventory_item_id: null,
        inventory_item_status: null,
      }]));

    await expect(service.createReport(
      USER, TENANT, FACTORY, ORDER,
      {
        order_line_id: ORDER_LINE,
        good_quantity: 9,
        scrap_quantity: 1,
        scrap_reason: 'Failed final inspection',
      } as CreateOrderProductionReportDto,
      'report-001', TRACE, TRACE,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO order_production_reports'))).toBe(false);
    expect(inventory.postFinishedGoodsOutputReceipt).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('posts good output, yield/scrap evidence and finished-good inventory receipt atomically', async () => {
    client.query
      .mockResolvedValueOnce(rows([])) // scoped advisory lock
      .mockResolvedValueOnce(rows([])) // idempotency key not used
      .mockResolvedValueOnce(rows([{ id: ORDER, order_number: 'ORD-100', status: 'IN_PROGRESS' }]))
      .mockResolvedValueOnce(rows([{
        id: ORDER_LINE,
        quantity: '10.0000',
        product_code: 'SKU-100',
        inventory_item_id: FINISHED_ITEM,
        inventory_item_status: 'ACTIVE',
      }]))
      .mockResolvedValueOnce(rows([{ good_quantity: '0.0000', scrap_quantity: '0.0000' }]))
      .mockResolvedValueOnce(rows([reportRow()]))
      .mockResolvedValueOnce(rows([{ id: POSTING }]))
      .mockResolvedValueOnce(rows([])); // transactional order event

    inventory.postFinishedGoodsOutputReceipt.mockResolvedValue({
      movementId: MOVEMENT,
      quantityAfter: '29.0000',
    });

    const result = await service.createReport(
      USER, TENANT, FACTORY, ORDER,
      {
        order_line_id: ORDER_LINE,
        good_quantity: 9,
        scrap_quantity: 1,
        scrap_reason: 'Failed final inspection',
      } as CreateOrderProductionReportDto,
      'report-001', TRACE, TRACE,
    );

    expect(inventory.postFinishedGoodsOutputReceipt).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        workOrderId: null,
        orderId: ORDER,
        orderLineId: ORDER_LINE,
        finishedItemId: FINISHED_ITEM,
        productionReportId: REPORT,
        goodQuantity: '9.0000',
        scrapQuantity: '1.0000',
        yieldPercentage: '90.0000',
        cumulativeYieldPercentage: '90.0000',
      }),
    );
    expect(String(client.query.mock.calls[5]?.[0])).toContain('INSERT INTO order_production_reports');
    expect(String(client.query.mock.calls[6]?.[0])).toContain('INSERT INTO production_output_postings');
    expect(client.query.mock.calls[6]?.[1]).toContain(MOVEMENT);
    expect(String(client.query.mock.calls[7]?.[0])).toContain('INSERT INTO outbox_events');
    expect(result).toMatchObject({
      id: REPORT,
      good_quantity: '9.0000',
      scrap_quantity: '1.0000',
      report_yield_percent: '90.0000',
      yield_percent: '90.0000',
      production_output_posting_id: POSTING,
      finished_good_movement_id: MOVEMENT,
      replayed: false,
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('records scrap-only output without creating a zero-quantity inventory receipt', async () => {
    client.query
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([{ id: ORDER, order_number: 'ORD-100', status: 'IN_PROGRESS' }]))
      .mockResolvedValueOnce(rows([{
        id: ORDER_LINE,
        quantity: '10.0000',
        product_code: 'SKU-100',
        inventory_item_id: FINISHED_ITEM,
        inventory_item_status: 'DISABLED',
      }]))
      .mockResolvedValueOnce(rows([{ good_quantity: '0.0000', scrap_quantity: '0.0000' }]))
      .mockResolvedValueOnce(rows([reportRow({
        good_quantity: '0.0000',
        scrap_quantity: '2.0000',
        cumulative_good_quantity: '0.0000',
        cumulative_scrap_quantity: '2.0000',
        yield_percent: '0.0000',
        scrap_reason: 'Unrecoverable damage',
      })]))
      .mockResolvedValueOnce(rows([{ id: POSTING }]))
      .mockResolvedValueOnce(rows([]));

    inventory.postFinishedGoodsOutputReceipt.mockResolvedValue({
      movementId: null,
      quantityAfter: null,
    });

    const result = await service.createReport(
      USER, TENANT, FACTORY, ORDER,
      {
        order_line_id: ORDER_LINE,
        good_quantity: 0,
        scrap_quantity: 2,
        scrap_reason: 'Unrecoverable damage',
      } as CreateOrderProductionReportDto,
      'scrap-only-report', TRACE, TRACE,
    );

    expect(inventory.postFinishedGoodsOutputReceipt).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        goodQuantity: '0.0000',
        scrapQuantity: '2.0000',
        yieldPercentage: '0.0000',
        cumulativeYieldPercentage: '0.0000',
      }),
    );
    expect(client.query.mock.calls[6]?.[1]).toContain(null);
    expect(result).toMatchObject({
      good_quantity: '0.0000',
      scrap_quantity: '2.0000',
      report_yield_percent: '0.0000',
      finished_good_movement_id: null,
    });
  });

  it('replays the stored inventory/yield links without posting stock twice', async () => {
    const expectedRequestHash = createHash('sha256').update(JSON.stringify({
      orderId: ORDER,
      orderLineId: ORDER_LINE,
      goodQuantity: '9.0000',
      scrapQuantity: '1.0000',
      scrapReason: 'Failed final inspection',
      notes: null,
    })).digest('hex');
    client.query
      .mockResolvedValueOnce(rows([])) // scoped advisory lock
      .mockResolvedValueOnce(rows([reportRow({
        request_hash: expectedRequestHash,
        report_yield_percent: '90.0000',
        production_output_posting_id: POSTING,
        inventory_movement_id: MOVEMENT,
      })]));

    const result = await service.createReport(
      USER, TENANT, FACTORY, ORDER,
      {
        order_line_id: ORDER_LINE,
        good_quantity: 9,
        scrap_quantity: 1,
        scrap_reason: 'Failed final inspection',
      } as CreateOrderProductionReportDto,
      'report-001', TRACE, TRACE,
    );

    expect(result).toMatchObject({
      production_output_posting_id: POSTING,
      finished_good_movement_id: MOVEMENT,
      replayed: true,
    });
    expect(inventory.postFinishedGoodsOutputReceipt).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
