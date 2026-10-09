import { jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import { AiAgentStudioPromotionController } from './ai.agent.studio.promotion.controller';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const traceId = '6f1a2222-2222-4222-8222-222222222222';

const service = {
  requestPublication: jest.fn<(...args: never[]) => Promise<any>>(),
  approvePublication: jest.fn<(...args: never[]) => Promise<any>>(),
  promotePublication: jest.fn<(...args: never[]) => Promise<any>>(),
  rollbackDeployment: jest.fn<(...args: never[]) => Promise<any>>(),
};

function request() {
  return {
    factoryos: {
      requestId: 'request-1',
      traceId,
      requestedUserId: userId,
      requestedTenantId: tenantId,
      requestedFactoryId: factoryId,
      userId,
      tenantId,
      factoryId,
    },
  } as never;
}

describe('AiAgentStudioPromotionController', () => {
  beforeEach(() => jest.clearAllMocks());

  it('maps authenticated context to publication request', async () => {
    service.requestPublication.mockResolvedValue({ status: 'PENDING' });
    const controller = new AiAgentStudioPromotionController(service as never);

    await controller.requestPublication(request(), {
      agent_definition_id: '7f1a2222-2222-4222-8222-222222222222',
      sandbox_id: '8f1a2222-2222-4222-8222-222222222222',
      simulation_run_id: '9f1a2222-2222-4222-8222-222222222222',
      target_stage: 'CANARY',
    } as never);

    expect(service.requestPublication).toHaveBeenCalledWith(
      tenantId,
      factoryId,
      userId,
      traceId,
      expect.objectContaining({ targetStage: 'CANARY' }),
    );
  });

  it('fails closed when authenticated context is missing', async () => {
    const controller = new AiAgentStudioPromotionController(service as never);

    await expect(
      controller.requestPublication({ factoryos: { traceId } } as never, {} as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps approve, promote and rollback operations', async () => {
    service.approvePublication.mockResolvedValue({ status: 'APPROVED' });
    service.promotePublication.mockResolvedValue({ request: { status: 'PROMOTED' } });
    service.rollbackDeployment.mockResolvedValue({ status: 'ACTIVE' });

    const controller = new AiAgentStudioPromotionController(service as never);

    await controller.approvePublication(
      request(),
      'bf1a2222-2222-4222-8222-222222222222',
    );
    await controller.promotePublication(
      request(),
      'bf1a2222-2222-4222-8222-222222222222',
    );
    await controller.rollbackDeployment(
      request(),
      'cf1a2222-2222-4222-8222-222222222222',
      { reason: 'Rollback drill' },
    );

    expect(service.approvePublication).toHaveBeenCalled();
    expect(service.promotePublication).toHaveBeenCalled();
    expect(service.rollbackDeployment).toHaveBeenCalled();
  });
});
