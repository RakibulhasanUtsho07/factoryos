import { UnauthorizedException } from '@nestjs/common';

import { jest } from '@jest/globals';

import { AiAgentStudioTemplateController } from './ai.agent.studio.template.controller';

describe('AiAgentStudioTemplateController', () => {
  const tenantId = '10000000-0000-4000-8000-000000000001';
  const factoryId = '20000000-0000-4000-8000-000000000002';
  const userId = '30000000-0000-4000-8000-000000000003';
  const templateService = {
    listTemplates: jest.fn(),
    getTemplate: jest.fn(),
    createDraftFromTemplate: jest.fn(),
  };
  let controller: AiAgentStudioTemplateController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AiAgentStudioTemplateController(
      templateService as never,
    );
  });

  const request = {
    factoryos: { tenantId, factoryId, userId },
  } as never;

  it('passes verified factory context to list templates', async () => {
    templateService.listTemplates.mockResolvedValue({ count: 7, items: [] });
    await controller.listTemplates(request);
    expect(templateService.listTemplates).toHaveBeenCalledWith(
      tenantId,
      factoryId,
      userId,
    );
  });

  it('passes the requested template key to get template', async () => {
    templateService.getTemplate.mockResolvedValue({ key: 'order-recovery' });
    await controller.getTemplate(request, 'order-recovery');
    expect(templateService.getTemplate).toHaveBeenCalledWith(
      tenantId,
      factoryId,
      userId,
      'order-recovery',
    );
  });

  it('creates a draft through the governed template service', async () => {
    templateService.createDraftFromTemplate.mockResolvedValue({ draft: { status: 'DRAFT' } });
    await controller.createDraftFromTemplate(request, 'quality-containment', {
      title: 'QA triage',
      customization: 'Include lot traceability evidence.',
    });
    expect(templateService.createDraftFromTemplate).toHaveBeenCalledWith(
      tenantId,
      factoryId,
      userId,
      'quality-containment',
      {
        title: 'QA triage',
        customization: 'Include lot traceability evidence.',
      },
    );
  });

  it('fails closed when verified request context is missing', async () => {
    await expect(
      controller.listTemplates({} as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(templateService.listTemplates).not.toHaveBeenCalled();
  });
});
