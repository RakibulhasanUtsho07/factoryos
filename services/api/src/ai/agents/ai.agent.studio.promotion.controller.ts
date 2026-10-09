import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import type { Request } from 'express';

import { PermissionGuard } from '../../iam/guards/permission.guard';
import { RequireFactoryScope } from '../../iam/require-factory-scope.decorator';
import { RequirePermission } from '../../iam/require-permission.decorator';
import { AiAgentStudioPromotionService } from './ai.agent.studio.promotion.service';
import { CreateAiAgentPublishRequestDto } from './dto/create-ai-agent-publish-request.dto';

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

@Controller('v1/ai/agent-studio')
export class AiAgentStudioPromotionController {
  constructor(
    private readonly promotionService: AiAgentStudioPromotionService,
  ) {}

  @Post('publish-requests')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.publish')
  @RequireFactoryScope()
  async requestPublication(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateAiAgentPublishRequestDto,
  ) {
    const context = this.getContext(request);

    return this.promotionService.requestPublication(
      context.tenantId,
      context.factoryId,
      context.userId,
      context.traceId,
      {
        agentDefinitionId: body.agent_definition_id,
        sandboxId: body.sandbox_id,
        simulationRunId: body.simulation_run_id,
        policySimulationRunId:
          body.policy_simulation_run_id ?? null,
        targetStage: body.target_stage,
        reason: body.reason ?? null,
      },
    );
  }

  @Post('publish-requests/:requestId/approve')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.publish')
  @RequireFactoryScope()
  async approvePublication(
    @Req() request: FactoryOsRequest,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
  ) {
    const context = this.getContext(request);

    return this.promotionService.approvePublication(
      context.tenantId,
      context.factoryId,
      context.userId,
      context.traceId,
      requestId,
    );
  }

  @Post('publish-requests/:requestId/promote')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.promote')
  @RequireFactoryScope()
  async promotePublication(
    @Req() request: FactoryOsRequest,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
  ) {
    const context = this.getContext(request);

    return this.promotionService.promotePublication(
      context.tenantId,
      context.factoryId,
      context.userId,
      context.traceId,
      requestId,
    );
  }

  @Post('deployments/:deploymentId/rollback')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.rollback')
  @RequireFactoryScope()
  async rollbackDeployment(
    @Req() request: FactoryOsRequest,
    @Param('deploymentId', new ParseUUIDPipe()) deploymentId: string,
    @Body() body: { reason?: string | null },
  ) {
    const context = this.getContext(request);

    return this.promotionService.rollbackDeployment(
      context.tenantId,
      context.factoryId,
      context.userId,
      context.traceId,
      deploymentId,
      body?.reason ?? null,
    );
  }

  private getContext(request: FactoryOsRequest) {
    const userId = request.factoryos?.userId ?? null;
    const tenantId = request.factoryos?.tenantId ?? null;
    const factoryId = request.factoryos?.factoryId ?? null;
    const traceId = request.factoryos?.traceId ?? null;

    if (!userId || !tenantId || !factoryId || !traceId) {
      throw new UnauthorizedException(
        'Authenticated AI factory context is missing',
      );
    }

    return { userId, tenantId, factoryId, traceId };
  }
}
