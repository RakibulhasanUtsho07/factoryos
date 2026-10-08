import {
  UnauthorizedException,
} from '@nestjs/common';

import { jest } from '@jest/globals';

import {
  AiAgentStudioDraftController,
} from './ai.agent.studio.draft.controller';

describe('AiAgentStudioDraftController', () => {
  const draftService = {
    createDraft: jest.fn(),
    listDrafts: jest.fn(),
    getLatestDraft: jest.fn(),
    reviewDraft: jest.fn(),
  };

  let controller: AiAgentStudioDraftController;

  const request = {
    factoryos: {
      userId:
        '30000000-0000-4000-8000-000000000003',
      tenantId:
        '10000000-0000-4000-8000-000000000001',
      factoryId:
        '20000000-0000-4000-8000-000000000002',
    },
  } as never;

  beforeEach(() => {
    jest.clearAllMocks();

    controller =
      new AiAgentStudioDraftController(
        draftService as never,
      );
  });

  it('creates a draft from natural language', async () => {
    draftService.createDraft.mockResolvedValue({
      status: 'DRAFT',
    });

    await controller.createDraft(
      request,
      {
        prompt:
          'Build a quality triage assistant',
        title: null,
      },
    );

    expect(
      draftService.createDraft,
    ).toHaveBeenCalledWith(
      request.factoryos.tenantId,
      request.factoryos.factoryId,
      request.factoryos.userId,
      {
        prompt:
          'Build a quality triage assistant',
        title: null,
      },
    );
  });

  it('lists drafts', async () => {
    draftService.listDrafts.mockResolvedValue({
      items: [],
      count: 0,
    });

    await controller.listDrafts(request);

    expect(
      draftService.listDrafts,
    ).toHaveBeenCalledWith(
      request.factoryos.tenantId,
      request.factoryos.factoryId,
      request.factoryos.userId,
    );
  });

  it('gets a specific draft', async () => {
    draftService.getLatestDraft.mockResolvedValue({
      draftId:
        '40000000-0000-4000-8000-000000000004',
    });

    const draftId =
      '40000000-0000-4000-8000-000000000004';

    await controller.getDraft(
      request,
      draftId,
    );

    expect(
      draftService.getLatestDraft,
    ).toHaveBeenCalledWith(
      request.factoryos.tenantId,
      request.factoryos.factoryId,
      request.factoryos.userId,
      draftId,
    );
  });

  it('reviews a draft without publishing it', async () => {
    draftService.reviewDraft.mockResolvedValue({
      status:
        'READY_FOR_PUBLISH',
    });

    await controller.reviewDraft(
      request,
      '40000000-0000-4000-8000-000000000004',
      {
        decision: 'APPROVE',
        notes: 'Ready for controlled follow-up',
      },
    );

    expect(
      draftService.reviewDraft,
    ).toHaveBeenCalledWith(
      request.factoryos.tenantId,
      request.factoryos.factoryId,
      request.factoryos.userId,
      '40000000-0000-4000-8000-000000000004',
      {
        decision: 'APPROVE',
        notes:
          'Ready for controlled follow-up',
      },
    );
  });

  it('rejects missing authenticated factory context', async () => {
    await expect(
      controller.createDraft(
        {
          factoryos: undefined,
        } as never,
        {
          prompt: 'Build a workflow',
        },
      ),
    ).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
