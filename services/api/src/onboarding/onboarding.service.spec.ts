import { BadRequestException } from '@nestjs/common';
import { jest } from '@jest/globals';

import { OnboardingService } from './onboarding.service';

describe('OnboardingService', () => {
  const database = {
    query: jest.fn(async () => ({
      rows: [{
        id: 'draft-1',
        step_key: 'factory_profile',
        payload: { name: 'Demo Factory' },
        version: '1',
        updated_at: '2026-11-15T12:00:00.000Z',
      }],
    })),
  };
  const auditService = {
    record: jest.fn(async () => undefined),
  };
  const service = new OnboardingService(
    database as never,
    auditService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists drafts within the verified tenant and factory database context', async () => {
    const result = await service.listSteps('user-1', 'tenant-1', 'factory-1');

    expect(result.saved_steps).toBe(1);
    expect(result.total_steps).toBe(7);
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('factory_onboarding_step_drafts'),
      ['tenant-1', 'factory-1'],
      { tenantId: 'tenant-1', userId: 'user-1' },
    );
  });

  it('rejects an unknown onboarding step before writing', async () => {
    await expect(service.saveStep(
      'user-1',
      'tenant-1',
      'factory-1',
      'unknown_step',
      { value: true },
      'request-1',
      'trace-1',
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects fields that are not part of the selected step contract', async () => {
    await expect(service.saveStep(
      'user-1',
      'tenant-1',
      'factory-1',
      'factory_profile',
      { name: 'Demo Factory', permission: 'admin' },
      'request-1',
      'trace-1',
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects non-text draft values', async () => {
    await expect(service.saveStep(
      'user-1',
      'tenant-1',
      'factory-1',
      'factory_profile',
      { name: 42 },
      'request-1',
      'trace-1',
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects payloads larger than 64 KiB before writing', async () => {
    await expect(service.saveStep(
      'user-1',
      'tenant-1',
      'factory-1',
      'factory_profile',
      { notes: 'x'.repeat(65 * 1024) },
      'request-1',
      'trace-1',
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).not.toHaveBeenCalled();
  });

  it('upserts a step draft using verified tenant, factory and actor context', async () => {
    const result = await service.saveStep(
      'user-1',
      'tenant-1',
      'factory-1',
      'factory_profile',
      { name: 'Demo Factory' },
      'request-1',
      'trace-1',
    );

    expect(result.id).toBe('draft-1');
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (tenant_id, factory_id, step_key)'),
      [
        'tenant-1',
        'factory-1',
        'factory_profile',
        JSON.stringify({ name: 'Demo Factory' }),
        'user-1',
      ],
      { tenantId: 'tenant-1', userId: 'user-1' },
    );
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      factoryId: 'factory-1',
      actorUserId: 'user-1',
      eventType: 'FACTORY_ONBOARDING',
      action: 'SAVE_STEP',
    }));
  });
});
