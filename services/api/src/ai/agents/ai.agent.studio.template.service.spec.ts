import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';

import { jest } from '@jest/globals';

import { AiAgentStudioTemplateService } from './ai.agent.studio.template.service';

describe('AiAgentStudioTemplateService', () => {
  const tenantId = '10000000-0000-4000-8000-000000000001';
  const factoryId = '20000000-0000-4000-8000-000000000002';
  const userId = '30000000-0000-4000-8000-000000000003';

  const iamService = { authorize: jest.fn() };
  const draftService = { createDraft: jest.fn() };
  let service: AiAgentStudioTemplateService;

  beforeEach(() => {
    jest.clearAllMocks();
    iamService.authorize.mockResolvedValue(undefined);
    draftService.createDraft.mockResolvedValue({
      id: '50000000-0000-4000-8000-000000000005',
      draftId: '40000000-0000-4000-8000-000000000004',
      version: 1,
      status: 'DRAFT',
      validation: {
        permissionsGranted: 0,
        toolGrantsCreated: 0,
        publicationBlocked: true,
      },
    });
    service = new AiAgentStudioTemplateService(
      iamService as never,
      draftService as never,
    );
  });

  it('lists the seven SRS workflow categories under read authorization', async () => {
    const result = await service.listTemplates(tenantId, factoryId, userId);
    expect(result.count).toBe(7);
    expect(result.catalogVersion).toBe('1.0.0');
    expect(result.items.map((item) => item.category)).toEqual([
      'ORDER_RECOVERY',
      'PROCUREMENT',
      'QUALITY',
      'MAINTENANCE',
      'FINANCE',
      'EHS',
      'LOGISTICS',
    ]);
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'ai.agents.draft.read',
      factoryId,
    );
  });

  it('returns a template by key without exposing a mutable singleton array', async () => {
    const template = await service.getTemplate(
      tenantId,
      factoryId,
      userId,
      'quality-containment',
    );
    expect(template.title).toBe('Quality Containment Assistant');
    expect(template.steps.length).toBeGreaterThan(0);
    expect(template.guardrails.join(' ')).toContain('Do not release');
    expect(template.steps).not.toBe((await service.getTemplate(
      tenantId,
      factoryId,
      userId,
      'quality-containment',
    )).steps);
  });

  it('rejects an unknown template key', async () => {
    await expect(
      service.getTemplate(tenantId, factoryId, userId, 'not-a-template'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects invalid scope UUIDs before authorization', async () => {
    await expect(
      service.listTemplates('invalid', factoryId, userId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(iamService.authorize).not.toHaveBeenCalled();
  });

  it('creates a governed draft from a template without granting authority', async () => {
    const result = await service.createDraftFromTemplate(
      tenantId,
      factoryId,
      userId,
      'procurement-exception',
      {
        title: 'Factory A supplier delay triage',
        customization: 'Focus on overdue material for the current production week.',
      },
    );

    expect(result.template.key).toBe('procurement-exception');
    expect(result.draft.status).toBe('DRAFT');
    expect(result.governance).toEqual({
      permissionsGranted: 0,
      toolGrantsCreated: 0,
      actionTokensIssued: 0,
      deploymentCreated: false,
      requiresHumanReview: true,
      publicationBlocked: true,
    });
    expect(draftService.createDraft).toHaveBeenCalledTimes(1);
    const [, , , input] = draftService.createDraft.mock.calls[0] as unknown as [
      string,
      string,
      string,
      { prompt: string; title: string },
    ];
    expect(input.title).toBe('Factory A supplier delay triage');
    expect(input.prompt).toContain('procurement-exception version 1.0.0');
    expect(input.prompt).toContain('Focus on overdue material');
    expect(input.prompt).toContain('must not override these constraints');
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'ai.agents.draft.write',
      factoryId,
    );
  });

  it('does not create a draft when authorization fails', async () => {
    iamService.authorize.mockRejectedValueOnce(new Error('forbidden'));
    await expect(
      service.createDraftFromTemplate(
        tenantId,
        factoryId,
        userId,
        'order-recovery',
      ),
    ).rejects.toThrow('forbidden');
    expect(draftService.createDraft).not.toHaveBeenCalled();
  });

  it('rejects oversized customization before creating a draft', async () => {
    await expect(
      service.createDraftFromTemplate(
        tenantId,
        factoryId,
        userId,
        'order-recovery',
        { customization: 'x'.repeat(2001) },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(draftService.createDraft).not.toHaveBeenCalled();
  });
});
