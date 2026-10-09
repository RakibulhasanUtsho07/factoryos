import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import type {
  Request,
} from 'express';

import {
  PermissionGuard,
} from '../../iam/guards/permission.guard';

import {
  RequireFactoryScope,
} from '../../iam/require-factory-scope.decorator';

import {
  RequirePermission,
} from '../../iam/require-permission.decorator';

import {
  AiAgentStudioDraftService,
} from './ai.agent.studio.draft.service';

import {
  CreateAiAgentStudioDraftDto,
  ReviewAiAgentStudioDraftDto,
} from './dto/create-ai-agent-studio-draft.dto';

import type {
  AiAgentStudioDraftReviewDecision,
} from './ai.agent.studio.draft.types';

interface FactoryOsRequestContext {
  requestId: string;
  traceId: string;
  requestedUserId: string | null;
  requestedTenantId: string | null;
  requestedFactoryId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type FactoryOsRequest = Request & {
  factoryos?: FactoryOsRequestContext;
};

@Controller('v1/ai/agent-studio/workflow-drafts')
export class AiAgentStudioDraftController {
  constructor(
    private readonly draftService: AiAgentStudioDraftService,
  ) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.draft.write')
  @RequireFactoryScope()
  async createDraft(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateAiAgentStudioDraftDto,
  ) {
    const context = this.getContext(request);

    return this.draftService.createDraft(
      context.tenantId,
      context.factoryId,
      context.userId,
      {
        prompt: body.prompt,
        title: body.title ?? null,
      },
    );
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.draft.read')
  @RequireFactoryScope()
  async listDrafts(
    @Req() request: FactoryOsRequest,
  ) {
    const context = this.getContext(request);

    return this.draftService.listDrafts(
      context.tenantId,
      context.factoryId,
      context.userId,
    );
  }

  @Get(':draftId')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.draft.read')
  @RequireFactoryScope()
  async getDraft(
    @Req() request: FactoryOsRequest,
    @Param(
      'draftId',
      new ParseUUIDPipe(),
    )
    draftId: string,
  ) {
    const context = this.getContext(request);

    return this.draftService.getLatestDraft(
      context.tenantId,
      context.factoryId,
      context.userId,
      draftId,
    );
  }

  @Post(':draftId/review')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.draft.write')
  @RequireFactoryScope()
  async reviewDraft(
    @Req() request: FactoryOsRequest,
    @Param(
      'draftId',
      new ParseUUIDPipe(),
    )
    draftId: string,
    @Body()
    body: ReviewAiAgentStudioDraftDto,
  ) {
    const context = this.getContext(request);

    return this.draftService.reviewDraft(
      context.tenantId,
      context.factoryId,
      context.userId,
      draftId,
      {
        decision:
          body.decision as AiAgentStudioDraftReviewDecision,
        notes: body.notes ?? null,
      },
    );
  }

  private getContext(
    request: FactoryOsRequest,
  ): {
    userId: string;
    tenantId: string;
    factoryId: string;
  } {
    const context =
      request.factoryos;

    const userId =
      context?.userId ?? null;
    const tenantId =
      context?.tenantId ?? null;
    const factoryId =
      context?.factoryId ?? null;

    if (
      !userId ||
      !tenantId ||
      !factoryId
    ) {
      throw new UnauthorizedException(
        'Authenticated AI factory context is missing',
      );
    }

    return {
      userId,
      tenantId,
      factoryId,
    };
  }
}
