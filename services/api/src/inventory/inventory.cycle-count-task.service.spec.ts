import { BadRequestException, ConflictException } from '@nestjs/common';
import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { InventoryCycleCountTaskService } from './inventory.cycle-count-task.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const OTHER_REVIEWER_ID = 'ac26f304-c4e2-4c2e-a1d8-eafedc78f714';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const ITEM_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';
const TASK_ID = '28c3c8e1-c57a-4ea1-9b9d-1a8c4c52c45d';
const PROPOSAL_ID = 'e5d197fe-7a4a-44ce-b3c4-9231289c1897';
const ESCALATION_ID = '6b42d2b9-46ca-4b87-a1b5-0e6db6905b0d';

type QueryResponse = { rows: QueryResultRow[] };

const queryRows = (rows: unknown[]): QueryResponse => ({
  rows: rows as QueryResultRow[],
});

const resolutionRequestHash = (taskId: string, resolutionNote: string): string =>
  createHash('sha256').update(JSON.stringify({
    taskId: taskId.toLowerCase(),
    resolutionNote,
  })).digest('hex');

const escalationRow = (requestHash: string): QueryResultRow => ({
  id: ESCALATION_ID,
  tenant_id: TENANT_ID,
  factory_id: FACTORY_ID,
  task_id: TASK_ID,
  proposal_id: PROPOSAL_ID,
  item_id: ITEM_ID,
  expected_quantity: '12.0000',
  counted_quantity: '7.0000',
  variance_quantity: '-5.0000',
  threshold_quantity: '2.0000',
  status: 'RESOLVED',
  detected_at: '2026-10-25T10:00:00.000Z',
  resolved_by_user_id: USER_ID,
  resolved_at: '2026-10-25T10:05:00.000Z',
  resolution_note: 'Investigated stock variance',
  resolution_idempotency_key: 'escalation-resolve-1',
  resolution_request_hash: requestHash,
  version: '2',
} as unknown as QueryResultRow);

describe('InventoryCycleCountTaskService', () => {
  let client: { query: ReturnType<typeof jest.fn> };
  let databaseMock: { transaction: ReturnType<typeof jest.fn>; query: ReturnType<typeof jest.fn> };
  let auditMock: { record: ReturnType<typeof jest.fn> };
  let service: InventoryCycleCountTaskService;

  beforeEach(() => {
    client = { query: jest.fn().mockResolvedValue(queryRows([])) };
    databaseMock = {
      transaction: jest.fn(async (first: unknown, second?: unknown) => {
        const callback = typeof first === 'function' ? first : second;
        if (typeof callback !== 'function') throw new Error('transaction callback missing');
        return (callback as (clientArg: typeof client) => Promise<unknown>)(client);
      }),
      query: jest.fn(),
    };
    auditMock = { record: jest.fn().mockResolvedValue('audit-id') };
    service = new InventoryCycleCountTaskService(
      databaseMock as unknown as DatabaseService,
      auditMock as unknown as AuditService,
    );
  });

  it('rejects a malformed due timestamp before opening a database transaction', async () => {
    await expect(service.createTask(
      USER_ID, TENANT_ID, FACTORY_ID,
      { item_id: ITEM_ID, due_at: 'not-a-date' },
      'count-task-create-1', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('requires an idempotency key for task creation', async () => {
    await expect(service.createTask(
      USER_ID, TENANT_ID, FACTORY_ID,
      { item_id: ITEM_ID, due_at: '2026-10-24T10:00:00.000Z' },
      null, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects a priority outside the supported range before touching the database', async () => {
    await expect(service.createTask(
      USER_ID, TENANT_ID, FACTORY_ID,
      { item_id: ITEM_ID, due_at: '2026-10-24T10:00:00.000Z', priority: 10001 },
      'count-task-create-2', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid task filters before querying the task list', async () => {
    await expect(service.listTasks(
      USER_ID, TENANT_ID, FACTORY_ID, { status: 'RUNNING' },
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.query).not.toHaveBeenCalled();
  });

  it('rejects an invalid task-list limit before querying the database', async () => {
    await expect(service.listTasks(
      USER_ID, TENANT_ID, FACTORY_ID, { limit: 101 },
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.query).not.toHaveBeenCalled();
  });

  it('rejects a malformed task id before opening a transaction', async () => {
    await expect(service.startTask(
      USER_ID, TENANT_ID, FACTORY_ID, 'bad-task-id', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('requires a cancellation reason before opening a transaction', async () => {
    await expect(service.cancelTask(
      USER_ID, TENANT_ID, FACTORY_ID, TASK_ID, '   ', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects non-boolean blind-count policy before opening a transaction', async () => {
    await expect(service.createTask(
      USER_ID, TENANT_ID, FACTORY_ID,
      {
        item_id: ITEM_ID,
        due_at: '2026-10-24T10:00:00.000Z',
        blind_count: 'yes' as unknown as boolean,
      },
      'count-task-blind-1', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects a variance threshold with more than four decimal places', async () => {
    await expect(service.createTask(
      USER_ID, TENANT_ID, FACTORY_ID,
      {
        item_id: ITEM_ID,
        due_at: '2026-10-24T10:00:00.000Z',
        variance_escalation_threshold: 1.23456,
      },
      'count-task-threshold-precision', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects a zero variance threshold before opening a transaction', async () => {
    await expect(service.createTask(
      USER_ID, TENANT_ID, FACTORY_ID,
      {
        item_id: ITEM_ID,
        due_at: '2026-10-24T10:00:00.000Z',
        variance_escalation_threshold: 0,
      },
      'count-task-threshold-zero', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('requires a resolution note before opening an escalation-resolution transaction', async () => {
    await expect(service.resolveVarianceEscalation(
      USER_ID, TENANT_ID, FACTORY_ID, TASK_ID, '  ', 'escalation-resolve-1', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('replays a resolved escalation for the same UUID even when the caller UUID casing differs', async () => {
    const note = 'Investigated stock variance';
    client.query.mockResolvedValueOnce(queryRows([
      escalationRow(resolutionRequestHash(TASK_ID.toUpperCase(), note)),
    ]));

    const result = await service.resolveVarianceEscalation(
      USER_ID.toUpperCase(), TENANT_ID, FACTORY_ID, TASK_ID.toUpperCase(),
      note, 'escalation-resolve-1', null, null,
    );

    expect(result).toMatchObject({
      id: ESCALATION_ID,
      resolved_by_user_id: USER_ID,
      status: 'RESOLVED',
      replayed: true,
    });
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(auditMock.record).not.toHaveBeenCalled();
  });

  it('rejects the original counter from resolving an escalation despite UUID casing differences', async () => {
    client.query
      .mockResolvedValueOnce(queryRows([]))
      .mockResolvedValueOnce(queryRows([{
        id: TASK_ID,
        status: 'AWAITING_REVIEW',
        current_proposal_id: PROPOSAL_ID,
        submitted_by_user_id: USER_ID,
      }]));

    await expect(service.resolveVarianceEscalation(
      USER_ID.toUpperCase(), TENANT_ID, FACTORY_ID, TASK_ID,
      'Investigated stock variance', 'escalation-resolve-2', null, null,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(auditMock.record).not.toHaveBeenCalled();
  });

  it('does not allow a different reviewer to replay another reviewer’s resolution key', async () => {
    const note = 'Investigated stock variance';
    client.query.mockResolvedValueOnce(queryRows([
      escalationRow(resolutionRequestHash(TASK_ID, note)),
    ]));

    await expect(service.resolveVarianceEscalation(
      OTHER_REVIEWER_ID.toUpperCase(), TENANT_ID, FACTORY_ID, TASK_ID,
      note, 'escalation-resolve-1', null, null,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(auditMock.record).not.toHaveBeenCalled();
  });
});
