import { jest } from '@jest/globals';
import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';

import { MaintenanceService } from './maintenance.service';

const tenantId = '00000000-0000-4000-8000-000000000001';
const factoryId = '00000000-0000-4000-8000-000000000002';
const actorUserId = '00000000-0000-4000-8000-000000000003';
const machineId = '00000000-0000-4000-8000-000000000004';
const eventId = '00000000-0000-4000-8000-000000000005';
const requestId = '00000000-0000-4000-8000-000000000006';
const traceId = '00000000-0000-4000-8000-000000000007';

type MockQueryResult = {
  rows: Record<string, unknown>[];
};

describe('MaintenanceService', () => {
  const query = jest.fn<(...args: unknown[]) => Promise<MockQueryResult>>();
  const transaction = jest.fn<(...args: unknown[]) => Promise<unknown>>();
  const auditRecord = jest.fn<(...args: unknown[]) => Promise<string>>();

  const client = { query };
  const database = { transaction };
  const auditService = { record: auditRecord };

  let service: MaintenanceService;

  const machineRow = {
    id: machineId,
    tenant_id: tenantId,
    factory_id: factoryId,
    machine_code: 'SEW-001',
    machine_type: 'LOCKSTITCH',
    line_code: 'LINE-01',
    status: 'ACTIVE',
    notes: null,
    created_by_user_id: actorUserId,
    created_at: '2026-10-10T10:00:00.000Z',
    updated_at: '2026-10-10T10:00:00.000Z',
    version: 1,
  };

  const downtimeRow = {
    id: eventId,
    tenant_id: tenantId,
    factory_id: factoryId,
    machine_id: machineId,
    machine_code: 'SEW-001',
    reason_code: 'NEEDLE_BREAK',
    description: null,
    started_at: '2026-10-10T10:00:00.000Z',
    ended_at: null,
    created_by_user_id: actorUserId,
    closed_by_user_id: null,
    created_at: '2026-10-10T10:00:00.000Z',
    version: 1,
  };

  beforeEach(() => {
    jest.resetAllMocks();
    auditRecord.mockResolvedValue('audit-event-id');
    transaction.mockImplementation(async (...args: unknown[]) => {
      const callback =
        typeof args[0] === 'function'
          ? args[0]
          : args[1];

      if (typeof callback !== 'function') {
        throw new Error('TEST_TRANSACTION_CALLBACK_MISSING');
      }

      return (callback as (value: PoolClient) => Promise<unknown>)(
        client as unknown as PoolClient,
      );
    });

    service = new MaintenanceService(
      database as never,
      auditService as never,
    );
  });

  it('creates a machine in the authorized tenant/factory scope and audits it', async () => {
    query.mockResolvedValueOnce({ rows: [machineRow] });

    const result = await service.createMachine(
      tenantId,
      factoryId,
      actorUserId,
      {
        machine_code: ' sew-001 ',
        machine_type: ' LOCKSTITCH ',
        line_code: ' LINE-01 ',
      },
      requestId,
      traceId,
    );

    expect(result).toEqual(machineRow);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      tenantId,
      factoryId,
      'SEW-001',
      'LOCKSTITCH',
      'LINE-01',
      'ACTIVE',
      null,
      actorUserId,
    ]);
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { tenantId, userId: actorUserId },
    );
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        factoryId,
        actorUserId,
        eventType: 'maintenance.machine.created',
        resourceId: machineId,
      }),
    );
  });

  it('rejects duplicate machine codes as a conflict', async () => {
    query.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key'), { code: '23505' }),
    );

    await expect(
      service.createMachine(
        tenantId,
        factoryId,
        actorUserId,
        {
          machine_code: 'SEW-001',
          machine_type: 'LOCKSTITCH',
          line_code: 'LINE-01',
        },
        requestId,
        traceId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('logs downtime only for an active machine and audits the record', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ id: machineId, status: 'ACTIVE' }],
      })
      .mockResolvedValueOnce({ rows: [downtimeRow] });

    const result = await service.logDowntime(
      tenantId,
      factoryId,
      actorUserId,
      machineId,
      { reason_code: ' needle_break ' },
      requestId,
      traceId,
    );

    expect(result).toEqual(downtimeRow);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[1]).toEqual([
      tenantId,
      factoryId,
      machineId,
      'NEEDLE_BREAK',
      null,
      actorUserId,
    ]);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'maintenance.machine.downtime.logged',
        resourceId: eventId,
      }),
    );
  });

  it('does not log downtime for inactive or retired machines', async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: machineId, status: 'INACTIVE' }],
    });

    await expect(
      service.logDowntime(
        tenantId,
        factoryId,
        actorUserId,
        machineId,
        { reason_code: 'NO_POWER' },
        requestId,
        traceId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(query).toHaveBeenCalledTimes(1);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('rejects a second open downtime event for the same machine', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ id: machineId, status: 'ACTIVE' }],
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('duplicate open event'), { code: '23505' }),
      );

    await expect(
      service.logDowntime(
        tenantId,
        factoryId,
        actorUserId,
        machineId,
        { reason_code: 'NO_POWER' },
        requestId,
        traceId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('closes an open downtime event and records the actor', async () => {
    const closedRow = {
      ...downtimeRow,
      ended_at: '2026-10-10T11:00:00.000Z',
      closed_by_user_id: actorUserId,
      version: 2,
    };
    query
      .mockResolvedValueOnce({ rows: [downtimeRow] })
      .mockResolvedValueOnce({ rows: [closedRow] });

    const result = await service.closeDowntime(
      tenantId,
      factoryId,
      actorUserId,
      eventId,
      requestId,
      traceId,
    );

    expect(result).toEqual(closedRow);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[1]).toEqual([
      eventId,
      tenantId,
      factoryId,
      actorUserId,
    ]);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'maintenance.machine.downtime.closed',
        resourceId: eventId,
      }),
    );
  });

  it('does not close a downtime event outside the factory scope', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(
      service.closeDowntime(
        tenantId,
        factoryId,
        actorUserId,
        eventId,
        requestId,
        traceId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(query).toHaveBeenCalledTimes(1);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('lists machines with bounded pagination and explicit factory scope', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [machineRow] });

    const result = await service.listMachines(
      tenantId,
      factoryId,
      actorUserId,
      { page: 2, limit: 1, search: 'sew' },
    );

    expect(result).toEqual({
      items: [machineRow],
      page: 2,
      limit: 1,
      total: 1,
    });
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('COUNT(*)'),
      [tenantId, factoryId, null, 'sew'],
    );
    expect(query.mock.calls[1]?.[1]).toEqual([
      tenantId,
      factoryId,
      null,
      'sew',
      1,
      1,
    ]);
  });

  it('lists downtime events using tenant/factory and state filters', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [downtimeRow] });

    const result = await service.listDowntime(
      tenantId,
      factoryId,
      actorUserId,
      { page: 1, limit: 10, machine_id: machineId, state: 'OPEN' },
    );

    expect(result).toEqual({
      items: [downtimeRow],
      page: 1,
      limit: 10,
      total: 1,
    });
    expect(query.mock.calls[0]?.[1]).toEqual([
      tenantId,
      factoryId,
      machineId,
      'OPEN',
    ]);
  });
});
