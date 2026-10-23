import { BadRequestException } from '@nestjs/common';
import { jest } from '@jest/globals';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { InventoryCycleCountRecurringPolicyService } from './inventory.cycle-count-recurring-policy.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const ITEM_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';
const ASSIGNEE_ID = 'd6cd65f7-b02d-48ae-9a24-49a9fca3f65f';

describe('InventoryCycleCountRecurringPolicyService', () => {
  const databaseMock = {
    transaction: jest.fn(),
    query: jest.fn(),
  };
  const auditMock = { record: jest.fn() };
  let service: InventoryCycleCountRecurringPolicyService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InventoryCycleCountRecurringPolicyService(
      databaseMock as unknown as DatabaseService,
      auditMock as unknown as AuditService,
    );
  });

  const validDto = () => ({
    item_id: ITEM_ID,
    assigned_to_user_id: ASSIGNEE_ID,
    cadence_unit: 'WEEKLY' as const,
    cadence_interval: 1,
    first_run_at: '2026-10-24T10:00:00.000Z',
  });

  it('requires an idempotency key before opening a transaction', async () => {
    await expect(service.createPolicy(
      USER_ID, TENANT_ID, FACTORY_ID, validDto(), null, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects recurring multi-bin targets with duplicate bins before opening a transaction', async () => {
    const binId = '9a9af4a2-1d2c-46e4-beb6-15e9b09d39a2';
    await expect(service.createPolicy(
      USER_ID, TENANT_ID, FACTORY_ID,
      { ...validDto(), location_ids: [binId, binId] },
      'recurring-duplicate-bins', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects combining single-bin and multi-bin recurrence targets', async () => {
    const binA = '9a9af4a2-1d2c-46e4-beb6-15e9b09d39a2';
    const binB = 'b4de8386-ea38-4695-a2b9-2fa86e0e0d91';
    await expect(service.createPolicy(
      USER_ID, TENANT_ID, FACTORY_ID,
      { ...validDto(), location_id: binA, location_ids: [binA, binB] },
      'recurring-conflicting-bins', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects a multi-bin recurring target with fewer than two bins', async () => {
    await expect(service.createPolicy(
      USER_ID, TENANT_ID, FACTORY_ID,
      { ...validDto(), location_ids: ['9a9af4a2-1d2c-46e4-beb6-15e9b09d39a2'] },
      'recurring-one-bin-array', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects a cadence interval that exceeds the weekly calendar bound', async () => {
    await expect(service.createPolicy(
      USER_ID, TENANT_ID, FACTORY_ID,
      { ...validDto(), cadence_interval: 53 },
      'recurring-create-1', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects an unsupported cadence unit before opening a transaction', async () => {
    await expect(service.createPolicy(
      USER_ID, TENANT_ID, FACTORY_ID,
      { ...validDto(), cadence_unit: 'HOURLY' as never },
      'recurring-create-2', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects a variance threshold with more than four decimal places', async () => {
    await expect(service.createPolicy(
      USER_ID, TENANT_ID, FACTORY_ID,
      { ...validDto(), variance_escalation_threshold: 0.12345 },
      'recurring-create-3', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects a zero variance threshold before opening a transaction', async () => {
    await expect(service.createPolicy(
      USER_ID, TENANT_ID, FACTORY_ID,
      { ...validDto(), variance_escalation_threshold: 0 },
      'recurring-create-4', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects malformed policy ids before querying', async () => {
    await expect(service.pausePolicy(
      USER_ID, TENANT_ID, FACTORY_ID, 'not-a-uuid', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects a materialization batch above the bound before opening a transaction', async () => {
    await expect(service.materializeDue(
      USER_ID, TENANT_ID, FACTORY_ID, 101, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects non-positive materialization batch size before opening a transaction', async () => {
    await expect(service.materializeDue(
      USER_ID, TENANT_ID, FACTORY_ID, 0, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('materializes a recurring multi-bin occurrence as one session and complete child task set atomically', async () => {
    const binA = '9a9af4a2-1d2c-46e4-beb6-15e9b09d39a2';
    const binB = 'b4de8386-ea38-4695-a2b9-2fa86e0e0d91';
    const sessionId = '6f24a321-1bd2-4c78-a194-0ed0c8b2a187';
    const taskA = 'bce92ca6-dd53-4e7b-9d7f-43f6717071f1';
    const taskB = 'd00eb5ee-1ee0-4224-b9b6-72fb06a2e5a2';
    const nextRunAt = '2026-10-31T10:00:00.000Z';
    const scheduledFor = '2026-10-24T10:00:00.000Z';
    const policy = {
      id: 'cb7c4679-1bf4-40b2-a3f4-810c5fb219a9',
      tenant_id: TENANT_ID,
      factory_id: FACTORY_ID,
      item_id: ITEM_ID,
      location_id: null,
      session_location_ids: [binA, binB],
      assigned_to_user_id: ASSIGNEE_ID,
      cadence_unit: 'WEEKLY',
      cadence_interval: 1,
      anchor_at: scheduledFor,
      next_occurrence_number: '0',
      next_run_at: scheduledFor,
      last_run_at: null,
      priority: 5,
      blind_count: true,
      variance_escalation_threshold: '2.0000',
      status: 'ACTIVE',
      idempotency_key: 'recurring-create',
      request_hash: 'a'.repeat(64),
      notes: 'inventory count',
      created_by_user_id: USER_ID,
      created_at: scheduledFor,
      updated_at: scheduledFor,
      version: '1',
    };
    const client = { query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>() };
    client.query
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [policy], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: sessionId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: taskA }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: taskB }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ next_run_at: nextRunAt }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    databaseMock.transaction.mockImplementation(async (...args: unknown[]) => {
      const work = args[1] as (transactionClient: unknown) => Promise<unknown>;
      return work(client);
    });

    const result = await service.materializeDue(
      USER_ID, TENANT_ID, FACTORY_ID, 50, null, null,
    );

    expect(result.materialized_count).toBe(1);
    expect(result.occurrences).toEqual([{
      policy_id: policy.id,
      task_id: null,
      session_id: sessionId,
      occurrence_number: 0,
      scheduled_for: scheduledFor,
      next_run_at: nextRunAt,
    }]);
    const queries = client.query.mock.calls.map(([sql]) => String(sql));
    expect(queries.filter((sql) => sql.includes('INSERT INTO inventory_cycle_count_sessions'))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes('INSERT INTO inventory_cycle_count_tasks'))).toHaveLength(2);
    const occurrenceCall = client.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO inventory_cycle_count_recurring_policy_occurrences'),
    );
    expect(occurrenceCall?.[1]).toEqual(expect.arrayContaining([null, sessionId]));
    expect(queries.some((sql) => sql.includes('INVENTORY.CYCLE_COUNT_SESSION_SCHEDULED'))).toBe(true);
  });

  it('rejects an invalid list limit before querying', async () => {
    await expect(service.listPolicies(
      USER_ID, TENANT_ID, FACTORY_ID, { limit: 101 },
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMock.query).not.toHaveBeenCalled();
  });
});
