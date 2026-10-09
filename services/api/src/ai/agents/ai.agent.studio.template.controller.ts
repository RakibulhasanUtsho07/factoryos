import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import type { Request } from 'express';

import { PermissionGuard } from '../../iam/guards/permission.guard';
import { RequireFactoryScope } from '../../iam/require-factory-scope.decorator';
import { RequirePermission } from '../../iam/require-permission.decorator';
import { AiAgentStudioTemplateService } from './ai.agent.studio.template.service';
import { CreateAiAgentStudioTemplateDraftDto } from './dto/create-ai-agent-studio-template-draft.dto';

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

@Controller('v1/ai/agent-studio/templates')
export class AiAgentStudioTemplateController {
  constructor(
    private readonly templateService: AiAgentStudioTemplateService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.draft.read')
  @RequireFactoryScope()
  async listTemplates(@Req() request: FactoryOsRequest) {
    const context = this.getContext(request);
    return this.templateService.listTemplates(
      context.tenantId,
      context.factoryId,
      context.userId,
    );
  }

  @Get(':templateKey')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.draft.read')
  @RequireFactoryScope()
  async getTemplate(
    @Req() request: FactoryOsRequest,
    @Param('templateKey') templateKey: string,
  ) {
    const context = this.getContext(request);
    return this.templateService.getTemplate(
      context.tenantId,
      context.factoryId,
      context.userId,
      templateKey,
    );
  }

  @Post(':templateKey/drafts')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.draft.write')
  @RequireFactoryScope()
  async createDraftFromTemplate(
    @Req() request: FactoryOsRequest,
    @Param('templateKey') templateKey: string,
    @Body() body?: CreateAiAgentStudioTemplateDraftDto,
  ) {
    const context = this.getContext(request);
    return this.templateService.createDraftFromTemplate(
      context.tenantId,
      context.factoryId,
      context.userId,
      templateKey,
      {
        title: body?.title ?? null,
        customization: body?.customization ?? null,
      },
    );
  }

  private getContext(
    request: FactoryOsRequest,
  ): { userId: string; tenantId: string; factoryId: string } {
    const userId = request.factoryos?.userId ?? null;
    const tenantId = request.factoryos?.tenantId ?? null;
    const factoryId = request.factoryos?.factoryId ?? null;

    if (!userId || !tenantId || !factoryId) {
      throw new UnauthorizedException(
        'Authenticated AI factory context is missing',
      );
    }

    return { userId, tenantId, factoryId };
  }
}
