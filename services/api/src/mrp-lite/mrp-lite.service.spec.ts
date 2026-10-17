import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { MrpLiteService } from './mrp-lite.service';

const USER = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const TRACE = 'f7168be2-1b73-42b3-a930-72c31b2d6050';

describe('MrpLiteService request contracts', () => {
  let service: MrpLiteService;
  let database: { transaction: ReturnType<typeof jest.fn>; query: ReturnType<typeof jest.fn> };
  let audit: { record: ReturnType<typeof jest.fn> };

  beforeEach(() => {
    database = { transaction: jest.fn(), query: jest.fn() };
    audit = { record: jest.fn() };
    service = new MrpLiteService(database as unknown as DatabaseService, audit as unknown as AuditService);
  });

  it('rejects malformed authenticated scope before opening a transaction', async () => {
    await expect(service.createRun('not-a-uuid', TENANT, FACTORY, {
      horizon_start: '2026-10-17', horizon_end: '2026-11-17',
    }, 'plan-key', TRACE, TRACE)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('requires an idempotency key before reading or creating a plan', async () => {
    await expect(service.createRun(USER, TENANT, FACTORY, {
      horizon_start: '2026-10-17', horizon_end: '2026-11-17',
    }, null, TRACE, TRACE)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects impossible calendar dates rather than normalizing them', async () => {
    await expect(service.createRun(USER, TENANT, FACTORY, {
      horizon_start: '2026-02-30', horizon_end: '2026-03-15',
    }, 'plan-key', TRACE, TRACE)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects a backwards planning horizon', async () => {
    await expect(service.createRun(USER, TENANT, FACTORY, {
      horizon_start: '2026-11-01', horizon_end: '2026-10-31',
    }, 'plan-key', TRACE, TRACE)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('bounds the inclusive horizon to at most 366 calendar days', async () => {
    await expect(service.createRun(USER, TENANT, FACTORY, {
      horizon_start: '2026-01-01', horizon_end: '2027-01-02',
    }, 'plan-key', TRACE, TRACE)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('validates a run identifier before querying stored snapshots', async () => {
    await expect(service.getRun(USER, TENANT, FACTORY, 'not-a-uuid')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects list limits outside the supported page size', async () => {
    await expect(service.listRuns(USER, TENANT, FACTORY, 101)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
  });
});
