import { UnauthorizedException } from '@nestjs/common';
import { jest } from '@jest/globals';

import { OnboardingController } from './onboarding.controller';

describe('OnboardingController', () => {
  const onboardingService = {
    listSteps: jest.fn(async () => ({ items: [], saved_steps: 0, total_steps: 7 })),
    saveStep: jest.fn(async () => ({ id: 'draft-1', step_key: 'factory_profile' })),
  };
  const controller = new OnboardingController(onboardingService as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads drafts using verified identity and factory context, not request headers', async () => {
    const request = {
      headers: {
        'x-user-id': 'spoofed-user',
        'x-tenant-id': 'spoofed-tenant',
        'x-factory-id': 'spoofed-factory',
      },
      factoryos: {
        requestId: 'request-1',
        traceId: 'trace-1',
        userId: 'verified-user',
        tenantId: 'verified-tenant',
        factoryId: 'verified-factory',
      },
    };

    await controller.listSteps(request as never);

    expect(onboardingService.listSteps).toHaveBeenCalledWith(
      'verified-user',
      'verified-tenant',
      'verified-factory',
    );
  });

  it('saves a step with the verified actor and request correlation context', async () => {
    const request = {
      factoryos: {
        requestId: 'request-1',
        traceId: 'trace-1',
        userId: 'verified-user',
        tenantId: 'verified-tenant',
        factoryId: 'verified-factory',
      },
    };

    await controller.saveStep(
      request as never,
      'factory_profile',
      { payload: { name: 'Demo Factory' } },
    );

    expect(onboardingService.saveStep).toHaveBeenCalledWith(
      'verified-user',
      'verified-tenant',
      'verified-factory',
      'factory_profile',
      { name: 'Demo Factory' },
      'request-1',
      'trace-1',
    );
  });

  it('rejects missing verified factory context', async () => {
    await expect(controller.listSteps({
      factoryos: {
        requestId: 'request-1',
        traceId: 'trace-1',
        userId: 'verified-user',
        tenantId: 'verified-tenant',
        factoryId: null,
      },
    } as never)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(onboardingService.listSteps).not.toHaveBeenCalled();
  });
});
