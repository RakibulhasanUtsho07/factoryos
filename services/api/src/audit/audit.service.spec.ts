import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from './audit.service';

const databaseQuery = jest.fn();
const clientQuery = jest.fn();
const database = { query: databaseQuery };
const client = { query: clientQuery } as unknown as PoolClient;

describe('AuditService.recordWithClient', () => {
  const input = {
    tenantId: 'faaab63d-c447-46ce-950d-deebdd7f5f30',
    factoryId: '6fa03a36-6e3e-45ff-8f48-9ce3e2af0001',
    actorUserId: '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001',
    eventType: 'BUSINESS_MODEL_EVIDENCE',
    action: 'RECORD_SOURCE_EVIDENCE',
    resourceType: 'BUSINESS_EVIDENCE',
    resourceId: 'e0000000-0000-4000-8000-000000000001',
    payload: { sourceKey: 'erp:po-100', revisionNo: 2 },
  };

  let service: AuditService;

  beforeEach(() => {
    jest.clearAllMocks();
    clientQuery.mockResolvedValue({ rows: [{ id: 'audit-event-id' }] });
    service = new AuditService(database as never);
  });

  it('writes the audit event with the supplied transaction client', async () => {
    await expect(service.recordWithClient(client, input)).resolves.toBe('audit-event-id');

    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(clientQuery.mock.calls[0]?.[0]).toContain('INSERT INTO audit_events');
    expect(clientQuery.mock.calls[0]?.[1]).toEqual([
      input.tenantId,
      input.factoryId,
      input.actorUserId,
      input.eventType,
      input.action,
      input.resourceType,
      input.resourceId,
      null,
      null,
      'INTERNAL',
      JSON.stringify(input.payload),
    ]);
    expect(databaseQuery).not.toHaveBeenCalled();
  });

  it('rejects an invalid tenant before attempting the audit insert', async () => {
    await expect(service.recordWithClient(client, {
      ...input,
      tenantId: 'not-a-uuid',
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(clientQuery).not.toHaveBeenCalled();
    expect(databaseQuery).not.toHaveBeenCalled();
  });

  it('fails closed when the audit insert returns no row', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] });

    await expect(service.recordWithClient(client, input)).rejects.toThrow('AUDIT_EVENT_INSERT_FAILED');
    expect(databaseQuery).not.toHaveBeenCalled();
  });
});
