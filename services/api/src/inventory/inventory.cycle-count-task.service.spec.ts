import { BadRequestException } from '@nestjs/common';
import { jest } from '@jest/globals';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { InventoryCycleCountTaskService } from './inventory.cycle-count-task.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const ITEM_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';
const TASK_ID = '28c3c8e1-c57a-4ea1-9b9d-1a8c4c52c45d';

describe('InventoryCycleCountTaskService', () => {
  const databaseMock = {
    transaction: jest.fn(),
    query: jest.fn(),
  };
  const auditMock = { record: jest.fn() };
  let service: InventoryCycleCountTaskService;

  beforeEach(() => {
    jest.clearAllMocks();
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
});
