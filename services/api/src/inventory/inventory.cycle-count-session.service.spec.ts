import { BadRequestException } from '@nestjs/common';
import { jest } from '@jest/globals';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { InventoryCycleCountSessionService } from './inventory.cycle-count-session.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY_ID = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const ITEM_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';
const BIN_A = '28c3c8e1-c57a-4ea1-9b9d-1a8c4c52c45d';
const BIN_B = 'b3c90b08-f0ea-4f71-9da5-055e9e5c6819';
const ASSIGNEE_ID = 'd6cd65f7-b02d-48ae-9a24-49a9fca3f65f';

describe('InventoryCycleCountSessionService', () => {
  const databaseMock = {
    transaction: jest.fn(),
    query: jest.fn(),
  };
  const auditMock = { record: jest.fn() };
  let service: InventoryCycleCountSessionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InventoryCycleCountSessionService(
      databaseMock as unknown as DatabaseService,
      auditMock as unknown as AuditService,
    );
  });

  const validDto = () => ({
    item_id: ITEM_ID,
    location_ids: [BIN_A, BIN_B],
    assigned_to_user_id: ASSIGNEE_ID,
    due_at: '2026-10-24T10:00:00.000Z',
  });

  it('rejects sessions with fewer than two bins before opening a transaction', async () => {
    await expect(service.createSession(
      USER_ID, TENANT_ID, FACTORY_ID,
      { ...validDto(), location_ids: [BIN_A] },
      'session-create-1', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects duplicate bins case-insensitively before opening a transaction', async () => {
    await expect(service.createSession(
      USER_ID, TENANT_ID, FACTORY_ID,
      { ...validDto(), location_ids: [BIN_A, BIN_A.toUpperCase()] },
      'session-create-2', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('requires an idempotency key before opening a transaction', async () => {
    await expect(service.createSession(
      USER_ID, TENANT_ID, FACTORY_ID, validDto(), null, null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects a zero variance threshold before opening a transaction', async () => {
    await expect(service.createSession(
      USER_ID, TENANT_ID, FACTORY_ID,
      { ...validDto(), variance_escalation_threshold: 0 },
      'session-create-3', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects non-finite or over-precision threshold quantities before opening a transaction', async () => {
    await expect(service.createSession(
      USER_ID, TENANT_ID, FACTORY_ID,
      { ...validDto(), variance_escalation_threshold: 1.23456 },
      'session-create-4', null, null,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects malformed session identifiers before querying', async () => {
    await expect(service.getSession(
      USER_ID, TENANT_ID, FACTORY_ID, 'not-a-uuid',
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(databaseMock.query).not.toHaveBeenCalled();
  });
});
