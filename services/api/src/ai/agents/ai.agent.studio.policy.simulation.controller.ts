import {
  Body,
  Controller,
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

import { AiAgentStudioPolicySimulationService } from './ai.agent.studio.policy.simulation.service';
import { CreateAiAgentStudioPolicySimulationDto } from './dto/create-ai-agent-studio-policy-simulation.dto';

interface FactoryOsRequestContext {
  traceId: string;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type FactoryOsRequest = Request & {
  factoryos?: FactoryOsRequestContext;
};

@Controller('v1/ai/agent-studio')
export class AiAgentStudioPolicySimulationController {
  constructor(
    private readonly policySimulationService:
      AiAgentStudioPolicySimulationService,
  ) {}

  @Post('sandboxes/:sandboxId/policy-simulations')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.agents.write')
  @RequireFactoryScope()
  async simulateHistoricalPolicies(
    @Req() request: FactoryOsRequest,
    @Param('sandboxId') sandboxId: string,
    @Body() body: CreateAiAgentStudioPolicySimulationDto,
  ) {
    const context = this.getContext(request);

    return this.policySimulationService.simulateHistoricalPolicies(
      context.tenantId,
      context.factoryId,
      context.userId,
      sandboxId,
      context.traceId,
      body.historical_events.map(
        (event) => ({
          eventKey: event.event_key,
          action: event.action,
          resourceType:
            event.resource_type,
          attributes:
            event.attributes,
          effectiveAt:
            event.effective_at,
          ...(event.expected_outcome !==
          undefined
            ? {
                expectedOutcome:
                  event.expected_outcome,
              }
            : {}),
        }),
      ),
    );
  }

  private getContext(
    request: FactoryOsRequest,
  ): {
    tenantId: string;
    factoryId: string;
    userId: string;
    traceId: string;
  } {
    const tenantId =
      request.factoryos?.tenantId ??
      null;
    const factoryId =
      request.factoryos?.factoryId ??
      null;
    const userId =
      request.factoryos?.userId ??
      null;
    const traceId =
      request.factoryos?.traceId ??
      null;

    if (
      !tenantId ||
      !factoryId ||
      !userId ||
      !traceId
    ) {
      throw new UnauthorizedException(
        'Authenticated AI factory context is missing',
      );
    }

    return {
      tenantId,
      factoryId,
      userId,
      traceId,
    };
  }
}
