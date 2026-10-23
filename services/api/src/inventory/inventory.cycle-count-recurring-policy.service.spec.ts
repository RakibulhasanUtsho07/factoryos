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

  it('rejects an invalid list limit before querying', async () => {
    await expect(service.listPolicies(
      USER_ID, TENANT_ID, FACTORY_ID, { limit: 101 },
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(databaseMock.query).not.toHaveBeenCalled();
  });
});
