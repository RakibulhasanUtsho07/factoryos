import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { UpsertInventoryReorderPolicyDto } from './dto/upsert-inventory-reorder-policy.dto';
import { InventoryReplenishmentService } from './inventory.replenishment.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const ITEM_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';
const SUPPLIER_ID = '34f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const TRACE_ID = '522ecb02-3e23-4416-9d13-ed9dcd780b81';
const REQUEST_ID = 'f7168be2-1b73-42b3-a930-72c31b2d6050';

type QueryResponse = { rows: unknown[] };

const policyDto = (
  overrides: Partial<UpsertInventoryReorderPolicyDto> = {},
): UpsertInventoryReorderPolicyDto => ({
  minimum_quantity: 5,
  maximum_quantity: 20,
  lead_time_days: 7,
  preferred_supplier_id: null,
  enabled: true,
  ...overrides,
});

const storedPolicy = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  tenant_id: TENANT_ID,
  factory_id: FACTORY_ID,
  item_id: ITEM_ID,
  minimum_quantity: '5.0000',
  maximum_quantity: '20.0000',
  lead_time_days: 7,
  preferred_supplier_id: null,
  enabled: true,
  created_by_user_id: USER_ID,
  updated_by_user_id: USER_ID,
  created_at: '2026-10-17T00:00:00.000Z',
  updated_at: '2026-10-17T00:00:00.000Z',
  version: '1',
  ...overrides,
});

describe('InventoryReplenishmentService', () => {
  let service: InventoryReplenishmentService;
  let client: { query: Mock };
  let database: { transaction: Mock; query: Mock };
  let audit: { record: Mock };

  beforeEach(() => {
    client = { query: jest.fn() };
    database = {
      transaction: jest.fn(async (context: unknown, callback?: unknown) => {
        if (typeof callback !== 'function') throw new Error('test transaction callback missing');
        return (callback as (clientArg: unknown) => Promise<unknown>)(client);
      }),
      query: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(randomUUID()) };
    service = new InventoryReplenishmentService(
      database as unknown as DatabaseService,
      audit as unknown as AuditService,
    );
  });

  it('rejects inverted min/max thresholds before opening a transaction', async () => {
    await expect(service.upsertPolicy(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID,
      policyDto({ minimum_quantity: 20, maximum_quantity: 20 }),
      REQUEST_ID, TRACE_ID,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects quantity precision beyond four decimal places', async () => {
    await expect(service.upsertPolicy(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID,
      policyDto({ minimum_quantity: 5.00001 }),
      REQUEST_ID, TRACE_ID,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('creates policy and its outbox event transactionally, then records audit evidence', async () => {
    const row = storedPolicy({ version: '1' });
    client.query
      .mockResolvedValueOnce({ rows: [{ id: ITEM_ID, sku: 'FABRIC-01', status: 'ACTIVE' }] } as QueryResponse)
      .mockResolvedValueOnce({ rows: [] } as QueryResponse)
      .mockResolvedValueOnce({ rows: [row] } as QueryResponse)
      .mockResolvedValueOnce({ rows: [] } as QueryResponse);

    const result = await service.upsertPolicy(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID, policyDto(), REQUEST_ID, TRACE_ID,
    );

    expect(result.changed).toBe(true);
    expect(result.policy.minimum_quantity).toBe('5.0000');
    expect(result.policy.maximum_quantity).toBe('20.0000');
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query.mock.calls[2]?.[0]).toContain('INSERT INTO inventory_reorder_policies');
    expect(client.query.mock.calls[3]?.[0]).toContain('INSERT INTO outbox_events');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      factoryId: FACTORY_ID,
      actorUserId: USER_ID,
      action: 'REORDER_POLICY_CREATE',
      resourceId: row.id,
    }));
  });

  it('does not bump the version or emit duplicate events for an unchanged policy', async () => {
    const row = storedPolicy();
    client.query
      .mockResolvedValueOnce({ rows: [{ id: ITEM_ID, sku: 'FABRIC-01', status: 'ACTIVE' }] } as QueryResponse)
      .mockResolvedValueOnce({ rows: [row] } as QueryResponse);

    const result = await service.upsertPolicy(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID, policyDto(), REQUEST_ID, TRACE_ID,
    );

    expect(result.changed).toBe(false);
    expect(result.policy.version).toBe('1');
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a preferred supplier that is disabled, missing, or out of tenant scope', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ id: ITEM_ID, sku: 'FABRIC-01', status: 'ACTIVE' }] } as QueryResponse)
      .mockResolvedValueOnce({ rows: [] } as QueryResponse);

    await expect(service.upsertPolicy(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID,
      policyDto({ preferred_supplier_id: SUPPLIER_ID }),
      REQUEST_ID, TRACE_ID,
    )).rejects.toBeInstanceOf(NotFoundException);

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects policy edits on disabled inventory items', async () => {
    client.query.mockResolvedValueOnce({
      rows: [{ id: ITEM_ID, sku: 'FABRIC-01', status: 'DISABLED' }],
    } as QueryResponse);

    await expect(service.upsertPolicy(
      USER_ID, TENANT_ID, FACTORY_ID, ITEM_ID, policyDto(), REQUEST_ID, TRACE_ID,
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('uses approved purchase orders and posted receipt quantities for shortage visibility', async () => {
    database.query.mockResolvedValue({ rows: [] } as QueryResponse);

    const result = await service.listShortages(TENANT_ID, FACTORY_ID, 25);

    expect(result).toEqual([]);
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("po.status = 'APPROVED'"),
      [TENANT_ID, FACTORY_ID, 25, 'SHORTAGES', null],
      { tenantId: TENANT_ID },
    );
    const sql = String(database.query.mock.calls[0]?.[0]);
    expect(sql).toContain("gr.status = 'POSTED'");
    expect(sql).toContain('pol.quantity - COALESCE(pr.received_quantity, 0)');
    expect(sql).toContain('quantity_on_hand - quantity_reserved');
    expect(sql).toContain('uncovered_shortage_quantity');
    expect(sql).toContain('LIMIT $3');
  });

  it('recommends replenishment only at/below the minimum stock position and targets the maximum', async () => {
    database.query.mockResolvedValue({ rows: [] } as QueryResponse);

    await service.listRecommendations(TENANT_ID, FACTORY_ID, 15);

    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('inventory_position <= minimum_quantity'),
      [TENANT_ID, FACTORY_ID, 15, 'RECOMMENDATIONS', null],
      { tenantId: TENANT_ID },
    );
    const sql = String(database.query.mock.calls[0]?.[0]);
    expect(sql).toContain('GREATEST(maximum_quantity - inventory_position, 0)');
    expect(sql).toContain("WHEN preferred_supplier_id IS NULL OR preferred_supplier_status IS DISTINCT FROM 'ACTIVE'");
  });

  it('enforces a bounded limit for shortage and recommendation endpoints', async () => {
    await expect(service.listShortages(TENANT_ID, FACTORY_ID, 101))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.listRecommendations(TENANT_ID, FACTORY_ID, 0))
      .rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).not.toHaveBeenCalled();
  });

  it('requires an active configured policy for the item details endpoint', async () => {
    database.query.mockResolvedValue({ rows: [] } as QueryResponse);

    await expect(service.getPolicy(TENANT_ID, FACTORY_ID, ITEM_ID))
      .rejects.toBeInstanceOf(NotFoundException);

    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("($4::text = 'POLICY' AND item_id = $5::uuid)"),
      [TENANT_ID, FACTORY_ID, 1, 'POLICY', ITEM_ID],
      { tenantId: TENANT_ID },
    );
  });
});
